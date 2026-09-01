// How far the bot has processed each channel, and how that survives a restart.
//
// Socket Mode only delivers what happens while the socket is connected. A message posted
// while the daemon is restarting, while the laptop is asleep, or during a launchd throttle
// window is never redelivered, and the symptom — nothing happens — is the same one every
// other failure in this daemon produces. So the position is recorded per channel here and
// replayed at startup (see replay.ts).
//
// "Processed" deliberately means *finished*, not *received*: a review commits to the cursor
// only once its job settles. A restart in the middle of a 30-minute review therefore
// replays that message and reviews it again, which is the outcome worth having — the
// alternative is a message left wearing an :eyes: reaction that never gets a verdict.

import * as fs from 'fs'
import * as path from 'path'

/** Bumped only if the on-disk shape changes incompatibly; an older file is discarded. */
export const CURSOR_VERSION = 1

/**
 * Cap on out-of-order entries kept above the watermark. Reached only if a message is begun
 * and never settled — a bug, but one that would otherwise pin the cursor forever and make
 * every restart replay the same growing backlog. Hitting it force-advances the watermark.
 */
export const DONE_LIMIT = 200

/** The persisted position in one channel. */
export interface ChannelCursor {
  /** Every message at or before this ts is processed. */
  ts: string
  /**
   * Processed messages *after* `ts`. These exist because reviews settle out of order when
   * CONCURRENCY > 1: without them, a restart would re-review a message whose review had
   * already finished, purely because an older review was still running at shutdown.
   */
  done: string[]
  /** When this entry last moved. Operator-facing; nothing reads it back. */
  updatedAt: string
}

export interface CursorFile {
  version: number
  channels: Record<string, ChannelCursor>
}

/**
 * Order two Slack `ts` values.
 *
 * They are `<seconds>.<microseconds>` strings and are compared as two integers rather than
 * as floats or as text: `Number()` on the whole thing loses microsecond precision at
 * current epoch values, which would make two messages in the same second compare equal —
 * and equal here means "already processed", i.e. a silently dropped review.
 */
export function compareTs(a: string, b: string): number {
  const [aSec = '0', aFrac = ''] = a.split('.')
  const [bSec = '0', bFrac = ''] = b.split('.')
  const seconds = Number(aSec) - Number(bSec)
  if (seconds !== 0) return seconds < 0 ? -1 : 1
  const fraction = Number(aFrac.padEnd(6, '0')) - Number(bFrac.padEnd(6, '0'))
  return fraction === 0 ? 0 : fraction < 0 ? -1 : 1
}

/** A Slack-style ts for a wall-clock time. Used to start a channel at "now". */
export function tsForTime(ms: number): string {
  return (ms / 1000).toFixed(6)
}

interface ChannelState {
  ts: string
  done: Set<string>
  /** Seen but not yet finished. In memory only — the whole point is that a crash replays these. */
  pending: Set<string>
}

export interface TrackerDeps {
  /** Persist the durable part of the state. Called only when it actually changes. */
  persist(file: CursorFile): void
  now(): number
  log(event: string, fields?: Record<string, unknown>): void
}

/**
 * The in-memory position, with an injected `persist` so the ordering logic is testable
 * without touching a filesystem.
 */
export class CursorTracker {
  private readonly channels = new Map<string, ChannelState>()

  constructor(private readonly deps: TrackerDeps, initial: CursorFile = { version: CURSOR_VERSION, channels: {} }) {
    for (const [channel, cursor] of Object.entries(initial.channels ?? {})) {
      this.channels.set(channel, { ts: cursor.ts, done: new Set(cursor.done ?? []), pending: new Set() })
    }
  }

  /** Channels with a recorded position — the replay set when no allowlist is configured. */
  list(): string[] {
    return [...this.channels.keys()]
  }

  /** Where replay should read from, or undefined for a channel never seen before. */
  watermark(channel: string): string | undefined {
    return this.channels.get(channel)?.ts
  }

  /** Processed messages above the watermark, which replay must not dispatch again. */
  settled(channel: string): string[] {
    return [...(this.channels.get(channel)?.done ?? [])]
  }

  /**
   * Messages begun and not yet finished, which replay must not dispatch *either*.
   *
   * The watermark deliberately stays below a message under review, so a catch-up reading from
   * the watermark finds it again on every pass — for a three-hour review at a five-minute
   * cadence, that is thirty-six re-dispatches of a job already running. They bounce off the
   * dedupe set in app.ts, but that set is a bounded LRU: evict the key while the review is
   * still going and the next pass starts a genuine second Codex run on the same PR.
   *
   * In-memory only, like `pending` itself. That is correct rather than a gap: after a restart
   * nothing is in flight, and the message *should* be replayed because its review died with
   * the process.
   */
  inFlight(channel: string): string[] {
    return [...(this.channels.get(channel)?.pending ?? [])]
  }

  /**
   * Give a channel a starting position if it has none, so a first run does not treat the
   * entire readable history as missed. Returns the position replay should use.
   */
  start(channel: string, ts: string): string {
    const existing = this.channels.get(channel)
    if (existing) return existing.ts
    this.channels.set(channel, { ts, done: new Set(), pending: new Set() })
    this.deps.log('cursor.started', { channel, ts })
    this.write()
    return ts
  }

  /** Whether this message is already accounted for and must not be processed again. */
  isProcessed(channel: string, ts: string): boolean {
    const state = this.channels.get(channel)
    if (!state) return false
    return compareTs(ts, state.ts) <= 0 || state.done.has(ts)
  }

  /**
   * Note that work has started on a message. Holds the watermark below it until `settle`,
   * which is what makes an interrupted review replay instead of vanishing.
   */
  begin(channel: string, ts: string): void {
    const state = this.channels.get(channel) ?? this.blank()
    this.channels.set(channel, state)
    if (compareTs(ts, state.ts) <= 0) return
    state.pending.add(ts)
  }

  /** Note that a message is finished, and advance the watermark as far as it can go. */
  settle(channel: string, ts: string): void {
    const state = this.channels.get(channel) ?? this.blank()
    this.channels.set(channel, state)
    state.pending.delete(ts)
    // Recorded even when it cannot move the watermark yet: a finished review that only lives
    // in memory would be re-reviewed after a restart, because the watermark it is waiting
    // behind is the very thing that did not survive.
    const added = compareTs(ts, state.ts) > 0 && !state.done.has(ts)
    if (added) state.done.add(ts)
    if (this.compact(channel, state) || added) this.write()
  }

  /** Begin and settle in one step, for a message with no work to do. */
  record(channel: string, ts: string): void {
    this.settle(channel, ts)
  }

  snapshot(): CursorFile {
    const channels: Record<string, ChannelCursor> = {}
    const updatedAt = new Date(this.deps.now()).toISOString()
    for (const [channel, state] of this.channels) {
      channels[channel] = { ts: state.ts, done: [...state.done].sort(compareTs), updatedAt }
    }
    return { version: CURSOR_VERSION, channels }
  }

  private blank(): ChannelState {
    // A message in a channel with no cursor yet: start the watermark below it so the
    // message itself still counts as unprocessed and can advance the cursor normally.
    return { ts: '0.000000', done: new Set(), pending: new Set() }
  }

  /**
   * Move the watermark over every settled message that no unfinished message precedes,
   * dropping those entries from `done`. The watermark is a promise about everything at or
   * below it, so it can only pass a message once nothing older is still running.
   */
  private compact(channel: string, state: ChannelState): boolean {
    const floor = [...state.pending].sort(compareTs)[0]
    let moved = false
    for (const ts of [...state.done].sort(compareTs)) {
      if (floor !== undefined && compareTs(ts, floor) > 0) break
      state.done.delete(ts)
      state.ts = ts
      moved = true
    }
    if (state.done.size > DONE_LIMIT) {
      // Something was begun and never settled. Give up on it rather than replay a backlog
      // that grows on every restart, and say so — this is a bug, not routine.
      const highest = [...state.done].sort(compareTs).pop() as string
      this.deps.log('cursor.forced', {
        channel,
        ts: highest,
        pending: state.pending.size,
        hint: 'a message was never settled; skipping ahead',
      })
      state.ts = highest
      state.done.clear()
      state.pending.clear()
      moved = true
    }
    return moved
  }

  private write(): void {
    try {
      this.deps.persist(this.snapshot())
    } catch (error) {
      // A cursor that cannot be written costs replay accuracy on the next restart; it must
      // never take down a daemon that is otherwise reviewing fine.
      this.deps.log('cursor.write.failed', { error: String(error) })
    }
  }
}

/** Read a cursor file, tolerating every way it can be absent or wrong. */
export function readCursorFile(
  file: string,
  log: (event: string, fields?: Record<string, unknown>) => void
): CursorFile {
  const empty: CursorFile = { version: CURSOR_VERSION, channels: {} }
  let raw: string
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch {
    return empty
  }
  try {
    const parsed = JSON.parse(raw) as CursorFile
    if (parsed?.version !== CURSOR_VERSION || typeof parsed.channels !== 'object' || !parsed.channels) {
      log('cursor.unreadable', { file, version: parsed?.version, hint: 'starting from now' })
      return empty
    }
    const channels: Record<string, ChannelCursor> = {}
    for (const [channel, cursor] of Object.entries(parsed.channels)) {
      if (typeof cursor?.ts !== 'string' || !/^\d+(\.\d+)?$/.test(cursor.ts)) continue
      channels[channel] = {
        ts: cursor.ts,
        done: Array.isArray(cursor.done) ? cursor.done.filter(ts => typeof ts === 'string') : [],
        updatedAt: typeof cursor.updatedAt === 'string' ? cursor.updatedAt : '',
      }
    }
    return { version: CURSOR_VERSION, channels }
  } catch (error) {
    // A truncated write, or a hand-edit. Losing the position replays nothing rather than
    // everything, which is the safe direction to fail in.
    log('cursor.unreadable', { file, error: String(error), hint: 'starting from now' })
    return empty
  }
}

/**
 * A tracker backed by a JSON file, written atomically.
 *
 * The rename matters: the file is rewritten on every settled message, so a plain truncating
 * write that lost power mid-flush would leave an empty or half-written file, and the next
 * start would have no idea where it was.
 */
export function openCursorStore(
  file: string,
  log: (event: string, fields?: Record<string, unknown>) => void,
  now: () => number = Date.now
): CursorTracker {
  const persist = (state: CursorFile): void => {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const tmp = `${file}.tmp`
    fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`)
    fs.renameSync(tmp, file)
  }
  return new CursorTracker({ persist, now, log }, readCursorFile(file, log))
}

/** A tracker that persists nothing, for an empty `CURSOR_FILE` and for the CLI. */
export function openNullCursorStore(
  log: (event: string, fields?: Record<string, unknown>) => void,
  now: () => number = Date.now
): CursorTracker {
  return new CursorTracker({ persist: () => {}, now, log })
}
