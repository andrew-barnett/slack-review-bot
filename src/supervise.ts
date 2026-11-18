// Running one detached child under an active-time deadline, with stall detection, output
// redaction, a bounded transcript tail and a run log. Shared by every review engine so each
// gets the same supervision; the engines keep only their own arguments and output parsing.

import { spawn, type ChildProcess } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'
import { StringDecoder } from 'string_decoder'
import { startActiveDeadline, type DeadlineDeps, type DeadlineSnapshot } from './deadline'
import { createOutputRedactor } from './redact'

/** Injection seam so tests can drive the process lifecycle without a real child. */
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

/** Kill a detached child and everything it spawned. */
export function killProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
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


export interface SuperviseOptions {
  /** Executable to spawn. */
  bin: string
  /** Arguments passed to the executable. */
  args: string[]
  /** Working directory for the child. */
  cwd: string
  /** Environment for the child. */
  env: NodeJS.ProcessEnv
  /**
   * Budget of *active* time for the run. Time the process spends suspended — a closed lid —
   * is not charged against it; see `deadline.ts` for why and how.
   */
  timeoutMs: number
  /**
   * Active time the run may go without printing anything before it is judged stalled and
   * killed. Measured in the same discounted units as `timeoutMs`, so a sleeping laptop is
   * never mistaken for a wedged run. 0 or undefined disables stall detection.
   */
  stallTimeoutMs?: number
  /**
   * Registry the spawned child registers into for its lifetime, so a daemon shutdown can signal
   * every in-flight child process group instead of orphaning it. Optional: the CLI has none.
   */
  registry?: ChildRegistry
  /** Directory to write the raw stdout/stderr transcript to. Empty disables it. */
  logDir?: string
  /** Base name of the run log file (without .log). */
  logName: string
  /** Identifier of the run, included in the run's log events. */
  runId: string
  /** Prefix for this child's log events: `<prefix>.frozen`, `<prefix>.stalled`. */
  logPrefix: string
  /** Structured daemon log for the run's own events. Optional: the CLI has none. */
  log?: (event: string, fields: Record<string, unknown>) => void
  /**
   * Called on each chunk of output with its last line and the run's active time so far,
   * so the status reply can show what a review is doing right now. Best-effort and optional —
   * the CLI passes nothing, and it must never be relied on for correctness.
   */
  onProgress?: (line: string, activeMs: number) => void
  /**
   * Called with every raw stdout chunk, before redaction and before the transcript tail is bounded.
   * For an engine whose result arrives on stdout (Claude's stream-JSON `result` event), so a large
   * final event is never cut by TRANSCRIPT_TAIL_LIMIT. The text stays in memory: it is never logged.
   */
  onStdout?: (text: string) => void
}

export interface SupervisedExit {
  code: number | null
  timedOut?: DeadlineSnapshot
  stalled?: DeadlineSnapshot
  /** Active time charged to the run, in ms (suspension discounted). */
  activeMs: number
  /** Redacted, bounded tail of the child's combined output. */
  transcript: string
}

export function superviseChild(
  options: SuperviseOptions,
  spawner: Spawner = spawn,
  /** Injection seam for the deadline's clock and heartbeat, so a test can sleep the machine. */
  clock: Partial<DeadlineDeps> = {}
): Promise<SupervisedExit> {
  // A bounded in-memory tail; the full transcript goes to the run log via appendLog.
  let transcript = ''
  // makeLogAppender creates logDir itself; superviseChild creates no other directory.
  const appendLog = makeLogAppender(options.logDir, options.logName)
  return new Promise<SupervisedExit>((resolve, reject) => {
    const child = spawner(options.bin, options.args, {
      cwd: options.cwd,
      env: options.env,
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
          options.log?.(`${options.logPrefix}.frozen`, {
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
          options.log?.(`${options.logPrefix}.stalled`, {
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

    // Send an already-safe, redacted span of output to every surface that stores or shows it —
    // the run log, the in-memory transcript, and the status reply — so all three inherit the one
    // redaction pass (issue #31).
    // `span` is already redacted by the stream redactor below; distribute it to the run log, the
    // in-memory transcript, and the status reply.
    const publish = (span: string) => {
      if (!span) return
      transcript = appendBoundedTail(transcript, span, TRANSCRIPT_TAIL_LIMIT)
      appendLog(span)
      // Guarded so a broken progress sink can never take a review down — reporting what a run is
      // doing is not worth failing it.
      if (options.onProgress) {
        try {
          options.onProgress(span, deadline.snapshot().activeMs)
        } catch {
          // A status-side failure is not the run's problem.
        }
      }
    }

    // stdout and stderr each get their OWN streaming redactor. A credential is written to one
    // stream in one write; a shared buffer would let the other stream's output interleave into
    // the middle of a token and defeat the match. The redactor carries key-block state across
    // chunks, so a chunk-split or over-long PEM key never leaks its body (issue #31).
    const stdoutRedactor = createOutputRedactor()
    const stderrRedactor = createOutputRedactor()
    // Each stream decodes through its OWN StringDecoder, so a multi-byte character split across two
    // pipe chunks survives instead of becoming U+FFFD (which would later be posted to GitHub).
    const capture = (redactor: { push(t: string): string }, raw?: (text: string) => void) => {
      const decoder = new StringDecoder('utf8')
      const deliver = (text: string) => {
        if (!text) return
        if (raw) {
          // A parser failure must never take the run down; the caller sees a missing result instead.
          try {
            raw(text)
          } catch {
            // Ignored on purpose.
          }
        }
        publish(redactor.push(text))
      }
      return {
        // Reset the stall clock on every raw chunk, before decoding: a run slowly writing one long
        // line is active, not silent (markActivity must see it even when nothing publishes yet).
        onData: (chunk: Buffer) => {
          deadline.markActivity()
          deliver(decoder.write(chunk))
        },
        end: () => deliver(decoder.end()),
      }
    }
    const stdoutCapture = capture(stdoutRedactor, options.onStdout)
    const stderrCapture = capture(stderrRedactor)
    child.stdout?.on('data', stdoutCapture.onData)
    child.stderr?.on('data', stderrCapture.onData)

    // Flush both redactors when the stream ends, so the final line (and its token footer) reaches
    // the transcript. A key block still open at close stays suppressed — flush emits no body.
    const flushOutput = () => {
      stdoutCapture.end()
      stderrCapture.end()
      publish(stdoutRedactor.flush())
      publish(stderrRedactor.flush())
    }

    child.on('error', error => {
      cleanupChild()
      flushOutput()
      deadline.stop()
      reject(error)
    })
    child.on('close', code => {
      // Cancel any pending SIGKILL and deregister now that the child is gone.
      cleanupChild()
      flushOutput()
      // Snapshot before stop so the active-time figure reflects the whole run; snapshot()
      // keeps working after stop, but reading it here keeps the intent obvious.
      const activeMs = deadline.snapshot().activeMs
      deadline.stop()
      resolve({ code, timedOut, stalled, activeMs, transcript })
    })
  })
}

function makeLogAppender(logDir: string | undefined, logName: string): (text: string) => void {
  if (!logDir) return () => {}
  try {
    fs.mkdirSync(logDir, { recursive: true })
  } catch {
    return () => {}
  }
  const file = path.join(logDir, `${logName}.log`)
  return text => {
    try {
      fs.appendFileSync(file, text)
    } catch {
      // Logging must never take the run down.
    }
  }
}
