// Daemon entry point. Connects to Slack over Socket Mode, watches for messages
// carrying GitHub PR URLs, and runs the Codex $review-pr skill against them.

import { App, LogLevel, SocketModeReceiver } from '@slack/bolt'
import type { WebClient } from '@slack/web-api'
import {
  CatchUpRunner,
  createConnectionTracker,
  createFreezeDetector,
  createReadyGate,
  FREEZE_CHECK_MS,
  LIVE_GATE_FAILOPEN_MS,
  type CatchUpReason,
  type ConnectionState,
} from './catchup'
import { runCodexReview } from './codex'
import { loadConfig, looksLikeUserId } from './config'
import { openCursorStore, openNullCursorStore } from './cursor'
import { makeGitHubEffects } from './github'
import { renderHelp } from './help'
import { runJob, type JobDeps } from './job'
import { createActiveReviews } from './progress'
import { TaskQueue } from './queue'
import { fetchHistorySince, replayMissed, type ReplaySummary } from './replay'
import { makeReviewRunner } from './review'
import { decideTrigger, isHelpRequest, isStatusRequest, makeSlackEffects, type SlackMessageEvent } from './slack'
import { createStats, renderStatus } from './status'
import type { RunUsage } from './usage'

function log(event: string, fields: Record<string, unknown> = {}): void {
  // Structured single-line JSON so `runs/*.log` and the launchd stdout stay greppable.
  // Message text is never logged — only channel, ts, and PR URLs — so a review request
  // that happens to quote customer data does not end up in the daemon log.
  process.stdout.write(`${JSON.stringify({ time: new Date().toISOString(), event, ...fields })}\n`)
}

/**
 * Turn a crash into a deliberate, logged exit.
 *
 * Node already terminates on an unhandled rejection, so this does not change *whether* the
 * daemon dies — only whether anyone can tell why afterwards. The path that gets here is the
 * socket client giving up: `SocketModeClient.retrieveWSSURL` classifies a DNS or connection
 * failure as unrecoverable (`autoReconnectEnabled` is and-ed with that verdict, so it does
 * not help) and rethrows out of its own reconnect loop, from a promise nobody awaits.
 *
 * Until the catch-up became continuous, that crash was the bot's only recovery mechanism,
 * because launchd's KeepAlive restart replayed the backlog on the way back up. It is now the
 * fallback rather than the plan, and either way it should leave a line behind.
 */
function installCrashHandlers(): void {
  process.on('unhandledRejection', reason => {
    log('bot.unhandled', {
      error: String(reason),
      hint: 'exiting so launchd restarts a daemon in a known state',
    })
    process.exit(1)
  })
  process.on('uncaughtException', error => {
    // The stack is the whole value of this line; String(error) alone loses where it came from.
    log('bot.uncaught', { error: String(error), stack: error?.stack })
    process.exit(1)
  })
}

async function main(): Promise<void> {
  installCrashHandlers()
  const config = loadConfig()
  // The receiver is built here rather than left to `socketMode: true`, because App keeps its
  // receiver private: constructing it is the only way to reach the SocketModeClient and hear
  // its connection events, which is where the catch-up hooks in.
  const receiver = new SocketModeReceiver({
    appToken: config.appToken,
    logLevel: LogLevel.INFO,
  })
  const app = new App({
    token: config.botToken,
    receiver,
    logLevel: LogLevel.INFO,
  })

  // Validate the bot token before connecting. Socket Mode only proves the app-level
  // token: a bad or mismatched xoxb- would let the daemon receive messages and start
  // reviews it can never react to or report on, which looks exactly like being idle.
  // Exiting instead means launchd retries every ThrottleInterval and the reason is in
  // the log, rather than the bot appearing to run while doing nothing visible.
  let botUserId: string
  try {
    const auth = await app.client.auth.test({ token: config.botToken })
    botUserId = String(auth.user_id)
    log('auth.ok', { user: auth.user, userId: botUserId, team: auth.team })
  } catch (error) {
    log('bot.fatal', { error: String(error), hint: 'SLACK_BOT_TOKEN rejected by auth.test' })
    process.exit(1)
  }

  const startedAt = Date.now()
  const stats = createStats(startedAt)
  const queue = new TaskQueue(config.concurrency)
  // Live view of what is running and waiting, for the status reply. Reads are in-memory, so
  // answering "what are you working on?" never waits on the review it is describing.
  const reviews = createActiveReviews()
  // Number of attempts a stalled run gets, mirrored into the status so a retry is visible.
  const reviewAttempts = config.stallBackoffMs.length > 0 ? config.stallBackoffMs.length : 1
  const runReview = makeReviewRunner(config, log, runCodexReview, reviews)
  // How far each channel has been processed, on disk. This is what makes a restart able to
  // pick up messages posted while the socket was down — Slack never redelivers them.
  const cursors = config.cursorFile
    ? openCursorStore(config.cursorFile, log)
    : openNullCursorStore(log)
  // Whether a catch-up can happen at all. Decided once, because the timer must not log the
  // same "disabled" line every five minutes for the life of the process.
  const catchUpEnabled = config.replayEnabled && Boolean(config.cursorFile)
  // Late-bound because these two point at each other: a catch-up dispatches through
  // `dispatch`, and the status reply `dispatch` renders reports on the catch-up. Both are
  // only ever read from inside a handler, long after main() has assigned them.
  let catchUps!: CatchUpRunner
  let connection!: ConnectionState
  // Slack retries event delivery; without this a redelivered message would start a
  // second review of the same PRs and post a duplicate thread. Bounded because the
  // daemon is meant to run for months — an unbounded Set is a slow leak, and retries
  // only ever arrive close behind the original.
  const handled = new Set<string>()
  const HANDLED_LIMIT = 500
  const markHandled = (key: string) => {
    handled.add(key)
    if (handled.size > HANDLED_LIMIT) {
      // Sets iterate in insertion order, so this drops the oldest key.
      handled.delete(handled.values().next().value as string)
    }
  }

  const triggerOptions = {
    channelIds: config.channelIds,
    ignoreUserIds: config.ignoreUserIds,
    // Lets an explicit @-mention override the ignore list, so a listed user (typically the
    // operator) can still request a review of their own PR by addressing the bot directly.
    botUserId,
  }
  const isRequest = (message: SlackMessageEvent): boolean =>
    decideTrigger(message, triggerOptions).review

  /**
   * Everything the bot does with one message, live or replayed.
   *
   * Shared deliberately: replay that took a different path would be a second, less-tested
   * implementation of the trigger rules, and the bug it hid would only ever show up after a
   * restart — the moment nobody is watching the log.
   *
   * Resolves to whether a review was actually queued, so a catch-up can report what it did
   * rather than what it intended. Live callers ignore it.
   */
  const dispatch = async (
    event: SlackMessageEvent,
    client: WebClient,
    source: 'live' | 'replay'
  ): Promise<boolean> => {
    const decision = decideTrigger(event, triggerOptions)
    if (!decision.review) {
      // Nothing to do with this message, so it is processed as far as the cursor is
      // concerned. Recording it is what keeps ordinary channel chatter from being re-read
      // on every restart. Replay never gets here — it only dispatches review requests — so
      // a stale status ping is not answered a day late.
      //
      // A message from outside the allowlist is not recorded at all: the bot may sit in
      // channels it does not review, and their positions are neither wanted in the file nor
      // meaningful in it.
      if (event.channel && event.ts && decision.reason !== 'other-channel') {
        cursors.record(event.channel, event.ts)
      }

      // Reviews take precedence, so this is only reached for messages that are not review
      // requests — a status question is one of them.
      if (isStatusRequest(event, { botUserId, channelIds: config.channelIds })) {
        const message = { channel: event.channel as string, ts: event.ts as string }
        const key = `status:${message.channel}/${message.ts}`
        if (handled.has(key)) return false
        markHandled(key)

        const text = renderStatus(
          stats.snapshot(Date.now(), queue.active, queue.queued, {
            codexProfile: config.codexProfile,
            concurrency: config.concurrency,
            runTimeoutMs: config.runTimeoutMs,
            channels: config.channelIds.length,
            ignoredUsers: config.ignoreUserIds.length,
          }),
          {
            enabled: catchUpEnabled,
            intervalMs: config.catchUpIntervalMs,
            last: catchUps.last(),
            runningForMs: catchUps.runningForMs(Date.now()),
          },
          connection,
          reviews.snapshot(Date.now())
        )
        log('status.requested', { channel: message.channel })
        try {
          await makeSlackEffects(client).postThreadReply(message, text)
        } catch (error) {
          log('status.failed', { error: String(error) })
        }
        return false
      }

      // Any other mention of the bot — an explicit `help`, a command it does not know, or a
      // bare mention — gets the help text, so addressing the bot never falls silent.
      if (isHelpRequest(event, { botUserId, channelIds: config.channelIds })) {
        const message = { channel: event.channel as string, ts: event.ts as string }
        const key = `help:${message.channel}/${message.ts}`
        if (handled.has(key)) return false
        markHandled(key)

        log('help.requested', { channel: message.channel })
        try {
          await makeSlackEffects(client).postThreadReply(
            message,
            renderHelp({
              ack: config.ackEmoji,
              queued: config.queuedEmoji,
              pass: config.passEmoji,
              findings: config.findingsEmoji,
              error: config.errorEmoji,
              humanReview: config.humanReviewEmoji,
            })
          )
        } catch (error) {
          log('help.failed', { error: String(error) })
        }
        return false
      }

      if (decision.reason !== 'no-pull-requests' && decision.reason !== 'not-a-message') {
        log('message.skipped', { reason: decision.reason })
      }
      return false
    }

    const { request } = decision
    const key = `${request.message.channel}/${request.message.ts}`
    if (handled.has(key)) {
      log('message.duplicate', { key, source })
      return false
    }
    markHandled(key)
    // Held below this message until the job settles, so a restart mid-review replays it
    // instead of leaving a message acknowledged with :eyes: and never answered.
    cursors.begin(request.message.channel, request.message.ts)

    // Captured by the recordUsage dep below and read once the job settles, so the token totals
    // land in stats.record alongside the outcome. Safe as a per-message closure var: deps is
    // built fresh for each triggering message.
    let usage: RunUsage | undefined
    const deps: JobDeps = {
      ...makeSlackEffects(client),
      ...makeGitHubEffects(),
      runReview,
      recordUsage: u => {
        usage = u
      },
      log,
    }

    // Track this request for the live status. Enqueued now (as waiting), promoted to active
    // when its slot is taken, and forgotten when it settles. Short `repo#number` labels, since
    // that is what reads well in a Slack line.
    const labels = request.prs.map(pr => `${pr.repo}#${pr.number}`)
    reviews.enqueue(key, labels)

    // Whether this message has to wait for a slot. Read before the job is handed to the queue,
    // because that is the last moment the answer is knowable from here.
    const waiting = queue.saturated
    log('review.queued', {
      key,
      source,
      prs: request.prs.map(pr => pr.url),
      queued: queue.queued,
      active: queue.active,
      waiting,
    })

    // A message waiting behind another review used to get nothing until its own run started
    // — two hours, once — which reads exactly like a missed message. The ack is the job's to
    // add, so the wait gets its own reaction here. Awaited on purpose: the job removes it
    // as it starts, and if a slot frees during this call the job must not race ahead of the
    // reaction it is meant to take off.
    let queuedReaction = false
    if (waiting) {
      try {
        await deps.addReaction(request.message, config.queuedEmoji)
        queuedReaction = true
      } catch (error) {
        log('reaction.queued.failed', { key, error: String(error) })
      }
    }

    // Deliberately not awaited: Bolt acks the event when this handler returns, and a
    // review takes far longer than Slack's ack window. The queue, not the handler,
    // is what serialises the work.
    void queue
      .run(() => {
        // The slot is taken: promote from waiting to active in the live status. Done here, not
        // inside the job, so the status shows it running the instant it starts — before the
        // deleted-message check and the first Codex output.
        reviews.start(key, reviewAttempts)
        return runJob(
          request,
          {
            ack: config.ackEmoji,
            queued: config.queuedEmoji,
            pass: config.passEmoji,
            findings: config.findingsEmoji,
            error: config.errorEmoji,
            humanReview: config.humanReviewEmoji,
            removeAckOnComplete: config.removeAckOnComplete,
          },
          deps,
          { queued: queuedReaction, postUsage: config.usageReplyEnabled }
        )
      })
      .then(outcome => stats.record(outcome, request.prs.length, Date.now(), usage?.tokensUsed))
      .catch(error => {
        // A crash never reaches runJob's own reporting, so count it as an error outcome
        // rather than letting the status reply claim nothing went wrong.
        stats.record('error', request.prs.length, Date.now(), usage?.tokensUsed)
        log('job.crashed', { key, error: String(error) })
      })
      .finally(() => {
        // Settled either way: the message has had its review, and a run that failed has
        // already reported that in the channel. Replaying it would repeat the failure.
        cursors.settle(request.message.channel, request.message.ts)
        // And it is no longer running or waiting, so it leaves the live status too.
        reviews.done(key)
      })

    return true
  }

  // Live events wait for a catch-up before they can touch the cursor. Without this, a message
  // arriving in the second between connecting and reading history would record its own position
  // first and carry the cursor straight over the backlog: the bot would come back, answer the
  // one new message, and forget everything posted while it was down. The wait is a history call
  // or two, and a redelivery caused by the delayed ack lands on the dedupe set like any other
  // retry.
  //
  // Re-armable, not one-shot: the same hazard recurs on every reconnect gap, not just at
  // startup. The gate is armed here for the startup catch-up, re-armed on each disconnect (by
  // the connection tracker), and opened when the covering catch-up has read history. A bounded
  // fail-open means a wedged catch-up can never hold live events forever.
  const liveGate = createReadyGate({
    log,
    failOpenMs: LIVE_GATE_FAILOPEN_MS,
    setTimer: (fn, ms) => {
      const t = setTimeout(fn, ms)
      t.unref?.()
      return t
    },
    clearTimer: t => clearTimeout(t),
  })
  liveGate.arm('startup')

  /**
   * One pass of the catch-up: read every channel back to its cursor and dispatch whatever
   * Socket Mode never delivered.
   *
   * Cheap when nothing was missed — one `conversations.history` per channel, returning no
   * messages — which is what makes it reasonable to run on a timer rather than only at
   * startup. It returns as soon as the work is *queued*, not reviewed, so a catch-up does not
   * sit behind a 30-minute review.
   */
  const runCatchUp = (reason: CatchUpReason): Promise<ReplaySummary> => {
    // With an allowlist, every configured channel is caught up, including one added since the
    // last run. Without one the bot listens to every channel it is in, and asking Slack which
    // those are needs a scope it does not have — so the channels it has actually processed
    // before are the ones it can catch up on.
    const channels = config.channelIds.length ? config.channelIds : cursors.list()
    log('catchup.start', { reason, channels: channels.length })
    return replayMissed(channels, {
      fetch: (channel, oldest, maxMessages) =>
        fetchHistorySince(app.client, channel, oldest, maxMessages),
      dispatch: message => dispatch(message, app.client, 'replay'),
      cursors,
      isRequest,
      limits: {
        maxAgeMs: config.replayMaxAgeMs,
        maxRequests: config.replayMaxRequests,
        maxMessages: config.replayMaxMessages,
      },
      log,
      now: Date.now,
    })
  }

  catchUps = new CatchUpRunner({ run: runCatchUp, log, now: Date.now })

  // The socket's state, and the reconnect trigger. These event names are the values of
  // socket-mode's internal `State` enum, which the package does not export — hence literals.
  const socket = createConnectionTracker({
    catchUp: reason => catchUps.request(reason),
    log,
    now: Date.now,
    catchUpOnReconnect: catchUpEnabled && config.catchUpOnReconnect,
    // Armed on disconnect and opened when the reconnect catch-up finishes reading history.
    liveGate,
  })
  connection = socket.state
  receiver.client.on('connected', () => socket.onConnected())
  receiver.client.on('disconnected', () => socket.onDisconnected())
  receiver.client.on('reconnecting', () => socket.onReconnecting())

  app.event('message', async ({ event, client }) => {
    await liveGate.wait()
    await dispatch(event as SlackMessageEvent, client, 'live')
  })

  // An ignore entry that is not a user ID can never match an event, and this daemon's
  // only failure signal is silence — so a typo would look exactly like it was working.
  // These are IDs the operator wrote themselves, echoed back to a local log.
  const suspect = config.ignoreUserIds.filter(id => !looksLikeUserId(id))
  if (suspect.length) {
    log('config.suspect', {
      ids: suspect,
      hint: 'SLACK_IGNORE_USER_IDS wants user IDs (U…/W…), not names or handles',
    })
  }

  await app.start()
  log('bot.started', {
    channels: config.channelIds.length ? config.channelIds : ['<any>'],
    ignoredUsers: config.ignoreUserIds.length ? config.ignoreUserIds : ['<none>'],
    concurrency: config.concurrency,
    codexProfile: config.codexProfile,
    workspaceRoot: config.workspaceRoot,
    worktreeRoot: config.worktreeRoot,
    cursorFile: config.cursorFile || '<disabled>',
    catchUpIntervalMs: catchUpEnabled ? config.catchUpIntervalMs : 0,
    catchUpOnReconnect: catchUpEnabled && config.catchUpOnReconnect,
  })

  // After app.start(), not before: Slack does not redeliver events missed while the socket
  // was down, so any gap between reading history and connecting would lose whatever landed
  // in it. Overlapping the other way is harmless — a message that arrives both live and in
  // the replayed history is caught by the same dedupe that already handles Slack's retries.
  try {
    if (!catchUpEnabled) {
      log('catchup.disabled', {
        hint: config.replayEnabled
          ? 'CURSOR_FILE is empty, so there is no position to catch up from'
          : 'REPLAY_ENABLED is off; the cursor is still recorded but never acted on',
      })
    } else {
      // Awaited, unlike the reconnect and timer passes: this is the one the live gate is
      // holding events for at startup. CatchUpRunner never rejects, so there is nothing to catch.
      await catchUps.request('startup')
    }
  } finally {
    // Always, or the gate would hold every live message for the life of the process.
    liveGate.open()
  }

  // The backstop, and the reason a missed message no longer needs a human to notice it.
  //
  // Deliberately independent of what the socket believes its state is. A laptop that slept
  // wakes holding a websocket that looks connected and is not, and it can take until the next
  // server ping timeout to find that out — a window in which the reconnect hook fires never
  // and this timer fires immediately, because the process was frozen and its timer is overdue.
  if (catchUpEnabled && config.catchUpIntervalMs > 0) {
    // Not unref'd: this is a daemon, and the timer keeping the event loop alive is a feature
    // if the socket ever stops doing it.
    setInterval(() => void catchUps.request('timer'), config.catchUpIntervalMs)
    log('catchup.scheduled', { intervalMs: config.catchUpIntervalMs })
  } else if (catchUpEnabled) {
    log('catchup.unscheduled', {
      hint: 'CATCHUP_INTERVAL_MS is 0; only startup and reconnects trigger a catch-up',
    })
  }

  // Notice the machine having been asleep, so a pass that merely spanned a closed lid is not
  // reported as a wedged one. Unconditional: it costs a wall-clock comparison every 30s, and
  // the `clock.jumped` line is worth having in the log whatever the catch-up is configured to
  // do — it dates the gap that the next pass is responsible for.
  const freeze = createFreezeDetector({
    now: Date.now,
    onFreeze: frozenForMs => catchUps.noteFreeze(frozenForMs),
    log,
  })
  setInterval(() => freeze.check(), FREEZE_CHECK_MS)

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      log('bot.stopping', { signal })
      app.stop().finally(() => process.exit(0))
    })
  }
}

main().catch(error => {
  log('bot.fatal', { error: String(error) })
  process.exit(1)
})
