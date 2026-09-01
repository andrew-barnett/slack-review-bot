import test from 'tape'
import { CursorTracker, type CursorFile } from './cursor'
import { planReplay, replayMissed, type HistoryResult, type ReplayDeps } from './replay'
import type { SlackMessageEvent } from './slack'

const HOUR = 60 * 60 * 1000
const NOW = 1_723_500_000_000

/** A message `minutesAgo` before NOW. `pr` marks it as a review request for these tests. */
function msg(minutesAgo: number, pr = true): SlackMessageEvent {
  const ts = ((NOW - minutesAgo * 60_000) / 1000).toFixed(6)
  return { type: 'message', channel: 'C1', ts, user: 'U1', text: pr ? 'review this' : 'hello' }
}

const isRequest = (message: SlackMessageEvent): boolean => (message.text ?? '').includes('review')

const limits = { maxAgeMs: 24 * HOUR, maxRequests: 10, maxMessages: 1000 }

// Chatter is not a review request, but it still has to be accounted for — otherwise the
// cursor cannot move past it and the same history is re-read on every restart.
test('planReplay separates review requests from everything else', t => {
  const plan = planReplay([msg(10), msg(9, false), msg(8)], { now: NOW, limits, settled: [], inFlight: [], isRequest })
  t.deepEqual(plan.dispatch.map(m => m.ts), [msg(10).ts, msg(8).ts], 'requests, oldest first')
  t.deepEqual(plan.ignored, [msg(9, false).ts], 'the rest is recorded, not dispatched')
  t.deepEqual(plan.skipped, [])
  t.end()
})

// The laptop-was-closed case. A PR posted three days ago has usually been merged, closed, or
// force-pushed past; spending 20 minutes of local machine time on it at startup is worse than
// saying so in the log.
test('planReplay leaves messages older than the age limit alone', t => {
  const plan = planReplay([msg(40 * 60), msg(30)], { now: NOW, limits, settled: [], inFlight: [], isRequest })
  t.deepEqual(plan.dispatch.map(m => m.ts), [msg(30).ts], 'only the recent request')
  t.deepEqual(plan.skipped, [{ ts: msg(40 * 60).ts, reason: 'too-old' }])
  t.end()
})

// At concurrency 1 each replayed request costs 10-30 minutes, so a long backlog would leave
// the bot working through history instead of answering whatever is asked next. The cap keeps
// the newest requests, which are the ones most likely to still matter.
test('planReplay caps the backlog and keeps the newest requests', t => {
  const messages = [msg(50), msg(40), msg(30), msg(20), msg(10)]
  const plan = planReplay(messages, {
    now: NOW,
    limits: { ...limits, maxRequests: 2 },
    settled: [],
    inFlight: [],
    isRequest,
  })
  t.deepEqual(plan.dispatch.map(m => m.ts), [msg(20).ts, msg(10).ts], 'the two newest, in order')
  t.deepEqual(
    plan.skipped.map(s => s.ts),
    [msg(50).ts, msg(40).ts, msg(30).ts],
    'the older ones are reported, not silently dropped'
  )
  t.ok(plan.skipped.every(s => s.reason === 'over-limit'))
  t.end()
})

// A review that finished while an older one was still running sits above the watermark in
// `done`. Replaying it would post a second findings thread on a message that already has one.
test('planReplay skips messages the cursor has already settled', t => {
  const plan = planReplay([msg(20), msg(10)], {
    now: NOW,
    limits,
    settled: [msg(10).ts as string],
    inFlight: [],
    isRequest,
  })
  t.deepEqual(plan.dispatch.map(m => m.ts), [msg(20).ts])
  t.end()
})

// conversations.history returns newest-first. Serving requests in that order would make the
// bot look like it skipped the person who asked first.
test('planReplay dispatches oldest first whatever order history arrives in', t => {
  const plan = planReplay([msg(10), msg(30), msg(20)], { now: NOW, limits, settled: [], inFlight: [], isRequest })
  t.deepEqual(plan.dispatch.map(m => m.ts), [msg(30).ts, msg(20).ts, msg(10).ts])
  t.end()
})

interface Harness {
  deps: ReplayDeps
  cursors: CursorTracker
  dispatched: string[]
  events: string[]
}

function harness(
  history: Record<string, HistoryResult | Error>,
  initial?: CursorFile
): Harness {
  const events: string[] = []
  const cursors = new CursorTracker(
    { persist: () => {}, now: () => NOW, log: e => events.push(e) },
    initial
  )
  const dispatched: string[] = []
  return {
    cursors,
    dispatched,
    events,
    deps: {
      async fetch(channel) {
        const result = history[channel]
        if (result instanceof Error) throw result
        return result ?? { messages: [], truncated: false }
      },
      // Stands in for app.ts's dispatch: it begins the message and leaves it pending, which
      // is what a queued review looks like from the cursor's point of view.
      async dispatch(message) {
        dispatched.push(message.ts as string)
        cursors.begin(message.channel as string, message.ts as string)
        return true
      },
      cursors,
      isRequest,
      limits,
      log: event => events.push(event),
      now: () => NOW,
    },
  }
}

// The first run of a fresh install, or a channel added to the allowlist today: reviewing every
// PR link in the readable history would be a spectacular way to introduce yourself.
test('replayMissed starts an unseen channel at now instead of replaying it', async t => {
  const h = harness({ C1: { messages: [msg(10)], truncated: false } })
  const summary = await replayMissed(['C1'], h.deps)
  t.deepEqual(h.dispatched, [], 'nothing replayed')
  t.equal(summary.dispatched, 0)
  t.ok(h.cursors.watermark('C1'), 'but the channel now has a position')
  t.ok(h.events.includes('cursor.started'))
  t.end()
})

// The ordering rule that makes replay safe to interrupt: a queued review has to hold the
// cursor below itself even though newer chatter in the same batch is already accounted for.
// Get this backwards and a restart during the replayed review loses it for good.
test('replayMissed keeps the cursor below a request it just queued', async t => {
  const older = msg(20)
  const newerChatter = msg(5, false)
  const h = harness(
    { C1: { messages: [newerChatter, older], truncated: false } },
    { version: 1, channels: { C1: { ts: '1.000000', done: [], updatedAt: '' } } }
  )

  await replayMissed(['C1'], h.deps)
  t.deepEqual(h.dispatched, [older.ts], 'the request was queued')
  t.equal(h.cursors.watermark('C1'), '1.000000', 'and the cursor did not step over it')
  t.deepEqual(h.cursors.settled('C1'), [newerChatter.ts], 'the chatter is accounted for above it')

  // Once the review finishes, the whole window collapses in one go.
  h.cursors.settle('C1', older.ts as string)
  t.equal(h.cursors.watermark('C1'), newerChatter.ts)
  t.end()
})

// Being removed from one channel, or losing a scope for it, must not stop the other channels
// being caught up — and must not advance the cursor of the channel that failed, or its
// backlog would be lost without ever being read.
test('replayMissed steps over a channel it cannot read', async t => {
  const h = harness(
    {
      C1: new Error('missing_scope'),
      C2: { messages: [msg(10)], truncated: false },
    },
    {
      version: 1,
      channels: {
        C1: { ts: '1.000000', done: [], updatedAt: '' },
        C2: { ts: '1.000000', done: [], updatedAt: '' },
      },
    }
  )
  const summary = await replayMissed(['C1', 'C2'], h.deps)
  t.equal(summary.failed, 1)
  t.equal(summary.dispatched, 1, 'the healthy channel still caught up')
  t.equal(h.cursors.watermark('C1'), '1.000000', 'the failed channel keeps its position for next time')
  t.ok(h.events.includes('replay.failed'))
  t.end()
})

// Truncation is the one case where the bot knowingly drops messages it was asked about, so it
// has to be visible in the log rather than inferred from a quiet startup.
test('replayMissed reports a history read that hit the message limit', async t => {
  const h = harness(
    { C1: { messages: [msg(10)], truncated: true } },
    { version: 1, channels: { C1: { ts: '1.000000', done: [], updatedAt: '' } } }
  )
  await replayMissed(['C1'], h.deps)
  t.ok(h.events.includes('replay.truncated'))
  t.end()
})

// With no allowlist and no cursor file yet there is nothing to catch up on, and asking Slack
// which channels the bot is in would need a scope it does not have.
test('replayMissed does nothing when there are no channels', async t => {
  const h = harness({})
  const summary = await replayMissed([], h.deps)
  t.deepEqual(summary, { channels: 0, dispatched: 0, skipped: 0, failed: 0 })
  t.ok(h.events.includes('replay.empty'))
  t.end()
})

// The production symptom, exactly. The cursor deliberately holds the watermark below a message
// under review, so every catch-up re-reads it: for a three-hour review at a five-minute
// cadence that is thirty-six re-dispatches of a job already running. Each bounces off a
// BOUNDED LRU dedupe set, so a busy enough channel evicts the key mid-review and the next pass
// starts a genuine second Codex run on the same PR.
test('planReplay skips a message that is still being reviewed', t => {
  const plan = planReplay([msg(20), msg(10)], {
    now: NOW,
    limits,
    settled: [],
    inFlight: [msg(10).ts as string],
    isRequest,
  })
  t.deepEqual(plan.dispatch.map(m => m.ts), [msg(20).ts], 'the in-flight one is left alone')
  t.deepEqual(plan.skipped, [], 'it was not dropped')
  // Load-bearing: `ignored` is recorded, and recording is settling. Filing a running review
  // there would advance the watermark past a review that has not produced a verdict yet.
  t.deepEqual(plan.ignored, [], 'and above all it is not recorded as done')
  t.end()
})

// End to end over the real CursorTracker, since the whole point is that `pending` and the
// watermark disagree on purpose and replay has to read both.
test('a second catch-up does not re-dispatch a review that is still running', async t => {
  const request = msg(10)
  const h = harness({ C1: { messages: [request], truncated: false } }, {
    version: 1,
    channels: { C1: { ts: '1.000000', done: [], updatedAt: '' } },
  })

  const first = await replayMissed(['C1'], h.deps)
  t.equal(first.dispatched, 1, 'the first pass queues it')
  t.deepEqual(h.dispatched, [request.ts])

  const second = await replayMissed(['C1'], h.deps)
  t.equal(second.dispatched, 0, 'the second pass leaves the running review alone')
  t.deepEqual(h.dispatched, [request.ts], 'dispatch was not called a second time')
  t.equal(h.cursors.watermark('C1'), '1.000000', 'and the watermark still waits for it')
  t.end()
})

// dispatched used to be plan.dispatch.length — what the pass INTENDED. A deduped request was
// counted as work done, so a status reply claimed "1 requeued" every five minutes for three
// hours about a review that had been queued once.
test('the summary counts what was queued, not what was planned', async t => {
  const h = harness({ C1: { messages: [msg(10)], truncated: false } }, {
    version: 1,
    channels: { C1: { ts: '1.000000', done: [], updatedAt: '' } },
  })
  // Stands in for the dedupe set absorbing a request: Slack retried the event and the live
  // path got there first.
  h.deps.dispatch = async () => false

  const summary = await replayMissed(['C1'], h.deps)
  t.equal(summary.dispatched, 0, 'a request nobody queued is not reported as queued')
  t.end()
})
