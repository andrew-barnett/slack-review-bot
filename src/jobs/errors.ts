// The error round-trip of the job protocol (spec 3.3). A worker serializes the error its local run
// function threw; the orchestrator rebuilds the same class, so the engines' instanceof-based retry
// logic (only a stall is retried) works unchanged across the process boundary. The body comes from a
// container that ran untrusted PR code, so every field is validated and every message redacted.

import { ClaudeRunError, type ClaudeFailureKind } from '../claude'
import { CodexOutputError, CodexStalledError, CodexTimeoutError } from '../codex'
import type { DeadlineSnapshot } from '../deadline'
import { redactSecrets } from '../redact'
import type { ClaudeUsageDetail, CodexUsageDetail } from '../usage'

export type SerializedRunError =
  | { class: 'CodexStalledError'; message: string; stallMs: number; snapshot: DeadlineSnapshot; codexUsage?: CodexUsageDetail }
  | { class: 'CodexTimeoutError'; message: string; snapshot: DeadlineSnapshot; codexUsage?: CodexUsageDetail }
  | { class: 'CodexOutputError'; message: string; tokensUsed?: number; activeMs: number; codexUsage?: CodexUsageDetail }
  | { class: 'ClaudeRunError'; message: string; kind: ClaudeFailureKind; activeMs: number; usage?: ClaudeUsageDetail }
  | { class: 'Error'; message: string }

/** Longest message kept; an error tail is already capped at 1500 characters by the runners. */
const MAX_MESSAGE = 8000
const CLAUDE_KINDS: ReadonlySet<string> = new Set<ClaudeFailureKind>(['timeout', 'stall', 'output'])

const text = (value: unknown): string => redactSecrets(typeof value === 'string' ? value : String(value ?? '')).slice(0, MAX_MESSAGE)

/** A finite, non-negative number, or 0. */
export function nonNegative(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
}

/** A finite, non-negative number, or undefined (an unknown count stays unknown). */
export function optionalNonNegative(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

export const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}

function snapshotOf(value: unknown): DeadlineSnapshot {
  const s = record(value)
  return { activeMs: nonNegative(s.activeMs), wallMs: nonNegative(s.wallMs), frozenMs: nonNegative(s.frozenMs) }
}

/** Claude's usage breakdown with every field forced to a finite, non-negative number. */
export function usageOf(value: unknown): ClaudeUsageDetail | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const u = value as Record<string, unknown>
  return {
    inputTokens: nonNegative(u.inputTokens),
    outputTokens: nonNegative(u.outputTokens),
    cacheReadTokens: nonNegative(u.cacheReadTokens),
    cacheWriteTokens: nonNegative(u.cacheWriteTokens),
    costUsd: nonNegative(u.costUsd),
    numTurns: nonNegative(u.numTurns),
    durationMs: nonNegative(u.durationMs),
  }
}

/** Codex's usage breakdown with every field forced to a finite, non-negative number (spec 6 wire). */
export function codexUsageOf(value: unknown): CodexUsageDetail | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const u = value as Record<string, unknown>
  return {
    inputTokens: nonNegative(u.inputTokens),
    cachedInputTokens: nonNegative(u.cachedInputTokens),
    cacheWriteTokens: nonNegative(u.cacheWriteTokens),
    outputTokens: nonNegative(u.outputTokens),
    reasoningTokens: nonNegative(u.reasoningTokens),
  }
}

/** The worker side: describe a thrown value so the orchestrator can rebuild it. */
export function serializeRunError(error: unknown): SerializedRunError {
  // Each Codex failure keeps the turns it completed (spec 6); absent stays absent.
  const codex = (u: CodexUsageDetail | undefined) => (u ? { codexUsage: { ...u } } : {})
  if (error instanceof CodexStalledError) {
    return {
      class: 'CodexStalledError',
      message: text(error.message),
      stallMs: error.stallMs,
      snapshot: { ...error.snapshot },
      ...codex(error.codexUsage),
    }
  }
  if (error instanceof CodexTimeoutError) {
    return { class: 'CodexTimeoutError', message: text(error.message), snapshot: { ...error.snapshot }, ...codex(error.codexUsage) }
  }
  if (error instanceof CodexOutputError) {
    return {
      class: 'CodexOutputError',
      message: text(error.message),
      activeMs: error.activeMs,
      ...(error.tokensUsed !== undefined ? { tokensUsed: error.tokensUsed } : {}),
      ...codex(error.codexUsage),
    }
  }
  if (error instanceof ClaudeRunError) {
    return {
      class: 'ClaudeRunError',
      message: text(error.message),
      kind: error.kind,
      activeMs: error.activeMs,
      ...(error.usage ? { usage: { ...error.usage } } : {}),
    }
  }
  return { class: 'Error', message: text(error instanceof Error ? error.message : error) }
}

/** The orchestrator side: rebuild the error class the worker's run function threw. Never throws. */
export function deserializeRunError(value: unknown): Error {
  const e = record(value)
  const message = text(e.message)
  switch (e.class) {
    case 'CodexStalledError':
      return new CodexStalledError(message, nonNegative(e.stallMs), snapshotOf(e.snapshot), codexUsageOf(e.codexUsage))
    case 'CodexTimeoutError':
      return new CodexTimeoutError(message, snapshotOf(e.snapshot), codexUsageOf(e.codexUsage))
    case 'CodexOutputError':
      return new CodexOutputError(message, optionalNonNegative(e.tokensUsed), nonNegative(e.activeMs), codexUsageOf(e.codexUsage))
    case 'ClaudeRunError': {
      // An unknown kind is treated as output: never retryable, never a timeout's budget claim.
      const kind = typeof e.kind === 'string' && CLAUDE_KINDS.has(e.kind) ? (e.kind as ClaudeFailureKind) : 'output'
      return new ClaudeRunError(message, kind, nonNegative(e.activeMs), usageOf(e.usage))
    }
    default:
      return new Error(message)
  }
}
