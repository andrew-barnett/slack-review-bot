import test from 'tape'
import { evaluateEligibility, mergeRules, NO_RULES, rulesFromClassic, rulesFromRulesets, type EligibilityFacts, type PullRequestRules } from './preflight'

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
  t.deepEqual(merged, { requiredApprovals: 2, requireCodeOwnerReview: true, requireLastPushApproval: false, dismissStaleReviews: true })
  t.end()
})

// Classic protection and rulesets use different field names (require_code_owner_reviews vs
// require_code_owner_review, dismiss_stale_reviews vs dismiss_stale_reviews_on_push). A mix-up
// silently drops a requirement.
test('rule parsers read each source field names', t => {
  t.deepEqual(
    rulesFromRulesets([{ type: 'pull_request', parameters: { required_approving_review_count: 2, require_code_owner_review: true, require_last_push_approval: true, dismiss_stale_reviews_on_push: true } }, { type: 'deletion' }]),
    { requiredApprovals: 2, requireCodeOwnerReview: true, requireLastPushApproval: true, dismissStaleReviews: true }
  )
  t.deepEqual(
    rulesFromClassic({ required_pull_request_reviews: { required_approving_review_count: 1, require_code_owner_reviews: true, require_last_push_approval: false, dismiss_stale_reviews: true } }),
    { requiredApprovals: 1, requireCodeOwnerReview: true, requireLastPushApproval: false, dismissStaleReviews: true }
  )
  t.deepEqual(rulesFromClassic(null), NO_RULES, 'an unprotected branch has no requirement')
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
test('dismissed approvals are excluded, older-SHA approvals still count', t => {
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
