// The one-shot worker (spec 3.4). It claims exactly one job, runs one engine attempt with the local
// run function, streams progress and the run log back, posts the result and exits 0 whatever the
// result. It holds only low-value, short-lived engine credentials from its stdin bundle, never
// LAUNCH_KEY and never a daemon token, and its workspace starts empty (spec D7).

import * as fs from 'fs'
import * as path from 'path'
import type { BedrockAuth } from './bedrock-auth'
import type { runClaudeReview } from './claude'
import type { ChildRegistry, runCodexReportOnly } from './codex'
import type { EngineName, ReviewConfig } from './config'
import type { JobClient } from './jobs/client'
import { serializeRunError } from './jobs/errors'
import { HEARTBEAT_MS, LOG_CHUNK_LIMIT, type ClaimReply, type ProgressBody, type ResultBody } from './jobs/protocol'
import { redactSecrets } from './redact'

export const CLAIM_RETRY_MS = 2_000
export const LOG_POLL_MS = 2_000
export const CHILD_KILL_GRACE_MS = 10_000
/** How long the worker waits for in-flight progress posts before posting its result. */
export const PROGRESS_DRAIN_MS = 5_000
/** Consecutive failed heartbeats (about a minute at 10 s) after which the orchestrator is gone. */
export const HEARTBEAT_FAILURE_LIMIT = 6
export const WORKER_NPMRC = '/home/bot/.npmrc-worker'
export const CODEARTIFACT_REGISTRY = 'https://trade-platform-153538148884.d.codeartifact.us-east-2.amazonaws.com/npm/trade-platform/'

export interface WorkerDeps {
  config: ReviewConfig
  ticket: string
  client: JobClient
  runCodex: typeof runCodexReportOnly
  runClaude: typeof runClaudeReview
  resolveAuth(engine: EngineName, runId: string): Promise<BedrockAuth>
  registry: ChildRegistry
  logDir: string
  log(event: string, fields?: Record<string, unknown>): void
  now(): number
  sleep(ms: number): Promise<void>
  every(ms: number, fn: () => void): () => void
  setTimer(fn: () => void, ms: number): void
  readFrom(file: string, offset: number, max: number): Buffer
}

export type WorkerExit = 'done' | 'cancelled' | 'idle' | 'rejected' | 'lost'

/** Spec 3.4: only a container worker with launcher-minted static Bedrock credentials may run. */
export function assertWorkerConfig(config: ReviewConfig): void {
  if (config.runtime !== 'container') throw new Error('the worker runs only with RUNTIME=container')
  if (config.engineAuth !== 'bedrock') throw new Error('the worker needs ENGINE_AUTH=bedrock')
  if (config.engineRoleArn) throw new Error('the worker uses launcher-minted static credentials; unset ENGINE_ROLE_ARN')
  if (!config.engineAwsStatic) throw new Error('the worker has no engine AWS credentials')
  if (!config.engineGhToken) throw new Error('the worker has no ENGINE_GH_TOKEN')
}

/** The job's worktree root, which must sit under the worker's own WORKTREE_ROOT. */
export function workerWorktreeRoot(given: string, root: string): string {
  const resolved = path.resolve(given)
  const rel = path.relative(path.resolve(root), resolved)
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('the job named a worktree root outside WORKTREE_ROOT')
  return resolved
}

/** Ruling 13: npm reads the token from the environment; the file holds only its name. */
export function renderWorkerNpmrc(): string {
  const host = CODEARTIFACT_REGISTRY.replace(/^https:/, '')
  return [`@trade-platform:registry=${CODEARTIFACT_REGISTRY}`, `${host}:_authToken=\${NPM_TOKEN}`, ''].join('\n')
}

export function writeWorkerNpmrc(file: string): void {
  fs.writeFileSync(file, renderWorkerNpmrc(), { mode: 0o600 })
}

/** Read up to `max` bytes of `file` from `offset`; empty when the file does not exist yet. */
export function readFrom(file: string, offset: number, max: number): Buffer {
  let fd: number
  try {
    fd = fs.openSync(file, 'r')
  } catch {
    return Buffer.alloc(0)
  }
  try {
    const buffer = Buffer.alloc(max)
    const read = fs.readSync(fd, buffer, 0, max, offset)
    return buffer.subarray(0, read)
  } finally {
    fs.closeSync(fd)
  }
}

async function claimOne(deps: WorkerDeps): Promise<ClaimReply | 'idle' | 'rejected'> {
  const deadline = deps.now() + deps.config.workerIdleExitMs
  while (deps.now() < deadline) {
    const started = deps.now()
    try {
      const reply = await deps.client.claim(deps.ticket)
      if (reply.status === 200 && reply.job) return reply.job
      if (reply.status === 403) return 'rejected'
      if (reply.status === 204 && deps.now() - started >= 1_000) continue
      if (reply.status !== 204) deps.log('worker.claim_status', { status: reply.status })
    } catch (error) {
      deps.log('worker.claim_failed', { error: redactSecrets(String(error)) })
    }
    // An error, an unexpected status, or a 204 that came back too fast to be a long-poll.
    await deps.sleep(CLAIM_RETRY_MS)
  }
  return 'idle'
}

export async function runWorker(deps: WorkerDeps): Promise<WorkerExit> {
  const claimed = await claimOne(deps)
  if (claimed === 'idle' || claimed === 'rejected') {
    deps.log('worker.exit_early', { reason: claimed })
    return claimed
  }
  const job = claimed
  const engine: EngineName = job.kind === 'codex-report-only' ? 'codex' : 'claude'
  deps.log('worker.claimed', { jobId: job.jobId, kind: job.kind, runId: job.options.runId })

  let cancelled = false
  let lost = false
  const cancel = (why: 'cancel' | 'lost') => {
    if (why === 'lost') lost = true
    if (cancelled) return
    cancelled = true
    deps.log('worker.cancelling', { jobId: job.jobId, why })
    deps.registry.killAll('SIGTERM')
    deps.setTimer(() => deps.registry.killAll('SIGKILL'), CHILD_KILL_GRACE_MS)
  }
  const onStatus = (status: number) => {
    if (status === 409) cancel('cancel')
    else if (status === 403 || status === 404) cancel('lost')
  }

  let heartbeatFailures = 0
  const beat = async () => {
    try {
      onStatus(await deps.client.heartbeat(job))
      heartbeatFailures = 0
    } catch (error) {
      heartbeatFailures += 1
      deps.log('worker.heartbeat_failed', { failures: heartbeatFailures, error: redactSecrets(String(error)) })
      if (heartbeatFailures >= HEARTBEAT_FAILURE_LIMIT) cancel('lost')
    }
  }
  const stopBeat = deps.every(HEARTBEAT_MS, () => void beat())

  // Progress: at most one post in flight; the newest line replaces any line still waiting.
  let posting = false
  let pending: ProgressBody | undefined
  // The current pump run; it resolves once every queued line has been posted (or given up on).
  let pumped: Promise<void> = Promise.resolve()
  const pump = async (): Promise<void> => {
    if (posting || !pending) return
    posting = true
    const body = pending
    pending = undefined
    try {
      onStatus(await deps.client.progress(job, body))
    } catch {
      // Progress is best-effort; the heartbeat decides whether the orchestrator is gone.
    } finally {
      posting = false
    }
    return pump()
  }
  const onProgress = (line: string, activeMs: number) => {
    pending = { line, activeMs }
    if (!posting) pumped = pump()
  }

  // Run log: superviseChild writes <logDir>/<runId>.log; ship whatever is new, in capped chunks.
  const logFile = path.join(deps.logDir, `${job.options.runId}.log`)
  let offset = 0
  let shipping = true
  let logChain: Promise<void> = Promise.resolve()
  const shipLog = (): Promise<void> => {
    logChain = logChain.then(async () => {
      while (shipping) {
        const chunk = deps.readFrom(logFile, offset, LOG_CHUNK_LIMIT)
        if (!chunk.length) return
        try {
          const status = await deps.client.log(job, chunk)
          if (status === 413) {
            shipping = false
            deps.log('worker.log_limit', { jobId: job.jobId })
            return
          }
          if (status !== 200) return onStatus(status)
          offset += chunk.length
        } catch {
          return
        }
      }
    })
    return logChain
  }
  const stopLog = deps.every(LOG_POLL_MS, () => void shipLog())

  let body: ResultBody
  try {
    const worktreeRoot = workerWorktreeRoot(job.options.worktreeRoot, deps.config.worktreeRoot)
    const bedrock = await deps.resolveAuth(engine, job.options.runId)
    const common = {
      prompt: job.options.prompt,
      workspaceRoot: deps.config.workspaceRoot,
      worktreeRoot,
      timeoutMs: job.options.timeoutMs,
      stallTimeoutMs: job.options.stallTimeoutMs,
      disableGitSigning: deps.config.disableGitSigning,
      envPassthrough: deps.config.codexEnvPassthrough,
      engineGhToken: deps.config.engineGhToken,
      bedrock,
      registry: deps.registry,
      logDir: deps.logDir,
      runId: job.options.runId,
      log: deps.log,
      onProgress,
    }
    if (engine === 'codex') {
      const o = await deps.runCodex({ ...common, codexBin: deps.config.codexBin, profile: deps.config.codexProfile })
      // The raw final message is not sent: the orchestrator re-validates `result` and needs nothing else.
      body = { ok: true, outcome: { result: o.result, tokensUsed: o.tokensUsed, activeMs: o.activeMs } }
    } else {
      const o = await deps.runClaude({ ...common, claudeBin: deps.config.claudeBin, configDir: deps.config.claudeConfigDir })
      body = { ok: true, outcome: { result: o.result, usage: o.usage, tokensUsed: o.tokensUsed, activeMs: o.activeMs, permissionDenials: o.permissionDenials } }
    }
  } catch (error) {
    body = { ok: false, error: serializeRunError(error) }
  }
  stopBeat()
  stopLog()
  // Ruling F2: the last progress line must reach the orchestrator before the result settles the job,
  // or it is dropped (and a status line like the smoke stub's never shows). Bounded: progress is
  // best-effort and must not hold the result back for long.
  await Promise.race([pumped, deps.sleep(PROGRESS_DRAIN_MS)])
  await shipLog()
  if (lost) {
    deps.log('worker.lost', { jobId: job.jobId })
    return 'lost'
  }
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const status = await deps.client.result(job, body)
      deps.log('worker.result_posted', { jobId: job.jobId, status, ok: body.ok })
      break
    } catch (error) {
      deps.log('worker.result_failed', { attempt, error: redactSecrets(String(error)) })
      await deps.sleep(CLAIM_RETRY_MS)
    }
  }
  return cancelled ? 'cancelled' : 'done'
}
