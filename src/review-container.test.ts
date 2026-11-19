import test from 'tape'
import type { ApproverGitHub, PullRequestInfo } from './approver-github'
import { loadReviewConfig } from './config'
import type { ReviewRequest } from './job'
import { makeContainerReviewRunner, selectReviewRunner } from './review'

const SHA = 'c'.repeat(40)
const URL1 = 'https://github.com/o/r/pull/1'
const request: ReviewRequest = { message: { channel: 'C1', ts: '1.1' }, prs: [{ owner: 'o', repo: 'r', number: 1, url: URL1 }], instructions: '' }
const config = loadReviewConfig({ HOME: '/home/bot', RUNTIME: 'container', REVIEW_ENGINES: 'claude', APPROVER_GH_TOKEN: 'approver-placeholder' })
const info: PullRequestInfo = { author: 'dev', base: 'main', baseRepo: 'o/r', headRef: 'feat/x', headSha: SHA, headRepo: 'o/r', state: 'open', draft: false }

/** A role-account fake on an unprotected branch; records what was posted. */
function fakeGh(posted: string[]): ApproverGitHub {
  return {
    login: async () => 'role-bot',
    getPullRequest: async () => info,
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
    commentableLines: async () => new Map(),
    updateBranch: async () => ({ ok: true as const }),
    postReview: async (_pr: unknown, review: { event: string }) => {
      posted.push(review.event)
      return { id: 1, url: `${URL1}#pullrequestreview-1` }
    },
    botReviews: async () => [],
    decision: async () => ({ reviewDecision: 'APPROVED', mergeStateStatus: 'CLEAN' }),
  } as unknown as ApproverGitHub
}

const remote = {
  runCodex: async () => {
    throw new Error('codex is not configured')
  },
  runClaude: async () => ({
    result: { results: [{ url: URL1, reviewedSha: SHA, verdict: 'clean' as const, findings: [], summary: '', environmentProblems: [] }] },
    usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, numTurns: 1, durationMs: 1 },
    tokensUsed: 2,
    activeMs: 3,
    permissionDenials: 0,
  }),
}

// Spec D8: container single mode is the dual runner with one engine and approvals off, posting as
// the role account. Regression caught: the container runtime falling through to the local
// single-engine runner, which would run Codex inside the orchestrator.
test('selectReviewRunner sends RUNTIME=container to the report-only remote runner', async t => {
  const posted: string[] = []
  const runner = selectReviewRunner(config, { gh: fakeGh(posted), engineDeps: remote, listChangedFiles: async () => ['src/a.ts'] })
  const out = await runner(request)
  t.deepEqual(posted, ['COMMENT'])
  t.equal(out.dual!.prs[0].outcome, 'clean')
  t.end()
})

// The orchestrator holds no engine credential: a container runner wired with an engine-auth
// resolver or a CodeArtifact refresh, or without the remote run functions, is refused at startup.
test('makeContainerReviewRunner refuses local engine wiring', t => {
  const base = { gh: fakeGh([]), engineDeps: remote, listChangedFiles: async () => [] }
  t.doesNotThrow(() => makeContainerReviewRunner(config, base))
  t.throws(() => makeContainerReviewRunner(config, { ...base, engineDeps: undefined }), /remote run functions/)
  t.throws(() => makeContainerReviewRunner(config, { ...base, engineAuth: async () => undefined }), /holds no engine credential/)
  t.throws(() => makeContainerReviewRunner(config, { ...base, refreshAuth: async () => {} }), /holds no engine credential/)
  t.throws(() => makeContainerReviewRunner(config, { ...base, listChangedFiles: undefined }), /listChangedFiles/)
  t.throws(() => makeContainerReviewRunner({ ...config, approverGhToken: '' }, { ...base, gh: undefined }), /APPROVER_GH_TOKEN/)
  t.end()
})

// DUAL_MODE_AVAILABLE stays false in both runtimes (Global Constraints).
test('container dual mode stays behind DUAL_MODE_AVAILABLE', t => {
  const dual = loadReviewConfig({ HOME: '/home/bot', RUNTIME: 'container', REVIEW_ENGINES: 'codex,claude', APPROVER_GH_TOKEN: 'a' })
  t.throws(() => makeContainerReviewRunner(dual, { gh: fakeGh([]), engineDeps: remote, listChangedFiles: async () => [] }), /REVIEW_ENGINES|dual/i)
  t.end()
})
