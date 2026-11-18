// Approval-eligibility pre-flight (spec section 5.2). The evaluator is pure: given facts about a
// PR, it predicts whether an approval from the role account would satisfy the base branch's
// rules. The fetch layer that gathers the facts is at the bottom of this file.

import type { ApproverGitHub, LatestPush, Permission, PullRequestInfo, ReviewFact } from './approver-github'
import { ownersFor, parseCodeowners, unsupportedLines } from './codeowners'
import type { PullRequestRef } from './parse-message'

export type EligibilityVerdict = 'counts' | 'partial' | 'wontCount'
export interface Eligibility { verdict: EligibilityVerdict; reasons: string[]; missing: string[]; lastPushApproval: boolean; dismissStale: boolean }
export interface PullRequestRules { requiredApprovals: number; requireCodeOwnerReview: boolean; requireLastPushApproval: boolean; dismissStaleReviews: boolean }
export interface EligibilityFacts {
  botLogin: string
  prAuthor: string
  changedFiles: string[]
  botPermission: Permission | null                         // null = unreadable
  ruleSources: { name: string; rules: PullRequestRules | null }[]   // rules null = unreadable source
  codeowners: string | null                                 // '' = no file; null = unreadable
  codeownersErrors: number | null                           // null = unreadable
  reviews: ReviewFact[] | null                              // null = unreadable
  reviewerPermissions: Record<string, Permission | null>   // keyed by lower-case login
  teamMembership: Record<string, boolean | null>           // key `${team lower}|${login lower}`, e.g. '@acme/pay|role-bot'
  latestPush: LatestPush | null                            // null = unreadable or not needed (see rule 7)
}

export const NO_RULES: PullRequestRules = {
  requiredApprovals: 0,
  requireCodeOwnerReview: false,
  requireLastPushApproval: false,
  dismissStaleReviews: false,
}

const WRITE_OR_ABOVE: ReadonlySet<string> = new Set(['admin', 'maintain', 'write'])
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

export function mergeRules(all: PullRequestRules[]): PullRequestRules {
  return all.reduce(
    (acc, r) => ({
      requiredApprovals: Math.max(acc.requiredApprovals, r.requiredApprovals),
      requireCodeOwnerReview: acc.requireCodeOwnerReview || r.requireCodeOwnerReview,
      requireLastPushApproval: acc.requireLastPushApproval || r.requireLastPushApproval,
      dismissStaleReviews: acc.dismissStaleReviews || r.dismissStaleReviews,
    }),
    NO_RULES
  )
}

type Params = Record<string, unknown>
const num = (v: unknown) => (typeof v === 'number' ? v : 0)
const bool = (v: unknown) => v === true

export function rulesFromRulesets(rules: unknown[]): PullRequestRules {
  return mergeRules(
    rules
      .filter((r): r is { type: string; parameters?: Params } => (r as { type?: string })?.type === 'pull_request')
      .map(r => {
        const p = r.parameters ?? {}
        return {
          requiredApprovals: num(p.required_approving_review_count),
          requireCodeOwnerReview: bool(p.require_code_owner_review),
          requireLastPushApproval: bool(p.require_last_push_approval),
          dismissStaleReviews: bool(p.dismiss_stale_reviews_on_push),
        }
      })
  )
}

export function rulesFromClassic(protection: unknown | null): PullRequestRules {
  const reviews = (protection as { required_pull_request_reviews?: Params } | null)?.required_pull_request_reviews
  if (!reviews) return NO_RULES
  return {
    requiredApprovals: num(reviews.required_approving_review_count),
    requireCodeOwnerReview: bool(reviews.require_code_owner_reviews),
    requireLastPushApproval: bool(reviews.require_last_push_approval),
    dismissStaleReviews: bool(reviews.dismiss_stale_reviews),
  }
}

/** Whether `login` is one of `owners`, directly or through an active team membership. */
function ownedBy(owners: string[], login: string, membership: EligibilityFacts['teamMembership']): boolean | null {
  let unknown = false
  for (const owner of owners) {
    if (!owner.startsWith('@')) continue // email owners cannot be resolved; never counted
    if (owner.includes('/')) {
      const member = membership[`${owner.toLowerCase()}|${login.toLowerCase()}`]
      if (member === true) return true
      if (member === null || member === undefined) unknown = true
    } else if (same(owner.slice(1), login)) {
      return true
    }
  }
  return unknown ? null : false
}

const MAX_LISTED_PATHS = 5

export function evaluateEligibility(f: EligibilityFacts): Eligibility {
  const unreadable: string[] = []
  if (f.ruleSources.length === 0) unreadable.push('rule sources (none were read)')
  for (const source of f.ruleSources) if (!source.rules) unreadable.push(source.name)
  const rules = mergeRules(f.ruleSources.flatMap(s => (s.rules ? [s.rules] : [])))
  const base = { lastPushApproval: rules.requireLastPushApproval, dismissStale: rules.dismissStaleReviews }
  const wont = (reasons: string[]): Eligibility => ({ verdict: 'wontCount', reasons, missing: [], ...base })

  // Rule 3: bot validity. These are definitive even if other sources are unreadable.
  const invalid: string[] = []
  if (same(f.botLogin, f.prAuthor)) invalid.push('the bot account authored this PR')
  if (f.botPermission && !WRITE_OR_ABOVE.has(f.botPermission)) {
    invalid.push(`the bot account has ${f.botPermission} permission; a counting approval needs write or higher`)
  }
  if (rules.requireLastPushApproval && f.latestPush && same(f.latestPush.actor, f.botLogin)) {
    invalid.push('the bot account made the latest push, and this branch requires the latest push to be approved by someone else')
  }
  if (invalid.length) return wont(invalid)

  // Rule 7: everything the remaining rules need must be readable.
  if (f.botPermission === null) unreadable.push('bot permission')
  if (f.reviews === null) unreadable.push('PR reviews')
  if (rules.requireLastPushApproval && !f.latestPush) unreadable.push('latest pusher')
  if (rules.requireCodeOwnerReview) {
    if (f.codeowners === null) unreadable.push('CODEOWNERS')
    if (f.codeownersErrors === null) unreadable.push('CODEOWNERS errors')
    else if (f.codeownersErrors > 0) unreadable.push(`CODEOWNERS (${f.codeownersErrors} error(s) reported by GitHub)`)
    if (f.codeowners) {
      const lines = unsupportedLines(parseCodeowners(f.codeowners))
      if (lines.length) unreadable.push(`CODEOWNERS syntax this tool does not support on line(s) ${lines.join(', ')}`)
    }
  }

  // Rule 2: eligible existing approvals.
  const approvals: ReviewFact[] = []
  const seenApprovers = new Set<string>()
  const changeRequesters: string[] = []
  const seenRequesters = new Set<string>()
  const needsReviews = rules.requiredApprovals > 0 || rules.requireCodeOwnerReview
  for (const r of f.reviews ?? []) {
    if (r.state === 'CHANGES_REQUESTED' && needsReviews && !same(r.login, f.botLogin) && !seenRequesters.has(r.login.toLowerCase())) {
      // An outstanding change request blocks merge; only a write-or-higher reviewer's counts.
      const perm = f.reviewerPermissions[r.login.toLowerCase()]
      if (perm === null || perm === undefined) unreadable.push(`permission of ${r.login}`)
      else if (WRITE_OR_ABOVE.has(perm)) {
        seenRequesters.add(r.login.toLowerCase())
        changeRequesters.push(r.login)
      }
      continue
    }
    if (r.state !== 'APPROVED' || same(r.login, f.botLogin) || same(r.login, f.prAuthor)) continue
    if (seenApprovers.has(r.login.toLowerCase())) continue
    const permission = f.reviewerPermissions[r.login.toLowerCase()]
    if (permission === null || permission === undefined) {
      unreadable.push(`permission of ${r.login}`)
      continue
    }
    if (WRITE_OR_ABOVE.has(permission)) {
      seenApprovers.add(r.login.toLowerCase())
      approvals.push(r)
    }
  }

  // Rule 4: owner coverage.
  type OwnerPath = { path: string; owners: string[]; byOthers: boolean; byBot: boolean }
  const ownerPaths: OwnerPath[] = []
  if (rules.requireCodeOwnerReview && f.codeowners !== null) {
    const parsed = parseCodeowners(f.codeowners)
    for (const path of f.changedFiles) {
      const owners = ownersFor(parsed, path)
      if (!owners || owners.length === 0) continue
      const others = approvals.map(a => ownedBy(owners, a.login, f.teamMembership))
      const bot = ownedBy(owners, f.botLogin, f.teamMembership)
      if (bot === null || others.some(o => o === null)) unreadable.push(`team membership for ${owners.join(' ')}`)
      ownerPaths.push({ path, owners, byOthers: others.some(o => o === true), byBot: bot === true })
    }
  }

  if (unreadable.length) return wont([...new Set(unreadable)].map(u => `could not verify: ${u}`))

  // Rule 5: remaining requirements with and without the bot.
  const shortfallWithout = Math.max(0, rules.requiredApprovals - approvals.length)
  const shortfallWith = Math.max(0, rules.requiredApprovals - approvals.length - 1)
  const unsatisfiedWithout = ownerPaths.filter(p => !p.byOthers)
  const unsatisfiedWith = unsatisfiedWithout.filter(p => !p.byBot)
  const lastPushSatisfiedWithout =
    !rules.requireLastPushApproval ||
    approvals.some(a => f.latestPush && !same(a.login, f.latestPush.actor) && Date.parse(a.submittedAt) > Date.parse(f.latestPush.at))

  const missing: string[] = []
  if (shortfallWith > 0) missing.push(`${shortfallWith} more approval${shortfallWith === 1 ? '' : 's'}`)
  const byOwners = new Map<string, string[]>()
  for (const p of unsatisfiedWith) byOwners.set(p.owners.join(' or '), [...(byOwners.get(p.owners.join(' or ')) ?? []), p.path])
  for (const [owners, paths] of byOwners) {
    const shown = paths.slice(0, MAX_LISTED_PATHS).join(', ')
    const more = paths.length > MAX_LISTED_PATHS ? ` and ${paths.length - MAX_LISTED_PATHS} more` : ''
    missing.push(`${owners} for ${shown}${more}`)
  }

  for (const login of changeRequesters) missing.push(`changes requested by @${login}`)

  // Rule 6: verdict.
  if (missing.length === 0) return { verdict: 'counts', reasons: [], missing: [], ...base }
  const changeReasons = changeRequesters.map(l => `changes requested by @${l} must be resolved or dismissed; an approval from the bot cannot clear it`)
  const reduced =
    shortfallWith < shortfallWithout || unsatisfiedWith.length < unsatisfiedWithout.length || !lastPushSatisfiedWithout
  if (reduced) return { verdict: 'partial', reasons: ['the bot approval satisfies some but not all requirements', ...changeReasons], missing, ...base }
  return { verdict: 'wontCount', reasons: ['the bot approval would not satisfy any remaining requirement', ...changeReasons], missing, ...base }
}

/** Where GitHub looks for CODEOWNERS, in its order of precedence. */
export const CODEOWNERS_PATHS = ['.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS'] as const

/** Resolve a read to its value, or null when it fails; the evaluator reports null as unreadable. */
async function attempt<T>(read: () => Promise<T>): Promise<T | null> {
  try {
    return await read()
  } catch {
    return null
  }
}

/**
 * Gather every fact `evaluateEligibility` needs, with the approver token, read-only. Never
 * rejects: a failed read becomes null and is reported as unreadable by the evaluator.
 */
export async function gatherEligibilityFacts(
  gh: ApproverGitHub,
  pr: PullRequestRef,
  info: PullRequestInfo,
  changedFiles: string[],
  botLogin: string
): Promise<EligibilityFacts> {
  const [rulesets, classic, botPermission, reviews] = await Promise.all([
    attempt(() => gh.branchRules(pr, info.base)),
    attempt(async () => rulesFromClassic(await gh.classicProtection(pr, info.base))),
    attempt(() => gh.permission(pr, botLogin)),
    attempt(() => gh.reviews(pr)),
  ])
  const ruleSources = [
    { name: 'rulesets', rules: rulesets === null ? null : rulesFromRulesets(rulesets) },
    { name: 'classic protection', rules: classic },
  ]
  const rules = mergeRules(ruleSources.flatMap(s => (s.rules ? [s.rules] : [])))

  // CODEOWNERS: the first file that exists, read from the base branch.
  let codeowners: string | null = ''
  if (rules.requireCodeOwnerReview) {
    for (const candidate of CODEOWNERS_PATHS) {
      // fileAt resolves null for a missing file (try the next location) and rejects on any other
      // failure (CODEOWNERS unreadable). Not wrapped in attempt(), which would conflate the two.
      try {
        const text = await gh.fileAt(pr, candidate, info.base)
        if (text === null) continue
        codeowners = text
      } catch {
        codeowners = null
      }
      break
    }
  }
  const codeownersErrors = rules.requireCodeOwnerReview ? await attempt(() => gh.codeownersErrorCount(pr, info.base)) : 0

  // Permissions of every other reviewer whose review the evaluator weighs: approvers (do they
  // count?) and change requesters (does the request block?). The bot's own reviews are excluded.
  const approvers = (reviews ?? []).filter(r => r.state === 'APPROVED')
  const reviewerLogins = new Map<string, string>()
  for (const r of reviews ?? []) {
    if ((r.state === 'APPROVED' || r.state === 'CHANGES_REQUESTED') && r.login.toLowerCase() !== botLogin.toLowerCase()) {
      reviewerLogins.set(r.login.toLowerCase(), r.login)
    }
  }
  const reviewerPermissions: Record<string, Permission | null> = {}
  await Promise.all(
    [...reviewerLogins].map(async ([key, login]) => {
      reviewerPermissions[key] = await attempt(() => gh.permission(pr, login))
    })
  )

  // Team membership: only teams that own a changed path, for the bot and each approver.
  const teamMembership: Record<string, boolean | null> = {}
  if (rules.requireCodeOwnerReview && codeowners) {
    const parsed = parseCodeowners(codeowners)
    const teams = new Set<string>()
    for (const file of changedFiles) for (const owner of ownersFor(parsed, file) ?? []) if (owner.startsWith('@') && owner.includes('/')) teams.add(owner)
    const candidates = [botLogin, ...approvers.map(a => a.login)]
    await Promise.all(
      [...teams].flatMap(team =>
        candidates.map(async login => {
          const [org, slug] = team.slice(1).split('/')
          teamMembership[`${team.toLowerCase()}|${login.toLowerCase()}`] = await attempt(() => gh.isTeamMember(org, slug, login))
        })
      )
    )
  }

  // Latest pusher: needed only under the last-push rule; unreadable for a fork head or a stale record.
  let latestPush: LatestPush | null = null
  if (rules.requireLastPushApproval && info.headRepo === info.baseRepo) {
    const push = await attempt(() => gh.latestPush(pr, info.headRef))
    latestPush = push && push.afterSha === info.headSha ? push : null
  }

  return {
    botLogin,
    prAuthor: info.author,
    changedFiles,
    botPermission,
    ruleSources,
    codeowners,
    codeownersErrors,
    reviews,
    reviewerPermissions,
    teamMembership,
    latestPush,
  }
}
