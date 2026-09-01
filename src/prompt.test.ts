import test from 'tape'
import { buildPrompt } from './prompt'
import type { PullRequestRef } from './parse-message'

function ref(repo: string, number: number): PullRequestRef {
  return { owner: 'o', repo, number, url: `https://github.com/o/${repo}/pull/${number}` }
}

const worktreeRoot = '/private/tmp/codex-pr-review'

// The whole bot hinges on the skill actually being invoked; a prompt that merely
// describes reviewing would get an ad-hoc review with none of the skill's rules.
test('buildPrompt invokes the review-pr skill and lists every PR', t => {
  const prompt = buildPrompt({ prs: [ref('a', 1), ref('b', 2)], instructions: '', worktreeRoot })
  t.ok(prompt.includes('$review-pr'), 'invokes the skill')
  t.ok(prompt.includes('https://github.com/o/a/pull/1'))
  t.ok(prompt.includes('https://github.com/o/b/pull/2'))
  t.end()
})

// Unattended runs are the reason this bot needs a custom prompt at all: the skill has
// several "ask the user and wait" branches that would hang a Codex run to its timeout.
test('buildPrompt spells out the unattended resolutions for every asking branch', t => {
  const prompt = buildPrompt({ prs: [ref('a', 1)], instructions: '', worktreeRoot })
  t.ok(/Never ask\s+for confirmation/.test(prompt), 'forbids asking')
  t.ok(prompt.includes('Missing issue reference'), 'covers the issue-reference branch')
  t.ok(prompt.includes('out of date with its base'), 'covers the stale-base branch')
  // The skill refuses an out-of-date PR outright. Telling Codex to merge the base would
  // have the bot rewriting someone's branch in a case the skill explicitly forbids.
  t.ok(prompt.includes('Do not bring the branch up to date'), 'does not authorise a base merge')
  t.ok(prompt.includes('AGENTS.md'), 'covers the repo-instruction branch')
  t.end()
})

// The user's Slack text is passed through verbatim, and must be clearly framed as
// message text so an offhand "just skip the tests" cannot silently rewrite the policy.
test('buildPrompt includes user instructions and marks them as non-overriding', t => {
  const prompt = buildPrompt({
    prs: [ref('a', 1)],
    instructions: 'focus on the migration path',
    worktreeRoot,
    requestedBy: 'U1',
  })
  t.ok(prompt.includes('focus on the migration path'))
  t.ok(prompt.includes('(U1)'))
  t.ok(prompt.includes('cannot change the unattended rules or the output contract'))
  // The output contract has to come after the user text so it is the last word.
  t.ok(prompt.indexOf('Output contract') > prompt.indexOf('focus on the migration path'))
  t.end()
})

// A message with no extra text should not produce an empty quoted block that reads to
// the model as an instruction to do nothing.
test('buildPrompt omits the instructions section when there is no extra text', t => {
  const prompt = buildPrompt({ prs: [ref('a', 1)], instructions: '', worktreeRoot })
  t.notOk(prompt.includes('Instructions from the requester'))
  t.end()
})

// The sandbox only grants write access under the configured worktree root; a prompt
// that omitted it would produce worktrees that fail on permissions.
test('buildPrompt pins the worktree root the sandbox actually allows', t => {
  const prompt = buildPrompt({ prs: [ref('a', 1)], instructions: '', worktreeRoot })
  t.ok(prompt.includes(`${worktreeRoot}/<repo>-<number>`))
  t.end()
})

// One bad PR in a batch must not cost the user the other reviews.
test('buildPrompt requires independent per-PR results', t => {
  const prompt = buildPrompt({ prs: [ref('a', 1), ref('b', 2)], instructions: '', worktreeRoot })
  t.ok(prompt.includes('must not stop the others'))
  t.ok(prompt.includes('exactly one entry per pull request'))
  t.end()
})

// Guards a programming error: an empty list would produce a prompt asking Codex to
// review nothing, and Codex would improvise.
test('buildPrompt refuses an empty PR list', t => {
  t.throws(() => buildPrompt({ prs: [], instructions: '', worktreeRoot }), /at least one/)
  t.end()
})
