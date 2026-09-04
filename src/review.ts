// Ties a ReviewRequest to a Codex run. Shared by the Slack daemon and the local CLI so
// both drive exactly the same prompt, profile, and output contract — a review that
// reproduces from the terminal is a review you can debug.

import {
  CodexOutputError,
  CodexStalledError,
  CodexTimeoutError,
  runCodexReview,
  type ChildRegistry,
} from './codex'
import type { ReviewConfig } from './config'
import type { ReviewRequest } from './job'
import type { ActiveReviews } from './progress'
import { buildPrompt } from './prompt'
import { reconcileResults } from './schema'
import { ReviewFailedError, type ReviewOutcome } from './usage'

/** Stable id for a run's log file: one per triggering message. */
export function runIdFor(request: ReviewRequest): string {
  return `${request.message.channel}-${request.message.ts.replace('.', '')}`
}

/** The live-status key for a request — the same channel/ts the dispatcher and cursor use. */
function progressKey(request: ReviewRequest): string {
  return `${request.message.channel}/${request.message.ts}`
}

export function makeReviewRunner(
  config: ReviewConfig,
  /** Daemon log for the run's own events (`codex.frozen`, `codex.stalled`, retries). The CLI passes nothing. */
  log?: (event: string, fields: Record<string, unknown>) => void,
  /** Injection seam so the retry loop is testable without spawning Codex. */
  runCodex: typeof runCodexReview = runCodexReview,
  /** Live-status registry, updated per attempt and per output chunk. The CLI passes nothing. */
  reviews?: ActiveReviews,
  /** Registry of live Codex children, so a shutdown can signal them. The CLI passes nothing. */
  registry?: ChildRegistry
): (request: ReviewRequest) => Promise<ReviewOutcome> {
  return async request => {
    const key = progressKey(request)
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

    // Active time charged across every attempt, not just the last. A stalled attempt still ran
    // for real before it was killed, so a stall-then-success or a give-up must report the sum —
    // reporting only the winning (or final) attempt would understate what the review cost.
    let chargedActiveMs = 0

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      // undefined when the schedule is empty, which disables stall detection in the run.
      const stallTimeoutMs = schedule[attempt]
      const isLast = attempt === attempts - 1
      // A retry is a fresh Codex run in a fresh worktree; a distinct runId keeps its transcript
      // in its own log file rather than appended after the wedged attempt's.
      const runId = attempt === 0 ? baseRunId : `${baseRunId}.retry${attempt}`

      // Reflect the attempt in the live status so a watcher can see a retry in progress.
      reviews?.attempt(key, attempt + 1)

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
          envPassthrough: config.codexEnvPassthrough,
          registry,
          logDir: config.runLogDir,
          runId,
          log,
          onProgress: reviews ? (line, activeMs) => reviews.output(key, line, activeMs) : undefined,
        })
        // Never trust the run to have covered everything it was asked to cover.
        chargedActiveMs += outcome.activeMs
        return {
          result: reconcileResults(urls, outcome.result),
          usage: {
            tokensUsed: outcome.tokensUsed,
            activeMs: chargedActiveMs,
            attempts: attempt + 1,
          },
        }
      } catch (error) {
        // Only a stall is retryable: a timeout has already spent the whole budget, and a crash
        // or bad output will not fix itself on a re-run.
        if (error instanceof CodexStalledError) {
          // Charge this attempt's active time whether or not we retry — a stalled attempt that is
          // then retried still cost the time it ran before the kill.
          chargedActiveMs += error.snapshot.activeMs
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
          // The run is over, but it still spent this much active time across ALL its attempts;
          // carry the sum so the failure thread and the status totals can account for it. A killed
          // run printed no token total, so tokensUsed stays undefined.
          throw new ReviewFailedError(
            { activeMs: chargedActiveMs, attempts },
            new Error(`Codex stalled on every attempt (${attempts}) and was killed for good — ${error.message}`)
          )
        }
        // A timeout is terminal, but it spent its whole budget of active time before the kill —
        // charge it (plus any earlier stalled attempts) rather than reporting no time at all.
        if (error instanceof CodexTimeoutError) {
          chargedActiveMs += error.snapshot.activeMs
          throw new ReviewFailedError({ activeMs: chargedActiveMs, attempts: attempt + 1 }, error)
        }
        // The run completed but its output is unusable. It still printed a token total and spent
        // active time — carry both so a bad-output failure is accounted for, not reported as free.
        if (error instanceof CodexOutputError) {
          chargedActiveMs += error.activeMs
          throw new ReviewFailedError(
            { tokensUsed: error.tokensUsed, activeMs: chargedActiveMs, attempts: attempt + 1 },
            error
          )
        }
        // A crash has no snapshot for this attempt, but any earlier stalled attempts still ran;
        // report their accumulated time when there is some, and undefined when there is none.
        throw new ReviewFailedError(
          { activeMs: chargedActiveMs > 0 ? chargedActiveMs : undefined, attempts: attempt + 1 },
          error
        )
      }
    }

    // The loop always returns a result or throws on the last attempt; this only satisfies the
    // type checker that the function cannot fall through without one.
    throw new Error('review runner exhausted its attempts without producing a result')
  }
}
