// The dual-engine review runner (spec sections 4, 5.3 and 5.8). Per PR: pre-flight, update the
// branch when the base moved (never under require_last_push_approval), pin the head, run both
// engines, confirm the head did not move, skip a SHA the bot already reviewed, post one combined
// review with the approver token, and read the decision back. Implements the same
// `runReview(request)` contract single mode does, so the job, queue and Slack frame are unchanged.

import type { ApproverGitHub, BotReview, PullRequestInfo } from './approver-github'
import type { EngineSchedule } from './config'
import { composeReview, decide, type EnginePass, type GateDecision, type PrOutcome } from './dual-gate'
import type { Engine, EngineRunOutcome } from './engine'
import { runEngines } from './engine-schedule'
import { GhApiError, GH_COMMAND_TIMEOUT_MS } from './gh-api'
import type { ReviewRequest } from './job'
import type { PullRequestRef } from './parse-message'
import { evaluateEligibility, gatherEligibilityFacts, type Eligibility } from './preflight'
import type { ActiveReviews } from './progress'
import type { PullRequestResult } from './schema'
import type { ReviewOutcome, RunUsage } from './usage'

export interface DualPrReport {
  url: string
  outcome: PrOutcome
  pinnedSha?: string
  eligibility?: Eligibility
  /** One per engine, in engine order; empty when the PR never reached the engines. */
  passes: EnginePass[]
  /** Why the PR was blocked or errored outside the engines (pre-flight, update-branch, posting). */
  reason?: string
  reviewUrl?: string
  /** A review by the bot at this SHA already existed, so nothing new was posted. */
  alreadyReviewed?: boolean
  /** Non-fatal notes: a read-back that contradicts the prediction, unreadable diff lines. */
  warnings: string[]
}

export interface DualReport {
  prs: DualPrReport[]
}

export interface DualDeps {
  gh: ApproverGitHub
  /** In ENGINE_ORDER. */
  engines: Engine[]
  schedule: EngineSchedule
  worktreeRoot: string
  /** Changed file names for the pre-flight (spec 5.2: the existing listChangedFiles). */
  listChangedFiles(pr: PullRequestRef): Promise<string[]>
  runIdFor(request: ReviewRequest): string
  log(event: string, fields: Record<string, unknown>): void
  reviews?: ActiveReviews
  /** How long to wait for update-branch to produce a new head (spec 5.3: the gh timeout). */
  updateTimeoutMs?: number
  pollMs?: number
  sleep?(ms: number): Promise<void>
  now?(): number
}

type Prepared =
  | { kind: 'ready'; pr: PullRequestRef; pinnedSha: string; eligibility: Eligibility }
  | { kind: 'blocked'; pr: PullRequestRef; reason: string; eligibility?: Eligibility }

const errText = (error: unknown) => (error instanceof Error ? error.message : String(error))
const short = (sha: string) => sha.slice(0, 7)

/**
 * Run the whole pre-flight for the PR as it stands in `info`. A failure to list changed files
 * cannot be expressed as a fact, so the PR is evaluated with no files and forced to wontCount
 * (spec Q4: a pre-flight that cannot finish is treated as won't count). `rulesReadable` says
 * whether every rule source was read, which the update-branch decision needs.
 */
export async function eligibilityFor(
  deps: Pick<DualDeps, 'gh' | 'listChangedFiles'>,
  pr: PullRequestRef,
  info: PullRequestInfo,
  botLogin: string
): Promise<{ eligibility: Eligibility; rulesReadable: boolean }> {
  let files: string[] | null = null
  try {
    files = await deps.listChangedFiles(pr)
  } catch {
    files = null
  }
  const facts = await gatherEligibilityFacts(deps.gh, pr, info, files ?? [], botLogin)
  const rulesReadable = facts.ruleSources.every(s => s.rules !== null)
  const eligibility = evaluateEligibility(facts)
  if (files === null) {
    return {
      eligibility: { ...eligibility, verdict: 'wontCount', reasons: ['could not verify: changed files', ...eligibility.reasons], missing: [] },
      rulesReadable,
    }
  }
  return { eligibility, rulesReadable }
}

/** Poll until the PR head differs from `oldSha`, or give up after the timeout. */
async function waitForNewHead(deps: DualDeps, pr: PullRequestRef, oldSha: string): Promise<PullRequestInfo | null> {
  const now = deps.now ?? Date.now
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)))
  const deadline = now() + (deps.updateTimeoutMs ?? GH_COMMAND_TIMEOUT_MS)
  while (now() < deadline) {
    await sleep(deps.pollMs ?? 2_000)
    try {
      const info = await deps.gh.getPullRequest(pr)
      if (info.headSha.toLowerCase() !== oldSha.toLowerCase()) return info
    } catch (error) {
      deps.log('dual.update.poll_failed', { pr: pr.url, error: errText(error) })
    }
  }
  return null
}

/** Steps 1-3 of spec section 4: pre-flight, update branch (Q3), pin. */
export async function preparePr(deps: DualDeps, pr: PullRequestRef, botLogin: string): Promise<Prepared> {
  let info: PullRequestInfo
  try {
    info = await deps.gh.getPullRequest(pr)
  } catch (error) {
    deps.log('dual.pr.read_failed', { pr: pr.url, error: errText(error) })
    return { kind: 'blocked', pr, reason: 'could not read the pull request with the role account' }
  }
  if (info.state !== 'open') return { kind: 'blocked', pr, reason: `the pull request is ${info.state}` }

  const first = await eligibilityFor(deps, pr, info, botLogin)
  let eligibility = first.eligibility

  let behind: number | undefined
  try {
    behind = await deps.gh.behindBy(pr, info.base, info.headSha)
  } catch (error) {
    // Unknown: the engines still check the base themselves and report `stale base`.
    deps.log('dual.compare.failed', { pr: pr.url, error: errText(error) })
  }
  if (behind !== undefined && behind > 0) {
    if (eligibility.lastPushApproval) {
      return { kind: 'blocked', pr, eligibility, reason: 'base moved; this repo requires approval of the latest push, so the author must update the branch' }
    }
    if (!first.rulesReadable) {
      // The last-push rule may be in a source we could not read; updating could void a counting
      // approval, so leave the branch to the author.
      return { kind: 'blocked', pr, eligibility, reason: 'base moved, and the branch rules could not all be read, so the bot will not update the branch; the author must update it' }
    }
    let update: Awaited<ReturnType<ApproverGitHub['updateBranch']>>
    try {
      update = await deps.gh.updateBranch(pr, info.headSha)
    } catch (error) {
      const status = error instanceof GhApiError && error.status ? ` (HTTP ${error.status})` : ''
      return { kind: 'blocked', pr, eligibility, reason: `update-branch failed${status}; nothing was posted` }
    }
    if (!update.ok) {
      return {
        kind: 'blocked',
        pr,
        eligibility,
        reason: `update-branch was refused (HTTP ${update.status ?? '?'}): the branch conflicts with its base or its head moved; the author must update the branch`,
      }
    }
    const updated = await waitForNewHead(deps, pr, info.headSha)
    if (!updated) return { kind: 'blocked', pr, eligibility, reason: 'update-branch was accepted, but no new head appeared in time; re-request the review' }
    deps.log('dual.updated', { pr: pr.url, from: info.headSha, to: updated.headSha })
    info = updated
    // Re-run the whole pre-flight against the new head (spec 5.3): the update can dismiss
    // approvals and makes the bot the latest pusher. V3 (who the push is attributed to) is
    // unverified, so this re-run is also what keeps a wrong assumption failing closed.
    eligibility = (await eligibilityFor(deps, pr, info, botLogin)).eligibility
  }
  return { kind: 'ready', pr, pinnedSha: info.headSha.toLowerCase(), eligibility }
}

/**
 * Bot review states that still stand on GitHub. A `DISMISSED` review is excluded: GitHub's own state
 * is authoritative (spec 5.2), a dismissed approval no longer counts, and a re-request is a human
 * asking again, so the bot may post a fresh review at the same SHA. That is not a double approval,
 * because the earlier one is no longer in effect. A `PENDING` review was never submitted.
 */
const STANDING_STATES: ReadonlySet<string> = new Set(['APPROVED', 'COMMENTED', 'CHANGES_REQUESTED'])

/**
 * What to report when a standing bot review already exists at the pinned SHA, so nothing is posted.
 * The outcome must describe what is on GitHub, not what would have been posted. An approval
 * is reported only when an `APPROVED` review stands. If the gate would approve now but the
 * standing review is a comment, for example an earlier `cleanNotCounted` before a permission
 * change, nothing on GitHub approves the PR. That reports as `cleanNotCounted`: both engines
 * are clean, and no counting approval exists.
 */
export function alreadyReviewedOutcome(
  decision: GateDecision,
  standing: BotReview[],
  pinnedSha: string
): { outcome: PrOutcome; reason: string; warnings: string[] } {
  const states = [...new Set(standing.map(r => r.state))].join(', ')
  const approvedStands = standing.some(r => r.state === 'APPROVED')
  const stands = `already reviewed at ${short(pinnedSha)} (${states}); that review stands and nothing new was posted`
  if (decision.event === 'APPROVE' && !approvedStands) {
    return {
      outcome: 'cleanNotCounted',
      reason: `${stands}. No approval exists at this SHA; push a new commit to get one`,
      warnings: [],
    }
  }
  const warnings =
    decision.event === 'COMMENT' && approvedStands
      ? [`an earlier approval by the bot at ${short(pinnedSha)} still stands, although this review found ${decision.outcome === 'findings' ? 'blocking findings' : 'that the approval would not count'}`]
      : []
  return { outcome: decision.outcome, reason: stands, warnings }
}

/** Steps 5-8 of spec section 4: combine, head check, idempotency, post, read-back. */
export async function finishPr(
  deps: DualDeps,
  prepared: Extract<Prepared, { kind: 'ready' }>,
  passes: EnginePass[],
  botLogin: string
): Promise<DualPrReport> {
  const { pr, pinnedSha, eligibility } = prepared
  const report: DualPrReport = { url: pr.url, outcome: 'error', pinnedSha, eligibility, passes, warnings: [] }

  let live: string
  try {
    live = (await deps.gh.getPullRequest(pr)).headSha.toLowerCase()
  } catch (error) {
    deps.log('dual.head.read_failed', { pr: pr.url, error: errText(error) })
    return { ...report, outcome: 'error', reason: 'could not re-read the head after the review; nothing was posted' }
  }
  if (live !== pinnedSha) {
    return { ...report, outcome: 'headMoved', reason: `head moved during review (${short(pinnedSha)} → ${short(live)}); re-request` }
  }

  const decision = decide(passes, eligibility)
  if (!decision.event) return { ...report, outcome: decision.outcome }

  try {
    const earlier = await deps.gh.botReviews(pr, botLogin)
    const standing = earlier.filter(r => r.commitId.toLowerCase() === pinnedSha && STANDING_STATES.has(r.state))
    if (standing.length) return { ...report, ...alreadyReviewedOutcome(decision, standing, pinnedSha), alreadyReviewed: true }
  } catch (error) {
    // Without the check a re-request could double-approve; post nothing instead.
    deps.log('dual.idempotency.failed', { pr: pr.url, error: errText(error) })
    return { ...report, outcome: 'error', reason: 'could not check for an earlier review by the bot; nothing was posted' }
  }

  let commentable = new Map<string, Set<number>>()
  try {
    commentable = await deps.gh.commentableLines(pr)
  } catch (error) {
    deps.log('dual.diff.failed', { pr: pr.url, error: errText(error) })
    report.warnings.push('could not read the diff lines, so every finding is in the review body')
  }
  const { body, comments } = composeReview({ pinnedSha, passes, eligibility, outcome: decision.outcome, commentable })
  try {
    const posted = await deps.gh.postReview(pr, { commitId: pinnedSha, event: decision.event, body, comments })
    report.reviewUrl = posted.url
  } catch (error) {
    const status = error instanceof GhApiError && error.status ? ` (HTTP ${error.status})` : ''
    deps.log('dual.post.failed', { pr: pr.url, event: decision.event, status: error instanceof GhApiError ? error.status : undefined })
    return { ...report, outcome: 'error', reason: `posting the review failed${status}` }
  }

  if (decision.event === 'APPROVE') {
    try {
      const d = await deps.gh.decision(pr)
      const state = `reviewDecision ${d.reviewDecision ?? 'none'}, mergeStateStatus ${d.mergeStateStatus}`
      // reviewDecision is null when the branch requires no review, which agrees with `counts`.
      const blocking = d.reviewDecision === 'REVIEW_REQUIRED' || d.reviewDecision === 'CHANGES_REQUESTED'
      if (eligibility.verdict === 'counts' && blocking) {
        report.warnings.push(`pre-flight predicted the approval counts, but GitHub reports ${state}`)
      } else if (eligibility.verdict === 'partial' && d.reviewDecision === 'APPROVED') {
        report.warnings.push(`pre-flight predicted more approvals were needed, but GitHub reports ${state}`)
      }
    } catch (error) {
      deps.log('dual.readback.failed', { pr: pr.url, error: errText(error) })
      report.warnings.push('could not read back reviewDecision after approving')
    }
  }
  return { ...report, outcome: decision.outcome }
}

/** Sum the engines' usage; per-engine figures stay in `engines`. */
export function combineUsage(outcomes: EngineRunOutcome[]): RunUsage {
  const tokens = outcomes.map(o => o.usage.tokensUsed).filter((t): t is number => t !== undefined)
  const active = outcomes.map(o => o.usage.activeMs).filter((t): t is number => t !== undefined)
  return {
    tokensUsed: tokens.length ? tokens.reduce((a, b) => a + b, 0) : undefined,
    activeMs: active.length ? active.reduce((a, b) => a + b, 0) : undefined,
    attempts: outcomes.reduce((max, o) => Math.max(max, o.usage.attempts), 0),
    engines: outcomes.map(o => ({ engine: o.engine, usage: o.usage })),
  }
}

/** The v1-shaped result, so logs and the CLI keep a familiar summary of a dual run. */
function legacyResult(report: DualPrReport): PullRequestResult {
  const passed = report.outcome === 'approved' || report.outcome === 'approvedPartial' || report.outcome === 'cleanNotCounted'
  return {
    url: report.url,
    status: passed ? 'passed' : report.outcome === 'findings' ? 'findings' : 'blocked',
    summary: report.reason ?? report.passes.map(p => `${p.engine}: ${p.detail}`).join(' · '),
    pushedTestCommits: false,
    reviewUrl: report.reviewUrl ?? '',
  }
}

export function makeDualReviewRunner(deps: DualDeps): (request: ReviewRequest) => Promise<ReviewOutcome> {
  return async request => {
    const runId = deps.runIdFor(request)
    const key = `${request.message.channel}/${request.message.ts}`
    const reports = new Map<string, DualPrReport>()
    let outcomes: EngineRunOutcome[] = []

    let botLogin: string | undefined
    try {
      botLogin = await deps.gh.login()
    } catch (error) {
      deps.log('dual.login.failed', { runId, error: errText(error) })
    }
    if (!botLogin) {
      for (const pr of request.prs) {
        reports.set(pr.url, { url: pr.url, outcome: 'error', passes: [], warnings: [], reason: 'could not authenticate as the role account (APPROVER_GH_TOKEN)' })
      }
    } else {
      const prepared: Prepared[] = []
      for (const pr of request.prs) prepared.push(await preparePr(deps, pr, botLogin))
      const ready = prepared.filter((p): p is Extract<Prepared, { kind: 'ready' }> => p.kind === 'ready')
      for (const p of prepared) {
        if (p.kind === 'blocked') reports.set(p.pr.url, { url: p.pr.url, outcome: 'blocked', eligibility: p.eligibility, passes: [], warnings: [], reason: p.reason })
      }
      if (ready.length) {
        const run = await runEngines(deps.engines, deps.schedule, {
          prs: ready.map(r => ({ ref: r.pr, pinnedSha: r.pinnedSha })),
          instructions: request.instructions,
          requestedBy: request.requestedBy,
          runId,
          worktreeRoot: deps.worktreeRoot,
          onProgress: deps.reviews ? (line, activeMs) => deps.reviews!.output(key, line, activeMs) : undefined,
        })
        outcomes = run.outcomes
        for (const r of ready) reports.set(r.pr.url, await finishPr(deps, r, run.passes.get(r.pr.url) ?? [], botLogin))
      }
    }

    const prs = request.prs.map(pr => reports.get(pr.url)!)
    deps.log('dual.done', { runId, outcomes: prs.map(r => `${r.url}=${r.outcome}`) })
    return { result: { results: prs.map(legacyResult) }, usage: combineUsage(outcomes), dual: { prs } }
  }
}
