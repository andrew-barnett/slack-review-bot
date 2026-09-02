// Slack adapters: turning an incoming event into a ReviewRequest, and the Web API
// calls the job needs. Kept separate from app.ts so the trigger rules are testable
// without constructing a Bolt app.

import type { WebClient } from '@slack/web-api'
import { resolveMentionCommand } from './command'
import type { JobDeps, MessageRef } from './job'
import { parseMessage } from './parse-message'
import type { ReviewRequest } from './job'

/** The subset of a Slack message event the trigger rules look at. */
export interface SlackMessageEvent {
  type?: string
  subtype?: string
  channel?: string
  ts?: string
  thread_ts?: string
  text?: string
  user?: string
  bot_id?: string
  app_id?: string
}

export interface TriggerOptions {
  /** Channel allowlist. Empty means any channel the bot is in. */
  channelIds: string[]
  /** Slack user IDs whose messages are never reviewed. Empty means everyone is reviewed. */
  ignoreUserIds?: string[]
}

export type SkipReason =
  | 'not-a-message'
  | 'edited-or-deleted'
  | 'from-a-bot'
  | 'ignored-user'
  | 'thread-reply'
  | 'other-channel'
  | 'no-pull-requests'

export type TriggerDecision =
  | { review: false; reason: SkipReason }
  | { review: true; request: ReviewRequest }

/**
 * Decide whether a message event should start a review.
 *
 * Two of these filters are load-bearing rather than cosmetic:
 *
 * - Bot messages are skipped, so the bot cannot trigger itself. Its own thread replies
 *   contain the PR URLs it just reviewed, which is an infinite review loop if allowed
 *   through, and other integrations post PR links constantly.
 * - Thread replies are skipped, per the configured trigger rule: only top-level channel
 *   messages start reviews, so discussion underneath the bot's own findings thread does
 *   not queue the same PRs again.
 *
 * The ignore list is a cost filter rather than a correctness one: the daemon runs as one
 * particular human, and a review of that human's own PR burns 10-30 minutes to produce a
 * verdict GitHub will not accept as an approval anyway. It matches on who posted the
 * message, which is not quite the same thing as who wrote the PR — see the README.
 */
export function decideTrigger(
  event: SlackMessageEvent,
  options: TriggerOptions
): TriggerDecision {
  if (event.type !== 'message') return { review: false, reason: 'not-a-message' }

  // Slack delivers edits and deletions as `message` events with a subtype and a nested
  // payload. Only a plain new message (no subtype, or a thread_broadcast) is a request.
  if (event.subtype && event.subtype !== 'thread_broadcast') {
    return { review: false, reason: 'edited-or-deleted' }
  }
  if (event.bot_id || !event.user) return { review: false, reason: 'from-a-bot' }
  // Compared case-insensitively: real IDs are uppercase, but these are typed by hand.
  if (options.ignoreUserIds?.some(id => id.toUpperCase() === event.user!.toUpperCase())) {
    return { review: false, reason: 'ignored-user' }
  }
  if (!event.channel || !event.ts) return { review: false, reason: 'not-a-message' }
  if (event.thread_ts && event.thread_ts !== event.ts) {
    return { review: false, reason: 'thread-reply' }
  }
  if (options.channelIds.length && !options.channelIds.includes(event.channel)) {
    return { review: false, reason: 'other-channel' }
  }

  const parsed = parseMessage(event.text || '')
  if (parsed.prs.length === 0) return { review: false, reason: 'no-pull-requests' }

  return {
    review: true,
    request: {
      message: { channel: event.channel, ts: event.ts },
      prs: parsed.prs,
      instructions: parsed.instructions,
      requestedBy: event.user,
    },
  }
}

export interface StatusOptions {
  /** The bot's own user ID, from auth.test at startup. */
  botUserId: string
  /** Channel allowlist, same as for reviews. */
  channelIds: string[]
}

/**
 * Whether a message is asking the bot for its status.
 *
 * Matched inside the ordinary `message` stream rather than via `app_mention`, so this
 * needs no extra scope or event subscription — the bot already receives every message in
 * its channels, and it now knows its own user ID.
 *
 * The ignore list is deliberately not consulted: it exists to stop the bot burning half
 * an hour reviewing a PR its own credentials cannot approve, which is no reason to refuse
 * the one question that costs nothing to answer. Reviews take precedence, so a message
 * carrying PR URLs is reviewed even if it also says "status".
 */
export function isStatusRequest(event: SlackMessageEvent, options: StatusOptions): boolean {
  if (event.type !== 'message') return false
  if (event.subtype && event.subtype !== 'thread_broadcast') return false
  if (event.bot_id || !event.user) return false
  if (!event.channel || !event.ts) return false
  if (options.channelIds.length && !options.channelIds.includes(event.channel)) return false

  const text = event.text || ''
  if (!text.includes(`<@${options.botUserId}>`)) return false
  // Typo-tolerant: `status`, `health`, `ping`, or a near miss like `staus`/`helth`/`pign`.
  // A word ambiguous between a status command and `help` resolves to neither and falls to help.
  return resolveMentionCommand(text) === 'status'
}

/**
 * Whether a message should get the help reply.
 *
 * The catch-all for talking to the bot: any @-mention of it that is not a review request and
 * not a status question — an explicit `help`, a command it does not understand, or a bare
 * mention — lands here. The caller checks the more specific triggers (review, then status)
 * first, so this only needs to recognise "someone is addressing the bot". Deliberately does
 * not consult the keyword or the ignore list: a person who mentioned the bot and got nothing
 * back would have no way to learn what it does, which is the opposite of help.
 */
export function isHelpRequest(event: SlackMessageEvent, options: StatusOptions): boolean {
  if (event.type !== 'message') return false
  if (event.subtype && event.subtype !== 'thread_broadcast') return false
  if (event.bot_id || !event.user) return false
  if (!event.channel || !event.ts) return false
  if (options.channelIds.length && !options.channelIds.includes(event.channel)) return false
  return (event.text || '').includes(`<@${options.botUserId}>`)
}

/** Web API implementations of the reaction and thread effects the job needs. */
export function makeSlackEffects(
  client: WebClient
): Pick<JobDeps, 'addReaction' | 'removeReaction' | 'postThreadReply' | 'messageExists'> {
  return {
    async messageExists(message: MessageRef): Promise<boolean> {
      // A single-message window at exactly this ts: inclusive bounds set to the same value
      // return that one message if it is still there, and nothing once it has been deleted.
      // Uses the channels:history scope the catch-up already relies on — no new permission.
      const result = await client.conversations.history({
        channel: message.channel,
        latest: message.ts,
        oldest: message.ts,
        inclusive: true,
        limit: 1,
      })
      return Boolean(result.messages?.some(m => m.ts === message.ts))
    },
    async addReaction(message: MessageRef, name: string): Promise<void> {
      try {
        await client.reactions.add({ channel: message.channel, timestamp: message.ts, name })
      } catch (error) {
        // Someone (or a previous run) already added it. Not a failure.
        if (isSlackError(error, 'already_reacted')) return
        throw error
      }
    },
    async removeReaction(message: MessageRef, name: string): Promise<void> {
      try {
        await client.reactions.remove({ channel: message.channel, timestamp: message.ts, name })
      } catch (error) {
        if (isSlackError(error, 'no_reaction')) return
        throw error
      }
    },
    async postThreadReply(message: MessageRef, text: string): Promise<void> {
      await client.chat.postMessage({
        channel: message.channel,
        thread_ts: message.ts,
        text,
        // Keep the reply in the thread rather than echoing it to the channel; the
        // reaction already carries the outcome at channel level.
        reply_broadcast: false,
        unfurl_links: false,
        unfurl_media: false,
      })
    },
  }
}

function isSlackError(error: unknown, code: string): boolean {
  const data = (error as { data?: { error?: string } })?.data
  return data?.error === code
}
