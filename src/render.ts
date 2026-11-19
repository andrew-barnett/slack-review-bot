// Rendering the review outcome into the Slack thread reply.
//
// Slack mrkdwn, not Markdown: labelled links are `<url|text>` and bullets are literal
// `•`. That syntax only renders for messages posted through the API, which is what the
// bot does — a report meant to be pasted by hand would need `[text](url)` instead.

import type { DualPrReport, DualReport } from './dual'
import { ENGINE_LABEL, type PrOutcome } from './dual-gate'
import type { PullRequestResult, ReviewRunResult } from './schema'

/** Which terminal reaction the outcome earns. */
export type Verdict = 'pass' | 'findings'

/**
 * A run passes only when every PR passed.
 *
 * `blocked` counts as not-passing: a PR nobody could review is not a PR that cleared
 * review, and stamping it :approved_stamp: would quietly claim otherwise.
 */
export function verdictFor(result: ReviewRunResult): Verdict {
  if (result.results.length === 0) return 'findings'
  return result.results.every(r => r.status === 'passed') ? 'pass' : 'findings'
}

/** github.com/o/r/pull/1 -> "o/r#1", falling back to the raw URL. */
export function shortLabel(url: string): string {
  const match = /github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/i.exec(url)
  return match ? `${match[1]}/${match[2]}#${match[3]}` : url
}

function link(result: PullRequestResult): string {
  return `<${result.url}|${shortLabel(result.url)}>`
}

/**
 * Neutralise Slack control syntax in untrusted text (engine output, GitHub-derived strings), so
 * `<!channel>`, `<@U1>` or `<url|label>` cannot ping people or spoof links. `&` goes first so the
 * entities this adds are not themselves re-escaped.
 */
export function escapeSlack(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** Trim a model-written summary to a single sentence for the thread. */
export function oneSentence(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim()
  if (!collapsed) return ''
  // Cut at the first sentence end that is followed by more prose, so "v1.2. Also …"
  // becomes "v1.2." only when something actually follows.
  const match = /^(.*?[.!?])(\s+\S)/.exec(collapsed)
  const first = match ? match[1] : collapsed
  return first.length > 300 ? `${first.slice(0, 297).trimEnd()}…` : first
}

function bulletsFor(results: PullRequestResult[], withSummary: boolean): string {
  return results
    .map(result => {
      const summary = withSummary ? escapeSlack(oneSentence(result.summary)) : ''
      const reviewLink = result.reviewUrl ? ` <${result.reviewUrl}|(review)>` : ''
      return summary ? `• ${link(result)} — ${summary}${reviewLink}` : `• ${link(result)}${reviewLink}`
    })
    .join('\n')
}

/** The thread reply posted when at least one PR did not pass. */
export function renderThread(result: ReviewRunResult): string {
  const passed = result.results.filter(r => r.status === 'passed')
  const findings = result.results.filter(r => r.status === 'findings')
  const blocked = result.results.filter(r => r.status === 'blocked')

  const total = result.results.length
  const sections: string[] = [
    `Reviewed ${total} pull request${total === 1 ? '' : 's'}.`,
  ]

  if (findings.length) {
    sections.push(`*Findings (${findings.length})*\n${bulletsFor(findings, true)}`)
  }
  if (blocked.length) {
    sections.push(
      `*Not reviewed (${blocked.length})*\n${bulletsFor(blocked, true)}`
    )
  }
  if (passed.length) {
    sections.push(`*No findings (${passed.length})*\n${bulletsFor(passed, false)}`)
  }

  // Disclosure, not decoration: the bot signs nothing, because unattended GPG signing
  // would block on a pinentry dialog. Anyone looking at an unexpected unsigned commit
  // on their branch should be able to find out why from the thread that caused it.
  if (result.results.some(r => r.pushedTestCommits)) {
    sections.push('_Regression-test commits were pushed to the PR branches, unsigned._')
  }

  return sections.join('\n\n')
}

/** The thread reply posted when the run itself failed. */
export function renderError(urls: string[], error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  const list = urls.map(url => `• <${url}|${shortLabel(url)}>`).join('\n')
  return [
    'The review run failed, so these pull requests were *not* reviewed:',
    list,
    `\`\`\`\n${message.slice(0, 2500)}\n\`\`\``,
  ].join('\n\n')
}

/** Worst first: a mixed request takes the first of these that any PR has (spec 5.9). */
export const DUAL_SEVERITY: readonly PrOutcome[] = ['error', 'blocked', 'findings', 'headMoved', 'clean', 'cleanNotCounted', 'approvedPartial', 'approved']

/** The worst outcome across a dual request's PRs; `error` for an empty list. */
export function worstOutcome(outcomes: PrOutcome[]): PrOutcome {
  for (const outcome of DUAL_SEVERITY) if (outcomes.includes(outcome)) return outcome
  return 'error'
}

const DUAL_OUTCOME_TEXT: Record<PrOutcome, string> = {
  approved: '*approved*',
  approvedPartial: '*approved (partial)*',
  cleanNotCounted: '*clean, approval would not count*',
  clean: '*clean (report-only comment)*',
  findings: '*findings*',
  blocked: '*blocked*',
  error: '*error, not approved*',
  headMoved: '*head moved during review; re-request*',
}

const PREFLIGHT_TEXT = { counts: 'counts', partial: 'partial', wontCount: "won't count" } as const

function dualLines(pr: DualPrReport): string[] {
  const head = [`• <${pr.url}|${shortLabel(pr.url)}> — ${DUAL_OUTCOME_TEXT[pr.outcome]}`]
  if (pr.eligibility) head.push(`pre-flight ${PREFLIGHT_TEXT[pr.eligibility.verdict]}`)
  for (const pass of pr.passes) head.push(`${ENGINE_LABEL[pass.engine]}: ${escapeSlack(pass.detail)}`)
  if (pr.reviewUrl) head.push(`<${pr.reviewUrl}|(review)>`)
  const lines = [head.join(' · ')]
  const sub = (text: string) => lines.push(`    ${text}`)
  if (pr.reason) sub(`_${escapeSlack(pr.reason)}_`)
  // The runner's reason already says which earlier review stands; this is only the fallback.
  if (pr.alreadyReviewed && pr.pinnedSha && !pr.reason) sub(`_already reviewed at \`${pr.pinnedSha.slice(0, 7)}\`; nothing new was posted_`)
  if (pr.eligibility && pr.eligibility.verdict !== 'counts') {
    for (const reason of pr.eligibility.reasons) sub(`_${escapeSlack(reason)}_`)
    if (pr.eligibility.missing.length) sub(`_still needed: ${pr.eligibility.missing.map(escapeSlack).join('; ')}_`)
  }
  for (const warning of pr.warnings) sub(`:warning: ${escapeSlack(warning)}`)
  return lines
}

/**
 * The dual-mode thread reply, posted for every dual run: per PR, the outcome, the pre-flight
 * verdict, each engine's state, and the review URL (spec 5.9), then any reason or warning.
 */
export function renderDualThread(report: DualReport): string {
  const total = report.prs.length
  const prs = `${total} pull request${total === 1 ? '' : 's'}`
  const title =
    report.engines?.length === 1 ? `${ENGINE_LABEL[report.engines[0]]} review (report-only) of ${prs}.` : `Dual-engine review of ${prs}.`
  return [title, ...report.prs.flatMap(dualLines)].join('\n')
}
