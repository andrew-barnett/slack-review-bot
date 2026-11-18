// The dual-engine gate (spec 5.8), as pure functions: each engine's pass state for a PR, the
// decision table that turns the passes and the pre-flight into what to post, and the combined
// review body and inline comments. The orchestrator in dual.ts does the I/O around these.

import { withAgentNote } from './agent-note'
import type { ReviewComment } from './approver-github'
import type { EngineName } from './config'
import type { EngineRunOutcome } from './engine'
import type { Eligibility } from './preflight'
import type { EnginePrResult, Finding } from './schema'

export type PassState = 'clean' | 'findings' | 'blocked' | 'invalid' | 'skipped'

export interface EnginePass {
  engine: EngineName
  state: PassState
  /** One short phrase for Slack and the review body, e.g. "2 blocking" or "skipped (Codex not clean)". */
  detail: string
  /** The engine's result for this PR, when it produced one. */
  result?: EnginePrResult
}

export type PrOutcome = 'approved' | 'approvedPartial' | 'cleanNotCounted' | 'findings' | 'blocked' | 'error' | 'headMoved'

export interface GateDecision {
  /** What to post; null posts nothing. */
  event: 'APPROVE' | 'COMMENT' | null
  outcome: PrOutcome
}

export const ENGINE_LABEL: Record<EngineName, string> = { codex: 'Codex', claude: 'Claude' }

const shortSha = (sha: string) => (sha ? sha.slice(0, 7) : '(none)')
const oneLine = (text: string, max = 200) => {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

function counts(findings: Finding[]): { blocking: number; nonBlocking: number } {
  const blocking = findings.filter(f => f.severity === 'blocking').length
  return { blocking, nonBlocking: findings.length - blocking }
}

/**
 * One engine's pass state for one PR (spec 5.8, first table). A blocked verdict is read before
 * the SHA check because the skill reports a blocked PR's found head, not the pinned one.
 */
export function passFor(outcome: EngineRunOutcome, url: string, pinnedSha: string): EnginePass {
  const engine = outcome.engine
  if (outcome.error) return { engine, state: 'invalid', detail: `error: ${oneLine(outcome.error)}` }
  const result = outcome.results.find(r => r.url.toLowerCase() === url.toLowerCase())
  if (!result) return { engine, state: 'invalid', detail: 'invalid: no result for this pull request' }
  if (result.environmentProblems.length > 0) {
    return { engine, state: 'invalid', detail: `invalid: ${oneLine(result.environmentProblems.join('; '))}`, result }
  }
  if (result.verdict === 'blocked') {
    return { engine, state: 'blocked', detail: `blocked: ${oneLine(result.summary) || 'no reason given'}`, result }
  }
  if (result.reviewedSha.toLowerCase() !== pinnedSha.toLowerCase()) {
    return {
      engine,
      state: 'invalid',
      detail: `invalid: reviewed ${shortSha(result.reviewedSha)} instead of ${shortSha(pinnedSha)}`,
      result,
    }
  }
  const { blocking, nonBlocking } = counts(result.findings)
  const extra = nonBlocking ? `, ${nonBlocking} non-blocking` : ''
  if (result.verdict === 'findings') return { engine, state: 'findings', detail: `${blocking} blocking${extra}`, result }
  return { engine, state: 'clean', detail: nonBlocking ? `clean (${nonBlocking} non-blocking)` : 'clean', result }
}

/** The pass for an engine serial mode did not run, because `earlier` was not clean. */
export function skippedPass(engine: EngineName, earlier: EngineName): EnginePass {
  return { engine, state: 'skipped', detail: `skipped (${ENGINE_LABEL[earlier]} not clean)` }
}

/**
 * The per-PR decision (spec 5.8, second table), for a head already confirmed unchanged. Every
 * APPROVE needs every configured engine clean; a skipped engine is never clean.
 */
export function decide(passes: EnginePass[], eligibility: Eligibility): GateDecision {
  if (passes.length === 0) return { event: null, outcome: 'error' }
  const has = (state: PassState) => passes.some(p => p.state === state)
  if (has('findings')) return { event: 'COMMENT', outcome: 'findings' }
  if (has('blocked')) return { event: null, outcome: 'blocked' }
  // A "one engine clean" comment would read as half an approval, so an invalid pass posts nothing.
  if (has('invalid') || has('skipped')) return { event: null, outcome: 'error' }
  if (eligibility.verdict === 'counts') return { event: 'APPROVE', outcome: 'approved' }
  if (eligibility.verdict === 'partial') return { event: 'APPROVE', outcome: 'approvedPartial' }
  return { event: 'COMMENT', outcome: 'cleanNotCounted' }
}

/** GitHub caps a review body and each comment at 65,536 characters; stay well under it. */
export const MAX_GITHUB_TEXT = 60_000

function cap(text: string): string {
  return text.length > MAX_GITHUB_TEXT ? `${text.slice(0, MAX_GITHUB_TEXT)}\n\n_(truncated)_` : text
}

function tag(engine: EngineName, finding: Finding): string {
  return `**[${ENGINE_LABEL[engine]} · ${finding.severity === 'blocking' ? 'BLOCKING' : 'NON-BLOCKING'}]**`
}

const VERDICT_TEXT: Record<Eligibility['verdict'], string> = { counts: 'counts', partial: 'partial', wontCount: "won't count" }

const HEADLINE: Record<PrOutcome, string> = {
  approved: 'Both engines are clean. Approved.',
  approvedPartial: 'Both engines are clean. Approved; this approval does not satisfy every requirement on its own.',
  cleanNotCounted: "Both engines are clean, but an approval from this account would not satisfy this PR's rules, so this is a comment, not an approval.",
  findings: 'Findings. Not approved.',
  blocked: 'Not reviewed.',
  error: 'Not approved: an engine did not complete a valid review.',
  headMoved: 'The head moved during the review; nothing was approved.',
}

export interface ComposeInput {
  pinnedSha: string
  passes: EnginePass[]
  eligibility: Eligibility
  outcome: PrOutcome
  /** Commentable new-side lines per file (approver-github `commentableLines`). */
  commentable: Map<string, Set<number>>
}

/**
 * The one combined review (spec 5.8): the pinned SHA, a line per engine, the pre-flight with its
 * reasons and missing items, findings that cannot be anchored, the name of any engine that failed,
 * and the hidden no-mention note. Every finding from a valid engine (clean or findings) is posted;
 * nothing is deduplicated by meaning.
 */
export function composeReview(input: ComposeInput): { body: string; comments: ReviewComment[] } {
  const { pinnedSha, passes, eligibility, outcome, commentable } = input
  const lines: string[] = [`**Dual-engine review at \`${pinnedSha}\`.** ${HEADLINE[outcome]}`, '']
  lines.push(passes.map(p => `${ENGINE_LABEL[p.engine]}: ${p.detail}`).join(' · '), '')
  lines.push(`Pre-flight: ${VERDICT_TEXT[eligibility.verdict]}.`)
  for (const reason of eligibility.reasons) lines.push(`- ${reason}`)
  if (eligibility.missing.length) {
    lines.push('', 'Still needed:')
    for (const item of eligibility.missing) lines.push(`- ${item}`)
  }
  for (const failed of passes.filter(p => p.state === 'invalid')) {
    lines.push('', `${ENGINE_LABEL[failed.engine]} did not complete a valid review (${failed.detail}), so this review cannot approve.`)
  }

  const comments: ReviewComment[] = []
  for (const pass of passes) {
    if ((pass.state !== 'clean' && pass.state !== 'findings') || !pass.result) continue
    const unanchored: string[] = []
    for (const finding of pass.result.findings) {
      const anchored = finding.file !== '' && finding.line > 0 && commentable.get(finding.file)?.has(finding.line)
      if (anchored) {
        comments.push({ path: finding.file, line: finding.line, side: 'RIGHT', body: withAgentNote(cap(`${tag(pass.engine, finding)} ${finding.body}`)) })
      } else {
        const where = finding.file ? `\`${finding.file}${finding.line > 0 ? `:${finding.line}` : ''}\` ` : ''
        unanchored.push(`- ${tag(pass.engine, finding)} ${where}${finding.body}`)
      }
    }
    if (unanchored.length) lines.push('', `### ${ENGINE_LABEL[pass.engine]}`, ...unanchored)
  }
  return { body: withAgentNote(cap(lines.join('\n'))), comments }
}
