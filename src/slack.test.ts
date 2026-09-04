import { retryPolicies, type WebClient } from '@slack/web-api'
import test from 'tape'
import {
  decideTrigger,
  isHelpRequest,
  isStatusRequest,
  makeSlackEffects,
  slackClientOptions,
  type SlackMessageEvent,
} from './slack'

const base: SlackMessageEvent = {
  type: 'message',
  channel: 'C123',
  ts: '1700000000.000100',
  user: 'U1',
  text: 'review https://github.com/o/r/pull/1',
}

test('decideTrigger starts a review for a top-level message with a PR URL', t => {
  const decision = decideTrigger(base, { channelIds: [] })
  t.equal(decision.review, true)
  if (decision.review) {
    t.equal(decision.request.prs.length, 1)
    t.equal(decision.request.message.ts, '1700000000.000100')
    t.equal(decision.request.requestedBy, 'U1')
  }
  t.end()
})

// The bot's own findings thread repeats every PR URL it just reviewed. If bot messages
// were not filtered out the bot would review its own reply, forever.
test('decideTrigger ignores messages from bots', t => {
  const decision = decideTrigger({ ...base, bot_id: 'B1' }, { channelIds: [] })
  t.equal(decision.review, false)
  if (!decision.review) t.equal(decision.reason, 'from-a-bot')
  t.end()
})

// The daemon runs on one person's machine with their gh and Codex credentials, so
// reviewing that person's own PR spends 10-30 minutes to reach a verdict GitHub will not
// accept as an approval. Checks the ignore list short-circuits before anything is queued.
test('decideTrigger ignores messages from a listed user', t => {
  const decision = decideTrigger(base, { channelIds: [], ignoreUserIds: ['U1'] })
  t.equal(decision.review, false)
  if (!decision.review) t.equal(decision.reason, 'ignored-user')
  t.end()
})

// Regression guard: the ignore list must not invert into an allowlist. Everyone absent
// from it still gets reviewed, and an empty or omitted list ignores nobody.
test('decideTrigger reviews users who are not on the ignore list', t => {
  t.equal(decideTrigger(base, { channelIds: [], ignoreUserIds: ['U2', 'U3'] }).review, true)
  t.equal(decideTrigger(base, { channelIds: [], ignoreUserIds: [] }).review, true)
  t.equal(decideTrigger(base, { channelIds: [] }).review, true)
  t.end()
})

// The IDs are typed into the credentials file by hand. A casing mismatch would fail the
// only way this daemon can fail — silently, by carrying on reviewing.
test('decideTrigger matches ignored user IDs case-insensitively', t => {
  t.equal(decideTrigger({ ...base, user: 'u1' }, { channelIds: [], ignoreUserIds: ['U1'] }).review, false)
  t.equal(decideTrigger(base, { channelIds: [], ignoreUserIds: ['u1'] }).review, false)
  t.end()
})

// Regression for the reported bug: an ignored user @-mentioning the bot with a PR URL used
// to be dropped as ignored-user and fall through to the help reply. An explicit mention is a
// deliberate request, so it overrides the ignore list and the review runs.
test('decideTrigger reviews an ignored user who explicitly mentions the bot', t => {
  const event = { ...base, text: '<@U0BOT> https://github.com/o/r/pull/312' }
  const decision = decideTrigger(event, { channelIds: [], ignoreUserIds: ['U1'], botUserId: 'U0BOT' })
  t.equal(decision.review, true, 'the mention overrides the ignore list')
  if (decision.review) t.equal(decision.request.prs[0].number, 312)
  t.end()
})

// The override is scoped to a mention of THIS bot. An ignored user with a PR but no mention
// (or a mention of someone else) is still skipped, so the cost filter for stray in-channel
// PR links is unchanged.
test('decideTrigger still ignores a listed user without an explicit mention', t => {
  t.equal(
    decideTrigger(base, { channelIds: [], ignoreUserIds: ['U1'], botUserId: 'U0BOT' }).review,
    false,
    'no mention -> still ignored'
  )
  t.equal(
    decideTrigger(
      { ...base, text: '<@U0OTHER> https://github.com/o/r/pull/1' },
      { channelIds: [], ignoreUserIds: ['U1'], botUserId: 'U0BOT' }
    ).review,
    false,
    'mention of another user -> still ignored'
  )
  t.end()
})

// Without a configured botUserId (the CLI, older callers) there is no way to detect a
// mention, so the override is off and the ignore list applies as it always did.
test('decideTrigger keeps ignoring a listed user when no botUserId is configured', t => {
  const event = { ...base, text: '<@U0BOT> https://github.com/o/r/pull/1' }
  t.equal(decideTrigger(event, { channelIds: [], ignoreUserIds: ['U1'] }).review, false)
  t.end()
})

// Configured trigger rule: only top-level messages start reviews, so discussion inside
// the bot's own thread does not re-queue the same PRs.
test('decideTrigger ignores replies inside a thread', t => {
  const decision = decideTrigger(
    { ...base, thread_ts: '1699999999.000000' },
    { channelIds: [] }
  )
  t.equal(decision.review, false)
  if (!decision.review) t.equal(decision.reason, 'thread-reply')
  t.end()
})

// A thread parent carries thread_ts === ts once someone replies to it. Treating that as
// a reply would make the bot stop responding to any message that had been replied to.
test('decideTrigger still reviews a thread parent whose thread_ts equals its ts', t => {
  const decision = decideTrigger({ ...base, thread_ts: base.ts }, { channelIds: [] })
  t.equal(decision.review, true)
  t.end()
})

// Slack delivers an edit as a `message` event with subtype message_changed and the new
// text nested. Without the subtype filter, editing an old message would re-review it.
test('decideTrigger ignores edits and deletions', t => {
  for (const subtype of ['message_changed', 'message_deleted', 'channel_join']) {
    const decision = decideTrigger({ ...base, subtype }, { channelIds: [] })
    t.equal(decision.review, false, subtype)
    if (!decision.review) t.equal(decision.reason, 'edited-or-deleted', subtype)
  }
  t.end()
})

// The allowlist is what keeps the bot from reviewing PR links in every channel it has
// been invited to.
test('decideTrigger honours the channel allowlist', t => {
  t.equal(decideTrigger(base, { channelIds: ['C999'] }).review, false)
  t.equal(decideTrigger(base, { channelIds: ['C123', 'C999'] }).review, true)
  t.end()
})

// Most channel traffic has no PR links; those messages must be dropped silently rather
// than starting an empty review.
test('decideTrigger ignores a message with no PR URLs', t => {
  const decision = decideTrigger({ ...base, text: 'morning all' }, { channelIds: [] })
  t.equal(decision.review, false)
  if (!decision.review) t.equal(decision.reason, 'no-pull-requests')
  t.end()
})

const statusOptions = { botUserId: 'U0BOT', channelIds: [] as string[] }
const statusBase: SlackMessageEvent = { ...base, text: '<@U0BOT> status' }

// Silence is this bot's only failure signal, and a status reply is the one way to tell a
// healthy idle daemon from a dead one from inside Slack.
test('isStatusRequest answers a mention asking for status', t => {
  t.equal(isStatusRequest(statusBase, statusOptions), true)
  t.equal(isStatusRequest({ ...statusBase, text: 'hey <@U0BOT> health?' }, statusOptions), true)
  t.equal(isStatusRequest({ ...statusBase, text: '<@U0BOT> ping' }, statusOptions), true)
  t.end()
})

// The bot is in a channel with other traffic. Answering every mention, or every message
// containing the word "status", would make it a nuisance.
test('isStatusRequest needs both the mention and the keyword', t => {
  t.equal(isStatusRequest({ ...statusBase, text: '<@U0BOT> thanks!' }, statusOptions), false)
  t.equal(isStatusRequest({ ...statusBase, text: 'what is the status of the deploy' }, statusOptions), false)
  t.equal(isStatusRequest({ ...statusBase, text: '<@U0OTHER> status' }, statusOptions), false)
  t.end()
})

// Its own replies mention no one, but other integrations do; a bot-to-bot status loop
// would be the same failure the review trigger already guards against.
test('isStatusRequest ignores bots, edits, and other channels', t => {
  t.equal(isStatusRequest({ ...statusBase, bot_id: 'B1' }, statusOptions), false)
  t.equal(isStatusRequest({ ...statusBase, subtype: 'message_changed' }, statusOptions), false)
  t.equal(isStatusRequest(statusBase, { ...statusOptions, channelIds: ['C999'] }), false)
  t.end()
})

// Deliberate: the ignore list stops the bot wasting half an hour on a review it cannot
// turn into an approval. Refusing to say whether it is alive would be a different thing.
test('isStatusRequest answers users on the ignore list', t => {
  t.equal(isStatusRequest({ ...statusBase, user: 'U1' }, statusOptions), true)
  t.end()
})

// Asking inside a thread is natural — often the thread of the review you are asking about
// — and unlike a review request it cannot re-queue any work.
test('isStatusRequest answers inside a thread', t => {
  t.equal(isStatusRequest({ ...statusBase, thread_ts: '1699999999.000000' }, statusOptions), true)
  t.end()
})

// --- messageExists: the deleted-message check the job runs the moment a slot frees. ---

/** A WebClient with just the one method messageExists calls, recording the args it passed. */
function clientReturning(messages: Array<{ ts?: string }> | undefined): {
  client: WebClient
  calls: Array<Record<string, unknown>>
} {
  const calls: Array<Record<string, unknown>> = []
  const client = {
    conversations: {
      async history(args: Record<string, unknown>) {
        calls.push(args)
        return { messages }
      },
    },
  } as unknown as WebClient
  return { client, calls }
}

// A message still in history returns true, and the query is a single-message window pinned to
// exactly that ts — so it cannot be fooled by a neighbouring message.
test('messageExists returns true for a message that is still there', async t => {
  const { client, calls } = clientReturning([{ ts: '1.1' }])
  const effects = makeSlackEffects(client)
  t.equal(await effects.messageExists!({ channel: 'C1', ts: '1.1' }), true)
  t.deepEqual(calls[0], { channel: 'C1', latest: '1.1', oldest: '1.1', inclusive: true, limit: 1 })
  t.end()
})

// A deleted message drops out of history, so the window comes back empty and the check is false.
test('messageExists returns false when the message has been deleted', async t => {
  const { client } = clientReturning([])
  const effects = makeSlackEffects(client)
  t.equal(await effects.messageExists!({ channel: 'C1', ts: '1.1' }), false)
  t.end()
})

// A window that returns only an adjacent message (never the asked-for ts) still reads as gone.
test('messageExists returns false when the ts is not among the returned messages', async t => {
  const { client } = clientReturning([{ ts: '2.2' }])
  const effects = makeSlackEffects(client)
  t.equal(await effects.messageExists!({ channel: 'C1', ts: '1.1' }), false)
  t.end()
})

// --- isHelpRequest: the catch-all for anyone addressing the bot. ---

// Any mention that is not a review or a status question should get help, so a bare mention,
// an explicit "help", and an unrecognised command all qualify.
test('isHelpRequest answers any mention, whatever the words are', t => {
  t.equal(isHelpRequest({ ...statusBase, text: '<@U0BOT> help' }, statusOptions), true, 'explicit help')
  t.equal(isHelpRequest({ ...statusBase, text: '<@U0BOT> what can you do?' }, statusOptions), true, 'a question')
  t.equal(isHelpRequest({ ...statusBase, text: 'hey <@U0BOT> frobnicate' }, statusOptions), true, 'an unknown command')
  t.equal(isHelpRequest({ ...statusBase, text: '<@U0BOT>' }, statusOptions), true, 'a bare mention')
  t.end()
})

// It fires for a status mention too — precedence (review, then status, then help) is the
// dispatcher's job, so this only has to recognise that the bot was addressed.
test('isHelpRequest also matches a status mention (dispatch orders the two)', t => {
  t.equal(isHelpRequest(statusBase, statusOptions), true)
  t.end()
})

// A message that does not mention the bot must not draw a help reply, or the bot would answer
// ordinary channel chatter.
test('isHelpRequest ignores a message that does not mention the bot', t => {
  t.equal(isHelpRequest({ ...statusBase, text: 'help me somebody' }, statusOptions), false)
  t.end()
})

// Same guards as the status trigger: not the bot's own messages, not edits, only allowlisted
// channels — but a thread mention is fair game, as with status.
test('isHelpRequest ignores bots, edits, and other channels, but answers in threads', t => {
  t.equal(isHelpRequest({ ...statusBase, bot_id: 'B1' }, statusOptions), false, 'not a bot')
  t.equal(isHelpRequest({ ...statusBase, subtype: 'message_changed' }, statusOptions), false, 'not an edit')
  t.equal(isHelpRequest(statusBase, { ...statusOptions, channelIds: ['C999'] }), false, 'only allowlisted channels')
  t.equal(isHelpRequest({ ...statusBase, thread_ts: '1699999999.000000' }, statusOptions), true, 'answers in a thread')
  t.end()
})

// --- Typo-tolerant status commands (see command.ts). ---

// A misspelled status command still reports status rather than falling through to help.
test('isStatusRequest tolerates typos in the status commands', t => {
  t.equal(isStatusRequest({ ...statusBase, text: '<@U0BOT> staus' }, statusOptions), true, 'staus')
  t.equal(isStatusRequest({ ...statusBase, text: '<@U0BOT> helth' }, statusOptions), true, 'helth -> health')
  t.equal(isStatusRequest({ ...statusBase, text: '<@U0BOT> pign' }, statusOptions), true, 'pign -> ping')
  t.end()
})

// A word ambiguous between help and a status command is not treated as status — it falls
// through to the help reply, which lists the real commands.
test('isStatusRequest does not guess an ambiguous word as status', t => {
  t.equal(isStatusRequest({ ...statusBase, text: '<@U0BOT> healp' }, statusOptions), false, 'help or health — no guess')
  t.end()
})

// A word nothing like a command is still not a status request (it becomes a help fallback).
test('isStatusRequest ignores a mention with no command-like word', t => {
  t.equal(isStatusRequest({ ...statusBase, text: '<@U0BOT> deploy please' }, statusOptions), false)
  t.end()
})

// The fix for issue #6: the bot's WebClient must carry a finite request timeout so a wedged
// Slack call (the catch-up's conversations.history) cannot hang forever.
test('slackClientOptions sets the configured finite timeout', t => {
  const opts = slackClientOptions(30_000)
  t.equal(opts.timeout, 30_000, 'the per-request timeout comes from config')
  t.ok(Number.isFinite(opts.timeout) && (opts.timeout as number) > 0, 'and is finite and positive')
  t.end()
})

// The retry policy must be bounded, not the ~30-minute default — otherwise a stuck call still
// spans half an hour of retries. Five-in-five-minutes bounds it; the catch-up timer is the
// backstop for a longer outage.
test('slackClientOptions bounds retries to the five-minute policy', t => {
  const opts = slackClientOptions(30_000)
  t.equal(opts.retryConfig, retryPolicies.fiveRetriesInFiveMinutes, 'bounded retry policy')
  t.notEqual(
    opts.retryConfig,
    retryPolicies.tenRetriesInAboutThirtyMinutes,
    'not the ~30-minute default that lets a call retry for half an hour'
  )
  t.end()
})
