import test from 'tape'
import type { ApproverGitHub } from './approver-github'
import {
  CodexOutputError,
  CodexStalledError,
  CodexTimeoutError,
  type CodexRunOutcome,
  type runCodexReview,
} from './codex'
import { loadReviewConfig, type ReviewConfig } from './config'
import type { ReviewRequest } from './job'
import { makeReviewRunner, selectReviewRunner, serialized } from './review'
import { ReviewFailedError } from './usage'

const request: ReviewRequest = {
  message: { channel: 'C1', ts: '1.1' },
  prs: [{ owner: 'o', repo: 'r', number: 1, url: 'https://github.com/o/r/pull/1' }],
  instructions: '',
}

/** A well-formed run outcome covering the requested PR, so reconciliation is a no-op. */
function passed(): CodexRunOutcome {
  return {
    result: {
      results: [
        { url: 'https://github.com/o/r/pull/1', status: 'passed', summary: '', pushedTestCommits: false, reviewUrl: '' },
      ],
    },
    rawFinalMessage: '{}',
    tokensUsed: 12345,
    activeMs: 90_000,
  }
}

function stall(stallMs: number | undefined): CodexStalledError {
  // A non-zero active time so tests can assert it survives onto the failure usage. Every stalled
  // attempt here reports 5s of active time.
  return new CodexStalledError('stalled', stallMs ?? 0, { activeMs: 5000, wallMs: 5000, frozenMs: 0 })
}

/** A timed-out run that spent `activeMs` of active time before it was killed. */
function timeout(activeMs: number): CodexTimeoutError {
  return new CodexTimeoutError('timed out', { activeMs, wallMs: activeMs, frozenMs: 0 })
}

/** A run that finished but whose final message was unusable, having cost the given usage. */
function badOutput(tokensUsed: number | undefined, activeMs: number): CodexOutputError {
  return new CodexOutputError('malformed final message', tokensUsed, activeMs)
}

/** Defaults with a controlled stall schedule; the graces here are the shape, not real minutes. */
function config(stallBackoffMs: number[]): ReviewConfig {
  return { ...loadReviewConfig({}), stallBackoffMs }
}

// The behaviour the operator asked for: a stalled attempt is retried with the *next, longer*
// grace, each retry is a fresh run, and the first one that produces a result wins.
test('makeReviewRunner retries a stall with the next longer grace and returns on success', async t => {
  const graces: (number | undefined)[] = []
  const runIds: string[] = []
  let calls = 0
  const fakeRun: typeof runCodexReview = async opts => {
    graces.push(opts.stallTimeoutMs)
    runIds.push(opts.runId)
    calls += 1
    if (calls < 3) throw stall(opts.stallTimeoutMs)
    return passed()
  }
  const events: string[] = []
  const runner = makeReviewRunner(config([1000, 2000, 3000, 4000]), e => events.push(e), fakeRun)

  const outcome = await runner(request)
  t.equal(outcome.result.results[0].status, 'passed', 'the succeeding attempt is returned')
  t.deepEqual(graces, [1000, 2000, 3000], 'each attempt waited longer for output than the last')
  t.deepEqual(runIds, ['C1-11', 'C1-11.retry1', 'C1-11.retry2'], 'each retry logs to its own runId')
  t.equal(events.filter(e => e === 'review.retry').length, 2, 'the two retries were logged')
  // Usage rides along with the winning attempt: Codex's token total, its active time, and the
  // attempt number it succeeded on (3, after two retries) — so a retried review reports honestly.
  t.equal(outcome.usage.tokensUsed, 12345, 'the token total from the successful run is carried')
  t.equal(
    outcome.usage.activeMs,
    100_000,
    'active time is summed across both stalled attempts (5s each) and the successful run (90s)'
  )
  t.equal(outcome.usage.attempts, 3, 'the attempt count reflects the two retries before success')
  t.end()
})

// After the last grace also stalls, the run is killed for good and the failure is surfaced —
// the operator's "then kill it permanently" — rather than retried forever.
test('makeReviewRunner gives up and throws once the final grace also stalls', async t => {
  let calls = 0
  const fakeRun: typeof runCodexReview = async opts => {
    calls += 1
    throw stall(opts.stallTimeoutMs)
  }
  const events: string[] = []
  const runner = makeReviewRunner(config([1000, 2000]), e => events.push(e), fakeRun)

  try {
    await runner(request)
    t.fail('a run that stalls on every attempt must reject')
  } catch (error) {
    t.ok(String(error).includes('stalled on every attempt (2)'), String(error))
    // The permanent failure still carries what the run cost, so the status totals and the error
    // thread can account for a run that burned time without producing a verdict.
    t.ok(error instanceof ReviewFailedError, 'a give-up throws a ReviewFailedError carrying usage')
    if (error instanceof ReviewFailedError) {
      t.equal(error.usage.attempts, 2, 'usage records both attempts were spent')
      t.equal(error.usage.activeMs, 10_000, 'active time is summed across both stalled attempts (5s each)')
      t.equal(error.usage.tokensUsed, undefined, 'a killed run reported no token total')
    }
  }
  t.equal(calls, 2, 'exactly the scheduled number of attempts were made')
  t.equal(events.filter(e => e === 'review.retry').length, 1, 'one retry between the two attempts')
  t.equal(events.filter(e => e === 'review.gave-up').length, 1, 'giving up was logged once')
  t.end()
})

// Only a stall is retryable. A crash or bad output will not fix itself on a re-run, so it is
// surfaced immediately without burning the rest of the schedule.
test('makeReviewRunner does not retry a non-stall failure', async t => {
  let calls = 0
  const fakeRun: typeof runCodexReview = async () => {
    calls += 1
    throw new Error('codex crashed')
  }
  const runner = makeReviewRunner(config([1000, 2000, 3000]), () => {}, fakeRun)

  try {
    await runner(request)
    t.fail('a crash must reject')
  } catch (error) {
    t.ok(String(error).includes('codex crashed'), String(error))
    // A crash is wrapped too, so the failure path always has a usage to report — here just the
    // single attempt, since a crash produces no token total or active-time snapshot.
    t.ok(error instanceof ReviewFailedError, 'a crash is wrapped in a ReviewFailedError')
    if (error instanceof ReviewFailedError) {
      t.equal(error.usage.attempts, 1, 'usage records the single attempt')
      t.equal(error.usage.tokensUsed, undefined, 'a crash reported no token total')
    }
  }
  t.equal(calls, 1, 'a non-stall failure is terminal — no retry')
  t.end()
})

// A timeout is terminal and never retried, but it spent its whole budget of active time before
// the kill. Regression for the usage gap where the timeout path fell through to `{ attempts }`
// with no activeMs at all, so a timed-out review reported as having cost no time.
test('makeReviewRunner reports the active time a timed-out run spent', async t => {
  const fakeRun: typeof runCodexReview = async () => {
    throw timeout(3_600_000)
  }
  const runner = makeReviewRunner(config([1000, 2000, 3000]), () => {}, fakeRun)

  try {
    await runner(request)
    t.fail('a timeout must reject')
  } catch (error) {
    t.ok(error instanceof ReviewFailedError, 'a timeout is wrapped in a ReviewFailedError')
    if (error instanceof ReviewFailedError) {
      t.equal(error.usage.attempts, 1, 'a timeout is terminal — one attempt, no retry')
      t.equal(error.usage.activeMs, 3_600_000, "the timeout's active time is carried onto the failure")
      t.equal(error.usage.tokensUsed, undefined, 'a killed run reported no token total')
    }
  }
  t.end()
})

// A stalled attempt that is retried and THEN times out must charge both spans — the accumulator
// must not reset between attempts. Regression for reporting only the final attempt's time.
test('makeReviewRunner sums a stalled attempt and a later timeout', async t => {
  let calls = 0
  const fakeRun: typeof runCodexReview = async () => {
    calls += 1
    throw calls === 1 ? stall(1000) : timeout(120_000)
  }
  const runner = makeReviewRunner(config([1000, 2000]), () => {}, fakeRun)

  try {
    await runner(request)
    t.fail('must reject once the retry also fails')
  } catch (error) {
    t.ok(error instanceof ReviewFailedError, 'wrapped in a ReviewFailedError')
    if (error instanceof ReviewFailedError) {
      t.equal(error.usage.activeMs, 125_000, 'the 5s stall and the 120s timeout are both charged')
      t.equal(error.usage.attempts, 2, 'the retry that then timed out is the second attempt')
    }
  }
  t.equal(calls, 2, 'the stall was retried, then the retry timed out')
  t.end()
})

// A completed run with unusable output is terminal, but it cost tokens and time. The failure
// must preserve BOTH — not report `tokens n/a` — or a run that consumed tokens vanishes from
// the status totals. Regression for the round-2 finding where a parse failure on the success
// path erased usage.
test('makeReviewRunner preserves tokens and active time from a bad-output failure', async t => {
  const fakeRun: typeof runCodexReview = async () => {
    throw badOutput(250_000, 60_000)
  }
  const runner = makeReviewRunner(config([1000, 2000]), () => {}, fakeRun)

  try {
    await runner(request)
    t.fail('bad output must reject')
  } catch (error) {
    t.ok(error instanceof ReviewFailedError, 'wrapped in a ReviewFailedError')
    if (error instanceof ReviewFailedError) {
      t.equal(error.usage.tokensUsed, 250_000, 'the token total the run printed is preserved')
      t.equal(error.usage.activeMs, 60_000, 'the active time is preserved')
      t.equal(error.usage.attempts, 1, 'bad output is terminal — one attempt, no retry')
    }
  }
  t.end()
})

// An empty schedule turns stall handling off entirely: one plain run, no output grace, no
// retries — the pre-stall behaviour, available to anyone who sets STALL_BACKOFF_MS empty.
test('makeReviewRunner runs once with no grace when the schedule is empty', async t => {
  const graces: (number | undefined)[] = []
  let calls = 0
  const fakeRun: typeof runCodexReview = async opts => {
    graces.push(opts.stallTimeoutMs)
    calls += 1
    return passed()
  }
  const runner = makeReviewRunner(config([]), () => {}, fakeRun)

  await runner(request)
  t.equal(calls, 1, 'exactly one attempt')
  t.deepEqual(graces, [undefined], 'no grace is passed, so the run does no stall detection')
  t.end()
})

// The runner feeds the live-status registry: it reports the attempt number for each try and
// forwards Codex output as progress, keyed by the same channel/ts the dispatcher uses.
test('makeReviewRunner reports attempt and output to the live-status registry', async t => {
  const attempts: Array<[string, number]> = []
  const outputs: Array<[string, string, number]> = []
  const reviews: import('./progress').ActiveReviews = {
    enqueue() {},
    start() {},
    done() {},
    attempt(key, n) { attempts.push([key, n]) },
    output(key, line, activeMs) { outputs.push([key, line, activeMs]) },
    snapshot() { return { active: [], waiting: [] } },
  }

  let calls = 0
  const fakeRun: typeof runCodexReview = async opts => {
    calls += 1
    opts.onProgress?.(`output from attempt ${calls}`, calls * 1000)
    if (calls < 2) throw stall(opts.stallTimeoutMs)
    return passed()
  }
  const runner = makeReviewRunner(config([1000, 2000]), () => {}, fakeRun, reviews)

  await runner(request)
  t.deepEqual(attempts, [['C1/1.1', 1], ['C1/1.1', 2]], 'attempt 1, then attempt 2 on the retry')
  t.deepEqual(
    outputs,
    [['C1/1.1', 'output from attempt 1', 1000], ['C1/1.1', 'output from attempt 2', 2000]],
    'output forwarded from both attempts, keyed by channel/ts'
  )
  t.end()
})

// The private-registry refresh (issue #42) must run before Codex is spawned, so the `npm ci`
// inside the run reads a fresh CodeArtifact token. A single-attempt run refreshes exactly once.
test('makeReviewRunner refreshes registry auth before running Codex', async t => {
  const order: string[] = []
  let refreshes = 0
  const refreshAuth = async (): Promise<void> => {
    refreshes += 1
    order.push('refresh')
  }
  const fakeRun: typeof runCodexReview = async () => {
    order.push('codex')
    return passed()
  }
  const runner = makeReviewRunner(config([]), () => {}, fakeRun, undefined, undefined, refreshAuth)

  await runner(request)
  t.deepEqual(order, ['refresh', 'codex'], 'refresh runs, then Codex')
  t.equal(refreshes, 1, 'refreshed once for a single-attempt request')
  t.end()
})

// Issue #44: the refresh must run before EVERY attempt, not once per request. A review that stalls
// and is retried across sleep cycles can run past the ≤12h CodeArtifact token TTL, so a retry that
// reuses the first attempt's token gets a 401 (the observed "npm ci authentication failed" / 401
// review outcomes). The login script self-caches by expiry, so a per-attempt refresh is a cheap
// no-op until the token actually needs re-minting — but the retry hours later does re-mint.
test('makeReviewRunner refreshes registry auth before every attempt', async t => {
  const order: string[] = []
  let refreshes = 0
  const refreshAuth = async (): Promise<void> => {
    refreshes += 1
    order.push('refresh')
  }
  let calls = 0
  const fakeRun: typeof runCodexReview = async opts => {
    order.push('codex')
    calls += 1
    if (calls < 2) throw stall(opts.stallTimeoutMs)
    return passed()
  }
  const runner = makeReviewRunner(config([1000, 2000]), () => {}, fakeRun, undefined, undefined, refreshAuth)

  await runner(request)
  t.deepEqual(order, ['refresh', 'codex', 'refresh', 'codex'], 'refresh precedes each attempt, including the retry')
  t.equal(refreshes, 2, 'refreshed once per attempt (the stalled first attempt and the succeeding retry)')
  t.end()
})

// The refresh is optional: a runner wired without it (unit tests, dry runs) must still work and
// never touch a registry — proving the daemon needs no live AWS to be exercised.
test('makeReviewRunner runs without a refresh hook', async t => {
  const fakeRun: typeof runCodexReview = async () => passed()
  const runner = makeReviewRunner(config([]), () => {}, fakeRun)
  const { result } = await runner(request)
  t.equal(result.results[0].status, 'passed', 'review completes with no refresh wired')
  t.end()
})

// ENGINE_AUTH (issue #69): single mode mints Bedrock credentials per attempt, after the registry
// refresh, keyed by the attempt's runId, so a stall retry gets a fresh session.
test('makeReviewRunner resolves Bedrock auth before every attempt and passes it to Codex', async t => {
  const order: string[] = []
  const engineAuth = async (engine: 'codex' | 'claude', runId: string) => {
    order.push(`auth:${engine}:${runId}`)
    return { region: 'us-east-2', model: 'm', credentials: { accessKeyId: runId, secretAccessKey: 'fake-secret-' + 'xyz' } }
  }
  const seen: string[] = []
  let calls = 0
  const fakeRun: typeof runCodexReview = async opts => {
    order.push('codex')
    seen.push(opts.bedrock?.credentials.accessKeyId ?? 'none')
    calls += 1
    if (calls < 2) throw stall(opts.stallTimeoutMs)
    return passed()
  }
  const runner = makeReviewRunner(config([1000, 2000]), () => {}, fakeRun, undefined, undefined, async () => {
    order.push('refresh')
  }, engineAuth)
  await runner(request)
  t.deepEqual(order, ['refresh', 'auth:codex:C1-11', 'codex', 'refresh', 'auth:codex:C1-11.retry1', 'codex'])
  t.deepEqual(seen, ['C1-11', 'C1-11.retry1'], 'each attempt runs with its own credentials')
  t.end()
})

// A failed mint is terminal: no Codex run, no retry, and a failure carrying the (credential-free)
// reason, so the Slack thread says why instead of the review silently using the subscription.
test('makeReviewRunner fails the review without running Codex when auth fails', async t => {
  let runs = 0
  let resolves = 0
  const fakeRun: typeof runCodexReview = async () => {
    runs += 1
    return passed()
  }
  const engineAuth = async () => {
    resolves += 1
    throw new Error('could not assume the engine role: ExpiredToken')
  }
  const runner = makeReviewRunner(config([1000, 2000]), () => {}, fakeRun, undefined, undefined, undefined, engineAuth)
  try {
    await runner(request)
    t.fail('should throw')
  } catch (error) {
    t.ok(error instanceof ReviewFailedError, 'a review failure')
    t.match(String((error as ReviewFailedError).cause ?? error), /ExpiredToken/)
    t.equal((error as ReviewFailedError).usage.attempts, 1)
  }
  t.equal(runs, 0, 'Codex never ran')
  t.equal(resolves, 1, 'not retried')
  t.end()
})

// The daemon wires one resolver for every mode; the selector must thread it to the single-mode
// runner, or bedrock mode would silently run on the subscription.
test('selectReviewRunner threads engineAuth to the single-mode runner', async t => {
  let asked = 0
  const runner = selectReviewRunner(
    { ...loadReviewConfig({ HOME: '/home/u', RUN_LOG_DIR: '', STALL_BACKOFF_MS: '' }), codexBin: '/nonexistent/codex-for-test' },
    {
      engineAuth: async () => {
        asked += 1
        throw new Error('stop before spawning')
      },
    }
  )
  await runner(request).catch(() => undefined)
  t.equal(asked, 1, 'the resolver was called')
  t.end()
})

// --- Mode selection and dual wiring ---

const dualConfig = loadReviewConfig({
  HOME: '/home/u',
  REVIEW_ENGINES: 'codex,claude',
  ENGINE_ORDER: 'claude,codex',
  ENGINE_SCHEDULE: 'serial',
  APPROVER_GH_TOKEN: 'approver-placeholder',
  ENGINE_GH_TOKEN: 'engine-placeholder',
  RUN_LOG_DIR: '',
})

// Dual mode stays refused until the flip checklist is done (issue 64). The runner selection is a
// second guard behind startup. Regression caught: a code path that runs dual mode while the
// approver token is still readable by engine children.
test('selectReviewRunner refuses dual mode while it is unavailable', t => {
  t.throws(() => selectReviewRunner(dualConfig), /issues\/64/)
  t.doesNotThrow(() => selectReviewRunner(loadReviewConfig({ HOME: '/home/u' })), 'single mode is unaffected')
  t.end()
})

// The whole dual wiring through the availability seam: engines in ENGINE_ORDER, serial schedule,
// the role-account client for posting, and both engines given the engine token. A clean result
// from both approves with commit_id. Regression caught: the selector building the engines in the
// wrong order or handing them the approver token.
test('selectReviewRunner wires the dual gate when dual mode is available', async t => {
  const sha = '4'.repeat(40)
  const order: string[] = []
  const tokens: (string | undefined)[] = []
  const clean = (prs: { url: string }[]) => ({
    results: prs.map(p => ({ url: p.url, reviewedSha: sha, verdict: 'clean', findings: [], summary: '', environmentProblems: [] })),
  })
  const posted: string[] = []
  const gh = {
    login: async () => 'role-bot',
    getPullRequest: async () => ({ author: 'dev', base: 'main', baseRepo: 'o/r', headRef: 'x', headSha: sha, headRepo: 'o/r', state: 'open', draft: false }),
    permission: async () => 'write',
    branchRules: async () => [],
    classicProtection: async () => null,
    reviews: async () => [],
    behindBy: async () => 0,
    botReviews: async () => [],
    commentableLines: async () => new Map(),
    postReview: async (_pr: unknown, r: { event: string; commitId: string }) => {
      posted.push(`${r.event}@${r.commitId}`)
      return { id: 1, url: 'u' }
    },
    decision: async () => ({ reviewDecision: null, mergeStateStatus: 'CLEAN' }),
  } as unknown as ApproverGitHub
  const runner = selectReviewRunner(
    dualConfig,
    {
      gh,
      listChangedFiles: async () => ['a.ts'],
      engineDeps: {
        runCodex: (async (o: { engineGhToken?: string }) => {
          order.push('codex')
          tokens.push(o.engineGhToken)
          return { result: clean(request.prs), rawFinalMessage: '', activeMs: 1 }
        }) as never,
        runClaude: (async (o: { engineGhToken: string }) => {
          order.push('claude')
          tokens.push(o.engineGhToken)
          const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, numTurns: 0, durationMs: 0 }
          return { result: clean(request.prs), usage, tokensUsed: 0, activeMs: 1, permissionDenials: 0 }
        }) as never,
      },
    },
    true
  )
  const out = await runner(request)
  t.deepEqual(order, ['claude', 'codex'], 'ENGINE_ORDER, serially')
  t.deepEqual(tokens, ['engine-placeholder', 'engine-placeholder'], 'engines get the read-only token, never the approver token')
  t.deepEqual(posted, [`APPROVE@${sha}`])
  t.equal(out.dual?.prs[0].outcome, 'approved')
  t.end()
})

/** A role-account fake whose PR is open at `sha` and needs no update; posts land in `posted`. */
function fakeApprover(sha: string, posted: string[]): ApproverGitHub {
  return {
    login: async () => 'role-bot',
    getPullRequest: async () => ({ author: 'dev', base: 'main', baseRepo: 'o/r', headRef: 'x', headSha: sha, headRepo: 'o/r', state: 'open', draft: false }),
    permission: async () => 'write',
    branchRules: async () => [],
    classicProtection: async () => null,
    reviews: async () => [],
    behindBy: async () => 0,
    botReviews: async () => [],
    commentableLines: async () => new Map(),
    postReview: async (_pr: unknown, r: { event: string; commitId: string }) => {
      posted.push(`${r.event}@${r.commitId}`)
      return { id: 1, url: 'u' }
    },
    decision: async () => ({ reviewDecision: null, mergeStateStatus: 'CLEAN' }),
  } as unknown as ApproverGitHub
}

// Parallel wiring details the first wiring test does not see: each engine gets its own worktree
// root under WORKTREE_ROOT, the Claude engine runs under the dedicated profile directory, and the
// per-attempt CodeArtifact refresh is serialized across the two engines. Regression caught: two
// engines sharing one checkout/node_modules, Claude running under the operator's own profile, or
// two concurrent refreshes racing on the shared npm user config.
test('selectReviewRunner gives each engine its own worktree root, the Claude profile, and a serialized refresh', async t => {
  const sha = '5'.repeat(40)
  const roots: Record<string, string> = {}
  let configDir: string | undefined
  let refreshing = 0
  let maxRefreshing = 0
  let refreshes = 0
  const refreshAuth = async () => {
    refreshing += 1
    refreshes += 1
    maxRefreshing = Math.max(maxRefreshing, refreshing)
    await new Promise(resolve => setTimeout(resolve, 5))
    refreshing -= 1
  }
  const clean = (prs: { url: string }[]) => ({
    results: prs.map(p => ({ url: p.url, reviewedSha: sha, verdict: 'clean', findings: [], summary: '', environmentProblems: [] })),
  })
  const posted: string[] = []
  const runner = selectReviewRunner(
    { ...dualConfig, engineSchedule: 'parallel', worktreeRoot: '/tmp/wt-root', claudeConfigDir: '/tmp/claude-profile' },
    {
      gh: fakeApprover(sha, posted),
      listChangedFiles: async () => ['a.ts'],
      refreshAuth,
      engineDeps: {
        runCodex: (async (o: { worktreeRoot: string }) => {
          roots.codex = o.worktreeRoot
          return { result: clean(request.prs), rawFinalMessage: '', activeMs: 1 }
        }) as never,
        runClaude: (async (o: { worktreeRoot: string; configDir: string }) => {
          roots.claude = o.worktreeRoot
          configDir = o.configDir
          const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, numTurns: 0, durationMs: 0 }
          return { result: clean(request.prs), usage, tokensUsed: 0, activeMs: 1, permissionDenials: 0 }
        }) as never,
      },
    },
    true
  )
  const out = await runner(request)
  t.deepEqual(roots, { codex: '/tmp/wt-root/codex', claude: '/tmp/wt-root/claude' }, 'per-engine worktree roots')
  t.equal(configDir, '/tmp/claude-profile', 'the Claude engine receives claudeConfigDir')
  t.equal(refreshes, 2, 'each engine refreshed before its attempt')
  t.equal(maxRefreshing, 1, 'the refreshes never overlapped')
  t.deepEqual(posted, [`APPROVE@${sha}`])
  t.equal(out.dual?.prs[0].outcome, 'approved')
  t.end()
})

// The selector is a second guard behind config loading for the token split. Regression caught: a
// config built without loadReviewConfig (or with its checks bypassed) running dual mode with no
// engine token, no approver token, or the approver token handed to the engines.
test('selectReviewRunner refuses dual mode without two distinct GitHub tokens', t => {
  const deps = { gh: fakeApprover('6'.repeat(40), []), listChangedFiles: async () => [] }
  t.throws(() => selectReviewRunner({ ...dualConfig, engineGhToken: '' }, deps, true), /requires ENGINE_GH_TOKEN/, 'empty engine token')
  t.throws(() => selectReviewRunner({ ...dualConfig, engineGhToken: undefined as unknown as string }, deps, true), /requires ENGINE_GH_TOKEN/, 'missing engine token')
  t.throws(() => selectReviewRunner({ ...dualConfig, approverGhToken: '' }, deps, true), /requires APPROVER_GH_TOKEN/, 'empty approver token')
  t.throws(() => selectReviewRunner({ ...dualConfig, approverGhToken: undefined as unknown as string }, deps, true), /requires APPROVER_GH_TOKEN/, 'missing approver token')
  t.throws(() => selectReviewRunner({ ...dualConfig, approverGhToken: 'same', engineGhToken: 'same' }, deps, true), /to differ/, 'equal tokens')
  t.doesNotThrow(() => selectReviewRunner(dualConfig, deps, true), 'distinct tokens are accepted')
  t.end()
})

// Two parallel engines refreshing the CodeArtifact token at once would race on one shared
// config file; serialized() runs them one after the other.
test('serialized runs concurrent calls one at a time', async t => {
  let running = 0
  let maxRunning = 0
  const step = serialized(async () => {
    running += 1
    maxRunning = Math.max(maxRunning, running)
    await new Promise(resolve => setImmediate(resolve))
    running -= 1
  })
  await Promise.all([step(), step(), step()])
  t.equal(maxRunning, 1)
  t.end()
})

// Ruling 2: the launchd runner (single mode, no engines list) must carry Codex usage, summed over a
// stalled attempt and the success, or a bedrock launchd install's ledger records only noUsage. The
// success tokensUsed is the sum across attempts too (spec 6), matching the summed usage. Regression
// caught: usage or tokens from the stalled first attempt dropped, or only the last attempt reported.
test('makeReviewRunner carries Codex usage summed across a stall and the success', async t => {
  const first = { inputTokens: 100, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 10, reasoningTokens: 0 }
  const second = { inputTokens: 30, cachedInputTokens: 5, cacheWriteTokens: 0, outputTokens: 3, reasoningTokens: 1 }
  let calls = 0
  const fakeRun: typeof runCodexReview = async opts => {
    calls += 1
    if (calls === 1) throw new CodexStalledError('stalled', opts.stallTimeoutMs ?? 0, { activeMs: 5000, wallMs: 5000, frozenMs: 0 }, first)
    return { ...passed(), tokensUsed: 39, codexUsage: second }
  }
  const outcome = await makeReviewRunner(config([1000, 2000]), undefined, fakeRun)(request)
  t.deepEqual(outcome.usage.codex, { inputTokens: 130, cachedInputTokens: 5, cacheWriteTokens: 0, outputTokens: 13, reasoningTokens: 1 })
  t.equal(outcome.usage.tokensUsed, 110 + 39, 'tokensUsed sums both attempts, matching the summed codex usage')
  t.end()
})

// The give-up path must carry every attempt's Codex usage too: a review that stalled twice still spent.
// Regression caught: a give-up reported as free.
test('makeReviewRunner keeps Codex usage on a give-up', async t => {
  const each = { inputTokens: 20, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 2, reasoningTokens: 0 }
  const fakeRun: typeof runCodexReview = async opts => {
    throw new CodexStalledError('stalled', opts.stallTimeoutMs ?? 0, { activeMs: 5000, wallMs: 5000, frozenMs: 0 }, each)
  }
  try {
    await makeReviewRunner(config([1000, 2000]), undefined, fakeRun)(request)
    t.fail('a run that stalls on every attempt must reject')
  } catch (error) {
    t.ok(error instanceof ReviewFailedError)
    if (error instanceof ReviewFailedError) {
      t.deepEqual(error.usage.codex, { inputTokens: 40, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 4, reasoningTokens: 0 })
    }
  }
  t.end()
})
