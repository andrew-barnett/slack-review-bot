// Spawning `codex exec` and getting a structured result back out.

import { spawn, type ChildProcess } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { SECRET_ENV_KEYS } from './config'
import { startActiveDeadline, type DeadlineDeps, type DeadlineSnapshot } from './deadline'
import { REVIEW_OUTPUT_SCHEMA, parseReviewResult, type ReviewRunResult } from './schema'

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
  /** Directory to write the raw stdout/stderr transcript to. Empty disables it. */
  logDir?: string
  /** Identifier used to name the log files. */
  runId: string
  /** Structured daemon log for the run's own events. Optional: the CLI has none. */
  log?: (event: string, fields: Record<string, unknown>) => void
}

export interface CodexRunOutcome {
  result: ReviewRunResult
  /** Raw final message, kept for the run log. */
  rawFinalMessage: string
}

/** Injection seam so the tests can drive the process lifecycle without running Codex. */
export type Spawner = typeof spawn

/**
 * Remove the bot's own credentials from an environment before handing it to Codex.
 *
 * The Codex profile sets `shell_environment_policy.inherit = "all"` so the skill's
 * `gh`, `git`, `npm` and `pnpm` calls see a real PATH and a working toolchain. That
 * inherits this process's environment wholesale — which is where the Slack tokens
 * live — so they are deleted here rather than relying on Codex-side filtering.
 */
export function stripSecretsFromEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const copy: NodeJS.ProcessEnv = { ...env }
  for (const key of SECRET_ENV_KEYS) delete copy[key]
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

  let env = stripSecretsFromEnv(process.env)
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

  const transcript: string[] = []
  const appendLog = makeLogAppender(options.logDir, options.runId)

  try {
    const exit = await new Promise<{
      code: number | null
      timedOut?: DeadlineSnapshot
      stalled?: DeadlineSnapshot
    }>((resolve, reject) => {
      const child = spawner(options.codexBin, args, {
        cwd: options.workspaceRoot,
        env,
        // Own process group, so the timeout path can take the whole tree down.
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })

      // SIGTERM the whole tree, then escalate to SIGKILL if it clings on — a wedged npm or
      // git can ignore the first signal. Shared by the timeout and the stall path.
      const killTree = (): void => {
        killProcessTree(child, 'SIGTERM')
        setTimeout(() => killProcessTree(child, 'SIGKILL'), 10_000).unref()
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
        transcript.push(text)
        appendLog(text)
        // Any output is progress: reset the stall clock so only genuine silence trips it.
        deadline.markActivity()
      }
      child.stdout?.on('data', capture)
      child.stderr?.on('data', capture)

      child.on('error', error => {
        deadline.stop()
        reject(error)
      })
      child.on('close', code => {
        deadline.stop()
        resolve({ code, timedOut, stalled })
      })
    })

    if (exit.timedOut) {
      throw new Error(describeTimeout(options.timeoutMs, exit.timedOut))
    }
    if (exit.stalled) {
      throw new CodexStalledError(
        describeStall(options.stallTimeoutMs ?? 0, exit.stalled),
        options.stallTimeoutMs ?? 0,
        exit.stalled
      )
    }

    // A non-zero exit with a well-formed final message still tells us what happened to
    // each PR, so the message is read first and the exit code only matters if it is
    // missing. Reversing that would throw away a complete review over a stray failure
    // in Codex's own teardown.
    const rawFinalMessage = fs.existsSync(outputPath) ? fs.readFileSync(outputPath, 'utf8') : ''
    if (!rawFinalMessage.trim()) {
      const tail = transcript.join('').slice(-1500).trim()
      throw new Error(
        `Codex exited with code ${exit.code} and produced no final message` + (tail ? `:\n${tail}` : '')
      )
    }

    return { result: parseReviewResult(rawFinalMessage), rawFinalMessage }
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
