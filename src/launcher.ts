// The host launcher (spec 3.6). The only process holding the operator's AWS login: it fetches the
// bot's secrets, mints per-worker engine credentials and claim tickets, starts the orchestrator and
// the workers with `docker compose run`, writes each one's secrets to its stdin, and owns the
// shutdown order. It never stops a worker while the orchestrator is alive.

import { execFile, spawn, type ChildProcess } from 'child_process'
import { randomBytes } from 'crypto'
import * as path from 'path'
import { promisify } from 'util'
import { assumeEngineRole, awsSessionEnv, engineSessionName, engineSessionSeconds, type AwsCredentials } from './bedrock-auth'
import { LAUNCH_KEY_BYTES, mintTicket } from './jobs/ticket'
import { redactSecrets } from './redact'
import { encodeSecretBundle } from './secret-bundle'
import { SHUTDOWN_GRACE_MS } from './supervise'

export const ORCHESTRATOR_NAME = 'slack-review-bot-orchestrator'
export const WORKER_PREFIX = 'slack-review-bot-worker-'
const SECRET_NAMES = ['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN', 'APPROVER_GH_TOKEN', 'ENGINE_GH_TOKEN'] as const
export const SECRET_IDS: Record<(typeof SECRET_NAMES)[number], string> = {
  SLACK_BOT_TOKEN: '/slack-review-bot/SLACK_BOT_TOKEN',
  SLACK_APP_TOKEN: '/slack-review-bot/SLACK_APP_TOKEN',
  APPROVER_GH_TOKEN: '/slack-review-bot/APPROVER_GH_TOKEN',
  ENGINE_GH_TOKEN: '/slack-review-bot/ENGINE_GH_TOKEN',
}
const CODEARTIFACT = { domain: 'trade-platform', owner: '153538148884', region: 'us-east-2' }
/** The reader session only lives long enough to fetch four secrets. */
const READER_SESSION_SECONDS = 900

export interface LauncherSettings {
  awsProfile: string
  region: string
  readerRoleArn: string
  engineRoleArn: string
  workerSlots: number
  runTimeoutMs: number
  shutdownDrainMs: number
  shutdownGraceMs: number
  /** The 30 s on top of drain + grace before the orchestrator is killed (spec 3.6 step 3). */
  hardBoundSlackMs: number
  /** How long workers get after SIGTERM, once the orchestrator is gone. */
  workerStopGraceMs: number
  workerRestartMs: number
  backoffBaseMs: number
  backoffMaxMs: number
  composeFile: string
  project: string
}

const positiveInt = (raw: string | undefined, fallback: number) => {
  const n = Number(raw)
  return raw && Number.isInteger(n) && n > 0 ? n : fallback
}

export function loadLauncherSettings(env: NodeJS.ProcessEnv): LauncherSettings {
  const concurrency = positiveInt(env.CONCURRENCY, 1)
  return {
    awsProfile: env.LAUNCHER_AWS_PROFILE || 'staging',
    region: env.LAUNCHER_REGION || 'us-east-2',
    readerRoleArn: env.LAUNCHER_READER_ROLE_ARN || 'arn:aws:iam::153538148884:role/SlackReviewBotSecretsReaderRole',
    engineRoleArn: env.LAUNCHER_ENGINE_ROLE_ARN || 'arn:aws:iam::153538148884:role/SlackReviewBotEngineRole',
    workerSlots: positiveInt(env.WORKER_SLOTS, 2 * concurrency),
    runTimeoutMs: positiveInt(env.RUN_TIMEOUT_MS, 3 * 60 * 60 * 1000),
    shutdownDrainMs: positiveInt(env.SHUTDOWN_DRAIN_MS, 5_000),
    // The bot's own run-kill grace is a constant (no setting), so the launcher uses the same value.
    shutdownGraceMs: SHUTDOWN_GRACE_MS,
    hardBoundSlackMs: 30_000,
    workerStopGraceMs: 30_000,
    workerRestartMs: 1_000,
    backoffBaseMs: 1_000,
    backoffMaxMs: 5 * 60_000,
    composeFile: env.LAUNCHER_COMPOSE_FILE || path.join(__dirname, '..', 'compose.yaml'),
    project: 'slack-review-bot',
  }
}

export type LauncherExec = (file: string, args: string[], env?: NodeJS.ProcessEnv) => Promise<{ stdout: string; stderr: string }>

const execFileAsync = promisify(execFile)
const defaultExec: LauncherExec = (file, args, env) => execFileAsync(file, args, { timeout: 60_000, env: env ?? process.env })

/** The first stderr line of a failed command, redacted; never its stdout (it may hold a value). */
function reason(error: unknown, what: string): string {
  const stderr = (error as { stderr?: unknown }).stderr
  const line = typeof stderr === 'string' ? stderr.split(/\r?\n/).find(l => l.trim()) ?? '' : ''
  return line ? redactSecrets(line.trim()).slice(0, 300) : `${what} failed`
}

export interface AwsOps {
  assumeRole(roleArn: string, sessionName: string, durationSeconds: number): Promise<AwsCredentials>
  getSecret(creds: AwsCredentials, id: string): Promise<string>
  codeartifactToken(durationSeconds: number): Promise<string>
}

export function makeAwsOps(settings: LauncherSettings, exec: LauncherExec = defaultExec): AwsOps {
  return {
    // Each role is assumed directly from the operator's profile, never chained (spec 3.6).
    assumeRole: (roleArn, sessionName, durationSeconds) =>
      assumeEngineRole({ roleArn, profile: settings.awsProfile, region: settings.region, durationSeconds, sessionName, exec }),
    async getSecret(creds, id) {
      // The reader session reaches `aws` through its environment only, with every profile file off.
      const env = awsSessionEnv(process.env, creds, settings.region)
      try {
        const { stdout } = await exec('aws', ['secretsmanager', 'get-secret-value', '--secret-id', id, '--query', 'SecretString', '--output', 'text'], env)
        const value = stdout.replace(/\r?\n$/, '')
        if (!value) throw Object.assign(new Error('empty'), { stderr: `${id} is empty` })
        return value
      } catch (error) {
        throw new Error(`could not read ${id}: ${reason(error, 'get-secret-value')}`)
      }
    },
    async codeartifactToken(durationSeconds) {
      try {
        const { stdout } = await exec('aws', [
          'codeartifact', 'get-authorization-token',
          '--domain', CODEARTIFACT.domain,
          '--domain-owner', CODEARTIFACT.owner,
          '--region', CODEARTIFACT.region,
          '--duration-seconds', String(durationSeconds),
          '--query', 'authorizationToken',
          '--output', 'text',
          '--profile', settings.awsProfile,
        ])
        return stdout.trim()
      } catch (error) {
        throw new Error(`could not mint a CodeArtifact token: ${reason(error, 'get-authorization-token')}`)
      }
    },
  }
}

export interface RunningContainer {
  name: string
  exited: Promise<number>
}

export interface DockerOps {
  run(service: 'orchestrator' | 'worker', name: string, bundle: string, args?: string[]): RunningContainer
  signal(name: string, signal: 'SIGTERM' | 'SIGKILL'): Promise<void>
  removeForce(name: string): Promise<void>
  listByPrefix(prefix: string): Promise<string[]>
}

/** The docker CLI's environment: the launcher's, minus every credential and every AWS variable. */
export function dockerEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {}
  for (const [name, value] of Object.entries(env)) {
    if (/^AWS_/.test(name) || /_TOKEN$/.test(name) || /SECRET/.test(name) || name === 'LAUNCH_KEY' || name === 'WORKER_TICKET') continue
    out[name] = value
  }
  return out
}

export function composeRunArgs(settings: LauncherSettings, service: 'orchestrator' | 'worker', name: string, args: string[]): string[] {
  return ['compose', '-f', settings.composeFile, '-p', settings.project, 'run', '--rm', '-T', '--name', name, service, ...args]
}

export function makeDockerOps(
  settings: LauncherSettings,
  env: NodeJS.ProcessEnv,
  spawnImpl: typeof spawn = spawn,
  exec: LauncherExec = defaultExec
): DockerOps {
  const cliEnv = dockerEnv(env)
  return {
    run(service, name, bundle, args = []) {
      const child: ChildProcess = spawnImpl('docker', composeRunArgs(settings, service, name, args), {
        stdio: ['pipe', 'inherit', 'inherit'],
        env: cliEnv,
      })
      // The bundle goes to stdin and nowhere else (spec 3.6.1); the entrypoint closes stdin after it.
      child.stdin?.on('error', () => {})
      child.stdin?.end(bundle)
      const exited = new Promise<number>(resolve => {
        child.on('error', () => resolve(127))
        child.on('exit', code => resolve(code ?? 1))
      })
      return { name, exited }
    },
    async signal(name, signal) {
      await exec('docker', ['kill', '--signal', signal, name], cliEnv).catch(() => undefined)
    },
    async removeForce(name) {
      // "No such container" is the normal case; anything else surfaces when `run --name` fails.
      await exec('docker', ['rm', '-f', name], cliEnv).catch(() => undefined)
    },
    async listByPrefix(prefix) {
      const { stdout } = await exec('docker', ['ps', '-a', '--format', '{{.Names}}', '--filter', `name=^${prefix}`], cliEnv)
      return stdout.split('\n').map(s => s.trim()).filter(Boolean)
    },
  }
}

export function backoffMs(failures: number, base: number, max: number): number {
  return Math.min(base * 2 ** Math.max(0, failures - 1), max)
}

export interface LauncherDeps {
  settings: LauncherSettings
  aws: AwsOps
  docker: DockerOps
  log(event: string, fields?: Record<string, unknown>): void
  now(): number
  randomKey(): Buffer
}

const errorLine = (error: unknown) => redactSecrets((error instanceof Error ? error.message : String(error)).split('\n')[0]).slice(0, 300)
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

async function fetchSecrets(deps: LauncherDeps): Promise<Record<(typeof SECRET_NAMES)[number], string>> {
  const reader = await deps.aws.assumeRole(deps.settings.readerRoleArn, 'slack-review-bot-launcher', READER_SESSION_SECONDS)
  const out = {} as Record<(typeof SECRET_NAMES)[number], string>
  for (const name of SECRET_NAMES) out[name] = await deps.aws.getSecret(reader, SECRET_IDS[name])
  return out
}

async function workerBundle(deps: LauncherDeps, engineToken: string, slot: number, ticket?: string): Promise<string> {
  const seconds = engineSessionSeconds(deps.settings.runTimeoutMs)
  const creds = await deps.aws.assumeRole(deps.settings.engineRoleArn, engineSessionName(`worker-${slot}-${deps.now()}`), seconds)
  if (!creds.sessionToken) throw new Error('the engine role returned no session token')
  const npmToken = await deps.aws.codeartifactToken(seconds)
  return encodeSecretBundle({
    ENGINE_GH_TOKEN: engineToken,
    AWS_ACCESS_KEY_ID: creds.accessKeyId,
    AWS_SECRET_ACCESS_KEY: creds.secretAccessKey,
    AWS_SESSION_TOKEN: creds.sessionToken,
    NPM_TOKEN: npmToken,
    ...(ticket ? { WORKER_TICKET: ticket } : {}),
  })
}

export function createLauncher(deps: LauncherDeps): { start(): Promise<number>; requestStop(): void } {
  const { settings, docker, log } = deps
  let stopping = false
  let stopRequested = false
  let signalStop!: () => void
  const stopSignal = new Promise<void>(resolve => (signalStop = resolve))
  const running = new Map<number, RunningContainer>()
  const pause = (ms: number) => Promise.race([sleep(ms), stopSignal])

  async function workerLoop(slot: number, key: Buffer, engineToken: string): Promise<void> {
    let failures = 0
    while (!stopping) {
      let bundle: string
      try {
        bundle = await workerBundle(deps, engineToken, slot, mintTicket(key, deps.now()))
        failures = 0
      } catch (error) {
        failures += 1
        const waitMs = backoffMs(failures, settings.backoffBaseMs, settings.backoffMaxMs)
        log('launcher.mint_failed', { slot, failures, waitMs, error: errorLine(error) })
        await pause(waitMs)
        continue
      }
      if (stopping) break
      const worker = docker.run('worker', `${WORKER_PREFIX}${slot}`, bundle)
      running.set(slot, worker)
      const code = await worker.exited
      running.delete(slot)
      log('launcher.worker_exited', { slot, code })
      await pause(settings.workerRestartMs)
    }
  }

  /** Only ever called once the orchestrator has exited. */
  async function stopWorkers(): Promise<void> {
    const workers = [...running.values()]
    await Promise.all(workers.map(w => docker.signal(w.name, 'SIGTERM')))
    const allExited = Promise.all(workers.map(w => w.exited))
    await Promise.race([allExited, sleep(settings.workerStopGraceMs)])
    for (const w of [...running.values()]) await docker.signal(w.name, 'SIGKILL')
    await allExited
  }

  return {
    requestStop() {
      if (stopRequested) {
        log('launcher.signal_ignored', { hint: 'already draining; the orchestrator decides when to force' })
        return
      }
      stopRequested = true
      log('launcher.stopping', {})
      signalStop()
    },

    async start() {
      let secrets: Record<(typeof SECRET_NAMES)[number], string>
      try {
        secrets = await fetchSecrets(deps)
      } catch (error) {
        log('launcher.secrets_failed', { error: errorLine(error) })
        return 1
      }
      if (secrets.APPROVER_GH_TOKEN === secrets.ENGINE_GH_TOKEN) {
        log('launcher.tokens_identical', { hint: 'APPROVER_GH_TOKEN and ENGINE_GH_TOKEN must be different tokens' })
        return 1
      }
      const key = deps.randomKey()
      if (key.length !== LAUNCH_KEY_BYTES) throw new Error('LAUNCH_KEY must be 32 bytes')

      // Ruling 10: the old orchestrator first (it may still be reviewing), then old workers.
      await docker.removeForce(ORCHESTRATOR_NAME)
      for (const name of await docker.listByPrefix(WORKER_PREFIX)) await docker.removeForce(name)

      const orchestrator = docker.run(
        'orchestrator',
        ORCHESTRATOR_NAME,
        encodeSecretBundle({
          SLACK_BOT_TOKEN: secrets.SLACK_BOT_TOKEN,
          SLACK_APP_TOKEN: secrets.SLACK_APP_TOKEN,
          APPROVER_GH_TOKEN: secrets.APPROVER_GH_TOKEN,
          LAUNCH_KEY: key.toString('base64url'),
        })
      )
      log('launcher.started', { slots: settings.workerSlots })
      const loops = Array.from({ length: settings.workerSlots }, (_, slot) => workerLoop(slot, key, secrets.ENGINE_GH_TOKEN))

      const first = await Promise.race([orchestrator.exited.then(code => ({ kind: 'exited' as const, code })), stopSignal.then(() => ({ kind: 'stop' as const }))])
      stopping = true
      if (first.kind === 'exited') {
        // Ruling 11: nothing is left to drain for; stop the workers and let launchd restart us.
        log('launcher.orchestrator_exited', { code: first.code })
        await stopWorkers()
        await Promise.all(loops)
        return 1
      }
      // Spec 3.6 step 3: drain first. Only the orchestrator is signalled, once.
      await docker.signal(ORCHESTRATOR_NAME, 'SIGTERM')
      const bound = settings.shutdownDrainMs + settings.shutdownGraceMs + settings.hardBoundSlackMs
      const exitedInTime = await Promise.race([orchestrator.exited.then(() => true), sleep(bound).then(() => false)])
      if (!exitedInTime) {
        log('launcher.orchestrator_kill', { boundMs: bound })
        await docker.signal(ORCHESTRATOR_NAME, 'SIGKILL')
      }
      const code = await orchestrator.exited
      log('launcher.orchestrator_stopped', { code })
      await stopWorkers()
      await Promise.all(loops)
      return 0
    },
  }
}

/** `launcher doctor orchestrator|worker`: run the container doctor with a real bundle (spec 3.7). */
export async function runDoctor(deps: LauncherDeps, role: 'orchestrator' | 'worker'): Promise<number> {
  const secrets = await fetchSecrets(deps)
  if (role === 'worker') {
    const bundle = await workerBundle(deps, secrets.ENGINE_GH_TOKEN, 0)
    return deps.docker.run('worker', 'slack-review-bot-doctor-worker', bundle, ['doctor', '--role', 'worker']).exited
  }
  const bundle = encodeSecretBundle({
    SLACK_BOT_TOKEN: secrets.SLACK_BOT_TOKEN,
    SLACK_APP_TOKEN: secrets.SLACK_APP_TOKEN,
    APPROVER_GH_TOKEN: secrets.APPROVER_GH_TOKEN,
    // A throwaway key: the doctor verifies no ticket.
    LAUNCH_KEY: deps.randomKey().toString('base64url'),
  })
  return deps.docker.run('orchestrator', 'slack-review-bot-doctor-orchestrator', bundle, ['doctor', '--role', 'orchestrator']).exited
}

export const defaultRandomKey = () => randomBytes(LAUNCH_KEY_BYTES)
