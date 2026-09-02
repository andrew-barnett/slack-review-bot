// The GitHub calls the human-review gate needs, via the `gh` CLI.
//
// Kept to two narrow operations — list a PR's changed file *names*, and post a PR comment —
// because that is all the gate requires. Listing names never reads file contents, so it does
// not expose the secrets a values file sits beside. Injected into the job like the Slack
// effects, and behind an injectable runner so the tests exercise the argument-building and
// parsing without a real `gh`.

import { execFile } from 'child_process'
import { promisify } from 'util'
import type { JobDeps } from './job'
import type { PullRequestRef } from './parse-message'

const execFileAsync = promisify(execFile)

/** Runs `gh` with the given args and returns stdout. Swapped out in tests. */
export type GhRunner = (args: string[]) => Promise<string>

function defaultRunner(bin: string): GhRunner {
  return async args => {
    // A large PR can list many files; 10 MB of names is far more than any real PR reaches.
    const { stdout } = await execFileAsync(bin, args, { maxBuffer: 10 * 1024 * 1024 })
    return stdout
  }
}

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
