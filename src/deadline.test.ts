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

// --- Stall detection: the run must show progress within a grace of *active* time. ---

const STALL = 40_000 // four CHECK intervals

// The core signal: a run that goes silent for its whole grace is flagged, once, and the
// heartbeat stops. The grace is spent in whole CHECK intervals of accrued active time.
test('startActiveDeadline flags a stall after the grace of silent active time', t => {
  const clock = fakeClock()
  const stalls: number[] = []
  startActiveDeadline(10 * 60_000, () => t.fail('the budget must not expire in this test'), {
    ...clock.deps,
    checkMs: CHECK,
    toleranceMs: TOLERANCE,
    stallMs: STALL,
    onStall: idle => stalls.push(idle),
  })

  for (let i = 0; i < 3; i += 1) clock.tick(CHECK)
  t.equal(stalls.length, 0, '30s of silence is under the 40s grace')
  clock.tick(CHECK)
  t.equal(stalls.length, 1, 'the fourth silent tick crosses the grace')
  t.ok(stalls[0] >= STALL, 'the reported idle is at least the grace')
  t.equal(clock.cleared, 1, 'the heartbeat is cleared on a stall')
  t.end()
})

// markActivity is what makes the grace mean "silent" rather than "slow": a run that keeps
// producing output resets the clock each time and is never flagged, however long it runs.
test('markActivity resets the stall clock so a talkative run is never flagged', t => {
  const clock = fakeClock()
  const stalls: number[] = []
  const deadline = startActiveDeadline(10 * 60_000, () => t.fail('no expiry'), {
    ...clock.deps,
    checkMs: CHECK,
    toleranceMs: TOLERANCE,
    stallMs: STALL,
    onStall: idle => stalls.push(idle),
  })

  // Progress on each of six ticks — well past the grace measured from the start.
  for (let i = 0; i < 6; i += 1) {
    clock.tick(CHECK)
    deadline.markActivity()
  }
  t.equal(stalls.length, 0, 'activity every tick keeps the run alive indefinitely')

  // Then fall silent: the grace is now measured from the last activity.
  for (let i = 0; i < 3; i += 1) clock.tick(CHECK)
  t.equal(stalls.length, 0, 'still under the grace since the last output')
  clock.tick(CHECK)
  t.equal(stalls.length, 1, 'flagged once the grace passes with no further output')
  t.end()
})

// Issue #8: output that arrives between heartbeats must reset the grace from the moment it
// arrived, not from the previous tick. markActivity now advances active time to now() before
// recording, so a run that spoke mid-interval gets the full grace from then — the old code
// recorded the previous tick's activeMs and would flag the stall a whole interval early.
test('markActivity credits silence from the output moment, not the previous tick', t => {
  let now = 1_000_000
  let cb: (() => void) | undefined
  const stalls: number[] = []
  const deadline = startActiveDeadline(10 * 60_000, () => t.fail('no expiry'), {
    now: () => now,
    setInterval: (fn: () => void) => {
      cb = fn
      return 1 as unknown as ReturnType<typeof setInterval>
    },
    clearInterval: () => {},
    checkMs: CHECK,
    toleranceMs: TOLERANCE,
    stallMs: STALL, // 40s = four CHECK intervals
    onStall: idle => stalls.push(idle),
  })

  // Output arrives 9s into the first interval, before any heartbeat has fired.
  now += CHECK - 1_000
  deadline.markActivity() // fix: active time advances to 9s and that is recorded as last output

  // Active time at the output was 9s. The grace (40s) is measured from there, so the stall
  // must land when active time reaches 49s — the fourth silent 10s tick (19s, 29s, 39s, 49s).
  for (let i = 0; i < 3; i += 1) {
    now += CHECK
    cb!()
  }
  t.equal(stalls.length, 0, '30s of silence since the 9s output is under the 40s grace')

  now += CHECK
  cb!() // active time now 49s: 40s since the output
  t.equal(stalls.length, 1, 'flagged once the grace elapses from the actual last output')
  t.end()
})

// The regression this shares with the budget: a machine asleep is not a run gone silent. A
// four-hour suspension is charged as one interval of idle, so it cannot trip the grace.
test('startActiveDeadline does not count a suspension as idle toward a stall', t => {
  const clock = fakeClock()
  const stalls: number[] = []
  startActiveDeadline(10 * 60_000, () => t.fail('no expiry'), {
    ...clock.deps,
    checkMs: CHECK,
    toleranceMs: TOLERANCE,
    stallMs: STALL,
    onStall: idle => stalls.push(idle),
  })

  clock.tick(CHECK) // one active interval of silence
  clock.tick(4 * 60 * 60 * 1000) // asleep four hours: charged as one interval, not four hours
  t.equal(stalls.length, 0, 'four hours asleep is not four hours of silence')
  clock.tick(CHECK)
  clock.tick(CHECK)
  t.equal(stalls.length, 1, 'the grace is reached only by real active silence once awake')
  t.end()
})

// When a run both runs out of budget and crosses the stall grace on the same tick, the budget
// wins: "used all its time" is the more accurate account than "went silent".
test('startActiveDeadline reports expiry, not a stall, when both land on one tick', t => {
  const clock = fakeClock()
  const expired: DeadlineSnapshot[] = []
  const stalls: number[] = []
  startActiveDeadline(20_000, s => expired.push(s), {
    ...clock.deps,
    checkMs: CHECK,
    toleranceMs: TOLERANCE,
    stallMs: 20_000,
    onStall: idle => stalls.push(idle),
  })

  clock.tick(CHECK)
  clock.tick(CHECK) // active reaches 20s: both the budget and the stall grace at once
  t.equal(expired.length, 1, 'the budget expiry is reported')
  t.equal(stalls.length, 0, 'the stall is not also reported')
  t.end()
})

// Stall detection is opt-in: with no grace configured the deadline behaves exactly as before,
// counting the budget and nothing else.
test('startActiveDeadline never stalls when no grace is configured', t => {
  const clock = fakeClock()
  const stalls: number[] = []
  startActiveDeadline(10 * 60_000, () => t.fail('no expiry'), {
    ...clock.deps,
    checkMs: CHECK,
    toleranceMs: TOLERANCE,
    onStall: idle => stalls.push(idle),
  })
  for (let i = 0; i < 20; i += 1) clock.tick(CHECK)
  t.equal(stalls.length, 0, 'no grace means no stall, however long the silence')
  t.end()
})
