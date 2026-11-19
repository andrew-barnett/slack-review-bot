// Remote implementations of the two report-only engine run functions (spec D1). Same signatures as
// runCodexReportOnly and runClaudeReview, so the engines, their stall retries, the scheduler and the
// gate run unchanged; each call is one job, run by one fresh worker container. The worker's outcome is
// untrusted (it ran PR code), so it is re-validated here exactly as a local final message would be.

import { ClaudeRunError, totalTokens, type ClaudeRunOptions, type ClaudeRunOutcome, type runClaudeReview } from '../claude'
import { CodexOutputError, type CodexRunOptions, type CodexRunOutcome, type runCodexReportOnly } from '../codex'
import { redactSecrets } from '../redact'
import { parseReviewResultV2, type EngineRunResult } from '../schema'
import type { ClaudeUsageDetail } from '../usage'
import type { JobBroker, SubmitHooks } from './broker'
import { nonNegative, optionalNonNegative, record, usageOf } from './errors'
import { toWireOptions } from './protocol'

export const WAITING_LINE = 'waiting for a worker'
export const CLAIMED_LINE = 'a worker claimed the job'

export interface RemoteRunners {
  runCodex: typeof runCodexReportOnly
  runClaude: typeof runClaudeReview
}

const message = (error: unknown) => redactSecrets(error instanceof Error ? error.message : String(error))

/** Validate a worker's Codex outcome; anything unusable is an output error carrying what it claimed to cost. */
export function normalizeCodexOutcome(raw: unknown): CodexRunOutcome<EngineRunResult> {
  const o = record(raw)
  const activeMs = nonNegative(o.activeMs)
  const tokensUsed = optionalNonNegative(o.tokensUsed)
  let result: EngineRunResult
  try {
    result = parseReviewResultV2(JSON.stringify(o.result ?? null))
  } catch (error) {
    throw new CodexOutputError(`the worker returned an unusable result: ${message(error)}`, tokensUsed, activeMs)
  }
  return { result, rawFinalMessage: '', tokensUsed, activeMs }
}

const ZERO_USAGE: ClaudeUsageDetail = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, numTurns: 0, durationMs: 0 }

/** Validate a worker's Claude outcome; the token total is recomputed, never trusted. */
export function normalizeClaudeOutcome(raw: unknown): ClaudeRunOutcome {
  const o = record(raw)
  const activeMs = nonNegative(o.activeMs)
  const usage = usageOf(o.usage) ?? ZERO_USAGE
  let result: EngineRunResult
  try {
    result = parseReviewResultV2(JSON.stringify(o.result ?? null))
  } catch (error) {
    throw new ClaudeRunError(`the worker returned an unusable result: ${message(error)}`, 'output', activeMs, usage)
  }
  return { result, usage, tokensUsed: totalTokens(usage), activeMs, permissionDenials: Math.floor(nonNegative(o.permissionDenials)) }
}

/** Status hooks: the request shows "waiting for a worker" until one claims the job (ruling 5). */
function hooksFor(onProgress: ((line: string, activeMs: number) => void) | undefined): SubmitHooks {
  const say = (line: string) => {
    try {
      onProgress?.(line, 0)
    } catch {
      // Status is best-effort.
    }
  }
  say(WAITING_LINE)
  return { onProgress, onClaimed: () => say(CLAIMED_LINE) }
}

export function makeRemoteRunners(broker: Pick<JobBroker, 'submit'>): RemoteRunners {
  return {
    runCodex: async (options: CodexRunOptions) =>
      // A rejection is already the rebuilt error class (CodexStalledError and friends): rethrown as is.
      normalizeCodexOutcome(await broker.submit('codex-report-only', toWireOptions(options), hooksFor(options.onProgress))),
    runClaude: async (options: ClaudeRunOptions) =>
      normalizeClaudeOutcome(await broker.submit('claude-review', toWireOptions(options), hooksFor(options.onProgress))),
  }
}
