// The orchestrator's side of the job protocol (spec 3.3), with no transport: a queue of engine
// attempts waiting for a worker, one-use claim tickets, per-job tokens, progress and log forwarding,
// result settlement, cancellation, and worker-loss detection. server.ts adapts it to HTTP, so every
// rule here is testable without a socket.
//
// Threat model: every worker runs untrusted PR code as the same UID as the worker process, so PR code
// can read the worker's ticket and job token. The ticket is spent before PR code exists, and the job
// token only reaches that worker's own job, so the worst a compromised worker can do is lie about its
// own engine's result.

import { randomBytes, timingSafeEqual } from 'crypto'
import * as fs from 'fs'
import * as path from 'path'
import { ClaudeRunError } from '../claude'
import { CodexOutputError } from '../codex'
import type { ChildRegistry } from '../supervise'
import { deserializeRunError } from './errors'
import {
  CLAIM_WAIT_MS,
  LOG_CHUNK_LIMIT,
  LOG_JOB_LIMIT,
  PROGRESS_LINE_LIMIT,
  RUN_ID_RE,
  WORKER_LOST_MS,
  type ClaimReply,
  type JobKind,
  type WireRunOptions,
} from './protocol'
import { createSpentNonces, verifyTicket } from './ticket'

export interface BrokerReply {
  status: number
  body?: unknown
}

export interface SubmitHooks {
  /** The request's live-status sink; called with each progress line the worker posts. */
  onProgress?: (line: string, activeMs: number) => void
  /** A worker took the job (for the "waiting for a worker" status line). */
  onClaimed?: () => void
}

export interface JobBrokerOptions {
  launchKey: Buffer
  ticketMaxAgeMs: number
  /** RUN_LOG_DIR; empty disables run logs. */
  logDir: string
  claimWaitMs?: number
  workerLostMs?: number
  /** Added to a job's timeoutMs to bound how long a claimed job may run; default JOB_DEADLINE_MARGIN_MS. */
  deadlineMarginMs?: number
  sweepMs?: number
  logChunkLimit?: number
  logJobLimit?: number
  now?: () => number
  log?: (event: string, fields: Record<string, unknown>) => void
  token?: () => string
  jobId?: () => string
}

export interface JobBroker {
  submit(kind: JobKind, options: WireRunOptions, hooks?: SubmitHooks): Promise<unknown>
  claim(ticket: string, signal?: AbortSignal): Promise<BrokerReply>
  progress(id: string, token: string, body: unknown): BrokerReply
  heartbeat(id: string, token: string): BrokerReply
  result(id: string, token: string, body: unknown): BrokerReply
  appendLog(id: string, token: string, chunk: Buffer): BrokerReply
  /** Shutdown, step one: fail queued jobs, mark claimed ones cancelled (409), refuse new submits. */
  cancelAll(): number
  /** Shutdown, step two: fail every job still unsettled. */
  abandonAll(): number
  inFlight(): number
  /** Worker-loss and housekeeping pass; run every SWEEP_MS by start(). */
  sweep(): void
  asRegistry(): ChildRegistry
  start(): void
  stop(): void
  readonly limits: { logChunk: number; logJob: number }
}

export const SWEEP_MS = 5_000
/** A sweep this much later than scheduled means the process (or the Docker VM) was suspended. */
export const FREEZE_TOLERANCE_MS = 15_000
/** Settled jobs are kept this long so a late call gets 403 (dead token) rather than 404. */
export const DONE_RETENTION_MS = 10 * 60_000
/**
 * A claimed job may run for its timeoutMs plus this margin. Heartbeats alone cannot bound a job: a
 * wedged worker, or PR code holding the job token, can heartbeat forever and pin a CONCURRENCY slot.
 */
export const JOB_DEADLINE_MARGIN_MS = 5 * 60_000

type Settlement = { ok: true; value: unknown } | { ok: false; error: Error }

interface Job {
  id: string
  kind: JobKind
  options: WireRunOptions
  hooks: SubmitHooks
  state: 'queued' | 'claimed' | 'done'
  cancelled: boolean
  token?: string
  lastBeatAt: number
  /** Set at claim time: claim + timeoutMs + margin, pushed back by any freeze. */
  deadlineAt?: number
  logBytes: number
  doneAt?: number
  settle(result: Settlement): void
}

interface Waiter {
  nonce: string
  /** The ticket's mint time; the worker's engine credentials were minted with it. */
  issuedAt: number
  reply(reply: BrokerReply): void
}

/** The error a job fails with when no worker result arrives: the kind's non-retryable output error. */
function outputError(kind: JobKind, message: string): Error {
  return kind === 'codex-report-only' ? new CodexOutputError(message, undefined, 0) : new ClaudeRunError(message, 'output', 0)
}

const FORBIDDEN: BrokerReply = { status: 403, body: { error: 'token not valid for this job' } }
const EXPIRED: BrokerReply = { status: 403, body: { error: 'expired' } }

export function createJobBroker(o: JobBrokerOptions): JobBroker {
  const now = o.now ?? Date.now
  const log = o.log ?? (() => {})
  const newToken = o.token ?? (() => randomBytes(32).toString('hex'))
  const newId = o.jobId ?? (() => randomBytes(12).toString('hex'))
  const claimWaitMs = o.claimWaitMs ?? CLAIM_WAIT_MS
  const workerLostMs = o.workerLostMs ?? WORKER_LOST_MS
  const deadlineMarginMs = o.deadlineMarginMs ?? JOB_DEADLINE_MARGIN_MS
  const sweepMs = o.sweepMs ?? SWEEP_MS
  const limits = { logChunk: o.logChunkLimit ?? LOG_CHUNK_LIMIT, logJob: o.logJobLimit ?? LOG_JOB_LIMIT }
  const spent = createSpentNonces(o.ticketMaxAgeMs)
  const jobs = new Map<string, Job>()
  const queue: Job[] = []
  const waiters: Waiter[] = []
  let closed = false
  let lastSweepAt: number | undefined
  let interval: ReturnType<typeof setInterval> | undefined

  const dequeue = (job: Job) => {
    const i = queue.indexOf(job)
    if (i >= 0) queue.splice(i, 1)
  }

  const finish = (job: Job, result: Settlement) => {
    if (job.state === 'done') return
    job.state = 'done'
    job.doneAt = now()
    dequeue(job)
    job.settle(result)
  }

  /** Give `job` to the holder of `nonce`; undefined when the nonce was already spent. */
  const assign = (job: Job, nonce: string): ClaimReply | undefined => {
    if (!spent.spend(nonce, now())) return undefined
    dequeue(job)
    job.state = 'claimed'
    job.token = newToken()
    job.lastBeatAt = now()
    job.deadlineAt = job.lastBeatAt + job.options.timeoutMs + deadlineMarginMs
    log('jobs.claimed', { jobId: job.id, kind: job.kind, runId: job.options.runId })
    try {
      job.hooks.onClaimed?.()
    } catch {
      // A status-side failure is not the job's problem.
    }
    return { jobId: job.id, jobToken: job.token, kind: job.kind, options: job.options }
  }

  /** Hand a new job to the oldest live waiter, or queue it. */
  const offer = (job: Job) => {
    while (waiters.length) {
      const waiter = waiters.shift()!
      // A waiter parked across a sleep still holds its nonce, but the credentials minted with its
      // ticket may have expired: refuse it so the worker exits and the launcher mints a fresh one.
      if (now() - waiter.issuedAt > o.ticketMaxAgeMs) {
        log('jobs.claim_rejected', { reason: 'expired', stage: 'assign' })
        waiter.reply(EXPIRED)
        continue
      }
      const reply = assign(job, waiter.nonce)
      if (reply) {
        waiter.reply({ status: 200, body: reply })
        return
      }
      // Another long-poll with the same ticket already took a job (Review Focus 4).
      waiter.reply({ status: 403, body: { error: 'spent' } })
    }
    queue.push(job)
  }

  const authed = (id: string, token: string): Job | BrokerReply => {
    const job = jobs.get(id)
    if (!job) return { status: 404, body: { error: 'unknown job' } }
    if (job.state !== 'claimed' || !job.token) return FORBIDDEN
    const given = Buffer.from(token, 'utf8')
    const expected = Buffer.from(job.token, 'utf8')
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return FORBIDDEN
    return job
  }
  const isReply = (value: Job | BrokerReply): value is BrokerReply => 'status' in value

  const broker: JobBroker = {
    limits,

    submit(kind, options, hooks = {}) {
      if (closed) return Promise.reject(outputError(kind, 'the orchestrator is shutting down; the job was not queued'))
      if (!RUN_ID_RE.test(options.runId)) return Promise.reject(new Error('runId is not safe for a log file name'))
      // The run deadline is computed from timeoutMs; NaN would make it unreachable.
      if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) return Promise.reject(new Error('timeoutMs is not a positive number'))
      return new Promise((resolve, reject) => {
        const job: Job = {
          id: newId(),
          kind,
          options,
          hooks,
          state: 'queued',
          cancelled: false,
          lastBeatAt: now(),
          logBytes: 0,
          settle: result => (result.ok ? resolve(result.value) : reject(result.error)),
        }
        jobs.set(job.id, job)
        log('jobs.queued', { jobId: job.id, kind, runId: options.runId })
        offer(job)
      })
    },

    async claim(ticket, signal) {
      const check = verifyTicket(o.launchKey, ticket, now(), o.ticketMaxAgeMs)
      if (!check.ok) {
        log('jobs.claim_rejected', { reason: check.reason })
        return { status: 403, body: { error: check.reason } }
      }
      if (spent.has(check.nonce)) {
        log('jobs.claim_rejected', { reason: 'spent' })
        return { status: 403, body: { error: 'spent' } }
      }
      const next = queue[0]
      if (next) {
        const reply = assign(next, check.nonce)
        return reply ? { status: 200, body: reply } : { status: 403, body: { error: 'spent' } }
      }
      if (signal?.aborted) return { status: 204 }
      return new Promise<BrokerReply>(resolve => {
        let done = false
        const waiter: Waiter = {
          nonce: check.nonce,
          issuedAt: check.issuedAt,
          reply: reply => {
            if (done) return
            done = true
            clearTimeout(timer)
            signal?.removeEventListener('abort', onAbort)
            resolve(reply)
          },
        }
        const drop = () => {
          const i = waiters.indexOf(waiter)
          if (i >= 0) waiters.splice(i, 1)
        }
        const timer = setTimeout(() => {
          drop()
          waiter.reply({ status: 204 })
        }, claimWaitMs)
        // Review Focus 2: a dropped connection must not keep a waiter that would swallow a job.
        const onAbort = () => {
          drop()
          waiter.reply({ status: 204 })
        }
        signal?.addEventListener('abort', onAbort, { once: true })
        waiters.push(waiter)
      })
    },

    progress(id, token, body) {
      const job = authed(id, token)
      if (isReply(job)) return job
      job.lastBeatAt = now()
      if (job.cancelled) return { status: 409, body: { cancel: true } }
      const b = body as { line?: unknown; activeMs?: unknown } | null
      if (!b || typeof b !== 'object' || typeof b.line !== 'string' || typeof b.activeMs !== 'number' || !Number.isFinite(b.activeMs) || b.activeMs < 0) {
        return { status: 400, body: { error: 'want {line, activeMs}' } }
      }
      try {
        job.hooks.onProgress?.(b.line.slice(0, PROGRESS_LINE_LIMIT), b.activeMs)
      } catch {
        // Reporting what a run is doing is never worth failing it.
      }
      return { status: 200, body: {} }
    },

    heartbeat(id, token) {
      const job = authed(id, token)
      if (isReply(job)) return job
      job.lastBeatAt = now()
      return job.cancelled ? { status: 409, body: { cancel: true } } : { status: 200, body: {} }
    },

    result(id, token, body) {
      const job = authed(id, token)
      if (isReply(job)) return job
      const b = body as { ok?: unknown; outcome?: unknown; error?: unknown } | null
      if (!b || typeof b !== 'object' || (b.ok !== true && b.ok !== false)) return { status: 400, body: { error: 'want {ok, outcome|error}' } }
      log('jobs.result', { jobId: job.id, runId: job.options.runId, ok: b.ok })
      // Accepted even after a cancel: the worker's own outcome (a killed run) is the truest report.
      finish(job, b.ok === true ? { ok: true, value: b.outcome } : { ok: false, error: deserializeRunError(b.error) })
      return { status: 200, body: {} }
    },

    appendLog(id, token, chunk) {
      const job = authed(id, token)
      if (isReply(job)) return job
      job.lastBeatAt = now()
      if (chunk.length > limits.logChunk || job.logBytes + chunk.length > limits.logJob) {
        return { status: 413, body: { error: 'log limit reached' } }
      }
      job.logBytes += chunk.length
      if (o.logDir) {
        try {
          fs.mkdirSync(o.logDir, { recursive: true })
          fs.appendFileSync(path.join(o.logDir, `${job.options.runId}.log`), chunk)
        } catch (error) {
          // Logging must never take the run down.
          log('jobs.log_write_failed', { jobId: job.id, error: String(error) })
        }
      }
      return { status: 200, body: {} }
    },

    cancelAll() {
      closed = true
      let count = 0
      for (const job of jobs.values()) {
        if (job.state === 'done') continue
        count += 1
        job.cancelled = true
        if (job.state === 'queued') finish(job, { ok: false, error: outputError(job.kind, 'cancelled by shutdown before a worker claimed it') })
      }
      if (count) log('jobs.cancel_all', { count })
      return count
    },

    abandonAll() {
      closed = true
      let count = 0
      for (const job of jobs.values()) {
        if (job.state === 'done') continue
        count += 1
        finish(job, { ok: false, error: outputError(job.kind, 'cancelled by shutdown; the worker did not report back in time') })
      }
      if (count) log('jobs.abandon_all', { count })
      return count
    },

    inFlight() {
      let count = 0
      for (const job of jobs.values()) if (job.state !== 'done') count += 1
      return count
    },

    sweep() {
      const t = now()
      // Ruling 7: a late sweep means the machine slept; nobody could heartbeat while it did.
      const frozen = lastSweepAt !== undefined && t - lastSweepAt > sweepMs + FREEZE_TOLERANCE_MS
      const frozenForMs = frozen ? t - (lastSweepAt as number) : 0
      if (frozen) log('jobs.freeze', { frozenForMs })
      lastSweepAt = t
      if (frozen && waiters.length) {
        // Every parked worker's credentials aged through the sleep; replace them all with fresh ones.
        log('jobs.waiters_flushed', { count: waiters.length })
        for (const waiter of waiters.splice(0)) waiter.reply(EXPIRED)
      }
      for (const job of [...jobs.values()]) {
        if (job.state === 'claimed') {
          if (frozen) {
            job.lastBeatAt = t
            // The run could not progress while frozen either, so the deadline moves by the same amount.
            if (job.deadlineAt !== undefined) job.deadlineAt += frozenForMs
          } else if (job.deadlineAt !== undefined && t > job.deadlineAt) {
            log('jobs.deadline', { jobId: job.id, runId: job.options.runId, overByMs: t - job.deadlineAt })
            finish(job, { ok: false, error: outputError(job.kind, 'worker exceeded its run deadline') })
          } else if (t - job.lastBeatAt > workerLostMs) {
            log('jobs.worker_lost', { jobId: job.id, runId: job.options.runId, silentMs: t - job.lastBeatAt })
            finish(job, { ok: false, error: outputError(job.kind, `worker lost (no heartbeat for ${Math.round(workerLostMs / 1000)} s)`) })
          }
        } else if (job.state === 'done' && job.doneAt !== undefined && t - job.doneAt > DONE_RETENTION_MS) {
          jobs.delete(job.id)
        }
      }
      spent.prune(t)
    },

    asRegistry() {
      return {
        add: () => {},
        remove: () => {},
        killAll: signal => (signal === 'SIGKILL' ? broker.abandonAll() : broker.cancelAll()),
        size: () => broker.inFlight(),
      }
    },

    start() {
      if (interval) return
      interval = setInterval(() => broker.sweep(), sweepMs)
      interval.unref?.()
    },

    stop() {
      if (interval) clearInterval(interval)
      interval = undefined
      for (const waiter of waiters.splice(0)) waiter.reply({ status: 204 })
    },
  }
  return broker
}
