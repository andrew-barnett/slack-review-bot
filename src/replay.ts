// Catching up on what Socket Mode never delivered.
//
// At startup the daemon reads each channel's history back to its cursor (see cursor.ts) and
// pushes the missed messages through the same trigger rules a live event takes. Two limits
// shape what that means in practice, both of them about a laptop that was closed for a
// while: a review costs 10-30 minutes of local machine time, and a PR from last week has
// usually moved on. So old messages and an unreasonably long backlog are recorded as
// processed and reported, rather than queued behind each other for the rest of the day.

import type { WebClient } from '@slack/web-api'
import { compareTs, tsForTime } from './cursor'
import type { SlackMessageEvent } from './slack'

export interface ReplayLimits {
  /** Messages older than this are not replayed. */
  maxAgeMs: number
  /** Cap on review requests one replay may dispatch, newest first. */
  maxRequests: number
}

export type ReplaySkipReason = 'too-old' | 'over-limit'

export interface ReplayPlan {
  /** Messages to hand to the normal dispatch path, oldest first. */
  dispatch: SlackMessageEvent[]
  /** Requests deliberately dropped. The cursor still moves past them. */
  skipped: Array<{ ts: string; reason: ReplaySkipReason }>
  /** Messages that were never review requests. The cursor moves past them too. */
  ignored: string[]
}

export interface PlanOptions {
  now: number
  limits: ReplayLimits
  /** Processed messages above the watermark, from CursorTracker.settled. */
  settled: string[]
  /** Messages under review right now, from CursorTracker.inFlight. */
  inFlight: string[]
  /** The live trigger rule, so replay can never review something a live event would not. */
  isRequest(message: SlackMessageEvent): boolean
}

/**
 * Decide what to do with a channel's missed messages. Pure, so the limits are testable
 * without a Slack connection or a 20-minute review.
 *
 * Ordering is by ts ascending for dispatch — the queue is FIFO and the channel's own order
 * is the least surprising one to serve requests in — but the *cap* keeps the newest
 * requests, since after a long outage the recent ones are the ones still worth reviewing.
 */
export function planReplay(messages: SlackMessageEvent[], options: PlanOptions): ReplayPlan {
  // Settled and in-flight are both "already accounted for", and neither may be dispatched.
  // They are distinct states — one is finished, the other is still running — but the cursor
  // keeps the watermark below both, so both keep reappearing in the history a catch-up reads.
  const accounted = new Set([...options.settled, ...options.inFlight])
  const plan: ReplayPlan = { dispatch: [], skipped: [], ignored: [] }
  const candidates: SlackMessageEvent[] = []

  const ordered = messages
    .filter((message): message is SlackMessageEvent & { ts: string } => typeof message.ts === 'string')
    .filter(message => !accounted.has(message.ts))
    .sort((a, b) => compareTs(a.ts, b.ts))

  for (const message of ordered) {
    if (!options.isRequest(message)) {
      plan.ignored.push(message.ts as string)
      continue
    }
    // Slack ts values are seconds since the epoch, so this is an age in the same units the
    // limit is expressed in once scaled.
    const ageMs = options.now - Number(message.ts) * 1000
    if (ageMs > options.limits.maxAgeMs) {
      plan.skipped.push({ ts: message.ts as string, reason: 'too-old' })
      continue
    }
    candidates.push(message)
  }

  const overflow = Math.max(0, candidates.length - Math.max(0, options.limits.maxRequests))
  for (const message of candidates.slice(0, overflow)) {
    plan.skipped.push({ ts: message.ts as string, reason: 'over-limit' })
  }
  plan.dispatch = candidates.slice(overflow)
  return plan
}

export interface HistoryResult {
  /** Messages newer than `oldest`, each stamped with its channel so the trigger rules apply. */
  messages: SlackMessageEvent[]
  /** True when the fetch stopped at `maxMessages` with more history still unread. */
  truncated: boolean
}

/** Page size for conversations.history. Slack's own maximum for the method is 999. */
const PAGE_LIMIT = 200

/**
 * Read a channel's history back to `oldest`, exclusive.
 *
 * Bounded by `maxMessages` because the backlog is whatever happened while the daemon was
 * down: for a busy channel and a laptop that was shut for a fortnight that is thousands of
 * messages, and paging all of them to find the two that were review requests is a lot of
 * API calls to make before the daemon is usefully up. Truncation keeps the newest, and the
 * caller advances the cursor past the rest.
 */
export async function fetchHistorySince(
  client: WebClient,
  channel: string,
  oldest: string,
  maxMessages: number
): Promise<HistoryResult> {
  const messages: SlackMessageEvent[] = []
  let cursor: string | undefined

  do {
    const page = await client.conversations.history({
      channel,
      oldest,
      // The watermark message itself is already processed; only what came after it matters.
      inclusive: false,
      limit: Math.min(PAGE_LIMIT, maxMessages - messages.length),
      cursor,
    })
    for (const message of (page.messages ?? []) as SlackMessageEvent[]) {
      // History omits the channel, but every trigger rule and every effect needs it.
      messages.push({ ...message, type: message.type ?? 'message', channel })
    }
    if (messages.length >= maxMessages) {
      return { messages, truncated: Boolean(page.has_more) || Boolean(page.response_metadata?.next_cursor) }
    }
    cursor = page.response_metadata?.next_cursor || undefined
  } while (cursor)

  return { messages, truncated: false }
}

export interface ReplaySummary {
  /** Channels the replay looked at. */
  channels: number
  /** Review requests handed to the queue. */
  dispatched: number
  /** Review requests deliberately dropped as too old or over the limit. */
  skipped: number
  /** Channels whose history could not be read at all. */
  failed: number
}

export interface ReplayCursors {
  watermark(channel: string): string | undefined
  settled(channel: string): string[]
  inFlight(channel: string): string[]
  start(channel: string, ts: string): string
  record(channel: string, ts: string): void
}

export interface ReplayDeps {
  fetch(channel: string, oldest: string, maxMessages: number): Promise<HistoryResult>
  /**
   * The daemon's normal per-message path. Resolves once the work is queued, not once it is
   * done, and reports whether it queued anything at all: a message the dedupe set has already
   * seen is a no-op, and counting it would put work in the summary that never happened.
   */
  dispatch(message: SlackMessageEvent): Promise<boolean>
  cursors: ReplayCursors
  /** The live trigger rule. */
  isRequest(message: SlackMessageEvent): boolean
  limits: ReplayLimits & { maxMessages: number }
  log(event: string, fields?: Record<string, unknown>): void
  now(): number
}

/**
 * Catch each channel up from its cursor, one channel at a time.
 *
 * A channel with no cursor is started at the current time rather than replayed: the first
 * run of a newly-installed bot, or a channel added to the allowlist today, would otherwise
 * treat every reviewable message in the readable history as missed.
 *
 * One channel failing — the bot was removed from it, the token lost a scope — is logged and
 * stepped over. Its cursor is left where it was, so the next restart tries again, and the
 * other channels still get caught up.
 */
export async function replayMissed(channels: string[], deps: ReplayDeps): Promise<ReplaySummary> {
  const summary: ReplaySummary = { channels: channels.length, dispatched: 0, skipped: 0, failed: 0 }
  if (!channels.length) {
    deps.log('replay.empty', { hint: 'no channels to catch up on yet' })
    return summary
  }

  for (const channel of channels) {
    const known = deps.cursors.watermark(channel)
    if (known === undefined) {
      deps.cursors.start(channel, tsForTime(deps.now()))
      continue
    }

    let history: HistoryResult
    try {
      history = await deps.fetch(channel, known, deps.limits.maxMessages)
    } catch (error) {
      summary.failed += 1
      deps.log('replay.failed', {
        channel,
        oldest: known,
        error: String(error),
        hint: 'conversations.history needs channels:history and bot membership',
      })
      continue
    }

    const plan = planReplay(history.messages, {
      now: deps.now(),
      limits: deps.limits,
      settled: deps.cursors.settled(channel),
      inFlight: deps.cursors.inFlight(channel),
      isRequest: deps.isRequest,
    })

    // Dispatch before recording anything: dispatching a request holds the cursor below it
    // until its review finishes, and recording a *newer* chatter message first would let
    // the watermark step straight over a review that has not run yet.
    let queued = 0
    for (const message of plan.dispatch) {
      if (await deps.dispatch(message)) queued += 1
    }
    for (const { ts, reason } of plan.skipped) {
      deps.log('replay.skipped', { channel, ts, reason })
      deps.cursors.record(channel, ts)
    }
    for (const ts of plan.ignored) {
      deps.cursors.record(channel, ts)
    }

    summary.dispatched += queued
    summary.skipped += plan.skipped.length
    if (history.truncated) {
      // The unread remainder is older than everything just processed, and the cursor has
      // moved past it, so those messages are gone for good. Worth a line: it is the one
      // case where the bot knowingly drops messages it was asked about.
      deps.log('replay.truncated', {
        channel,
        read: history.messages.length,
        limit: deps.limits.maxMessages,
        hint: 'older history beyond the limit was not read and will not be reviewed',
      })
    }
    deps.log('replay.channel', {
      channel,
      oldest: known,
      read: history.messages.length,
      queued,
      // Non-zero means the dedupe set absorbed a request this pass planned to queue — Slack's
      // own event retry racing the catch-up, which is routine. A number that repeats every
      // pass is not routine, and used to be counted as `queued` and reported as work done.
      deduped: plan.dispatch.length - queued,
      skipped: plan.skipped.length,
      ignored: plan.ignored.length,
      truncated: history.truncated,
    })
  }

  deps.log('replay.done', summary as unknown as Record<string, unknown>)
  return summary
}
