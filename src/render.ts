// Rendering the review outcome into the Slack thread reply.
//
// Slack mrkdwn, not Markdown: labelled links are `<url|text>` and bullets are literal
// `•`. That syntax only renders for messages posted through the API, which is what the
// bot does — a report meant to be pasted by hand would need `[text](url)` instead.

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
      const summary = withSummary ? oneSentence(result.summary) : ''
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
