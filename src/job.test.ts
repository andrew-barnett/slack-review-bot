import test from 'tape'
import { runJob, type JobDeps, type JobEmoji, type ReviewRequest } from './job'
import type { PullRequestResult, ReviewRunResult } from './schema'

const emoji: JobEmoji = {
  ack: 'eyes',
  queued: 'hourglass_flowing_sand',
  pass: 'approved_stamp',
  findings: 'comments',
  error: 'warning',
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
