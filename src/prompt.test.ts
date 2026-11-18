import test from 'tape'
import { buildPrompt, buildReportOnlyPrompt, skillInvocation } from './prompt'
import { AGENT_NO_MENTION_NOTE } from './agent-note'
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
  // Since 2026-08-19 the skill auto-merges a conflict-free stale base rather than refusing.
  // The bot must defer to that "Automatic Base Merge" section, not force a block — a
  // regression to the old "Do not bring the branch up to date" wording would leave every
  // out-of-date PR stuck as `blocked` even when the base merges cleanly.
  t.ok(prompt.includes('Automatic Base Merge'), 'defers to the skill clean auto-merge')
  t.notOk(prompt.includes('Do not bring the branch up to date'), 'does not suppress the base merge')
  // The bot normally supplies commit.gpgsign=false so test-only commits can be pushed without
  // a signing key. A base merge is different: the review skill requires it to stop rather than
  // bypass signing, so this prompt must restore signing for that one command.
  t.ok(prompt.includes('commit.gpgsign=true'), 'does not push an unsigned automatic base merge')
  // The conflict case is the one that must still block, so the reviewer never rewrites
  // someone's branch with a merge that would need manual resolution.
  t.ok(prompt.includes('not** conflict-free') || prompt.includes('not conflict-free'),
    'still blocks when the base merge would conflict')
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

// Issue #46: the worktree path is deterministic and reused across runs/retries, so a prior
// run killed mid-install leaves a partial node_modules there. The prompt must tell the review
// to inspect that path and start from a clean directory, or the next install fails with ENOTEMPTY.
// (The removal is guarded — see the safeguards test below.)
test('buildPrompt tells the review to start from a clean worktree path', t => {
  const prompt = buildPrompt({ prs: [ref('a', 1)], instructions: '', worktreeRoot })
  t.ok(prompt.includes('Start clean'), 'instructs a clean start')
  t.ok(prompt.includes('inspect whatever is already at'), 'inspects the reused path before recreating it')
  t.ok(prompt.includes('ENOTEMPTY'), 'names the failure the stale state causes')
  t.end()
})

// The guard keys destruction on unpushed COMMITS, not on a dirty working tree. review.ts makes
// every attempt a fresh run in a fresh worktree that redoes the review from scratch, so uncommitted
// changes in a reused checkout are abandoned scratch the next run regenerates — not work to lose.
// The one thing a reused checkout can hold that is NOT reproducible is a commit made but not pushed.
test('buildPrompt removes a reused worktree only when it has no unpushed commits', t => {
  const prompt = buildPrompt({ prs: [ref('a', 1)], instructions: '', worktreeRoot })
  t.ok(prompt.includes('remove or replace it when it is a Codex-created review checkout for the same PR with no unpushed commits'))
  t.ok(prompt.includes('Preserve it only when it carries an unpushed commit'), 'an unpushed commit is the one preserve case')
  t.end()
})

// Regression: an install (`npm ci`/`pnpm install`) routinely regenerates tracked files — e.g.
// aix-ui's libs/ui-shared/src/lib/pdf-worker-path.ts — leaving the reused worktree dirty. The old
// guard ("no unpushed changes") read that dirty tree as unsafe and refused to recreate the checkout,
// so a re-review was reported `blocked` for pure install debris. The prompt must say a dirty /
// install-regenerated working tree does not block recreating the checkout.
test('buildPrompt does not let an install-regenerated working tree block recreating the worktree', t => {
  const prompt = buildPrompt({ prs: [ref('a', 1)], instructions: '', worktreeRoot })
  t.ok(prompt.includes('a dirty or install-regenerated working tree does not block this'), 'a dirty tree must not block recreation')
  t.end()
})

// The findings/approval comments are posted by Codex via the skill, not by the bot, so the only
// control surface is the prompt: it must carry the hidden no-mention note verbatim and tell the
// run to append it to every GitHub comment. A regression here reintroduces the spurious
// @-mentions of the borrowed-token author on everyone else's PRs.
test('buildPrompt tells the run to append the hidden no-mention note to every GitHub comment', t => {
  const prompt = buildPrompt({ prs: [ref('a', 1)], instructions: '', worktreeRoot })
  t.ok(prompt.includes(AGENT_NO_MENTION_NOTE), 'embeds the exact note block')
  t.ok(/append[\s\S]*every[\s\S]*comment you\s+post to GitHub/i.test(prompt), 'instructs appending to every comment')
  // The note must stay before the output contract so the contract remains the prompt's last word.
  t.ok(prompt.indexOf(AGENT_NO_MENTION_NOTE) < prompt.indexOf('Output contract'), 'note precedes the output contract')
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

// Regression: the bot was recording `blocked` for repos whose CLAUDE.md merely shapes
// the environment (integration tests that need live services, "never read decrypted
// files"), refusing reviews it could have completed. The unattended resolution must
// default to honoring such a constraint and reviewing whatever can still be evaluated —
// e.g. skip only the un-runnable suites and review the diff with the rest.
test('buildPrompt tells an unattended run to honor environment-shaping constraints and still review', t => {
  const prompt = buildPrompt({ prs: [ref('a', 1)], instructions: '', worktreeRoot })
  t.ok(prompt.includes('honor the constraint and complete the review'), 'default is complete-while-honoring')
  t.ok(prompt.includes('run the tests that can run'), 'reviews with the runnable tests instead of blocking on a suite it cannot run')
  t.ok(prompt.includes('Bias toward completing the review'), 'states the completion bias explicitly')
  t.end()
})

// The `blocked` state must be reserved for instructions that would make the review
// unsound or subvert it (approve-without-review, suppress findings) — not the routine
// operating guidance almost every repo carries. This catches a regression back to the
// old "any material change is fatal" behavior.
test('buildPrompt blocks only on review-subverting instructions, not constraints it can honor', t => {
  const prompt = buildPrompt({ prs: [ref('a', 1)], instructions: '', worktreeRoot })
  t.ok(prompt.includes('unsound or subvert'), 'names the subversion test for blocking')
  t.ok(prompt.includes('suppress or soften findings'), 'gives a concrete review-subverting example')
  t.end()
})

const SHA1 = '1'.repeat(40)
const SHA2 = '2'.repeat(40)
function reportOnly(engine: 'codex' | 'claude', instructions = '') {
  return buildReportOnlyPrompt({
    engine,
    prs: [{ ref: ref('a', 1), pinnedSha: SHA1 }, { ref: ref('b', 2), pinnedSha: SHA2 }],
    instructions,
    worktreeRoot: `${worktreeRoot}/${engine}`,
  })
}

// review-pr turns report-only mode on only for the exact phrase plus a pinned SHA per PR
// (aqua-skills PR 197). Regression caught: a paraphrase that silently runs the normal, writing
// workflow, which pushes and approves with whatever credential it has.
test('buildReportOnlyPrompt invokes report-only mode with a pinned SHA per PR', t => {
  const prompt = reportOnly('codex')
  t.ok(prompt.startsWith('$review-pr'), 'Codex invokes the skill with $')
  t.ok(prompt.includes('report-only mode'), 'the exact phrase the skill keys on')
  t.ok(prompt.includes(`https://github.com/o/a/pull/1 — pinned SHA \`${SHA1}\``))
  t.ok(prompt.includes(`https://github.com/o/b/pull/2 — pinned SHA \`${SHA2}\``))
  t.ok(prompt.includes('`head moved`') && prompt.includes('`stale base`'), 'both blocked reasons the skill uses')
  t.end()
})

// The daemon owns every GitHub write in dual mode. Any surviving instruction to push, merge, sign,
// post the no-mention note or approve would contradict report-only mode. Regression caught: v1
// text leaking into the dual prompt.
test('buildReportOnlyPrompt drops every write instruction from the single-mode prompt', t => {
  const prompt = reportOnly('claude', 'please be thorough')
  for (const banned of ['Sign that merge commit', 'still approve', 'Hidden no-mention note', AGENT_NO_MENTION_NOTE, 'push regression-test\ncommits', 'Automatic Base Merge" section — do not force']) {
    t.notOk(prompt.includes(banned), `does not contain: ${banned.slice(0, 40)}`)
  }
  t.ok(prompt.includes('Push nothing') && prompt.includes('Write nothing to GitHub'))
  t.ok(prompt.includes('please be thorough'), 'requester instructions are kept')
  t.end()
})

// One builder for both engines; only the skill invocation differs (spec 5.6). Regression caught:
// the two engines being given different rules, so one engine's clean means something else.
test('buildReportOnlyPrompt is identical for both engines apart from the invocation', t => {
  const codex = reportOnly('codex').replace(`${worktreeRoot}/codex`, 'ROOT').replace(skillInvocation('codex'), 'INVOKE')
  const claude = reportOnly('claude').replace(`${worktreeRoot}/claude`, 'ROOT').replace(skillInvocation('claude'), 'INVOKE')
  t.equal(codex, claude)
  t.ok(reportOnly('claude').startsWith('Use the `review-pr` skill'), 'Claude names the skill')
  t.end()
})

// Each engine has its own worktree root so parallel runs never share a checkout (spec 5.4).
test('buildReportOnlyPrompt pins the engine-specific worktree root and the output contract', t => {
  const prompt = reportOnly('claude')
  t.ok(prompt.includes(`${worktreeRoot}/claude/<repo>-<number>`))
  t.ok(prompt.includes('environmentProblems') && prompt.includes('Never fold an environment problem into a clean verdict'))
  t.throws(() => buildReportOnlyPrompt({ engine: 'codex', prs: [], instructions: '', worktreeRoot }), /at least one/)
  t.end()
})

// The unattended section and the output contract must agree: a test not run because of the
// environment (services or network the sandbox denies) is an environment problem, which makes the
// pass invalid. Regression caught: the summary telling the engine such tests are "skipped and
// noted", so an engine skips them and returns clean, and the gate approves an untested PR.
test('buildReportOnlyPrompt treats tests not run because of the environment as an environment problem', t => {
  const prompt = reportOnly('codex')
  const flat = prompt.replace(/\s+/g, ' ')
  t.notOk(flat.includes('skipped and noted'), 'no "skipped and noted" escape hatch')
  t.ok(flat.includes('Tests not run because of the environment (suites needing a database, NATS or network the sandbox denies) are an environment problem: list each one in `environmentProblems`, and never return `clean` after skipping them'), 'the unattended section routes them to environmentProblems')
  t.ok(flat.includes('tests NOT RUN because of the environment (an install, toolchain or network failure, or a database, NATS or network the sandbox denies)'), 'the output contract covers sandbox-denied services')
  t.ok(flat.includes('an engine that skipped tests because of the environment must not return `clean`'), 'the output contract forbids clean after skipping')
  t.end()
})
