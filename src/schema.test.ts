import test from 'tape'
import { parseReviewResult, reconcileResults, REVIEW_OUTPUT_SCHEMA } from './schema'
import type { PullRequestResult } from './schema'

function entry(url: string, status: PullRequestResult['status'] = 'passed'): PullRequestResult {
  return { url, status, summary: '', pushedTestCommits: false, reviewUrl: '' }
}

test('parseReviewResult reads a well-formed payload', t => {
  const result = parseReviewResult(
    JSON.stringify({
      results: [
        { url: 'https://github.com/o/r/pull/1', status: 'passed', summary: '', pushedTestCommits: false, reviewUrl: '' },
        { url: 'https://github.com/o/r/pull/2', status: 'findings', summary: 'Null deref in the retry path.', pushedTestCommits: true, reviewUrl: 'https://github.com/o/r/pull/2#r1' },
      ],
    })
  )
  t.equal(result.results.length, 2)
  t.equal(result.results[1].status, 'findings')
  t.equal(result.results[1].pushedTestCommits, true)
  t.end()
})

// Models emit fenced JSON even under structured output. Failing on the fence would
// turn a perfectly good review into a run error.
test('parseReviewResult tolerates a ```json fence around the payload', t => {
  const result = parseReviewResult(
    '```json\n{"results":[{"url":"u","status":"passed","summary":"","pushedTestCommits":false,"reviewUrl":""}]}\n```'
  )
  t.equal(result.results[0].url, 'u')
  t.end()
})

// The critical safety property: anything the bot cannot understand must raise, because
// the caller turns a thrown error into :warning: and a "not reviewed" thread. Silently
// coercing junk into an empty result array would render as :approved_stamp: — the bot
// claiming a clean review it never performed.
test('parseReviewResult throws rather than degrading to a pass', t => {
  t.throws(() => parseReviewResult(''), /empty final message/, 'empty output')
  t.throws(() => parseReviewResult('I reviewed the PR and it looks fine'), /not valid JSON/, 'prose')
  t.throws(() => parseReviewResult('{"ok":true}'), /no "results" array/, 'wrong shape')
  t.throws(
    () => parseReviewResult('{"results":[{"url":"u","status":"approved"}]}'),
    /not one of passed\/findings\/blocked/,
    'invented status'
  )
  t.throws(() => parseReviewResult('{"results":[{"status":"passed"}]}'), /url is missing/, 'no url')
  t.end()
})

// The dangerous case: Codex reviews two PRs, reports only one, and that one passed.
// Without reconciliation the run reads as all-passed and the message gets
// :approved_stamp: — claiming a clean review of a PR that was never looked at.
test('reconcileResults marks an unreported PR as blocked rather than dropping it', t => {
  const requested = ['https://github.com/o/r/pull/1', 'https://github.com/o/r/pull/2']
  const reconciled = reconcileResults(requested, { results: [entry(requested[0])] })
  t.equal(reconciled.results.length, 2)
  t.equal(reconciled.results[1].status, 'blocked')
  t.ok(reconciled.results[1].summary.includes('did not report'))
  t.end()
})

// An empty result set is the same failure in its most complete form.
test('reconcileResults blocks every PR when nothing came back', t => {
  const requested = ['https://github.com/o/r/pull/1']
  const reconciled = reconcileResults(requested, { results: [] })
  t.equal(reconciled.results.length, 1)
  t.equal(reconciled.results[0].status, 'blocked')
  t.end()
})

// The thread and the output contract both go by request order; a model that answers
// out of order should not reorder the thread.
test('reconcileResults restores the requested order and URL spelling', t => {
  const requested = ['https://github.com/o/a/pull/1', 'https://github.com/o/b/pull/2']
  const reconciled = reconcileResults(requested, {
    results: [entry('https://github.com/O/B/pull/2', 'findings'), entry(requested[0])],
  })
  t.deepEqual(reconciled.results.map(r => r.url), requested, 'order and casing come from the request')
  t.equal(reconciled.results[1].status, 'findings', 'the matched entry keeps its verdict')
  t.end()
})

// A result for a PR nobody asked about signals the run went off the rails. Discarding
// it would hide that; keeping it surfaces the mismatch in the thread.
test('reconcileResults keeps unexpected extra entries', t => {
  const reconciled = reconcileResults(['https://github.com/o/a/pull/1'], {
    results: [entry('https://github.com/o/a/pull/1'), entry('https://github.com/o/z/pull/9', 'findings')],
  })
  t.equal(reconciled.results.length, 2)
  t.equal(reconciled.results[1].url, 'https://github.com/o/z/pull/9')
  t.end()
})

// Structured-output enforcement rejects a schema whose objects omit additionalProperties
// or leave a property out of `required`; a rejected schema fails every run.
test('REVIEW_OUTPUT_SCHEMA is strict-mode clean', t => {
  const item = REVIEW_OUTPUT_SCHEMA.properties.results.items
  t.equal(REVIEW_OUTPUT_SCHEMA.additionalProperties, false)
  t.equal(item.additionalProperties, false)
  t.deepEqual(
    [...item.required].sort(),
    Object.keys(item.properties).sort(),
    'every property is required'
  )
  t.end()
})
