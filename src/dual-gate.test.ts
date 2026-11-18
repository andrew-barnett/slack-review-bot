import test from 'tape'
import { AGENT_NO_MENTION_NOTE } from './agent-note'
import { composeReview, decide, passFor, skippedPass, type EnginePass, type PassState } from './dual-gate'
import type { EngineRunOutcome } from './engine'
import type { Eligibility } from './preflight'
import type { EnginePrResult } from './schema'

const SHA = 'f'.repeat(40)
const URL1 = 'https://github.com/o/r/pull/1'
const counts: Eligibility = { verdict: 'counts', reasons: [], missing: [], lastPushApproval: false, dismissStale: false }
const partial: Eligibility = { ...counts, verdict: 'partial', reasons: ['the bot approval satisfies some but not all requirements'], missing: ['1 more approval'] }
const wontCount: Eligibility = { ...counts, verdict: 'wontCount', reasons: ['could not verify: classic protection'] }

function result(over: Partial<EnginePrResult> = {}): EnginePrResult {
  return { url: URL1, reviewedSha: SHA, verdict: 'clean', findings: [], summary: '', environmentProblems: [], ...over }
}
function outcome(over: Partial<EngineRunOutcome> = {}, r: EnginePrResult | null = result()): EngineRunOutcome {
  return { engine: 'claude', results: r ? [r] : [], usage: { attempts: 1 }, ...over }
}
const pass = (engine: EnginePass['engine'], state: PassState): EnginePass => ({ engine, state, detail: state })

// Spec 5.8, first table: every engine outcome maps to exactly one pass state. Regression caught
// by each row: an engine failure, environment problem or wrong SHA ever reading as clean.
test('passFor implements every row of the pass-state table', t => {
  const rows: [string, EngineRunOutcome, PassState, RegExp][] = [
    ['process error', outcome({ error: 'Claude run exceeded the 180 minute timeout' }, null), 'invalid', /^error: Claude run exceeded/],
    ['no result', outcome({}, null), 'invalid', /no result/],
    ['environment problem', outcome({}, result({ environmentProblems: ['npm ci failed: E401'] })), 'invalid', /npm ci failed/],
    ['wrong SHA', outcome({}, result({ reviewedSha: 'e'.repeat(40) })), 'invalid', /reviewed eeeeeee instead of fffffff/],
    ['blocked', outcome({}, result({ verdict: 'blocked', reviewedSha: '', summary: 'stale base' })), 'blocked', /blocked: stale base/],
    ['findings', outcome({}, result({ verdict: 'findings', findings: [{ severity: 'blocking', file: 'a.ts', line: 1, body: 'x' }, { severity: 'non-blocking', file: '', line: 0, body: 'y' }] })), 'findings', /^1 blocking, 1 non-blocking$/],
    ['clean', outcome(), 'clean', /^clean$/],
  ]
  for (const [name, o, state, detail] of rows) {
    const p = passFor(o, URL1, SHA)
    t.equal(p.state, state, name)
    t.match(p.detail, detail, `${name} detail`)
  }
  t.equal(passFor(outcome({}, result({ reviewedSha: SHA.toUpperCase() })), URL1, SHA).state, 'clean', 'SHA compare ignores case')
  t.equal(skippedPass('claude', 'codex').detail, 'skipped (Codex not clean)')
  t.end()
})

// Spec 5.8, second table: every row, plus the rule that a skipped engine is never clean.
// Regression caught by each row: an APPROVE without both engines clean, a REQUEST_CHANGES, or a
// "one engine clean" comment that reads as half an approval.
test('decide implements every row of the decision table', t => {
  const rows: [string, EnginePass[], Eligibility, ReturnType<typeof decide>][] = [
    ['all clean, counts', [pass('codex', 'clean'), pass('claude', 'clean')], counts, { event: 'APPROVE', outcome: 'approved' }],
    ['all clean, partial', [pass('codex', 'clean'), pass('claude', 'clean')], partial, { event: 'APPROVE', outcome: 'approvedPartial' }],
    ['all clean, wontCount', [pass('codex', 'clean'), pass('claude', 'clean')], wontCount, { event: 'COMMENT', outcome: 'cleanNotCounted' }],
    ['findings, none invalid', [pass('codex', 'findings'), pass('claude', 'clean')], counts, { event: 'COMMENT', outcome: 'findings' }],
    ['findings and invalid', [pass('codex', 'findings'), pass('claude', 'invalid')], counts, { event: 'COMMENT', outcome: 'findings' }],
    ['blocked, no findings', [pass('codex', 'blocked'), pass('claude', 'clean')], counts, { event: null, outcome: 'blocked' }],
    ['no findings, invalid', [pass('codex', 'clean'), pass('claude', 'invalid')], counts, { event: null, outcome: 'error' }],
    ['serial: findings then skipped', [pass('codex', 'findings'), pass('claude', 'skipped')], counts, { event: 'COMMENT', outcome: 'findings' }],
    ['serial: invalid then skipped', [pass('codex', 'invalid'), pass('claude', 'skipped')], counts, { event: null, outcome: 'error' }],
    ['skipped is never clean', [pass('codex', 'clean'), pass('claude', 'skipped')], counts, { event: null, outcome: 'error' }],
    ['no passes', [], counts, { event: null, outcome: 'error' }],
  ]
  for (const [name, passes, eligibility, expected] of rows) t.deepEqual(decide(passes, eligibility), expected, name)
  t.end()
})

// The combined review: findings on a commentable line go inline, tagged by engine and severity;
// others go in the body under the engine's heading. Every comment and the body carry the hidden
// no-mention note. Regression caught: a finding on a line outside the diff making GitHub reject
// the whole review with 422.
test('composeReview anchors only commentable findings and tags each by engine', t => {
  const codex: EnginePass = {
    engine: 'codex', state: 'findings', detail: '1 blocking',
    result: result({ verdict: 'findings', findings: [{ severity: 'blocking', file: 'src/a.ts', line: 3, body: 'null deref' }] }),
  }
  const claude: EnginePass = {
    engine: 'claude', state: 'findings', detail: '1 blocking, 1 non-blocking',
    result: result({
      verdict: 'findings',
      findings: [
        { severity: 'blocking', file: 'src/a.ts', line: 99, body: 'off-diff line' },
        { severity: 'non-blocking', file: '', line: 0, body: 'PR-level note' },
      ],
    }),
  }
  const { body, comments } = composeReview({
    pinnedSha: SHA, passes: [codex, claude], eligibility: partial, outcome: 'findings',
    commentable: new Map([['src/a.ts', new Set([3])]]),
  })
  t.equal(comments.length, 1)
  t.deepEqual({ ...comments[0], body: comments[0].body.split('\n')[0] }, { path: 'src/a.ts', line: 3, side: 'RIGHT', body: '**[Codex · BLOCKING]** null deref' })
  t.ok(comments[0].body.endsWith(AGENT_NO_MENTION_NOTE), 'inline comment carries the note')
  t.ok(body.includes(`\`${SHA}\``), 'pinned SHA')
  t.ok(body.includes('Codex: 1 blocking · Claude: 1 blocking, 1 non-blocking'), 'one line per engine')
  t.ok(body.includes('Pre-flight: partial.') && body.includes('- 1 more approval'), 'pre-flight with missing')
  t.ok(body.includes('### Claude\n- **[Claude · BLOCKING]** `src/a.ts:99` off-diff line'), 'off-diff finding in the body')
  t.ok(body.includes('- **[Claude · NON-BLOCKING]** PR-level note'))
  t.ok(body.endsWith(AGENT_NO_MENTION_NOTE), 'body carries the note')
  t.end()
})

// Spec 5.8: "COMMENT with the valid engines' findings; body names the engine that failed".
// The failed engine contributes nothing, and the body says why there is no approval.
test('composeReview names an invalid engine and posts only valid engines findings', t => {
  const codex: EnginePass = { engine: 'codex', state: 'findings', detail: '1 blocking', result: result({ verdict: 'findings', findings: [{ severity: 'blocking', file: '', line: 0, body: 'bug' }] }) }
  const claude: EnginePass = { engine: 'claude', state: 'invalid', detail: 'invalid: npm ci failed', result: result({ findings: [{ severity: 'non-blocking', file: '', line: 0, body: 'from an invalid pass' }] }) }
  const { body } = composeReview({ pinnedSha: SHA, passes: [codex, claude], eligibility: counts, outcome: 'findings', commentable: new Map() })
  t.ok(body.includes('Claude did not complete a valid review (invalid: npm ci failed)'))
  t.notOk(body.includes('from an invalid pass'), "an invalid engine's findings are not posted")
  t.end()
})

// A clean-but-not-counted comment must say plainly that it is not an approval, with the reasons.
test('composeReview explains a clean result whose approval would not count', t => {
  const { body } = composeReview({
    pinnedSha: SHA, passes: [pass('codex', 'clean'), pass('claude', 'clean')], eligibility: wontCount, outcome: 'cleanNotCounted', commentable: new Map(),
  })
  t.ok(body.includes('so this is a comment, not an approval'))
  t.ok(body.includes("Pre-flight: won't count.") && body.includes('- could not verify: classic protection'))
  t.end()
})

// GitHub rejects a review body over 65,536 characters with 422, which would turn a valid review
// into an error. A huge finding (an engine pasting a whole test file) is truncated instead.
test('composeReview caps an oversized body', t => {
  const huge: EnginePass = { engine: 'codex', state: 'findings', detail: '1 blocking', result: result({ verdict: 'findings', findings: [{ severity: 'blocking', file: '', line: 0, body: 'x'.repeat(100_000) }] }) }
  const { body } = composeReview({ pinnedSha: SHA, passes: [huge, pass('claude', 'clean')], eligibility: counts, outcome: 'findings', commentable: new Map() })
  t.ok(body.length < 65_536)
  t.ok(body.includes('_(truncated)_'))
  t.end()
})
