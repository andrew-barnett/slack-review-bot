import test from 'tape'
import { CLAIMED_LINE } from './jobs/remote'
import { orchestratorConfig, smokeJob } from './orchestrator'
import type { RunUsage } from './usage'

const key = Buffer.alloc(32, 9).toString('base64url')
const bundle = { SLACK_BOT_TOKEN: 'bot-placeholder', SLACK_APP_TOKEN: 'app-placeholder', APPROVER_GH_TOKEN: 'approver-placeholder', LAUNCH_KEY: key }

// Spec 3.6.1: the orchestrator keeps its secrets in its config object and never in its environment,
// so no later spawn (gh, git) inherits them. Regression caught: Object.assign(process.env, bundle).
test('orchestratorConfig reads the bundle without touching the environment', t => {
  const env: NodeJS.ProcessEnv = { HOME: '/home/bot', REVIEW_ENGINES: 'claude' }
  const before = JSON.stringify(env)
  const { config, launchKey } = orchestratorConfig(bundle, env)
  t.equal(JSON.stringify(env), before, 'env is unchanged')
  t.equal(config.runtime, 'container')
  t.equal(config.botToken, 'bot-placeholder')
  t.equal(config.approverGhToken, 'approver-placeholder')
  t.equal(launchKey.length, 32)
  t.end()
})

// The orchestrator never holds the engine token or engine AWS keys, even if the container env had
// them by mistake, and its engine auth is never bedrock (it runs no engine).
test('orchestratorConfig drops engine credentials from what config sees', t => {
  const env: NodeJS.ProcessEnv = {
    HOME: '/home/bot',
    ENGINE_GH_TOKEN: 'engine-placeholder',
    ENGINE_AUTH: 'bedrock',
    CODEX_BEDROCK_PROJECT: 'proj_testproject123',
    AWS_ACCESS_KEY_ID: 'id-placeholder',
    AWS_SECRET_ACCESS_KEY: 'secret-placeholder',
  }
  const { config } = orchestratorConfig(bundle, env)
  t.equal(config.engineGhToken, '')
  t.equal(config.engineAuth, 'subscription')
  t.equal(config.engineAwsStatic, undefined)
  t.end()
})

// A LAUNCH_KEY that is not 32 bytes of base64url cannot verify tickets; refuse rather than start.
test('orchestratorConfig rejects a malformed LAUNCH_KEY', t => {
  t.throws(() => orchestratorConfig({ ...bundle, LAUNCH_KEY: 'c2hvcnQ' }, { HOME: '/h' }), /LAUNCH_KEY/)
  t.end()
})

// The smoke job is one canned Codex attempt through the remote runner, under the worker's worktree
// root, and it reports every status line it saw so the smoke can check the progress stream.
test('smokeJob submits one codex job and reports results and status lines', async t => {
  const { config } = orchestratorConfig(bundle, { HOME: '/home/bot', WORKTREE_ROOT: '/work/wt' })
  const seen: Record<string, unknown>[] = []
  const runners = {
    runCodex: async (options: { worktreeRoot: string; runId: string; onProgress?: (line: string, activeMs: number) => void }) => {
      seen.push(options)
      options.onProgress?.(CLAIMED_LINE, 0)
      options.onProgress?.('stub-codex: reviewing\n', 5)
      return { result: { results: [] }, rawFinalMessage: '', activeMs: 5 }
    },
    runClaude: async () => {
      throw new Error('not used')
    },
  }
  const reply = await smokeJob(config)(runners as never)()
  t.equal(seen[0].worktreeRoot, '/work/wt/codex')
  t.match(String(seen[0].runId), /^smoke-\d+$/)
  t.deepEqual(reply.results, [])
  t.deepEqual(reply.lines, [CLAIMED_LINE, 'stub-codex: reviewing\n'])
  t.end()
})

// Spec 6/7: the smoke's one Codex run is recorded through the spend cap as one Codex engine run, under
// the smoke's runId and with the worker's usage, so the compose smoke can prove usage reaches the
// ledger. Regression caught: the smoke passing while --json usage is lost on the worker wire.
test('smokeJob records its Codex run with the spend cap', async t => {
  const { config } = orchestratorConfig(bundle, { HOME: '/home/bot' })
  const codexUsage = { inputTokens: 1200, cachedInputTokens: 200, cacheWriteTokens: 0, outputTokens: 300, reasoningTokens: 40 }
  const runners = {
    runCodex: async () => ({ result: { results: [] }, rawFinalMessage: '', activeMs: 5, tokensUsed: 1740, codexUsage }),
    runClaude: async () => {
      throw new Error('not used')
    },
  }
  const recorded: Array<{ usage: RunUsage; runId: string }> = []
  const spend = { record: async (usage: RunUsage, runId: string) => void recorded.push({ usage, runId }) }
  const reply = await smokeJob(config, spend)(runners as never)()
  t.equal(recorded.length, 1)
  t.equal(recorded[0].runId, reply.runId)
  t.deepEqual(recorded[0].usage.engines?.map(e => [e.engine, e.usage.codex]), [['codex', codexUsage]])
  t.end()
})
