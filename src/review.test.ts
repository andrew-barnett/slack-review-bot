import test from 'tape'
import { CodexStalledError, type CodexRunOutcome, type runCodexReview } from './codex'
import { loadReviewConfig, type ReviewConfig } from './config'
import type { ReviewRequest } from './job'
import { makeReviewRunner } from './review'
import { ReviewFailedError } from './usage'

const request: ReviewRequest = {
  message: { channel: 'C1', ts: '1.1' },
  prs: [{ owner: 'o', repo: 'r', number: 1, url: 'https://github.com/o/r/pull/1' }],
  instructions: '',
}

/** A well-formed run outcome covering the requested PR, so reconciliation is a no-op. */
function passed(): CodexRunOutcome {
  return {
    result: {
      results: [
        { url: 'https://github.com/o/r/pull/1', status: 'passed', summary: '', pushedTestCommits: false, reviewUrl: '' },
      ],
    },
    rawFinalMessage: '{}',
    tokensUsed: 12345,
    activeMs: 90_000,
  }
}

function stall(stallMs: number | undefined): CodexStalledError {
  // A non-zero active time so tests can assert it survives onto the failure usage.
  return new CodexStalledError('stalled', stallMs ?? 0, { activeMs: 5000, wallMs: 5000, frozenMs: 0 })
}

/** Defaults with a controlled stall schedule; the graces here are the shape, not real minutes. */
function config(stallBackoffMs: number[]): ReviewConfig {
  return { ...loadReviewConfig({}), stallBackoffMs }
}

// The behaviour the operator asked for: a stalled attempt is retried with the *next, longer*
// grace, each retry is a fresh run, and the first one that produces a result wins.
test('makeReviewRunner retries a stall with the next longer grace and returns on success', async t => {
  const graces: (number | undefined)[] = []
  const runIds: string[] = []
  let calls = 0
  const fakeRun: typeof runCodexReview = async opts => {
    graces.push(opts.stallTimeoutMs)
    runIds.push(opts.runId)
    calls += 1
    if (calls < 3) throw stall(opts.stallTimeoutMs)
    return passed()
  }
  const events: string[] = []
  const runner = makeReviewRunner(config([1000, 2000, 3000, 4000]), e => events.push(e), fakeRun)

  const outcome = await runner(request)
  t.equal(outcome.result.results[0].status, 'passed', 'the succeeding attempt is returned')
  t.deepEqual(graces, [1000, 2000, 3000], 'each attempt waited longer for output than the last')
  t.deepEqual(runIds, ['C1-11', 'C1-11.retry1', 'C1-11.retry2'], 'each retry logs to its own runId')
  t.equal(events.filter(e => e === 'review.retry').length, 2, 'the two retries were logged')
  // Usage rides along with the winning attempt: Codex's token total, its active time, and the
  // attempt number it succeeded on (3, after two retries) — so a retried review reports honestly.
  t.equal(outcome.usage.tokensUsed, 12345, 'the token total from the successful run is carried')
  t.equal(outcome.usage.activeMs, 90_000, 'the active time from the successful run is carried')
  t.equal(outcome.usage.attempts, 3, 'the attempt count reflects the two retries before success')
  t.end()
})

// After the last grace also stalls, the run is killed for good and the failure is surfaced —
// the operator's "then kill it permanently" — rather than retried forever.
test('makeReviewRunner gives up and throws once the final grace also stalls', async t => {
  let calls = 0
  const fakeRun: typeof runCodexReview = async opts => {
    calls += 1
    throw stall(opts.stallTimeoutMs)
  }
  const events: string[] = []
  const runner = makeReviewRunner(config([1000, 2000]), e => events.push(e), fakeRun)

  try {
    await runner(request)
    t.fail('a run that stalls on every attempt must reject')
  } catch (error) {
    t.ok(String(error).includes('stalled on every attempt (2)'), String(error))
    // The permanent failure still carries what the run cost, so the status totals and the error
    // thread can account for a run that burned time without producing a verdict.
    t.ok(error instanceof ReviewFailedError, 'a give-up throws a ReviewFailedError carrying usage')
    if (error instanceof ReviewFailedError) {
      t.equal(error.usage.attempts, 2, 'usage records both attempts were spent')
      t.equal(error.usage.activeMs, 5000, "the last stall's active time is carried onto the failure")
      t.equal(error.usage.tokensUsed, undefined, 'a killed run reported no token total')
    }
  }
  t.equal(calls, 2, 'exactly the scheduled number of attempts were made')
  t.equal(events.filter(e => e === 'review.retry').length, 1, 'one retry between the two attempts')
  t.equal(events.filter(e => e === 'review.gave-up').length, 1, 'giving up was logged once')
  t.end()
})

// Only a stall is retryable. A crash or bad output will not fix itself on a re-run, so it is
// surfaced immediately without burning the rest of the schedule.
test('makeReviewRunner does not retry a non-stall failure', async t => {
  let calls = 0
  const fakeRun: typeof runCodexReview = async () => {
    calls += 1
    throw new Error('codex crashed')
  }
  const runner = makeReviewRunner(config([1000, 2000, 3000]), () => {}, fakeRun)

  try {
    await runner(request)
    t.fail('a crash must reject')
  } catch (error) {
    t.ok(String(error).includes('codex crashed'), String(error))
    // A crash is wrapped too, so the failure path always has a usage to report — here just the
    // single attempt, since a crash produces no token total or active-time snapshot.
    t.ok(error instanceof ReviewFailedError, 'a crash is wrapped in a ReviewFailedError')
    if (error instanceof ReviewFailedError) {
      t.equal(error.usage.attempts, 1, 'usage records the single attempt')
      t.equal(error.usage.tokensUsed, undefined, 'a crash reported no token total')
    }
  }
  t.equal(calls, 1, 'a non-stall failure is terminal — no retry')
  t.end()
})

// An empty schedule turns stall handling off entirely: one plain run, no output grace, no
// retries — the pre-stall behaviour, available to anyone who sets STALL_BACKOFF_MS empty.
test('makeReviewRunner runs once with no grace when the schedule is empty', async t => {
  const graces: (number | undefined)[] = []
  let calls = 0
  const fakeRun: typeof runCodexReview = async opts => {
    graces.push(opts.stallTimeoutMs)
    calls += 1
    return passed()
  }
  const runner = makeReviewRunner(config([]), () => {}, fakeRun)

  await runner(request)
  t.equal(calls, 1, 'exactly one attempt')
  t.deepEqual(graces, [undefined], 'no grace is passed, so the run does no stall detection')
  t.end()
})

// The runner feeds the live-status registry: it reports the attempt number for each try and
// forwards Codex output as progress, keyed by the same channel/ts the dispatcher uses.
test('makeReviewRunner reports attempt and output to the live-status registry', async t => {
  const attempts: Array<[string, number]> = []
  const outputs: Array<[string, string, number]> = []
  const reviews: import('./progress').ActiveReviews = {
    enqueue() {},
    start() {},
    done() {},
    attempt(key, n) { attempts.push([key, n]) },
    output(key, line, activeMs) { outputs.push([key, line, activeMs]) },
    snapshot() { return { active: [], waiting: [] } },
  }

  let calls = 0
  const fakeRun: typeof runCodexReview = async opts => {
    calls += 1
    opts.onProgress?.(`output from attempt ${calls}`, calls * 1000)
    if (calls < 2) throw stall(opts.stallTimeoutMs)
    return passed()
  }
  const runner = makeReviewRunner(config([1000, 2000]), () => {}, fakeRun, reviews)

  await runner(request)
  t.deepEqual(attempts, [['C1/1.1', 1], ['C1/1.1', 2]], 'attempt 1, then attempt 2 on the retry')
  t.deepEqual(
    outputs,
    [['C1/1.1', 'output from attempt 1', 1000], ['C1/1.1', 'output from attempt 2', 2000]],
    'output forwarded from both attempts, keyed by channel/ts'
  )
  t.end()
})
