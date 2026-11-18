// Every GitHub call the daemon makes as the role account, with the approver token. The token is
// handed to gh per call (GH_TOKEN in that call's env) and never placed in process.env, and it is
// never given to an engine child (spec sections 5.7 and 9).

import { defaultRunner, ghApi, ghApiLines, GhApiError, type GhRunner } from './gh-api'
import type { PullRequestRef } from './parse-message'

export type Permission = 'admin' | 'maintain' | 'write' | 'triage' | 'read' | 'none'
export interface PullRequestInfo { author: string; base: string; headRef: string; headSha: string; headRepo: string; baseRepo: string; state: string; draft: boolean }
export interface ReviewFact { login: string; state: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED' | 'PENDING'; submittedAt: string }
export interface LatestPush { actor: string; at: string; afterSha: string }
export interface ReviewComment { path: string; line: number; side: 'RIGHT'; body: string }
export interface PostedReview { id: number; url: string }
export interface BotReview { login: string; commitId: string; state: string }
export interface Decision { reviewDecision: string | null; mergeStateStatus: string }
export interface ApproverGitHub {
  login(): Promise<string>
  getPullRequest(pr: PullRequestRef): Promise<PullRequestInfo>
  permission(pr: PullRequestRef, login: string): Promise<Permission>
  branchRules(pr: PullRequestRef, branch: string): Promise<unknown[]>
  classicProtection(pr: PullRequestRef, branch: string): Promise<unknown | null>   // null = "Branch not protected" 404; any other failure rejects
  fileAt(pr: PullRequestRef, path: string, ref: string): Promise<string | null>      // null = no such file (404); non-base64 content (e.g. over 1 MB) rejects
  /** Number of CODEOWNERS errors GitHub reports at `ref`; null when GitHub answers 404, i.e. it sees no CODEOWNERS file. */
  codeownersErrorCount(pr: PullRequestRef, ref: string): Promise<number | null>
  isTeamMember(org: string, team: string, login: string): Promise<boolean>
  reviews(pr: PullRequestRef): Promise<ReviewFact[]>
  latestPush(pr: PullRequestRef, headRef: string): Promise<LatestPush | null>          // null = no record
  commentableLines(pr: PullRequestRef): Promise<Map<string, Set<number>>>
  updateBranch(pr: PullRequestRef, expectedHeadSha: string): Promise<{ ok: true } | { ok: false; status: number | undefined }>
  postReview(pr: PullRequestRef, review: { commitId: string; event: 'APPROVE' | 'COMMENT'; body: string; comments: ReviewComment[] }): Promise<PostedReview>
  botReviews(pr: PullRequestRef, botLogin: string): Promise<BotReview[]>
  decision(pr: PullRequestRef): Promise<Decision>
}

const repoPath = (pr: PullRequestRef) => `repos/${pr.owner}/${pr.repo}`

/** Commentable new-side line numbers in a unified-diff patch: added (+) and context ( ) lines. */
export function parsePatchLines(patch: string): Set<number> {
  const lines = new Set<number>()
  let next = 0
  let inHunk = false
  for (const raw of patch.split('\n')) {
    const header = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw)
    if (header) {
      next = Number(header[1])
      inHunk = true
      continue
    }
    if (!inHunk) continue
    if (raw.startsWith('+') || raw.startsWith(' ')) {
      lines.add(next)
      next += 1
    }
    // '-' lines and '\ No newline at end of file' do not advance the new side.
  }
  return lines
}

async function orNullOn404<T>(call: Promise<T>): Promise<T | null> {
  try {
    return await call
  } catch (error) {
    if (error instanceof GhApiError && error.status === 404) return null
    throw error
  }
}

export function makeApproverGitHub(token: string, run: GhRunner = defaultRunner('gh')): ApproverGitHub {
  // Every call made through this runner authenticates as the role account.
  const asApprover: GhRunner = (args, opts = {}) =>
    run(args, { ...opts, env: { ...process.env, ...opts.env, GH_TOKEN: token } })

  const graphql = <T>(query: string, variables: Record<string, unknown>) =>
    ghApi<{ data: T }>(asApprover, 'graphql', { method: 'POST', body: { query, variables } }).then(r => r.data)

  return {
    async login() {
      return (await ghApi<{ login: string }>(asApprover, 'user')).login
    },
    async getPullRequest(pr) {
      const p = await ghApi<{
        user: { login: string }
        base: { ref: string; repo: { full_name: string } }
        head: { ref: string; sha: string; repo: { full_name: string } | null }
        state: string
        draft: boolean
      }>(asApprover, `${repoPath(pr)}/pulls/${pr.number}`)
      return {
        author: p.user.login,
        base: p.base.ref,
        baseRepo: p.base.repo.full_name,
        headRef: p.head.ref,
        headSha: p.head.sha,
        // A deleted fork has no repo; treat it as foreign so the latest pusher reads as unverifiable.
        headRepo: p.head.repo?.full_name ?? '',
        state: p.state,
        draft: p.draft,
      }
    },
    async permission(pr, login) {
      const r = await ghApi<{ permission: Permission; role_name?: string }>(
        asApprover,
        `${repoPath(pr)}/collaborators/${encodeURIComponent(login)}/permission`
      )
      // role_name carries maintain/triage, which the legacy `permission` field folds into write/read.
      const role = r.role_name as Permission | undefined
      return role && ['admin', 'maintain', 'write', 'triage', 'read'].includes(role) ? role : r.permission
    },
    async branchRules(pr, branch) {
      return ghApiLines<unknown>(asApprover, `${repoPath(pr)}/rules/branches/${encodeURIComponent(branch)}`)
    },
    async classicProtection(pr, branch) {
      try {
        return await ghApi<unknown>(asApprover, `${repoPath(pr)}/branches/${encodeURIComponent(branch)}/protection`)
      } catch (error) {
        // Only GitHub's explicit "Branch not protected" 404 means no protection. Any other 404
        // (a hidden or renamed repo or branch, a token that cannot see it) is unreadable, never
        // "no requirement".
        if (error instanceof GhApiError && error.status === 404 && /branch not protected/i.test(error.detail)) return null
        throw error
      }
    },
    async fileAt(pr, filePath, ref) {
      const file = await orNullOn404(
        ghApi<{ content?: string; encoding?: string }>(asApprover, `${repoPath(pr)}/contents/${filePath}?ref=${encodeURIComponent(ref)}`)
      )
      if (!file) return null
      // A file over 1 MB comes back with encoding "none" and empty content; decoding that would
      // read as an empty file. Anything but base64 content is unreadable.
      if (file.encoding !== 'base64' || typeof file.content !== 'string') {
        throw new Error(`contents of ${filePath} are not base64 (encoding ${String(file.encoding)}); the file may be too large to read`)
      }
      return Buffer.from(file.content, 'base64').toString('utf8')
    },
    async codeownersErrorCount(pr, ref) {
      const r = await orNullOn404(ghApi<{ errors: unknown[] }>(asApprover, `${repoPath(pr)}/codeowners/errors?ref=${encodeURIComponent(ref)}`))
      return r ? r.errors.length : null
    },
    async isTeamMember(org, team, login) {
      const r = await orNullOn404(
        ghApi<{ state: string }>(asApprover, `orgs/${org}/teams/${team}/memberships/${encodeURIComponent(login)}`)
      )
      return r?.state === 'active'
    },
    async reviews(pr) {
      // Every page: an owner's approval past the first 100 reviewers must not be silently dropped.
      type Page = {
        repository: {
          pullRequest: {
            latestOpinionatedReviews: {
              nodes: { author: { login: string } | null; state: ReviewFact['state']; submittedAt: string }[]
              pageInfo: { hasNextPage: boolean; endCursor: string | null }
            }
          }
        }
      }
      const out: ReviewFact[] = []
      let after: string | null = null
      do {
        const data: Page = await graphql<Page>(
          `query($owner:String!,$name:String!,$number:Int!,$after:String){repository(owner:$owner,name:$name){pullRequest(number:$number){latestOpinionatedReviews(first:100,after:$after){nodes{author{login} state submittedAt} pageInfo{hasNextPage endCursor}}}}}`,
          { owner: pr.owner, name: pr.repo, number: pr.number, after }
        )
        const page = data.repository.pullRequest.latestOpinionatedReviews
        for (const n of page.nodes) if (n.author) out.push({ login: n.author.login, state: n.state, submittedAt: n.submittedAt })
        after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null
      } while (after)
      return out
    },
    async latestPush(pr, headRef) {
      const ref = encodeURIComponent(`refs/heads/${headRef}`)
      const items = await ghApi<{ actor: { login: string } | null; timestamp: string; after: string }[]>(
        asApprover,
        `${repoPath(pr)}/activity?ref=${ref}&activity_type=push&per_page=1`
      )
      const top = items[0]
      return top && top.actor ? { actor: top.actor.login, at: top.timestamp, afterSha: top.after } : null
    },
    async commentableLines(pr) {
      const files = await ghApiLines<{ filename: string; patch?: string }>(asApprover, `${repoPath(pr)}/pulls/${pr.number}/files?per_page=100`)
      return new Map(files.map(f => [f.filename, parsePatchLines(f.patch ?? '')]))
    },
    async updateBranch(pr, expectedHeadSha) {
      try {
        await ghApi(asApprover, `${repoPath(pr)}/pulls/${pr.number}/update-branch`, {
          method: 'PUT',
          body: { expected_head_sha: expectedHeadSha },
        })
        return { ok: true }
      } catch (error) {
        if (error instanceof GhApiError && error.status === 422) return { ok: false, status: 422 }
        throw error
      }
    },
    async postReview(pr, review) {
      const r = await ghApi<{ id: number; html_url: string }>(asApprover, `${repoPath(pr)}/pulls/${pr.number}/reviews`, {
        method: 'POST',
        body: { commit_id: review.commitId, event: review.event, body: review.body, comments: review.comments },
      })
      return { id: r.id, url: r.html_url }
    },
    async botReviews(pr, botLogin) {
      const all = await ghApiLines<{ user: { login: string } | null; commit_id: string; state: string }>(
        asApprover,
        `${repoPath(pr)}/pulls/${pr.number}/reviews?per_page=100`
      )
      return all
        .filter(r => r.user && r.user.login.toLowerCase() === botLogin.toLowerCase())
        .map(r => ({ login: r.user!.login, commitId: r.commit_id, state: r.state }))
    },
    async decision(pr) {
      const data = await graphql<{ repository: { pullRequest: { reviewDecision: string | null; mergeStateStatus: string } } }>(
        `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewDecision mergeStateStatus}}}`,
        { owner: pr.owner, name: pr.repo, number: pr.number }
      )
      return data.repository.pullRequest
    },
  }
}
