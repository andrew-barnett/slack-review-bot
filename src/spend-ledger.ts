// The month-to-date Bedrock spend ledger (spec section 7): one append-only JSON Lines journal per UTC
// month, spend-YYYY-MM.jsonl in the cursor file's directory. Each line is a priced engine run, a decided
// threshold alert, or a decided cap-reached message. The bot never rewrites, renames or deletes a
// journal: a new month is a new file name, and old months stay for audit. `spentUsd` never leaves the
// process: user-facing text shows percentages only (spec section 1).

import * as fs from 'fs'
import * as path from 'path'
import type { EngineName } from './config'
import type { LedgerTokens } from './pricing'

/** One priced engine run: a `run` line without its `type`. */
export interface SpendRun {
  at: string
  runId: string
  engine: EngineName
  model: string
  tokens: LedgerTokens
  costUsd: number
  /** The engine ran but reported no usage (a lost worker, say): recorded at zero so the gap is auditable. */
  noUsage?: true
}

/** What the current month's journal adds up to. */
export interface SpendState {
  /** The UTC month, `YYYY-MM`. */
  month: string
  /** The sum of the month's run costs. */
  spentUsd: number
  /** Alert thresholds already decided this month, ascending. */
  alerted: number[]
  /** The highest cap a cap-reached message was decided for this month; absent when none was. */
  capAnnouncedFor?: number
  /** The journal has a bad line, or storage cannot be written: the month reads as capped (ruling 8). */
  locked: boolean
  /** The month's runs, in journal order. */
  entries: SpendRun[]
}

export interface SpendLedger {
  /** This month's state, switching to the new month's journal first if the UTC month has changed. */
  state(nowMs: number): Readonly<SpendState>
  /** Count the runs, then append them in one write. Never throws. */
  recordRuns(runs: SpendRun[], nowMs: number): void
  /** Mark the threshold alerted, then append it. Called before posting. Never throws. */
  recordAlert(percent: number, nowMs: number): void
  /** Mark the cap-reached message decided for `capUsd`, then append it. Called before posting. Never throws. */
  recordCapAnnounced(capUsd: number, nowMs: number): void
}

type Log = (event: string, fields: Record<string, unknown>) => void

/** `YYYY-MM` of the UTC month containing `ms`. */
export function utcMonth(ms: number): string {
  const d = new Date(ms)
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
}

/** 00:00 UTC on the first day of the month after the one containing `ms`: when the cap resets. */
export function nextMonthStart(ms: number): number {
  const d = new Date(ms)
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)
}

/** The journal for `month` (`YYYY-MM`) in the state directory `dir`. */
export function spendFileFor(dir: string, month: string): string {
  return path.join(dir, `spend-${month}.jsonl`)
}

const UNREADABLE_HINT = 'this month reads as capped; fix or remove the bad line and restart'
const WRITE_HINT = 'new reviews are refused until the spend journal can be written'

const isObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const nonNegative = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0
const TOKEN_FIELDS = ['input', 'cachedInput', 'cacheWrite', 'output', 'reasoning'] as const

type JournalLine = { type: 'run'; run: SpendRun } | { type: 'alert'; percent: number } | { type: 'cap'; capUsd: number }

/** One journal line, or the reason it cannot be trusted. */
function parseLine(text: string): JournalLine | string {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (error) {
    return `not JSON: ${String(error)}`
  }
  if (!isObject(value)) return 'not a JSON object'
  const at = value.at
  if (typeof at !== 'string' || Number.isNaN(Date.parse(at))) return 'bad "at"'
  if (value.type === 'run') {
    const { runId, engine, model, tokens, costUsd, noUsage } = value
    if (typeof runId !== 'string' || typeof model !== 'string') return 'bad run: runId and model must be strings'
    if (engine !== 'codex' && engine !== 'claude') return 'bad run: unknown engine'
    if (!isObject(tokens) || !TOKEN_FIELDS.every(field => nonNegative(tokens[field]))) return 'bad run: tokens'
    if (!nonNegative(costUsd)) return 'bad run: costUsd'
    if (noUsage !== undefined && noUsage !== true) return 'bad run: noUsage'
    const counts = tokens as Record<(typeof TOKEN_FIELDS)[number], number>
    return {
      type: 'run',
      run: {
        at,
        runId,
        engine,
        model,
        tokens: {
          input: counts.input,
          cachedInput: counts.cachedInput,
          cacheWrite: counts.cacheWrite,
          output: counts.output,
          reasoning: counts.reasoning,
        },
        costUsd,
        ...(noUsage ? { noUsage: true as const } : {}),
      },
    }
  }
  if (value.type === 'alert') {
    const percent = value.percent
    return typeof percent === 'number' && Number.isInteger(percent) && percent >= 1 && percent <= 99
      ? { type: 'alert', percent }
      : 'bad alert: percent must be an integer from 1 to 99'
  }
  if (value.type === 'cap') {
    const capUsd = value.capUsd
    return typeof capUsd === 'number' && Number.isFinite(capUsd) && capUsd > 0 ? { type: 'cap', capUsd } : 'bad cap: capUsd must be above zero'
  }
  return `unknown type ${JSON.stringify(value.type)}`
}

/** One month's journal, as read and as recorded since. */
interface Month {
  month: string
  file: string
  spentUsd: number
  alerted: Set<number>
  capAnnouncedFor?: number
  /** A line could not be trusted: the month stays locked until the line is fixed and the bot restarts. */
  unreadable: boolean
  /** The file ends without a newline (a crash mid-append): the next append starts a fresh line first. */
  partialTail: boolean
  entries: SpendRun[]
}

function applyLine(m: Month, line: JournalLine): void {
  if (line.type === 'run') {
    m.entries.push(line.run)
    m.spentUsd += line.run.costUsd
  } else if (line.type === 'alert') {
    m.alerted.add(line.percent)
  } else {
    m.capAnnouncedFor = Math.max(m.capAnnouncedFor ?? 0, line.capUsd)
  }
}

/** Read `month`'s journal. A missing file is an empty month; any line that cannot be trusted locks it. */
function readMonth(dir: string, month: string, log: Log): Month {
  const file = spendFileFor(dir, month)
  const m: Month = { month, file, spentUsd: 0, alerted: new Set(), unreadable: false, partialTail: false, entries: [] }
  let raw: string
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return m
    log('spend.unreadable', { file, reason: `cannot read: ${String(error)}`, hint: UNREADABLE_HINT })
    m.unreadable = true
    return m
  }
  const bad = (line: number, reason: string): void => {
    m.unreadable = true
    log('spend.unreadable', { file, line, reason, hint: UNREADABLE_HINT })
  }
  const lines = raw.split('\n')
  // What follows the last newline: empty for a whole journal, a partial line after a crash mid-append.
  const tail = lines.pop() ?? ''
  lines.forEach((text, index) => {
    if (text.trim() === '') return
    const parsed = parseLine(text)
    if (typeof parsed === 'string') bad(index + 1, parsed)
    else applyLine(m, parsed)
  })
  if (tail !== '') {
    // Conservative: even a tail that would parse is treated as a write that may not have finished.
    bad(lines.length + 1, 'partial last line (no trailing newline)')
    m.partialTail = true
  }
  return m
}

/** How a journal is appended to. Tests substitute one that fails part-way through a write. */
export type AppendFile = (file: string, text: string) => void

/**
 * Open the journal for the current UTC month in `dir` (Task 5's `spendDir`). Reading never throws: an
 * untrustworthy journal, or storage that cannot be written, makes the month read as capped instead.
 */
export function openSpendLedger(
  dir: string,
  log: Log,
  nowMs: number = Date.now(),
  appendFile: AppendFile = fs.appendFileSync
): SpendLedger {
  // True while the last append or probe failed. The month reads as capped until one succeeds, and every
  // state() retries the probe, so the lock clears on its own once storage recovers.
  let writeFailing = false
  const succeeded = (file: string): void => {
    if (writeFailing) log('spend.write_recovered', { file })
    writeFailing = false
  }
  const failed = (file: string, error: unknown): void => {
    writeFailing = true
    log('spend.write_failed', { file, error: String(error), hint: WRITE_HINT })
  }
  /** Can the journal be appended to? A zero-byte append creates a missing file and writes nothing. */
  const probe = (m: Month): void => {
    try {
      fs.mkdirSync(dir, { recursive: true })
      fs.accessSync(dir, fs.constants.W_OK)
      appendFile(m.file, '')
      succeeded(m.file)
    } catch (error) {
      failed(m.file, error)
    }
  }
  /** One append per call. Never throws: a ledger that cannot be written must not take a review down. */
  const append = (m: Month, records: object[]): void => {
    const text = `${m.partialTail ? '\n' : ''}${records.map(record => `${JSON.stringify(record)}\n`).join('')}`
    try {
      fs.mkdirSync(dir, { recursive: true })
      appendFile(m.file, text)
      m.partialTail = false
      succeeded(m.file)
    } catch (error) {
      // A failed append may still have written a prefix with no newline. Start the next record on a
      // fresh line so it never joins the damaged one (a blank line is ignored on read).
      m.partialTail = true
      failed(m.file, error)
    }
  }

  let current = readMonth(dir, utcMonth(nowMs), log)
  probe(current)

  /** The month for `now`: on the first call in a new UTC month, read (and probe) that month's journal. */
  const monthAt = (now: number): Month => {
    const month = utcMonth(now)
    if (month !== current.month) {
      log('spend.month_started', { from: current.month, to: month, file: spendFileFor(dir, month) })
      current = readMonth(dir, month, log)
      probe(current)
    }
    return current
  }

  return {
    state(now) {
      const m = monthAt(now)
      if (writeFailing) probe(m)
      return {
        month: m.month,
        spentUsd: m.spentUsd,
        alerted: [...m.alerted].sort((a, b) => a - b),
        ...(m.capAnnouncedFor !== undefined ? { capAnnouncedFor: m.capAnnouncedFor } : {}),
        locked: m.unreadable || writeFailing,
        entries: m.entries,
      }
    },
    recordRuns(runs, now) {
      if (runs.length === 0) return
      const m = monthAt(now)
      // Counted before the append: if it fails, this process still counts the run and stays capped
      // (ruling 17).
      for (const run of runs) applyLine(m, { type: 'run', run })
      append(m, runs.map(run => ({ type: 'run', ...run })))
    },
    recordAlert(percent, now) {
      const m = monthAt(now)
      applyLine(m, { type: 'alert', percent })
      append(m, [{ type: 'alert', at: new Date(now).toISOString(), percent }])
    },
    recordCapAnnounced(capUsd, now) {
      const m = monthAt(now)
      applyLine(m, { type: 'cap', capUsd })
      append(m, [{ type: 'cap', at: new Date(now).toISOString(), capUsd }])
    },
  }
}
