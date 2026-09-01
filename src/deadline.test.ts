import test from 'tape'
import { startActiveDeadline, type DeadlineSnapshot } from './deadline'

/** A hand-cranked clock and interval, so a test can decide exactly when each tick lands. */
function fakeClock(start = 1_000_000) {
  let now = start
  let callback: (() => void) | undefined
  let cleared = 0
  return {
    deps: {
      now: () => now,
      setInterval: (cb: () => void) => {
        callback = cb
        return 1 as unknown as ReturnType<typeof setInterval>
      },
      clearInterval: () => {
        cleared += 1
      },
    },
    /** Advance the clock by `ms` and fire the heartbeat, as the event loop would on time. */
    tick(ms: number) {
      now += ms
      callback?.()
    },
    get cleared() {
      return cleared
    },
  }
}

const CHECK = 10_000
const TOLERANCE = 5_000

// The ordinary case has to keep working: a run that is awake the whole time is killed once
// its budget is spent, within one heartbeat of the moment it would have been under setTimeout.
test('startActiveDeadline expires after the budget of ordinary ticks', t => {
  const clock = fakeClock()
  const expired: DeadlineSnapshot[] = []
  startActiveDeadline(60_000, s => expired.push(s), { ...clock.deps, checkMs: CHECK, toleranceMs: TOLERANCE })

  for (let i = 0; i < 5; i += 1) clock.tick(CHECK)
  t.equal(expired.length, 0, '50s of a 60s budget is not expired')
  clock.tick(CHECK)
  t.equal(expired.length, 1, 'the sixth 10s tick spends the budget')
  t.equal(expired[0].activeMs, 60_000)
  t.equal(expired[0].frozenMs, 0, 'nothing was frozen, so nothing was discounted')
  t.equal(clock.cleared, 1, 'the heartbeat is cleared on expiry')
  t.end()
})

// The regression this module exists for: a tick that fires hours late is a machine that was
// asleep, and that stretch must not be charged to the run. Under setTimeout the same gap
// killed a review that had done four minutes of work.
test('startActiveDeadline does not charge a long suspension against the budget', t => {
  const clock = fakeClock()
  const expired: DeadlineSnapshot[] = []
  const freezes: number[] = []
  const deadline = startActiveDeadline(60_000, s => expired.push(s), {
    ...clock.deps,
    checkMs: CHECK,
    toleranceMs: TOLERANCE,
    onFreeze: frozenForMs => freezes.push(frozenForMs),
  })

  clock.tick(CHECK)
  clock.tick(4 * 60 * 60 * 1000) // the lid was closed for four hours
  t.equal(expired.length, 0, 'four hours of sleep did not expire a one-minute budget')
  t.deepEqual(freezes, [4 * 60 * 60 * 1000 - CHECK], 'the excess over one interval is the freeze')
  const mid = deadline.snapshot()
  t.equal(mid.activeMs, 2 * CHECK, 'the frozen tick is charged as one ordinary interval')
  t.equal(mid.frozenMs, 4 * 60 * 60 * 1000 - CHECK)

  for (let i = 0; i < 3; i += 1) clock.tick(CHECK)
  t.equal(expired.length, 0, '50s active so far')
  clock.tick(CHECK)
  t.equal(expired.length, 1, 'expires once the *active* total reaches the budget')
  t.ok(expired[0].wallMs > 4 * 60 * 60 * 1000, 'the snapshot still reports the true wall-clock span')
  t.end()
})

// Timer jitter is real time the run had. Treating every slightly-late tick as a suspension
// would slowly stretch the budget on a busy machine, so lateness within tolerance is charged.
test('startActiveDeadline charges lateness within tolerance in full', t => {
  const clock = fakeClock()
  const freezes: number[] = []
  const deadline = startActiveDeadline(600_000, () => {}, {
    ...clock.deps,
    checkMs: CHECK,
    toleranceMs: TOLERANCE,
    onFreeze: frozenForMs => freezes.push(frozenForMs),
  })
  clock.tick(CHECK + TOLERANCE) // exactly at tolerance: still jitter
  t.deepEqual(freezes, [], 'no freeze reported at the tolerance boundary')
  t.equal(deadline.snapshot().activeMs, CHECK + TOLERANCE, 'the whole late tick is charged')
  clock.tick(CHECK + TOLERANCE + 1) // one past tolerance: a suspension
  t.equal(freezes.length, 1, 'one past the boundary is a freeze')
  t.equal(deadline.snapshot().activeMs, 2 * CHECK + TOLERANCE, 'the frozen tick is charged one interval')
  t.end()
})

// A run that finishes must release its heartbeat, and a stopped deadline must never fire —
// otherwise a completed review's timer would go on to kill an unrelated later process group.
test('startActiveDeadline.stop cancels the heartbeat and suppresses expiry', t => {
  const clock = fakeClock()
  const expired: DeadlineSnapshot[] = []
  const deadline = startActiveDeadline(20_000, s => expired.push(s), { ...clock.deps, checkMs: CHECK, toleranceMs: TOLERANCE })
  clock.tick(CHECK)
  deadline.stop()
  deadline.stop()
  t.equal(clock.cleared, 1, 'stop is idempotent — one clearInterval for two calls')
  clock.tick(CHECK)
  clock.tick(CHECK)
  t.equal(expired.length, 0, 'ticks after stop are ignored')
  t.end()
})

// A budget shorter than the default heartbeat must still be checked promptly; without the
// clamp a 5s budget would be noticed 30s in, which makes the setting lie for short values.
test('startActiveDeadline clamps the heartbeat to the budget', t => {
  const intervals: number[] = []
  startActiveDeadline(5_000, () => {}, {
    now: () => 0,
    setInterval: (_cb, ms) => {
      intervals.push(ms)
      return 1 as unknown as ReturnType<typeof setInterval>
    },
    clearInterval: () => {},
  })
  t.deepEqual(intervals, [5_000])
  t.end()
})
