// Ties a ReviewRequest to a Codex run. Shared by the Slack daemon and the local CLI so
// both drive exactly the same prompt, profile, and output contract — a review that
// reproduces from the terminal is a review you can debug.

import { runCodexReview } from './codex'
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
  /** Daemon log for the run's own events (`codex.frozen`). The CLI passes nothing. */
  log?: (event: string, fields: Record<string, unknown>) => void
): (request: ReviewRequest) => Promise<ReviewRunResult> {
  return async request => {
    const prompt = buildPrompt({
      prs: request.prs,
      instructions: request.instructions,
      worktreeRoot: config.worktreeRoot,
      requestedBy: request.requestedBy,
    })
    const outcome = await runCodexReview({
      prompt,
      codexBin: config.codexBin,
      profile: config.codexProfile,
      workspaceRoot: config.workspaceRoot,
      worktreeRoot: config.worktreeRoot,
      timeoutMs: config.runTimeoutMs,
      disableGitSigning: config.disableGitSigning,
      logDir: config.runLogDir,
      runId: runIdFor(request),
      log,
    })
    // Never trust the run to have covered everything it was asked to cover.
    return reconcileResults(request.prs.map(pr => pr.url), outcome.result)
  }
}
