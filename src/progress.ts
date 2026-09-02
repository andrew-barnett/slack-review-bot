// A live view of what the daemon is doing right now, for the status reply.
//
// The status handler must answer instantly even while a review is running — it does, because
// the review runs in a detached child process and the bot's event loop is free. The one rule
// this registry keeps is that every method is a cheap in-memory update: nothing here awaits a
// review, spawns a process, or touches the network, so reading a snapshot to answer "what are
// you working on?" can never be what makes the answer slow.
//
// A review moves through: enqueue (waiting for a slot) -> start (slot taken) -> attempt/output
// (a Codex run reporting progress, possibly across retries) -> done. `done` is called from the
// same settle path that clears the cursor, so a crash cannot leak an entry.

/** The most a surfaced output line may be before it is truncated for Slack. */
const MAX_LINE = 140

export interface ActiveReview {
  /** Short PR labels, e.g. `["orders-service#12", "lib#3"]`. */
  labels: string[]
  /** Wall-clock time since the slot was taken. */
  wallMs: number
  /** Active time the current attempt has run — sleep discounted, so it can be far under wall. */
  activeMs: number
  /** 1-based attempt number and how many are scheduled; equal means no retry has happened. */
  attempt: number
  attempts: number
  /** The last line of Codex output, cleaned and truncated. Absent until the run prints. */
  lastLine?: string
  /** Wall time since that last line arrived — the "last update 12s ago" figure. */
  sinceOutputMs?: number
}

export interface WaitingReview {
  labels: string[]
}

export interface ActivitySnapshot {
  active: ActiveReview[]
  waiting: WaitingReview[]
}

export interface ActiveReviews {
  /** Register a request that is waiting for a slot (or about to take one). */
  enqueue(key: string, labels: string[]): void
  /** The slot is taken: stamp the start time and the attempt schedule. */
  start(key: string, attempts: number): void
  /** A (re)try began: update the attempt number and clear the previous attempt's progress. */
  attempt(key: string, attempt: number): void
  /** A chunk of Codex output arrived. `activeMs` is the run's active time at that moment. */
  output(key: string, line: string, activeMs: number): void
  /** The review settled (passed, had findings, errored, or was skipped): forget it. */
  done(key: string): void
  /** What is running and what is waiting, as of `now`. */
  snapshot(now: number): ActivitySnapshot
}

interface Entry {
  labels: string[]
  startedAt?: number
  attempt: number
  attempts: number
  activeMs: number
  lastLine?: string
  lastOutputAt?: number
}

/**
 * Strip a Codex output line down to something safe and legible in a Slack line: no ANSI
 * colour codes or control characters, whitespace collapsed, and truncated. It is still raw
 * tool output, so a reader should treat it as a hint about what the run is doing, not as
 * trusted or complete text.
 */
export function cleanLine(text: string): string {
  const lines = text.split('\n')
  let last = ''
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    // eslint-disable-next-line no-control-regex
    const stripped = lines[i].replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').replace(/[\x00-\x1f\x7f]/g, ' ').trim()
    if (stripped) {
      last = stripped
      break
    }
  }
  // Backticks would break the inline-code span the status reply wraps this line in.
  const collapsed = last.replace(/\s+/g, ' ').replace(/`/g, "'")
  return collapsed.length > MAX_LINE ? `${collapsed.slice(0, MAX_LINE - 1)}…` : collapsed
}

export function createActiveReviews(now: () => number = Date.now): ActiveReviews {
  const entries = new Map<string, Entry>()

  return {
    enqueue(key, labels) {
      // Keep an existing entry's live fields if this key is somehow re-enqueued; only a fresh
      // key starts blank. Re-enqueue should not happen, but losing a running entry's progress
      // to a stray duplicate event would be worse than ignoring it.
      if (!entries.has(key)) {
        entries.set(key, { labels, attempt: 0, attempts: 0, activeMs: 0 })
      }
    },
    start(key, attempts) {
      const entry = entries.get(key)
      if (!entry) return
      entry.startedAt = now()
      entry.attempt = 1
      entry.attempts = Math.max(1, attempts)
      entry.activeMs = 0
      entry.lastLine = undefined
      entry.lastOutputAt = undefined
    },
    attempt(key, attempt) {
      const entry = entries.get(key)
      if (!entry) return
      entry.attempt = attempt
      // A retry is a fresh run: the previous attempt's active time and last line are stale.
      entry.activeMs = 0
      entry.lastLine = undefined
      entry.lastOutputAt = undefined
    },
    output(key, line, activeMs) {
      const entry = entries.get(key)
      if (!entry) return
      const cleaned = cleanLine(line)
      // A chunk that was only whitespace or control codes is still progress for the stall
      // clock, but there is nothing legible to show, so keep the previous visible line.
      if (cleaned) entry.lastLine = cleaned
      entry.activeMs = activeMs
      entry.lastOutputAt = now()
    },
    done(key) {
      entries.delete(key)
    },
    snapshot(at) {
      const active: ActiveReview[] = []
      const waiting: WaitingReview[] = []
      for (const entry of entries.values()) {
        if (entry.startedAt === undefined) {
          waiting.push({ labels: entry.labels })
          continue
        }
        active.push({
          labels: entry.labels,
          wallMs: Math.max(0, at - entry.startedAt),
          activeMs: entry.activeMs,
          attempt: entry.attempt,
          attempts: entry.attempts,
          lastLine: entry.lastLine,
          sinceOutputMs: entry.lastOutputAt === undefined ? undefined : Math.max(0, at - entry.lastOutputAt),
        })
      }
      return { active, waiting }
    },
  }
}
