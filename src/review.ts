// Ties a ReviewRequest to a Codex run. Shared by the Slack daemon and the local CLI so
// both drive exactly the same prompt, profile, and output contract — a review that
// reproduces from the terminal is a review you can debug.

import { CodexStalledError, runCodexReview } from './codex'
import type { ReviewConfig } from './config'
import type { ReviewRequest } from './job'
import { buildPrompt } from './prompt'
import { reconcileResults, type ReviewRunResult } from './schema'

/** Stable id for a run's log file: one per triggering message. */
export function runIdFor(request: ReviewRequest): string {
  return `${request.message.channel}-${request.message.ts.replace('.', '')}`
}

export function makeReviewRunner(
  config: ReviewConfig,
  /** Daemon log for the run's own events (`codex.frozen`, `codex.stalled`, retries). The CLI passes nothing. */
  log?: (event: string, fields: Record<string, unknown>) => void,
  /** Injection seam so the retry loop is testable without spawning Codex. */
  runCodex: typeof runCodexReview = runCodexReview
): (request: ReviewRequest) => Promise<ReviewRunResult> {
  return async request => {
    const prompt = buildPrompt({
      prs: request.prs,
      instructions: request.instructions,
      worktreeRoot: config.worktreeRoot,
      requestedBy: request.requestedBy,
    })
    const urls = request.prs.map(pr => pr.url)
    const baseRunId = runIdFor(request)
    // An empty schedule means stall handling is off: one plain run, no output deadline, no
    // retries — restoring the pre-stall behaviour for anyone who sets STALL_BACKOFF_MS empty.
    const schedule = config.stallBackoffMs
    const attempts = schedule.length > 0 ? schedule.length : 1

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      // undefined when the schedule is empty, which disables stall detection in the run.
      const stallTimeoutMs = schedule[attempt]
      const isLast = attempt === attempts - 1
      // A retry is a fresh Codex run in a fresh worktree; a distinct runId keeps its transcript
      // in its own log file rather than appended after the wedged attempt's.
      const runId = attempt === 0 ? baseRunId : `${baseRunId}.retry${attempt}`

      try {
        const outcome = await runCodex({
          prompt,
          codexBin: config.codexBin,
          profile: config.codexProfile,
          workspaceRoot: config.workspaceRoot,
          worktreeRoot: config.worktreeRoot,
          timeoutMs: config.runTimeoutMs,
          stallTimeoutMs,
          disableGitSigning: config.disableGitSigning,
          logDir: config.runLogDir,
          runId,
          log,
        })
        // Never trust the run to have covered everything it was asked to cover.
        return reconcileResults(urls, outcome.result)
      } catch (error) {
        // Only a stall is retryable: a timeout has already spent the whole budget, and a crash
        // or bad output will not fix itself on a re-run.
        if (error instanceof CodexStalledError) {
          if (!isLast) {
            log?.('review.retry', {
              runId: baseRunId,
              prs: urls,
              attempt: attempt + 1,
              of: attempts,
              stalledAfterMs: stallTimeoutMs,
              nextStallMs: schedule[attempt + 1],
            })
            continue
          }
          log?.('review.gave-up', { runId: baseRunId, prs: urls, attempts })
          throw new Error(
            `Codex stalled on every attempt (${attempts}) and was killed for good — ${error.message}`
          )
        }
        throw error
      }
    }

    // The loop always returns a result or throws on the last attempt; this only satisfies the
    // type checker that the function cannot fall through without one.
    throw new Error('review runner exhausted its attempts without producing a result')
  }
}
