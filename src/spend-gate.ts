// Where the spend cap refuses a review request (spec section 9): at admission, before the request is
// queued, and again when a queued request reaches its slot. A refused request gets the error reaction and
// a thread reply naming when reviews resume. Refusals are settled by the caller and never replayed.

import type { MessageRef } from './job'
import type { SpendCap } from './spend-cap'
import { nextMonthStart } from './spend-ledger'
import { renderCapRefusal } from './spend-messages'

export interface RefusalEffects {
  addReaction(message: MessageRef, name: string): Promise<void>
  removeReaction(message: MessageRef, name: string): Promise<void>
  postThreadReply(message: MessageRef, text: string): Promise<void>
  log: (event: string, fields: Record<string, unknown>) => void
}

/** React and reply. Each Slack failure is logged and swallowed: the request is refused either way. */
async function answer(message: MessageRef, errorEmoji: string, effects: RefusalEffects, nowMs: number): Promise<void> {
  try {
    await effects.addReaction(message, errorEmoji)
  } catch (error) {
    effects.log('reaction.cap.failed', { channel: message.channel, ts: message.ts, error: String(error) })
  }
  try {
    await effects.postThreadReply(message, renderCapRefusal(nextMonthStart(nowMs)))
  } catch (error) {
    effects.log('thread.cap.failed', { channel: message.channel, ts: message.ts, error: String(error) })
  }
}

/** At admission: when the cap is reached, answer the request and return true (the caller settles it). */
export async function refuseAtAdmission(
  cap: Pick<SpendCap, 'capped'>,
  message: MessageRef,
  errorEmoji: string,
  effects: RefusalEffects,
  nowMs: number
): Promise<boolean> {
  if (!cap.capped(nowMs)) return false
  await answer(message, errorEmoji, effects, nowMs)
  return true
}

/** At the slot: drop the queued reaction if it was added, then answer the request. */
export async function refuseAtSlot(
  message: MessageRef,
  emoji: { error: string; queued: string },
  effects: RefusalEffects,
  queued: Promise<boolean> | undefined,
  nowMs: number
): Promise<void> {
  // Awaited first, so the queued reaction's add has landed before it is removed (as runJob does).
  if (queued && (await queued)) {
    try {
      await effects.removeReaction(message, emoji.queued)
    } catch (error) {
      effects.log('reaction.cap.queued.remove.failed', { channel: message.channel, ts: message.ts, error: String(error) })
    }
  }
  await answer(message, emoji.error, effects, nowMs)
}

/** A queue task that checks the cap when it takes its slot: refused if reached, else run. */
export function capCheckedTask<T>(opts: {
  cap: Pick<SpendCap, 'capped'>
  now: () => number
  refuse: () => Promise<T>
  run: () => Promise<T>
}): () => Promise<T> {
  return () => (opts.cap.capped(opts.now()) ? opts.refuse() : opts.run())
}
