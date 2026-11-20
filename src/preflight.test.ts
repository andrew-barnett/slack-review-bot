import test from 'tape'
import type { ApproverGitHub, PullRequestInfo, ReviewFact } from './approver-github'
import { evaluateEligibility, gatherEligibilityFacts, mergeRules, NO_RULES, rulesFromClassic, rulesFromRulesets, type EligibilityFacts, type PullRequestRules } from './preflight'

const rules = (r: Partial<PullRequestRules>): PullRequestRules => ({ ...NO_RULES, ...r })

/** A PR with no requirements, a write-access bot, and nothing unreadable; each test varies one thing. */
function facts(over: Partial<EligibilityFacts> = {}): EligibilityFacts {
  return {
    botLogin: 'role-bot',
    prAuthor: 'dev',
    changedFiles: ['src/a.ts'],
    botPermission: 'write',
    ruleSources: [{ name: 'rulesets', rules: NO_RULES }, { name: 'classic protection', rules: NO_RULES }],
    codeowners: '',
    codeownersErrors: 0,
    reviews: [],
    reviewerPermissions: {},
    teamMembership: {},
    latestPush: null,
    ...over,
  }
}

// Rules come from rulesets and classic protection; the effective rule is the strictest of all.
// Taking only one source would under-state requirements on a repo that uses both.
test('mergeRules takes the strictest of every source', t => {
  const merged = mergeRules([rules({ requiredApprovals: 1, dismissStaleReviews: true }), rules({ requiredApprovals: 2, requireCodeOwnerReview: true })])
  t.deepEqual(merged, { requiredApprovals: 2, requireCodeOwnerReview: true, requireLastPushApproval: false, dismissStaleReviews: true, extraApprovalForCopilot: false })
  t.end()
})

// Classic protection and rulesets use different field names (require_code_owner_reviews vs
// require_code_owner_review, dismiss_stale_reviews vs dismiss_stale_reviews_on_push). A mix-up
// silently drops a requirement.
test('rule parsers read each source field names', t => {
  t.deepEqual(
    rulesFromRulesets([{ type: 'pull_request', parameters: { required_approving_review_count: 2, require_code_owner_review: true, require_last_push_approval: true, dismiss_stale_reviews_on_push: true } }, { type: 'deletion' }]),
    { requiredApprovals: 2, requireCodeOwnerReview: true, requireLastPushApproval: true, dismissStaleReviews: true, extraApprovalForCopilot: false }
  )
  t.deepEqual(
    rulesFromClassic({ required_pull_request_reviews: { required_approving_review_count: 1, require_code_owner_reviews: true, require_last_push_approval: false, dismiss_stale_reviews: true } }),
    { requiredApprovals: 1, requireCodeOwnerReview: true, requireLastPushApproval: false, dismissStaleReviews: true, extraApprovalForCopilot: false }
  )
  t.deepEqual(rulesFromClassic(null), NO_RULES, 'an unprotected branch has no requirement')
  t.end()
})

// The live trade-platform/trade-platform-monorepo ruleset (V1, 2026-11-20) sets dismissal_restriction
// (a non-empty object even when disabled) and require_extra_approval_for_unattributed_changes, which
// GitHub enables by default. Both used to be unknown, so every such repo failed closed and the bot's
// approval was never predicted to count.
test('rulesFromRulesets accepts the dismissal-restriction and unattributed-changes parameters', t => {
  const parsed = rulesFromRulesets([
    { type: 'deletion' },
    {
      type: 'pull_request',
      parameters: {
        required_approving_review_count: 1,
        dismiss_stale_reviews_on_push: true,
        required_reviewers: [],
        require_code_owner_review: false,
        dismissal_restriction: { enabled: false, allowed_actors: [] },
        require_last_push_approval: true,
        required_review_thread_resolution: false,
        require_extra_approval_for_unattributed_changes: true,
        allowed_merge_methods: ['merge', 'squash', 'rebase'],
      },
    },
    { type: 'required_status_checks', parameters: { strict_required_status_checks_policy: true } },
  ])
  t.deepEqual(parsed, { requiredApprovals: 1, requireCodeOwnerReview: false, requireLastPushApproval: true, dismissStaleReviews: true, extraApprovalForCopilot: true })
  t.end()
})

// The extra-approval rule applies only to Copilot-authored PRs, and only when approvals are
// required. Regression caught: predicting that the bot's single approval satisfies a one-approval
// rule on a Copilot PR, when GitHub requires two.
test('a Copilot-authored PR needs one more approval when the unattributed-changes rule is on', t => {
  const on = [{ name: 'rulesets', rules: rules({ requiredApprovals: 1, extraApprovalForCopilot: true }) }]
  t.equal(evaluateEligibility(facts({ ruleSources: on })).verdict, 'counts', 'a human-authored PR is unaffected')
  const copilot = evaluateEligibility(facts({ ruleSources: on, prAuthor: 'Copilot' }))
  t.equal(copilot.verdict, 'partial')
  t.deepEqual(copilot.missing, ['1 more approval'])
  t.equal(evaluateEligibility(facts({ ruleSources: on, prAuthor: 'copilot-swe-agent[bot]' })).verdict, 'partial')
  const off = [{ name: 'rulesets', rules: rules({ requiredApprovals: 1 }) }]
  t.equal(evaluateEligibility(facts({ ruleSources: off, prAuthor: 'Copilot' })).verdict, 'counts', 'rule off: no extra approval')
  const none = [{ name: 'rulesets', rules: rules({ extraApprovalForCopilot: true }) }]
  t.equal(evaluateEligibility(facts({ ruleSources: none, prAuthor: 'Copilot' })).verdict, 'counts', 'no approvals required: nothing extra')
  t.end()
})

// No requirements at all: a valid bot approval trivially counts.
test('counts when nothing is required', t => {
  t.equal(evaluateEligibility(facts()).verdict, 'counts')
  t.end()
})

// Rule 3: the bot authored the PR. GitHub forbids self-approval. Review Focus 2: case-insensitive.
test('wontCount when the bot authored the PR, case-insensitively', t => {
  const e = evaluateEligibility(facts({ prAuthor: 'Role-Bot' }))
  t.equal(e.verdict, 'wontCount')
  t.match(e.reasons.join(' '), /authored this PR/)
  t.end()
})

// Rule 3: read or triage permission cannot approve in a way that counts.
test('wontCount when the bot lacks write permission', t => {
  t.equal(evaluateEligibility(facts({ botPermission: 'read' })).verdict, 'wontCount')
  t.end()
})

// Rule 3: under require_last_push_approval the latest pusher's approval does not satisfy it.
test('wontCount when the bot made the latest push under the last-push rule', t => {
  const e = evaluateEligibility(facts({
    ruleSources: [{ name: 'rulesets', rules: rules({ requireLastPushApproval: true }) }],
    latestPush: { actor: 'role-bot', at: '2026-11-17T10:00:00Z', afterSha: 'h' },
  }))
  t.equal(e.verdict, 'wontCount')
  t.ok(e.lastPushApproval)
  t.end()
})

// Rule 2: a read-only reviewer's approval is shown by GitHub but never counts. Counting it would
// predict "counts" while GitHub still wants another approval.
test('a read-only reviewer approval does not count toward the number', t => {
  const e = evaluateEligibility(facts({
    ruleSources: [{ name: 'rulesets', rules: rules({ requiredApprovals: 2 }) }],
    reviews: [{ login: 'reader', state: 'APPROVED', submittedAt: '2026-11-17T09:00:00Z' }],
    reviewerPermissions: { reader: 'read' },
  }))
  t.equal(e.verdict, 'partial')
  t.deepEqual(e.missing, ['1 more approval'])
  t.end()
})

// Rule 2: GitHub's DISMISSED state is authoritative. An APPROVED review on an older SHA still
// counts (an empty-commit push does not dismiss it).
test('an APPROVED review counts toward the number and a DISMISSED one does not', t => {
  const base = { ruleSources: [{ name: 'rulesets', rules: rules({ requiredApprovals: 2, dismissStaleReviews: true }) }], reviewerPermissions: { alice: 'write' as const } }
  t.equal(evaluateEligibility(facts({ ...base, reviews: [{ login: 'alice', state: 'APPROVED', submittedAt: '2026-11-17T09:00:00Z' }] })).verdict, 'counts')
  t.equal(evaluateEligibility(facts({ ...base, reviews: [{ login: 'alice', state: 'DISMISSED', submittedAt: '2026-11-17T09:00:00Z' }] })).verdict, 'partial')
  t.end()
})

// Rule 4: an existing code-owner approval satisfies the path even though the bot does not own it;
// the bot then fills the count, so the result is counts.
test('an existing owner approval plus the bot filling the count gives counts', t => {
  const e = evaluateEligibility(facts({
    ruleSources: [{ name: 'rulesets', rules: rules({ requiredApprovals: 2, requireCodeOwnerReview: true }) }],
    codeowners: '/src/ @alice',
    reviews: [{ login: 'alice', state: 'APPROVED', submittedAt: '2026-11-17T09:00:00Z' }],
    reviewerPermissions: { alice: 'write' },
  }))
  t.equal(e.verdict, 'counts')
  t.end()
})

// Rule 4 through team membership. Review Focus 2: an owner written with different case still matches.
test('the bot satisfies an owner path through active team membership', t => {
  const e = evaluateEligibility(facts({
    ruleSources: [{ name: 'rulesets', rules: rules({ requiredApprovals: 1, requireCodeOwnerReview: true }) }],
    codeowners: '/src/ @Acme/Pay',
    teamMembership: { '@acme/pay|role-bot': true },
  }))
  t.equal(e.verdict, 'counts')
  t.end()
})

// Rule 6: the bot owns one path but another needs a different owner: partial, naming what remains.
test('partial when some owner paths remain after the bot approval', t => {
  const e = evaluateEligibility(facts({
    changedFiles: ['src/a.ts', 'billing/b.ts'],
    ruleSources: [{ name: 'rulesets', rules: rules({ requiredApprovals: 1, requireCodeOwnerReview: true }) }],
    codeowners: ['/src/ @role-bot', '/billing/ @acme/finance'].join('\n'),
    teamMembership: { '@acme/finance|role-bot': false },
  }))
  t.equal(e.verdict, 'partial')
  t.deepEqual(e.missing, ['@acme/finance for billing/b.ts'])
  t.end()
})

// Rule 6: a valid approval that reduces nothing does not move the PR, so wontCount.
test('wontCount when the bot approval reduces no requirement', t => {
  const e = evaluateEligibility(facts({
    ruleSources: [{ name: 'rulesets', rules: rules({ requiredApprovals: 1, requireCodeOwnerReview: true }) }],
    codeowners: '/src/ @alice',
    reviews: [{ login: 'carol', state: 'APPROVED', submittedAt: '2026-11-17T09:00:00Z' }],
    reviewerPermissions: { carol: 'write' },
  }))
  t.equal(e.verdict, 'wontCount')
  t.end()
})

// Rule 5: an approval before the latest push still counts toward the number but cannot satisfy
// the latest-push requirement; the bot (not the pusher) satisfies it, so counts.
test('pre-push approvals count toward the number; the bot satisfies the latest push', t => {
  const e = evaluateEligibility(facts({
    ruleSources: [{ name: 'rulesets', rules: rules({ requiredApprovals: 2, requireLastPushApproval: true }) }],
    reviews: [{ login: 'alice', state: 'APPROVED', submittedAt: '2026-11-17T08:00:00Z' }],
    reviewerPermissions: { alice: 'write' },
    latestPush: { actor: 'dev', at: '2026-11-17T09:00:00Z', afterSha: 'h' },
  }))
  t.equal(e.verdict, 'counts')
  t.end()
})

// Rule 7 / Review Focus 3: anything needed but unreadable is wontCount with the source named,
// never a quiet "counts".
test('wontCount naming each unreadable source', t => {
  const e = evaluateEligibility(facts({
    ruleSources: [{ name: 'classic protection', rules: null }],
    reviews: [{ login: 'alice', state: 'APPROVED', submittedAt: '2026-11-17T09:00:00Z' }],
    reviewerPermissions: { alice: null },
  }))
  t.equal(e.verdict, 'wontCount')
  t.match(e.reasons.join(' '), /classic protection/)
  t.match(e.reasons.join(' '), /permission of alice/)
  t.end()
})

// Rule 7: CODEOWNERS errors matter only when code-owner review is required. With it required,
// a broken file is unverifiable.
test('CODEOWNERS errors make the result unverifiable only when owners are required', t => {
  t.equal(evaluateEligibility(facts({ codeownersErrors: 2 })).verdict, 'counts')
  t.equal(evaluateEligibility(facts({ codeownersErrors: 2, ruleSources: [{ name: 'rulesets', rules: rules({ requireCodeOwnerReview: true }) }] })).verdict, 'wontCount')
  t.end()
})

const REV = (login: string, state: ReviewFact['state'], submittedAt = '2026-11-17T09:00:00Z'): ReviewFact => ({ login, state, submittedAt })
const needApproval = (extra: Partial<PullRequestRules> = {}) => [{ name: 'rulesets', rules: rules({ requiredApprovals: 1, ...extra }) }]

// A write-level CHANGES_REQUESTED blocks merge and the bot's approval cannot clear it. Predicting
// "counts" here would tell the user the PR is mergeable when GitHub still blocks it.
test('an outstanding change request from a writer prevents counts', t => {
  const e = evaluateEligibility(facts({
    ruleSources: needApproval(),
    reviews: [REV('carol', 'CHANGES_REQUESTED')],
    reviewerPermissions: { carol: 'write' },
  }))
  t.notEqual(e.verdict, 'counts')
  t.ok(e.missing.includes('changes requested by @carol'))
  t.match(e.reasons.join(' '), /changes requested by @carol/)
  t.end()
})

// A read-only reviewer's change request does not block merge, so it must not block counts.
test('a change request from a read-only reviewer does not block', t => {
  t.equal(evaluateEligibility(facts({
    ruleSources: needApproval(),
    reviews: [REV('carol', 'CHANGES_REQUESTED')],
    reviewerPermissions: { carol: 'read' },
  })).verdict, 'counts')
  t.end()
})

// An unknown requester permission is unverifiable: never a quiet counts.
test('wontCount when a change requester permission is unknown', t => {
  const e = evaluateEligibility(facts({ ruleSources: needApproval(), reviews: [REV('carol', 'CHANGES_REQUESTED')] }))
  t.equal(e.verdict, 'wontCount')
  t.match(e.reasons.join(' '), /permission of carol/)
  t.end()
})

// With no approvals or owner review required, change requests are not merge-blocking.
test('change requests are ignored when no approvals or owner review are required', t => {
  t.equal(evaluateEligibility(facts({ reviews: [REV('carol', 'CHANGES_REQUESTED')], reviewerPermissions: { carol: 'write' } })).verdict, 'counts')
  t.end()
})

// A change request plus a slot the bot fills is partial: the bot reduced something, but the
// change request (which it cannot clear) remains.
test('partial when the bot fills a slot but a change request remains', t => {
  const e = evaluateEligibility(facts({
    ruleSources: needApproval({ requiredApprovals: 2 }),
    reviews: [REV('carol', 'CHANGES_REQUESTED')],
    reviewerPermissions: { carol: 'write' },
  }))
  t.equal(e.verdict, 'partial')
  t.ok(e.missing.includes('changes requested by @carol'))
  t.end()
})

// CODEOWNERS syntax the matcher does not support means ownership cannot be trusted (regression:
// a negation line silently ignored would predict counts wrongly).
test('unsupported CODEOWNERS syntax is unverifiable only when owner review is required', t => {
  const codeowners = '!src/a.ts @alice'
  const e = evaluateEligibility(facts({ codeowners, ruleSources: needApproval({ requireCodeOwnerReview: true }) }))
  t.equal(e.verdict, 'wontCount')
  t.match(e.reasons.join(' '), /line\(s\) 1/)
  t.equal(evaluateEligibility(facts({ codeowners })).verdict, 'counts')
  t.end()
})

// Each unreadable input must yield wontCount and name itself, never a quiet counts.
test('each unreadable input yields wontCount naming it', t => {
  const owner = [{ name: 'rulesets', rules: rules({ requireCodeOwnerReview: true }) }]
  const push = [{ name: 'rulesets', rules: rules({ requireLastPushApproval: true }) }]
  const cases: [string, Partial<EligibilityFacts>, RegExp][] = [
    ['reviews null', { reviews: null }, /PR reviews/],
    ['botPermission null', { botPermission: null }, /bot permission/],
    ['codeowners null', { ruleSources: owner, codeowners: null }, /CODEOWNERS/],
    ['codeownersErrors null', { ruleSources: owner, codeownersErrors: null }, /CODEOWNERS errors/],
    ['latestPush null', { ruleSources: push, latestPush: null }, /latest pusher/],
    ['team membership missing', { ruleSources: owner, codeowners: '/src/ @acme/pay' }, /team membership/],
    ['team membership null', { ruleSources: owner, codeowners: '/src/ @acme/pay', teamMembership: { '@acme/pay|role-bot': null } }, /team membership/],
    ['empty ruleSources', { ruleSources: [] }, /rule sources/],
  ]
  for (const [name, over, re] of cases) {
    const e = evaluateEligibility(facts(over))
    t.equal(e.verdict, 'wontCount', name)
    t.match(e.reasons.join(' '), re, `${name} reason`)
  }
  t.end()
})

// The same person may appear as 'alice' and 'Alice'; counting twice would over-state approvals.
test('approvals are deduplicated by lower-cased login', t => {
  const e = evaluateEligibility(facts({
    ruleSources: needApproval({ requiredApprovals: 3 }),
    reviews: [REV('alice', 'APPROVED'), REV('Alice', 'APPROVED')],
    reviewerPermissions: { alice: 'write' },
  }))
  t.deepEqual(e.missing, ['1 more approval'], 'one approval + bot leaves 1 of 3 missing')
  t.end()
})

// Fractional-second timestamps must order correctly. As strings '...09:00:00.500Z' sorts before
// '...09:00:00Z', so alice's post-push approval would be missed, the latest push would look
// unapproved, and the bot would wrongly read as "reducing" a requirement (partial, not wontCount).
test('last-push ordering uses parsed timestamps', t => {
  const e = evaluateEligibility(facts({
    ruleSources: needApproval({ requireLastPushApproval: true, requireCodeOwnerReview: true }),
    codeowners: '/src/ @zed',
    reviews: [REV('alice', 'APPROVED', '2026-11-17T09:00:00.500Z')],
    reviewerPermissions: { alice: 'write' },
    latestPush: { actor: 'dev', at: '2026-11-17T09:00:00Z', afterSha: 'h' },
  }))
  t.equal(e.verdict, 'wontCount')
  t.end()
})

const prRef = { owner: 'acme', repo: 'svc', number: 1, url: 'https://github.com/acme/svc/pull/1' }
const info: PullRequestInfo = { author: 'dev', base: 'main', baseRepo: 'acme/svc', headRef: 'feat/x', headSha: 'h1', headRepo: 'acme/svc', state: 'open', draft: false }

/** A fake ApproverGitHub with sensible defaults; each test overrides what it exercises. */
function fakeGh(over: Partial<ApproverGitHub> = {}): ApproverGitHub {
  const unused = async () => { throw new Error('not used in pre-flight') }
  return {
    login: async () => 'role-bot',
    getPullRequest: async () => info,
    permission: async () => 'write',
    branchRules: async () => [],
    classicProtection: async () => null,
    fileAt: async () => null,
    codeownersErrorCount: async () => 0,
    isTeamMember: async () => false,
    reviews: async () => [],
    latestPush: async () => null,
    commentableLines: unused,
    updateBranch: unused,
    postReview: unused,
    botReviews: unused,
    decision: unused,
    ...over,
  } as ApproverGitHub
}

// A failing read must become "unreadable" in the facts, so the evaluator says wontCount and names
// it. The fetch layer must never reject, or one flaky call would crash the review.
test('a failing read becomes null instead of rejecting', async t => {
  const f = await gatherEligibilityFacts(fakeGh({ classicProtection: async () => { throw new Error('HTTP 403') } }), prRef, info, ['a.ts'], 'role-bot')
  t.equal(f.ruleSources.find(s => s.name === 'classic protection')?.rules, null)
  t.end()
})

// CODEOWNERS lives in one of three places; GitHub uses the first that exists in that order.
test('CODEOWNERS is read from the first location that exists, at the base branch', async t => {
  const asked: string[] = []
  const f = await gatherEligibilityFacts(
    fakeGh({
      // CODEOWNERS is only read when code-owner review is required.
      branchRules: async () => [{ type: 'pull_request', parameters: { require_code_owner_review: true } }],
      fileAt: async (_pr, p, ref) => { asked.push(`${p}@${ref}`); return p === 'CODEOWNERS' ? '* @x' : null },
    }),
    prRef, info, ['a.ts'], 'role-bot'
  )
  t.deepEqual(asked, ['.github/CODEOWNERS@main', 'CODEOWNERS@main'])
  t.equal(f.codeowners, '* @x')
  t.end()
})

// Review Focus 4: a latest-push record for a different SHA than the head is stale and must read
// as unreadable, not as the latest push.
test('a latest-push record that does not match the head is treated as unreadable', async t => {
  const f = await gatherEligibilityFacts(
    fakeGh({
      branchRules: async () => [{ type: 'pull_request', parameters: { require_last_push_approval: true } }],
      latestPush: async () => ({ actor: 'dev', at: '2026-11-17T09:00:00Z', afterSha: 'old' }),
    }),
    prRef, info, ['a.ts'], 'role-bot'
  )
  t.equal(f.latestPush, null)
  t.equal(evaluateEligibility(f).verdict, 'wontCount')
  t.end()
})

// The latest pusher cannot be read for a head branch in a fork, so it is unreadable when needed.
test('the latest push of a fork head is unreadable', async t => {
  let called = false
  const f = await gatherEligibilityFacts(
    fakeGh({
      branchRules: async () => [{ type: 'pull_request', parameters: { require_last_push_approval: true } }],
      latestPush: async () => { called = true; return null },
    }),
    prRef, { ...info, headRepo: 'someone/svc' }, ['a.ts'], 'role-bot'
  )
  t.equal(f.latestPush, null)
  t.notOk(called, 'not queried for a fork')
  t.end()
})

// Team membership is looked up only for teams that own a changed path, and for each candidate
// (the bot and every approver), with keys matching the evaluator's format.
test('team membership is fetched for owning teams and candidates only', async t => {
  const asked: string[] = []
  const f = await gatherEligibilityFacts(
    fakeGh({
      branchRules: async () => [{ type: 'pull_request', parameters: { require_code_owner_review: true, required_approving_review_count: 1 } }],
      fileAt: async (_pr, p) => (p === '.github/CODEOWNERS' ? ['/src/ @Acme/Pay', '/other/ @acme/ops'].join('\n') : null),
      reviews: async () => [{ login: 'Alice', state: 'APPROVED', submittedAt: '2026-11-17T09:00:00Z' }],
      isTeamMember: async (org, team, login) => { asked.push(`${org}/${team}/${login}`); return login === 'role-bot' },
    }),
    prRef, info, ['src/a.ts'], 'role-bot'
  )
  t.deepEqual(asked.sort(), ['Acme/Pay/Alice', 'Acme/Pay/role-bot'])
  t.equal(f.teamMembership['@acme/pay|role-bot'], true)
  t.equal(f.reviewerPermissions['alice'], 'write')
  t.equal(evaluateEligibility(f).verdict, 'counts')
  t.end()
})

// Regression: the evaluator looks up the permission of every outstanding change requester (a
// write+ request blocks the merge). Without fetching it here, every change request would be
// reported as an unreadable permission. The bot's own review is excluded.
test('permissions are fetched for change requesters, not only approvers', async t => {
  const asked: string[] = []
  const f = await gatherEligibilityFacts(
    fakeGh({
      reviews: async () => [
        { login: 'Carol', state: 'CHANGES_REQUESTED', submittedAt: '2026-11-17T09:00:00Z' },
        { login: 'Role-Bot', state: 'CHANGES_REQUESTED', submittedAt: '2026-11-17T09:00:00Z' },
      ],
      permission: async (_pr, login) => { asked.push(login); return 'maintain' },
    }),
    prRef, info, ['a.ts'], 'role-bot'
  )
  t.equal(f.reviewerPermissions['carol'], 'maintain')
  t.notOk('role-bot' in f.reviewerPermissions, 'the bot review is not looked up')
  t.deepEqual(asked.filter(l => l !== 'role-bot'), ['Carol'])
  t.end()
})

const OWNER_REVIEW = [{ type: 'pull_request', parameters: { require_code_owner_review: true } }]

// GitHub's errors endpoint says 404 when it sees no CODEOWNERS file. The pre-flight cross-checks
// that with the file reads. Regression caught: a 404 was folded into "0 errors", so a file the
// reads missed (or a file GitHub does not see) passed as a clean, empty CODEOWNERS.
test('CODEOWNERS file reads are cross-checked against the errors endpoint', async t => {
  const gather = (fileAt: ApproverGitHub['fileAt'], codeownersErrorCount: ApproverGitHub['codeownersErrorCount']) =>
    gatherEligibilityFacts(fakeGh({ branchRules: async () => OWNER_REVIEW, fileAt, codeownersErrorCount }), prRef, info, ['a.ts'], 'role-bot')

  const none = await gather(async () => null, async () => null)
  t.equal(none.codeowners, '', 'no file anywhere and 404 from GitHub is a consistent no-file')
  t.equal(none.codeownersErrors, 0)

  const hidden = await gather(async () => null, async () => 0)
  t.equal(hidden.codeowners, null, 'all reads 404 but GitHub says a file exists is unreadable')

  const phantom = await gather(async (_pr, p) => (p === 'CODEOWNERS' ? '* @x' : null), async () => null)
  t.equal(phantom.codeowners, null, 'a file was read but GitHub says there is none is unreadable')

  const found = await gather(async (_pr, p) => (p === 'CODEOWNERS' ? '* @x' : null), async () => 0)
  t.equal(found.codeowners, '* @x', 'consistent file and zero errors is readable')
  t.equal(found.codeownersErrors, 0)

  const failed = await gather(async () => null, async () => { throw new Error('HTTP 500') })
  t.equal(failed.codeownersErrors, null, 'a failed errors read stays unreadable')
  t.equal(evaluateEligibility(failed).verdict, 'wontCount')
  t.equal(evaluateEligibility(hidden).verdict, 'wontCount')
  t.end()
})

// A pull_request rule parameter this tool does not model could be a requirement it would miss
// (for example required reviewers). Regression caught: unknown parameters were silently ignored,
// predicting "counts" where GitHub would not count the approval.
test('an unknown non-empty pull_request ruleset parameter makes the rulesets unreadable', async t => {
  const gather = (parameters: Record<string, unknown>) =>
    gatherEligibilityFacts(fakeGh({ branchRules: async () => [{ type: 'pull_request', parameters }] }), prRef, info, ['a.ts'], 'role-bot')

  const set = await gather({ required_reviewers: [{ reviewer: { id: 1 } }] })
  t.equal(set.ruleSources[0].rules, null)
  const e = evaluateEligibility(set)
  t.equal(e.verdict, 'wontCount')
  t.match(e.reasons.join(' '), /required_reviewers/, 'the reason names the parameter')

  const empty = await gather({ required_reviewers: [], some_flag: false, some_count: 0, some_text: '', some_obj: {} })
  t.notEqual(empty.ruleSources[0].rules, null, 'empty or falsy unknown parameters are ignored')

  const known = await gather({ required_approving_review_count: 2, required_review_thread_resolution: true, allowed_merge_methods: ['merge'], automatic_copilot_code_review_enabled: true })
  t.deepEqual(known.ruleSources[0].rules, { requiredApprovals: 2, requireCodeOwnerReview: false, requireLastPushApproval: false, dismissStaleReviews: false, extraApprovalForCopilot: false }, 'known parameters are unaffected')

  t.throws(() => rulesFromRulesets([{ type: 'pull_request', parameters: { x_new: true } }]), /x_new/)
  t.end()
})
