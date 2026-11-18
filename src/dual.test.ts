import test from 'tape'
import type { ApproverGitHub, PullRequestInfo, ReviewFact } from './approver-github'
import type { EngineName } from './config'
import type { Engine, EngineRunInput } from './engine'
import { combineUsage, makeDualReviewRunner, type DualDeps } from './dual'
import { GhApiError } from './gh-api'
import type { ReviewRequest } from './job'
import type { EnginePrResult } from './schema'

const OLD = 'a'.repeat(40)
const NEW = 'b'.repeat(40)
const URL1 = 'https://github.com/o/r/pull/1'
const request: ReviewRequest = {
  message: { channel: 'C1', ts: '1.1' },
  prs: [{ owner: 'o', repo: 'r', number: 1, url: URL1 }],
  instructions: '',
}
const info = (headSha: string): PullRequestInfo => ({
  author: 'dev', base: 'main', baseRepo: 'o/r', headRef: 'feat/x', headSha, headRepo: 'o/r', state: 'open', draft: false,
})

interface World {
  gh: ApproverGitHub
  posted: { event: string; commitId: string; body: string }[]
  updates: string[]
}

/**
 * A fake role account. `heads` is the sequence of head SHAs successive getPullRequest calls see
 * (the last one repeats). Everything else defaults to an unprotected branch, so the pre-flight
 * says `counts`; each test overrides what it exercises.
 */
function world(heads: string[] = [OLD], over: Partial<ApproverGitHub> = {}): World {
  const posted: World['posted'] = []
  const updates: string[] = []
  let call = 0
  const gh = {
    login: async () => 'role-bot',
    getPullRequest: async () => info(heads[Math.min(call++, heads.length - 1)]),
    permission: async () => 'write',
    branchRules: async () => [],
    classicProtection: async () => null,
    fileAt: async () => null,
    codeownersErrorCount: async () => null,
    isTeamMember: async () => false,
    reviews: async () => [],
    latestPush: async () => null,
    behindBy: async () => 0,
    postIssueComment: async () => {},
    commentableLines: async () => new Map([['src/a.ts', new Set([3])]]),
    updateBranch: async (_pr: unknown, sha: string) => {
      updates.push(sha)
      return { ok: true as const }
    },
    postReview: async (_pr: unknown, review: { event: string; commitId: string; body: string }) => {
      posted.push({ event: review.event, commitId: review.commitId, body: review.body })
      return { id: 1, url: 'https://github.com/o/r/pull/1#pullrequestreview-1' }
    },
    botReviews: async () => [],
    decision: async () => ({ reviewDecision: 'APPROVED', mergeStateStatus: 'CLEAN' }),
    ...over,
  } as ApproverGitHub
  return { gh, posted, updates }
}

/** A fake engine answering `verdict` for every PR at the SHA it was given. */
function engine(name: EngineName, verdict: EnginePrResult['verdict'] = 'clean', over: Partial<EnginePrResult> = {}) {
  const calls: EngineRunInput[] = []
  const e: Engine & { calls: EngineRunInput[] } = {
    name,
    calls,
    async run(input) {
      calls.push(input)
      const findings = verdict === 'findings' ? [{ severity: 'blocking' as const, file: 'src/a.ts', line: 3, body: 'bug' }] : []
      return {
        engine: name,
        results: input.prs.map(p => ({ url: p.ref.url, reviewedSha: p.pinnedSha, verdict, findings, summary: '', environmentProblems: [], ...over })),
        usage: { tokensUsed: 100, activeMs: 1000, attempts: 1 },
      }
    },
  }
  return e
}

function deps(w: World, engines: Engine[] = [engine('codex'), engine('claude')], over: Partial<DualDeps> = {}): DualDeps {
  let now = 0
  return {
    gh: w.gh,
    engines,
    schedule: 'parallel',
    worktreeRoot: '/wt',
    listChangedFiles: async () => ['src/a.ts'],
    runIdFor: () => 'C1-11',
    log: () => {},
    sleep: async ms => {
      now += ms
    },
    now: () => now,
    updateTimeoutMs: 10_000,
    pollMs: 2_000,
    ...over,
  }
}

const run = (d: DualDeps) => makeDualReviewRunner(d)(request)

// The R4 contract end to end: both engines clean at the pinned SHA, head unchanged, pre-flight
// counts → one APPROVE tied to that SHA (never to whatever the head is at posting time).
test('dual runner approves with commit_id when both engines are clean and the head is unchanged', async t => {
  const w = world()
  const codex = engine('codex')
  const out = await run(deps(w, [codex, engine('claude')]))
  t.equal(codex.calls[0].prs[0].pinnedSha, OLD, 'engines review the pinned SHA')
  t.deepEqual(w.posted.map(p => [p.event, p.commitId]), [['APPROVE', OLD]])
  const pr = out.dual!.prs[0]
  t.equal(pr.outcome, 'approved')
  t.equal(pr.reviewUrl, 'https://github.com/o/r/pull/1#pullrequestreview-1')
  t.deepEqual(pr.warnings, [])
  t.equal(out.result.results[0].status, 'passed', 'legacy summary for logs and the CLI')
  t.equal(out.usage.tokensUsed, 200, 'usage summed across engines')
  t.end()
})

// Findings post a COMMENT (never REQUEST_CHANGES); a blocked or invalid engine posts nothing.
test('dual runner posts a COMMENT for findings and nothing for blocked or invalid', async t => {
  const findings = world()
  t.equal((await run(deps(findings, [engine('codex', 'findings'), engine('claude')]))).dual!.prs[0].outcome, 'findings')
  t.deepEqual(findings.posted.map(p => p.event), ['COMMENT'])

  const blocked = world()
  t.equal((await run(deps(blocked, [engine('codex', 'blocked', { reviewedSha: '' }), engine('claude')]))).dual!.prs[0].outcome, 'blocked')
  t.deepEqual(blocked.posted, [])

  const invalid = world()
  const out = await run(deps(invalid, [engine('codex'), engine('claude', 'clean', { environmentProblems: ['npm ci failed'] })]))
  t.equal(out.dual!.prs[0].outcome, 'error')
  t.deepEqual(invalid.posted, [], 'one engine clean is never half an approval')
  t.end()
})

// R4: a head that moves during the review discards both results and posts nothing.
test('dual runner posts nothing when the head moved during the review', async t => {
  const w = world([OLD, NEW])
  const out = await run(deps(w))
  t.equal(out.dual!.prs[0].outcome, 'headMoved')
  t.match(out.dual!.prs[0].reason ?? '', /head moved during review \(aaaaaaa → bbbbbbb\)/)
  t.deepEqual(w.posted, [])
  t.end()
})

// Idempotency (narrow #35): a review by the bot at this SHA already exists, so a replayed
// request cannot double-approve.
test('dual runner skips posting when the bot already reviewed the pinned SHA', async t => {
  const w = world([OLD], { botReviews: async () => [{ login: 'role-bot', commitId: OLD.toUpperCase(), state: 'APPROVED' }] })
  const out = await run(deps(w))
  t.deepEqual(w.posted, [])
  t.equal(out.dual!.prs[0].alreadyReviewed, true)
  t.equal(out.dual!.prs[0].outcome, 'approved', 'the standing approval is real, so approved is honest')
  t.match(out.dual!.prs[0].reason ?? '', /already reviewed at aaaaaaa \(APPROVED\); that review stands/)
  t.end()
})

// The skip must report what is on GitHub, not what would have been posted. Regression caught: an
// earlier cleanNotCounted COMMENT at this SHA, then a permission change and a clean re-request,
// reported `approved` (approval reaction, CLI success) although no approval was ever posted.
test('dual runner never reports approved over a standing COMMENT at the pinned SHA', async t => {
  const w = world([OLD], { botReviews: async () => [{ login: 'role-bot', commitId: OLD, state: 'COMMENTED' }] })
  const out = await run(deps(w))
  const pr = out.dual!.prs[0]
  t.deepEqual(w.posted, [], 'nothing is posted')
  t.equal(pr.alreadyReviewed, true)
  t.equal(pr.outcome, 'cleanNotCounted', 'clean, but no approval exists at this SHA')
  t.match(pr.reason ?? '', /\(COMMENTED\); that review stands.*No approval exists at this SHA/)
  t.end()
})

// A dismissed approval no longer counts (GitHub's state is authoritative, spec 5.2), so it does not
// block a re-request: the bot approves again at the same SHA. Regression caught: a dismissed
// approval silently making the PR unapprovable until a new commit.
test('dual runner re-posts when its earlier review at the pinned SHA was dismissed', async t => {
  const w = world([OLD], { botReviews: async () => [{ login: 'role-bot', commitId: OLD, state: 'DISMISSED' }] })
  const out = await run(deps(w))
  t.deepEqual(w.posted.map(p => [p.event, p.commitId]), [['APPROVE', OLD]])
  t.equal(out.dual!.prs[0].outcome, 'approved')
  t.notOk(out.dual!.prs[0].alreadyReviewed)
  t.end()
})

// The other direction: findings now, but an earlier approval at this SHA stands. Nothing is
// posted (no double review) and Slack warns that the approval is still in effect.
test('dual runner warns when findings meet a standing approval at the pinned SHA', async t => {
  const w = world([OLD], { botReviews: async () => [{ login: 'role-bot', commitId: OLD, state: 'APPROVED' }] })
  const out = await run(deps(w, [engine('codex', 'findings'), engine('claude')]))
  const pr = out.dual!.prs[0]
  t.deepEqual(w.posted, [])
  t.equal(pr.outcome, 'findings')
  t.match(pr.warnings.join('\n'), /earlier approval by the bot at aaaaaaa still stands/)
  t.end()
})

// If the idempotency check itself fails, posting could double-approve, so nothing is posted.
test('dual runner posts nothing when it cannot check for an earlier review', async t => {
  const w = world([OLD], { botReviews: async () => { throw new Error('HTTP 502') } })
  const out = await run(deps(w))
  t.deepEqual(w.posted, [])
  t.equal(out.dual!.prs[0].outcome, 'error')
  t.end()
})

// Read-back: a prediction GitHub contradicts adds a warning naming both. reviewDecision null means
// no review is required, which agrees with `counts`. Regression caught: a false "prediction was
// wrong" warning on every unprotected repo.
test('dual runner warns when the read-back contradicts the prediction, and only then', async t => {
  const wrong = world([OLD], { decision: async () => ({ reviewDecision: 'REVIEW_REQUIRED', mergeStateStatus: 'BLOCKED' }) })
  t.deepEqual((await run(deps(wrong))).dual!.prs[0].warnings, [
    'pre-flight predicted the approval counts, but GitHub reports reviewDecision REVIEW_REQUIRED, mergeStateStatus BLOCKED',
  ])
  const unprotected = world([OLD], { decision: async () => ({ reviewDecision: null, mergeStateStatus: 'CLEAN' }) })
  t.deepEqual((await run(deps(unprotected))).dual!.prs[0].warnings, [])
  t.end()
})

// A failed post is an error naming the HTTP status, so Slack can say why.
test('dual runner reports a failed post with its HTTP status', async t => {
  const w = world([OLD], { postReview: async () => { throw new GhApiError('gh api failed (HTTP 422)', 422) } })
  const out = await run(deps(w))
  t.equal(out.dual!.prs[0].outcome, 'error')
  t.equal(out.dual!.prs[0].reason, 'posting the review failed (HTTP 422)')
  t.end()
})

// Q3: under require_last_push_approval the bot never updates the branch (its own push would void
// its approval); the PR is blocked, engines do not run, nothing is posted.
test('dual runner blocks a moved base under require_last_push_approval without updating', async t => {
  const w = world([OLD], {
    behindBy: async () => 3,
    branchRules: async () => [{ type: 'pull_request', parameters: { required_approving_review_count: 1, require_last_push_approval: true } }],
  })
  const codex = engine('codex')
  const out = await run(deps(w, [codex, engine('claude')]))
  t.equal(out.dual!.prs[0].outcome, 'blocked')
  t.match(out.dual!.prs[0].reason ?? '', /requires approval of the latest push/)
  t.deepEqual(w.updates, [])
  t.equal(codex.calls.length, 0)
  t.deepEqual(w.posted, [])
  t.end()
})

// Review Focus 3: if a rule source is unreadable, the last-push rule may be hiding in it, so the
// bot must not update the branch on a guess.
test('dual runner does not update the branch when a rule source is unreadable', async t => {
  const w = world([OLD], { behindBy: async () => 1, classicProtection: async () => { throw new GhApiError('gh api failed (HTTP 403)', 403) } })
  const out = await run(deps(w))
  t.equal(out.dual!.prs[0].outcome, 'blocked')
  t.match(out.dual!.prs[0].reason ?? '', /branch rules could not all be read/)
  t.deepEqual(w.updates, [])
  t.end()
})

// Q3: a 422 from update-branch (a conflict, or the head moved) blocks the PR and posts nothing.
test('dual runner blocks when update-branch is refused', async t => {
  const w = world([OLD], { behindBy: async () => 1, updateBranch: async () => ({ ok: false as const, status: 422 }) })
  const out = await run(deps(w))
  t.equal(out.dual!.prs[0].outcome, 'blocked')
  t.match(out.dual!.prs[0].reason ?? '', /HTTP 422/)
  t.deepEqual(w.posted, [])
  t.end()
})

// An accepted update whose new head never appears within the gh timeout blocks rather than
// pinning the old head, which GitHub has already replaced.
test('dual runner blocks when no new head appears after update-branch', async t => {
  const w = world([OLD], { behindBy: async () => 1 })
  const out = await run(deps(w))
  t.deepEqual(w.updates, [OLD], 'update-branch was sent with expected_head_sha')
  t.equal(out.dual!.prs[0].outcome, 'blocked')
  t.match(out.dual!.prs[0].reason ?? '', /no new head appeared in time/)
  t.end()
})

// Spec 5.3 and the issue 61 acceptance: after update-branch the whole pre-flight is re-run against
// the new head. Here the update dismisses the code owner's approval, so `counts` becomes `partial`,
// and the engines review and the bot approves the NEW head. Regression caught: posting with the
// stale prediction, or pinning the pre-update SHA.
test('dual runner re-runs the pre-flight after update-branch dismisses an owner approval', async t => {
  let updated = false
  const reviews = (): ReviewFact[] => [{ login: 'alice', state: updated ? 'DISMISSED' : 'APPROVED', submittedAt: '2026-11-17T09:00:00Z' }]
  const w = world([OLD, NEW], {
    behindBy: async () => 2,
    branchRules: async () => [{ type: 'pull_request', parameters: { required_approving_review_count: 1, require_code_owner_review: true } }],
    fileAt: async (_pr, file) => (file === '.github/CODEOWNERS' ? '* @alice\n' : null),
    codeownersErrorCount: async () => 0,
    reviews: async () => reviews(),
    updateBranch: async () => {
      updated = true
      return { ok: true as const }
    },
  })
  const codex = engine('codex')
  const out = await run(deps(w, [codex, engine('claude')]))
  const pr = out.dual!.prs[0]
  t.equal(codex.calls[0].prs[0].pinnedSha, NEW, 'the new head is pinned')
  t.equal(pr.eligibility?.verdict, 'partial', 're-evaluated: the owner approval was dismissed')
  t.ok(pr.eligibility?.missing.some(m => m.includes('@alice')))
  t.deepEqual(w.posted.map(p => [p.event, p.commitId]), [['APPROVE', NEW]])
  t.equal(pr.outcome, 'approvedPartial')
  t.end()
})

// A role-account token that does not authenticate makes every PR an error before any engine runs.
test('dual runner reports every PR as an error when the role account cannot log in', async t => {
  const w = world([OLD], { login: async () => { throw new Error('HTTP 401') } })
  const codex = engine('codex')
  const out = await run(deps(w, [codex, engine('claude')]))
  t.equal(out.dual!.prs[0].outcome, 'error')
  t.match(out.dual!.prs[0].reason ?? '', /APPROVER_GH_TOKEN/)
  t.equal(codex.calls.length, 0)
  t.end()
})

// Q4: a pre-flight that cannot finish is wontCount, the review still runs, and a dual-clean result
// is a COMMENT, never an APPROVE.
test('dual runner treats an unlistable diff as wontCount and comments instead of approving', async t => {
  const w = world()
  const out = await run(deps(w, undefined, { listChangedFiles: async () => { throw new Error('HTTP 406') } }))
  t.equal(out.dual!.prs[0].eligibility?.verdict, 'wontCount')
  t.deepEqual(w.posted.map(p => p.event), ['COMMENT'])
  t.equal(out.dual!.prs[0].outcome, 'cleanNotCounted')
  t.end()
})

// Narrow approve race: the head can move after the first re-read, during the idempotency and diff
// reads. Regression caught: an APPROVE at the old pinned SHA after a push in that window. Heads are
// [pre-flight, first check, pre-post check].
test('dual runner posts nothing when the head moves between the first check and posting', async t => {
  const w = world([OLD, OLD, NEW])
  const out = await run(deps(w))
  t.equal(out.dual!.prs[0].outcome, 'headMoved')
  t.match(out.dual!.prs[0].reason ?? '', /aaaaaaa → bbbbbbb/)
  t.deepEqual(w.posted, [])
  t.end()
})

// A failed pre-post head read cannot confirm the pinned SHA, so nothing is posted.
test('dual runner posts nothing when the pre-post head read fails', async t => {
  let call = 0
  const w = world([OLD], {
    getPullRequest: async () => {
      if (++call === 3) throw new Error('HTTP 502')
      return info(OLD)
    },
  })
  const out = await run(deps(w))
  t.equal(out.dual!.prs[0].outcome, 'error')
  t.match(out.dual!.prs[0].reason ?? '', /just before posting/)
  t.deepEqual(w.posted, [])
  t.end()
})

// The same PR pasted twice (URL case differs) must be reviewed, posted and reported once.
// Regression caught: a double review and a double approval attempt for one PR.
test('dual runner reviews a PR listed twice only once', async t => {
  const w = world()
  const codex = engine('codex')
  const dup: ReviewRequest = { ...request, prs: [request.prs[0], { ...request.prs[0], url: URL1.toUpperCase() }] }
  const out = await makeDualReviewRunner(deps(w, [codex, engine('claude')]))(dup)
  t.equal(codex.calls[0].prs.length, 1)
  t.equal(out.dual!.prs.length, 1)
  t.equal(w.posted.length, 1)
  t.end()
})

// One PR's unexpected failure must not lose the other PR's report or the usage. Regression caught:
// a throw in finishPr for PR 2 rejecting the whole run after PR 1 had already been approved.
test('dual runner isolates a throw while finishing one PR', async t => {
  const URL2 = 'https://github.com/o/r/pull/2'
  const two: ReviewRequest = { ...request, prs: [request.prs[0], { owner: 'o', repo: 'r', number: 2, url: URL2 }] }
  const w = world([OLD], {
    postReview: async (pr: { number: number }) => {
      if (pr.number === 2) throw new Error('boom')
      return { id: 1, url: 'https://github.com/o/r/pull/1#pullrequestreview-1' }
    },
  } as Partial<ApproverGitHub>)
  const d = deps(w, undefined, {
    log: event => {
      if (event === 'dual.post.failed') throw new Error('log sink broke')
    },
  })
  const out = await makeDualReviewRunner(d)(two)
  t.deepEqual(out.dual!.prs.map(p => p.outcome), ['approved', 'error'], 'PR 1 keeps its report')
  t.equal(out.usage.tokensUsed, 200, 'usage survives')
  t.end()
})

// A failed behindBy compare skips the update; the user must see that base freshness was unchecked.
test('dual runner warns when the base freshness could not be checked', async t => {
  const w = world([OLD], { behindBy: async () => { throw new Error('HTTP 502') } })
  const out = await run(deps(w))
  t.match(out.dual!.prs[0].warnings.join('\n'), /could not check whether the base moved/)
  t.deepEqual(w.updates, [])
  t.end()
})

// Per-engine usage survives the combination for the Slack usage line and the status totals.
test('combineUsage sums tokens and active time and keeps each engine', t => {
  const u = combineUsage([
    { engine: 'codex', results: [], usage: { tokensUsed: 10, activeMs: 100, attempts: 2 } },
    { engine: 'claude', results: [], usage: { activeMs: 50, attempts: 1 } },
  ])
  t.equal(u.tokensUsed, 10)
  t.equal(u.activeMs, 150)
  t.equal(u.attempts, 2)
  t.deepEqual(u.engines?.map(e => e.engine), ['codex', 'claude'])
  t.end()
})
