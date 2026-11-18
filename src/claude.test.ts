import { EventEmitter } from 'events'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { PassThrough } from 'stream'
import test from 'tape'
import {
  buildClaudeArgs,
  buildClaudeEnv,
  CLAUDE_ALLOWED_TOOLS,
  claudeUsage,
  ClaudeRunError,
  createResultCollector,
  runClaudeReview,
  totalTokens,
  type ClaudeRunOptions,
} from './claude'
import type { Spawner } from './supervise'
import { TRANSCRIPT_TAIL_LIMIT } from './supervise'

/** A stand-in for the `claude` child; `pid` is undefined so kills signal this handle only. */
class FakeChild extends EventEmitter {
  pid: number | undefined = undefined
  stdout = new PassThrough()
  stderr = new PassThrough()
  signals: string[] = []
  kill(signal?: NodeJS.Signals | number): boolean {
    this.signals.push(String(signal))
    this.emit('close', null)
    return true
  }
}

function fakeClock() {
  let now = 1_000_000
  let heartbeat: (() => void) | undefined
  return {
    deps: {
      now: () => now,
      setInterval: (cb: () => void) => {
        heartbeat = cb
        return 1 as unknown as ReturnType<typeof setInterval>
      },
      clearInterval: () => {},
      checkMs: 10_000,
      toleranceMs: 5_000,
    },
    tick(ms: number) {
      now += ms
      heartbeat?.()
    },
  }
}

const settle = () => new Promise(resolve => setImmediate(resolve))
const SHA = 'c'.repeat(40)
const URL1 = 'https://github.com/o/r/pull/1'

function options(over: Partial<ClaudeRunOptions> = {}): ClaudeRunOptions {
  return {
    prompt: 'review',
    claudeBin: 'claude',
    configDir: '/cfg/claude-review-bot',
    workspaceRoot: '/ws',
    worktreeRoot: fs.mkdtempSync(path.join(os.tmpdir(), 'claude-test-worktrees-')),
    timeoutMs: 600_000,
    disableGitSigning: true,
    engineGhToken: 'engine-placeholder',
    runId: 'test',
    ...over,
  }
}

function resultEvent(structured: unknown, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    structured_output: structured,
    total_cost_usd: 2.1,
    num_turns: 12,
    duration_ms: 180_000,
    permission_denials: [],
    usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 30_000, cache_creation_input_tokens: 4000 },
    ...extra,
  })
}

const clean = { results: [{ url: URL1, reviewedSha: SHA, verdict: 'clean', findings: [], summary: '', environmentProblems: [] }] }

/** Start a run against a FakeChild, returning the child and what it was spawned with. */
function start(over: Partial<ClaudeRunOptions> = {}) {
  const child = new FakeChild()
  const seen: { bin?: string; args?: string[]; cwd?: string; env?: NodeJS.ProcessEnv } = {}
  const spawner = ((bin: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv }) => {
    Object.assign(seen, { bin, args, cwd: opts.cwd, env: opts.env })
    return child
  }) as unknown as Spawner
  const clock = fakeClock()
  const run = runClaudeReview(options(over), spawner, clock.deps).then(
    value => ({ value, error: undefined as unknown }),
    (error: unknown) => ({ value: undefined, error })
  )
  return { child, seen, clock, run }
}

// The flags are the ones the V2 spike verified. Losing --permission-mode dontAsk would make the
// child wait on a prompt nobody answers; losing --json-schema loses structured_output. --bare and
// --setting-sources are deliberately absent: --bare skips the secret-blocking hook, and
// --setting-sources does not isolate the user's skills (spike).
test('buildClaudeArgs uses the verified headless flags', t => {
  const args = buildClaudeArgs({ prompt: 'do it', schemaJson: '{"type":"object"}', workspaceRoot: '/ws' })
  t.deepEqual(args.slice(0, 2), ['-p', 'do it'], 'the prompt follows -p')
  const value = (flag: string) => args[args.indexOf(flag) + 1]
  t.equal(value('--output-format'), 'stream-json')
  t.ok(args.includes('--verbose'), 'stream-json needs --verbose')
  t.equal(value('--json-schema'), '{"type":"object"}')
  t.equal(value('--permission-mode'), 'dontAsk')
  t.equal(value('--add-dir'), '/ws')
  t.equal(args[args.length - 2], '--allowedTools', '--allowedTools is last, so its variadic list cannot swallow anything')
  t.equal(args[args.length - 1], CLAUDE_ALLOWED_TOOLS.join(','))
  for (const banned of ['--bare', '--setting-sources', '--dangerously-skip-permissions']) t.notOk(args.includes(banned), `${banned} is not used`)
  t.end()
})

// The Claude child gets the shared allowlist plus its own credential and config dir. The approver
// token must be dropped even when named as passthrough, and an inherited operator token must not
// shadow the read-only engine token. Regression caught: an approving credential in untrusted PR code.
test('buildClaudeEnv passes the Claude credential and engine token, never the approver token', t => {
  const env = buildClaudeEnv(
    {
      PATH: '/usr/bin',
      HOME: '/home/u',
      CLAUDE_CODE_OAUTH_TOKEN: 'claude-placeholder',
      APPROVER_GH_TOKEN: 'approver-placeholder',
      GITHUB_TOKEN: 'operator-placeholder',
      ANTHROPIC_API_KEY: 'api-key-placeholder',
    },
    { configDir: '/cfg', engineGhToken: 'engine-placeholder', envPassthrough: ['APPROVER_GH_TOKEN'], disableGitSigning: true }
  )
  t.equal(env.CLAUDE_CODE_OAUTH_TOKEN, 'claude-placeholder', 'passed by exact name')
  t.equal(env.CLAUDE_CONFIG_DIR, '/cfg', 'the dedicated profile, never the operator one')
  t.equal(env.GH_TOKEN, 'engine-placeholder')
  t.notOk('APPROVER_GH_TOKEN' in env, 'approver token denied despite passthrough')
  t.notOk('GITHUB_TOKEN' in env, 'operator token stripped')
  t.notOk('ANTHROPIC_API_KEY' in env, 'not on the allowlist')
  t.equal(env.GIT_CONFIG_KEY_0, 'commit.gpgsign', 'signing disabled like Codex')
  t.end()
})

// A stream-JSON event can arrive split across chunks, and many non-result events come first.
// Only a complete `result` line counts, and the last one wins.
test('createResultCollector reassembles a split result line and ignores other events', t => {
  const c = createResultCollector()
  c.push('{"type":"system","subtype":"init"}\n{"type":"assistant","message":{"content":"the result is near"}}\n{"type":"res')
  c.push('ult","num_turns":3}\n')
  t.equal(c.result()?.num_turns, 3)
  c.push('{"type":"result","num_turns":4}')
  c.flush()
  t.equal(c.result()?.num_turns, 4, 'an unterminated final line is read on flush')
  t.end()
})

// A line over the cap is dropped whole, and the collector resumes cleanly at the next line.
// Regression caught: an over-long tool output wedging the buffer so the later result is lost.
test('createResultCollector drops an over-long line and still reads the result after it', t => {
  const c = createResultCollector(100)
  c.push('{"type":"user","content":"' + 'x'.repeat(150))
  c.push('more"}\n{"type":"result","num_turns":7}\n')
  t.equal(c.result()?.num_turns, 7)
  t.end()
})

// Usage comes from the result event (spike): four token figures, cost, turns, duration.
test('claudeUsage reads every figure and totalTokens sums the four token counts', t => {
  const u = claudeUsage(JSON.parse(resultEvent(clean)))
  t.deepEqual(u, { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 30_000, cacheWriteTokens: 4000, costUsd: 2.1, numTurns: 12, durationMs: 180_000 })
  t.equal(totalTokens(u), 35_200)
  t.deepEqual(claudeUsage({ type: 'result' }).inputTokens, 0, 'absent fields read as 0')
  t.end()
})

// The happy path: the child runs in its own worktree root with the dedicated config dir, and the
// structured_output of the result event is parsed with schema v2.
test('runClaudeReview parses structured_output and reports usage and denials', async t => {
  const { child, seen, run } = start()
  await settle()
  child.stdout.write('{"type":"system","subtype":"init"}\n')
  child.stdout.write(resultEvent(clean, { permission_denials: [{ tool_name: 'Bash' }] }) + '\n')
  await settle()
  child.emit('close', 0)
  const { value, error } = await run
  t.equal(error, undefined)
  t.equal(value?.result.results[0].verdict, 'clean')
  t.equal(value?.tokensUsed, 35_200)
  t.equal(value?.permissionDenials, 1)
  t.equal(seen.bin, 'claude')
  t.ok(seen.cwd && seen.cwd.includes('claude-test-worktrees-'), 'cwd is the engine worktree root')
  t.equal(seen.env?.CLAUDE_CONFIG_DIR, '/cfg/claude-review-bot')
  t.end()
})

// A fresh config dir is not logged in (spike): the result event has is_error true. That must be a
// failed run, never a clean review.
test('runClaudeReview turns an is_error result into an output failure', async t => {
  const { child, run } = start()
  await settle()
  child.stdout.write(resultEvent(undefined, { is_error: true, result: 'Not logged in · Please run /login' }) + '\n')
  await settle()
  child.emit('close', 1)
  const { error } = await run
  t.ok(error instanceof ClaudeRunError)
  t.equal((error as ClaudeRunError).kind, 'output')
  t.match(String(error), /Not logged in/)
  t.end()
})

// A clean verdict alongside a blocking finding is malformed output, so the pass is invalid.
test('runClaudeReview rejects structured output that fails schema v2', async t => {
  const { child, run } = start()
  await settle()
  const bad = { results: [{ ...clean.results[0], findings: [{ severity: 'blocking', file: '', line: 0, body: 'bug' }] }] }
  child.stdout.write(resultEvent(bad) + '\n')
  await settle()
  child.emit('close', 0)
  const { error } = await run
  t.equal((error as ClaudeRunError).kind, 'output')
  t.match(String(error), /verdict clean with a blocking finding/)
  t.end()
})

// No result event at all (a crash) is an output failure that names the exit code.
test('runClaudeReview fails when the child exits without a result event', async t => {
  const { child, run } = start()
  await settle()
  child.stdout.write('{"type":"system","subtype":"init"}\n')
  await settle()
  child.emit('close', 2)
  const { error } = await run
  t.equal((error as ClaudeRunError).kind, 'output')
  t.match(String(error), /exited with code 2 and produced no result event/)
  t.end()
})

// A silent child is killed as stalled, and that is the one retryable kind.
test('runClaudeReview kills a silent child and reports a stall', async t => {
  const { child, clock, run } = start({ stallTimeoutMs: 30_000 })
  await settle()
  for (let i = 0; i < 4; i += 1) clock.tick(10_000)
  await settle()
  t.deepEqual(child.signals, ['SIGTERM'])
  const { error } = await run
  t.equal((error as ClaudeRunError).kind, 'stall')
  t.end()
})

// Review Focus 2: the result event carries every finding body twice (structured_output and the
// `result` string), so a review with long findings easily exceeds the 64 KB transcript tail.
// Parsing from the tail would cut the event and turn a real review into an output failure.
test('runClaudeReview reads a result event larger than the transcript tail', async t => {
  const body = 'x'.repeat(TRANSCRIPT_TAIL_LIMIT)
  const big = { results: [{ ...clean.results[0], verdict: 'findings', findings: [{ severity: 'blocking', file: 'a.ts', line: 1, body }] }] }
  const { child, run } = start()
  await settle()
  const line = resultEvent(big, { result: JSON.stringify(big) }) + '\n'
  for (let i = 0; i < line.length; i += 16 * 1024) child.stdout.write(line.slice(i, i + 16 * 1024))
  await settle()
  child.emit('close', 0)
  const { value, error } = await run
  t.equal(error, undefined, String(error))
  t.equal(value?.result.results[0].findings[0].body.length, TRANSCRIPT_TAIL_LIMIT)
  t.end()
})
