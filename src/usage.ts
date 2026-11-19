// What one review cost, and how that reads in Slack.
//
// Codex prints a running "tokens used" total to its transcript; the bot never surfaced it.
// This module parses that number out, carries it (with the run's active time and attempt
// count) as a RunUsage, and renders it two ways: a per-review thread line and the compact
// figures the status reply shows. Kept free of Slack and Codex specifics so the parsing and
// the formatting are unit-testable on their own.

import type { EngineName } from './config'
import type { DualReport } from './dual'
import type { ReviewRunResult } from './schema'

/**
 * What Claude's stream-JSON `result` event reports about a run (V2 spike, issue 54). `costUsd` is
 * notional under subscription auth (CLAUDE_CODE_OAUTH_TOKEN): a figure, not a charge.
 */
export interface ClaudeUsageDetail {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  costUsd: number
  numTurns: number
  durationMs: number
}

/**
 * What `codex exec --json` reports a run cost: each `turn.completed.usage`, summed over the run's
 * turns (spec 6; field names from codex-cli 0.169.0). Whether `cachedInputTokens` is inside
 * `inputTokens`, and `reasoningTokens` inside `outputTokens`, is the price table's to say.
 */
export interface CodexUsageDetail {
  inputTokens: number
  cachedInputTokens: number
  cacheWriteTokens: number
  outputTokens: number
  reasoningTokens: number
}

/** A Codex run's token total for the usage line and the status: the sum of every field (spec 6). */
export function codexTotalTokens(u: CodexUsageDetail): number {
  return u.inputTokens + u.cachedInputTokens + u.cacheWriteTokens + u.outputTokens + u.reasoningTokens
}

/** Sum two optional Codex usage breakdowns field by field; unknown only when both are unknown. */
export function addCodexUsage(
  a: CodexUsageDetail | undefined,
  b: CodexUsageDetail | undefined
): CodexUsageDetail | undefined {
  if (!a) return b
  if (!b) return a
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    cachedInputTokens: a.cachedInputTokens + b.cachedInputTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    reasoningTokens: a.reasoningTokens + b.reasoningTokens,
  }
}

/**
 * The cost of a single review request, gathered whether it passed, found things, or failed.
 *
 * `tokensUsed` is optional because a killed run (a timeout or a stall) usually dies before
 * Codex prints its total — the field is absent then rather than a misleading zero. `activeMs`
 * is the deadline's charged time, so a run that spent hours suspended reads as the minutes it
 * was actually working. `attempts` is how many Codex invocations the run took, so a retry after
 * a stall is visible rather than hidden behind a single figure.
 */
export interface RunUsage {
  /** Codex's reported total for the run, or undefined when it printed none (e.g. a kill). */
  tokensUsed?: number
  /** Active (non-suspended) time charged to the run, in ms; undefined when never measured. */
  activeMs?: number
  /** Number of Codex invocations this review took — >1 means a stall was retried. */
  attempts: number
  /** Claude's own figures, when this usage is a Claude engine's. */
  claude?: ClaudeUsageDetail
  /** Codex's --json figures summed over every attempt, when this usage is a Codex run's (spec 6). */
  codex?: CodexUsageDetail
  /** Dual mode: each engine's usage. The top-level figures are then the sums across engines. */
  engines?: { engine: EngineName; usage: RunUsage }[]
}

/** A completed review: what Codex concluded, and what it cost. */
export interface ReviewOutcome {
  result: ReviewRunResult
  usage: RunUsage
  /** Dual mode only: the per-PR gate report the job renders. */
  dual?: DualReport
}

/**
 * A review run that failed, carrying what it still managed to cost.
 *
 * The runner throws this instead of a bare Error so the job can report usage on the failure
 * path too — a run that stalled through every attempt still burned real active time, and a
 * status total that ignored failed runs would understate the machine time spent. The original
 * failure is preserved as {@link cause} and its message is this error's message, so the Slack
 * error thread reads exactly as it did before.
 */
export class ReviewFailedError extends Error {
  constructor(
    readonly usage: RunUsage,
    cause: unknown
  ) {
    super(cause instanceof Error ? cause.message : String(cause))
    this.name = 'ReviewFailedError'
    this.cause = cause
    if (cause instanceof Error && cause.stack) this.stack = cause.stack
  }
}

/**
 * Pull Codex's "tokens used" total out of a run transcript.
 *
 * Codex prints the total once near the end, as `tokens used` followed by the number (on the
 * next line in `codex exec`, or inline as `tokens used: N` in other builds) — both are
 * accepted. The last occurrence wins, so a transcript that somehow reported more than once is
 * read as its final figure. Returns undefined when no total was printed, which is the normal
 * case for a run killed before it finished.
 */
export function parseTokensUsed(transcript: string): number | undefined {
  // Match only a "tokens used" footer that stands on its OWN line — Codex's actual usage line —
  // rather than scanning the whole transcript for the substring. The transcript also contains
  // the diffs and command output Codex reviewed, which can themselves contain "tokens used N"
  // (this very file does); a loose substring scan could pick one of those up as a fabricated
  // total. Anchoring to a standalone line rejects text embedded in reviewed content, which
  // always carries a diff marker, code, or prose around it. Two forms are accepted: the label
  // and number on one line, or the label alone with the number on the next line.
  const lines = transcript.split(/\r?\n/)
  let found: number | undefined
  for (let i = 0; i < lines.length; i += 1) {
    const label = /^[ \t]*tokens used[ \t]*:?[ \t]*([\d,]*)[ \t]*$/i.exec(lines[i])
    if (!label) continue
    let digits = label[1]
    // Two-line form: the label is alone on its line, the total on the next non-blank line.
    if (!digits) {
      const next = (lines[i + 1] ?? '').trim()
      const number = /^([\d,]+)$/.exec(next)
      if (!number) continue
      digits = number[1]
    }
    const n = Number(digits.replace(/,/g, ''))
    if (Number.isFinite(n)) found = n
  }
  return found
}

/** Group digits with commas: 210482 -> "210,482". Exact figure for the thread line. */
export function formatTokensExact(n: number): string {
  return Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

/**
 * Round a token count to a compact figure for the status reply: 9_150_000 -> "9.2M",
 * 210_482 -> "210K", 842 -> "842". A whole number of millions drops the decimal ("9M", not
 * "9.0M"). The status surface trades exactness for a line that stays short across many reviews;
 * the per-review thread uses {@link formatTokensExact} instead.
 */
export function formatTokensCompact(n: number): string {
  if (n >= 1_000_000) {
    const m = n / 1_000_000
    const text = m.toFixed(1)
    return `${text.endsWith('.0') ? text.slice(0, -2) : text}M`
  }
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`
  return `${Math.round(n)}`
}

/**
 * A run's active time as `4m12s` / `45s` / `1h04m`, seconds and minutes zero-padded so the
 * figures line up. Shown next to the token count in the thread; the status reply uses its own
 * coarser `formatDuration` for the other spans it prints.
 */
export function formatActive(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m${String(seconds % 60).padStart(2, '0')}s`
  const hours = Math.floor(minutes / 60)
  return `${hours}h${String(minutes % 60).padStart(2, '0')}m`
}

/**
 * The per-review usage line posted in the thread, e.g.
 * `🧮 210,482 tokens · 4m12s active · 1 attempt`.
 *
 * Degrades gracefully: a run with no token total (a kill) reads `tokens n/a`, and active time
 * is dropped when it was never measured, so a failed run still gets an honest one-liner rather
 * than a row of zeros.
 */
export function renderUsageLine(usage: RunUsage): string {
  // Dual mode reports each engine on its own (spec 5.9), never a blended figure.
  if (usage.engines) {
    if (usage.engines.length === 0) return '🧮 no engine ran'
    return `🧮 ${usage.engines.map(e => `${ENGINE_NAME[e.engine]} ${usageParts(e.usage).join(' · ')}`).join(' | ')}`
  }
  return `🧮 ${usageParts(usage).join(' · ')}`
}

const ENGINE_NAME: Record<EngineName, string> = { codex: 'Codex', claude: 'Claude' }

function usageParts(usage: RunUsage): string[] {
  let tokens = usage.tokensUsed === undefined ? 'tokens n/a' : `${formatTokensExact(usage.tokensUsed)} tokens`
  // Subscription auth makes Claude's cost a notional figure, not a charge, so it says so.
  if (usage.claude) tokens += ` ($${usage.claude.costUsd.toFixed(2)} notional)`
  const parts = [tokens]
  if (usage.activeMs !== undefined && usage.activeMs > 0) parts.push(`${formatActive(usage.activeMs)} active`)
  parts.push(`${usage.attempts} attempt${usage.attempts === 1 ? '' : 's'}`)
  return parts
}
