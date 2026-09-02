// The bot's own status surface: what it answers when someone asks whether it is alive.
//
// Kept pure. app.ts owns the mutable counters and the clock and passes a snapshot in, so
// the rendering is testable without a running daemon or a Slack connection.

import type { CatchUpRecord, ConnectionState } from './catchup'
import type { JobOutcome } from './job'

export interface StatusConfigSummary {
  codexProfile: string
  concurrency: number
  runTimeoutMs: number
  channels: number
  ignoredUsers: number
}

/**
 * What the daemon can say about its catch-up, as opposed to what it did at startup.
 *
 * `enabled` is carried explicitly rather than inferred from a missing `last`, because those
 * two states need different answers: "switched off, and nothing will ever be picked up" is a
 * configuration problem, while "nothing has finished yet" is a daemon that started ten
 * seconds ago. Conflating them is what the old startup-only line did.
 */
export interface CatchUpStatus {
  /** False when REPLAY_ENABLED is off, or there is no cursor file to catch up from. */
  enabled: boolean
  /** Timer period, or 0 when only startup and reconnects trigger one. */
  intervalMs: number
  last?: CatchUpRecord
  /**
   * How long the executing pass has been going, when one is. Rendered only when it looks
   * stuck, which is the one failure this surface exists to catch: a wedged pass coalesces
   * every later request away and never logs an error, so the mechanism stops with no sign.
   */
  runningForMs?: number
}

/**
 * How long a pass may run before a status reply calls it out.
 *
 * A healthy pass is one `conversations.history` per channel and finishes in well under a
 * second, so a minute is already far outside normal — but it is long enough that the ~30
 * minutes of internal WebClient retries during a genuine outage are what shows up here,
 * rather than a false alarm on every slow network.
 */
const STALL_AFTER_MS = 60_000

export interface StatusSnapshot {
  startedAt: number
  now: number
  /** Reviews running right now, and reviews waiting behind them. */
  active: number
  queued: number
  counts: Record<JobOutcome, number>
  lastReview?: { outcome: JobOutcome; finishedAt: number; prs: number }
  config: StatusConfigSummary
}

export interface Stats {
  record(outcome: JobOutcome, prs: number, finishedAt: number): void
  snapshot(
    now: number,
    active: number,
    queued: number,
    config: StatusConfigSummary
  ): StatusSnapshot
}

/** Counters for the life of one daemon process. Deliberately not persisted: the question
 *  a status request answers is "is this process working", and a restart resets that. */
export function createStats(startedAt: number): Stats {
  const counts: Record<JobOutcome, number> = { pass: 0, findings: 0, error: 0, skipped: 0 }
  let lastReview: StatusSnapshot['lastReview']
  return {
    record(outcome, prs, finishedAt) {
      counts[outcome] += 1
      lastReview = { outcome, finishedAt, prs }
    },
    snapshot(now, active, queued, config) {
      return { startedAt, now, active, queued, counts: { ...counts }, lastReview, config }
    },
  }
}

/** Coarse, human-facing duration: enough to tell "just now" from "since Tuesday". */
export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ${minutes % 60}m`
  return `${Math.floor(hours / 24)}d ${hours % 24}h`
}

const OUTCOME_WORD: Record<JobOutcome, string> = {
  pass: 'all passed',
  findings: 'findings',
  error: 'errored',
  skipped: 'skipped (message gone)',
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`
}

/**
 * The socket's own state, which used to be invisible from Slack.
 *
 * This is the line that distinguishes "idle because nobody has asked" from "idle because the
 * websocket has been down for an hour" — the two states that produced identical silence, and
 * the reason a missed message went unnoticed until someone went looking in the log.
 */
function renderConnection(connection: ConnectionState, now: number): string {
  const churn = connection.reconnects === 0 ? '' : `, ${plural(connection.reconnects, 'reconnect')}`
  if (!connection.connected) {
    const since =
      connection.lastDisconnectedAt === undefined
        ? 'not connected yet'
        : `down for ${formatDuration(now - connection.lastDisconnectedAt)}`
    return `*Link* ${since}${churn}`
  }
  const held =
    connection.lastConnectedAt === undefined
      ? 'connected'
      : `connected for ${formatDuration(now - connection.lastConnectedAt)}`
  return `*Link* ${held}${churn}`
}

/** How a finished catch-up reads: what it found, when, and what asked for it. */
function renderCatchUpResult(last: CatchUpRecord, now: number): string {
  const ago = `${formatDuration(now - last.at)} ago (${last.reason})`
  if (last.error !== undefined) return `failed ${ago} — ${last.error}`
  const summary = last.summary
  if (!summary) return `finished ${ago}`
  if (summary.dispatched === 0 && summary.skipped === 0 && summary.failed === 0) {
    return `nothing missed, ${ago}`
  }
  return (
    `${summary.dispatched} requeued, ${summary.skipped} skipped` +
    (summary.failed ? `, ${plural(summary.failed, 'channel')} unreadable` : '') +
    ` — ${ago}`
  )
}

function renderCatchUp(catchUp: CatchUpStatus, now: number): string {
  if (!catchUp.enabled) {
    return '*Catch-up* off — messages posted while this was disconnected are not picked up'
  }
  const cadence =
    catchUp.intervalMs > 0
      ? `every ${formatDuration(catchUp.intervalMs)}`
      : 'on reconnect only — no timer'
  const result = catchUp.last === undefined ? 'none finished yet' : renderCatchUpResult(catchUp.last, now)
  const stalled =
    catchUp.runningForMs !== undefined && catchUp.runningForMs >= STALL_AFTER_MS
      ? ` · STUCK: a pass has been running for ${formatDuration(catchUp.runningForMs)}`
      : ''
  return `*Catch-up* ${result} · ${cadence}${stalled}`
}

/**
 * Slack mrkdwn for a status reply.
 *
 * Answers the questions that silence in the channel cannot distinguish between: is the
 * process up, is the socket up, did it catch up on anything it missed, is it wedged on a long
 * review, has it reviewed anything at all, and is it configured the way you think it is.
 *
 * `catchUp` and `connection` are optional so the CLI and the tests can render a status
 * without inventing a socket, but the daemon always passes both — the whole point of the
 * pair is that a bot which stopped receiving messages should say so here rather than looking
 * merely idle.
 */
export function renderStatus(
  snapshot: StatusSnapshot,
  catchUp?: CatchUpStatus,
  connection?: ConnectionState
): string {
  const { counts, config, lastReview } = snapshot
  const total = counts.pass + counts.findings + counts.error
  // Skipped is not a verdict — it is a request the bot declined to review (a deleted message) —
  // so it is reported alongside the counts rather than folded into them.
  const skipped = counts.skipped ? `, ${counts.skipped} skipped` : ''
  const lines = [
    `*Up* ${formatDuration(snapshot.now - snapshot.startedAt)} — queue: ${snapshot.active} running, ${snapshot.queued} waiting`,
    total === 0 && !counts.skipped
      ? '*Reviews* none since start'
      : `*Reviews* ${counts.pass} passed, ${counts.findings} with findings, ${counts.error} errored${skipped}`,
  ]
  if (connection) lines.push(renderConnection(connection, snapshot.now))
  if (catchUp) lines.push(renderCatchUp(catchUp, snapshot.now))
  if (lastReview) {
    lines.push(
      `*Last* ${OUTCOME_WORD[lastReview.outcome]} — ${plural(lastReview.prs, 'PR')}, ${formatDuration(snapshot.now - lastReview.finishedAt)} ago`
    )
  }
  lines.push(
    `*Config* profile \`${config.codexProfile}\`, concurrency ${config.concurrency}, ` +
      `timeout ${formatDuration(config.runTimeoutMs)}, ` +
      `${config.channels === 0 ? 'any channel' : plural(config.channels, 'channel')}, ` +
      `${plural(config.ignoredUsers, 'ignored user')}`
  )
  return lines.join('\n')
}
