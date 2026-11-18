// Run one review from the terminal, with no Slack involved.
//
//   npm run review -- https://github.com/o/r/pull/1 [more urls...] [free-text instructions]
//   npm run review -- --dry-run https://github.com/o/r/pull/1   # print the prompt only
//
// This is the same prompt, profile, and output contract the daemon uses, so a review
// that misbehaves in Slack can be reproduced and iterated on here.

import { makeEngineAuth } from './bedrock-auth'
import { assertModeAvailable, isDualMode, loadReviewConfig, scrubDaemonSecrets } from './config'
import { engineWorktreeRoot } from './engine'
import { parseMessage } from './parse-message'
import { buildPrompt, buildReportOnlyPrompt } from './prompt'
import { renderDualThread, renderThread, verdictFor, worstOutcome } from './render'
import { selectReviewRunner } from './review'
import { ensureRegistryAuth } from './registry-auth'
import type { ReviewRequest } from './job'
import { renderUsageLine } from './usage'

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  const dryRun = argv.includes('--dry-run')
  const text = argv.filter(arg => arg !== '--dry-run').join(' ')

  const parsed = parseMessage(text)
  if (parsed.prs.length === 0) {
    process.stderr.write('No GitHub pull request URLs found in the arguments.\n')
    process.exitCode = 2
    return
  }

  const config = loadReviewConfig()
  scrubDaemonSecrets(process.env, config)
  try {
    assertModeAvailable(config)
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`)
    process.exitCode = 2
    return
  }
  // The CLI has no Slack message to key the run log on, so it synthesises a ref with a
  // 'cli' channel and a wall-clock ts. Nothing reacts or posts to it.
  const request: ReviewRequest = {
    message: { channel: 'cli', ts: `${Date.now() / 1000}` },
    prs: parsed.prs,
    instructions: parsed.instructions,
    requestedBy: 'cli',
  }

  if (dryRun) {
    // Dual mode pins each head at run time, so the dry run shows the Codex report-only prompt with
    // a placeholder where each pinned SHA goes.
    const prompt = isDualMode(config)
      ? buildReportOnlyPrompt({
          engine: 'codex',
          prs: request.prs.map(ref => ({ ref, pinnedSha: '<pinned at run time>' })),
          instructions: request.instructions,
          worktreeRoot: engineWorktreeRoot(config.worktreeRoot, 'codex'),
          requestedBy: request.requestedBy,
        })
      : buildPrompt({
          prs: request.prs,
          instructions: request.instructions,
          worktreeRoot: config.worktreeRoot,
          requestedBy: request.requestedBy,
        })
    process.stdout.write(prompt + '\n')
    return
  }

  process.stderr.write(`Reviewing ${request.prs.length} pull request(s) via ${isDualMode(config) ? 'Codex and Claude' : 'Codex'}...\n`)
  // Same private-registry refresh the daemon does, so a terminal review of a platform repo does
  // not fail `npm ci` on a stale CodeArtifact token (issue #42).
  const refreshAuth = (): Promise<void> =>
    ensureRegistryAuth({
      scriptPath: config.codeartifactLoginScript,
      enabled: config.codeartifactRefreshEnabled,
    })
  const { result, usage, dual } = await selectReviewRunner(config, { refreshAuth, engineAuth: makeEngineAuth(config) })(request)

  process.stdout.write(`\n${JSON.stringify(dual ?? result, null, 2)}\n`)
  process.stdout.write(`\n${renderUsageLine(usage)}\n`)
  if (dual) {
    const worst = worstOutcome(dual.prs.map(pr => pr.outcome))
    process.stdout.write(`\nOutcome: ${worst}\n`)
    process.stdout.write(`\n--- Slack thread that would be posted ---\n${renderDualThread(dual)}\n`)
    // A partial approval still approved; anything worse is a non-zero exit.
    process.exitCode = worst === 'approved' || worst === 'approvedPartial' ? 0 : 1
    return
  }
  process.stdout.write(`\nVerdict: ${verdictFor(result)}\n`)
  process.stdout.write(`\n--- Slack thread that would be posted ---\n${renderThread(result)}\n`)
  // Non-zero exit when anything did not pass, so a CI or shell caller can branch on it.
  process.exitCode = verdictFor(result) === 'pass' ? 0 : 1
}

main().catch(error => {
  process.stderr.write(`${String(error)}\n`)
  process.exit(1)
})
