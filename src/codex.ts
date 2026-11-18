// Spawning `codex exec` and getting a structured result back out.

import { spawn } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { CODEX_ENV_ALLOWLIST, CODEX_ENV_ALLOWLIST_PREFIXES, DAEMON_SECRET_VARS } from './config'
import { type DeadlineDeps, type DeadlineSnapshot } from './deadline'
import {
  parseReviewResult,
  parseReviewResultV2,
  REVIEW_OUTPUT_SCHEMA,
  REVIEW_OUTPUT_SCHEMA_V2,
  type EngineRunResult,
  type ReviewRunResult,
} from './schema'
import { parseTokensUsed } from './usage'
import { redactSecrets } from './redact'
import {
  appendBoundedTail,
  createChildRegistry,
  drainChildRegistry,
  SHUTDOWN_GRACE_MS,
  SHUTDOWN_POLL_MS,
  superviseChild,
  TRANSCRIPT_TAIL_LIMIT,
  type ChildRegistry,
  type DrainDeps,
  type Spawner,
} from './supervise'

// Re-exported so existing imports from './codex' keep working after the extraction.
export {
  appendBoundedTail,
  createChildRegistry,
  drainChildRegistry,
  SHUTDOWN_GRACE_MS,
  SHUTDOWN_POLL_MS,
  TRANSCRIPT_TAIL_LIMIT,
  type ChildRegistry,
  type DrainDeps,
  type Spawner,
}

export interface CodexRunOptions {
  prompt: string
  codexBin: string
  /** Config profile layered from $CODEX_HOME/<profile>.config.toml. */
  profile: string
  /** Directory Codex treats as its workspace root. */
  workspaceRoot: string
  /** Extra writable directory for the per-PR worktrees. */
  worktreeRoot: string
  /**
   * Budget of *active* time for the run. Time the process spends suspended — a closed lid —
   * is not charged against it; see `deadline.ts` for why and how.
   */
  timeoutMs: number
  /**
   * Active time the run may go without printing anything before it is judged stalled and
   * killed. Measured in the same discounted units as `timeoutMs`, so a sleeping laptop is
   * never mistaken for a wedged run. 0 or undefined disables stall detection. A stalled run
   * throws {@link CodexStalledError}, which the caller may retry with a longer grace.
   */
  stallTimeoutMs?: number
  disableGitSigning: boolean
  /** Extra env var names to pass to the Codex child on top of the built-in allowlist. */
  envPassthrough?: string[]
  /** Dual mode: the read-only engine token, set as the child's GH_TOKEN. Undefined in single mode. */
  engineGhToken?: string
  /**
   * Registry the spawned child registers into for its lifetime, so a daemon shutdown can signal
   * every in-flight `codex exec` process group instead of orphaning it. Optional: the CLI has none.
   */
  registry?: ChildRegistry
  /** Directory to write the raw stdout/stderr transcript to. Empty disables it. */
  logDir?: string
  /** Identifier used to name the log files. */
  runId: string
  /** Structured daemon log for the run's own events. Optional: the CLI has none. */
  log?: (event: string, fields: Record<string, unknown>) => void
  /**
   * Called on each chunk of Codex output with its last line and the run's active time so far,
   * so the status reply can show what a review is doing right now. Best-effort and optional —
   * the CLI passes nothing, and it must never be relied on for correctness.
   */
  onProgress?: (line: string, activeMs: number) => void
}

export interface CodexRunOutcome<T = ReviewRunResult> {
  result: T
  /** Raw final message, kept for the run log. */
  rawFinalMessage: string
  /** Codex's reported "tokens used" total, or undefined when it printed none. */
  tokensUsed?: number
  /** Active time charged to the run, in ms (suspension discounted); 0 for a run too short to tick. */
  activeMs: number
}

// The redactor's hold-buffer cap lives with the streaming redactor in redact.ts; re-exported here
// because the tests import it from this module.
export { OUTPUT_FLUSH_LIMIT } from './redact'

/**
 * Build the Codex child's environment from an allowlist of the daemon's own.
 *
 * The Codex profile sets `shell_environment_policy.inherit = "all"`, so whatever is passed here
 * is exactly what the skill's `gh`, `git`, `npm` and `pnpm` calls — and any untrusted PR test
 * code — get to see. Rather than inherit the whole environment and try to strip the secrets out
 * (a denylist that silently misses the next new credential), start from nothing and copy across
 * only {@link CODEX_ENV_ALLOWLIST}, the allowed prefixes, and any operator passthrough names.
 * Everything else — cloud keys, registry tokens, the Slack tokens, arbitrary secrets — never
 * reaches the child.
 */
export function buildChildEnv(
  env: NodeJS.ProcessEnv,
  extraNames: readonly string[] = []
): NodeJS.ProcessEnv {
  const allowed = new Set<string>([...CODEX_ENV_ALLOWLIST, ...extraNames])
  // Daemon-held tokens are denied outright, even when an operator names them as passthrough:
  // the approver token can approve PRs, and engines run untrusted PR code.
  for (const name of DAEMON_SECRET_VARS) allowed.delete(name)
  const out: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue
    if (DAEMON_SECRET_VARS.includes(key)) continue
    if (allowed.has(key) || CODEX_ENV_ALLOWLIST_PREFIXES.some(prefix => key.startsWith(prefix))) {
      out[key] = value
    }
  }
  return out
}

/** The passthrough names that will be ignored because they are daemon secrets; for a startup warning. */
export function deniedPassthrough(extraNames: readonly string[]): string[] {
  return extraNames.filter(name => DAEMON_SECRET_VARS.includes(name))
}

/**
 * Point the child's `gh` at the read-only engine token. GH_TOKEN wins over GITHUB_TOKEN in gh,
 * but both other token variables are removed anyway, so nothing else the child runs (a PR's test
 * script, for example) finds a broader credential.
 */
export function withEngineGhToken(env: NodeJS.ProcessEnv, token: string): NodeJS.ProcessEnv {
  const copy: NodeJS.ProcessEnv = { ...env }
  delete copy.GITHUB_TOKEN
  delete copy.GH_ENTERPRISE_TOKEN
  copy.GH_TOKEN = token
  return copy
}

/**
 * Append `commit.gpgsign=false` using git's GIT_CONFIG_COUNT protocol.
 *
 * The user's global config sets `commit.gpgsign = true` against a GPG key whose agent
 * caches the passphrase for ten minutes (`default-cache-ttl 600`) behind pinentry-mac.
 * An unattended review that pushes a regression-test commit with a cold cache would pop
 * a GUI passphrase dialog and hang there for the rest of the run. Overriding via the
 * environment leaves the user's real git config untouched and applies only to commands
 * Codex spawns. The bot discloses unsigned test commits in the Slack thread.
 *
 * Any GIT_CONFIG_* pairs already in the environment are preserved — the override is
 * appended at the next free index rather than replacing index 0.
 */
export function withGitSigningDisabled(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const copy: NodeJS.ProcessEnv = { ...env }
  const existing = Number(copy.GIT_CONFIG_COUNT)
  const base = Number.isInteger(existing) && existing > 0 ? existing : 0
  copy[`GIT_CONFIG_KEY_${base}`] = 'commit.gpgsign'
  copy[`GIT_CONFIG_VALUE_${base}`] = 'false'
  copy.GIT_CONFIG_COUNT = String(base + 1)
  return copy
}

/** Assemble the `codex exec` argument list. Exported for unit testing. */
export function buildCodexArgs(options: {
  profile: string
  workspaceRoot: string
  worktreeRoot: string
  schemaPath: string
  outputPath: string
  prompt: string
}): string[] {
  return [
    'exec',
    // Layer the bot's permission profile over the user's base config: approvals off,
    // sandbox network on, caches writable. Never mutate the base config instead — that
    // would silently de-restrict every interactive Codex session too.
    '--profile', options.profile,
    '--cd', options.workspaceRoot,
    // The workspace root is writable by virtue of being the workspace; the worktree
    // root sits outside it and has to be granted explicitly.
    '--add-dir', options.worktreeRoot,
    // The workspace root is a directory of checkouts, not itself a repository.
    '--skip-git-repo-check',
    '--output-schema', options.schemaPath,
    '--output-last-message', options.outputPath,
    options.prompt,
  ]
}

export function runCodexReview(
  options: CodexRunOptions,
  spawner: Spawner = spawn,
  /** Injection seam for the deadline's clock and heartbeat, so a test can sleep the machine. */
  clock: Partial<DeadlineDeps> = {}
): Promise<CodexRunOutcome> {
  return runCodexWith(options, REVIEW_OUTPUT_SCHEMA, parseReviewResult, spawner, clock)
}

/** Dual mode: the same run with output schema v2, for the report-only prompt (spec 5.6). */
export function runCodexReportOnly(
  options: CodexRunOptions,
  spawner: Spawner = spawn,
  clock: Partial<DeadlineDeps> = {}
): Promise<CodexRunOutcome<EngineRunResult>> {
  return runCodexWith(options, REVIEW_OUTPUT_SCHEMA_V2, parseReviewResultV2, spawner, clock)
}

async function runCodexWith<T>(
  options: CodexRunOptions,
  schema: object,
  parse: (raw: string) => T,
  spawner: Spawner,
  clock: Partial<DeadlineDeps>
): Promise<CodexRunOutcome<T>> {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'slack-review-bot-'))
  const schemaPath = path.join(scratch, 'output-schema.json')
  const outputPath = path.join(scratch, 'final-message.json')
  fs.writeFileSync(schemaPath, JSON.stringify(schema, null, 2))

  let env = buildChildEnv(process.env, options.envPassthrough)
  if (options.disableGitSigning) env = withGitSigningDisabled(env)
  if (options.engineGhToken) env = withEngineGhToken(env, options.engineGhToken)

  const args = buildCodexArgs({
    profile: options.profile,
    workspaceRoot: options.workspaceRoot,
    worktreeRoot: options.worktreeRoot,
    schemaPath,
    outputPath,
    prompt: options.prompt,
  })

  fs.mkdirSync(options.worktreeRoot, { recursive: true })

  try {
    const exit = await superviseChild(
      {
        bin: options.codexBin,
        args,
        cwd: options.workspaceRoot,
        env,
        timeoutMs: options.timeoutMs,
        stallTimeoutMs: options.stallTimeoutMs,
        registry: options.registry,
        logDir: options.logDir,
        logName: options.runId,
        runId: options.runId,
        logPrefix: 'codex',
        log: options.log,
        onProgress: options.onProgress,
      },
      spawner,
      clock
    )
    const transcript = exit.transcript

    if (exit.timedOut) {
      // Carry the snapshot, not just a message: the run spent this much active time before it
      // was killed, and the caller accounts for it in the usage it reports.
      throw new CodexTimeoutError(describeTimeout(options.timeoutMs, exit.timedOut), exit.timedOut)
    }
    if (exit.stalled) {
      throw new CodexStalledError(
        describeStall(options.stallTimeoutMs ?? 0, exit.stalled),
        options.stallTimeoutMs ?? 0,
        exit.stalled
      )
    }

    // Measure usage before anything that can throw on the final message: a run that printed a
    // token total and spent active time still cost that much even if its output is unusable, so
    // the bad-output failures below carry the usage rather than dropping it.
    const tokensUsed = parseTokensUsed(transcript)
    const activeMs = exit.activeMs

    // A non-zero exit with a well-formed final message still tells us what happened to
    // each PR, so the message is read first and the exit code only matters if it is
    // missing. Reversing that would throw away a complete review over a stray failure
    // in Codex's own teardown.
    const rawFinalMessage = fs.existsSync(outputPath) ? fs.readFileSync(outputPath, 'utf8') : ''
    if (!rawFinalMessage.trim()) {
      // Redact the whole transcript before slicing: capture already redacted each chunk, but a
      // secret split across two chunks is only whole here, and this tail is posted to the Slack
      // error thread and the daemon log (issue #31).
      const tail = redactSecrets(transcript).slice(-1500).trim()
      throw new CodexOutputError(
        `Codex exited with code ${exit.code} and produced no final message` + (tail ? `:\n${tail}` : ''),
        tokensUsed,
        activeMs
      )
    }

    let result: T
    try {
      result = parse(rawFinalMessage)
    } catch (error) {
      // The run finished and cost tokens/time, but its final message is malformed or
      // schema-invalid. Surface it as an output failure that still carries the usage, rather
      // than letting the parse throw a bare error that erases what the run spent. Redact in case a
      // schema/parse error echoes part of the malformed message, which is untrusted output (#31).
      throw new CodexOutputError(
        redactSecrets(error instanceof Error ? error.message : String(error)),
        tokensUsed,
        activeMs
      )
    }

    return { result, rawFinalMessage, tokensUsed, activeMs }
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true })
  }
}

/**
 * Thrown when a run is killed for going silent, as opposed to for exhausting its budget.
 *
 * A distinct type so the caller can tell the one condition worth retrying (a wedged run that
 * may just need another attempt) from a timeout or a crash (which will not fix themselves).
 * Carries the snapshot so a giving-up caller can report how much active time was spent.
 */
export class CodexStalledError extends Error {
  constructor(
    message: string,
    readonly stallMs: number,
    readonly snapshot: DeadlineSnapshot
  ) {
    super(message)
    this.name = 'CodexStalledError'
  }
}

/**
 * Thrown when a run is killed for exhausting its active-time budget.
 *
 * A distinct type from {@link CodexStalledError} — a timeout is terminal and not retried — but
 * it carries the same {@link DeadlineSnapshot} so the caller can charge the active time the run
 * spent before the kill, rather than reporting a timed-out run as having cost nothing.
 */
export class CodexTimeoutError extends Error {
  constructor(
    message: string,
    readonly snapshot: DeadlineSnapshot
  ) {
    super(message)
    this.name = 'CodexTimeoutError'
  }
}

/**
 * Thrown when a run finished but its final message is missing, empty, or unparseable.
 *
 * Distinct from a spawn crash: the process ran to completion and may well have printed a token
 * total and spent real active time — it is only the *output* that is unusable. Carrying the
 * measured usage lets the caller report what the run cost instead of erasing it, which a bare
 * parse error thrown from the success path would do.
 */
export class CodexOutputError extends Error {
  constructor(
    message: string,
    readonly tokensUsed: number | undefined,
    readonly activeMs: number
  ) {
    super(message)
    this.name = 'CodexOutputError'
  }
}

/**
 * The error a stalled run reports. Exported for unit testing.
 *
 * Phrased in active time, since that is what the grace is measured in: a run silent for its
 * whole grace across a closed lid has not actually been silent for that long by the clock.
 */
export function describeStall(stallMs: number, snapshot: DeadlineSnapshot): string {
  const minutes = (ms: number) => `${Math.round(ms / 60_000)} minute${Math.round(ms / 60_000) === 1 ? '' : 's'}`
  return (
    `Codex produced no output for ${minutes(stallMs)} of active time and was killed as stalled` +
    ` (${minutes(snapshot.activeMs)} of active time into the run)`
  )
}

/**
 * The error a killed run reports. Exported for unit testing.
 *
 * Says how much of the wall-clock span was discounted, so a thread reading "exceeded three
 * hours" next to a message posted four hours ago is not a puzzle.
 */
export function describeTimeout(timeoutMs: number, snapshot: DeadlineSnapshot): string {
  const minutes = (ms: number) => `${Math.round(ms / 60_000)} minute${Math.round(ms / 60_000) === 1 ? '' : 's'}`
  let text = `Codex run exceeded the ${Math.round(timeoutMs / 60_000)} minute timeout and was killed`
  if (snapshot.frozenMs > 0) {
    text +=
      ` (${minutes(snapshot.wallMs)} by the wall clock, of which ${minutes(snapshot.frozenMs)}` +
      ' with the machine asleep were not counted)'
  }
  return text
}

function makeLogAppender(logDir: string | undefined, runId: string): (text: string) => void {
  if (!logDir) return () => {}
  try {
    fs.mkdirSync(logDir, { recursive: true })
  } catch {
    return () => {}
  }
  const file = path.join(logDir, `${runId}.log`)
  return text => {
    try {
      fs.appendFileSync(file, text)
    } catch {
      // Logging must never take the run down.
    }
  }
}
