// The human-review gate.
//
// Some changes must not be reviewed by the bot at all. Deployment values in the `deployments`
// repo are the case this exists for: they carry the deployed image tags and sit next to
// encrypted secrets, so a person has to review them, not an automated pass. When the bot sees
// such a change it declines the review and comments on the PR so the author knows a human is
// required — silence would read as "the bot is just slow".
//
// Pure: the file list is fetched elsewhere and passed in, so the rule is testable without a
// GitHub call.

import type { PullRequestRef } from './parse-message'

/**
 * Whether a changed path is a deployment values file — `values.yaml` and its per-environment
 * siblings (`values-prod.yaml`, `values.staging.yaml`, `values.yml`), in any directory. The
 * encrypted `*.yaml.enc` twin is deliberately excluded: it is ciphertext, safe to read, and
 * is the normal way an encrypted change is committed.
 */
export function isDeploymentsValuesFile(path: string): boolean {
  const base = path.split('/').pop() ?? path
  return /^values([.-][^/]*)?\.ya?ml$/i.test(base)
}

/**
 * The values files a PR touches that require a human — empty unless it is a `deployments` PR
 * changing at least one. The repo check is what keeps an ordinary chart's `values.yaml` in
 * some other repo from being gated.
 */
export function protectedDeploymentsFiles(pr: Pick<PullRequestRef, 'repo'>, changedFiles: string[]): string[] {
  if (pr.repo !== 'deployments') return []
  return changedFiles.filter(isDeploymentsValuesFile)
}

/**
 * The GitHub PR comment left when a review is declined for human handling.
 *
 * `verified` is false when the changed files could not be listed: for a `deployments` PR that
 * is reason enough to hand it to a person rather than risk an automated pass on something that
 * might be a values change.
 */
export function renderHumanReviewComment(files: string[], verified: boolean): string {
  const header = '**Automated review skipped — a human review is required.**'
  if (!verified) {
    return [
      `🙋 ${header}`,
      '',
      "I couldn't confirm which files this `deployments` pull request changes, so out of " +
        'caution I have not reviewed it. Please have a person review these changes.',
    ].join('\n')
  }
  const list = files.map(file => `- \`${file}\``).join('\n')
  return [
    `🙋 ${header}`,
    '',
    'This pull request changes deployment values in the `deployments` repo, which must be ' +
      'reviewed by a person rather than by the bot:',
    '',
    list,
    '',
    'I have not reviewed these changes — please have a human review and approve them.',
  ].join('\n')
}

/** The Slack thread note summarising which requested PRs were handed to a human. */
export function renderHumanReviewThread(labels: string[]): string {
  const which = labels.join(', ')
  return (
    `🙋 *Human review required* — I won't auto-review ${which} because it changes ` +
    "deployment values (`values.yaml`) in the `deployments` repo. I've left a note on the PR; " +
    'please have a person review it.'
  )
}
