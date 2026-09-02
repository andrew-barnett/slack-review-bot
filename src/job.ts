// The bot's behaviour for one triggering message, as a pure function over injected
// effects. Everything Slack- and Codex-specific is a dependency, so the whole
// react -> review -> react -> thread sequence is unit-testable without either service.

import type { PullRequestRef } from './parse-message'
import { renderError, renderThread, verdictFor } from './render'
import type { ReviewRunResult } from './schema'

export interface MessageRef {
  channel: string
  /** Slack message ts — both the reaction target and the thread parent. */
  ts: string
}

export interface ReviewRequest {
  message: MessageRef
  prs: PullRequestRef[]
  instructions: string
  requestedBy?: string
}

export interface JobDeps {
  addReaction(message: MessageRef, name: string): Promise<void>
  removeReaction(message: MessageRef, name: string): Promise<void>
  postThreadReply(message: MessageRef, text: string): Promise<void>
  runReview(request: ReviewRequest): Promise<ReviewRunResult>
  /**
   * Whether the triggering message still exists. Optional: the CLI has no Slack to ask. When
   * present, the job checks it the moment a slot frees — a request can sit in the queue for
   * hours, and a message deleted in the meantime should not cost a 20-minute review whose
   * findings would land on a thread nobody can see.
   */
  messageExists?(message: MessageRef): Promise<boolean>
  log(event: string, fields: Record<string, unknown>): void
}

export interface JobEmoji {
  ack: string
  /** Worn while the message waits for a slot; swapped for `ack` when its run starts. */
  queued: string
  pass: string
  findings: string
  error: string
  removeAckOnComplete: boolean
}

export interface JobOptions {
  /**
   * The message is already wearing `emoji.queued`, added by the dispatcher when it had to
   * wait for a slot. The job takes it off once the ack is on, so the message never has no
   * reaction and never has two.
   */
  queued?: boolean
}

export type JobOutcome = 'pass' | 'findings' | 'error' | 'skipped'

/**
 * Acknowledge, review, and report.
 *
 * The ack reaction is added before the review starts and is never conditional on it
 * succeeding — it is the bot's "I saw this", and a user who gets no reaction at all
 * should be able to conclude the bot is down rather than merely slow.
 */
export async function runJob(
  request: ReviewRequest,
  emoji: JobEmoji,
  deps: JobDeps,
  options: JobOptions = {}
): Promise<JobOutcome> {
  const urls = request.prs.map(pr => pr.url)

  // Checked before anything else, because this runs the instant a slot frees — the message may
  // have been deleted while it waited in the queue. A check that itself fails is treated as
  // "still there": a transient Slack error is no reason to silently drop a real request, and
  // the worst case is one review of an already-gone message rather than a dropped live one.
  if (deps.messageExists) {
    let exists = true
    try {
      exists = await deps.messageExists(request.message)
    } catch (error) {
      deps.log('review.exists.failed', { prs: urls, error: String(error) })
    }
    if (!exists) {
      deps.log('review.aborted', {
        channel: request.message.channel,
        ts: request.message.ts,
        prs: urls,
        reason: 'message-deleted',
      })
      return 'skipped'
    }
  }

  deps.log('review.start', { channel: request.message.channel, ts: request.message.ts, prs: urls })

  // A failure to react must not cancel the review; the reaction is a status surface,
  // not a precondition. Losing it costs the user feedback, losing the review costs
  // them the work.
  await swallow(deps, 'reaction.ack.failed', () => deps.addReaction(request.message, emoji.ack))
  // Ack on before queued off: a reader glancing at the channel between the two calls
  // should see the bot working on it, not a message with no reaction at all.
  if (options.queued) {
    await swallow(deps, 'reaction.queued.remove.failed', () =>
      deps.removeReaction(request.message, emoji.queued)
    )
  }

  let result: ReviewRunResult
  try {
    result = await deps.runReview(request)
  } catch (error) {
    deps.log('review.failed', { prs: urls, error: String(error) })
    await finishAck(deps, emoji, request.message)
    await swallow(deps, 'reaction.error.failed', () => deps.addReaction(request.message, emoji.error))
    await swallow(deps, 'thread.error.failed', () =>
      deps.postThreadReply(request.message, renderError(urls, error))
    )
    return 'error'
  }

  const verdict = verdictFor(result)
  deps.log('review.done', {
    prs: urls,
    verdict,
    statuses: result.results.map(r => `${r.url}=${r.status}`),
  })

  await finishAck(deps, emoji, request.message)

  if (verdict === 'pass') {
    await swallow(deps, 'reaction.pass.failed', () => deps.addReaction(request.message, emoji.pass))
    return 'pass'
  }

  // Reaction first, then the thread: the reaction is the at-a-glance signal in the
  // channel, and it should be there even if the longer message fails to post.
  await swallow(deps, 'reaction.findings.failed', () =>
    deps.addReaction(request.message, emoji.findings)
  )
  await swallow(deps, 'thread.failed', () =>
    deps.postThreadReply(request.message, renderThread(result))
  )
  return 'findings'
}

async function finishAck(deps: JobDeps, emoji: JobEmoji, message: MessageRef): Promise<void> {
  if (!emoji.removeAckOnComplete) return
  await swallow(deps, 'reaction.ack.remove.failed', () => deps.removeReaction(message, emoji.ack))
}

/** Run an effect, logging and discarding any failure. */
async function swallow(deps: JobDeps, event: string, effect: () => Promise<void>): Promise<void> {
  try {
    await effect()
  } catch (error) {
    deps.log(event, { error: String(error) })
  }
}
