import test from 'tape'
import type { EngineName } from './config'
import type { Engine, EngineRunInput, EngineRunOutcome } from './engine'
import { runEngines, type ScheduleInput } from './engine-schedule'
import type { EnginePrResult } from './schema'

const SHA = '9'.repeat(40)
const pr = (n: number) => ({ ref: { owner: 'o', repo: 'r', number: n, url: `https://github.com/o/r/pull/${n}` }, pinnedSha: SHA })
const input: ScheduleInput = { prs: [pr(1), pr(2)], instructions: '', runId: 'C1-1', worktreeRoot: '/wt' }

function result(n: number, verdict: EnginePrResult['verdict']): EnginePrResult {
  const findings = verdict === 'findings' ? [{ severity: 'blocking' as const, file: '', line: 0, body: 'bug' }] : []
  return { url: `https://github.com/o/r/pull/${n}`, reviewedSha: SHA, verdict, findings, summary: '', environmentProblems: [] }
}

/** A fake engine that records its inputs and answers from a per-PR verdict table. */
function fakeEngine(name: EngineName, verdicts: Record<number, EnginePrResult['verdict']>, over: Partial<EngineRunOutcome> = {}) {
  const calls: EngineRunInput[] = []
  let release!: () => void
  const gate = new Promise<void>(resolve => (release = resolve))
  const engine: Engine & { calls: EngineRunInput[]; release: () => void; gated: boolean } = {
    name,
    calls,
    release,
    gated: false,
    async run(i) {
      calls.push(i)
      if (engine.gated) await gate
      return { engine: name, results: i.prs.map(p => result(p.ref.number, verdicts[p.ref.number])), usage: { attempts: 1 }, ...over }
    },
  }
  return engine
}

// Parallel starts both engines on every PR before either finishes, each in its own worktree root,
// and reports passes in engine order. Regression caught: a "parallel" run that awaits the first
// engine before starting the second, doubling review time.
test('runEngines in parallel starts both engines at once on every PR', async t => {
  const codex = fakeEngine('codex', { 1: 'clean', 2: 'findings' })
  const claude = fakeEngine('claude', { 1: 'clean', 2: 'clean' })
  codex.gated = true
  const run = runEngines([codex, claude], 'parallel', input)
  await new Promise(resolve => setImmediate(resolve))
  t.equal(claude.calls.length, 1, 'claude started while codex is still running')
  codex.release()
  const out = await run
  t.equal(codex.calls[0].worktreeRoot, '/wt/codex')
  t.equal(claude.calls[0].worktreeRoot, '/wt/claude')
  t.deepEqual(out.passes.get('https://github.com/o/r/pull/2')!.map(p => `${p.engine}:${p.state}`), ['codex:findings', 'claude:clean'])
  t.equal(out.outcomes.length, 2)
  t.end()
})

// Spec 5.8 and the issue 61 acceptance: a mixed request in serial mode. Codex finds a defect in
// PR 1 and is clean on PR 2, so Claude reviews only PR 2, and PR 1 records Claude as skipped.
// Regression caught: one PR's defect denying another PR its second review.
test('runEngines in serial mode decides per PR', async t => {
  const codex = fakeEngine('codex', { 1: 'findings', 2: 'clean' })
  const claude = fakeEngine('claude', { 2: 'clean' })
  const out = await runEngines([codex, claude], 'serial', input)
  t.deepEqual(claude.calls[0].prs.map(p => p.ref.number), [2], 'claude reviews only the PR codex passed')
  const pr1 = out.passes.get('https://github.com/o/r/pull/1')!
  t.deepEqual(pr1.map(p => p.state), ['findings', 'skipped'])
  t.equal(pr1[1].detail, 'skipped (Codex not clean)')
  t.deepEqual(out.passes.get('https://github.com/o/r/pull/2')!.map(p => p.state), ['clean', 'clean'])
  t.end()
})

// When no PR is left for the next engine, it is not spawned at all (spec 5.8).
test('runEngines in serial mode does not spawn an engine with nothing to review', async t => {
  const codex = fakeEngine('codex', {}, { results: [], error: 'Codex run exceeded the 180 minute timeout' })
  const claude = fakeEngine('claude', {})
  const out = await runEngines([codex, claude], 'serial', input)
  t.equal(claude.calls.length, 0)
  t.equal(out.outcomes.length, 1)
  t.deepEqual(out.passes.get('https://github.com/o/r/pull/1')!.map(p => p.state), ['invalid', 'skipped'])
  t.end()
})

// ENGINE_ORDER decides who goes first in serial mode.
test('runEngines in serial mode follows the given engine order', async t => {
  const codex = fakeEngine('codex', { 1: 'clean', 2: 'clean' })
  const claude = fakeEngine('claude', { 1: 'blocked', 2: 'clean' })
  const out = await runEngines([claude, codex], 'serial', input)
  t.deepEqual(codex.calls[0].prs.map(p => p.ref.number), [2])
  t.deepEqual(out.passes.get('https://github.com/o/r/pull/1')!.map(p => p.detail), ['blocked: no reason given', 'skipped (Claude not clean)'])
  t.end()
})
