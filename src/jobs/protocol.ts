// The job protocol between the orchestrator and one-shot workers (spec 3.3): HTTP/1.1 with JSON
// bodies on the internal `jobs` network. These are the shared constants, wire types and validators.

import * as path from 'path'
import type { SerializedRunError } from './errors'

export const JOB_PORT = 8080
/** How long POST /v1/claim waits for a job before answering 204. */
export const CLAIM_WAIT_MS = 25_000
export const HEARTBEAT_MS = 10_000
/** No heartbeat (or progress, or log) for this long fails the job as "worker lost". */
export const WORKER_LOST_MS = 45_000
export const LOG_CHUNK_LIMIT = 1024 * 1024
export const LOG_JOB_LIMIT = 50 * 1024 * 1024
/** A result body; findings can be long, but not this long. */
export const JSON_BODY_LIMIT = 16 * 1024 * 1024
export const PROGRESS_LINE_LIMIT = 4096
/** Spec 3.3: tickets older than WORKER_IDLE_EXIT_MS + 1 minute are rejected. */
export const TICKET_GRACE_MS = 60_000

/** A run id names a log file under RUN_LOG_DIR, so it may hold no path separator. */
export const RUN_ID_RE = /^[A-Za-z0-9._-]{1,200}$/
export const JOB_ID_RE = /^[A-Za-z0-9]{1,64}$/
export const JOB_TOKEN_RE = /^[0-9a-f]{64}$/

export type JobKind = 'codex-report-only' | 'claude-review'
export const JOB_KINDS: readonly JobKind[] = ['codex-report-only', 'claude-review']

/**
 * What crosses the wire about a run (ruling 1). Machine-local settings and every credential come
 * from the worker's own config, never from here.
 */
export interface WireRunOptions {
  prompt: string
  worktreeRoot: string
  timeoutMs: number
  stallTimeoutMs?: number
  runId: string
}

export interface ClaimReply {
  jobId: string
  jobToken: string
  kind: JobKind
  options: WireRunOptions
}

export interface ProgressBody {
  line: string
  activeMs: number
}

export type ResultBody = { ok: true; outcome: unknown } | { ok: false; error: SerializedRunError }

export function ticketMaxAgeMs(workerIdleExitMs: number): number {
  return workerIdleExitMs + TICKET_GRACE_MS
}

/** Pick exactly the wire fields from a full run-options object. */
export function toWireOptions(options: WireRunOptions): WireRunOptions {
  const out: WireRunOptions = {
    prompt: options.prompt,
    worktreeRoot: options.worktreeRoot,
    timeoutMs: options.timeoutMs,
    runId: options.runId,
  }
  if (options.stallTimeoutMs !== undefined) out.stallTimeoutMs = options.stallTimeoutMs
  return out
}

const positive = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0

export function parseWireOptions(value: unknown): WireRunOptions {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('options is not an object')
  const o = value as Record<string, unknown>
  if (typeof o.prompt !== 'string' || !o.prompt) throw new Error('options.prompt is missing')
  if (typeof o.worktreeRoot !== 'string' || !path.isAbsolute(o.worktreeRoot)) throw new Error('options.worktreeRoot is not an absolute path')
  if (!positive(o.timeoutMs)) throw new Error('options.timeoutMs is not a positive number')
  if (o.stallTimeoutMs !== undefined && !positive(o.stallTimeoutMs)) throw new Error('options.stallTimeoutMs is not a positive number')
  if (typeof o.runId !== 'string' || !RUN_ID_RE.test(o.runId)) throw new Error('options.runId is not a safe run id')
  return toWireOptions(o as unknown as WireRunOptions)
}

export function parseClaimReply(value: unknown): ClaimReply {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('claim reply is not an object')
  const r = value as Record<string, unknown>
  if (typeof r.jobId !== 'string' || !JOB_ID_RE.test(r.jobId)) throw new Error('claim reply jobId is invalid')
  if (typeof r.jobToken !== 'string' || !JOB_TOKEN_RE.test(r.jobToken)) throw new Error('claim reply jobToken is invalid')
  if (typeof r.kind !== 'string' || !(JOB_KINDS as readonly string[]).includes(r.kind)) throw new Error('claim reply kind is invalid')
  return { jobId: r.jobId, jobToken: r.jobToken, kind: r.kind as JobKind, options: parseWireOptions(r.options) }
}
