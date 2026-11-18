// The GitHub calls the human-review gate needs, via the `gh` CLI.
//
// Kept to two narrow operations — list a PR's changed file *names*, and post a PR comment —
// because that is all the gate requires. Listing names never reads file contents, so it does
// not expose the secrets a values file sits beside. Injected into the job like the Slack
// effects, and behind an injectable runner so the tests exercise the argument-building and
// parsing without a real `gh`.

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
