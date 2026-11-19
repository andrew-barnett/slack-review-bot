import test from 'tape'
import type { Engine, EngineRunInput } from './engine'
import type { GhRunner } from './gh-api'
import type { PullRequestRef } from './parse-message'
import { parseEngineFlag, pinHead, renderReportOnly, reportOnlyExitCode, runReportOnly } from './report-only'

const SHA = 'a'.repeat(40)
const ref: PullRequestRef = { owner: 'o', repo: 'r', number: 7, url: 'https://github.com/o/r/pull/7' }

function engine(name: 'codex' | 'claude', verdict: 'approve' | 'findings', seen: EngineRunInput[]): Engine {
  return {
    name,
    run: async input => {
      seen.push(input)
      return {
        engine: name,
        usage: { attempts: 1, tokensUsed: 10, activeMs: 5 },
        results: input.prs.map(pr => ({
          url: pr.ref.url,
          reviewedSha: pr.pinnedSha,
          verdict,
          summary: verdict === 'approve' ? 'clean' : 'one issue',
          findings:
            verdict === 'approve'
              ? []
              : [{ severity: 'blocking', path: 'src/a.ts', line: 1, title: 'bug', body: 'a real bug', suggestedTest: '' }],
          environmentProblems: [],
          validation: [],
        })),
      } as never
    },
  }
}

// The whole point of the flag: the only GitHub call is the read that pins the head. Regression
// caught: report-only mode quietly reusing the dual runner, which posts and can approve.
test('runReportOnly makes one read-only gh call per PR and hands every engine the pinned head', async t => {
  const calls: string[][] = []
  const gh: GhRunner = async args => {
    calls.push(args)
    return `${SHA}\n`
  }
  const seen: EngineRunInput[] = []
  const report = await runReportOnly(
    { prs: [ref], instructions: '' },
    { gh, engines: [engine('codex', 'approve', seen), engine('claude', 'findings', seen)], worktreeRoot: '/wt', runId: 'cli-1' }
  )
  t.deepEqual(calls, [['api', 'repos/o/r/pulls/7', '--jq', '.head.sha']])
  t.deepEqual(seen.map(s => s.prs[0].pinnedSha), [SHA, SHA], 'both engines review the pinned head')
  t.deepEqual(seen.map(s => s.worktreeRoot), ['/wt/codex', '/wt/claude'], 'each engine gets its own root')
  t.deepEqual(report.prs[0].passes.map(p => p.state), ['clean', 'findings'])
  t.equal(report.usage.tokensUsed, 20)
  t.equal(reportOnlyExitCode(report), 1)
  t.match(renderReportOnly(report), /claude: findings/)
  t.end()
})

// A head that cannot be read must stop the run before any engine starts: an engine reviewing an
// unpinned PR could report on a different commit than the one compared.
test('pinHead rejects a gh failure or a non-SHA answer', async t => {
  await pinHead(async () => 'not-a-sha', ref).then(
    () => t.fail('accepted a non-SHA'),
    error => t.match(String(error), /gh returned no commit SHA/)
  )
  await pinHead(async () => {
    throw new Error('HTTP 404')
  }, ref).then(
    () => t.fail('accepted a failure'),
    error => t.match(String(error), /could not read the head of https:\/\/github.com\/o\/r\/pull\/7: HTTP 404/)
  )
  t.end()
})

// An engine error must not read as clean: exit 2 separates "could not judge" from "found issues".
test('reportOnlyExitCode: all clean 0, findings 1, an unusable pass 2', async t => {
  const gh: GhRunner = async () => SHA
  const seen: EngineRunInput[] = []
  const clean = await runReportOnly({ prs: [ref], instructions: '' }, { gh, engines: [engine('codex', 'approve', seen)], worktreeRoot: '/wt', runId: 'r' })
  t.equal(reportOnlyExitCode(clean), 0)
  const broken: Engine = {
    name: 'codex',
    run: async () => {
      throw new Error('model call denied')
    },
  }
  const failed = await runReportOnly({ prs: [ref], instructions: '' }, { gh, engines: [broken], worktreeRoot: '/wt', runId: 'r' })
  t.equal(reportOnlyExitCode(failed), 2)
  t.end()
})

// --engine selects engines for this run only, so "claude" alone works for a model comparison.
test('parseEngineFlag', t => {
  t.deepEqual(parseEngineFlag(['--engine', 'claude', 'https://x']), { engines: ['claude'], rest: ['https://x'] })
  t.deepEqual(parseEngineFlag(['--engine=codex,claude']), { engines: ['codex', 'claude'], rest: [] })
  t.deepEqual(parseEngineFlag(['https://x']), { engines: undefined, rest: ['https://x'] })
  t.throws(() => parseEngineFlag(['--engine', 'gpt']), /--engine must be/)
  t.throws(() => parseEngineFlag(['--engine', 'codex,codex']), /--engine must be/)
  t.end()
})
