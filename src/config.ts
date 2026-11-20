// Runtime configuration, read once at startup from the environment.
//
// The Codex child process is built from an ALLOWLIST, not a denylist: it inherits only the
// variables the review toolchain needs (see CODEX_ENV_ALLOWLIST below and buildChildEnv in
// codex.ts), so a secret in the daemon's environment — cloud keys, registry tokens, the Slack
// tokens read here — is never handed to model-directed shell commands or untrusted PR test code
// unless it is explicitly named. CODEX_ENV_PASSTHROUGH is the escape hatch for a var a
// particular install needs.

import * as os from 'os'
import * as path from 'path'
import type { AwsCredentials } from './bedrock-auth'
import { defaultPricesFile } from './pricing'
import { defaultLoginScriptPath } from './registry-auth'

/** The review engines the bot can run. */
export type EngineName = 'codex' | 'claude'
/** Whether a dual run starts both engines at once or one after the other. */
export type EngineSchedule = 'parallel' | 'serial'
/**
 * Where the bot runs: the launchd daemon (the default), or the orchestrator and one-shot worker
 * containers (https://github.com/andrew-barnett/slack-review-bot/issues/70).
 */
export type Runtime = 'launchd' | 'container'
/**
 * How the engines reach their models: the operator's own subscriptions (Codex's ChatGPT login and
 * Claude's OAuth token), or AWS Bedrock with short-lived credentials that can only invoke models.
 */
export type EngineAuth = 'subscription' | 'bedrock'

const ENGINE_AUTH_MODES: readonly EngineAuth[] = ['subscription', 'bedrock']

/**
 * The static AWS variables captured as engine credentials in bedrock mode without a role ARN (a
 * launcher injects them). Deleted from the daemon environment once captured, so they reach engine
 * children only by explicit injection.
 */
export const ENGINE_AWS_STATIC_VARS: readonly string[] = ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN']

/** The shape of an IAM role ARN; anything else is refused before it reaches `aws sts`. */
const ROLE_ARN = /^arn:aws:iam::\d{12}:role\/[\w+=,.@/-]+$/
/** Region and model IDs are interpolated into Codex's TOML `-c` overrides, so only this charset is safe. */
const TOML_SAFE_ID = /^[A-Za-z0-9._:-]+$/

const ENGINE_NAMES: readonly EngineName[] = ['codex', 'claude']

/** The role account's PAT the daemon approves with. Never reaches an engine child. */
export const APPROVER_TOKEN_VAR = 'APPROVER_GH_TOKEN'
/** The role account's read-only token, handed to engines as GH_TOKEN in dual mode. */
export const ENGINE_TOKEN_VAR = 'ENGINE_GH_TOKEN'
/** Daemon-held secrets: denied to every child and deleted from process.env at startup. */
export const DAEMON_SECRET_VARS: readonly string[] = [APPROVER_TOKEN_VAR, ENGINE_TOKEN_VAR]

/**
 * Whether dual mode may run. The orchestrator exists, but this stays false until the filesystem
 * boundary for the approver token lands (https://github.com/andrew-barnett/slack-review-bot/issues/64)
 * and the V1/V3 checks that need the role account's token are done; see the README's flip checklist.
 * Startup refuses dual mode while it is false. Tests reach dual paths through the `available`
 * parameter of assertModeAvailable and selectReviewRunner, never by changing this constant.
 */
export const DUAL_MODE_AVAILABLE = false

/** Throw when dual mode is configured but not available in this build. */
export function assertModeAvailable(config: Pick<ReviewConfig, 'reviewEngines'>, available: boolean = DUAL_MODE_AVAILABLE): void {
  if (isDualMode(config) && !available) {
    throw new Error(
      'REVIEW_ENGINES=codex,claude is not available yet: it is gated on https://github.com/andrew-barnett/slack-review-bot/issues/64'
    )
  }
}

/**
 * Everything needed to run a review. Deliberately free of Slack credentials so the
 * local CLI (`npm run review`) can drive an identical Codex run without a bot token.
 */
export interface ReviewConfig {
  /** Emoji posted as soon as a triggering message is seen. */
  ackEmoji: string
  /** Emoji posted instead while the message waits for a review slot; replaced by `ackEmoji`. */
  queuedEmoji: string
  /** Emoji posted when every reviewed PR passed with no findings. */
  passEmoji: string
  /** Emoji posted when any PR has findings or could not be reviewed. */
  findingsEmoji: string
  /** Emoji posted when the run itself failed (Codex crashed, bad output, timeout). */
  errorEmoji: string
  /** Emoji posted when a PR is handed to a human instead of reviewed (the deployments gate). */
  humanReviewEmoji: string
  /** Dual mode: both engines clean and approved, but the approval does not satisfy every rule. */
  approvalPartialEmoji: string
  /** Dual mode: both engines clean, but an approval from the role account would not count. */
  approvalNotCountedEmoji: string
  /** Dual mode: the PR head moved during the review, so nothing was posted. */
  headMovedEmoji: string
  /** Remove the ack emoji once a terminal reaction is added. */
  removeAckOnComplete: boolean
  /** Path to the codex binary. */
  codexBin: string
  /** Codex config profile name, layered from $CODEX_HOME/<name>.config.toml. */
  codexProfile: string
  /** Working root Codex runs in — the directory holding the local checkouts. */
  workspaceRoot: string
  /** Where the review-pr skill is told to put its per-PR git worktrees. */
  worktreeRoot: string
  /** Hard timeout for one Codex run, in milliseconds. */
  runTimeoutMs: number
  /**
   * Escalating stall grace, in milliseconds, one entry per attempt. A run that produces no
   * output for the current entry's worth of *active* time is killed and retried with the next,
   * longer entry; a run that goes silent on the last entry is killed for good. Empty disables
   * stall detection and retries entirely. Each entry is clamped to `stallMaxMs`.
   */
  stallBackoffMs: number[]
  /** Ceiling on any single stall grace, so no attempt waits longer than this for output. */
  stallMaxMs: number
  /** How many reviews may run at once. */
  concurrency: number
  /** Disable git commit signing in the Codex child process. */
  disableGitSigning: boolean
  /** Directory for per-run logs and raw Codex output. Empty disables run logging. */
  runLogDir: string
  /**
   * Extra environment variable names to pass through to the Codex child, on top of
   * {@link CODEX_ENV_ALLOWLIST}. The escape hatch for an install whose reviews need a variable
   * the allowlist does not cover; keep it minimal, since anything added here reaches
   * model-directed commands and untrusted PR code.
   */
  codexEnvPassthrough: string[]
  /**
   * Whether to refresh the AWS CodeArtifact npm token before each review (issue #42). Platform
   * repos install `@trade-platform/*` from CodeArtifact, whose tokens expire within 12 hours; a
   * days-old daemon otherwise hands every review a stale token and `npm ci` fails with E401.
   * The operator kill switch — turn it off for an install with no private registry.
   */
  codeartifactRefreshEnabled: boolean
  /** Absolute path to the vendored CodeArtifact login script the refresh runs. */
  codeartifactLoginScript: string
  /** Engines to run: `['codex']` (single mode) or both (dual mode). */
  reviewEngines: EngineName[]
  /** Dual mode only: run the engines at once or one after the other. */
  engineSchedule: EngineSchedule
  /** Serial order; equals `reviewEngines` in single mode. */
  engineOrder: EngineName[]
  /** Dual mode only: the approver PAT. Empty in single mode. Never logged, never passed to a child. */
  approverGhToken: string
  /** Dual mode only: the read-only engine token. Empty in single mode. */
  engineGhToken: string
  /** Claude Code binary (Plan 2). */
  claudeBin: string
  /** Dedicated Claude config dir for the engine (Plan 2). */
  claudeConfigDir: string
  /** RUNTIME: the launchd daemon (default) or the orchestrator and worker containers. */
  runtime: Runtime
  /** Container runtime: a worker with no job after this long exits; its ticket lives one minute longer. */
  workerIdleExitMs: number
  /** Container runtime, worker side: the orchestrator's job server. */
  orchestratorUrl: string
  /** Container runtime, orchestrator side: the job server's port on the internal network. */
  jobPort: number
  /**
   * How the engines authenticate to their models (issue #69). `subscription` (the default) changes
   * nothing; `bedrock` routes both engines through AWS Bedrock with short-lived credentials.
   */
  engineAuth: EngineAuth
  /** Bedrock mode: the AWS region both engines call Bedrock in. */
  bedrockRegion: string
  /** Bedrock mode: the model ID Codex uses on the Bedrock Mantle endpoint (e.g. `openai.gpt-5.6-terra`). */
  codexBedrockModel: string
  /**
   * Bedrock mode: the Mantle project Codex calls through, sent as the `OpenAI-Project` header. The
   * account's bedrock-runtime data-retention mode is `none`, which OpenAI models reject; this project
   * carries `default`. Account-specific, so there is no default; required in bedrock mode.
   */
  codexBedrockProject: string
  /** Bedrock mode: the model ID Claude Code uses (a cross-region inference profile). */
  claudeBedrockModel: string
  /**
   * Bedrock mode: Codex's context window for the Bedrock model, in tokens. Codex has no metadata for
   * Bedrock model IDs and falls back to defaults; this overrides that fallback. Defaults to
   * {@link DEFAULT_CODEX_BEDROCK_CONTEXT_WINDOW} in bedrock mode; unset in subscription mode.
   */
  codexBedrockContextWindow?: number
  /**
   * Bedrock mode: the role the daemon assumes per attempt to mint engine credentials. It can only
   * invoke Bedrock models. Empty means static credentials from the daemon env ({@link engineAwsStatic}).
   */
  engineRoleArn: string
  /** Bedrock mode: the AWS profile the daemon calls `sts assume-role` with. Empty means the default chain. */
  engineAwsProfile: string
  /**
   * Bedrock mode without a role ARN: static credentials captured from the daemon env (the container
   * case, where a launcher injects them). Never logged; scrubDaemonSecrets removes the variables.
   */
  engineAwsStatic?: AwsCredentials
}

export interface Config extends ReviewConfig {
  /** Slack bot token (xoxb-). Needs chat:write, reactions:write, channels:history. */
  botToken: string
  /** Slack app-level token (xapp-) with connections:write, for Socket Mode. */
  appToken: string
  /** Channel IDs the bot listens to. Empty means "every channel it is a member of". */
  channelIds: string[]
  /**
   * Slack user IDs whose messages never start a review. Normally holds the account whose
   * `gh` and Codex credentials the daemon runs as: a review of your own PR costs 10-30
   * minutes of machine time and cannot produce the one thing a review is for, since
   * GitHub will not let you approve your own pull request.
   */
  ignoreUserIds: string[]
  /**
   * Where the per-channel processing position is kept, so a restart can replay what Socket
   * Mode never delivered. Empty disables both the file and the replay that depends on it.
   */
  cursorFile: string
  /** Replay missed messages at startup. Off means the cursor is still kept, but not acted on. */
  replayEnabled: boolean
  /** Messages older than this are never replayed — a stale PR is usually not worth 20 minutes. */
  replayMaxAgeMs: number
  /** Cap on review requests one replay may queue, keeping the newest. */
  replayMaxRequests: number
  /** Cap on messages read back per channel while looking for those requests. */
  replayMaxMessages: number
  /**
   * How often to catch up regardless of what the socket thinks its state is. 0 disables the
   * timer, leaving startup and reconnects as the only triggers.
   *
   * This is the backstop that makes the bot self-healing: it does not care *why* a message
   * was never delivered, so it covers a closed laptop, a DNS flap, a Wi-Fi change, a bug in
   * the socket client, and a Slack-side outage with one mechanism. It also handles sleep for
   * free — the process is frozen while the machine is asleep, so the timer fires on wake,
   * which is exactly when the catch-up is wanted.
   */
  catchUpIntervalMs: number
  /** Catch up the moment the socket reconnects, rather than waiting for the timer. */
  catchUpOnReconnect: boolean
  /**
   * Post a per-review usage line (tokens, active time, attempts) as a thread reply on every
   * completed review. Off silences that reply without affecting the token totals the status
   * command reports, which are always kept.
   */
  usageReplyEnabled: boolean
  /**
   * Per-request timeout, in ms, for the bot's Slack Web API calls. The WebClient defaults to no
   * timeout, so a wedged call (notably the catch-up's `conversations.history`) can hang forever;
   * a finite value caps it. Paired with a bounded retry policy in `slackClientOptions`.
   */
  slackRequestTimeoutMs: number
  /**
   * How long, in ms, a shutdown waits for an in-flight review to settle before force-killing it
   * (issue #32). On SIGINT/SIGTERM the daemon stops accepting work and drains to idle; a review
   * that has not settled within this deadline is force-killed and left to replay on the next start
   * (no spurious error thread). Keep it below the supervisor's own kill timeout (launchd's
   * ExitTimeOut, or the orchestrator's grace period) so the daemon exits — and reaps its children —
   * before it is SIGKILLed and leaves them orphaned. Raise it, with a matching supervisor grace,
   * where letting a review finish is preferable to replaying it.
   */
  shutdownDrainMs: number
  /** BEDROCK_MONTHLY_CAP_USD: the bot's monthly Bedrock spend cap. Never shown in Slack (spec section 1). */
  spendCapUsd: number
  /** SPEND_ALERT_PERCENTS: percentages of the cap that post a channel alert, ascending. */
  spendAlertPercents: number[]
  /** SPEND_ALERT_HERE_PERCENTS: which of those alerts carry `<!here>`. */
  spendAlertHerePercents: number[]
  /** SPEND_ALERT_CHANNEL, else the first SLACK_CHANNEL_IDS entry; empty means alerts are only logged. */
  spendAlertChannel: string
  /** BEDROCK_PRICES_FILE: the price table spend is computed from. */
  bedrockPricesFile: string
  /** Where the month-to-date ledger's spend-YYYY-MM.jsonl journals live: the cursor file's directory (spec section 7). */
  spendDir: string
}

/**
 * The only environment variables the Codex child process inherits, by exact name.
 *
 * Everything else — every secret in the daemon's environment — is dropped. The list covers what
 * the review toolchain genuinely needs: the shell/OS basics, the on-disk config locations for
 * Codex/gh/git/npm (so file-based auth in $HOME keeps working), and the few credentials the
 * tools legitimately use (gh's token, a private-registry npm token). NODE_ENV is deliberately
 * absent: inheriting `production` would make `npm ci` skip devDependencies and break test runs.
 */
export const CODEX_ENV_ALLOWLIST = [
  // Shell / OS basics — the toolchain cannot run without these.
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'PWD',
  'TMPDIR',
  'TMP',
  'TEMP',
  'TERM',
  'COLORTERM',
  'TZ',
  'LANG',
  // Where Codex, gh, git and npm keep their config and credentials on disk.
  'CODEX_HOME',
  'XDG_CONFIG_HOME',
  'XDG_CACHE_HOME',
  'XDG_DATA_HOME',
  // Credentials the review toolchain genuinely needs: gh (clone, PR review) and private npm.
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'GH_HOST',
  'GH_ENTERPRISE_TOKEN',
  'NPM_TOKEN',
  // TLS trust for a corporate proxy, when configured.
  'NODE_EXTRA_CA_CERTS',
] as const

/**
 * Variable-name prefixes also allowed through, for families that carry needed config: locale
 * (`LC_*`) and npm's own configuration (`npm_config_*`, which is how a private-registry auth
 * token commonly reaches `npm ci`).
 */
export const CODEX_ENV_ALLOWLIST_PREFIXES = ['LC_', 'npm_config_'] as const

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key]
  if (!value) throw new Error(`${key} is not set`)
  return value
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

/**
 * Like parsePositiveInt, but 0 is a real answer rather than a typo.
 *
 * Needed for the intervals that a 0 switches off: parsePositiveInt would read `=0` as
 * out-of-range and hand back the default, so an operator disabling the timer would get the
 * five-minute default instead and nothing would say otherwise.
 */
function parseNonNegativeInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === '') return fallback
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? n : fallback
}

function parseBool(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw === '') return fallback
  return /^(1|true|yes|on)$/i.test(raw)
}

/** Split a comma/whitespace separated list, dropping empties. */
export function parseList(raw: string | undefined): string[] {
  if (!raw) return []
  return raw.split(/[\s,]+/).map(s => s.trim()).filter(Boolean)
}

/**
 * Parse a list of positive integers (milliseconds), keeping only the well-formed ones and
 * capping each at `max`.
 *
 * Three cases, deliberately distinct: `undefined` (the variable is unset) uses `fallback`; an
 * explicitly **empty** value (`STALL_BACKOFF_MS=`) returns `[]`, which is how the operator turns
 * stall detection and retries OFF — the README documents exactly that; and a non-empty but
 * all-invalid value (a typo like `abc`) falls back to `fallback`, so a mistake degrades to the
 * built-in schedule rather than silently disabling stall handling.
 */
export function parseMsList(raw: string | undefined, fallback: number[], max: number): number[] {
  if (raw === undefined) return fallback.map(ms => Math.min(ms, max))
  if (raw.trim() === '') return [] // explicitly empty: disabled, not defaulted
  const parsed = parseList(raw)
    .map(Number)
    .filter(n => Number.isFinite(n) && n > 0)
    .map(ms => Math.min(ms, max))
  return parsed.length ? parsed : fallback.map(ms => Math.min(ms, max))
}

/**
 * Parse a configured list of Slack user IDs.
 *
 * Message events identify the sender only by ID, so IDs are what the ignore list has to
 * hold — a display name or handle would need a `users.info` lookup per message, an extra
 * scope, and would still break the moment someone renames themselves.
 *
 * IDs reach the file by hand, though, so the decorated forms are accepted and normalised:
 * `<@U123>` (what pasting a mention produces), `<@U123|name>`, `@U123`, and any casing
 * all become `U123`. A mis-entered ID here fails silently — the bot just keeps reviewing
 * — so it is worth being liberal about the input.
 */
export function parseUserIds(raw: string | undefined): string[] {
  return parseList(raw)
    .map(entry => entry.replace(/^<(.*)>$/, '$1').split('|')[0].replace(/^@/, '').toUpperCase())
    .filter(Boolean)
}

/**
 * Whether a normalised entry has the shape of a Slack user ID: `U…`, or `W…` for an
 * Enterprise Grid account. Used only to warn at startup — an entry that fails this can
 * never match a real event, and silence is this daemon's only failure signal.
 */
export function looksLikeUserId(id: string): boolean {
  return /^[UW][A-Z0-9]{2,}$/.test(id)
}

/** Parse BEDROCK_MONTHLY_CAP_USD: a positive number of US dollars; unset means 1000. */
export function parseCapUsd(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return 1000
  const text = raw.trim()
  const n = /^\d+(\.\d+)?$/.test(text) ? Number(text) : Number.NaN
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`BEDROCK_MONTHLY_CAP_USD must be a positive number of US dollars, like 1000 (got "${raw}")`)
  }
  return n
}

/** Split a list of whole numbers; an entry that is not all digits becomes NaN so the caller can reject it. */
function parseIntegerList(raw: string): number[] {
  return parseList(raw).map(s => (/^\d+$/.test(s) ? Number(s) : Number.NaN))
}

/** Parse SPEND_ALERT_PERCENTS: integers 1-99, strictly ascending; unset or empty means 25,50,75,90. */
export function parseAlertPercents(raw: string | undefined): number[] {
  if (raw === undefined || raw.trim() === '') return [25, 50, 75, 90]
  const percents = parseIntegerList(raw)
  const valid =
    percents.every(n => Number.isInteger(n) && n >= 1 && n <= 99) &&
    percents.every((n, i) => i === 0 || n > percents[i - 1])
  if (!valid) {
    throw new Error(`SPEND_ALERT_PERCENTS must be integers from 1 to 99 in strictly ascending order (got "${raw}")`)
  }
  return percents
}

/**
 * Parse SPEND_ALERT_HERE_PERCENTS against the alert percents. Unset means whichever of 75 and 90 are alert
 * percents (ruling 6); explicitly empty means no threshold alert carries `<!here>`.
 */
export function parseHerePercents(raw: string | undefined, alertPercents: number[]): number[] {
  if (raw === undefined) return [75, 90].filter(p => alertPercents.includes(p))
  const percents = parseIntegerList(raw)
  for (const p of percents) {
    if (!alertPercents.includes(p)) {
      throw new Error(`SPEND_ALERT_HERE_PERCENTS: ${Number.isNaN(p) ? 'a non-integer entry' : p} is not in SPEND_ALERT_PERCENTS (${alertPercents.join(',')})`)
    }
  }
  return percents
}

/** Parse SPEND_ALERT_CHANNEL: a Slack channel ID; unset means the first allowlisted channel, or none. */
export function parseAlertChannel(raw: string | undefined, channelIds: string[]): string {
  if (raw === undefined || raw.trim() === '') return channelIds[0] ?? ''
  const id = raw.trim()
  if (!/^[CGD][A-Z0-9]{2,}$/.test(id)) {
    throw new Error(`SPEND_ALERT_CHANNEL must be a Slack channel ID like C0123456789, not a name (got "${raw}")`)
  }
  return id
}

/** Parse RUNTIME: unset means the launchd daemon. */
export function parseRuntime(raw: string | undefined): Runtime {
  if (raw === undefined || raw.trim() === '') return 'launchd'
  if (raw === 'launchd' || raw === 'container') return raw
  throw new Error(`RUNTIME must be "launchd" or "container" (got "${raw}")`)
}

/**
 * Parse REVIEW_ENGINES: unset means Codex alone; the other accepted shape is both engines. In the
 * container runtime, single mode may also be Claude alone (spec D8).
 */
export function parseEngines(raw: string | undefined, runtime: Runtime = 'launchd'): EngineName[] {
  const list = parseList(raw)
  if (list.length === 0) return ['codex']
  for (const name of list) {
    if (!ENGINE_NAMES.includes(name as EngineName)) {
      throw new Error(`REVIEW_ENGINES: unknown engine "${name}" (expected "codex" or "codex,claude")`)
    }
  }
  const shape = [...list].sort().join(',')
  const shapes = runtime === 'container' ? ['codex', 'claude', 'claude,codex'] : ['codex', 'claude,codex']
  if (list.length !== new Set(list).size || !shapes.includes(shape)) {
    throw new Error(
      runtime === 'container'
        ? `REVIEW_ENGINES must be "codex", "claude" or "codex,claude" (got "${raw}")`
        : `REVIEW_ENGINES must be "codex" or "codex,claude" (got "${raw}"); "claude" alone needs RUNTIME=container`
    )
  }
  return list as EngineName[]
}

/** Parse ENGINE_SCHEDULE: parallel unless set to serial. */
export function parseSchedule(raw: string | undefined): EngineSchedule {
  if (raw === undefined || raw.trim() === '') return 'parallel'
  if (raw === 'parallel' || raw === 'serial') return raw
  throw new Error(`ENGINE_SCHEDULE must be "parallel" or "serial" (got "${raw}")`)
}

/** ENGINE_SCHEDULE for single mode, where it is unused: an invalid value falls back to the default. */
function lenientSchedule(raw: string | undefined): EngineSchedule {
  try {
    return parseSchedule(raw)
  } catch {
    return 'parallel'
  }
}

/** Parse ENGINE_ORDER as a permutation of the configured engines; ignored in single mode. */
export function parseEngineOrder(raw: string | undefined, engines: EngineName[]): EngineName[] {
  if (engines.length < 2) return [...engines]
  const order = raw === undefined || raw.trim() === '' ? ['codex', 'claude'] : parseList(raw)
  const valid =
    order.length === engines.length &&
    new Set(order).size === order.length &&
    engines.every(engine => order.includes(engine))
  if (!valid) {
    throw new Error(`ENGINE_ORDER must list each of ${engines.join(', ')} exactly once (got "${raw}")`)
  }
  return order as EngineName[]
}

/** True when more than one engine is configured. */
export function isDualMode(config: Pick<ReviewConfig, 'reviewEngines'>): boolean {
  return config.reviewEngines.length > 1
}

/** Parse ENGINE_AUTH: unset means subscription; anything but the two modes is an error. */
export function parseEngineAuth(raw: string | undefined): EngineAuth {
  if (raw === undefined || raw.trim() === '') return 'subscription'
  if ((ENGINE_AUTH_MODES as readonly string[]).includes(raw)) return raw as EngineAuth
  throw new Error(`ENGINE_AUTH must be one of ${ENGINE_AUTH_MODES.map(m => `"${m}"`).join(', ')} (got "${raw}")`)
}

/**
 * Codex's context window in bedrock mode when CODEX_BEDROCK_CONTEXT_WINDOW is unset. OpenAI models on
 * Bedrock bill a whole request at long-context rates once its input exceeds 272K tokens, and the
 * spend price table holds only the short-context rates, so capping Codex here keeps the cap's
 * arithmetic exact. Raising it means also pricing long-context requests.
 */
export const DEFAULT_CODEX_BEDROCK_CONTEXT_WINDOW = 272000

/**
 * Parse CODEX_BEDROCK_CONTEXT_WINDOW: absent when unset, otherwise a positive integer. A bad value
 * is an error rather than a silent default, because it is spliced into a Codex `-c` override.
 */
export function parseContextWindow(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === '') return undefined
  if (!/^[1-9]\d*$/.test(raw.trim())) {
    throw new Error(`CODEX_BEDROCK_CONTEXT_WINDOW must be a positive integer (got "${raw}")`)
  }
  return Number(raw.trim())
}

/**
 * Delete the daemon-held secrets from an environment once config has read them, so no later spawn
 * that inherits the daemon's environment (the CodeArtifact login script, a bare `gh`) carries them:
 * always the GitHub tokens, and, only when config captured them as static engine credentials, the
 * AWS key variables. Without that, the approver's `gh` calls and the CodeArtifact login (which needs
 * the operator's own profile) would silently run as the engine role. Subscription mode is unchanged.
 */
export function scrubDaemonSecrets(env: NodeJS.ProcessEnv, config?: Pick<ReviewConfig, 'engineAwsStatic'>): void {
  for (const name of DAEMON_SECRET_VARS) delete env[name]
  if (config?.engineAwsStatic) {
    for (const name of ENGINE_AWS_STATIC_VARS) delete env[name]
  }
}

/** A Bedrock Mantle project ID, as sent in the `OpenAI-Project` header. */
const BEDROCK_PROJECT_ID = /^proj_[a-z0-9]+$/

type BedrockConfig = Pick<
  ReviewConfig,
  | 'engineAuth'
  | 'bedrockRegion'
  | 'codexBedrockModel'
  | 'codexBedrockProject'
  | 'claudeBedrockModel'
  | 'codexBedrockContextWindow'
  | 'engineRoleArn'
  | 'engineAwsProfile'
  | 'engineAwsStatic'
>

/**
 * Read the Bedrock settings. The defaults are always filled in, but only bedrock mode validates
 * them or captures credentials, so a stale value can never stop a subscription install starting.
 */
function loadBedrockConfig(env: NodeJS.ProcessEnv): BedrockConfig {
  const out: BedrockConfig = {
    engineAuth: parseEngineAuth(env.ENGINE_AUTH),
    bedrockRegion: env.BEDROCK_REGION || 'us-east-2',
    codexBedrockModel: env.CODEX_BEDROCK_MODEL || 'openai.gpt-5.6-terra',
    codexBedrockProject: env.CODEX_BEDROCK_PROJECT ?? '',
    claudeBedrockModel: env.CLAUDE_BEDROCK_MODEL || 'us.anthropic.claude-opus-5-5',
    engineRoleArn: env.ENGINE_ROLE_ARN ?? '',
    engineAwsProfile: env.ENGINE_AWS_PROFILE ?? '',
  }
  if (out.engineAuth !== 'bedrock') return out
  for (const [name, value] of [
    ['BEDROCK_REGION', out.bedrockRegion],
    ['CODEX_BEDROCK_MODEL', out.codexBedrockModel],
    ['CLAUDE_BEDROCK_MODEL', out.claudeBedrockModel],
  ] as const) {
    if (!TOML_SAFE_ID.test(value)) throw new Error(`${name} may contain only letters, digits and . _ : - (got "${value}")`)
  }
  // The project ID is not secret, so it is echoed; it is spliced into a TOML override, hence the strict shape.
  if (!out.codexBedrockProject) {
    throw new Error('CODEX_BEDROCK_PROJECT is required when ENGINE_AUTH=bedrock (the Bedrock Mantle project ID, proj_...)')
  }
  if (!BEDROCK_PROJECT_ID.test(out.codexBedrockProject)) {
    throw new Error(`CODEX_BEDROCK_PROJECT must look like proj_<lowercase letters and digits> (got "${out.codexBedrockProject}")`)
  }
  out.codexBedrockContextWindow =
    parseContextWindow(env.CODEX_BEDROCK_CONTEXT_WINDOW) ?? DEFAULT_CODEX_BEDROCK_CONTEXT_WINDOW
  if (out.engineRoleArn) {
    // The value is not echoed: a malformed one may be a secret pasted into the wrong variable.
    if (!ROLE_ARN.test(out.engineRoleArn)) {
      throw new Error('ENGINE_ROLE_ARN is not an IAM role ARN (want arn:aws:iam::<12 digits>:role/<name>)')
    }
    return out
  }
  const accessKeyId = env.AWS_ACCESS_KEY_ID ?? ''
  const secretAccessKey = env.AWS_SECRET_ACCESS_KEY ?? ''
  if (!accessKeyId || !secretAccessKey) {
    throw new Error(
      'ENGINE_AUTH=bedrock needs ENGINE_ROLE_ARN, or static AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY in the daemon environment'
    )
  }
  const sessionToken = env.AWS_SESSION_TOKEN
  out.engineAwsStatic = { accessKeyId, secretAccessKey, ...(sessionToken ? { sessionToken } : {}) }
  return out
}

export function loadReviewConfig(env: NodeJS.ProcessEnv = process.env): ReviewConfig {
  const home = env.HOME || os.homedir()
  const runtime = parseRuntime(env.RUNTIME)
  const reviewEngines = parseEngines(env.REVIEW_ENGINES, runtime)
  const dual = reviewEngines.length > 1
  // The container runtime posts every review as the role account (spec D8), so the role tokens are
  // read in single mode too: the orchestrator receives the approver token, a worker the engine token.
  const container = runtime === 'container'
  const config: ReviewConfig = {
    ackEmoji: env.ACK_EMOJI || 'eyes',
    queuedEmoji: env.QUEUED_EMOJI || 'hourglass_flowing_sand',
    passEmoji: env.PASS_EMOJI || 'approved_stamp',
    findingsEmoji: env.FINDINGS_EMOJI || 'comments',
    errorEmoji: env.ERROR_EMOJI || 'warning',
    humanReviewEmoji: env.HUMAN_REVIEW_EMOJI || 'raising_hand',
    approvalPartialEmoji: env.APPROVAL_PARTIAL_EMOJI || 'large_yellow_circle',
    approvalNotCountedEmoji: env.APPROVAL_NOT_COUNTED_EMOJI || 'white_circle',
    headMovedEmoji: env.HEAD_MOVED_EMOJI || 'arrows_counterclockwise',
    removeAckOnComplete: parseBool(env.REMOVE_ACK_ON_COMPLETE, false),
    codexBin: env.CODEX_BIN || 'codex',
    codexProfile: env.CODEX_PROFILE || 'review-bot',
    workspaceRoot: env.WORKSPACE_ROOT || path.join(home, 'src'),
    worktreeRoot: env.WORKTREE_ROOT || '/private/tmp/codex-pr-review',
    // Reviews routinely run 10-30 minutes; a multi-PR message multiplies that. The
    // timeout exists to stop a wedged run holding the queue forever, not to bound
    // normal work, so it is deliberately generous.
    runTimeoutMs: parsePositiveInt(env.RUN_TIMEOUT_MS, 3 * 60 * 60 * 1000),
    // No single wait for output ever exceeds this — the operator's "don't go more than 15
    // minutes between status updates" rule, enforced by clamping every grace to it.
    stallMaxMs: parsePositiveInt(env.STALL_MAX_MS, 15 * 60 * 1000),
    // Increasing patience across retries: give a fresh run ten minutes to say something, then a
    // re-run thirteen, then fifteen, then fifteen; a run silent through all four is killed for good.
    // The first grace must comfortably exceed a cold `npm ci` on the largest repo: codex streams no
    // stdout during a non-TTY install, so a shorter grace (the original 2 minutes) killed a healthy
    // install mid-run, and the reused checkout then failed the retry with ENOTEMPTY (issue #44). The
    // queue tolerates the longer waits because a genuinely wedged run is rare, while a killed install
    // was routine. Every grace is still clamped under the 15-minute ceiling.
    stallBackoffMs: parseMsList(
      env.STALL_BACKOFF_MS,
      [10, 13, 15, 15].map(m => m * 60 * 1000),
      parsePositiveInt(env.STALL_MAX_MS, 15 * 60 * 1000)
    ),
    concurrency: parsePositiveInt(env.CONCURRENCY, 1),
    disableGitSigning: parseBool(env.DISABLE_GIT_SIGNING, true),
    runLogDir: env.RUN_LOG_DIR ?? path.join(home, 'src', 'slack-review-bot', 'runs'),
    codexEnvPassthrough: parseList(env.CODEX_ENV_PASSTHROUGH),
    codeartifactRefreshEnabled: parseBool(env.CODEARTIFACT_REFRESH, true),
    codeartifactLoginScript: env.CODEARTIFACT_LOGIN_SCRIPT || defaultLoginScriptPath(),
    reviewEngines,
    // Like ENGINE_ORDER, validated only in dual mode: a stale invalid value must not stop a
    // single-engine install from starting.
    engineSchedule: dual ? parseSchedule(env.ENGINE_SCHEDULE) : lenientSchedule(env.ENGINE_SCHEDULE),
    engineOrder: parseEngineOrder(env.ENGINE_ORDER, reviewEngines),
    approverGhToken: dual || container ? env[APPROVER_TOKEN_VAR] ?? '' : '',
    engineGhToken: dual || container ? env[ENGINE_TOKEN_VAR] ?? '' : '',
    claudeBin: env.CLAUDE_BIN || 'claude',
    claudeConfigDir: env.CLAUDE_CONFIG_DIR_REVIEW || path.join(home, '.claude-review-bot'),
    runtime,
    workerIdleExitMs: parsePositiveInt(env.WORKER_IDLE_EXIT_MS, 10 * 60 * 1000),
    orchestratorUrl: env.ORCHESTRATOR_URL || 'http://slack-review-bot-orchestrator:8080',
    jobPort: parsePositiveInt(env.JOB_PORT, 8080),
    ...loadBedrockConfig(env),
  }
  // A non-approval must never wear the approval stamp, in any mode.
  for (const [name, value] of [
    ['APPROVAL_PARTIAL_EMOJI', config.approvalPartialEmoji],
    ['APPROVAL_NOT_COUNTED_EMOJI', config.approvalNotCountedEmoji],
    ['HEAD_MOVED_EMOJI', config.headMovedEmoji],
  ] as const) {
    if (value === config.passEmoji) throw new Error(`${name} must differ from PASS_EMOJI (got "${value}")`)
  }
  // In the container runtime no process holds both tokens; the launcher checks they differ (spec 3.2),
  // the orchestrator requires the approver token and the worker the engine token.
  if (dual && !container) {
    if (!config.approverGhToken) throw new Error(`${APPROVER_TOKEN_VAR} is required when REVIEW_ENGINES=codex,claude`)
    if (!config.engineGhToken) throw new Error(`${ENGINE_TOKEN_VAR} is required when REVIEW_ENGINES=codex,claude`)
    if (config.approverGhToken === config.engineGhToken) {
      throw new Error(`${APPROVER_TOKEN_VAR} and ${ENGINE_TOKEN_VAR} must be different tokens (the engine token must be read-only)`)
    }
  }
  return config
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const home = env.HOME || os.homedir()
  const stateDir = path.join(home, '.local', 'state', 'slack-review-bot')
  const cursorFile = env.CURSOR_FILE ?? path.join(stateDir, 'cursors.json')
  const channelIds = parseList(env.SLACK_CHANNEL_IDS)
  const spendAlertPercents = parseAlertPercents(env.SPEND_ALERT_PERCENTS)
  return {
    ...loadReviewConfig(env),
    botToken: required(env, 'SLACK_BOT_TOKEN'),
    appToken: required(env, 'SLACK_APP_TOKEN'),
    channelIds,
    ignoreUserIds: parseUserIds(env.SLACK_IGNORE_USER_IDS),
    cursorFile,
    replayEnabled: parseBool(env.REPLAY_ENABLED, true),
    // A day: long enough to cover an overnight restart or a closed laptop, short enough that
    // a PR posted before a long weekend is not reviewed on Monday against a branch that has
    // since been merged.
    replayMaxAgeMs: parsePositiveInt(env.REPLAY_MAX_AGE_MS, 24 * 60 * 60 * 1000),
    // Ten reviews is already hours of machine time at the default concurrency of 1; queuing
    // more than that on startup means the bot is busy with the backlog instead of with
    // whatever anyone asks it next.
    replayMaxRequests: parsePositiveInt(env.REPLAY_MAX_REQUESTS, 10),
    replayMaxMessages: parsePositiveInt(env.REPLAY_MAX_MESSAGES, 1000),
    // Five minutes: the trade is how long a missed request sits unnoticed against how often
    // it is worth one conversations.history call per channel to learn that nothing was
    // missed. That call is Slack tier 3 (~50/min), so the API cost is noise at this
    // interval — the reason not to go much lower is log volume, not rate limits.
    catchUpIntervalMs: parseNonNegativeInt(env.CATCHUP_INTERVAL_MS, 5 * 60 * 1000),
    catchUpOnReconnect: parseBool(env.CATCHUP_ON_RECONNECT, true),
    usageReplyEnabled: parseBool(env.USAGE_REPLY_ENABLED, true),
    // 30s: a healthy conversations.history / postMessage / reactions call returns in well under
    // a second, so this only ever fires on a genuinely stuck request.
    slackRequestTimeoutMs: parsePositiveInt(env.SLACK_REQUEST_TIMEOUT_MS, 30_000),
    // 5s: this drain plus the child-kill grace (SHUTDOWN_GRACE_MS, 10s) must finish inside the
    // supervisor's kill timeout — a typical launchd ExitTimeOut is ~20s — or the daemon is SIGKILLed
    // mid-drain and orphans a detached child. 5 + 10 = 15s leaves a comfortable margin, while still
    // letting a review right at the finish line settle. Raise it (with a matching supervisor grace)
    // to prefer draining over replaying.
    shutdownDrainMs: parsePositiveInt(env.SHUTDOWN_DRAIN_MS, 5_000),
    // The monthly Bedrock spend cap (spec section 4). Parsed always; the price file is read only when the
    // cap is active (ruling 3), by openSpendCap at daemon startup.
    spendCapUsd: parseCapUsd(env.BEDROCK_MONTHLY_CAP_USD),
    spendAlertPercents,
    spendAlertHerePercents: parseHerePercents(env.SPEND_ALERT_HERE_PERCENTS, spendAlertPercents),
    spendAlertChannel: parseAlertChannel(env.SPEND_ALERT_CHANNEL, channelIds),
    bedrockPricesFile: env.BEDROCK_PRICES_FILE || defaultPricesFile(),
    // Beside the cursor file (on the orchestrator state volume in the container). An empty CURSOR_FILE
    // disables the cursor, never the ledger (ruling 9).
    spendDir: cursorFile ? path.dirname(cursorFile) : stateDir,
  }
}
