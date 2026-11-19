// The container doctor checks (spec 3.7). Pure over an injected probe, so each has a
// deliberate-failure test without a live container. The worker checks are the acceptance criteria
// of https://github.com/andrew-barnett/slack-review-bot/issues/64.

import type { AwsCredentials } from './bedrock-auth'
import { ghEnvAs, type LoginLookup } from './doctor-dual'
import type { CheckResult, CommandRunner } from './doctor'
import { redactSecrets } from './redact'

export interface ContainerProbe {
  env: NodeJS.ProcessEnv
  exists(p: string): boolean
  readFile(p: string): string | undefined
  runCommand: CommandRunner
  lookupLogin(token: string): Promise<LoginLookup>
}

/** Names that must never be visible in a worker: the daemon's tokens and the ticket key. */
export const DAEMON_ONLY_NAMES = ['APPROVER_GH_TOKEN', 'SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN', 'LAUNCH_KEY'] as const
/** The variable names, or a Slack token's shape, in any file under the scanned dirs. */
const LEAK_PATTERN = 'APPROVER_GH_TOKEN|SLACK_BOT_TOKEN|SLACK_APP_TOKEN|LAUNCH_KEY|xox[abpr]-[A-Za-z0-9-]{10,}|xapp-[0-9]-[A-Za-z0-9-]{10,}'
const SCAN_DIRS = ['/home/bot', '/tmp']
export const ENGINE_ROLE_NAME = 'SlackReviewBotEngineRole'
export const PROBE_SECRET_ID = '/slack-review-bot/SLACK_BOT_TOKEN'

const firstLine = (text: string) => redactSecrets(text.trim().split('\n')[0] ?? '').slice(0, 200)

/** --role orchestrator|worker; undefined when absent. */
export function parseDoctorRole(argv: string[]): 'orchestrator' | 'worker' | undefined {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const value = arg === '--role' ? argv[i + 1] : arg.startsWith('--role=') ? arg.slice('--role='.length) : undefined
    if (arg !== '--role' && value === undefined) continue
    if (value === 'orchestrator' || value === 'worker') return value
    throw new Error('--role must be "orchestrator" or "worker"')
  }
  return undefined
}

/**
 * The environment every worker `aws` probe runs with: the engine session only. No profile, config
 * or credentials file can substitute another identity.
 */
export function engineAwsEnv(base: NodeJS.ProcessEnv, creds: AwsCredentials, region: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { PATH: base.PATH, HOME: base.HOME }
  env.AWS_CONFIG_FILE = '/dev/null'
  env.AWS_SHARED_CREDENTIALS_FILE = '/dev/null'
  env.AWS_REGION = region
  env.AWS_ACCESS_KEY_ID = creds.accessKeyId
  env.AWS_SECRET_ACCESS_KEY = creds.secretAccessKey
  if (creds.sessionToken) env.AWS_SESSION_TOKEN = creds.sessionToken
  return env
}

export async function checkDaemonSecretsAbsent(probe: ContainerProbe): Promise<CheckResult> {
  const name = 'daemon secrets absent'
  const present = DAEMON_ONLY_NAMES.filter(n => probe.env[n] !== undefined)
  if (present.length) return { name, status: 'fail', detail: `set in the environment: ${present.join(', ')}` }
  if (probe.exists('/run/secrets')) return { name, status: 'fail', detail: '/run/secrets exists (Compose secrets are not used)' }
  // -r does not follow symlinks, so the linked skill and hook sources are not scanned; -l prints
  // file names only, never the matching text.
  const { code, output } = await probe.runCommand('grep', ['-rlE', LEAK_PATTERN, ...SCAN_DIRS])
  if (code === 1) return { name, status: 'ok', detail: `none in the environment, ${SCAN_DIRS.join(' or ')}; no /run/secrets` }
  if (code === 0) return { name, status: 'fail', detail: `found in: ${output.trim().split('\n').slice(0, 5).join(', ')}` }
  // A scan that could not run is unknown, never clean.
  return { name, status: 'fail', detail: `the file scan did not complete (exit ${code}): ${firstLine(output)}` }
}

export async function checkGhLoggedOut(probe: ContainerProbe): Promise<CheckResult> {
  const name = 'gh logged out'
  const { code, output } = await probe.runCommand('gh', ['auth', 'status'], ghEnvAs(probe.env))
  if (code === 1 && /not logged in/i.test(output)) return { name, status: 'ok', detail: 'gh has no stored login (tokens reach gh per call only)' }
  if (code === 0) return { name, status: 'fail', detail: `gh has a stored login: ${firstLine(output)}` }
  // gh missing, timed out or failing otherwise: unknown, never clean.
  return { name, status: 'fail', detail: `gh auth status did not answer (exit ${code}): ${firstLine(output)}` }
}

export async function checkEngineRole(probe: ContainerProbe, awsEnv: NodeJS.ProcessEnv): Promise<CheckResult> {
  const name = 'aws identity'
  const { code, output } = await probe.runCommand('aws', ['sts', 'get-caller-identity', '--output', 'json'], awsEnv)
  if (code !== 0) return { name, status: 'fail', detail: `sts get-caller-identity failed: ${firstLine(output)}` }
  let arn = ''
  try {
    arn = String((JSON.parse(output) as { Arn?: unknown }).Arn ?? '')
  } catch {
    return { name, status: 'fail', detail: 'sts get-caller-identity returned something that is not JSON' }
  }
  return arn.includes(`:assumed-role/${ENGINE_ROLE_NAME}/`)
    ? { name, status: 'ok', detail: arn }
    : { name, status: 'fail', detail: `expected assumed-role/${ENGINE_ROLE_NAME}/…, got ${arn || 'no ARN'}` }
}

export async function checkSecretsDenied(probe: ContainerProbe, awsEnv: NodeJS.ProcessEnv, region: string): Promise<CheckResult> {
  const name = 'secrets denied'
  // describe-secret returns metadata only, never a value; the engine role must not even get that.
  const { code, output } = await probe.runCommand('aws', ['secretsmanager', 'describe-secret', '--secret-id', PROBE_SECRET_ID, '--region', region], awsEnv)
  if (code === 0) return { name, status: 'fail', detail: `the engine role can describe ${PROBE_SECRET_ID}` }
  return /AccessDenied/.test(output)
    ? { name, status: 'ok', detail: `describe-secret ${PROBE_SECRET_ID} is denied` }
    : { name, status: 'fail', detail: `could not confirm a denial: ${firstLine(output)}` }
}

export function checkPidNamespace(probe: ContainerProbe): CheckResult {
  const name = 'pid namespace'
  const cmdline = probe.readFile('/proc/1/cmdline')
  if (cmdline === undefined) return { name, status: 'fail', detail: '/proc/1/cmdline is unreadable' }
  const init = cmdline.split('\0')[0]
  return /(^|\/)(tini|docker-init)$/.test(init)
    ? { name, status: 'ok', detail: `PID 1 is ${init}: only this container's processes are visible` }
    : { name, status: 'fail', detail: `PID 1 is ${init || 'unknown'}, not the container's init` }
}

export function checkNoDockerSocket(probe: ContainerProbe): CheckResult {
  const name = 'docker socket'
  return probe.exists('/var/run/docker.sock') || probe.exists('/run/docker.sock')
    ? { name, status: 'fail', detail: 'a Docker socket is mounted; it would hand out the host' }
    : { name, status: 'ok', detail: 'no Docker socket' }
}

/** Ruling 8: this container's token is the role account (ROLE_GH_LOGIN) and not the operator. */
export async function checkTokenIdentity(probe: ContainerProbe, label: string, token: string): Promise<CheckResult> {
  const name = `${label} identity`
  const role = probe.env.ROLE_GH_LOGIN ?? ''
  const operator = probe.env.OPERATOR_GH_LOGIN ?? ''
  if (!role) return { name, status: 'fail', detail: 'ROLE_GH_LOGIN is not set (a launcher setting)' }
  if (operator && role.toLowerCase() === operator.toLowerCase()) {
    return { name, status: 'fail', detail: 'ROLE_GH_LOGIN equals OPERATOR_GH_LOGIN; the role account must not be the operator' }
  }
  const who = await probe.lookupLogin(token)
  if ('error' in who) return { name, status: 'fail', detail: `GET /user failed: ${firstLine(who.error)}` }
  if (operator && who.login.toLowerCase() === operator.toLowerCase()) {
    return { name, status: 'fail', detail: `the token is the operator (${who.login})` }
  }
  return who.login.toLowerCase() === role.toLowerCase()
    ? { name, status: 'ok', detail: `the token is ${who.login}` }
    : { name, status: 'fail', detail: `the token is ${who.login}, expected ${role}` }
}
