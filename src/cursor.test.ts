import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import test from 'tape'
import {
  CursorTracker,
  DONE_LIMIT,
  compareTs,
  openCursorStore,
  readCursorFile,
  tsForTime,
  type CursorFile,
} from './cursor'

const silent = () => {}

function tracker(initial?: CursorFile): { t: CursorTracker; writes: CursorFile[] } {
  const writes: CursorFile[] = []
  const t = new CursorTracker(
    { persist: state => writes.push(state), now: () => 0, log: silent },
    initial
  )
  return { t, writes }
}

// Slack ts values are `<seconds>.<microseconds>`. Comparing them as numbers loses the last
// digits at current epoch values, so two messages in the same second would compare equal —
// and equal, here, means "already processed", i.e. a review silently dropped.
test('compareTs distinguishes messages inside the same second', t => {
  t.equal(compareTs('1723489200.000100', '1723489200.000200'), -1, 'microseconds decide')
  t.equal(compareTs('1723489200.000200', '1723489200.000100'), 1)
  t.equal(compareTs('1723489200.000100', '1723489200.000100'), 0)
  t.equal(compareTs('1723489199.999999', '1723489200.000000'), -1, 'seconds decide first')
  t.equal(compareTs('1723489200.10', '1723489200.020000'), 1, 'a short fraction is not a small one')
  t.end()
})

// The ordinary case: chatter arriving in order should leave the cursor on the newest message
// and nothing pending, or every restart would re-read the same history.
test('CursorTracker advances the watermark through in-order messages', t => {
  const { t: c, writes } = tracker()
  c.start('C1', '100.000000')
  c.record('C1', '101.000000')
  c.record('C1', '102.000000')
  t.equal(c.watermark('C1'), '102.000000')
  t.deepEqual(c.settled('C1'), [], 'nothing left above the watermark')
  t.ok(writes.length >= 3, 'each advance is persisted')
  t.end()
})

// The whole reason the cursor tracks finished rather than received work: a review killed by a
// restart has to come back. If `begin` moved the watermark, the message would be left with an
// :eyes: reaction and no verdict, forever.
test('CursorTracker holds the watermark below an unfinished message', t => {
  const { t: c, writes } = tracker()
  c.start('C1', '100.000000')
  const before = writes.length
  c.begin('C1', '101.000000')
  t.equal(c.watermark('C1'), '100.000000', 'a started review does not move the cursor')
  t.equal(writes.length, before, 'and does not write — pending state must not survive a crash')

  // Newer chatter finishing first must not carry the cursor over the running review.
  c.record('C1', '102.000000')
  t.equal(c.watermark('C1'), '100.000000', 'still held')
  t.deepEqual(c.settled('C1'), ['102.000000'], 'kept as done-above-watermark instead')
  t.equal(c.isProcessed('C1', '102.000000'), true, 'so replay will not dispatch it twice')
  t.equal(c.isProcessed('C1', '101.000000'), false, 'the unfinished review is still replayable')

  c.settle('C1', '101.000000')
  t.equal(c.watermark('C1'), '102.000000', 'finishing it collapses the whole window')
  t.deepEqual(c.settled('C1'), [])
  t.end()
})

// With CONCURRENCY > 1 reviews finish out of order. A cursor that only tracked a single
// timestamp would either re-review the one that finished early or skip the one still running.
test('CursorTracker survives out-of-order completion', t => {
  const { t: c } = tracker()
  c.start('C1', '100.000000')
  c.begin('C1', '101.000000')
  c.begin('C1', '102.000000')
  c.settle('C1', '102.000000')
  t.equal(c.watermark('C1'), '100.000000')
  t.deepEqual(c.settled('C1'), ['102.000000'])
  c.settle('C1', '101.000000')
  t.equal(c.watermark('C1'), '102.000000')
  t.end()
})

// A restart must not throw away the position it just loaded: starting an already-known
// channel at "now" would skip everything that happened while the daemon was down, which is
// exactly the bug the cursor exists to prevent.
test('CursorTracker.start never moves an existing cursor forward', t => {
  const { t: c } = tracker({
    version: 1,
    channels: { C1: { ts: '100.000000', done: [], updatedAt: '' } },
  })
  t.equal(c.start('C1', '999.000000'), '100.000000', 'the stored position wins')
  t.equal(c.watermark('C1'), '100.000000')
  t.equal(c.start('C2', '999.000000'), '999.000000', 'an unknown channel starts where told')
  t.deepEqual(c.list().sort(), ['C1', 'C2'])
  t.end()
})

// Replay hands back a ts that is already below the watermark whenever live delivery and the
// replayed history overlap. That must be a no-op rather than a backwards jump.
test('CursorTracker ignores messages at or below the watermark', t => {
  const { t: c } = tracker()
  c.start('C1', '100.000000')
  c.record('C1', '099.000000')
  c.begin('C1', '099.500000')
  t.equal(c.watermark('C1'), '100.000000', 'the cursor only ever moves forward')
  t.deepEqual(c.settled('C1'), [])
  t.end()
})

// A message begun and never settled is a bug, but one whose symptom would be a cursor pinned
// forever and a backlog that grows on every restart. The cap trades correctness for progress
// and says so in the log.
test('CursorTracker force-advances rather than growing done without bound', t => {
  const logged: string[] = []
  const c = new CursorTracker({ persist: () => {}, now: () => 0, log: e => logged.push(e) })
  c.start('C1', '100.000000')
  c.begin('C1', '101.000000')
  for (let i = 0; i <= DONE_LIMIT; i += 1) {
    c.record('C1', `${200 + i}.000000`)
  }
  t.equal(c.watermark('C1'), `${200 + DONE_LIMIT}.000000`, 'skipped ahead to the newest')
  t.deepEqual(c.settled('C1'), [], 'and the backlog is dropped')
  t.ok(logged.includes('cursor.forced'), 'never silently')
  t.end()
})

// A cursor file that cannot be read has to mean "start from now", not "replay everything" and
// not "crash on boot": the daemon's job is reviewing PRs, and a lost position costs one
// catch-up, while a crash loop costs all of them.
test('readCursorFile tolerates every broken file', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-test-'))
  const missing = path.join(dir, 'nope.json')
  t.deepEqual(readCursorFile(missing, silent).channels, {}, 'absent')

  const truncated = path.join(dir, 'truncated.json')
  fs.writeFileSync(truncated, '{"version":1,"channels":{"C1":')
  t.deepEqual(readCursorFile(truncated, silent).channels, {}, 'half-written')

  const future = path.join(dir, 'future.json')
  fs.writeFileSync(future, JSON.stringify({ version: 99, channels: { C1: { ts: '1.0' } } }))
  t.deepEqual(readCursorFile(future, silent).channels, {}, 'a version this build does not know')

  const partly = path.join(dir, 'partly.json')
  fs.writeFileSync(
    partly,
    JSON.stringify({
      version: 1,
      channels: {
        C1: { ts: '100.000000', done: ['101.000000'], updatedAt: 'x' },
        C2: { ts: 'not-a-ts' },
        C3: { done: [] },
      },
    })
  )
  const parsed = readCursorFile(partly, silent)
  t.deepEqual(Object.keys(parsed.channels), ['C1'], 'entries without a usable ts are dropped')
  t.deepEqual(parsed.channels.C1.done, ['101.000000'])
  fs.rmSync(dir, { recursive: true, force: true })
  t.end()
})

// The round trip is the feature: what one process settled has to be what the next process
// reads back, through a directory that may not exist yet.
test('openCursorStore round-trips a position through a new directory', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-test-'))
  const file = path.join(dir, 'nested', 'cursors.json')

  const first = openCursorStore(file, silent, () => 0)
  first.start('C1', '100.000000')
  first.begin('C1', '101.000000')
  first.record('C1', '102.000000')

  const second = openCursorStore(file, silent, () => 0)
  t.equal(second.watermark('C1'), '100.000000', 'the interrupted review is still unprocessed')
  t.deepEqual(second.settled('C1'), ['102.000000'], 'the one that finished is not replayed')
  t.equal(second.isProcessed('C1', '101.000000'), false, 'so the killed review runs again')
  t.notOk(fs.existsSync(`${file}.tmp`), 'no temp file left behind')
  fs.rmSync(dir, { recursive: true, force: true })
  t.end()
})

// tsForTime feeds `conversations.history`, which wants seconds with a fraction. An integer
// millisecond value here would ask Slack for messages since the year 56000.
test('tsForTime renders milliseconds as a Slack timestamp', t => {
  t.equal(tsForTime(1723489200123), '1723489200.123000')
  t.ok(compareTs(tsForTime(Date.now()), '1723489200.000000') > 0, 'now is after a 2024 message')
  t.end()
})

// A catch-up must not re-dispatch a review that is currently running, and `pending` is the
// only record that one is — the watermark deliberately sits below it, so history reads keep
// finding it. Kept in memory on purpose: after a restart nothing is in flight, and the message
// SHOULD be replayed, because its review died with the process.
test('inFlight reports begun-but-unfinished messages', t => {
  const tracker = new CursorTracker({ persist: () => {}, now: () => 0, log: () => {} })
  tracker.start('C1', '10.000000')
  t.deepEqual(tracker.inFlight('C1'), [], 'nothing running yet')

  tracker.begin('C1', '20.000000')
  t.deepEqual(tracker.inFlight('C1'), ['20.000000'], 'a queued review is visible')
  t.deepEqual(tracker.settled('C1'), [], 'and is not confused with a finished one')

  tracker.settle('C1', '20.000000')
  t.deepEqual(tracker.inFlight('C1'), [], 'cleared once it finishes')
  t.deepEqual(tracker.inFlight('C-never-seen'), [], 'an unknown channel is empty, not undefined')
  t.end()
})
