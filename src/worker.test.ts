import test from 'tape'
import type { BedrockAuth } from './bedrock-auth'
import { ClaudeRunError } from './claude'
import { CodexOutputError } from './codex'
import { loadReviewConfig } from './config'
import type { ClaimOutcome, JobClient } from './jobs/client'
import type { ClaimReply, ProgressBody, ResultBody } from './jobs/protocol'
import {
  assertWorkerConfig,
  CODEARTIFACT_REGISTRY,
  HEARTBEAT_FAILURE_LIMIT,
  PROGRESS_DRAIN_MS,
  RESULT_ATTEMPTS,
  renderWorkerNpmrc,
  runWorker,
  workerExitCode,
  workerWorktreeRoot,
  type WorkerDeps,
} from './worker'
import { registerHeldSecret } from './redact'

const config = loadReviewConfig({
  HOME: '/home/bot',
  RUNTIME: 'container',
  ENGINE_AUTH: 'bedrock',
  CODEX_BEDROCK_PROJECT: 'proj_testproject123',
  AWS_ACCESS_KEY_ID: 'id-placeholder-value',
  AWS_SECRET_ACCESS_KEY: 'secret-placeholder-value',
  AWS_SESSION_TOKEN: 'session-placeholder-value',
  ENGINE_GH_TOKEN: 'engine-placeholder',
  WORKSPACE_ROOT: '/work/src',
  WORKTREE_ROOT: '/work/wt',
  CODEX_BIN: '/usr/local/bin/codex',
  CLAUDE_BIN: '/usr/local/bin/claude',
  CLAUDE_CONFIG_DIR_REVIEW: '/home/bot/.claude-review-bot',
})
const auth: BedrockAuth = { region: 'us-east-2', model: 'openai.gpt-5.5', project: 'proj_testproject123', credentials: { accessKeyId: 'a', secretAccessKey: 's', sessionToken: 't' } }
const SHA = 'd'.repeat(40)
const clean = { results: [{ url: 'https://github.com/o/r/pull/1', reviewedSha: SHA, verdict: 'clean' as const, findings: [], summary: '', environmentProblems: [] }] }
const codexJob: ClaimReply = {
  jobId: 'j1',
  jobToken: 'f'.repeat(64),
  kind: 'codex-report-only',
  options: { prompt: 'p', worktreeRoot: '/work/wt/codex', timeoutMs: 1000, stallTimeoutMs: 500, runId: 'C1-11.codex' },
}
const tick = () => new Promise(resolve => setImmediate(resolve))

/** A worker wired to fakes; `every` callbacks are captured (heartbeat first, then log polling). */
function harness(claims: (ClaimOutcome | Error)[] = [{ status: 200, job: codexJob }]) {
  let clock = 0
  const calls = { progress: [] as ProgressBody[], results: [] as ResultBody[], logs: [] as string[], heartbeats: 0 }
  const heartbeat = { status: 200 as number | Error }
  const killed: string[] = []
  // How many engine children are live; most tests run with one, as during a real engine run.
  const children = { count: 1 }
  const timers: (() => void)[] = []
  const client: JobClient = {
    claim: async () => {
      clock += 25_000 // a long-poll that found nothing takes its full wait
      const next = claims.length > 1 ? claims.shift()! : claims[0]
      if (next instanceof Error) throw next
      return next
    },
    progress: async (_job, body) => {
      calls.progress.push(body)
      return 200
    },
    heartbeat: async () => {
      calls.heartbeats += 1
      if (heartbeat.status instanceof Error) throw heartbeat.status
      return heartbeat.status
    },
    result: async (_job, body) => {
      calls.results.push(body)
      return 200
    },
    log: async (_job, chunk) => {
      calls.logs.push(chunk.toString())
      return 200
    },
  }
  const deps: WorkerDeps = {
    config,
    ticket: 'ticket-placeholder',
    client,
    runCodex: async () => ({ result: clean, rawFinalMessage: 'raw', tokensUsed: 3, activeMs: 4 }),
    runClaude: async () => ({ result: clean, usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, numTurns: 1, durationMs: 1 }, tokensUsed: 2, activeMs: 5, permissionDenials: 0 }),
    resolveAuth: async () => auth,
    registry: { add: () => {}, remove: () => {}, killAll: signal => (killed.push(signal), 1), size: () => children.count },
    logDir: '/tmp/srb-run-test',
    log: () => {},
    now: () => clock,
    sleep: async ms => {
      clock += ms
    },
    every: (_ms, fn) => {
      timers.push(fn)
      return () => {}
    },
    setTimer: fn => fn(),
    readFrom: () => Buffer.alloc(0),
  }
  return { deps, calls, heartbeat, killed, timers, children }
}

// Spec 3.4 step 3: a worker that never gets a job exits 0 after WORKER_IDLE_EXIT_MS, so the launcher
// replaces it with fresh credentials. Regression caught: a worker idling forever on expiring STS keys.
test('worker exits idle when no job arrives before WORKER_IDLE_EXIT_MS', async t => {
  const h = harness([{ status: 204 }])
  let ran = false
  h.deps.runCodex = async () => {
    ran = true
    throw new Error('should not run')
  }
  t.equal(await runWorker(h.deps), 'idle')
  t.notOk(ran)
  t.end()
})

// A 403 means a bad, spent or expired ticket: the worker can never get a job, so it exits at once.
test('worker exits rejected when its ticket is refused', async t => {
  const h = harness([{ status: 403 }])
  t.equal(await runWorker(h.deps), 'rejected')
  t.deepEqual(h.calls.results, [])
  t.end()
})

// Ruling 1: the job supplies only the prompt, the worktree root, the budget and the run id. The binary,
// profile, workspace, engine token and Bedrock credentials come from the worker's own config. The raw
// final message is not sent back.
test('worker runs the claimed codex job with its own config and credentials', async t => {
  const h = harness()
  const seen: Record<string, unknown>[] = []
  const authCalls: string[] = []
  h.deps.resolveAuth = async (engine, runId) => {
    authCalls.push(`${engine}:${runId}`)
    return auth
  }
  h.deps.runCodex = async options => {
    seen.push(options as unknown as Record<string, unknown>)
    options.onProgress?.('npm ci', 9)
    await tick()
    return { result: clean, rawFinalMessage: 'raw final message', tokensUsed: 3, activeMs: 4 }
  }
  t.equal(await runWorker(h.deps), 'done')
  const o = seen[0]
  t.equal(o.codexBin, '/usr/local/bin/codex')
  t.equal(o.profile, config.codexProfile)
  t.equal(o.workspaceRoot, '/work/src')
  t.equal(o.worktreeRoot, '/work/wt/codex')
  t.equal(o.engineGhToken, 'engine-placeholder')
  t.equal(o.bedrock, auth)
  t.equal(o.prompt, 'p')
  t.equal(o.runId, 'C1-11.codex')
  t.equal(o.stallTimeoutMs, 500)
  t.equal(o.logDir, '/tmp/srb-run-test')
  t.deepEqual(authCalls, ['codex:C1-11.codex'], 'fresh Bedrock auth per attempt, for the right engine')
  t.deepEqual(h.calls.progress, [{ line: 'npm ci', activeMs: 9 }])
  t.deepEqual(h.calls.results, [{ ok: true, outcome: { result: clean, tokensUsed: 3, activeMs: 4 } }])
  t.end()
})

// Spec 3.3 cancellation: a 409 on a heartbeat makes the worker SIGTERM, then SIGKILL, its children,
// and the killed run's own outcome is still reported, exactly as a locally killed child would be.
test('worker cancels its children on 409 and still reports the outcome', async t => {
  const h = harness()
  h.heartbeat.status = 409
  h.deps.runCodex = async () => {
    h.timers[0]()
    await tick()
    throw new CodexOutputError('Codex exited with code null and produced no final message', undefined, 1)
  }
  t.equal(await runWorker(h.deps), 'cancelled')
  t.deepEqual(h.killed, ['SIGTERM', 'SIGKILL'])
  t.equal(h.calls.results.length, 1)
  const body = h.calls.results[0]
  t.ok(!body.ok && body.error.class === 'CodexOutputError')
  t.end()
})

// Spec section 5: when the orchestrator restarted, the next call gets 404; the worker kills its
// children and exits without posting into a job nobody owns.
test('worker treats 404 as the orchestrator gone: kills children, posts nothing', async t => {
  const h = harness()
  h.heartbeat.status = 404
  h.deps.runCodex = async () => {
    h.timers[0]()
    await tick()
    throw new CodexOutputError('killed', undefined, 1)
  }
  t.equal(await runWorker(h.deps), 'lost')
  t.ok(h.killed.includes('SIGTERM'))
  t.deepEqual(h.calls.results, [])
  t.end()
})

// An orchestrator that vanished entirely (no 404, just connection errors) must not keep a worker
// running PR code for hours: about a minute of failed heartbeats counts as lost.
test('worker treats a minute of failed heartbeats as the orchestrator gone', async t => {
  const h = harness()
  h.heartbeat.status = new Error('getaddrinfo ENOTFOUND')
  h.deps.runCodex = async () => {
    for (let i = 0; i < HEARTBEAT_FAILURE_LIMIT; i += 1) {
      h.timers[0]()
      await tick()
    }
    throw new CodexOutputError('killed', undefined, 1)
  }
  t.equal(await runWorker(h.deps), 'lost')
  t.ok(h.killed.includes('SIGTERM'))
  t.end()
})

// The orchestrator's retry logic needs the class and the kind: a Claude stall must arrive as a
// ClaudeRunError with kind 'stall' (spec 3.3 error round-trip).
test('worker serializes a Claude stall for the orchestrator', async t => {
  const h = harness([{ status: 200, job: { ...codexJob, kind: 'claude-review', options: { ...codexJob.options, worktreeRoot: '/work/wt/claude', runId: 'C1-11.claude' } } }])
  let options: Record<string, unknown> = {}
  h.deps.runClaude = async o => {
    options = o as unknown as Record<string, unknown>
    throw new ClaudeRunError('stalled', 'stall', 7)
  }
  t.equal(await runWorker(h.deps), 'done')
  t.equal(options.claudeBin, '/usr/local/bin/claude')
  t.equal(options.configDir, '/home/bot/.claude-review-bot')
  t.deepEqual(h.calls.results, [{ ok: false, error: { class: 'ClaudeRunError', message: 'stalled', kind: 'stall', activeMs: 7 } }])
  t.end()
})

// A job naming a worktree outside WORKTREE_ROOT is refused before the engine runs.
test('worker refuses a worktree root outside WORKTREE_ROOT', async t => {
  const h = harness([{ status: 200, job: { ...codexJob, options: { ...codexJob.options, worktreeRoot: '/home/bot' } } }])
  let ran = false
  h.deps.runCodex = async () => {
    ran = true
    return { result: clean, rawFinalMessage: '', activeMs: 0 }
  }
  t.equal(await runWorker(h.deps), 'done')
  t.notOk(ran)
  const body = h.calls.results[0]
  t.ok(!body.ok && /outside WORKTREE_ROOT/.test(body.error.message))
  t.equal(workerWorktreeRoot('/work/wt/claude', '/work/wt'), '/work/wt/claude')
  t.throws(() => workerWorktreeRoot('/work/wt/../../etc', '/work/wt'), /outside/)
  t.end()
})

// The run log reaches the orchestrator: whatever the local run wrote is streamed, and a final flush
// after the run ships the tail.
test('worker streams the run log and flushes it after the run', async t => {
  const h = harness()
  const chunks = [Buffer.from('first part'), Buffer.alloc(0)]
  h.deps.readFrom = () => chunks.shift() ?? Buffer.alloc(0)
  t.equal(await runWorker(h.deps), 'done')
  t.deepEqual(h.calls.logs, ['first part'])
  t.end()
})

// Spec 3.4: the worker runs only as a container worker with launcher-minted static Bedrock
// credentials and the engine token. Each missing piece is refused at startup, not mid-review.
test('assertWorkerConfig requires the container runtime, static Bedrock credentials and the engine token', t => {
  t.doesNotThrow(() => assertWorkerConfig(config))
  t.throws(() => assertWorkerConfig({ ...config, runtime: 'launchd' }), /RUNTIME=container/)
  t.throws(() => assertWorkerConfig({ ...config, engineAuth: 'subscription' }), /ENGINE_AUTH=bedrock/)
  t.throws(() => assertWorkerConfig({ ...config, engineRoleArn: 'arn:aws:iam::123456789012:role/x' }), /ENGINE_ROLE_ARN/)
  t.throws(() => assertWorkerConfig({ ...config, engineAwsStatic: undefined }), /AWS credentials/)
  t.throws(() => assertWorkerConfig({ ...config, engineGhToken: '' }), /ENGINE_GH_TOKEN/)
  t.end()
})

// Ruling 13: the npmrc names the token by reference, so the value never touches the filesystem.
test('renderWorkerNpmrc references the token by name, never by value', t => {
  const text = renderWorkerNpmrc()
  t.ok(text.includes(`@trade-platform:registry=${CODEARTIFACT_REGISTRY}`))
  t.ok(text.includes('//trade-platform-153538148884.d.codeartifact.us-east-2.amazonaws.com/npm/trade-platform/:_authToken=${NPM_TOKEN}'))
  t.end()
})

// Ruling F2: the run's last progress line must be posted before the result, or the orchestrator
// settles the job first and the line is lost. Regression caught: firing the result while a progress
// post is still in flight.
test('worker posts in-flight progress before the result', async t => {
  const h = harness()
  const order: string[] = []
  let release: () => void = () => {}
  const gate = new Promise<void>(resolve => (release = resolve))
  h.deps.client.progress = async (_job, body) => {
    await gate
    order.push(`progress:${body.line}`)
    return 200
  }
  h.deps.client.result = async () => {
    order.push('result')
    return 200
  }
  h.deps.sleep = ms => (ms === PROGRESS_DRAIN_MS ? new Promise(() => {}) : Promise.resolve())
  h.deps.runCodex = async options => {
    options.onProgress?.('last line', 9)
    return { result: clean, rawFinalMessage: 'raw', tokensUsed: 3, activeMs: 4 }
  }
  const done = runWorker(h.deps)
  for (let i = 0; i < 5; i += 1) await tick()
  t.deepEqual(order, [], 'the result waits for the progress post')
  release()
  t.equal(await done, 'done')
  t.deepEqual(order, ['progress:last line', 'result'])
  t.end()
})

// The drain is bounded: a progress post that never returns must not hold the result back.
test('worker posts its result even when a progress post hangs', async t => {
  const h = harness()
  h.deps.client.progress = () => new Promise(() => {})
  h.deps.runCodex = async options => {
    options.onProgress?.('stuck', 1)
    return { result: clean, rawFinalMessage: 'raw', tokensUsed: 3, activeMs: 4 }
  }
  t.equal(await runWorker(h.deps), 'done')
  t.equal(h.calls.results.length, 1)
  t.end()
})

// A 409 that lands before the engine child exists must still stop the run: the worker must not start
// PR code for a job the orchestrator already cancelled, and a later cancel signal must kill a child
// that started meanwhile. Regression caught: one-shot cancellation that finds no child and never fires
// again, leaving a full-timeout review nobody owns.
test('worker does not start the engine after a cancel that arrived first', async t => {
  const h = harness()
  h.children.count = 0
  h.heartbeat.status = 409
  let ran = false
  h.deps.resolveAuth = async () => {
    await h.timers[0]()
    return auth
  }
  h.deps.runCodex = async () => {
    ran = true
    return { result: clean, rawFinalMessage: 'raw', tokensUsed: 3, activeMs: 4 }
  }
  t.equal(await runWorker(h.deps), 'cancelled')
  t.notOk(ran, 'the engine never started')
  t.deepEqual(h.killed, [], 'there was nothing to kill yet')
  t.equal(h.calls.results.length, 1)
  const r = h.calls.results[0]
  t.ok(!r.ok && r.error.class === 'CodexOutputError' && /before the engine started/.test(r.error.message))
  t.end()
})

// Every cancel signal re-kills: a child spawned after the first 409 is still terminated by the next.
test('worker kills a child that started after an earlier cancel', async t => {
  const h = harness()
  h.deps.runCodex = async () => {
    h.children.count = 0
    h.heartbeat.status = 409
    await h.timers[0]()
    h.children.count = 1
    await h.timers[0]()
    return { result: clean, rawFinalMessage: 'raw', tokensUsed: 3, activeMs: 4 }
  }
  await runWorker(h.deps)
  t.deepEqual(h.killed, ['SIGTERM', 'SIGKILL'], 'the second cancel killed the late child')
  t.end()
})

// A 5xx from the orchestrator may be transient, so the result is retried; a worker that cannot deliver
// says so with its own event instead of claiming it posted.
test('worker retries a result answered with 5xx and reports one it could not deliver', async t => {
  const h = harness()
  const statuses = [502, 200]
  h.deps.client.result = async () => statuses.shift() ?? 200
  const events: string[] = []
  h.deps.log = event => events.push(event)
  await runWorker(h.deps)
  t.deepEqual(events.filter(e => e.startsWith('worker.result')), ['worker.result_failed', 'worker.result_posted'])
  const g = harness()
  g.deps.client.result = async () => 503
  const gEvents: string[] = []
  g.deps.log = event => gEvents.push(event)
  await runWorker(g.deps)
  t.equal(gEvents.filter(e => e === 'worker.result_failed').length, RESULT_ATTEMPTS)
  t.ok(gEvents.includes('worker.result_undelivered'))
  t.end()
})

// Only a 200 heartbeat proves the orchestrator is alive; a proxy answering 502 forever must count
// toward worker-side loss detection.
test('worker counts non-200 heartbeats as failures', async t => {
  const h = harness()
  h.heartbeat.status = 502
  h.deps.runCodex = async () => {
    for (let i = 0; i < HEARTBEAT_FAILURE_LIMIT; i += 1) await h.timers[0]()
    return { result: clean, rawFinalMessage: 'raw', tokensUsed: 3, activeMs: 4 }
  }
  t.equal(await runWorker(h.deps), 'lost')
  t.end()
})

// A 409 is the orchestrator cancelling, which proves it is alive: repeated 409s while a child shuts
// down must not turn a cancelled run into 'lost' (which skips posting the result).
test('worker does not count 409 heartbeats as failures', async t => {
  const h = harness()
  h.heartbeat.status = 409
  h.deps.runCodex = async () => {
    for (let i = 0; i < HEARTBEAT_FAILURE_LIMIT + 2; i += 1) await h.timers[0]()
    return { result: clean, rawFinalMessage: 'raw', tokensUsed: 3, activeMs: 4 }
  }
  t.equal(await runWorker(h.deps), 'cancelled')
  t.equal(h.calls.results.length, 1)
  t.end()
})


// Final review, Important 2: the launcher can only back off from a worker that fails at once if the
// exit code says so. Regression caught: `rejected` (an expired or spent ticket, e.g. a VM clock behind
// the host) exiting 0 like `idle`, so the launcher re-mints credentials every few seconds forever.
test('workerExitCode is non-zero only for a rejected ticket', t => {
  t.equal(workerExitCode('done'), 0)
  t.equal(workerExitCode('cancelled'), 0)
  t.equal(workerExitCode('idle'), 0)
  t.equal(workerExitCode('lost'), 0)
  t.notEqual(workerExitCode('rejected'), 0)
  t.end()
})

// Final review (T7 minor): a 4xx on the result is final and means the result was dropped (dead token,
// duplicate result). Regression caught: logging it as `result_posted`, which hides a lost review.
test('worker logs a 4xx result reply as rejected, not posted', async t => {
  const h = harness()
  h.deps.client.result = async () => 403
  const events: [string, Record<string, unknown>][] = []
  h.deps.log = (event, fields = {}) => void events.push([event, fields])
  await runWorker(h.deps)
  const names = events.map(([e]) => e).filter(e => e.startsWith('worker.result'))
  t.deepEqual(names, ['worker.result_rejected'], 'one attempt, logged as rejected')
  t.equal(events.find(([e]) => e === 'worker.result_rejected')?.[1].status, 403)
  t.end()
})

// Controller ruling: the worker holds the values of its engine credentials (registered with
// registerHeldSecret); the orchestrator never sees them and can only redact by token shape. So the
// worker redacts every string of the outcome before posting. Regression caught: a finding body that
// quotes NPM_TOKEN or the engine token leaving the worker and reaching Slack.
test('worker redacts held secret values from every string of the posted result', async t => {
  const held = 'held-placeholder-value-0042'
  registerHeldSecret(held)
  const h = harness()
  h.deps.runCodex = async () => ({
    result: {
      results: [
        {
          ...clean.results[0],
          verdict: 'findings' as const,
          summary: `summary mentions ${held}`,
          findings: [{ severity: 'blocking' as const, file: 'a.ts', line: 1, body: `leaked ${held} here` }],
        },
      ],
    },
    rawFinalMessage: held,
    tokensUsed: 3,
    activeMs: 4,
  })
  await runWorker(h.deps)
  const posted = JSON.stringify(h.calls.results[0])
  t.notOk(posted.includes(held), 'no held value in the outcome')
  t.ok(posted.includes('leaked') && posted.includes('a.ts'), 'the rest of the finding survives')
  const g = harness()
  g.deps.runCodex = async () => {
    throw new CodexOutputError(`could not parse ${held}`, undefined, 0)
  }
  await runWorker(g.deps)
  t.notOk(JSON.stringify(g.calls.results[0]).includes(held), 'no held value in an error result')
  t.end()
})
