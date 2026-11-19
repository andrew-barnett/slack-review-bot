// Runtime preflight: `npm run doctor`.
//
// scripts/install-service.sh checks what can be checked from a shell before the daemon
// exists — the build, the credentials file mode, the Codex profile. Everything else is
// only knowable by asking Slack and the filesystem, and every one of those failures
// produces the same symptom: the bot receives messages and never visibly reacts. This
// turns each of them into a line of output.
//
// Exit code is 1 if any check failed, so it can gate a launch.

import { execFile, spawn } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { promisify } from 'util'
import { WebClient } from '@slack/web-api'
import { resolveBedrockAuth, type BedrockAuth } from './bedrock-auth'
import { isDualMode, loadConfig, loadReviewConfig, looksLikeUserId, scrubDaemonSecrets, type Config, type ReviewConfig } from './config'
import { inContainer } from './container'
import {
  checkDaemonSecretsAbsent,
  checkEngineRole,
  checkGhLoggedOut,
  checkNoDockerSocket,
  checkPidNamespace,
  checkSecretsDenied,
  checkTokenIdentity,
  engineAwsEnv,
  parseDoctorRole,
  type ContainerProbe,
} from './doctor-container'
import { orchestratorConfig } from './orchestrator'
import { ORCHESTRATOR_BUNDLE, readSecretBundle, WORKER_DOCTOR_BUNDLE } from './secret-bundle'
import { assertWorkerConfig } from './worker'
import { redactSecrets } from './redact'
import type { Exec } from './registry-auth'
import { readCursorFile } from './cursor'
import {
  DOCTOR_PROBE_PR_VAR,
  checkChildEnvIsolation,
  checkRoleIdentity,
  ghEnvAs,
  lookupLogin,
  probeEngineReadOnly,
} from './doctor-dual'
import { defaultRunner, type GhRunner } from './gh-api'

export type CheckStatus = 'ok' | 'warn' | 'fail'

export interface CheckResult {
  name: string
  status: CheckStatus
  detail: string
}

const MARK: Record<CheckStatus, string> = { ok: 'ok  ', warn: 'warn', fail: 'FAIL' }

/**
 * Format the report and decide the exit code. Warnings never fail the run: they are for
 * things that cannot be verified from here, which is different from being wrong.
 */
export function summarise(results: CheckResult[]): { lines: string[]; exitCode: number } {
  const width = results.reduce((max, r) => Math.max(max, r.name.length), 0)
  const lines = results.map(r => `${MARK[r.status]}  ${r.name.padEnd(width)}  ${r.detail}`)
  const failed = results.filter(r => r.status === 'fail').length
  const warned = results.filter(r => r.status === 'warn').length

  lines.push('')
  if (failed) {
    lines.push(`${failed} failed, ${warned} warning${warned === 1 ? '' : 's'} — fix the failures before launching.`)
  } else if (warned) {
    lines.push(`No failures, ${warned} warning${warned === 1 ? '' : 's'} — see above for what could not be verified.`)
  } else {
    lines.push('All checks passed.')
  }
  return { lines, exitCode: failed ? 1 : 0 }
}

/**
 * An ignore entry that is not a user ID can never match an event, so the filter it was
 * written for silently does nothing. That is exactly the class of failure this tool is
 * for, so it counts as a failure rather than a warning.
 */
export function checkIgnoreList(ids: string[]): CheckResult {
  const name = 'ignore list'
  if (!ids.length) return { name, status: 'ok', detail: 'empty — every human is reviewed' }
  const bad = ids.filter(id => !looksLikeUserId(id))
  if (bad.length) {
    return {
      name,
      status: 'fail',
      detail: `not user IDs: ${bad.join(', ')} — want U…/W… from Slack's Copy member ID`,
    }
  }
  return { name, status: 'ok', detail: `${ids.length} ignored: ${ids.join(', ')}` }
}

/** Slack's error code for a failed Web API call, or the raw error if it is not one. */
function slackErr(error: unknown): string {
  const code = (error as { data?: { error?: string } })?.data?.error
  return code ?? String(error)
}

function isMissingScope(error: unknown): boolean {
  const code = (error as { data?: { error?: string } })?.data?.error
  return code === 'missing_scope' || code === 'not_allowed_token_type'
}

async function checkBotToken(client: WebClient): Promise<CheckResult> {
  const name = 'bot token'
  try {
    const res = await client.auth.test()
    return { name, status: 'ok', detail: `${res.user} (${res.user_id}) in ${res.team}` }
  } catch (error) {
    return { name, status: 'fail', detail: `auth.test rejected it: ${slackErr(error)}` }
  }
}

/**
 * Validates the app-level token the only way Slack offers: by asking for a socket URL.
 * The URL is discarded — opening it is what the daemon does, and doing it twice here
 * would just churn a connection.
 */
async function checkAppToken(appToken: string): Promise<CheckResult> {
  const name = 'app token'
  try {
    await new WebClient(appToken).apps.connections.open()
    return { name, status: 'ok', detail: 'apps.connections.open accepted it' }
  } catch (error) {
    return { name, status: 'fail', detail: `apps.connections.open rejected it: ${slackErr(error)}` }
  }
}

/**
 * Membership matters as much as the ID being valid: the bot receives messages only from
 * channels it has been invited to, so an allowlisted channel it is not in is silence.
 */
async function checkChannels(client: WebClient, ids: string[]): Promise<CheckResult[]> {
  if (!ids.length) {
    return [
      {
        name: 'channels',
        status: 'warn',
        detail: 'no allowlist — every channel the bot is in will trigger reviews',
      },
    ]
  }
  return Promise.all(
    ids.map(async (id): Promise<CheckResult> => {
      const name = `channel ${id}`
      try {
        const res = await client.conversations.info({ channel: id })
        const channel = res.channel as { name?: string; is_member?: boolean } | undefined
        if (!channel?.is_member) {
          return {
            name,
            status: 'fail',
            detail: `#${channel?.name ?? '?'} exists but the bot is not a member — /invite it`,
          }
        }
        return { name, status: 'ok', detail: `#${channel.name}, bot is a member` }
      } catch (error) {
        if (isMissingScope(error)) {
          return { name, status: 'warn', detail: 'cannot verify — add the channels:read scope' }
        }
        return { name, status: 'fail', detail: `conversations.info failed: ${slackErr(error)}` }
      }
    })
  )
}

/**
 * Every emoji the bot reacts with in the configured mode. Dual mode adds the three gate
 * outcomes, so a missing one is caught here rather than as a failed reaction mid-review.
 */
export function wantedEmoji(config: ReviewConfig): string[] {
  const names = [
    config.ackEmoji,
    config.queuedEmoji,
    config.passEmoji,
    config.findingsEmoji,
    config.errorEmoji,
    config.humanReviewEmoji,
  ]
  if (isDualMode(config)) {
    names.push(config.approvalPartialEmoji, config.approvalNotCountedEmoji, config.headMovedEmoji)
  }
  return [...new Set(names)]
}

/**
 * A missing emoji does not stop a review, but it does lose the channel-level verdict,
 * which is the part anyone actually looks at. Only custom emoji are listable, so a name
 * that is absent may still be a valid built-in — hence a warning, never a failure.
 */
export async function checkEmoji(client: WebClient, config: Config): Promise<CheckResult> {
  const name = 'emoji'
  // Every emoji the bot actually reacts with, so the preflight can't pass while a configured
  // queued/human-review emoji is missing and its reaction fails at runtime (#20). Deduped in
  // case an operator points two of them at the same name.
  const wanted = wantedEmoji(config)
  try {
    const res = await client.emoji.list()
    const custom = new Set(Object.keys(res.emoji ?? {}))
    const unknown = wanted.filter(e => !custom.has(e))
    if (!unknown.length) return { name, status: 'ok', detail: `all custom: ${wanted.join(', ')}` }
    return {
      name,
      status: 'warn',
      detail: `not custom emoji: ${unknown.join(', ')} — fine if they are built-in names`,
    }
  } catch (error) {
    if (isMissingScope(error)) {
      return { name, status: 'warn', detail: 'cannot verify — add the emoji:read scope' }
    }
    return { name, status: 'warn', detail: `emoji.list failed: ${slackErr(error)}` }
  }
}

/** Ceiling on any one external check command, so a wedged binary fails the check instead of hanging the doctor. */
export const CHECK_COMMAND_TIMEOUT_MS = 30_000

export type CommandResult = { code: number; output: string }
export type CommandRunner = (command: string, args: string[], env?: NodeJS.ProcessEnv) => Promise<CommandResult>

/**
 * Run a command to completion, SIGKILLing its whole process group after `timeoutMs` (the same bound
 * the gh runner uses). The timeout resolves from the timer itself: a grandchild (bash running
 * `node check-claude-profile.js`) can hold the pipes open after the direct child dies, so 'close'
 * may never fire.
 */
export function run(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
  timeoutMs: number = CHECK_COMMAND_TIMEOUT_MS
): Promise<CommandResult> {
  return new Promise(resolve => {
    let settled = false
    const finish = (result: CommandResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }
    // Detached puts the child in its own process group, so the timeout can kill its descendants too.
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], env, detached: true })
    let output = ''
    const timer = setTimeout(() => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL')
      } catch {
        // The group is already gone; fall back to the direct child.
        child.kill('SIGKILL')
      }
      // Stop reading so a surviving holder of the pipes cannot keep the doctor's event loop busy.
      child.stdout.destroy()
      child.stderr.destroy()
      finish({ code: -1, output: `timed out after ${timeoutMs}ms` })
    }, timeoutMs)
    child.stdout.on('data', chunk => (output += chunk))
    child.stderr.on('data', chunk => (output += chunk))
    child.on('error', error => finish({ code: -1, output: String(error) }))
    child.on('close', code => finish({ code: code ?? -1, output }))
  })
}

/** The PATH launchd hands a GUI agent. Everything else has to be put there deliberately. */
const LAUNCHD_BASE_PATH = '/usr/bin:/bin:/usr/sbin:/sbin'

const AGENT_PLIST = path.join(
  os.homedir(),
  'Library',
  'LaunchAgents',
  'com.abarnett.slack-review-bot.plist'
)

/** Recover the PATH prefix install-service.sh baked into the plist. Pure, for the tests. */
export function parseAgentPathPrefix(plistXml: string): string | undefined {
  return /export PATH="([^"]*?):\$PATH"/.exec(plistXml)?.[1]
}

function isExecutableFile(candidate: string): boolean {
  try {
    // statSync follows symlinks, so a Homebrew shim pointing into a pruned Caskroom
    // version reads as missing here exactly as it would when spawned.
    if (!fs.statSync(candidate).isFile()) return false
    fs.accessSync(candidate, fs.constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** First match for `tool` walking `pathValue` left to right, the way execvp does. */
export function findOnPath(
  tool: string,
  pathValue: string,
  isExecutable: (candidate: string) => boolean = isExecutableFile
): string | undefined {
  for (const dir of pathValue.split(':')) {
    if (!dir) continue
    const candidate = path.join(dir, tool)
    if (isExecutable(candidate)) return candidate
  }
  return undefined
}

/**
 * Reconstruct the PATH the LaunchAgent actually runs with, rather than reporting on this
 * shell's.
 *
 * Checking the toolchain from a terminal is worse than useless here: it reliably passes
 * while the agent is broken. The agent's PATH is the plist's baked-in prefix followed by
 * whatever `zsh -lc` derives from launchd's bare environment — which is much less than an
 * interactive shell has, because a non-interactive login shell never reads ~/.zshrc, where
 * `brew shellenv` and nvm live. Reproducing it means running that same shell with the
 * environment stripped back to what launchd provides.
 *
 * Returns undefined when no agent is installed, in which case there is no second PATH to
 * report on and the remaining checks fall back to this process's own.
 */
async function resolveAgentPath(): Promise<string | undefined> {
  if (!fs.existsSync(AGENT_PLIST)) return undefined
  const prefix = parseAgentPathPrefix(fs.readFileSync(AGENT_PLIST, 'utf8'))
  if (prefix === undefined) return undefined

  const { code, output } = await run('/bin/zsh', ['-lc', 'printf %s "$PATH"'], {
    HOME: os.homedir(),
    USER: os.userInfo().username,
    PATH: LAUNCHD_BASE_PATH,
  })
  return `${prefix}:${code === 0 ? output.trim() : LAUNCHD_BASE_PATH}`
}

/**
 * The tools the agent must resolve: Claude joins the list only in dual mode, and `aws` only in
 * bedrock role mode, where the daemon mints engine credentials with `aws sts assume-role`.
 */
export function agentTools(config: ReviewConfig): string[] {
  const tools = isDualMode(config) ? ['codex', 'claude', 'gh', 'git', 'npm'] : ['codex', 'gh', 'git', 'npm']
  if (config.engineAuth === 'bedrock' && config.engineRoleArn) tools.push('aws')
  return tools
}

const execFileAsync = promisify(execFile)

/** The mint's exec, bounded like every other doctor command so a wedged `aws` fails the check. */
const boundedExec: Exec = (file, args) =>
  execFileAsync(file, args, { timeout: CHECK_COMMAND_TIMEOUT_MS, killSignal: 'SIGKILL' })

/**
 * The environment the identity probe runs in: only PATH, HOME, the engine credentials and the
 * region, with the AWS config and shared-credentials files pointed at /dev/null, so the answer
 * can only come from the minted credentials and never from a profile on disk.
 */
export function bedrockProbeEnv(pathValue: string, home: string, auth: BedrockAuth): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: pathValue,
    HOME: home,
    AWS_ACCESS_KEY_ID: auth.credentials.accessKeyId,
    AWS_SECRET_ACCESS_KEY: auth.credentials.secretAccessKey,
    AWS_REGION: auth.region,
    AWS_CONFIG_FILE: '/dev/null',
    AWS_SHARED_CREDENTIALS_FILE: '/dev/null',
  }
  if (auth.credentials.sessionToken) env.AWS_SESSION_TOKEN = auth.credentials.sessionToken
  return env
}

/** The role name an assumed-role ARN carries: the last path segment of the role ARN. */
function roleName(roleArn: string): string {
  return roleArn.slice(roleArn.indexOf(':role/') + ':role/'.length).split('/').pop() ?? ''
}

/** The Arn field of `sts get-caller-identity` JSON, found inside output that may carry stderr too. */
function callerArn(output: string): string | undefined {
  const start = output.indexOf('{')
  const end = output.lastIndexOf('}')
  if (start === -1 || end <= start) return undefined
  try {
    const arn = (JSON.parse(output.slice(start, end + 1)) as { Arn?: unknown }).Arn
    return typeof arn === 'string' ? arn : undefined
  } catch {
    return undefined
  }
}

/**
 * ENGINE_AUTH=bedrock (issue #69): prove the engines will get working, correctly scoped credentials.
 * In role mode `aws` must resolve, the mint must succeed, and the minted credentials alone must
 * identify as the engine role; in static mode the captured credentials' identity is reported. The
 * credentials are never printed: errors carry only the STS reason, redacted again here.
 */
export async function checkBedrock(
  config: ReviewConfig,
  agentPath: string | undefined,
  deps: {
    runCommand?: CommandRunner
    exec?: Exec
    find?: (tool: string, pathValue: string) => string | undefined
    pathValue?: string
    home?: string
  } = {}
): Promise<CheckResult[]> {
  const runCommand = deps.runCommand ?? run
  const pathValue = agentPath ?? deps.pathValue ?? process.env.PATH ?? ''
  const home = deps.home ?? os.homedir()
  const role = Boolean(config.engineRoleArn)
  const results: CheckResult[] = []
  if (role) {
    const found = (deps.find ?? findOnPath)('aws', pathValue)
    if (!found) {
      return [{ name: 'bedrock aws cli', status: 'fail', detail: '`aws` does not resolve on PATH; the daemon cannot mint engine credentials' }]
    }
    results.push({ name: 'bedrock aws cli', status: 'ok', detail: found })
  }
  let auth: BedrockAuth
  try {
    auth = await resolveBedrockAuth(config, 'claude', 'doctor', deps.exec ?? boundedExec)
  } catch (error) {
    return [...results, { name: 'bedrock credentials', status: 'fail', detail: redactSecrets(error instanceof Error ? error.message : String(error)) }]
  }
  results.push({
    name: 'bedrock credentials',
    status: 'ok',
    detail: role ? `assumed ${config.engineRoleArn}` : 'static credentials from the daemon environment',
  })
  const { code, output } = await runCommand('aws', ['sts', 'get-caller-identity', '--output', 'json'], bedrockProbeEnv(pathValue, home, auth))
  const arn = code === 0 ? callerArn(output) : undefined
  if (!arn) {
    const reason = redactSecrets(output.trim().split('\n')[0]?.slice(0, 300) || `exit ${code}`)
    return [...results, { name: 'bedrock identity', status: 'fail', detail: `sts get-caller-identity failed with the engine credentials: ${reason}` }]
  }
  if (!role) return [...results, { name: 'bedrock identity', status: 'ok', detail: arn }]
  const want = `:assumed-role/${roleName(config.engineRoleArn)}/`
  return [
    ...results,
    arn.includes(want)
      ? { name: 'bedrock identity', status: 'ok', detail: arn }
      : { name: 'bedrock identity', status: 'fail', detail: `the engine credentials identify as ${arn}, not the role ${config.engineRoleArn}` },
  ]
}

/**
 * Every tool the review shells out to has to be reachable from the agent, not just from a
 * terminal. A miss here is what produces `spawn codex ENOENT` on the first real review —
 * hours or days after a startup that looked completely healthy, because the plist invokes
 * node by absolute path and only PATH-resolved children fail.
 */
function checkAgentToolchain(agentPath: string | undefined, wanted: string[]): CheckResult {
  const name = 'agent PATH'
  if (agentPath === undefined) {
    return {
      name,
      status: 'warn',
      detail: `no agent installed at ${AGENT_PLIST} — checks below use this shell's PATH`,
    }
  }
  const missing = wanted.filter(tool => !findOnPath(tool, agentPath))
  if (missing.length) {
    return {
      name,
      status: 'fail',
      detail: `unreachable from the agent: ${missing.join(', ')} — it would fail with spawn ${missing[0]} ENOENT. Re-run scripts/install-service.sh`,
    }
  }
  return { name, status: 'ok', detail: `${wanted.join(', ')} all resolve` }
}

/** Run against the agent's PATH when there is one, so this agrees with what the daemon sees. */
async function checkBinary(
  name: string,
  bin: string,
  agentPath: string | undefined,
  runCommand: CommandRunner = run
): Promise<CheckResult> {
  const env = agentPath === undefined ? process.env : { ...process.env, PATH: agentPath }
  const { code, output } = await runCommand(bin, ['--version'], env)
  if (code !== 0) {
    const where = agentPath === undefined ? '' : " using the agent's PATH"
    return {
      name,
      status: 'fail',
      detail: `\`${bin} --version\` failed${where}: ${output.trim() || `exit ${code}`}`,
    }
  }
  return { name, status: 'ok', detail: `${bin} — ${output.trim().split('\n')[0]}` }
}

/**
 * Defers to the Claude installer's --check, so there is one definition of a valid profile.
 * The roots come from config so the check validates the same grants the engine runs with; the
 * daemon env file and gh config dir are not config fields, so the installer resolves them from
 * its own defaults and variables, as the daemon's other checks do.
 */
export async function checkClaudeProfile(config: Config, runCommand: CommandRunner = run, extraArgs: string[] = []): Promise<CheckResult> {
  const name = 'claude profile'
  const script = path.join(__dirname, '..', 'scripts', 'install-claude-profile.sh')
  if (!fs.existsSync(script)) {
    return { name, status: 'fail', detail: `installer not found at ${script}` }
  }
  const { code, output } = await runCommand(script, [
    '--check',
    '--dir',
    config.claudeConfigDir,
    '--workspace-root',
    config.workspaceRoot,
    '--worktree-root',
    config.worktreeRoot,
    ...extraArgs,
  ])
  return code === 0
    ? { name, status: 'ok', detail: output.trim().split('\n').pop() || 'valid' }
    : { name, status: 'fail', detail: output.trim().split('\n')[0] || `exit ${code}` }
}

/**
 * The dual-mode checks (spec 5.10). Each guards a property the gate's safety rests on: the
 * engine binary and its isolated profile, one role account behind both tokens, an engine token
 * that cannot write, and an approver token no engine can see.
 */
export async function checkDualMode(
  config: Config,
  agentPath: string | undefined,
  deps: { gh?: GhRunner; base?: NodeJS.ProcessEnv; runCommand?: CommandRunner } = {}
): Promise<CheckResult[]> {
  const gh = deps.gh ?? defaultRunner('gh')
  const runCommand = deps.runCommand ?? run
  // main() has scrubbed both daemon tokens from the process environment; ghEnvAs also strips
  // every other GitHub token, so each lookup runs as exactly one identity.
  const base = deps.base ?? process.env
  const [approver, engine, operator] = await Promise.all([
    lookupLogin(gh, ghEnvAs(base, config.approverGhToken)),
    lookupLogin(gh, ghEnvAs(base, config.engineGhToken)),
    lookupLogin(gh, ghEnvAs(base)),
  ])
  return [
    await checkBinary('claude binary', config.claudeBin, agentPath, runCommand),
    await checkClaudeProfile(config, runCommand),
    checkRoleIdentity(approver, engine, operator),
    await probeEngineReadOnly(gh, base, config.engineGhToken, base[DOCTOR_PROBE_PR_VAR]),
    checkChildEnvIsolation(config, base),
  ]
}

/** Defers to the installer's own --check, so there is one definition of a valid profile. */
export async function checkCodexProfile(config: ReviewConfig, runCommand: CommandRunner = run, extraArgs: string[] = []): Promise<CheckResult> {
  const name = 'codex profile'
  const script = path.join(__dirname, '..', 'scripts', 'install-codex-profile.sh')
  if (!fs.existsSync(script)) {
    return { name, status: 'warn', detail: `installer not found at ${script}` }
  }
  const { code, output } = await runCommand(script, ['--check', '--name', config.codexProfile, ...extraArgs])
  return code === 0
    ? { name, status: 'ok', detail: output.trim().split('\n').pop() ?? 'valid' }
    : { name, status: 'fail', detail: output.trim().split('\n')[0] ?? `exit ${code}` }
}

function isDirectory(target: string): boolean {
  try {
    return fs.statSync(target).isDirectory()
  } catch {
    return false
  }
}

function isWritable(target: string): boolean {
  try {
    fs.accessSync(target, fs.constants.W_OK)
    return true
  } catch {
    return false
  }
}

/** Both roots are handed to Codex as sandbox writable roots; a wrong one fails mid-review. */
export function checkRoots(config: Config): CheckResult[] {
  const results: CheckResult[] = []

  results.push(
    isDirectory(config.workspaceRoot)
      ? { name: 'workspace root', status: 'ok', detail: config.workspaceRoot }
      : {
          name: 'workspace root',
          status: 'fail',
          detail: `${config.workspaceRoot} is not a directory — checkouts live here`,
        }
  )

  const worktree = config.worktreeRoot
  if (isDirectory(worktree)) {
    results.push({ name: 'worktree root', status: 'ok', detail: worktree })
  } else if (isWritable(path.dirname(worktree))) {
    results.push({ name: 'worktree root', status: 'ok', detail: `${worktree} — will be created on first use` })
  } else {
    results.push({
      name: 'worktree root',
      status: 'fail',
      detail: `${worktree} does not exist and ${path.dirname(worktree)} is not writable`,
    })
  }

  if (config.runLogDir && !isDirectory(config.runLogDir) && !isWritable(path.dirname(config.runLogDir))) {
    results.push({
      name: 'run log dir',
      status: 'warn',
      detail: `${config.runLogDir} is not creatable — transcripts will be lost`,
    })
  }

  return results
}

/**
 * The cursor is what lets a restart pick up messages Socket Mode never delivered, and it is
 * the one piece of daemon state that has to outlive the process. An unwritable file is a
 * failure rather than a warning: the daemon would keep reviewing, and every restart would
 * quietly drop whatever was posted while it was down.
 */
export function checkCursor(config: Config): CheckResult[] {
  const name = 'cursor file'
  if (!config.cursorFile) {
    return [
      {
        name,
        status: 'warn',
        detail: 'CURSOR_FILE is empty — messages posted while the daemon is down are lost',
      },
    ]
  }

  const results: CheckResult[] = []
  const file = config.cursorFile
  if (fs.existsSync(file)) {
    const cursors = readCursorFile(file, () => {})
    const channels = Object.keys(cursors.channels).length
    results.push(
      isWritable(file)
        ? {
            name,
            status: 'ok',
            detail: `${file} — ${channels} channel${channels === 1 ? '' : 's'} recorded`,
          }
        : { name, status: 'fail', detail: `${file} is not writable — the position cannot advance` }
    )
  } else if (isWritable(path.dirname(file)) || isWritable(path.dirname(path.dirname(file)))) {
    results.push({ name, status: 'ok', detail: `${file} — will be created on first message` })
  } else {
    results.push({ name, status: 'fail', detail: `${file} is not creatable` })
  }

  if (!config.replayEnabled) {
    results.push({
      name: 'replay',
      status: 'warn',
      detail: 'REPLAY_ENABLED is off — the position is recorded but never acted on',
    })
    return results
  }

  // Which triggers will actually fire. Worth its own line because the catch-up is what makes a
  // message missed during a network blip recoverable without anyone noticing and restarting
  // the daemon — and switching both of the live triggers off restores exactly that old
  // behaviour, silently, from two environment variables that look like tuning knobs.
  const triggers = ['startup']
  if (config.catchUpOnReconnect) triggers.push('reconnect')
  if (config.catchUpIntervalMs > 0) triggers.push(`every ${formatMs(config.catchUpIntervalMs)}`)
  results.push(
    triggers.length === 1
      ? {
          name: 'catch-up',
          status: 'warn',
          detail:
            'startup only — CATCHUP_INTERVAL_MS is 0 and CATCHUP_ON_RECONNECT is off, so a message ' +
            'missed while offline waits for a restart',
        }
      : { name: 'catch-up', status: 'ok', detail: triggers.join(', ') }
  )
  return results
}

/** Coarse ms for a preflight line: `300000` tells you much less than `5m`. */
function formatMs(ms: number): string {
  if (ms % 60_000 === 0) return `${ms / 60_000}m`
  return `${Math.round(ms / 1000)}s`
}

/**
 * Turn a failed history read into the thing to go and do about it.
 *
 * The distinction that matters is between "replay cannot read this channel" and "the bot is
 * not in this channel at all" — the second one means no live event is being delivered either,
 * so the channel has never worked, and saying only that replay will skip it would send the
 * reader looking for a bug in the catch-up.
 */
export function explainHistoryError(error: unknown): string {
  const code = slackErr(error)
  switch (code) {
    case 'not_in_channel':
    case 'channel_not_found':
      return `${code} — the bot is not in this channel, so it receives no messages from it either: /invite it`
    case 'missing_scope':
    case 'not_allowed_token_type':
      return `${code} — add channels:history (groups:history for a private channel) and reinstall`
    default:
      return `conversations.history failed: ${code} — replay will skip this channel`
  }
}

/**
 * Replay reads history with `conversations.history`, which needs `channels:history` and
 * membership. Socket Mode delivery needs the same scope and the same membership, so this is
 * also the check that catches a channel the bot was never invited to when `channels:read` is
 * absent and the membership check above could only warn.
 */
async function checkHistoryAccess(client: WebClient, config: Config): Promise<CheckResult[]> {
  const channels = config.channelIds.length
    ? config.channelIds
    : Object.keys(readCursorFile(config.cursorFile, () => {}).channels)
  if (!config.cursorFile || !config.replayEnabled || !channels.length) return []

  return Promise.all(
    channels.map(async (channel): Promise<CheckResult> => {
      const name = `history ${channel}`
      try {
        await client.conversations.history({ channel, limit: 1 })
        return { name, status: 'ok', detail: 'readable — replay can catch up on this channel' }
      } catch (error) {
        return { name, status: 'fail', detail: explainHistoryError(error) }
      }
    })
  )
}

/**
 * Permissions only. This never opens the file: its whole content is two Slack tokens, and
 * the daemon is the only thing that should ever read it.
 */
function checkCredentialsFile(): CheckResult {
  const name = 'credentials file'
  const file =
    process.env.SLACK_REVIEW_BOT_ENV || path.join(os.homedir(), '.config', 'slack-review-bot', 'env')
  try {
    const mode = fs.statSync(file).mode & 0o777
    return mode === 0o600
      ? { name, status: 'ok', detail: `${file} is 0600` }
      : { name, status: 'fail', detail: `${file} is 0${mode.toString(8)} — chmod 600 (it holds both tokens)` }
  } catch {
    return {
      name,
      status: 'warn',
      detail: `${file} not found — fine if the tokens come from the shell instead`,
    }
  }
}

/** The live probe for the container checks. */
function liveProbe(base: NodeJS.ProcessEnv): ContainerProbe {
  const gh = defaultRunner('gh')
  return {
    env: base,
    exists: p => fs.existsSync(p),
    readFile: p => {
      try {
        return fs.readFileSync(p, 'utf8')
      } catch {
        return undefined
      }
    },
    runCommand: run,
    lookupLogin: token => lookupLogin(gh, ghEnvAs(base, token)),
  }
}

/** `doctor --role worker` (spec 3.7): the bundle arrives on stdin exactly as for a real worker. */
async function workerDoctor(): Promise<CheckResult[]> {
  // Check the environment the container started with, before the bundle is merged and before
  // scrubDaemonSecrets deletes APPROVER_GH_TOKEN: scrubbing first would hide exactly the leak this
  // check exists to catch (a daemon token handed to the container that runs PR code).
  const daemonSecrets = await checkDaemonSecretsAbsent(liveProbe({ ...process.env }))
  const { WORKER_TICKET: _ticket, ...exported } = await readSecretBundle(process.stdin, WORKER_DOCTOR_BUNDLE)
  Object.assign(process.env, exported)
  const config = loadReviewConfig(process.env)
  assertWorkerConfig(config)
  scrubDaemonSecrets(process.env, config)
  const probe = liveProbe(process.env)
  const awsEnv = engineAwsEnv(process.env, config.engineAwsStatic!, config.bedrockRegion)
  // The worker's profile files live under the image's HOME; these flags select the container checks.
  const claudeArgs = ['--container', '--npmrc', process.env.npm_config_userconfig || '/home/bot/.npmrc-worker']
  return [
    daemonSecrets,
    await checkGhLoggedOut(probe),
    await checkEngineRole(probe, awsEnv),
    await checkSecretsDenied(probe, awsEnv, config.bedrockRegion),
    checkPidNamespace(probe),
    checkNoDockerSocket(probe),
    await checkTokenIdentity(probe, 'engine token', config.engineGhToken),
    await checkClaudeProfile(config as Config, run, claudeArgs),
    await checkCodexProfile(config, run, ['--container']),
    // The worker logs runs to its own temp dir and ships them to the orchestrator; RUN_LOG_DIR is unused.
    ...checkRoots(config as Config).filter(r => r.name !== 'run log dir'),
  ]
}

/** `doctor --role orchestrator`: Slack, the approver identity, and the container's own isolation. */
async function orchestratorDoctor(): Promise<CheckResult[]> {
  const bundle = await readSecretBundle(process.stdin, ORCHESTRATOR_BUNDLE)
  const { config } = orchestratorConfig(bundle, process.env)
  const probe = liveProbe(process.env)
  const client = new WebClient(config.botToken)
  return [
    await checkBotToken(client),
    await checkAppToken(config.appToken),
    ...(await checkChannels(client, config.channelIds)),
    checkIgnoreList(config.ignoreUserIds),
    await checkEmoji(client, config),
    await checkGhLoggedOut(probe),
    checkNoDockerSocket(probe),
    checkPidNamespace(probe),
    await checkTokenIdentity(probe, 'approver token', config.approverGhToken),
    ...checkCursor(config),
    ...(await checkHistoryAccess(client, config)),
  ]
}

async function containerDoctor(role: 'orchestrator' | 'worker' | undefined): Promise<CheckResult[]> {
  if (!role) {
    return [{ name: 'role', status: 'fail', detail: 'in a container, run doctor --role orchestrator or --role worker' }]
  }
  try {
    return role === 'worker' ? await workerDoctor() : await orchestratorDoctor()
  } catch (error) {
    return [{ name: `${role} setup`, status: 'fail', detail: redactSecrets(String(error)) }]
  }
}

async function main(): Promise<void> {
  const role = parseDoctorRole(process.argv.slice(2))
  // Spec 3.7: in a container the launchd PATH and env-file checks do not apply.
  if (role || inContainer()) {
    const { lines, exitCode } = summarise(await containerDoctor(role))
    process.stdout.write(`${lines.join('\n')}\n`)
    process.exitCode = exitCode
    return
  }
  let config: Config
  try {
    config = loadConfig()
  } catch (error) {
    const { lines, exitCode } = summarise([
      {
        name: 'config',
        status: 'fail',
        detail: `${String(error)} — source the credentials file, or run via the LaunchAgent`,
      },
      checkCredentialsFile(),
    ])
    process.stdout.write(`${lines.join('\n')}\n`)
    process.exitCode = exitCode
    return
  }

  // The tokens now live only on `config`; no check below may find them in the process environment.
  scrubDaemonSecrets(process.env, config)
  const client = new WebClient(config.botToken)
  const agentPath = await resolveAgentPath()
  const results: CheckResult[] = [
    checkCredentialsFile(),
    await checkBotToken(client),
    await checkAppToken(config.appToken),
    ...(await checkChannels(client, config.channelIds)),
    checkIgnoreList(config.ignoreUserIds),
    await checkEmoji(client, config),
    checkAgentToolchain(agentPath, agentTools(config)),
    await checkBinary('codex binary', config.codexBin, agentPath),
    await checkCodexProfile(config),
    ...(isDualMode(config) ? await checkDualMode(config, agentPath) : []),
    ...(config.engineAuth === 'bedrock' ? await checkBedrock(config, agentPath) : []),
    ...checkRoots(config),
    ...checkCursor(config),
    ...(await checkHistoryAccess(client, config)),
  ]

  const { lines, exitCode } = summarise(results)
  process.stdout.write(`${lines.join('\n')}\n`)
  process.exitCode = exitCode
}

// Only run when invoked directly, so the unit tests can import the pure helpers.
if (require.main === module) {
  main().catch(error => {
    process.stderr.write(`${String(error)}\n`)
    process.exit(1)
  })
}
