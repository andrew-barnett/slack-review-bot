import test from 'tape'
import { createShutdownController } from './shutdown'

// A never-fired timer, so drain resolves only when the tracked jobs settle — the clean drain path.
const neverTimes = () => {}
// A timer that fires immediately, standing in for the deadline elapsing first — the forced path.
const firesNow = (fn: () => void) => fn()

// With nothing in flight, a shutdown drains instantly and does not force anything.
test('drain resolves drained immediately when no review is in flight', async t => {
  const s = createShutdownController()
  t.equal(await s.drain(15_000, firesNow), 'drained', 'no jobs means already idle')
  t.notOk(s.forced, 'nothing was force-killed')
  t.end()
})

// The primary contract: wait for the active review to settle, then drain cleanly. `forced` stays
// false, so the job keeps its normal settle-and-report path.
test('drain waits for a tracked review and resolves drained when it settles first', async t => {
  const s = createShutdownController()
  let finish: () => void = () => {}
  s.track(new Promise<void>(resolve => (finish = resolve)))
  t.equal(s.active(), 1, 'the review is tracked as in flight')
  const draining = s.drain(15_000, neverTimes) // deadline never fires; only settling ends the wait
  finish()
  t.equal(await draining, 'drained', 'the review settled before the deadline')
  t.notOk(s.forced, 'a drained review is not forced')
  t.end()
})

// The fallback contract: a review that has not settled by the deadline is forced. The `forced` flag
// is what tells the job path to suppress the error thread and leave the cursor unsettled (→ replay).
test('drain resolves forced and sets the flag when the deadline passes first', async t => {
  const s = createShutdownController()
  s.track(new Promise<void>(() => {})) // a review that never settles on its own
  t.equal(await s.drain(15_000, firesNow), 'forced', 'the deadline elapsed with the review still running')
  t.ok(s.forced, 'forced is set so the job replays cleanly instead of erroring')
  t.end()
})

// A settled review must stop counting as in flight, or a later drain would wait for a ghost.
test('a tracked review is untracked once it settles', async t => {
  const s = createShutdownController()
  let finish: () => void = () => {}
  s.track(new Promise<void>(resolve => (finish = resolve)))
  finish()
  await new Promise(r => setImmediate(r)) // let the untrack microtask run
  t.equal(s.active(), 0, 'the settled review is no longer in flight')
  t.end()
})

// request() gates new work and must be idempotent, so a second signal does not restart the sequence.
test('request is idempotent', t => {
  const s = createShutdownController()
  t.notOk(s.requested, 'not requested until asked')
  t.ok(s.request(), 'first request wins')
  t.ok(s.requested, 'and is recorded')
  t.notOk(s.request(), 'a second request is a no-op')
  t.end()
})
