// Making the catch-up a continuous concern rather than a startup one.
//
// replay.ts knows how to read a channel back to its cursor. The daemon used to do that
// exactly once, in main(). Socket Mode never redelivers, so every reconnect after that left
// a hole nobody looked in, and the two failure modes were the wrong way round:
//
//   - a SHORT outage reconnected cleanly, the daemon lived, and the messages posted during
//     it were never reviewed — a silent miss;
//   - a LONG outage threw out of the reconnect loop (SocketModeClient treats a DNS failure
//     as unrecoverable), killed the process, and launchd's restart replayed them.
//
// So the bot recovered from big network failures and quietly dropped messages in small ones.
// Catch-ups are now requested from three places — startup, every reconnect, and a timer —
// and this module is what keeps that from being three ways to corrupt one cursor.

import type { ReplaySummary } from './replay'

/** Why a catch-up was asked for. Reported in the log and in a status reply. */
export type CatchUpReason = 'startup' | 'reconnect' | 'timer'

/** The outcome of one finished catch-up. */
export interface CatchUpRecord {
  reason: CatchUpReason
  /** When the run finished. */
  at: number
  /** Present when the run completed. */
  summary?: ReplaySummary
  /** Present instead when it threw. */
  error?: string
}

export interface CatchUpDeps {
  /** Do the work — normally replayMissed over the configured channels. */
  run(reason: CatchUpReason): Promise<ReplaySummary>
  log(event: string, fields?: Record<string, unknown>): void
  now(): number
}

/**
 * Runs catch-ups one at a time, coalescing the ones that pile up behind a slow run.
 *
 * Serialised because CursorTracker is not safe against two concurrent replays of one
 * channel: both read the same history, and `begin`/`settle` interleaved from two passes can
 * walk the watermark over a review that is still sitting in the queue. The dedupe set in
 * app.ts would stop the duplicate *review*, but the cursor damage outlives the process,
 * which is the failure this whole module exists to prevent.
 *
 * Coalesced because a request is cheap to make and not free to serve. A reconnect storm —
 * twenty in a minute, which the error log shows is an ordinary afternoon on a laptop — should
 * cost one more catch-up, not twenty. A single waiting slot is enough: a run that has not
 * started yet would read the same history as the one already queued ahead of it.
 */
export class CatchUpRunner {
  private chain: Promise<void> = Promise.resolve()
  /** Requested and not yet finished: the running one, plus at most one waiting. */
  private outstanding = 0
  private lastRecord: CatchUpRecord | undefined
  /** When the currently-executing pass began, or undefined when none is. */
  private activeSince: number | undefined

  constructor(private readonly deps: CatchUpDeps) {}

  /** The most recent finished run, for a status reply. */
  last(): CatchUpRecord | undefined {
    return this.lastRecord
  }

  /** True while a run is executing, or waiting behind one that is. */
  get busy(): boolean {
    return this.outstanding > 0
  }

  /**
   * How long the executing pass has been going, or undefined when idle.
   *
   * This is the tell for the one way coalescing can turn against us. `WebClient` defaults to
   * `timeout: 0` — no HTTP timeout at all — so a wedged `conversations.history` leaves this
   * runner busy forever, and every later request is coalesced away: the catch-up would stop
   * without a single error anywhere. Abandoning the pass on a timer would be worse, since the
   * abandoned one keeps mutating the cursor while its replacement starts, so the answer is to
   * make the stall loud instead. A healthy pass finishes in well under a second, so any
   * non-trivial value here means something is stuck.
   */
  runningForMs(now: number): number | undefined {
    return this.activeSince === undefined ? undefined : Math.max(0, now - this.activeSince)
  }

  /**
   * Discount a stretch during which the whole process was frozen.
   *
   * A closed laptop suspends the process outright, so a pass in flight when the lid shuts is
   * still in flight on wake with a wall clock that jumped — one weekend produced a
   * `runningForMs` of 122336950, thirty-four hours, for a pass that then finished two seconds
   * later. Blaming the pass for time nobody was executing turns the stall signal into a false
   * alarm after every sleep, which is worse than not having it: a signal that cries wolf is
   * one nobody reads when the genuine 30-minute retry stall shows up next to it.
   *
   * Pushing `activeSince` forward rather than subtracting from the reported figure keeps this
   * correct across several freezes within one pass.
   */
  noteFreeze(frozenForMs: number): void {
    if (this.activeSince !== undefined) this.activeSince += frozenForMs
  }

  /**
   * Ask for a catch-up, and resolve once the work covering this request has finished.
   *
   * Never rejects. A failed catch-up earns a log line and a status field, but every caller
   * is a fire-and-forget event handler or a timer, and an unhandled rejection from one of
   * those is exactly the crash this change is meant to stop relying on.
   */
  request(reason: CatchUpReason): Promise<void> {
    if (this.outstanding > 1) {
      // runningForMs is the payload that matters here. One of these lines is routine; the same
      // line every interval with a climbing duration is a wedged pass, and the only place that
      // would ever show up.
      this.deps.log('catchup.coalesced', {
        reason,
        runningForMs: this.runningForMs(this.deps.now()),
        hint: 'a catch-up is already queued behind the running one',
      })
      return this.chain
    }
    this.outstanding += 1
    this.chain = this.chain.then(async () => {
      this.activeSince = this.deps.now()
      try {
        const summary = await this.deps.run(reason)
        this.lastRecord = { reason, at: this.deps.now(), summary }
        this.deps.log('catchup.done', { reason, ...summary })
      } catch (error) {
        this.lastRecord = { reason, at: this.deps.now(), error: String(error) }
        this.deps.log('catchup.failed', { reason, error: String(error) })
      } finally {
        this.outstanding -= 1
        this.activeSince = undefined
      }
    })
    return this.chain
  }
}

/**
 * How often the freeze detector checks in, and how late a check may be before the gap counts
 * as the process having been suspended rather than merely busy.
 *
 * Thirty seconds each way: short enough that a lid closed for a minute is caught, long enough
 * that ordinary event-loop congestion — a review spawning, a big history page parsing — never
 * looks like a freeze.
 */
export const FREEZE_CHECK_MS = 30_000
export const FREEZE_TOLERANCE_MS = 30_000

export interface FreezeDetectorDeps {
  now(): number
  /** Told how long the process was suspended for. */
  onFreeze(frozenForMs: number): void
  log(event: string, fields?: Record<string, unknown>): void
  checkMs?: number
  toleranceMs?: number
}

/**
 * Notice that the process was suspended, by watching a heartbeat run late.
 *
 * Deliberately not `performance.now()`. Whether a monotonic clock advances across system sleep
 * is platform- and libuv-version-specific — on Darwin it depends on whether the clock maps to
 * `mach_absolute_time` or `mach_continuous_time` — so a fix built on "the monotonic clock
 * excludes sleep" would be correct or useless depending on a detail nothing in this repo pins
 * down. A timer that should have fired 30 seconds ago and fires 34 hours late is unambiguous
 * on every platform, and needs only the wall clock everything else here already uses.
 */
export function createFreezeDetector(deps: FreezeDetectorDeps): { check(): void } {
  const checkMs = deps.checkMs ?? FREEZE_CHECK_MS
  const toleranceMs = deps.toleranceMs ?? FREEZE_TOLERANCE_MS
  let last = deps.now()
  return {
    check(): void {
      const at = deps.now()
      const late = at - last - checkMs
      last = at
      if (late <= toleranceMs) return
      deps.log('clock.jumped', {
        frozenForMs: late,
        hint: 'the process was suspended; not counting it against the running catch-up',
      })
      deps.onFreeze(late)
    },
  }
}

/** What the socket has been doing lately. Owned by app.ts, rendered by status.ts. */
export interface ConnectionState {
  connected: boolean
  /** Reconnections since this process started — the first connection is not one. */
  reconnects: number
  lastConnectedAt?: number
  lastDisconnectedAt?: number
}

export interface ConnectionDeps {
  /** Ask for a catch-up. Called on every reconnect, never on the first connection. */
  catchUp(reason: CatchUpReason): void
  log(event: string, fields?: Record<string, unknown>): void
  now(): number
  /** False to track the socket for the status reply but not act on a reconnect. */
  catchUpOnReconnect: boolean
}

/**
 * Track the socket's state, and turn a reconnect into a catch-up.
 *
 * Split out from app.ts so the "first connection is not a reconnect" rule is testable — it
 * is the one piece of this that is easy to get wrong and impossible to notice, since getting
 * it wrong means a redundant catch-up at startup rather than a visible failure.
 *
 * The first `connected` fires from inside `app.start()`, before the startup catch-up has
 * run; treating it as a reconnect would race a second pass against the startup one for no
 * benefit. Every later one is a genuine gap, because the socket cannot reconnect without
 * having been disconnected, and Slack does not redeliver what it missed in between.
 */
export function createConnectionTracker(deps: ConnectionDeps): {
  state: ConnectionState
  onConnected(): void
  onDisconnected(): void
  onReconnecting(): void
} {
  const state: ConnectionState = { connected: false, reconnects: 0 }
  return {
    state,
    onConnected(): void {
      const first = state.lastConnectedAt === undefined
      state.connected = true
      state.lastConnectedAt = deps.now()
      if (!first) state.reconnects += 1
      deps.log('socket.connected', { first, reconnects: state.reconnects })
      if (first) return
      if (!deps.catchUpOnReconnect) {
        deps.log('catchup.skipped', {
          reason: 'reconnect',
          hint: 'CATCHUP_ON_RECONNECT is off; the timer is the only catch-up left',
        })
        return
      }
      deps.catchUp('reconnect')
    },
    onDisconnected(): void {
      state.connected = false
      state.lastDisconnectedAt = deps.now()
      // Worth a line at info level: this is the event whose aftermath used to be invisible,
      // and pairing it with the socket.connected that follows gives the length of the gap
      // the next catch-up is responsible for.
      deps.log('socket.disconnected', { reconnects: state.reconnects })
    },
    onReconnecting(): void {
      state.connected = false
      deps.log('socket.reconnecting', { reconnects: state.reconnects })
    },
  }
}
