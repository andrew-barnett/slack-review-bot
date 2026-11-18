import test from 'tape'
import { makeApproverGitHub, parsePatchLines } from './approver-github'
import type { GhCallOptions } from './gh-api'

const pr = { owner: 'o', repo: 'r', number: 5, url: 'https://github.com/o/r/pull/5' }

function recorder(responses: Record<string, string | Error>) {
  const calls: { args: string[]; opts?: GhCallOptions }[] = []
  const run = async (args: string[], opts?: GhCallOptions) => {
    calls.push({ args, opts })
    const key = args.find(a => a.startsWith('repos/') || a.startsWith('orgs/') || a === 'graphql' || a === 'user') ?? ''
    const response = responses[key]
    if (response instanceof Error) throw response
    return response ?? ''
  }
  return { calls, run }
}

function httpError(status: number): Error {
  return Object.assign(new Error('failed'), { stderr: `gh: x (HTTP ${status})` })
}

// Every call must carry the approver token as GH_TOKEN in its own env, so the token never needs
// to live in process.env (spec section 5.7).
test('every approver call passes the token in the per-call env', async t => {
  const { calls, run } = recorder({ user: '{"login":"role-bot"}' })
  const gh = makeApproverGitHub('approver-placeholder', run)
  t.equal(await gh.login(), 'role-bot')
  t.equal(calls[0].opts?.env?.GH_TOKEN, 'approver-placeholder')
  t.end()
})

// An approval tied to commit_id is the whole point: the review applies to the commit both
// engines reviewed, never to whatever the head became. Body and comments go over stdin.
test('postReview posts commit_id, event, body and RIGHT-side comments on stdin', async t => {
  const { calls, run } = recorder({ 'repos/o/r/pulls/5/reviews': '{"id":9,"html_url":"https://x/9"}' })
  const gh = makeApproverGitHub('tok', run)
  const posted = await gh.postReview(pr, {
    commitId: 'a'.repeat(40),
    event: 'APPROVE',
    body: 'both clean',
    comments: [{ path: 'src/a.ts', line: 3, side: 'RIGHT', body: '**[Codex · NON-BLOCKING]** nit' }],
  })
  t.deepEqual(posted, { id: 9, url: 'https://x/9' })
  t.deepEqual(calls[0].args, ['api', 'repos/o/r/pulls/5/reviews', '--method', 'POST', '--input', '-'])
  t.deepEqual(JSON.parse(calls[0].opts?.input ?? '{}'), {
    commit_id: 'a'.repeat(40),
    event: 'APPROVE',
    body: 'both clean',
    comments: [{ path: 'src/a.ts', line: 3, side: 'RIGHT', body: '**[Codex · NON-BLOCKING]** nit' }],
  })
  t.end()
})

// 404 on classic protection means "not protected" (no requirement), while 403 means the token
// could not read it. Conflating them would either invent or hide a requirement.
test('classicProtection maps a "Branch not protected" 404 to null and rethrows other failures', async t => {
  const notProtected = Object.assign(new Error('failed'), { stderr: 'gh: Branch not protected (HTTP 404)' })
  const absent = makeApproverGitHub('tok', recorder({ 'repos/o/r/branches/main/protection': notProtected }).run)
  t.equal(await absent.classicProtection(pr, 'main'), null)
  // Regression caught: a bare "Not Found" 404 (renamed/hidden repo or branch) was read as "no
  // protection", silently inventing a no-requirement verdict.
  const missing = Object.assign(new Error('failed'), { stderr: 'gh: Not Found (HTTP 404)' })
  const ambiguous = makeApproverGitHub('tok', recorder({ 'repos/o/r/branches/main/protection': missing }).run)
  try {
    await ambiguous.classicProtection(pr, 'main')
    t.fail('a plain Not Found 404 must reject')
  } catch (error) {
    t.equal((error as { status?: number }).status, 404)
  }
  const denied = makeApproverGitHub('tok', recorder({ 'repos/o/r/branches/main/protection': httpError(403) }).run)
  try {
    await denied.classicProtection(pr, 'main')
    t.fail('403 must throw')
  } catch (error) {
    t.equal((error as { status?: number }).status, 403)
  }
  t.end()
})

// fileAt must return text only for base64 content. Regression caught: a file over 1 MB comes back
// with encoding "none" and empty content, which decoded to '' and read as an empty CODEOWNERS.
test('fileAt decodes base64, rejects other encodings, and maps 404 to null', async t => {
  const path = 'repos/o/r/contents/CODEOWNERS?ref=main'
  const ok = makeApproverGitHub('tok', recorder({ [path]: JSON.stringify({ encoding: 'base64', content: Buffer.from('* @x').toString('base64') }) }).run)
  t.equal(await ok.fileAt(pr, 'CODEOWNERS', 'main'), '* @x')
  const big = makeApproverGitHub('tok', recorder({ [path]: JSON.stringify({ encoding: 'none', content: '' }) }).run)
  try {
    await big.fileAt(pr, 'CODEOWNERS', 'main')
    t.fail('encoding none must reject')
  } catch {
    t.pass('encoding none rejects')
  }
  const missing = makeApproverGitHub('tok', recorder({ [path]: httpError(404) }).run)
  t.equal(await missing.fileAt(pr, 'CODEOWNERS', 'main'), null)
  t.end()
})

// codeownersErrorCount must distinguish "no file" (404) from "N errors", so the pre-flight can
// cross-check it against the file reads. Regression caught: 404 was folded into 0 errors.
test('codeownersErrorCount returns null for 404 and the count otherwise', async t => {
  const path = 'repos/o/r/codeowners/errors?ref=main'
  t.equal(await makeApproverGitHub('tok', recorder({ [path]: httpError(404) }).run).codeownersErrorCount(pr, 'main'), null)
  t.equal(await makeApproverGitHub('tok', recorder({ [path]: '{"errors":[{},{}]}' }).run).codeownersErrorCount(pr, 'main'), 2)
  t.equal(await makeApproverGitHub('tok', recorder({ [path]: '{"errors":[]}' }).run).codeownersErrorCount(pr, 'main'), 0)
  t.end()
})

// A 422 from update-branch is a merge conflict or a moved head. It is a normal outcome the
// orchestrator reports, not a crash.
test('updateBranch reports 422 as not ok', async t => {
  const gh = makeApproverGitHub('tok', recorder({ 'repos/o/r/pulls/5/update-branch': httpError(422) }).run)
  t.deepEqual(await gh.updateBranch(pr, 'b'.repeat(40)), { ok: false, status: 422 })
  t.end()
})

// Membership is "active" only. A pending invitation does not make someone an owner, and 404 (not
// a member) is false rather than an error.
test('isTeamMember is true only for an active membership', async t => {
  t.equal(await makeApproverGitHub('tok', recorder({ 'orgs/acme/teams/pay/memberships/u': '{"state":"active"}' }).run).isTeamMember('acme', 'pay', 'u'), true)
  t.equal(await makeApproverGitHub('tok', recorder({ 'orgs/acme/teams/pay/memberships/u': '{"state":"pending"}' }).run).isTeamMember('acme', 'pay', 'u'), false)
  t.equal(await makeApproverGitHub('tok', recorder({ 'orgs/acme/teams/pay/memberships/u': httpError(404) }).run).isTeamMember('acme', 'pay', 'u'), false)
  t.end()
})

// reviews() must follow GraphQL pagination. A PR with more than 100 opinionated reviewers would
// otherwise lose an eligible owner approval on page two and under-predict eligibility.
test('reviews follows pageInfo across pages', async t => {
  const pages = [
    { nodes: [{ author: { login: 'a' }, state: 'COMMENTED', submittedAt: '2026-11-17T08:00:00Z' }], pageInfo: { hasNextPage: true, endCursor: 'c1' } },
    { nodes: [{ author: { login: 'owner' }, state: 'APPROVED', submittedAt: '2026-11-17T09:00:00Z' }], pageInfo: { hasNextPage: false, endCursor: null } },
  ]
  const afters: unknown[] = []
  const gh = makeApproverGitHub('tok', async (_args, opts) => {
    const body = JSON.parse(opts?.input ?? '{}')
    afters.push(body.variables.after)
    const page = pages[afters.length - 1]
    return JSON.stringify({ data: { repository: { pullRequest: { latestOpinionatedReviews: page } } } })
  })
  const reviews = await gh.reviews(pr)
  t.deepEqual(afters, [null, 'c1'], 'second request carries the first page cursor')
  t.deepEqual(reviews.map(r => r.login), ['a', 'owner'], 'the page-two approval is returned')
  t.end()
})

// Only added and context lines on the new side can carry an inline comment. Deleted lines and
// lines outside every hunk must fall back to the review body.
test('parsePatchLines returns RIGHT-side added and context lines', t => {
  const patch = ['@@ -1,3 +1,4 @@', ' keep', '-gone', '+new1', '+new2', ' tail', '@@ -20,2 +21,1 @@', '-x', ' y'].join('\n')
  t.deepEqual([...parsePatchLines(patch)].sort((a, b) => a - b), [1, 2, 3, 4, 21])
  t.deepEqual([...parsePatchLines('')], [], 'a binary or empty patch has no commentable lines')
  t.end()
})

// The latest-push record must be for the current head. The activity API can lag, and a stale
// record would misjudge require_last_push_approval (Review Focus 4). The fetch layer compares
// afterSha with the head; this test pins that the field is populated.
test('latestPush returns actor, time and after-SHA of the newest push', async t => {
  const { calls, run } = recorder({
    'repos/o/r/activity?ref=refs%2Fheads%2Ffeat%2Fx&activity_type=push&per_page=1':
      '[{"actor":{"login":"dev"},"timestamp":"2026-11-17T10:00:00Z","after":"c0ffee"}]',
  })
  const push = await makeApproverGitHub('tok', run).latestPush(pr, 'feat/x')
  t.deepEqual(push, { actor: 'dev', at: '2026-11-17T10:00:00Z', afterSha: 'c0ffee' })
  t.ok(calls[0].args.includes('repos/o/r/activity?ref=refs%2Fheads%2Ffeat%2Fx&activity_type=push&per_page=1'))
  t.end()
})
