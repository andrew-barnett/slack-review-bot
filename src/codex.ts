// Spawning `codex exec` and getting a structured result back out.

import { spawn, type ChildProcess } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { CODEX_ENV_ALLOWLIST, CODEX_ENV_ALLOWLIST_PREFIXES } from './config'
import { startActiveDeadline, type DeadlineDeps, type DeadlineSnapshot } from './deadline'
import { REVIEW_OUTPUT_SCHEMA, parseReviewResult, type ReviewRunResult } from './schema'
import { parseTokensUsed } from './usage'

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

export interface CodexRunOutcome {
  result: ReviewRunResult
  /** Raw final message, kept for the run log. */
  rawFinalMessage: string
  /** Codex's reported "tokens used" total, or undefined when it printed none. */
  tokensUsed?: number
  /** Active time charged to the run, in ms (suspension discounted); 0 for a run too short to tick. */
  activeMs: number
}

/** Injection seam so the tests can drive the process lifecycle without running Codex. */
export type Spawner = typeof spawn

/**
 * The most transcript retained in memory. The whole transcript is streamed to the run log on
 * disk; in memory only a bounded tail is kept, which is all the token footer and the error-tail
 * ever read. Without this a long, noisy review grows an unbounded buffer for the life of the run.
 */
export const TRANSCRIPT_TAIL_LIMIT = 64 * 1024

/** Append to a rolling buffer, keeping only the last `limit` characters. */
export function appendBoundedTail(buffer: string, text: string, limit: number): string {
  const combined = buffer + text
  return combined.length > limit ? combined.slice(combined.length - limit) : combined
}

/**
 * A set of live `codex exec` children, so a shutdown can signal them all.
 *
 * The children are spawned `detached`, in their own process groups, precisely so a timeout can
 * take a whole tree down — but that also means the parent exiting does not stop them. On
 * shutdown the daemon signals every registered child's group through here, rather than leaving
 * a review running with nothing left to report its verdict or settle its cursor.
 */
export interface ChildRegistry {
  add(child: ChildProcess): void
  remove(child: ChildProcess): void
  /** Signal every registered child's process group; returns how many were signalled. */
  killAll(signal: NodeJS.Signals): number
  size(): number
}

export function createChildRegistry(): ChildRegistry {
  const children = new Set<ChildProcess>()
  return {
    add: child => {
      children.add(child)
    },
    remove: child => {
      children.delete(child)
    },
    killAll: signal => {
      const count = children.size
      for (const child of children) killProcessTree(child, signal)
      return count
    },
    size: () => children.size,
  }
}

/** How long shutdown waits for SIGTERM'd children to exit before escalating to SIGKILL. */
export const SHUTDOWN_GRACE_MS = 10_000
/** How often shutdown re-checks whether the children have exited. */
export const SHUTDOWN_POLL_MS = 200

export interface DrainDeps {
  now(): number
  setTimer(fn: () => void, ms: number): ReturnType<typeof setTimeout>
  graceMs: number
  pollMs: number
  log?(event: string, fields?: Record<string, unknown>): void
}

/**
 * Stop every registered child before the daemon exits.
 *
 * SIGTERM the lot, then wait for them to deregister as they exit (via the run's own close
 * handler) and SIGKILL any that cling past the grace — the same escalation the per-run kill path
 * uses — rather than exiting on a fixed timer and leaving a wedged `codex exec` tree reparented
 * to init. Resolves once the registry is empty or the stragglers have been SIGKILLed, so the
 * caller can exit knowing nothing was orphaned.
 */
export async function drainChildRegistry(registry: ChildRegistry, deps: DrainDeps): Promise<void> {
  const signalled = registry.killAll('SIGTERM')
  if (signalled === 0 || registry.size() === 0) return
  const deadline = deps.now() + deps.graceMs
  await new Promise<void>(resolve => {
    const poll = (): void => {
      if (registry.size() === 0) {
        resolve()
        return
      }
      if (deps.now() >= deadline) {
        const remaining = registry.killAll('SIGKILL')
        deps.log?.('shutdown.sigkill', { remaining })
        resolve()
        return
      }
      deps.setTimer(poll, deps.pollMs)
    }
    deps.setTimer(poll, deps.pollMs)
  })
}

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
  const out: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue
    if (allowed.has(key) || CODEX_ENV_ALLOWLIST_PREFIXES.some(prefix => key.startsWith(prefix))) {
      out[key] = value
    }
  }
  return out
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

/** Kill a detached child and everything it spawned. */
function killProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) {
    // No pid means no process group to target; signal the handle directly rather than
    // silently leaving the child running past its deadline.
    try {
      child.kill(signal)
    } catch {
      // Already gone.
    }
    return
  }
  try {
    // Negative pid targets the process group, which `detached: true` created. Codex
    // spawns shells that spawn git/npm; signalling only the parent would orphan those.
    process.kill(-child.pid, signal)
  } catch {
    try {
      child.kill(signal)
    } catch {
      // Already gone.
    }
  }
}

export async function runCodexReview(
  options: CodexRunOptions,
  spawner: Spawner = spawn,
  /** Injection seam for the deadline's clock and heartbeat, so a test can sleep the machine. */
  clock: Partial<DeadlineDeps> = {}
): Promise<CodexRunOutcome> {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'slack-review-bot-'))
  const schemaPath = path.join(scratch, 'output-schema.json')
  const outputPath = path.join(scratch, 'final-message.json')
  fs.writeFileSync(schemaPath, JSON.stringify(REVIEW_OUTPUT_SCHEMA, null, 2))

  let env = buildChildEnv(process.env, options.envPassthrough)
  if (options.disableGitSigning) env = withGitSigningDisabled(env)

  const args = buildCodexArgs({
    profile: options.profile,
    workspaceRoot: options.workspaceRoot,
    worktreeRoot: options.worktreeRoot,
    schemaPath,
    outputPath,
    prompt: options.prompt,
  })

  fs.mkdirSync(options.worktreeRoot, { recursive: true })

  // A bounded in-memory tail; the full transcript goes to the run log via appendLog.
  let transcript = ''
  const appendLog = makeLogAppender(options.logDir, options.runId)

  try {
    const exit = await new Promise<{
      code: number | null
      timedOut?: DeadlineSnapshot
      stalled?: DeadlineSnapshot
      activeMs: number
    }>((resolve, reject) => {
      const child = spawner(options.codexBin, args, {
        cwd: options.workspaceRoot,
        env,
        // Own process group, so the timeout path can take the whole tree down.
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })

      // Registered for the life of the run so a shutdown can signal this process group.
      options.registry?.add(child)

      // SIGTERM the whole tree, then escalate to SIGKILL if it clings on — a wedged npm or
      // git can ignore the first signal. Shared by the timeout and the stall path. The
      // escalation timer is tracked and cancelled the instant the child exits: an untracked
      // timer fires SIGKILL ~10s later at a pid/pgid the OS may have reused by then.
      let killTimer: ReturnType<typeof setTimeout> | undefined
      const killTree = (): void => {
        // Schedule the escalation BEFORE sending SIGTERM: a child that exits synchronously in
        // response would otherwise run cleanupChild() before killTimer is assigned, leaving the
        // timer to fire SIGKILL later at a possibly-reused pgid.
        killTimer = setTimeout(() => killProcessTree(child, 'SIGKILL'), 10_000)
        killTimer.unref()
        killProcessTree(child, 'SIGTERM')
      }
      // Called once the child is gone: cancel a pending SIGKILL and drop it from the registry.
      const cleanupChild = (): void => {
        if (killTimer) {
          clearTimeout(killTimer)
          killTimer = undefined
        }
        options.registry?.remove(child)
      }

      // Not a plain setTimeout: that counts wall-clock time, and a run in flight when the lid
      // closes is charged for the whole nap. One review was killed for "exceeding" three hours
      // of which it had used four minutes; the next one inherited the same fate because it
      // started during a two-second maintenance wake. The deadline charges active time only.
      let timedOut: DeadlineSnapshot | undefined
      let stalled: DeadlineSnapshot | undefined
      const deadline = startActiveDeadline(
        options.timeoutMs,
        snapshot => {
          timedOut = snapshot
          killTree()
        },
        {
          ...clock,
          stallMs: options.stallTimeoutMs,
          onFreeze: (frozenForMs, snapshot) => {
            options.log?.('codex.frozen', {
              runId: options.runId,
              frozenForMs,
              activeMs: snapshot.activeMs,
              remainingMs: Math.max(0, options.timeoutMs - snapshot.activeMs),
              hint: 'the process was suspended; not counting it against the run timeout',
            })
            clock.onFreeze?.(frozenForMs, snapshot)
          },
          // A run that has gone silent for its whole grace is wedged, not slow: kill it so the
          // caller can retry it (with a longer grace) rather than hold the queue for hours.
          onStall: (idleMs, snapshot) => {
            stalled = snapshot
            options.log?.('codex.stalled', {
              runId: options.runId,
              idleMs,
              stallMs: options.stallTimeoutMs,
              activeMs: snapshot.activeMs,
              hint: 'no output for the whole grace; killing so the review can be retried',
            })
            killTree()
            clock.onStall?.(idleMs, snapshot)
          },
        }
      )

      const capture = (chunk: Buffer) => {
        const text = chunk.toString('utf8')
        transcript = appendBoundedTail(transcript, text, TRANSCRIPT_TAIL_LIMIT)
        appendLog(text)
        // Any output is progress: reset the stall clock so only genuine silence trips it.
        deadline.markActivity()
        // Surface the latest line for the status reply. Guarded so a broken progress sink can
        // never take a review down — reporting what a run is doing is not worth failing it.
        if (options.onProgress) {
          try {
            options.onProgress(text, deadline.snapshot().activeMs)
          } catch {
            // A status-side failure is not the run's problem.
          }
        }
      }
      child.stdout?.on('data', capture)
      child.stderr?.on('data', capture)

      child.on('error', error => {
        cleanupChild()
        deadline.stop()
        reject(error)
      })
      child.on('close', code => {
        // Cancel any pending SIGKILL and deregister now that the child is gone.
        cleanupChild()
        // Snapshot before stop so the active-time figure reflects the whole run; snapshot()
        // keeps working after stop, but reading it here keeps the intent obvious.
        const activeMs = deadline.snapshot().activeMs
        deadline.stop()
        resolve({ code, timedOut, stalled, activeMs })
      })
    })

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
      const tail = transcript.slice(-1500).trim()
      throw new CodexOutputError(
        `Codex exited with code ${exit.code} and produced no final message` + (tail ? `:\n${tail}` : ''),
        tokensUsed,
        activeMs
      )
    }

    let result: ReviewRunResult
    try {
      result = parseReviewResult(rawFinalMessage)
    } catch (error) {
      // The run finished and cost tokens/time, but its final message is malformed or
      // schema-invalid. Surface it as an output failure that still carries the usage, rather
      // than letting the parse throw a bare error that erases what the run spent.
      throw new CodexOutputError(error instanceof Error ? error.message : String(error), tokensUsed, activeMs)
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
