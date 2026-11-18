import test from 'tape'
import { parseReviewResult, parseReviewResultV2, reconcileResults, reconcileResultsV2, REVIEW_OUTPUT_SCHEMA, REVIEW_OUTPUT_SCHEMA_V2 } from './schema'
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

// #14: every field is `required` in the output schema, so a payload missing one did not match
// the contract (a truncated/malformed result). The parser must reject it, not default it —
// coercing a missing `pushedTestCommits` to false could claim no test commits when the real
// result was lost. An empty string for summary/reviewUrl is fine; a missing key is not.
test('parseReviewResult enforces the required fields instead of defaulting them', t => {
  const base = '{"results":[{"url":"u","status":"passed"'
  t.throws(() => parseReviewResult(`${base}}]}`), /summary is missing/, 'no summary')
  t.throws(() => parseReviewResult(`${base},"summary":""}]}`), /pushedTestCommits is missing/, 'no pushedTestCommits')
  t.throws(
    () => parseReviewResult(`${base},"summary":"","pushedTestCommits":false}]}`),
    /reviewUrl is missing/,
    'no reviewUrl'
  )
  t.throws(
    () => parseReviewResult(`${base},"summary":"","pushedTestCommits":"no","reviewUrl":""}]}`),
    /pushedTestCommits is missing or not a boolean/,
    'wrong type is rejected too'
  )
  // A complete entry with empty summary/reviewUrl is valid — the schema permits those.
  const ok = parseReviewResult(`${base},"summary":"","pushedTestCommits":false,"reviewUrl":""}]}`)
  t.equal(ok.results[0].pushedTestCommits, false, 'a complete entry still parses')
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

const SHA = 'a'.repeat(40)
function v2(entry: Record<string, unknown>): string {
  return JSON.stringify({
    results: [{ url: 'https://github.com/o/r/pull/1', reviewedSha: SHA, verdict: 'clean', findings: [], summary: '', environmentProblems: [], ...entry }],
  })
}

// The happy path for schema v2: a clean verdict with a non-blocking finding is allowed (spec 5.6).
test('parseReviewResultV2 reads a clean result with a non-blocking finding', t => {
  const r = parseReviewResultV2(v2({ findings: [{ severity: 'non-blocking', file: 'src/a.ts', line: 3, body: 'nit' }] }))
  t.equal(r.results[0].verdict, 'clean')
  t.equal(r.results[0].findings[0].severity, 'non-blocking')
  t.equal(r.results[0].reviewedSha, SHA)
  t.end()
})

// The gate's core invariant: clean means zero blocking findings. A result that says both must be a
// parse error, so it becomes an invalid pass rather than an approval (spec 5.6; issue 59 acceptance).
test('parseReviewResultV2 rejects clean with a blocking finding', t => {
  t.throws(
    () => parseReviewResultV2(v2({ findings: [{ severity: 'blocking', file: '', line: 0, body: 'bug' }] })),
    /verdict clean with a blocking finding/
  )
  t.end()
})

// reviewedSha is compared with the pinned SHA, so a short or malformed SHA must fail here rather
// than fail the comparison silently later. A blocked PR may report none.
test('parseReviewResultV2 enforces the reviewedSha format, except an empty one on blocked', t => {
  t.throws(() => parseReviewResultV2(v2({ reviewedSha: 'abc123' })), /40-character hex SHA/)
  t.throws(() => parseReviewResultV2(v2({ reviewedSha: '' })), /40-character hex SHA/, 'clean needs a SHA')
  t.equal(parseReviewResultV2(v2({ verdict: 'blocked', reviewedSha: '', summary: 'head moved' })).results[0].reviewedSha, '')
  t.equal(parseReviewResultV2(v2({ reviewedSha: 'A'.repeat(40) })).results[0].reviewedSha, SHA, 'normalised to lower case')
  t.end()
})

// Every field is required. A missing environmentProblems must not default to [] — that would turn
// an engine that lost its environment report into a valid pass.
test('parseReviewResultV2 rejects missing or mistyped fields', t => {
  t.throws(() => parseReviewResultV2(v2({ environmentProblems: undefined })), /environmentProblems/)
  t.throws(() => parseReviewResultV2(v2({ findings: [{ severity: 'major', file: '', line: 0, body: 'x' }] })), /severity/)
  t.throws(() => parseReviewResultV2(v2({ findings: [{ severity: 'blocking', file: '', line: -1, body: 'x' }] })), /line/)
  t.throws(() => parseReviewResultV2(v2({ verdict: 'passed' })), /verdict/)
  t.throws(() => parseReviewResultV2('not json'), /not valid JSON/)
  t.end()
})

// A PR the engine never reported must be an invalid pass, not dropped and not clean. Regression
// caught: one engine silently skipping a PR while the other's clean result approves it.
test('reconcileResultsV2 turns an unreported PR into an environment problem', t => {
  const r = reconcileResultsV2(
    ['https://github.com/o/r/pull/1', 'https://github.com/o/r/pull/2'],
    parseReviewResultV2(v2({ url: 'https://github.com/O/R/pull/1' }))
  )
  t.equal(r.results.length, 2)
  t.equal(r.results[0].url, 'https://github.com/o/r/pull/1', 'requested spelling restored')
  t.deepEqual(r.results[1].environmentProblems, ['the engine reported no result for this pull request'])
  t.end()
})

// Both engines are handed this schema; a strict-mode violation would fail every dual run.
test('REVIEW_OUTPUT_SCHEMA_V2 is strict-mode clean at every level', t => {
  const check = (node: { additionalProperties?: unknown; required?: readonly string[]; properties?: Record<string, unknown> }, where: string) => {
    t.equal(node.additionalProperties, false, `${where} forbids extra properties`)
    t.deepEqual([...(node.required ?? [])].sort(), Object.keys(node.properties ?? {}).sort(), `${where} requires every property`)
  }
  const item = REVIEW_OUTPUT_SCHEMA_V2.properties.results.items
  check(REVIEW_OUTPUT_SCHEMA_V2, 'root')
  check(item, 'result')
  check(item.properties.findings.items, 'finding')
  t.end()
})
