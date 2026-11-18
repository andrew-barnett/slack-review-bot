// The GitHub calls the human-review gate needs, via the `gh` CLI.
//
// Kept to two narrow operations — list a PR's changed file *names*, and post a PR comment —
// because that is all the gate requires. Listing names never reads file contents, so it does
// not expose the secrets a values file sits beside. Injected into the job like the Slack
// effects, and behind an injectable runner so the tests exercise the argument-building and
// parsing without a real `gh`.

import type { ApproverGitHub } from './approver-github'
import { isDualMode, type ReviewConfig } from './config'
import { defaultRunner, GH_COMMAND_TIMEOUT_MS, type GhRunner } from './gh-api'
import type { JobDeps } from './job'
import type { PullRequestRef } from './parse-message'

// Re-exported so existing imports from './github' keep working.
export { defaultRunner, GH_COMMAND_TIMEOUT_MS, type GhRunner }

export function makeGitHubEffects(
  bin = 'gh',
  run: GhRunner = defaultRunner(bin)
): Pick<JobDeps, 'listChangedFiles' | 'postPrComment'> {
  return {
    async listChangedFiles(pr: PullRequestRef): Promise<string[]> {
      const stdout = await run([
        'pr',
        'diff',
        String(pr.number),
        '--repo',
        `${pr.owner}/${pr.repo}`,
        // Names only: the gate needs the paths, never the diff contents.
        '--name-only',
      ])
      return stdout
        .split('\n')
        .map(line => line.trim())
        .filter(Boolean)
    },
    async postPrComment(pr: PullRequestRef, body: string): Promise<void> {
      await run(['pr', 'comment', String(pr.number), '--repo', `${pr.owner}/${pr.repo}`, '--body', body])
    },
  }
}

/**
 * The job's GitHub effects for the configured mode. In dual mode the human-gate comment is posted
 * as the role account (spec 5.7), so all of the bot's GitHub output comes from one identity;
 * listing changed files stays a read with the existing effect.
 */
export function makeJobGitHubEffects(
  config: Pick<ReviewConfig, 'reviewEngines'>,
  approver: ApproverGitHub | undefined,
  base: Pick<JobDeps, 'listChangedFiles' | 'postPrComment'> = makeGitHubEffects()
): Pick<JobDeps, 'listChangedFiles' | 'postPrComment'> {
  if (!isDualMode(config)) return base
  if (!approver) throw new Error('dual mode needs the role-account client for the human-gate comment')
  return { listChangedFiles: base.listChangedFiles, postPrComment: (pr, body) => approver.postIssueComment(pr, body) }
}
