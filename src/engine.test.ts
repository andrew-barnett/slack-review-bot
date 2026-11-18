import test from 'tape'
import { CodexStalledError, CodexTimeoutError, type CodexRunOptions, type runCodexReportOnly } from './codex'
import { ClaudeRunError, type ClaudeRunOptions, type runClaudeReview } from './claude'
import { loadReviewConfig } from './config'
import { AttemptFailure, engineWorktreeRoot, makeClaudeEngine, makeCodexEngine, runWithStallRetries, type EngineRunInput } from './engine'
import type { EngineRunResult } from './schema'

const SHA = 'd'.repeat(40)
const URL1 = 'https://github.com/o/r/pull/1'
const URL2 = 'https://github.com/o/r/pull/2'

const config = loadReviewConfig({
  HOME: '/home/u',
  REVIEW_ENGINES: 'codex,claude',
  APPROVER_GH_TOKEN: 'approver-placeholder',
  ENGINE_GH_TOKEN: 'engine-placeholder',
  STALL_BACKOFF_MS: '60000,120000',
  RUN_LOG_DIR: '',
})

const input: EngineRunInput = {
  prs: [
    { ref: { owner: 'o', repo: 'r', number: 1, url: URL1 }, pinnedSha: SHA },
    { ref: { owner: 'o', repo: 'r', number: 2, url: URL2 }, pinnedSha: SHA },
  ],
  instructions: '',
  worktreeRoot: '/wt/codex',
  runId: 'C1-11',
}

const clean = (url: string): EngineRunResult['results'][number] => ({
  url, reviewedSha: SHA, verdict: 'clean', findings: [], summary: '', environmentProblems: [],
})
const snapshot = (activeMs: number) => ({ activeMs, wallMs: activeMs, frozenMs: 0 })

// Parallel runs must never share a checkout or a node_modules (spec 5.4).
test('engineWorktreeRoot gives each engine its own subdirectory', t => {
  t.equal(engineWorktreeRoot('/private/tmp/codex-pr-review', 'claude'), '/private/tmp/codex-pr-review/claude')
  t.end()
})

// The Codex engine must run report-only with the pinned SHAs, the engine-specific root and the
// read-only engine token. Regression caught: the dual run handing Codex the v1 prompt, which
// pushes and approves.
test('the Codex engine runs the report-only prompt with the engine token and its own root', async t => {
  let seen: CodexRunOptions | undefined
  const runCodex = (async (options: CodexRunOptions) => {
    seen = options
    return { result: { results: [clean(URL1)] }, rawFinalMessage: '', tokensUsed: 5000, activeMs: 1000 }
  }) as unknown as typeof runCodexReportOnly
  const out = await makeCodexEngine(config, { runCodex }).run(input)
  t.ok(seen?.prompt.startsWith('$review-pr'))
  t.ok(seen?.prompt.includes(`pinned SHA \`${SHA}\``))
  t.equal(seen?.worktreeRoot, '/wt/codex')
  t.equal(seen?.engineGhToken, 'engine-placeholder')
  t.equal(seen?.runId, 'C1-11.codex')
  t.equal(out.error, undefined)
  t.equal(out.results.length, 2, 'reconciled to every requested PR')
  t.deepEqual(out.results[1].environmentProblems, ['the engine reported no result for this pull request'])
  t.deepEqual(out.usage, { tokensUsed: 5000, activeMs: 1000, attempts: 1 })
  t.end()
})

// The Claude engine uses the dedicated config dir and reports Claude's own usage figures.
test('the Claude engine passes its binary and config dir and keeps the Claude usage detail', async t => {
  let seen: ClaudeRunOptions | undefined
  const detail = { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4, costUsd: 0.5, numTurns: 6, durationMs: 7 }
  const runClaude = (async (options: ClaudeRunOptions) => {
    seen = options
    return { result: { results: [clean(URL1), clean(URL2)] }, usage: detail, tokensUsed: 10, activeMs: 2000, permissionDenials: 0 }
  }) as unknown as typeof runClaudeReview
  const out = await makeClaudeEngine(config, { runClaude }).run({ ...input, worktreeRoot: '/wt/claude' })
  t.equal(seen?.claudeBin, 'claude')
  t.equal(seen?.configDir, '/home/u/.claude-review-bot')
  t.ok(seen?.prompt.startsWith('Use the `review-pr` skill'))
  t.deepEqual(out.usage.claude, detail)
  t.equal(out.usage.tokensUsed, 10)
  t.end()
})

// A stall is retried with the next grace, active time is charged across attempts, and the
// registry token is refreshed before each attempt (issue 44).
test('an engine retries a stall and charges both attempts', async t => {
  let calls = 0
  let refreshes = 0
  const runCodex = (async (options: CodexRunOptions) => {
    calls += 1
    if (calls === 1) {
      t.equal(options.stallTimeoutMs, 60000)
      throw new CodexStalledError('stalled', 60000, snapshot(60000))
    }
    t.equal(options.stallTimeoutMs, 120000)
    t.equal(options.runId, 'C1-11.codex.retry1')
    return { result: { results: [clean(URL1), clean(URL2)] }, rawFinalMessage: '', tokensUsed: 1, activeMs: 500 }
  }) as unknown as typeof runCodexReportOnly
  const out = await makeCodexEngine(config, { runCodex, refreshAuth: async () => { refreshes += 1 } }).run(input)
  t.equal(out.error, undefined)
  t.equal(out.usage.attempts, 2)
  t.equal(out.usage.activeMs, 60500)
  t.equal(refreshes, 2)
  t.end()
})

// A timeout is terminal and must surface as `error`, never as a thrown rejection or an empty
// clean result. Regression caught: a timed-out engine with no results being read as "no findings".
test('an engine reports a timeout as an error without retrying', async t => {
  let calls = 0
  const runCodex = (async () => {
    calls += 1
    throw new CodexTimeoutError('Codex run exceeded the 180 minute timeout', snapshot(1000))
  }) as unknown as typeof runCodexReportOnly
  const out = await makeCodexEngine(config, { runCodex }).run(input)
  t.equal(calls, 1)
  t.match(out.error ?? '', /exceeded the 180 minute timeout/)
  t.deepEqual(out.results, [])
  t.end()
})

// A stall on the last attempt gives up with an error naming the attempts.
test('an engine gives up after stalling on every attempt', async t => {
  const runClaude = (async () => {
    throw new ClaudeRunError('Claude produced no output', 'stall', 100)
  }) as unknown as typeof runClaudeReview
  const out = await makeClaudeEngine(config, { runClaude }).run(input)
  t.match(out.error ?? '', /stalled on every attempt \(2\)/)
  t.equal(out.usage.activeMs, 200)
  t.end()
})

// Spend is charged across attempts, like active time. Regression caught: a stalled attempt's
// tokens dropped from the usage of the retry that succeeded, under-reporting the review's cost.
test('runWithStallRetries adds a failed attempt\'s tokens to the successful attempt\'s', async t => {
  let calls = 0
  const out = await runWithStallRetries('codex', input, [60000, 120000], async () => {
    calls += 1
    if (calls === 1) throw new AttemptFailure('stalled', true, 10, 100)
    return { result: { results: [clean(URL1), clean(URL2)] }, activeMs: 20, tokensUsed: 200 }
  })
  t.equal(out.error, undefined)
  t.equal(out.usage.tokensUsed, 300)
  t.equal(out.usage.activeMs, 30)
  t.end()
})

// A successful attempt that reports no token count must not erase what the failed attempts
// already spent: unknown plus known is the known part, never unknown.
test('runWithStallRetries keeps known spend when the successful attempt omits it', async t => {
  let calls = 0
  const out = await runWithStallRetries('codex', input, [60000, 120000], async () => {
    calls += 1
    if (calls === 1) throw new AttemptFailure('stalled', true, 10, 100)
    return { result: { results: [clean(URL1), clean(URL2)] }, activeMs: 20 }
  })
  t.equal(out.usage.tokensUsed, 100)
  t.end()
})

// The Claude breakdown (input, output, cache, cost, turns) is summed across attempts the same way,
// so the per-engine usage line and the status totals agree with the token total.
test('the Claude engine sums the usage breakdown across a stalled attempt and the retry', async t => {
  const first = { inputTokens: 10, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 40, costUsd: 0.5, numTurns: 1, durationMs: 100 }
  const second = { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4, costUsd: 0.25, numTurns: 2, durationMs: 50 }
  let calls = 0
  const runClaude = (async () => {
    calls += 1
    if (calls === 1) throw new ClaudeRunError('Claude produced no output', 'stall', 100, first)
    return { result: { results: [clean(URL1), clean(URL2)] }, usage: second, tokensUsed: 10, activeMs: 200, permissionDenials: 0 }
  }) as unknown as typeof runClaudeReview
  const out = await makeClaudeEngine(config, { runClaude }).run(input)
  t.equal(out.error, undefined)
  t.deepEqual(out.usage.claude, { inputTokens: 11, outputTokens: 22, cacheReadTokens: 33, cacheWriteTokens: 44, costUsd: 0.75, numTurns: 3, durationMs: 150 })
  t.equal(out.usage.tokensUsed, 110, 'the failed attempt\'s 100 tokens plus the retry\'s 10')
  t.end()
})

// A crash (spawn ENOENT) never escapes the engine, and a token echoed in an error is redacted
// before it can reach Slack.
test('an engine turns a crash into a redacted error', async t => {
  const runCodex = (async () => {
    throw new Error(`spawn codex ENOENT ghp_${'a'.repeat(36)}`)
  }) as unknown as typeof runCodexReportOnly
  const out = await makeCodexEngine(config, { runCodex }).run(input)
  t.match(out.error ?? '', /spawn codex ENOENT/)
  t.notOk((out.error ?? '').includes('ghp_'), 'the token is redacted')
  t.end()
})

// Two engines share one live-status line in parallel, so each line names its engine.
test('an engine prefixes its progress lines with its name', async t => {
  const lines: string[] = []
  const runCodex = (async (options: CodexRunOptions) => {
    options.onProgress?.('npm ci', 10)
    return { result: { results: [clean(URL1), clean(URL2)] }, rawFinalMessage: '', activeMs: 10 }
  }) as unknown as typeof runCodexReportOnly
  await makeCodexEngine(config, { runCodex }).run({ ...input, onProgress: line => lines.push(line) })
  t.deepEqual(lines, ['[codex] npm ci'])
  t.end()
})

// --- ENGINE_AUTH (issue #69) ---

const bedrockFor = (engine: string, runId: string) => ({
  region: 'us-east-2',
  model: `${engine}-model`,
  credentials: { accessKeyId: `id-for-${runId}`, secretAccessKey: 'fake-secret-' + 'value-xyz' },
})

// Credentials are minted per attempt, keyed by the attempt's runId, so a stall retry gets a fresh
// session instead of one that may expire mid-retry. Each engine asks with its own name.
test('both engines resolve Bedrock auth per attempt and pass it to the run', async t => {
  const asked: string[] = []
  const engineAuth = async (engine: 'codex' | 'claude', runId: string) => {
    asked.push(`${engine}:${runId}`)
    return bedrockFor(engine, runId)
  }
  const codexSeen: Array<CodexRunOptions['bedrock']> = []
  let calls = 0
  const runCodex = (async (options: CodexRunOptions) => {
    codexSeen.push(options.bedrock)
    calls += 1
    if (calls === 1) throw new CodexStalledError('stalled', 60_000, snapshot(1000))
    return { result: { results: [clean(URL1), clean(URL2)] }, rawFinalMessage: '', activeMs: 10 }
  }) as unknown as typeof runCodexReportOnly
  await makeCodexEngine(config, { runCodex, engineAuth }).run(input)
  t.deepEqual(asked, ['codex:C1-11.codex', 'codex:C1-11.codex.retry1'], 'one resolve per attempt')
  t.deepEqual(
    codexSeen.map(b => b?.credentials.accessKeyId),
    ['id-for-C1-11.codex', 'id-for-C1-11.codex.retry1'],
    'each attempt runs with its own credentials'
  )

  let claudeSeen: ClaudeRunOptions['bedrock']
  const runClaude = (async (options: ClaudeRunOptions) => {
    claudeSeen = options.bedrock
    const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, numTurns: 0, durationMs: 0 }
    return { result: { results: [clean(URL1), clean(URL2)] }, usage, tokensUsed: 0, activeMs: 1, permissionDenials: 0 }
  }) as unknown as typeof runClaudeReview
  await makeClaudeEngine(config, { runClaude, engineAuth }).run(input)
  t.equal(claudeSeen?.model, 'claude-model', 'Claude gets its own model')
  t.end()
})

// Subscription mode resolves to undefined, and an engine with no resolver at all must behave
// exactly as before: no bedrock option reaches the run.
test('an engine passes no Bedrock auth in subscription mode', async t => {
  const seen: Array<CodexRunOptions['bedrock'] | 'unset'> = []
  const runCodex = (async (options: CodexRunOptions) => {
    seen.push('bedrock' in options && options.bedrock !== undefined ? options.bedrock : 'unset')
    return { result: { results: [clean(URL1), clean(URL2)] }, rawFinalMessage: '', activeMs: 1 }
  }) as unknown as typeof runCodexReportOnly
  await makeCodexEngine(config, { runCodex, engineAuth: async () => undefined }).run(input)
  await makeCodexEngine(config, { runCodex }).run(input)
  t.deepEqual(seen, ['unset', 'unset'])
  t.end()
})

// A failed mint (AccessDenied, an expired operator session) must fail the engine without running
// it and without retrying, since retrying cannot fix it, and the error must reach the gate as an
// engine error, never as a clean pass.
test('an engine reports a failed credential mint as a non-retried error', async t => {
  let runs = 0
  let resolves = 0
  const runCodex = (async () => {
    runs += 1
    return { result: { results: [clean(URL1), clean(URL2)] }, rawFinalMessage: '', activeMs: 1 }
  }) as unknown as typeof runCodexReportOnly
  const engineAuth = async () => {
    resolves += 1
    throw new Error('could not assume the engine role: An error occurred (AccessDenied)')
  }
  const out = await makeCodexEngine(config, { runCodex, engineAuth }).run(input)
  t.equal(runs, 0, 'the engine never ran')
  t.equal(resolves, 1, 'not retried')
  t.deepEqual(out.results, [])
  t.match(out.error ?? '', /could not assume the engine role: An error occurred \(AccessDenied\)/)
  t.equal(out.usage.attempts, 1)
  t.end()
})
