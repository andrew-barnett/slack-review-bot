// Runtime configuration, read once at startup from the environment.
//
// Secrets (the two Slack tokens) are read here and nowhere else, so the set of
// environment keys that must be scrubbed before spawning Codex is a single list —
// see SECRET_ENV_KEYS below and stripSecretsFromEnv in codex.ts.

import * as os from 'os'
import * as path from 'path'

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
  /** How many reviews may run at once. */
  concurrency: number
  /** Disable git commit signing in the Codex child process. */
  disableGitSigning: boolean
  /** Directory for per-run logs and raw Codex output. Empty disables run logging. */
  runLogDir: string
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
}

/** Environment keys holding secrets. Never passed down to the Codex child process. */
export const SECRET_ENV_KEYS = ['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN'] as const

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

export function loadReviewConfig(env: NodeJS.ProcessEnv = process.env): ReviewConfig {
  const home = env.HOME || os.homedir()
  return {
    ackEmoji: env.ACK_EMOJI || 'eyes',
    queuedEmoji: env.QUEUED_EMOJI || 'hourglass_flowing_sand',
    passEmoji: env.PASS_EMOJI || 'approved_stamp',
    findingsEmoji: env.FINDINGS_EMOJI || 'comments',
    errorEmoji: env.ERROR_EMOJI || 'warning',
    removeAckOnComplete: parseBool(env.REMOVE_ACK_ON_COMPLETE, false),
    codexBin: env.CODEX_BIN || 'codex',
    codexProfile: env.CODEX_PROFILE || 'review-bot',
    workspaceRoot: env.WORKSPACE_ROOT || path.join(home, 'src'),
    worktreeRoot: env.WORKTREE_ROOT || '/private/tmp/codex-pr-review',
    // Reviews routinely run 10-30 minutes; a multi-PR message multiplies that. The
    // timeout exists to stop a wedged run holding the queue forever, not to bound
    // normal work, so it is deliberately generous.
    runTimeoutMs: parsePositiveInt(env.RUN_TIMEOUT_MS, 3 * 60 * 60 * 1000),
    concurrency: parsePositiveInt(env.CONCURRENCY, 1),
    disableGitSigning: parseBool(env.DISABLE_GIT_SIGNING, true),
    runLogDir: env.RUN_LOG_DIR ?? path.join(home, 'src', 'slack-review-bot', 'runs'),
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const home = env.HOME || os.homedir()
  return {
    ...loadReviewConfig(env),
    botToken: required(env, 'SLACK_BOT_TOKEN'),
    appToken: required(env, 'SLACK_APP_TOKEN'),
    channelIds: parseList(env.SLACK_CHANNEL_IDS),
    ignoreUserIds: parseUserIds(env.SLACK_IGNORE_USER_IDS),
    cursorFile: env.CURSOR_FILE ?? path.join(home, '.local', 'state', 'slack-review-bot', 'cursors.json'),
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
  }
}
