import test from 'tape'
import { runJob, type JobDeps, type JobEmoji, type ReviewRequest } from './job'
import type { PullRequestResult, ReviewRunResult } from './schema'

const emoji: JobEmoji = {
  ack: 'eyes',
  queued: 'hourglass_flowing_sand',
  pass: 'approved_stamp',
  findings: 'comments',
  error: 'warning',
  humanReview: 'raising_hand',
  removeAckOnComplete: false,
}

const request: ReviewRequest = {
  message: { channel: 'C1', ts: '1.1' },
  prs: [{ owner: 'o', repo: 'r', number: 1, url: 'https://github.com/o/r/pull/1' }],
  instructions: '',
}

interface Recorder {
  deps: JobDeps
  added: string[]
  removed: string[]
  threads: string[]
}

function recorder(
  runReview: (request: ReviewRequest) => Promise<ReviewRunResult>,
  overrides: Partial<JobDeps> = {}
): Recorder {
  const added: string[] = []
  const removed: string[] = []
  const threads: string[] = []
  const deps: JobDeps = {
    async addReaction(_m, name) { added.push(name) },
    async removeReaction(_m, name) { removed.push(name) },
    async postThreadReply(_m, text) { threads.push(text) },
    runReview,
    log() {},
    ...overrides,
  }
  return { deps, added, removed, threads }
}

function result(...results: PullRequestResult[]): ReviewRunResult {
  return { results }
}

function pr(status: PullRequestResult['status'], summary = ''): PullRequestResult {
  return { url: 'https://github.com/o/r/pull/1', status, summary, pushedTestCommits: false, reviewUrl: '' }
}

// The specified happy path: ack immediately, then stamp approval with no thread noise.
test('runJob reacts eyes then approved_stamp and posts no thread when all PRs pass', async t => {
  const rec = recorder(async () => result(pr('passed')))
  const outcome = await runJob(request, emoji, rec.deps)
  t.equal(outcome, 'pass')
  t.deepEqual(rec.added, ['eyes', 'approved_stamp'], 'ack precedes the verdict')
  t.deepEqual(rec.threads, [], 'a clean review stays out of the thread')
  t.end()
})

// The specified findings path: the reaction is the channel-level signal, the thread
// carries the per-PR detail.
test('runJob reacts comments and posts a thread when a PR has findings', async t => {
  const rec = recorder(async () => result(pr('findings', 'Retry loop double-counts failures.')))
  const outcome = await runJob(request, emoji, rec.deps)
  t.equal(outcome, 'findings')
  t.deepEqual(rec.added, ['eyes', 'comments'])
  t.equal(rec.threads.length, 1)
  t.ok(rec.threads[0].includes('Retry loop double-counts failures.'))
  t.end()
})

// A blocked PR was never actually reviewed, so it must not earn the approval stamp.
test('runJob treats a blocked PR as findings', async t => {
  const rec = recorder(async () => result(pr('blocked', 'Base branch will not merge cleanly.')))
  t.equal(await runJob(request, emoji, rec.deps), 'findings')
  t.deepEqual(rec.added, ['eyes', 'comments'])
  t.ok(rec.threads[0].includes('Not reviewed'))
  t.end()
})

// A crashed run must never look like a pass. Without an explicit error path the user
// sees a lone :eyes: forever and cannot tell a slow review from a dead one.
test('runJob reacts warning and explains when the review run fails', async t => {
  const rec = recorder(async () => { throw new Error('Codex produced no final message') })
  const outcome = await runJob(request, emoji, rec.deps)
  t.equal(outcome, 'error')
  t.deepEqual(rec.added, ['eyes', 'warning'])
  t.ok(rec.threads[0].includes('*not* reviewed'))
  t.ok(rec.threads[0].includes('Codex produced no final message'))
  t.end()
})

// The reaction is a status surface, not a precondition. A workspace that has not
// installed :approved_stamp: (reactions.add -> invalid_name) must not cost the user the
// review they already paid for.
test('runJob still reviews and reports when reacting fails', async t => {
  let reviewed = false
  const rec = recorder(
    async () => { reviewed = true; return result(pr('findings', 'Bug.')) },
    { async addReaction() { throw new Error('invalid_name') } }
  )
  const outcome = await runJob(request, emoji, rec.deps)
  t.equal(reviewed, true, 'review still ran after the ack reaction failed')
  t.equal(outcome, 'findings')
  t.equal(rec.threads.length, 1, 'thread still posted after the verdict reaction failed')
  t.end()
})

// Losing the thread post should not also lose the reaction; ordering the reaction first
// is what guarantees the channel still shows an outcome.
test('runJob keeps the findings reaction when the thread post fails', async t => {
  const rec = recorder(
    async () => result(pr('findings', 'Bug.')),
    { async postThreadReply() { throw new Error('channel_not_found') } }
  )
  t.equal(await runJob(request, emoji, rec.deps), 'findings')
  t.deepEqual(rec.added, ['eyes', 'comments'])
  t.end()
})

test('runJob removes the ack reaction when configured to', async t => {
  const rec = recorder(async () => result(pr('passed')))
  await runJob(request, { ...emoji, removeAckOnComplete: true }, rec.deps)
  t.deepEqual(rec.removed, ['eyes'])
  t.deepEqual(rec.added, ['eyes', 'approved_stamp'])
  t.end()
})

// A message that waited for a slot wears the queued reaction until its run starts. The job
// must take it off — after the ack is on — or the message ends up with two status reactions,
// one of them claiming it is still waiting.
test('runJob swaps the queued reaction for the ack when told the message waited', async t => {
  const rec = recorder(async () => result(pr('passed')))
  await runJob(request, emoji, rec.deps, { queued: true })
  t.deepEqual(rec.added, ['eyes', 'approved_stamp'])
  t.deepEqual(rec.removed, ['hourglass_flowing_sand'], 'the queued reaction comes off once the ack is on')
  t.end()
})

// The dispatcher only reports `queued` when its reaction actually landed. A job that removed
// it regardless would log a spurious no_reaction failure on every review that did not wait.
test('runJob leaves reactions alone when the message never waited', async t => {
  const rec = recorder(async () => result(pr('passed')))
  await runJob(request, emoji, rec.deps)
  t.deepEqual(rec.removed, [], 'nothing to remove for a message that started at once')
  t.end()
})

// Removing the queued reaction is a status nicety, not a precondition. Slack rejecting it
// (no_reaction, say, because a human already removed it) must not cost the review.
test('runJob still reviews when removing the queued reaction fails', async t => {
  let reviewed = false
  const rec = recorder(
    async () => { reviewed = true; return result(pr('passed')) },
    { async removeReaction() { throw new Error('no_reaction') } }
  )
  const outcome = await runJob(request, emoji, rec.deps, { queued: true })
  t.equal(reviewed, true)
  t.equal(outcome, 'pass')
  t.end()
})

// --- Deleted-message guard: a request can sit in the queue for hours before a slot frees. ---

// A message deleted while it waited must not be reviewed: no 20-minute run, no thread posted
// onto a message nobody can see. The job settles as 'skipped', distinct from an error.
test('runJob skips a review when the triggering message no longer exists', async t => {
  let reviewed = false
  const events: string[] = []
  const rec = recorder(
    async () => {
      reviewed = true
      return result(pr('passed'))
    },
    { async messageExists() { return false }, log: (e: string) => events.push(e) }
  )

  const outcome = await runJob(request, emoji, rec.deps)
  t.equal(outcome, 'skipped', 'a deleted message is skipped, not reviewed')
  t.notOk(reviewed, 'the review never ran')
  t.deepEqual(rec.added, [], 'a gone message gets no reactions')
  t.deepEqual(rec.threads, [], 'and no thread')
  t.ok(events.includes('review.aborted'), 'the skip is logged')
  t.notOk(events.includes('review.start'), 'the run was never announced as started')
  t.end()
})

// The ordinary case: a message that still exists is reviewed exactly as before the guard.
test('runJob reviews normally when the message still exists', async t => {
  const rec = recorder(async () => result(pr('passed')), { async messageExists() { return true } })
  const outcome = await runJob(request, emoji, rec.deps)
  t.equal(outcome, 'pass')
  t.deepEqual(rec.added, ['eyes', 'approved_stamp'], 'the review proceeded')
  t.end()
})

// Fail-open: a transient Slack error on the existence check is no reason to silently drop a
// real request. Reviewing an occasionally-already-gone message is the lesser harm.
test('runJob reviews anyway when the existence check itself fails', async t => {
  const events: string[] = []
  const rec = recorder(async () => result(pr('passed')), {
    async messageExists() { throw new Error('slack down') },
    log: (e: string) => events.push(e),
  })
  const outcome = await runJob(request, emoji, rec.deps)
  t.equal(outcome, 'pass', 'a failed check does not block the review')
  t.ok(events.includes('review.exists.failed'), 'the failed check is logged')
  t.end()
})

// --- Human-review gate: deployments PRs that touch values.yaml are handed to a person. ---

const deployRequest: ReviewRequest = {
  message: { channel: 'C1', ts: '2.2' },
  prs: [
    { owner: 'trade-platform', repo: 'deployments', number: 5, url: 'https://github.com/trade-platform/deployments/pull/5' },
  ],
  instructions: '',
}

// The core rule: a deployments values.yaml change is not reviewed, is commented on, and is
// flagged in the channel — the developer must not be left thinking the bot is merely slow.
test('runJob hands a deployments values.yaml PR to a human and comments', async t => {
  let reviewed = false
  const comments: Array<{ url: string; body: string }> = []
  const events: string[] = []
  const rec = recorder(
    async () => {
      reviewed = true
      return result(pr('passed'))
    },
    {
      async listChangedFiles() { return ['values.yaml', 'README.md'] },
      async postPrComment(p, body) { comments.push({ url: p.url, body }) },
      log: (e: string) => events.push(e),
    }
  )

  const outcome = await runJob(deployRequest, emoji, rec.deps)
  t.equal(outcome, 'skipped', 'the request is skipped, not reviewed')
  t.notOk(reviewed, 'the bot never ran the review')
  t.equal(comments.length, 1, 'it commented on the PR')
  t.ok(/human review is required/i.test(comments[0].body), 'the comment says a human is needed')
  t.ok(rec.added.includes('raising_hand'), 'the human-review reaction is added')
  t.ok(events.includes('review.human-required'), 'and it is logged')
  t.end()
})

// A deployments PR that does not touch a values file is still the bot's to review.
test('runJob reviews a deployments PR that does not touch values.yaml', async t => {
  let reviewed = false
  const comments: unknown[] = []
  const rec = recorder(
    async () => {
      reviewed = true
      return result(pr('passed'))
    },
    {
      async listChangedFiles() { return ['README.md', 'chart/templates/deployment.yaml'] },
      async postPrComment() { comments.push(1) },
    }
  )
  const outcome = await runJob(deployRequest, emoji, rec.deps)
  t.equal(outcome, 'pass', 'reviewed normally')
  t.ok(reviewed, 'the review ran')
  t.equal(comments.length, 0, 'no gate comment')
  t.end()
})

// The gate must not add a GitHub call for the common case: a PR outside the deployments repo is
// passed straight through without its files being listed.
test('runJob does not inspect files for a non-deployments PR', async t => {
  let listed = false
  const rec = recorder(async () => result(pr('passed')), {
    async listChangedFiles() { listed = true; return [] },
  })
  const outcome = await runJob(request, emoji, rec.deps) // request is repo "r"
  t.equal(outcome, 'pass')
  t.notOk(listed, 'a non-deployments PR is not inspected')
  t.end()
})

// Fail safe: if the files of a deployments PR cannot be listed, it is handed to a human rather
// than reviewed on a guess — the sensitive repo errs toward caution.
test('runJob hands a deployments PR to a human when its files cannot be listed', async t => {
  let reviewed = false
  const comments: Array<{ body: string }> = []
  const events: string[] = []
  const rec = recorder(
    async () => {
      reviewed = true
      return result(pr('passed'))
    },
    {
      async listChangedFiles() { throw new Error('gh unavailable') },
      async postPrComment(_p, body) { comments.push({ body }) },
      log: (e: string) => events.push(e),
    }
  )
  const outcome = await runJob(deployRequest, emoji, rec.deps)
  t.equal(outcome, 'skipped', 'not reviewed on a guess')
  t.notOk(reviewed)
  t.equal(comments.length, 1, 'still comments')
  t.ok(events.includes('gate.list-files.failed'), 'the failure is logged')
  t.end()
})

// A mixed request: the gated deployments PR is set aside and commented on, while the other PR
// is reviewed — the review runs on only the reviewable PRs.
test('runJob reviews the other PRs when one is gated', async t => {
  const mixed: ReviewRequest = {
    message: { channel: 'C1', ts: '3.3' },
    prs: [
      { owner: 'trade-platform', repo: 'deployments', number: 5, url: 'https://github.com/trade-platform/deployments/pull/5' },
      { owner: 'o', repo: 'r', number: 1, url: 'https://github.com/o/r/pull/1' },
    ],
    instructions: '',
  }
  let reviewedUrls: string[] = []
  const comments: Array<{ url: string }> = []
  const rec = recorder(
    async req => {
      reviewedUrls = req.prs.map(p => p.url)
      return result(pr('passed'))
    },
    {
      async listChangedFiles(p) { return p.repo === 'deployments' ? ['values.yaml'] : [] },
      async postPrComment(p) { comments.push({ url: p.url }) },
    }
  )
  const outcome = await runJob(mixed, emoji, rec.deps)
  t.equal(outcome, 'pass', 'the reviewable PR was reviewed')
  t.deepEqual(reviewedUrls, ['https://github.com/o/r/pull/1'], 'only the non-gated PR reached the review')
  t.deepEqual(comments, [{ url: 'https://github.com/trade-platform/deployments/pull/5' }], 'the gated PR was commented on')
  t.end()
})

// Without a GitHub client (the CLI case) the gate is inert and a deployments PR is reviewed as
// before — the guard lives in the daemon, which wires the client.
test('runJob leaves the gate inert when no GitHub client is wired', async t => {
  let reviewed = false
  const rec = recorder(async () => {
    reviewed = true
    return result(pr('passed'))
  })
  const outcome = await runJob(deployRequest, emoji, rec.deps)
  t.equal(outcome, 'pass', 'reviewed, since the gate needs a GitHub client')
  t.ok(reviewed)
  t.end()
})
