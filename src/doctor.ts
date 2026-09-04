// Runtime preflight: `npm run doctor`.
//
// scripts/install-service.sh checks what can be checked from a shell before the daemon
// exists — the build, the credentials file mode, the Codex profile. Everything else is
// only knowable by asking Slack and the filesystem, and every one of those failures
// produces the same symptom: the bot receives messages and never visibly reacts. This
// turns each of them into a line of output.
//
// Exit code is 1 if any check failed, so it can gate a launch.

import { spawn } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { WebClient } from '@slack/web-api'
import { loadConfig, looksLikeUserId, type Config } from './config'
import { readCursorFile } from './cursor'

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
 * A missing emoji does not stop a review, but it does lose the channel-level verdict,
 * which is the part anyone actually looks at. Only custom emoji are listable, so a name
 * that is absent may still be a valid built-in — hence a warning, never a failure.
 */
export async function checkEmoji(client: WebClient, config: Config): Promise<CheckResult> {
  const name = 'emoji'
  // Every emoji the bot actually reacts with, so the preflight can't pass while a configured
  // queued/human-review emoji is missing and its reaction fails at runtime (#20). Deduped in
  // case an operator points two of them at the same name.
  const wanted = [
    ...new Set([
      config.ackEmoji,
      config.queuedEmoji,
      config.passEmoji,
      config.findingsEmoji,
      config.errorEmoji,
      config.humanReviewEmoji,
    ]),
  ]
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

function run(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env
): Promise<{ code: number; output: string }> {
  return new Promise(resolve => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], env })
    let output = ''
    child.stdout.on('data', chunk => (output += chunk))
    child.stderr.on('data', chunk => (output += chunk))
    child.on('error', error => resolve({ code: -1, output: String(error) }))
    child.on('close', code => resolve({ code: code ?? -1, output }))
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
 * Every tool the review shells out to has to be reachable from the agent, not just from a
 * terminal. A miss here is what produces `spawn codex ENOENT` on the first real review —
 * hours or days after a startup that looked completely healthy, because the plist invokes
 * node by absolute path and only PATH-resolved children fail.
 */
function checkAgentToolchain(agentPath: string | undefined): CheckResult {
  const name = 'agent PATH'
  if (agentPath === undefined) {
    return {
      name,
      status: 'warn',
      detail: `no agent installed at ${AGENT_PLIST} — checks below use this shell's PATH`,
    }
  }
  const wanted = ['codex', 'gh', 'git', 'npm']
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
async function checkCodexBin(bin: string, agentPath: string | undefined): Promise<CheckResult> {
  const name = 'codex binary'
  const env = agentPath === undefined ? process.env : { ...process.env, PATH: agentPath }
  const { code, output } = await run(bin, ['--version'], env)
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

/** Defers to the installer's own --check, so there is one definition of a valid profile. */
async function checkCodexProfile(config: Config): Promise<CheckResult> {
  const name = 'codex profile'
  const script = path.join(__dirname, '..', 'scripts', 'install-codex-profile.sh')
  if (!fs.existsSync(script)) {
    return { name, status: 'warn', detail: `installer not found at ${script}` }
  }
  const { code, output } = await run(script, ['--check', '--name', config.codexProfile])
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

async function main(): Promise<void> {
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

  const client = new WebClient(config.botToken)
  const agentPath = await resolveAgentPath()
  const results: CheckResult[] = [
    checkCredentialsFile(),
    await checkBotToken(client),
    await checkAppToken(config.appToken),
    ...(await checkChannels(client, config.channelIds)),
    checkIgnoreList(config.ignoreUserIds),
    await checkEmoji(client, config),
    checkAgentToolchain(agentPath),
    await checkCodexBin(config.codexBin, agentPath),
    await checkCodexProfile(config),
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
