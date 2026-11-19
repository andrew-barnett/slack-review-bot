import test from 'tape'
import { ClaudeRunError } from '../claude'
import { CodexOutputError, CodexStalledError, type CodexRunOptions } from '../codex'
import { loadReviewConfig } from '../config'
import { makeCodexEngine } from '../engine'
import type { SubmitHooks } from './broker'
import type { JobKind, WireRunOptions } from './protocol'
import { CLAIMED_LINE, makeRemoteRunners, WAITING_LINE } from './remote'

const URL1 = 'https://github.com/o/r/pull/1'
const SHA = 'c'.repeat(40)
const clean = { results: [{ url: URL1, reviewedSha: SHA, verdict: 'clean', findings: [], summary: '', environmentProblems: [] }] }
const codexOptions: CodexRunOptions = {
  prompt: 'p',
  codexBin: 'codex',
  profile: 'review-bot',
  workspaceRoot: '/work/src',
  worktreeRoot: '/work/wt/codex',
  timeoutMs: 1000,
  stallTimeoutMs: 500,
  disableGitSigning: true,
  engineGhToken: 'engine-placeholder',
  runId: 'C1-11.codex',
}

/** A fake broker that records submissions and answers from a script of outcomes or errors. */
function fakeBroker(script: (Error | unknown)[]) {
  const calls: { kind: JobKind; options: WireRunOptions; hooks?: SubmitHooks }[] = []
  return {
    calls,
    submit: async (kind: JobKind, options: WireRunOptions, hooks?: SubmitHooks) => {
      calls.push({ kind, options, hooks })
      hooks?.onClaimed?.()
      const next = script.shift()
      if (next instanceof Error) throw next
      return next
    },
  }
}

// The remote function must submit the codex job kind with only the wire fields, announce that it is
// waiting for a worker, and return the local outcome shape. Regression caught: the engine token or a
// Bedrock credential riding along in the job options.
test('remote runCodex submits a codex-report-only job with only the wire fields', async t => {
  const broker = fakeBroker([{ result: clean, tokensUsed: 10, activeMs: 20, rawFinalMessage: 'ignored' }])
  const lines: string[] = []
  const out = await makeRemoteRunners(broker).runCodex({ ...codexOptions, onProgress: line => lines.push(line) })
  t.equal(broker.calls[0].kind, 'codex-report-only')
  t.deepEqual(Object.keys(broker.calls[0].options).sort(), ['prompt', 'runId', 'stallTimeoutMs', 'timeoutMs', 'worktreeRoot'])
  t.deepEqual(lines, [WAITING_LINE, CLAIMED_LINE])
  t.deepEqual(out.result, clean)
  t.equal(out.tokensUsed, 10)
  t.equal(out.activeMs, 20)
  t.equal(out.rawFinalMessage, '', 'the raw final message never crosses the wire')
  t.end()
})

// Review Focus 3: the result body is attacker-controlled. Anything that is not a valid v2 result must
// become the engine's output error (an invalid pass), never a crash and never a clean pass.
test('remote runCodex turns a malformed outcome into CodexOutputError', async t => {
  const hostile = [null, 'text', {}, { result: { results: 'no' } }, { result: { results: [{ url: URL1, verdict: 'clean' }] } }]
  for (const raw of hostile) {
    try {
      await makeRemoteRunners(fakeBroker([raw])).runCodex(codexOptions)
      t.fail(`accepted ${JSON.stringify(raw)}`)
    } catch (error) {
      t.ok(error instanceof CodexOutputError, `rejected ${JSON.stringify(raw)}`)
    }
  }
  t.end()
})

// Usage numbers from a worker feed the status totals; negative or NaN values must be clamped, and
// Claude's token total recomputed from the breakdown rather than trusted.
test('remote runClaude normalizes hostile usage numbers', async t => {
  const usage = { inputTokens: 5, outputTokens: -3, cacheReadTokens: Number.NaN, cacheWriteTokens: 1, costUsd: 'x', numTurns: 2, durationMs: 1 }
  const broker = fakeBroker([{ result: clean, usage, tokensUsed: 999999, activeMs: -1, permissionDenials: 2.5 }])
  const out = await makeRemoteRunners(broker).runClaude({ ...codexOptions, claudeBin: 'claude', configDir: '/c', engineGhToken: 'e' })
  t.equal(broker.calls[0].kind, 'claude-review')
  t.deepEqual(out.usage, { inputTokens: 5, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 1, costUsd: 0, numTurns: 2, durationMs: 1 })
  t.equal(out.tokensUsed, 6, 'recomputed from the breakdown')
  t.equal(out.activeMs, 0)
  t.equal(out.permissionDenials, 2)
  try {
    await makeRemoteRunners(fakeBroker([{ usage }])).runClaude({ ...codexOptions, claudeBin: 'claude', configDir: '/c', engineGhToken: 'e' })
    t.fail('accepted a missing result')
  } catch (error) {
    t.ok(error instanceof ClaudeRunError && error.kind === 'output')
  }
  t.end()
})

// Spec D1: retries, scheduling and the gate stay in the orchestrator unchanged. A stall from a worker
// must make the Codex engine retry with a fresh job (a fresh container), exactly as a local stall does.
test('a remote stall makes the Codex engine retry with a new job', async t => {
  const stalled = new CodexStalledError('stalled', 600_000, { activeMs: 5, wallMs: 5, frozenMs: 0 })
  const broker = fakeBroker([stalled, { result: clean, tokensUsed: 1, activeMs: 2 }])
  const config = { ...loadReviewConfig({ HOME: '/home/bot' }), stallBackoffMs: [1000, 2000] }
  const engine = makeCodexEngine(config, { runCodex: makeRemoteRunners(broker).runCodex })
  const outcome = await engine.run({ prs: [{ ref: { owner: 'o', repo: 'r', number: 1, url: URL1 }, pinnedSha: SHA }], instructions: '', worktreeRoot: '/work/wt/codex', runId: 'C1-11' })
  t.equal(broker.calls.length, 2, 'two jobs: the retry ran in a fresh worker')
  t.deepEqual(broker.calls.map(c => c.options.stallTimeoutMs), [1000, 2000], 'the escalating stall schedule crosses the wire')
  t.deepEqual(broker.calls.map(c => c.options.runId), ['C1-11.codex', 'C1-11.codex.retry1'])
  t.equal(outcome.usage.attempts, 2)
  t.equal(outcome.error, undefined)
  t.end()
})
