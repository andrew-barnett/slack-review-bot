import { EventEmitter } from 'events'
import test from 'tape'
import { engineSessionSeconds } from './bedrock-auth'
import { verifyTicket } from './jobs/ticket'
import {
  backoffMs,
  composeRunArgs,
  createLauncher,
  dockerEnv,
  loadLauncherSettings,
  makeAwsOps,
  makeDockerOps,
  ORCHESTRATOR_NAME,
  WORKER_FAST_EXIT_MS,
  type AwsOps,
  type DockerOps,
  type LauncherDeps,
  type LauncherSettings,
} from './launcher'

const fast: LauncherSettings = {
  ...loadLauncherSettings({ HOME: '/Users/op' }),
  workerSlots: 2,
  shutdownDrainMs: 40,
  shutdownGraceMs: 0,
  hardBoundSlackMs: 0,
  workerStopGraceMs: 30,
  workerRestartMs: 1,
  backoffBaseMs: 1,
  backoffMaxMs: 4,
  killWaitMs: 30,
}
const until = async (cond: () => boolean, ms = 2000) => {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting')
    await new Promise(resolve => setTimeout(resolve, 2))
  }
}
const secrets: Record<string, string> = {
  '/slack-review-bot/SLACK_BOT_TOKEN': 'bot-placeholder',
  '/slack-review-bot/SLACK_APP_TOKEN': 'app-placeholder',
  '/slack-review-bot/APPROVER_GH_TOKEN': 'approver-placeholder',
  '/slack-review-bot/ENGINE_GH_TOKEN': 'engine-placeholder',
}

function fakeAws(over: Partial<AwsOps> = {}): AwsOps {
  let n = 0
  return {
    assumeRole: async () => ({ accessKeyId: `id-${++n}`, secretAccessKey: `key-${n}`, sessionToken: `session-${n}` }),
    getSecret: async (_c, id) => secrets[id],
    codeartifactToken: async () => 'npm-placeholder',
    ...over,
  }
}

/**
 * Containers that live until signalled. The orchestrator exits `orchTermMs` after SIGTERM (null:
 * it ignores SIGTERM); workers exit on SIGTERM when `workersObeyTerm`. SIGKILL works unless
 * `orchIgnoresKill` / `workersIgnoreKill` (a docker CLI that never reports the exit). `workerExit`
 * makes the nth run (from 1) of a worker exit at once with the returned code (undefined: stay up).
 */
function fakeDocker(
  opts: {
    orchTermMs?: number | null
    workersObeyTerm?: boolean
    orchIgnoresKill?: boolean
    workersIgnoreKill?: boolean
    workerExit?: (name: string, n: number) => number | undefined
    rmFails?: boolean
  } = {}
) {
  const events: string[] = []
  const bundles = new Map<string, string>()
  const live = new Map<string, (code: number) => void>()
  const runs = new Map<string, number>()
  const docker: DockerOps = {
    run(_service, name, bundle) {
      events.push(`run ${name}`)
      bundles.set(name, bundle)
      const n = (runs.get(name) ?? 0) + 1
      runs.set(name, n)
      let done = false
      const exited = new Promise<number>(resolve => {
        live.set(name, code => {
          if (done) return
          done = true
          live.delete(name)
          events.push(`exit ${name}`)
          resolve(code)
        })
      })
      const code = name === ORCHESTRATOR_NAME ? undefined : opts.workerExit?.(name, n)
      if (code !== undefined) live.get(name)!(code)
      return { name, exited }
    },
    async signal(name, signal) {
      events.push(`${signal} ${name}`)
      const exit = live.get(name)
      if (!exit) return
      if (signal === 'SIGKILL') {
        if (name === ORCHESTRATOR_NAME ? opts.orchIgnoresKill : opts.workersIgnoreKill) return
        return exit(137)
      }
      if (name === ORCHESTRATOR_NAME) {
        const ms = opts.orchTermMs === undefined ? 10 : opts.orchTermMs
        if (ms !== null) setTimeout(() => exit(0), ms)
      } else if (opts.workersObeyTerm !== false) {
        exit(143)
      }
    },
    async removeForce(name) {
      events.push(`rm ${name}`)
      // Only the per-slot removal is made to fail; the start-up cleanup is not under test here.
      if (opts.rmFails && name === 'slack-review-bot-worker-0') throw new Error('Error response from daemon: removal of container is already in progress')
    },
    async listByPrefix() {
      events.push('ps workers')
      return ['slack-review-bot-worker-7']
    },
  }
  return { docker, events, bundles, exit: (name: string, code: number) => live.get(name)?.(code) }
}

function deps(d: DockerOps, over: Partial<LauncherDeps> = {}): LauncherDeps & { logs: [string, Record<string, unknown>][] } {
  const logs: [string, Record<string, unknown>][] = []
  return {
    logs,
    settings: fast,
    aws: fakeAws(),
    docker: d,
    log: (event, fields = {}) => void logs.push([event, fields]),
    now: Date.now,
    randomKey: () => Buffer.alloc(32, 5),
    ...over,
  }
}

// Review Focus 5 / ruling 10: a launcher restarted after a crash must remove a leftover
// orchestrator first (it could still be double-reviewing), then leftover workers, and only then
// start anything. Regression caught: `run --name` failing on the stale name, or two orchestrators.
test('launcher removes the stale orchestrator before stale workers and before starting anything', async t => {
  const f = fakeDocker()
  const launcher = createLauncher(deps(f.docker))
  const done = launcher.start()
  await until(() => f.events.includes('run slack-review-bot-worker-1'))
  t.deepEqual(f.events.slice(0, 4), [`rm ${ORCHESTRATOR_NAME}`, 'ps workers', 'rm slack-review-bot-worker-7', `run ${ORCHESTRATOR_NAME}`])
  launcher.requestStop()
  t.equal(await done, 0)
  t.end()
})

// Spec 3.6 step 1: the two role tokens must differ, or the engine could write as the approver.
test('launcher refuses identical approver and engine tokens and starts nothing', async t => {
  const f = fakeDocker()
  const same = fakeAws({ getSecret: async (_c, id) => (id.endsWith('_GH_TOKEN') ? 'same-placeholder' : secrets[id]) })
  const d = deps(f.docker, { aws: same })
  t.equal(await createLauncher(d).start(), 1)
  t.notOk(f.events.some(e => e.startsWith('run ')))
  t.ok(d.logs.some(([event]) => event === 'launcher.tokens_identical'))
  t.end()
})

// Spec 3.4 / 3.6.1: LAUNCH_KEY goes to the orchestrator only; a worker gets the engine credentials
// and a ticket that verifies under that key, and never a daemon token.
test('launcher sends each container exactly its own bundle', async t => {
  const f = fakeDocker()
  const launcher = createLauncher(deps(f.docker))
  const done = launcher.start()
  await until(() => f.bundles.has('slack-review-bot-worker-0'))
  const orch = JSON.parse(f.bundles.get(ORCHESTRATOR_NAME)!)
  t.deepEqual(Object.keys(orch).sort(), ['APPROVER_GH_TOKEN', 'LAUNCH_KEY', 'SLACK_APP_TOKEN', 'SLACK_BOT_TOKEN'])
  const key = Buffer.from(orch.LAUNCH_KEY, 'base64url')
  t.equal(key.length, 32)
  const worker = JSON.parse(f.bundles.get('slack-review-bot-worker-0')!)
  t.deepEqual(Object.keys(worker).sort(), ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'ENGINE_GH_TOKEN', 'NPM_TOKEN', 'WORKER_TICKET'])
  t.equal(worker.ENGINE_GH_TOKEN, 'engine-placeholder')
  t.ok(verifyTicket(key, worker.WORKER_TICKET, Date.now(), 60_000).ok, 'the ticket verifies under the orchestrator key')
  launcher.requestStop()
  await done
  t.end()
})

// The spec's central shutdown rule: SIGTERM goes to the orchestrator only, and no worker is
// signalled until the orchestrator has exited. Regression caught: an in-flight review turned into
// "worker lost" and settled as an error, so it never replays.
test('launcher never stops a worker while the orchestrator is alive', async t => {
  const f = fakeDocker({ orchTermMs: 25 })
  // A hard bound far above the orchestrator's 25 ms exit, so a loaded machine cannot reach it.
  const launcher = createLauncher(deps(f.docker, { settings: { ...fast, shutdownDrainMs: 5_000 } }))
  const done = launcher.start()
  await until(() => f.events.includes('run slack-review-bot-worker-1'))
  launcher.requestStop()
  t.equal(await done, 0)
  const orchExit = f.events.indexOf(`exit ${ORCHESTRATOR_NAME}`)
  const firstWorkerSignal = f.events.findIndex(e => /^SIG(TERM|KILL) slack-review-bot-worker-/.test(e))
  t.ok(f.events.indexOf(`SIGTERM ${ORCHESTRATOR_NAME}`) < orchExit)
  t.ok(orchExit >= 0 && firstWorkerSignal > orchExit, 'workers are signalled only after the orchestrator exited')
  t.notOk(f.events.includes(`SIGKILL ${ORCHESTRATOR_NAME}`), 'no escalation within the hard bound')
  t.end()
})

// A repeated SIGTERM to the launcher is ignored: it must not escalate or signal anything new.
test('launcher ignores a repeated stop request', async t => {
  const f = fakeDocker({ orchTermMs: 20 })
  const d = deps(f.docker, { settings: { ...fast, shutdownDrainMs: 5_000 } })
  const launcher = createLauncher(d)
  const done = launcher.start()
  await until(() => f.events.includes('run slack-review-bot-worker-1'))
  launcher.requestStop()
  launcher.requestStop()
  await done
  t.equal(f.events.filter(e => e === `SIGTERM ${ORCHESTRATOR_NAME}`).length, 1)
  t.ok(d.logs.some(([event]) => event === 'launcher.signal_ignored'))
  t.end()
})

// The only escalation is the hard bound: an orchestrator that ignores SIGTERM is killed first and
// waited for; then workers get SIGTERM, and SIGKILL after their grace.
test('launcher escalates only after the hard bound, orchestrator first', async t => {
  const f = fakeDocker({ orchTermMs: null, workersObeyTerm: false })
  const launcher = createLauncher(deps(f.docker))
  const done = launcher.start()
  await until(() => f.events.includes('run slack-review-bot-worker-1'))
  const stopAt = Date.now()
  launcher.requestStop()
  await done
  const kill = f.events.indexOf(`SIGKILL ${ORCHESTRATOR_NAME}`)
  t.ok(kill >= 0, 'orchestrator killed')
  t.ok(Date.now() - stopAt >= fast.shutdownDrainMs, 'not before the hard bound')
  t.ok(f.events.indexOf(`exit ${ORCHESTRATOR_NAME}`) < f.events.indexOf('SIGTERM slack-review-bot-worker-0'))
  t.ok(f.events.indexOf('SIGTERM slack-review-bot-worker-0') < f.events.indexOf('SIGKILL slack-review-bot-worker-0'))
  t.end()
})

// Ruling 11: an orchestrator that exits on its own leaves nothing to drain for, so the launcher
// stops its workers and exits 1 for launchd to restart the stack with fresh secrets.
test('launcher stops workers and exits 1 when the orchestrator exits on its own', async t => {
  const f = fakeDocker()
  const launcher = createLauncher(deps(f.docker))
  const done = launcher.start()
  await until(() => f.events.includes('run slack-review-bot-worker-1'))
  f.exit(ORCHESTRATOR_NAME, 1)
  t.equal(await done, 1)
  t.ok(f.events.includes('SIGTERM slack-review-bot-worker-0'))
  t.end()
})

// Spec 3.6 step 2: a failed mint backs off exponentially to the cap and logs the STS error line,
// never a credential, and never starts a worker without credentials.
test('launcher backs off on a failed mint and logs only the error line', async t => {
  t.deepEqual([1, 2, 3, 10].map(n => backoffMs(n, 1000, 300_000)), [1000, 2000, 4000, 300_000])
  const f = fakeDocker()
  let calls = 0
  const failing = fakeAws({
    assumeRole: async roleArn => {
      if (roleArn.endsWith('SlackReviewBotSecretsReaderRole')) return { accessKeyId: 'r', secretAccessKey: 'r', sessionToken: 'r' }
      calls += 1
      throw new Error('could not assume the engine role: An error occurred (AccessDenied) when calling the AssumeRole operation')
    },
  })
  const d = deps(f.docker, { aws: failing })
  const launcher = createLauncher(d)
  const done = launcher.start()
  await until(() => calls >= 4)
  launcher.requestStop()
  await done
  t.notOk(f.events.some(e => e.startsWith('run slack-review-bot-worker-')), 'no worker without credentials')
  const failure = d.logs.find(([event]) => event === 'launcher.mint_failed')!
  t.match(String(failure[1].error), /AccessDenied/)
  t.ok(Number(failure[1].waitMs) <= fast.backoffMaxMs)
  t.end()
})

// Secrets never ride the docker command line or its environment; the bundle goes to stdin.
test('dockerEnv strips credentials and composeRunArgs carries no value', t => {
  const env = dockerEnv({ PATH: '/usr/bin', HOME: '/Users/op', AWS_PROFILE: 'staging', NPM_TOKEN: 'x', GH_TOKEN: 'x', LAUNCH_KEY: 'x', SOME_SECRET: 'x', REVIEW_ENGINES: 'codex' })
  t.deepEqual(Object.keys(env).sort(), ['HOME', 'PATH', 'REVIEW_ENGINES'])
  t.deepEqual(composeRunArgs(fast, 'worker', 'slack-review-bot-worker-0', []), [
    'compose', '-f', fast.composeFile, '-p', 'slack-review-bot', 'run', '--rm', '-T', '--name', 'slack-review-bot-worker-0', 'worker',
  ])
  t.end()
})

// The reader credentials reach `aws` through its environment only, with every profile file
// disabled; the CodeArtifact token is minted with the operator profile for the pinned domain.
test('makeAwsOps passes reader credentials by environment and pins CodeArtifact', async t => {
  const calls: { args: string[]; env?: NodeJS.ProcessEnv }[] = []
  const aws = makeAwsOps(fast, async (_file, args, env) => {
    calls.push({ args, env })
    return { stdout: 'value-placeholder\n', stderr: '' }
  })
  t.equal(await aws.getSecret({ accessKeyId: 'r1', secretAccessKey: 'r2', sessionToken: 'r3' }, '/slack-review-bot/SLACK_BOT_TOKEN'), 'value-placeholder')
  t.notOk(calls[0].args.some(a => a.startsWith('r')), 'no credential in the arguments')
  t.equal(calls[0].env?.AWS_ACCESS_KEY_ID, 'r1')
  t.equal(calls[0].env?.AWS_CONFIG_FILE, '/dev/null')
  t.equal(calls[0].env?.AWS_PROFILE, undefined)
  await aws.codeartifactToken(3600)
  t.deepEqual(calls[1].args, [
    'codeartifact', 'get-authorization-token', '--domain', 'trade-platform', '--domain-owner', '153538148884',
    '--region', 'us-east-2', '--duration-seconds', '3600', '--query', 'authorizationToken', '--output', 'text', '--profile', 'staging',
  ])
  t.end()
})

// F9: through the real AWS ops, every role is assumed directly from the operator profile (never
// chained off another session's credentials), the engine session covers one run, and the reader
// role is used only for the secrets. Regression caught: the engine role assumed with the reader's
// credentials in the environment (chaining caps the session at one hour), or the wrong ARN/length.
test('launcher mints both roles from the operator profile with the right ARNs and session length', async t => {
  const calls: { args: string[]; env?: NodeJS.ProcessEnv }[] = []
  const exec = async (_file: string, args: string[], env?: NodeJS.ProcessEnv) => {
    calls.push({ args, env })
    if (args[0] === 'sts') {
      return { stdout: JSON.stringify({ Credentials: { AccessKeyId: 'id-x', SecretAccessKey: 'key-x', SessionToken: 'session-x' } }), stderr: '' }
    }
    if (args[0] === 'secretsmanager') return { stdout: `${secrets[args[args.indexOf('--secret-id') + 1]]}\n`, stderr: '' }
    return { stdout: 'npm-placeholder\n', stderr: '' }
  }
  const f = fakeDocker()
  const launcher = createLauncher(deps(f.docker, { aws: makeAwsOps(fast, exec) }))
  const done = launcher.start()
  await until(() => f.events.includes('run slack-review-bot-worker-1'))
  launcher.requestStop()
  await done
  const assumes = calls.filter(c => c.args[0] === 'sts')
  const flag = (args: string[], name: string) => args[args.indexOf(name) + 1]
  t.equal(flag(assumes[0].args, '--role-arn'), fast.readerRoleArn, 'the reader role is assumed first')
  const engine = assumes.slice(1)
  t.ok(engine.length >= 1, 'the engine role is assumed per worker')
  for (const c of engine) {
    t.equal(flag(c.args, '--role-arn'), fast.engineRoleArn)
    t.equal(flag(c.args, '--duration-seconds'), String(engineSessionSeconds(fast.runTimeoutMs)))
  }
  for (const c of assumes) {
    t.equal(flag(c.args, '--profile'), 'staging', 'assumed from the operator profile')
    t.equal(c.env?.AWS_ACCESS_KEY_ID, undefined, 'no session credentials in the environment (no chaining)')
    t.equal(c.env?.AWS_SESSION_TOKEN, undefined)
  }
  t.end()
})

/** The `waitMs` of every `launcher.worker_failed_fast` log for one slot, in order. */
const fastWaits = (logs: [string, Record<string, unknown>][], slot: number) =>
  logs.filter(([event, fields]) => event === 'launcher.worker_failed_fast' && fields.slot === slot).map(([, fields]) => fields.waitMs)

// Final review, Important 2: a worker that exits at once (bad config, an expired ticket from a VM clock
// behind the host, a name conflict) must not be restarted every second. Regression caught: each slot
// assuming the engine role, minting a CodeArtifact token and starting a container every 2-5 s forever.
test('launcher backs off a worker that exits non-zero, growing to the cap', async t => {
  const f = fakeDocker({ workerExit: () => 3 })
  const d = deps(f.docker, { settings: { ...fast, workerSlots: 1 } })
  const launcher = createLauncher(d)
  const done = launcher.start()
  await until(() => fastWaits(d.logs, 0).length >= 4)
  launcher.requestStop()
  t.equal(await done, 0)
  t.deepEqual(fastWaits(d.logs, 0).slice(0, 4), [1, 2, 4, 4], 'backoffMs schedule, capped at backoffMaxMs')
  t.equal(d.logs.find(([event]) => event === 'launcher.worker_failed_fast')?.[1].code, 3)
  t.end()
})

// An exit 0 can still be a failure when it comes within the fast-exit window (a worker that cannot
// even long-poll); a run that lasted past the window is healthy and resets the backoff.
test('launcher counts a quick exit 0 as a failure and resets the backoff after a healthy run', async t => {
  t.equal(WORKER_FAST_EXIT_MS, 10_000)
  let clock = 1_800_000_000_000
  const f = fakeDocker({
    workerExit: (_name, n) => {
      if (n === 3) clock += WORKER_FAST_EXIT_MS // the third run lasts past the window
      return n === 4 ? 1 : n <= 5 ? 0 : undefined
    },
  })
  const d = deps(f.docker, { settings: { ...fast, workerSlots: 1 }, now: () => clock })
  const launcher = createLauncher(d)
  const done = launcher.start()
  await until(() => f.events.filter(e => e === 'run slack-review-bot-worker-0').length >= 6)
  launcher.requestStop()
  await done
  t.deepEqual(fastWaits(d.logs, 0), [1, 2, 1, 2], 'runs 1-2 back off; run 3 resets; runs 4-5 back off from the base')
  t.end()
})

// A container left behind under the slot's name (its `compose run` client died) would make every
// `run --name` fail. The slot's name is force-removed before each run, and a failing removal is logged,
// never thrown, so the slot keeps going.
test('launcher force-removes the slot name before each worker run and logs a failed removal', async t => {
  const f = fakeDocker({ workerExit: (_name, n) => (n === 1 ? 0 : undefined), rmFails: true })
  const d = deps(f.docker, { settings: { ...fast, workerSlots: 1 } })
  const launcher = createLauncher(d)
  const done = launcher.start()
  await until(() => f.events.filter(e => e === 'run slack-review-bot-worker-0').length >= 2)
  launcher.requestStop()
  await done
  const slot = f.events.filter(e => e.endsWith(' slack-review-bot-worker-0') && /^(rm|run) /.test(e))
  t.deepEqual(slot.slice(0, 4), ['rm slack-review-bot-worker-0', 'run slack-review-bot-worker-0', 'rm slack-review-bot-worker-0', 'run slack-review-bot-worker-0'])
  const failure = d.logs.find(([event]) => event === 'launcher.worker_remove_failed')
  t.ok(failure, 'the failed removal is logged')
  t.match(String(failure?.[1].error), /already in progress/)
  t.end()
})

// Final review, Minor 1: a stop requested while the secrets are being fetched must not start the
// orchestrator, which would connect to Slack and begin reviews only to be killed with no drain.
test('launcher starts nothing when a stop arrives during the secret fetch', async t => {
  const f = fakeDocker()
  let release!: () => void
  const gate = new Promise<void>(resolve => (release = resolve))
  let fetching = false
  const slow = fakeAws({
    getSecret: async (_c, id) => {
      fetching = true
      await gate
      return secrets[id]
    },
  })
  const d = deps(f.docker, { aws: slow })
  const launcher = createLauncher(d)
  const done = launcher.start()
  await until(() => fetching)
  launcher.requestStop()
  release()
  t.equal(await done, 0, 'a clean exit')
  t.notOk(f.events.some(e => e.startsWith('run ')), 'no container started')
  t.ok(d.logs.some(([event]) => event === 'launcher.stopped_before_start'))
  t.end()
})

// Final review (T13): a docker CLI that never reports the exit after SIGKILL must not hold the launcher
// past launchd's ExitTimeOut. Both waits are bounded and the overrun is logged.
test('launcher bounds the exit waits after SIGKILL and logs the overrun', async t => {
  const f = fakeDocker({ orchTermMs: null, orchIgnoresKill: true, workersObeyTerm: false, workersIgnoreKill: true })
  const d = deps(f.docker)
  const launcher = createLauncher(d)
  const done = launcher.start()
  await until(() => f.events.includes('run slack-review-bot-worker-1'))
  launcher.requestStop()
  t.equal(await done, 0)
  t.ok(d.logs.some(([event]) => event === 'launcher.orchestrator_exit_unconfirmed'))
  t.ok(d.logs.some(([event]) => event === 'launcher.workers_exit_unconfirmed'))
  t.ok(f.events.indexOf(`SIGKILL ${ORCHESTRATOR_NAME}`) < f.events.indexOf('SIGTERM slack-review-bot-worker-0'), 'workers still only after the orchestrator kill')
  t.end()
})

/** A spawn stand-in that records its call and the bytes written to stdin, and never exits. */
function recordingSpawn() {
  const calls: { file: string; args: string[]; options: { env?: NodeJS.ProcessEnv; stdio?: unknown } }[] = []
  const stdin: string[] = []
  const spawnImpl = ((file: string, args: string[], options: { env?: NodeJS.ProcessEnv }) => {
    calls.push({ file, args, options })
    const child = new EventEmitter() as EventEmitter & { stdin: { on(): void; end(data: string): void } }
    child.stdin = { on: () => {}, end: data => void stdin.push(data) }
    return child
  }) as unknown as Parameters<typeof makeDockerOps>[2]
  return { calls, stdin, spawnImpl }
}

// Final review (T13): the one secret path no test pinned end to end. The bundle must reach the
// container through stdin only: not in the docker argument vector, and the docker CLI's environment
// carries no credential variable. Regression caught: a refactor passing values with `-e NAME=value`
// (visible in `ps` and `docker inspect`) or inheriting the launcher's AWS session.
test('makeDockerOps passes the bundle on stdin only, with a credential-free CLI environment', t => {
  const env = { PATH: '/usr/bin', HOME: '/Users/op', AWS_PROFILE: 'staging', AWS_SESSION_TOKEN: 'aws-placeholder', NPM_TOKEN: 'npm-placeholder', GH_TOKEN: 'gh-placeholder', LAUNCH_KEY: 'key-placeholder' }
  const r = recordingSpawn()
  const docker = makeDockerOps(fast, env, r.spawnImpl)
  const bundle = JSON.stringify({ ENGINE_GH_TOKEN: 'bundle-placeholder-value' })
  docker.run('worker', 'slack-review-bot-worker-0', bundle)
  t.equal(r.calls.length, 1)
  t.equal(r.calls[0].file, 'docker')
  t.deepEqual(r.calls[0].args, ['compose', '-f', fast.composeFile, '-p', 'slack-review-bot', 'run', '--rm', '-T', '--name', 'slack-review-bot-worker-0', 'worker'])
  const cliEnv = r.calls[0].options.env ?? {}
  t.deepEqual(Object.keys(cliEnv).sort(), ['HOME', 'PATH'], 'no AWS_*, *_TOKEN or LAUNCH_KEY variable reaches the CLI')
  t.notOk(JSON.stringify(r.calls[0]).includes('bundle-placeholder-value'), 'no bundle value in the arguments or environment')
  t.deepEqual(r.stdin, [bundle], 'the bundle is written to stdin, once')
  t.end()
})

// Final review (T13): `docker kill` / `rm -f` failures were swallowed, hiding why a stop or a restart
// stalled. "No such container" is the normal case and stays quiet; anything else is logged.
test('makeDockerOps logs docker kill and rm failures other than a missing container', async t => {
  const logs: [string, Record<string, unknown>][] = []
  let stderr = 'Error response from daemon: No such container: x'
  const exec = async () => {
    throw Object.assign(new Error('failed'), { stderr })
  }
  const docker = makeDockerOps(fast, { PATH: '/usr/bin' }, recordingSpawn().spawnImpl, exec, (event, fields = {}) => void logs.push([event, fields]))
  await docker.signal('slack-review-bot-worker-0', 'SIGTERM')
  await docker.removeForce('slack-review-bot-worker-0')
  t.deepEqual(logs, [], 'a missing container is not worth a log line')
  stderr = 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock'
  await docker.signal('slack-review-bot-worker-0', 'SIGKILL')
  await docker.removeForce('slack-review-bot-worker-0')
  t.deepEqual(logs.map(([event]) => event), ['launcher.docker_kill_failed', 'launcher.docker_rm_failed'])
  t.equal(logs[0][1].signal, 'SIGKILL')
  t.match(String(logs[0][1].error), /Cannot connect/)
  t.end()
})
