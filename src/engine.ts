// The review-engine abstraction for dual mode (spec 5.4). Each engine runs review-pr in report-only
// mode against pinned commits and returns one EnginePrResult per PR, its usage, and (on a
// process-level failure) an error. An engine never throws: the gate treats `error` as an invalid
// pass, so a crash can never read as clean.

import * as path from 'path'
import {
  CodexOutputError,
  CodexStalledError,
  CodexTimeoutError,
  runCodexReportOnly,
  type ChildRegistry,
} from './codex'
import type { BedrockAuth } from './bedrock-auth'
import { ClaudeRunError, runClaudeReview, totalTokens } from './claude'
import type { EngineName, ReviewConfig } from './config'
import type { PullRequestRef } from './parse-message'
import { buildReportOnlyPrompt } from './prompt'
import { redactSecrets } from './redact'
import { reconcileResultsV2, type EnginePrResult, type EngineRunResult } from './schema'
import type { ClaudeUsageDetail, RunUsage } from './usage'

export interface EnginePr {
  ref: PullRequestRef
  pinnedSha: string
}

export interface EngineRunInput {
  prs: EnginePr[]
  instructions: string
  requestedBy?: string
  /** This engine's own root: `<WORKTREE_ROOT>/<engine>` (see engineWorktreeRoot). */
  worktreeRoot: string
  runId: string
  /** Live-status sink for this request; the engine prefixes each line with its name. */
  onProgress?: (line: string, activeMs: number) => void
}

export interface EngineRunOutcome {
  engine: EngineName
  /** One per requested PR, in order; empty when `error` is set. */
  results: EnginePrResult[]
  usage: RunUsage
  /** Process-level failure: timeout, stall kill on the last attempt, unparseable output, crash. */
  error?: string
}

export interface Engine {
  name: EngineName
  run(input: EngineRunInput): Promise<EngineRunOutcome>
}

/** Parallel engines never share a checkout or a node_modules (spec 5.4). */
export function engineWorktreeRoot(root: string, engine: EngineName): string {
  return path.join(root, engine)
}

/** What one successful attempt produced. */
export interface AttemptSuccess {
  result: EngineRunResult
  activeMs: number
  tokensUsed?: number
  claude?: ClaudeUsageDetail
}

/** A failed attempt; only a stall is retried. */
export class AttemptFailure extends Error {
  constructor(
    message: string,
    readonly stalled: boolean,
    readonly activeMs: number,
    readonly tokensUsed?: number,
    /** Claude's usage breakdown as far as the failed attempt got. */
    readonly claude?: ClaudeUsageDetail
  ) {
    super(message)
    this.name = 'AttemptFailure'
  }
}

/** Sum two optional token counts; unknown only when both are unknown. */
function addTokens(a: number | undefined, b: number | undefined): number | undefined {
  return a === undefined && b === undefined ? undefined : (a ?? 0) + (b ?? 0)
}

/** Sum two optional Claude usage breakdowns field by field; unknown only when both are unknown. */
export function addClaudeUsage(
  a: ClaudeUsageDetail | undefined,
  b: ClaudeUsageDetail | undefined
): ClaudeUsageDetail | undefined {
  if (!a) return b
  if (!b) return a
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    costUsd: a.costUsd + b.costUsd,
    numTurns: a.numTurns + b.numTurns,
    durationMs: a.durationMs + b.durationMs,
  }
}

export interface RetryDeps {
  /** Refresh the private-registry token before each attempt (issue 44). Never throws. */
  refreshAuth?: () => Promise<void>
  log?: (event: string, fields: Record<string, unknown>) => void
}

/**
 * Run attempts with the same escalating stall schedule single mode uses (an empty schedule means one
 * attempt with no stall detection), charging active time across every attempt. Never throws.
 */
export async function runWithStallRetries(
  engine: EngineName,
  input: EngineRunInput,
  schedule: number[],
  attemptOnce: (stallTimeoutMs: number | undefined, runId: string) => Promise<AttemptSuccess>,
  deps: RetryDeps = {}
): Promise<EngineRunOutcome> {
  const urls = input.prs.map(pr => pr.ref.url)
  const attempts = schedule.length > 0 ? schedule.length : 1
  const baseRunId = `${input.runId}.${engine}`
  let charged = 0
  // Spend is charged across every attempt, like active time: a stalled attempt's tokens were
  // consumed even though its result was discarded.
  let tokens: number | undefined
  let claude: ClaudeUsageDetail | undefined
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const runId = attempt === 0 ? baseRunId : `${baseRunId}.retry${attempt}`
    if (deps.refreshAuth) await deps.refreshAuth()
    try {
      const ok = await attemptOnce(schedule[attempt], runId)
      charged += ok.activeMs
      tokens = addTokens(tokens, ok.tokensUsed)
      claude = addClaudeUsage(claude, ok.claude)
      return {
        engine,
        results: reconcileResultsV2(urls, ok.result).results,
        usage: { tokensUsed: tokens, activeMs: charged, attempts: attempt + 1, ...(claude ? { claude } : {}) },
      }
    } catch (error) {
      const failure =
        error instanceof AttemptFailure ? error : new AttemptFailure(error instanceof Error ? error.message : String(error), false, 0)
      charged += failure.activeMs
      tokens = addTokens(tokens, failure.tokensUsed)
      claude = addClaudeUsage(claude, failure.claude)
      if (failure.stalled && attempt < attempts - 1) {
        deps.log?.('engine.retry', { engine, runId: baseRunId, attempt: attempt + 1, of: attempts })
        continue
      }
      deps.log?.('engine.failed', { engine, runId: baseRunId, attempts: attempt + 1 })
      const message = failure.stalled ? `stalled on every attempt (${attempts}): ${failure.message}` : failure.message
      return {
        engine,
        results: [],
        usage: { tokensUsed: tokens, activeMs: charged > 0 ? charged : undefined, attempts: attempt + 1, ...(claude ? { claude } : {}) },
        error: redactSecrets(message),
      }
    }
  }
  // Unreachable: the loop returns on success and on the last failure.
  return { engine, results: [], usage: { attempts }, error: 'the engine ran no attempts' }
}

/**
 * Resolve an engine attempt's model auth: Bedrock credentials in bedrock mode, undefined in
 * subscription mode. Called once per attempt, so a stall retry gets a fresh session.
 */
export type EngineAuthResolver = (engine: EngineName, runId: string) => Promise<BedrockAuth | undefined>

/**
 * Resolve the attempt's auth, turning a failure into a non-retryable attempt failure. The message
 * is the resolver's own (credential-free by construction) and is redacted again at the outcome.
 */
async function attemptAuth(
  resolve: EngineAuthResolver | undefined,
  engine: EngineName,
  runId: string
): Promise<BedrockAuth | undefined> {
  if (!resolve) return undefined
  try {
    return await resolve(engine, runId)
  } catch (error) {
    throw new AttemptFailure(redactSecrets(error instanceof Error ? error.message : String(error)), false, 0)
  }
}

export interface EngineDeps extends RetryDeps {
  /** ENGINE_AUTH: per-attempt model auth. Absent (tests, subscription) means no Bedrock. */
  engineAuth?: EngineAuthResolver
  registry?: ChildRegistry
  /** Injection seams for tests. */
  runCodex?: typeof runCodexReportOnly
  runClaude?: typeof runClaudeReview
}

function prompt(engine: EngineName, input: EngineRunInput): string {
  return buildReportOnlyPrompt({
    engine,
    prs: input.prs,
    instructions: input.instructions,
    worktreeRoot: input.worktreeRoot,
    requestedBy: input.requestedBy,
  })
}

const progress = (engine: EngineName, input: EngineRunInput) =>
  input.onProgress ? (line: string, activeMs: number) => input.onProgress!(`[${engine}] ${line}`, activeMs) : undefined

export function makeCodexEngine(config: ReviewConfig, deps: EngineDeps = {}): Engine {
  const runCodex = deps.runCodex ?? runCodexReportOnly
  return {
    name: 'codex',
    run: input =>
      runWithStallRetries(
        'codex',
        input,
        config.stallBackoffMs,
        async (stallTimeoutMs, runId) => {
          const bedrock = await attemptAuth(deps.engineAuth, 'codex', runId)
          try {
            const o = await runCodex({
              prompt: prompt('codex', input),
              codexBin: config.codexBin,
              profile: config.codexProfile,
              workspaceRoot: config.workspaceRoot,
              worktreeRoot: input.worktreeRoot,
              timeoutMs: config.runTimeoutMs,
              stallTimeoutMs,
              disableGitSigning: config.disableGitSigning,
              envPassthrough: config.codexEnvPassthrough,
              engineGhToken: config.engineGhToken,
              bedrock,
              registry: deps.registry,
              logDir: config.runLogDir,
              runId,
              log: deps.log,
              onProgress: progress('codex', input),
            })
            return { result: o.result, activeMs: o.activeMs, tokensUsed: o.tokensUsed }
          } catch (error) {
            if (error instanceof CodexStalledError) throw new AttemptFailure(error.message, true, error.snapshot.activeMs)
            if (error instanceof CodexTimeoutError) throw new AttemptFailure(error.message, false, error.snapshot.activeMs)
            if (error instanceof CodexOutputError) throw new AttemptFailure(error.message, false, error.activeMs, error.tokensUsed)
            throw error
          }
        },
        deps
      ),
  }
}

export function makeClaudeEngine(config: ReviewConfig, deps: EngineDeps = {}): Engine {
  const runClaude = deps.runClaude ?? runClaudeReview
  return {
    name: 'claude',
    run: input =>
      runWithStallRetries(
        'claude',
        input,
        config.stallBackoffMs,
        async (stallTimeoutMs, runId) => {
          const bedrock = await attemptAuth(deps.engineAuth, 'claude', runId)
          try {
            const o = await runClaude({
              prompt: prompt('claude', input),
              claudeBin: config.claudeBin,
              configDir: config.claudeConfigDir,
              workspaceRoot: config.workspaceRoot,
              worktreeRoot: input.worktreeRoot,
              timeoutMs: config.runTimeoutMs,
              stallTimeoutMs,
              disableGitSigning: config.disableGitSigning,
              envPassthrough: config.codexEnvPassthrough,
              engineGhToken: config.engineGhToken,
              bedrock,
              registry: deps.registry,
              logDir: config.runLogDir,
              runId,
              log: deps.log,
              onProgress: progress('claude', input),
            })
            return { result: o.result, activeMs: o.activeMs, tokensUsed: o.tokensUsed, claude: o.usage }
          } catch (error) {
            if (error instanceof ClaudeRunError) {
              const tokens = error.usage ? totalTokens(error.usage) : undefined
              throw new AttemptFailure(error.message, error.kind === 'stall', error.activeMs, tokens, error.usage)
            }
            throw error
          }
        },
        deps
      ),
  }
}
