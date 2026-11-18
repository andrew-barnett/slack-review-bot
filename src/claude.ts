// Spawning headless Claude Code (`claude -p`) as the second review engine, and reading its
// structured result back out (spec 5.5; flags verified in the V2 spike on issue 54).
//
// Supervision (deadline, stall kill, redaction, run log, child registry) is shared with Codex
// through supervise.ts. This file keeps only what is Claude-specific: the arguments, the child
// environment, and parsing the stream-JSON `result` event.

import { spawn } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'
import { buildChildEnv, withEngineGhToken, withGitSigningDisabled } from './codex'
import { type DeadlineDeps } from './deadline'
import { redactSecrets } from './redact'
import { parseReviewResultV2, REVIEW_OUTPUT_SCHEMA_V2, type EngineRunResult } from './schema'
import { superviseChild, type ChildRegistry, type Spawner } from './supervise'
import type { ClaudeUsageDetail } from './usage'

/** The non-interactive Claude credential (`claude setup-token`), passed to the child by exact name. */
export const CLAUDE_TOKEN_VAR = 'CLAUDE_CODE_OAUTH_TOKEN'

/**
 * Tools the engine may use. With `--permission-mode dontAsk`, anything not listed is denied without
 * a prompt and reported in `permission_denials`. Bash runs inside the profile's sandbox.
 */
export const CLAUDE_ALLOWED_TOOLS = ['Bash', 'Read', 'Grep', 'Glob', 'Edit', 'Write', 'Skill', 'TodoWrite'] as const

/** The largest partial stdout line kept while waiting for its newline (a stream-JSON event). */
export const CLAUDE_LINE_LIMIT = 8 * 1024 * 1024

export interface ClaudeRunOptions {
  prompt: string
  claudeBin: string
  /** The dedicated config dir (CLAUDE_CONFIG_DIR) holding the engine profile. */
  configDir: string
  /** Read-only checkouts; added as a working directory so Claude may read them. */
  workspaceRoot: string
  /** This engine's worktree root; the child's cwd, so the sandbox lets it write there. */
  worktreeRoot: string
  timeoutMs: number
  stallTimeoutMs?: number
  disableGitSigning: boolean
  envPassthrough?: string[]
  /** The read-only engine token, set as the child's GH_TOKEN. Claude runs only in dual mode. */
  engineGhToken: string
  registry?: ChildRegistry
  logDir?: string
  runId: string
  log?: (event: string, fields: Record<string, unknown>) => void
  onProgress?: (line: string, activeMs: number) => void
}

export interface ClaudeRunOutcome {
  result: EngineRunResult
  usage: ClaudeUsageDetail
  /** Input + output + cache-read + cache-write tokens. */
  tokensUsed: number
  activeMs: number
  /** How many tool calls the permission mode denied; reported, never fatal. */
  permissionDenials: number
}

/** Why a Claude run produced no usable result. `stall` is the only retryable kind. */
export type ClaudeFailureKind = 'timeout' | 'stall' | 'output'

export class ClaudeRunError extends Error {
  constructor(
    message: string,
    readonly kind: ClaudeFailureKind,
    readonly activeMs: number,
    readonly usage?: ClaudeUsageDetail
  ) {
    super(message)
    this.name = 'ClaudeRunError'
  }
}

/** Assemble the `claude` argument list. Exported for unit testing. */
export function buildClaudeArgs(options: { prompt: string; schemaJson: string; workspaceRoot: string }): string[] {
  // The prompt is a positional after the boolean -p; a leading dash would be parsed as a flag.
  if (options.prompt.startsWith('-')) throw new Error('Claude prompt must not start with "-"')
  return [
    '-p', options.prompt,
    // Every event is one stdout line: progress for the stall timer, and the final `result` event.
    '--output-format', 'stream-json',
    '--verbose',
    '--json-schema', options.schemaJson,
    // Never prompt: anything not allowed is denied and listed in permission_denials.
    '--permission-mode', 'dontAsk',
    '--add-dir', options.workspaceRoot,
    // Last, and one comma-joined value, so the variadic flag cannot swallow another argument.
    '--allowedTools', CLAUDE_ALLOWED_TOOLS.join(','),
  ]
}

/**
 * The Claude child's environment: the same allowlist as Codex, plus the Claude credential by exact
 * name, the dedicated config dir, and the engine token as GH_TOKEN. buildChildEnv's denylist keeps
 * the approver token out even if an operator names it as passthrough.
 */
export function buildClaudeEnv(
  base: NodeJS.ProcessEnv,
  options: {
    configDir: string
    engineGhToken: string
    envPassthrough?: string[]
    disableGitSigning: boolean
    /** This engine's worktree root; package caches are redirected beneath it. */
    cacheRoot?: string
  }
): NodeJS.ProcessEnv {
  let env = buildChildEnv(base, [...(options.envPassthrough ?? []), CLAUDE_TOKEN_VAR])
  // The OAuth token must be the credential in use, even if an operator passed an API key through.
  delete env.ANTHROPIC_API_KEY
  env.CLAUDE_CONFIG_DIR = options.configDir
  if (options.cacheRoot) {
    // Keep package caches inside the engine's own worktree root, so the sandbox profile need not
    // grant writes to the operator's ~/.npm, ~/.cache, ~/Library/Caches or ~/Library/pnpm.
    const cache = path.join(options.cacheRoot, '.cache')
    env.XDG_CACHE_HOME = cache
    env.npm_config_cache = path.join(cache, 'npm')
    env.npm_config_store_dir = path.join(cache, 'pnpm-store')
  }
  if (options.disableGitSigning) env = withGitSigningDisabled(env)
  return withEngineGhToken(env, options.engineGhToken)
}

/** The fields of the stream-JSON `result` event the bot reads. */
export interface ClaudeResultEvent {
  type: 'result'
  subtype?: string
  is_error?: boolean
  result?: string
  structured_output?: unknown
  total_cost_usd?: number
  num_turns?: number
  duration_ms?: number
  permission_denials?: unknown[]
  usage?: {
    input_tokens?: number
    output_tokens?: number
    cache_read_input_tokens?: number
    cache_creation_input_tokens?: number
  }
}

/**
 * Collects raw stdout and keeps the last `{"type":"result"}` event. Lines are split on newlines
 * across chunks; any other event is discarded as soon as its line is complete.
 */
export function createResultCollector(lineLimit: number = CLAUDE_LINE_LIMIT): {
  push(text: string): void
  flush(): void
  result(): ClaudeResultEvent | undefined
} {
  let partial = ''
  let overflowed = false
  let last: ClaudeResultEvent | undefined
  const take = (line: string) => {
    const trimmed = line.trim()
    if (!trimmed.startsWith('{') || !trimmed.includes('"result"')) return
    try {
      const event = JSON.parse(trimmed) as { type?: string }
      if (event.type === 'result') last = event as ClaudeResultEvent
    } catch {
      // Not JSON (a stray log line); ignore it.
    }
  }
  return {
    push(text) {
      const pieces = (partial + text).split('\n')
      partial = pieces.pop() ?? ''
      for (const piece of pieces) {
        if (overflowed) {
          // The rest of an over-long line; drop it and resume at the next line.
          overflowed = false
          continue
        }
        take(piece)
      }
      if (partial.length > lineLimit) {
        partial = ''
        overflowed = true
      }
    },
    flush() {
      if (!overflowed && partial) take(partial)
      partial = ''
    },
    result: () => last,
  }
}

const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

/** Read the usage figures out of a result event; absent fields read as 0. */
export function claudeUsage(event: ClaudeResultEvent): ClaudeUsageDetail {
  return {
    inputTokens: n(event.usage?.input_tokens),
    outputTokens: n(event.usage?.output_tokens),
    cacheReadTokens: n(event.usage?.cache_read_input_tokens),
    cacheWriteTokens: n(event.usage?.cache_creation_input_tokens),
    costUsd: n(event.total_cost_usd),
    numTurns: n(event.num_turns),
    durationMs: n(event.duration_ms),
  }
}

export function totalTokens(u: ClaudeUsageDetail): number {
  return u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheWriteTokens
}

const minutes = (ms: number) => `${Math.round(ms / 60_000)} minute${Math.round(ms / 60_000) === 1 ? '' : 's'}`

export async function runClaudeReview(
  options: ClaudeRunOptions,
  spawner: Spawner = spawn,
  clock: Partial<DeadlineDeps> = {}
): Promise<ClaudeRunOutcome> {
  const env = buildClaudeEnv(process.env, {
    configDir: options.configDir,
    engineGhToken: options.engineGhToken,
    envPassthrough: options.envPassthrough,
    disableGitSigning: options.disableGitSigning,
    cacheRoot: options.worktreeRoot,
  })
  const args = buildClaudeArgs({
    prompt: options.prompt,
    schemaJson: JSON.stringify(REVIEW_OUTPUT_SCHEMA_V2),
    workspaceRoot: options.workspaceRoot,
  })
  fs.mkdirSync(options.worktreeRoot, { recursive: true })
  const collector = createResultCollector()

  const exit = await superviseChild(
    {
      bin: options.claudeBin,
      args,
      cwd: options.worktreeRoot,
      env,
      timeoutMs: options.timeoutMs,
      stallTimeoutMs: options.stallTimeoutMs,
      registry: options.registry,
      logDir: options.logDir,
      logName: options.runId,
      runId: options.runId,
      logPrefix: 'claude',
      log: options.log,
      onProgress: options.onProgress,
      onStdout: text => collector.push(text),
    },
    spawner,
    clock
  )
  collector.flush()
  const event = collector.result()
  const usage = event ? claudeUsage(event) : undefined

  if (exit.timedOut) {
    throw new ClaudeRunError(`Claude run exceeded the ${minutes(options.timeoutMs)} timeout and was killed`, 'timeout', exit.timedOut.activeMs, usage)
  }
  if (exit.stalled) {
    throw new ClaudeRunError(
      `Claude produced no output for ${minutes(options.stallTimeoutMs ?? 0)} of active time and was killed as stalled`,
      'stall',
      exit.stalled.activeMs,
      usage
    )
  }
  if (!event) {
    const tail = redactSecrets(exit.transcript).slice(-1500).trim()
    throw new ClaudeRunError(
      `Claude exited with code ${exit.code} and produced no result event` + (tail ? `:\n${tail}` : ''),
      'output',
      exit.activeMs
    )
  }
  if (event.is_error) {
    // e.g. "Not logged in · Please run /login" when the credential is missing (V2 spike).
    const detail = redactSecrets(String(event.result ?? event.subtype ?? 'unknown error')).slice(0, 500)
    throw new ClaudeRunError(`Claude reported an error: ${detail}`, 'output', exit.activeMs, usage)
  }
  if (event.structured_output === undefined || event.structured_output === null) {
    throw new ClaudeRunError('Claude finished without structured output', 'output', exit.activeMs, usage)
  }
  let result: EngineRunResult
  try {
    result = parseReviewResultV2(JSON.stringify(event.structured_output))
  } catch (error) {
    throw new ClaudeRunError(redactSecrets(error instanceof Error ? error.message : String(error)), 'output', exit.activeMs, usage)
  }
  const detail = usage as ClaudeUsageDetail
  const denials = Array.isArray(event.permission_denials) ? event.permission_denials.length : 0
  if (denials > 0) options.log?.('claude.permission_denials', { runId: options.runId, count: denials })
  return { result, usage: detail, tokensUsed: totalTokens(detail), activeMs: exit.activeMs, permissionDenials: denials }
}
