// The termination contract for a deploy/restart (issue #32).
//
// A review runs 10-30 minutes and has side effects partway through (GitHub review comments, pushed
// test commits, Slack threads), so a restart that kills it mid-flight must not (a) settle the
// message as reviewed — that would silently drop it — nor (b) post a misleading error thread for a
// kill that was our own shutdown, not a failure of the PR.
//
// The contract is DRAIN-TO-IDLE: on a signal, stop accepting new work and wait for the active
// review(s) to settle, up to a bounded deadline, then exit. If the deadline passes first, the run
// is FORCED to stop: the `forced` flag then tells the job path to suppress the error thread and
// leave the cursor unsettled, so the review replays cleanly on the next start rather than being lost
// or mis-reported. Socket Mode is single-consumer and deploys never overlap, so there is only ever
// one draining instance and a clean replay cannot double up with a second live instance.
//
// Durable per-PR idempotency (so even a replay cannot repeat a side effect) and a split
// listener/worker (so a listener deploy never kills a worker) are stronger follow-ups (#35, #34).

/** Schedules a one-shot timer; injectable so tests need no real clock. Return value is ignored. */
export type SetTimer = (fn: () => void, ms: number) => unknown

export interface ShutdownController {
  /** True once a stop has been requested: the dispatcher rejects new reviews from this point. */
  readonly requested: boolean
  /** True once a drain timed out and the in-flight review(s) were force-killed (→ replay). */
  readonly forced: boolean
  /** Request a stop. Idempotent: returns true the first time, false if already requested. */
  request(): boolean
  /** Track an in-flight review so {@link drain} can wait for it; auto-untracked when it settles. */
  track(job: Promise<unknown>): void
  /** How many reviews are in flight. */
  active(): number
  /**
   * Wait for the tracked reviews to settle, up to `drainMs`. Resolves 'drained' when they all
   * settle first (or none are in flight), or 'forced' when the deadline passes first — in which
   * case {@link forced} becomes true so the caller force-kills and the job path replays cleanly.
   */
  drain(drainMs: number, setTimer?: SetTimer): Promise<'drained' | 'forced'>
}

const defaultSetTimer: SetTimer = (fn, ms) => {
  const timer = setTimeout(fn, ms)
  // Do not keep the event loop alive just for the drain deadline.
  ;(timer as { unref?: () => void }).unref?.()
  return timer
}

export function createShutdownController(): ShutdownController {
  const jobs = new Set<Promise<unknown>>()
  let requested = false
  let forced = false

  return {
    get requested() {
      return requested
    },
    get forced() {
      return forced
    },
    request() {
      if (requested) return false
      requested = true
      return true
    },
    track(job) {
      jobs.add(job)
      const drop = () => jobs.delete(job)
      // Untrack whether the review passed or threw; either way it is no longer in flight.
      void job.then(drop, drop)
    },
    active() {
      return jobs.size
    },
    async drain(drainMs, setTimer = defaultSetTimer) {
      if (jobs.size === 0) return 'drained'
      // Snapshot: new work is already rejected once `requested` is set, so nothing is added here.
      const settled = Promise.allSettled([...jobs]).then(() => 'drained' as const)
      const deadline = new Promise<'forced'>(resolve => setTimer(() => resolve('forced'), drainMs))
      const result = await Promise.race([settled, deadline])
      if (result === 'forced') forced = true
      return result
    },
  }
}
