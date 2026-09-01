import test from 'tape'
import {
  CatchUpRunner,
  createConnectionTracker,
  createFreezeDetector,
  type CatchUpReason,
} from './catchup'
import type { ReplaySummary } from './replay'

const summary = (dispatched = 0): ReplaySummary => ({ channels: 1, dispatched, skipped: 0, failed: 0 })

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(res => {
    resolve = res
  })
  return { promise, resolve }
}

/**
 * Let every pending microtask run.
 *
 * request() appends to a promise chain, so the first run starts a microtask later rather than
 * synchronously — asserting straight after the call sees nothing started at all and reads like
 * the queue is working when it has simply not begun.
 */
const drain = (): Promise<void> => new Promise(resolve => setImmediate(resolve))

// The reason the runner exists. Two replays of one channel read the same history and
// interleave begin/settle on the same ts, which can walk the watermark past a review still
// sitting in the queue — a message acknowledged with :eyes: that no restart will ever
// re-dispatch. Concurrency here is silent and permanent, so it is worth asserting directly.
test('CatchUpRunner never runs two catch-ups at once', async t => {
  const gate = deferred<ReplaySummary>()
  const started: CatchUpReason[] = []
  let concurrent = 0
  let peak = 0
  const runner = new CatchUpRunner({
    run: async reason => {
      started.push(reason)
      concurrent += 1
      peak = Math.max(peak, concurrent)
      const result = started.length === 1 ? await gate.promise : summary()
      concurrent -= 1
      return result
    },
    log: () => {},
    now: () => 0,
  })

  const first = runner.request('startup')
  const second = runner.request('reconnect')
  await drain()
  t.equal(started.length, 1, 'the second request waits instead of starting')
  gate.resolve(summary())
  await Promise.all([first, second])
  t.deepEqual(started, ['startup', 'reconnect'], 'both ran, in request order')
  t.equal(peak, 1, 'and never at the same time')
  t.end()
})

// A laptop waking on a flaky network produces a burst of reconnects — the error log shows
// the counter reaching :20 in an afternoon. Each one asking for its own catch-up would spend
// the afternoon paging history instead of reviewing, and every pass after the first would
// read exactly what the queued one is about to.
test('CatchUpRunner coalesces requests behind the one already waiting', async t => {
  const gate = deferred<ReplaySummary>()
  const started: CatchUpReason[] = []
  const events: string[] = []
  const runner = new CatchUpRunner({
    run: async reason => {
      started.push(reason)
      return started.length === 1 ? gate.promise : summary()
    },
    log: event => events.push(event),
    now: () => 0,
  })

  void runner.request('startup')
  void runner.request('reconnect')
  const third = runner.request('timer')
  t.ok(events.includes('catchup.coalesced'), 'the third is dropped rather than queued')
  gate.resolve(summary())
  await third
  t.deepEqual(started, ['startup', 'reconnect'], 'a reconnect storm costs one extra pass')
  t.end()
})

// Coalescing has one way to turn against us, and this is the only thing that would show it.
// WebClient defaults to no HTTP timeout, so a wedged conversations.history leaves the runner
// permanently busy and silently coalesces every later request away — the catch-up stops with
// no error logged anywhere. The duration on the coalesce line is what makes that diagnosable.
test('a coalesced request reports how long the running pass has been stuck', async t => {
  const gate = deferred<ReplaySummary>()
  const coalesced: Array<Record<string, unknown>> = []
  let clock = 0
  const runner = new CatchUpRunner({
    run: () => gate.promise,
    log: (event, fields) => {
      if (event === 'catchup.coalesced' && fields) coalesced.push(fields)
    },
    now: () => clock,
  })

  t.equal(runner.runningForMs(0), undefined, 'idle reports no running pass')
  void runner.request('startup')
  void runner.request('timer')
  await drain()

  clock = 12 * 60_000
  t.equal(runner.runningForMs(clock), 12 * 60_000, 'a wedged pass is measurable')
  void runner.request('timer')
  t.equal(coalesced.length, 1, 'the third request is coalesced')
  t.equal(coalesced[0].runningForMs, 12 * 60_000, 'and carries the duration that makes it a bug')

  gate.resolve(summary())
  await drain()
  t.equal(runner.runningForMs(clock), undefined, 'and it clears once the pass finishes')
  t.end()
})

// The runner is driven by event handlers and a timer, so a rejection escaping it would be an
// unhandled rejection — which is the crash-and-let-launchd-restart-it behaviour this whole
// change exists to stop depending on. It also must not leave its slot taken: a permanently
// busy runner coalesces every later request away and the bot silently stops catching up.
test('a catch-up that throws is recorded and does not wedge the runner', async t => {
  const events: string[] = []
  let calls = 0
  const runner = new CatchUpRunner({
    run: async () => {
      calls += 1
      if (calls === 1) throw new Error('history unreadable')
      return summary(2)
    },
    log: event => events.push(event),
    now: () => 1000,
  })

  await runner.request('startup')
  t.ok(events.includes('catchup.failed'), 'the failure is logged')
  t.equal(runner.last()?.error, 'Error: history unreadable', 'and survives into the status record')
  t.equal(runner.busy, false, 'the slot is released')

  await runner.request('timer')
  t.equal(runner.last()?.summary?.dispatched, 2, 'a later catch-up still runs')
  t.equal(runner.last()?.reason, 'timer', 'and the record describes the latest one')
  t.end()
})

// The rule that is easy to get wrong and impossible to see: the first `connected` arrives
// from inside app.start(), before the startup catch-up has run. Counting it as a reconnect
// would race a second pass against the startup one — harmless-looking, and exactly the kind
// of duplicate work that makes a log unreadable when something real goes wrong.
test('the first connection is not a reconnect and does not trigger a catch-up', t => {
  const asked: CatchUpReason[] = []
  const tracker = createConnectionTracker({
    catchUp: reason => asked.push(reason),
    log: () => {},
    now: () => 5,
    catchUpOnReconnect: true,
  })

  tracker.onConnected()
  t.deepEqual(asked, [], 'startup runs its own catch-up already')
  t.equal(tracker.state.reconnects, 0, 'and connecting once is not reconnecting')
  t.equal(tracker.state.connected, true)

  tracker.onDisconnected()
  t.equal(tracker.state.connected, false, 'a drop is visible to a status request')
  tracker.onConnected()
  t.deepEqual(asked, ['reconnect'], 'the gap the socket just left gets read back')
  t.equal(tracker.state.reconnects, 1)
  t.end()
})

// Turning the reconnect trigger off must not also blind the status reply: "20 reconnects and
// no catch-up since startup" is the diagnosis, so the counter has to keep moving even when
// nothing acts on it.
test('CATCHUP_ON_RECONNECT off still tracks the socket', t => {
  const asked: CatchUpReason[] = []
  const events: string[] = []
  const tracker = createConnectionTracker({
    catchUp: reason => asked.push(reason),
    log: event => events.push(event),
    now: () => 0,
    catchUpOnReconnect: false,
  })

  tracker.onConnected()
  tracker.onReconnecting()
  t.equal(tracker.state.connected, false, 'reconnecting is not connected')
  tracker.onConnected()
  t.deepEqual(asked, [], 'no catch-up was requested')
  t.equal(tracker.state.reconnects, 1, 'but the reconnect is still counted')
  t.ok(events.includes('catchup.skipped'), 'and the daemon says why it did nothing')
  t.end()
})

// A closed laptop suspends the process outright, so a pass in flight when the lid shuts is
// still in flight on wake with a wall clock that jumped. One weekend produced a runningForMs
// of 122336950 - thirty-four hours - for a pass that then finished two seconds later. A stall
// signal that cries wolf after every sleep is one nobody reads when the genuine 30-minute
// retry stall shows up next to it.
test('a frozen process is not counted against the running pass', async t => {
  const gate = deferred<ReplaySummary>()
  let clock = 0
  const runner = new CatchUpRunner({ run: () => gate.promise, log: () => {}, now: () => clock })

  void runner.request('timer')
  await drain()

  const weekend = 34 * 60 * 60_000
  clock = weekend
  t.equal(runner.runningForMs(clock), weekend, 'the wall clock alone blames the pass for the sleep')
  runner.noteFreeze(weekend - 2000)
  t.equal(runner.runningForMs(clock), 2000, 'discounting the freeze leaves the two seconds it really ran')

  gate.resolve(summary())
  await drain()
  t.equal(runner.runningForMs(clock), undefined, 'and it still clears normally')
  t.end()
})

// Deliberately not performance.now(): whether a monotonic clock advances across system sleep
// is platform- and libuv-specific, so the fix has to rest on something unambiguous. A heartbeat
// that should have fired 30s ago and fires 34 hours late is that. The tolerance is what keeps
// ordinary event-loop congestion - a review spawning, a big history page parsing - from
// registering as a suspend.
test('the freeze detector tells a suspended process from a merely busy one', t => {
  let clock = 0
  const frozen: number[] = []
  const events: string[] = []
  const detector = createFreezeDetector({
    now: () => clock,
    onFreeze: ms => frozen.push(ms),
    log: event => events.push(event),
    checkMs: 30_000,
    toleranceMs: 30_000,
  })

  clock = 30_000
  detector.check()
  t.deepEqual(frozen, [], 'a tick on time is not a freeze')

  clock += 45_000
  detector.check()
  t.deepEqual(frozen, [], '15s of congestion is not either')

  const weekend = 34 * 60 * 60_000
  clock += weekend
  detector.check()
  t.equal(frozen.length, 1, 'a lid closed for the weekend is')
  t.equal(frozen[0], weekend - 30_000, 'reported as the lateness beyond the expected gap')
  t.ok(events.includes('clock.jumped'), 'and says so in the log')

  clock += 30_000
  detector.check()
  t.equal(frozen.length, 1, 'the baseline resets, so the next tick is ordinary again')
  t.end()
})
