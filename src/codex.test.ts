import { EventEmitter } from 'events'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { PassThrough } from 'stream'
import test from 'tape'
import {
  buildCodexArgs,
  CodexStalledError,
  CodexTimeoutError,
  describeStall,
  describeTimeout,
  runCodexReview,
  stripSecretsFromEnv,
  withGitSigningDisabled,
  type Spawner,
} from './codex'

function argValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag)
  return index === -1 ? undefined : args[index + 1]
}

// Every one of these flags is load-bearing. Losing --profile silently reverts the run
// to the interactive config, where approval_policy is "on-request" and the sandbox has
// no network — the run then hangs on the first approval prompt or fails on DNS.
test('buildCodexArgs selects the bot profile, workspace, and worktree root', t => {
  const args = buildCodexArgs({
    profile: 'review-bot',
    workspaceRoot: '/home/u/src',
    worktreeRoot: '/private/tmp/codex-pr-review',
    schemaPath: '/tmp/s.json',
    outputPath: '/tmp/o.json',
    prompt: 'do the thing',
  })
  t.equal(args[0], 'exec')
  t.equal(argValue(args, '--profile'), 'review-bot')
  t.equal(argValue(args, '--cd'), '/home/u/src')
  t.equal(argValue(args, '--add-dir'), '/private/tmp/codex-pr-review')
  t.equal(argValue(args, '--output-schema'), '/tmp/s.json')
  t.equal(argValue(args, '--output-last-message'), '/tmp/o.json')
  t.equal(args[args.length - 1], 'do the thing', 'prompt is the trailing positional')
  t.end()
})

// The workspace root is a directory of checkouts, not a repository. Without this flag
// codex exec refuses to start at all.
test('buildCodexArgs skips the git repo check', t => {
  const args = buildCodexArgs({
    profile: 'p', workspaceRoot: '/w', worktreeRoot: '/t',
    schemaPath: '/s', outputPath: '/o', prompt: 'x',
  })
  t.ok(args.includes('--skip-git-repo-check'))
  t.end()
})

// The Codex profile sets shell_environment_policy.inherit = "all", so anything left in
// the daemon's environment is visible to model-generated shell commands. The bot's
// Slack tokens must not be among them.
test('stripSecretsFromEnv removes the Slack credentials and keeps everything else', t => {
  const env = stripSecretsFromEnv({
    SLACK_BOT_TOKEN: 'xoxb-secret',
    SLACK_APP_TOKEN: 'xapp-secret',
    PATH: '/usr/bin',
    HOME: '/home/u',
  })
  t.equal(env.SLACK_BOT_TOKEN, undefined)
  t.equal(env.SLACK_APP_TOKEN, undefined)
  t.equal(env.PATH, '/usr/bin', 'PATH survives — gh, git and npm need it')
  t.equal(env.HOME, '/home/u')
  t.end()
})

// commit.gpgsign is true globally and the GPG agent caches for ten minutes behind
// pinentry-mac. An unattended test commit with a cold cache pops a GUI dialog and hangs
// the run for its whole timeout, so signing is disabled for Codex's children only.
test('withGitSigningDisabled sets commit.gpgsign=false via the git env protocol', t => {
  const env = withGitSigningDisabled({ PATH: '/usr/bin' })
  t.equal(env.GIT_CONFIG_COUNT, '1')
  t.equal(env.GIT_CONFIG_KEY_0, 'commit.gpgsign')
  t.equal(env.GIT_CONFIG_VALUE_0, 'false')
  t.end()
})

// Appending at index 0 would silently drop a pre-existing GIT_CONFIG_KEY_0 from the
// caller's environment — git reads pairs 0..COUNT-1, so the overwritten setting just
// disappears.
test('withGitSigningDisabled appends after existing GIT_CONFIG pairs', t => {
  const env = withGitSigningDisabled({
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'user.name',
    GIT_CONFIG_VALUE_0: 'Bot',
  })
  t.equal(env.GIT_CONFIG_COUNT, '2')
  t.equal(env.GIT_CONFIG_KEY_0, 'user.name', 'existing pair untouched')
  t.equal(env.GIT_CONFIG_KEY_1, 'commit.gpgsign')
  t.equal(env.GIT_CONFIG_VALUE_1, 'false')
  t.end()
})

// A malformed GIT_CONFIG_COUNT must not produce GIT_CONFIG_KEY_NaN, which git ignores —
// leaving signing on and re-introducing the pinentry hang.
test('withGitSigningDisabled recovers from a non-numeric GIT_CONFIG_COUNT', t => {
  const env = withGitSigningDisabled({ GIT_CONFIG_COUNT: 'oops' })
  t.equal(env.GIT_CONFIG_COUNT, '1')
  t.equal(env.GIT_CONFIG_KEY_0, 'commit.gpgsign')
  t.end()
})

/**
 * A stand-in for the `codex exec` child: never exits on its own, records the signal it was
 * sent, and can be made to finish with a final message on demand. `pid` is deliberately
 * undefined so the kill path signals this handle instead of a real process group.
 */
class FakeChild extends EventEmitter {
  pid: number | undefined = undefined
  stdout = new PassThrough()
  stderr = new PassThrough()
  signals: string[] = []
  kill(signal?: NodeJS.Signals | number): boolean {
    this.signals.push(String(signal))
    // As a real SIGTERM would, end the process — `close` is what the run awaits.
    this.emit('close', null)
    return true
  }
}

/** A clock the test advances by hand, standing in for both Date.now and the heartbeat. */
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

function runOptions(log?: (event: string, fields: Record<string, unknown>) => void) {
  return {
    prompt: 'review',
    codexBin: 'codex',
    profile: 'review-bot',
    workspaceRoot: os.tmpdir(),
    worktreeRoot: fs.mkdtempSync(path.join(os.tmpdir(), 'codex-test-worktrees-')),
    timeoutMs: 60_000,
    disableGitSigning: false,
    runId: 'test',
    log,
  }
}

const settle = () => new Promise(resolve => setImmediate(resolve))

// The regression that motivated the deadline: a run in flight across a closed lid was killed
// for "exceeding" a budget it had barely touched. Four hours of wall clock in one gap must
// leave the budget almost untouched, and the kill must come only after that much *active*
// time — with the log and the error both saying how much was discounted.
test('runCodexReview does not charge a machine-asleep gap against the run timeout', async t => {
  const child = new FakeChild()
  const spawner = (() => child) as unknown as Spawner
  const clock = fakeClock()
  const frozen: Record<string, unknown>[] = []
  const log = (event: string, fields: Record<string, unknown>) => {
    if (event === 'codex.frozen') frozen.push(fields)
  }

  // The rejection lands on the tick that kills, before this test gets back to await it; a
  // handler attached up front keeps it from surfacing as an unhandled rejection meanwhile.
  const run = runCodexReview(runOptions(log), spawner, clock.deps).then(
    () => undefined,
    (error: unknown) => error
  )
  await settle()

  clock.tick(10_000)
  clock.tick(4 * 60 * 60 * 1000) // asleep for four hours
  await settle()
  t.deepEqual(child.signals, [], 'a one-minute budget survives a four-hour sleep')
  t.equal(frozen.length, 1, 'the suspension is logged once')
  t.equal(frozen[0].runId, 'test')
  t.equal(frozen[0].remainingMs, 40_000, 'the sleep cost one heartbeat, not four hours')

  for (let i = 0; i < 4; i += 1) clock.tick(10_000)
  await settle()
  t.deepEqual(child.signals, ['SIGTERM'], 'killed once sixty seconds of active time are spent')

  const error = await run
  t.ok(error !== undefined, 'a killed run must reject')
  // A distinct error type carrying the deadline snapshot, so the caller can charge the active time
  // the run spent before the kill rather than reporting a timed-out run as free.
  t.ok(error instanceof CodexTimeoutError, 'it rejects with CodexTimeoutError')
  t.ok(String(error).includes('exceeded the 1 minute timeout'), String(error))
  t.ok(String(error).includes('asleep were not counted'), 'the error accounts for the discounted time')
  if (error instanceof CodexTimeoutError) {
    t.ok(error.snapshot.activeMs >= 60_000, 'the snapshot carries the active time the run spent')
  }
  t.end()
})

// The ordinary path must be unaffected: a run that finishes releases its deadline and its
// final message is parsed. A deadline left ticking after `close` would fire later against a
// handle that no longer maps to anything.
test('runCodexReview returns the parsed final message and stops the deadline on exit', async t => {
  const child = new FakeChild()
  let outputPath = ''
  const spawner = ((_bin: string, args: string[]) => {
    outputPath = args[args.indexOf('--output-last-message') + 1]
    return child
  }) as unknown as Spawner
  const clock = fakeClock()

  const run = runCodexReview(runOptions(), spawner, clock.deps)
  await settle()
  clock.tick(10_000)
  fs.writeFileSync(
    outputPath,
    JSON.stringify({
      results: [{ url: 'https://github.com/o/r/pull/1', status: 'passed', summary: '', pushedTestCommits: false, reviewUrl: '' }],
    })
  )
  child.emit('close', 0)
  const outcome = await run
  t.equal(outcome.result.results[0].status, 'passed')

  // Enough ticks to have expired the budget had the deadline still been running.
  for (let i = 0; i < 10; i += 1) clock.tick(10_000)
  t.deepEqual(child.signals, [], 'no signal after the run has already finished')
  t.end()
})

// The run has to surface what it cost: Codex's "tokens used" total, parsed out of the
// transcript, and the active time the deadline charged. This is what the status totals and the
// per-review thread line are built from.
test('runCodexReview reports the token total and active time on a completed run', async t => {
  const child = new FakeChild()
  let outputPath = ''
  const spawner = ((_bin: string, args: string[]) => {
    outputPath = args[args.indexOf('--output-last-message') + 1]
    return child
  }) as unknown as Spawner
  const clock = fakeClock()

  const run = runCodexReview(runOptions(), spawner, clock.deps)
  await settle()
  clock.tick(10_000) // one heartbeat of active time
  // Codex prints its running total to the transcript; the two-line form is what `codex exec` emits.
  child.stdout.write('reviewing...\ntokens used\n300,448\n')
  await settle()
  fs.writeFileSync(
    outputPath,
    JSON.stringify({
      results: [{ url: 'https://github.com/o/r/pull/1', status: 'passed', summary: '', pushedTestCommits: false, reviewUrl: '' }],
    })
  )
  child.emit('close', 0)
  const outcome = await run
  t.equal(outcome.tokensUsed, 300_448, 'the token total is parsed from the transcript')
  t.equal(outcome.activeMs, 10_000, 'the active time charged to the run is reported')
  t.end()
})

// A run that printed no total (the normal shape of a killed run, but also possible on a clean
// exit) reports undefined tokens rather than a misleading zero.
test('runCodexReview reports undefined tokens when the run printed no total', async t => {
  const child = new FakeChild()
  let outputPath = ''
  const spawner = ((_bin: string, args: string[]) => {
    outputPath = args[args.indexOf('--output-last-message') + 1]
    return child
  }) as unknown as Spawner
  const clock = fakeClock()

  const run = runCodexReview(runOptions(), spawner, clock.deps)
  await settle()
  fs.writeFileSync(
    outputPath,
    JSON.stringify({
      results: [{ url: 'https://github.com/o/r/pull/1', status: 'passed', summary: '', pushedTestCommits: false, reviewUrl: '' }],
    })
  )
  child.emit('close', 0)
  const outcome = await run
  t.equal(outcome.tokensUsed, undefined, 'no total printed means no figure, not zero')
  t.end()
})

// A run that has printed nothing for its whole grace is wedged, not slow. It must be killed
// and rejected with the typed error the runner retries on — and, like the timeout, measured in
// active time so a closed lid is never mistaken for silence.
test('runCodexReview kills a silent run and rejects with CodexStalledError', async t => {
  const child = new FakeChild()
  const spawner = (() => child) as unknown as Spawner
  const clock = fakeClock()
  const stalled: Record<string, unknown>[] = []
  const log = (event: string, fields: Record<string, unknown>) => {
    if (event === 'codex.stalled') stalled.push(fields)
  }

  const run = runCodexReview({ ...runOptions(log), stallTimeoutMs: 40_000 }, spawner, clock.deps).then(
    () => 'resolved',
    (error: unknown) => error
  )
  await settle()

  for (let i = 0; i < 3; i += 1) clock.tick(10_000) // 30s of silence, under the 40s grace
  t.deepEqual(child.signals, [], 'not killed before the grace is spent')
  clock.tick(10_000) // 40s: the grace is up
  await settle()

  const outcome = await run
  t.ok(outcome instanceof CodexStalledError, 'a stall rejects with the typed, retryable error')
  t.equal((outcome as CodexStalledError).stallMs, 40_000, 'the error carries the grace it exceeded')
  t.deepEqual(child.signals, ['SIGTERM'], 'the process tree was signalled to stop')
  t.equal(stalled.length, 1, 'the stall was logged once')
  t.equal(stalled[0].runId, 'test')
  t.end()
})

// The wiring that makes the grace mean "silent", not "slow": every chunk of output resets the
// clock, so a run that keeps talking is never killed even long past the grace from its start.
test('runCodexReview does not kill a run that keeps producing output', async t => {
  const child = new FakeChild()
  const spawner = (() => child) as unknown as Spawner
  const clock = fakeClock()

  // A budget far larger than the run, so only a stall (not the timeout) could kill it here.
  const run = runCodexReview(
    { ...runOptions(), timeoutMs: 10 * 60_000, stallTimeoutMs: 40_000 },
    spawner,
    clock.deps
  ).then(
    () => 'resolved',
    (error: unknown) => String(error)
  )
  await settle()

  // Talk every 30s for well past the 40s grace measured from the start: 18 silent ticks would
  // otherwise cross the grace six times over.
  for (let i = 0; i < 6; i += 1) {
    clock.tick(10_000)
    clock.tick(10_000)
    clock.tick(10_000)
    child.stdout.write(`progress ${i}\n`)
    await settle()
  }
  t.deepEqual(child.signals, [], 'a run that keeps printing is never judged stalled')
  t.end()
})

// The status reply's live feed: each chunk of output is reported with its text and the run's
// active time so far, so a watcher can see what the review is doing right now.
test('runCodexReview reports output progress with the active time', async t => {
  const child = new FakeChild()
  let outputPath = ''
  const spawner = ((_bin: string, args: string[]) => {
    outputPath = args[args.indexOf('--output-last-message') + 1]
    return child
  }) as unknown as Spawner
  const clock = fakeClock()
  const progress: Array<{ line: string; activeMs: number }> = []

  const run = runCodexReview(
    { ...runOptions(), timeoutMs: 10 * 60_000, onProgress: (line, activeMs) => progress.push({ line, activeMs }) },
    spawner,
    clock.deps
  )
  await settle()

  clock.tick(10_000) // ten seconds of active time
  child.stdout.write('reading files\nrunning jest\n')
  await settle()

  t.equal(progress.length, 1, 'one report per output chunk')
  t.ok(progress[0].line.includes('running jest'), 'carries the output text')
  t.equal(progress[0].activeMs, 10_000, 'with the active time at that moment')

  fs.writeFileSync(
    outputPath,
    JSON.stringify({
      results: [{ url: 'https://github.com/o/r/pull/1', status: 'passed', summary: '', pushedTestCommits: false, reviewUrl: '' }],
    })
  )
  child.emit('close', 0)
  await run
  t.end()
})

// The thread's error line is what a requester sees when every retry stalled. It is phrased in
// active time, since a run silent across a closed lid was not really silent for that span.
test('describeStall states the grace and how far into the run it gave up', t => {
  t.equal(
    describeStall(2 * 60_000, { activeMs: 2 * 60_000, wallMs: 2 * 60_000, frozenMs: 0 }),
    'Codex produced no output for 2 minutes of active time and was killed as stalled (2 minutes of active time into the run)'
  )
  t.end()
})

// The thread's error line is the only place a requester learns why the review died. Next to
// a message posted four hours ago, "exceeded three hours" needs the discount spelled out; a
// run that never slept should not carry the clause at all.
test('describeTimeout spells out the discounted sleep only when there was one', t => {
  const H = 60 * 60 * 1000
  t.equal(
    describeTimeout(3 * H, { activeMs: 3 * H, wallMs: 3 * H, frozenMs: 0 }),
    'Codex run exceeded the 180 minute timeout and was killed'
  )
  t.equal(
    describeTimeout(3 * H, { activeMs: 3 * H, wallMs: 5 * H, frozenMs: 2 * H }),
    'Codex run exceeded the 180 minute timeout and was killed (300 minutes by the wall clock, of which 120 minutes with the machine asleep were not counted)'
  )
  t.end()
})
