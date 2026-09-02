import test from 'tape'
import { cleanLine, createActiveReviews } from './progress'

/** A hand-cranked clock so wall-time and "N ago" figures are exact, not timing-dependent. */
function clock(start = 1_000_000) {
  let now = start
  return { now: () => now, advance: (ms: number) => { now += ms } }
}

const M = 60_000

// A request waits for a slot before it runs; the status must be able to name it in either
// state and move it cleanly from one to the other.
test('a review is waiting until it starts, then active', t => {
  const c = clock()
  const reviews = createActiveReviews(c.now)
  reviews.enqueue('k1', ['orders-service#12', 'lib#3'])

  let snap = reviews.snapshot(c.now())
  t.equal(snap.waiting.length, 1, 'enqueued means waiting')
  t.deepEqual(snap.waiting[0].labels, ['orders-service#12', 'lib#3'])
  t.equal(snap.active.length, 0)

  reviews.start('k1', 4)
  snap = reviews.snapshot(c.now())
  t.equal(snap.waiting.length, 0, 'no longer waiting once started')
  t.equal(snap.active.length, 1)
  t.equal(snap.active[0].attempt, 1, 'first attempt')
  t.equal(snap.active[0].attempts, 4, 'of the scheduled four')
  t.end()
})

// The three numbers the status shows: wall time since start, active time from the run, and how
// long since the last output — each computed against the snapshot's clock.
test('wall time, active time, and time-since-output are reported', t => {
  const c = clock()
  const reviews = createActiveReviews(c.now)
  reviews.enqueue('k', ['repo#1'])
  reviews.start('k', 1)

  c.advance(6 * M) // six minutes of wall clock
  reviews.output('k', 'running jest in libs/orders\n', 4 * M) // of which four were active

  let snap = reviews.snapshot(c.now())
  t.equal(snap.active[0].wallMs, 6 * M, 'wall time since start')
  t.equal(snap.active[0].activeMs, 4 * M, 'active time from the run')
  t.equal(snap.active[0].lastLine, 'running jest in libs/orders', 'the last output line')
  t.equal(snap.active[0].sinceOutputMs, 0, 'output just arrived')

  c.advance(12_000)
  snap = reviews.snapshot(c.now())
  t.equal(snap.active[0].sinceOutputMs, 12_000, 'twelve seconds later, silence is measured')
  t.equal(snap.active[0].wallMs, 6 * M + 12_000, 'and the wall clock keeps running')
  t.end()
})

// A retry is a fresh run: its attempt number advances, and the wedged attempt's active time and
// last line must not carry over and mislead a reader. The wall clock, though, is the whole
// review's, so it keeps counting from the original start.
test('a retry advances the attempt and clears the previous attempt progress', t => {
  const c = clock()
  const reviews = createActiveReviews(c.now)
  reviews.enqueue('k', ['repo#1'])
  reviews.start('k', 4)
  reviews.output('k', 'first attempt output', 30_000)
  c.advance(2 * M)

  reviews.attempt('k', 2)
  const snap = reviews.snapshot(c.now())
  t.equal(snap.active[0].attempt, 2, 'now on the second attempt')
  t.equal(snap.active[0].activeMs, 0, 'active time reset for the fresh run')
  t.equal(snap.active[0].lastLine, undefined, "the wedged attempt's line is cleared")
  t.equal(snap.active[0].sinceOutputMs, undefined, 'and there is no output yet this attempt')
  t.equal(snap.active[0].wallMs, 2 * M, 'the wall clock still counts from the original start')
  t.end()
})

// done is called from the same settle path as the cursor, so a finished or crashed review
// always leaves the live view.
test('done removes a review from the live view', t => {
  const reviews = createActiveReviews()
  reviews.enqueue('k', ['repo#1'])
  reviews.start('k', 1)
  reviews.done('k')
  const snap = reviews.snapshot(Date.now())
  t.equal(snap.active.length, 0)
  t.equal(snap.waiting.length, 0)
  t.end()
})

// Late or stray updates for a review that has already been forgotten must not resurrect it or
// throw — the registry is fed from an async child process whose events can arrive after done.
test('updates for an unknown key are ignored', t => {
  const reviews = createActiveReviews()
  reviews.output('ghost', 'x', 1)
  reviews.attempt('ghost', 2)
  reviews.start('ghost', 1)
  t.equal(reviews.snapshot(Date.now()).active.length, 0, 'nothing was created')
  t.end()
})

// A blank output chunk is still progress for the stall clock, but there is nothing to show, so
// the previously visible line must survive rather than being blanked.
test('a whitespace-only chunk keeps the last visible line', t => {
  const reviews = createActiveReviews()
  reviews.enqueue('k', ['repo#1'])
  reviews.start('k', 1)
  reviews.output('k', 'a real line', 1000)
  reviews.output('k', '   \n\n', 2000)
  const snap = reviews.snapshot(Date.now())
  t.equal(snap.active[0].lastLine, 'a real line', 'the last legible line is retained')
  t.equal(snap.active[0].activeMs, 2000, 'but the active time still advances')
  t.end()
})

// cleanLine is what keeps raw Codex output from breaking or flooding the Slack line.
test('cleanLine takes the last non-empty line and sanitises it', t => {
  t.equal(cleanLine('a\n\nb  c\n'), 'b c', 'last non-empty line, whitespace collapsed')
  t.equal(cleanLine('\x1b[32mgreen\x1b[0m text'), 'green text', 'ANSI colour codes stripped')
  t.equal(cleanLine('has `backtick`'), "has 'backtick'", 'backticks that would break the code span')
  const long = cleanLine('x'.repeat(200))
  t.ok(long.length <= 140, 'truncated to the cap')
  t.ok(long.endsWith('…'), 'with an ellipsis to show it was cut')
  t.equal(cleanLine('   \n  \t '), '', 'nothing legible yields an empty string')
  t.end()
})
