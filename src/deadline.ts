// A time budget that only counts time the process was actually running.
//
// `setTimeout(kill, 3h)` measures wall-clock time, and a closed laptop keeps the wall clock
// running while the process is suspended outright. A review that started at 15:27, was
// asleep for the entire afternoon, and was still installing dependencies when the lid opened
// at 18:33 got killed at 18:35 for "exceeding" a timeout it had used about four minutes of.
// The queue behind it then inherited the same problem: its run started during a two-second
// maintenance wake, so most of its three hours had elapsed before anyone opened the lid.
//
// The catch-up runner already had the answer for its own stall signal — a heartbeat that
// notices it fired far later than scheduled and discounts the gap (`createFreezeDetector`).
// This is that idea as a deadline: a 30-second heartbeat accumulates active time, a tick that
// arrives much later than 30 seconds is credited as one 30-second interval and the rest is
// booked as frozen, and the budget expires only when the *active* total reaches it.
//
// Deliberately not `performance.now()`: whether a monotonic clock advances across system sleep
// is platform- and libuv-specific, while a timer that fires an hour late is unambiguous.

export interface DeadlineSnapshot {
  /** Time the budget has been charged for. */
  activeMs: number
  /** Time since the deadline started, by the wall clock. */
  wallMs: number
  /** Time the process is judged to have been suspended, and was not charged for. */
  frozenMs: number
}

export interface DeadlineDeps {
  now(): number
  setInterval(callback: () => void, ms: number): ReturnType<typeof setInterval>
  clearInterval(handle: ReturnType<typeof setInterval>): void
  /** Heartbeat cadence. Also the most one tick can be charged. */
  checkMs: number
  /** How late a tick may fire before the excess is treated as a suspension rather than jitter. */
  toleranceMs: number
  /** Told about each suspension, with the deadline's state after discounting it. */
  onFreeze?(frozenForMs: number, snapshot: DeadlineSnapshot): void
}

export interface ActiveDeadline {
  /** Cancel the deadline; `onExpire` will not be called after this. Idempotent. */
  stop(): void
  snapshot(): DeadlineSnapshot
}

export const DEADLINE_CHECK_MS = 30_000
export const DEADLINE_TOLERANCE_MS = 30_000

/**
 * Start counting `budgetMs` of active time, calling `onExpire` once when it runs out.
 *
 * A tick that fires no more than `toleranceMs` late is charged in full — timer jitter under
 * load is real time the run had. A tick later than that is charged `checkMs` and the excess
 * is recorded as frozen. The event loop cannot fire a timer while the process is suspended, so
 * a long gap between two consecutive ticks is exactly the sleep that should not count.
 */
export function startActiveDeadline(
  budgetMs: number,
  onExpire: (snapshot: DeadlineSnapshot) => void,
  overrides: Partial<DeadlineDeps> = {}
): ActiveDeadline {
  const deps: DeadlineDeps = {
    now: Date.now,
    setInterval: (callback, ms) => setInterval(callback, ms),
    clearInterval: handle => clearInterval(handle),
    // A budget shorter than the heartbeat would otherwise be checked only after it had been
    // exceeded by most of a heartbeat; clamping keeps short (test-sized) budgets honest.
    checkMs: Math.max(1, Math.min(DEADLINE_CHECK_MS, budgetMs)),
    toleranceMs: DEADLINE_TOLERANCE_MS,
    ...overrides,
  }

  const startedAt = deps.now()
  let last = startedAt
  let activeMs = 0
  let frozenMs = 0
  let handle: ReturnType<typeof setInterval> | undefined

  const snapshot = (): DeadlineSnapshot => ({ activeMs, wallMs: deps.now() - startedAt, frozenMs })

  const stop = (): void => {
    if (handle === undefined) return
    deps.clearInterval(handle)
    handle = undefined
  }

  const tick = (): void => {
    if (handle === undefined) return
    const at = deps.now()
    const elapsed = at - last
    last = at
    const late = elapsed - deps.checkMs
    if (late > deps.toleranceMs) {
      // Suspended: charge the interval that was scheduled, not the time nobody was executing.
      activeMs += deps.checkMs
      frozenMs += late
      deps.onFreeze?.(late, snapshot())
    } else {
      activeMs += elapsed
    }
    if (activeMs >= budgetMs) {
      stop()
      onExpire(snapshot())
    }
  }

  handle = deps.setInterval(tick, deps.checkMs)
  return { stop, snapshot }
}
