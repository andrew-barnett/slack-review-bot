// Run one review from the terminal, with no Slack involved.
//
//   npm run review -- https://github.com/o/r/pull/1 [more urls...] [free-text instructions]
//   npm run review -- --dry-run https://github.com/o/r/pull/1   # print the prompt only
//
// This is the same prompt, profile, and output contract the daemon uses, so a review
// that misbehaves in Slack can be reproduced and iterated on here.

import { loadReviewConfig } from './config'
import { parseMessage } from './parse-message'
import { buildPrompt } from './prompt'
import { renderThread, verdictFor } from './render'
import { makeReviewRunner } from './review'
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
  // The CLI has no Slack message to key the run log on, so it synthesises a ref with a
  // 'cli' channel and a wall-clock ts. Nothing reacts or posts to it.
  const request: ReviewRequest = {
    message: { channel: 'cli', ts: `${Date.now() / 1000}` },
    prs: parsed.prs,
    instructions: parsed.instructions,
    requestedBy: 'cli',
  }

  if (dryRun) {
    process.stdout.write(
      buildPrompt({
        prs: request.prs,
        instructions: request.instructions,
        worktreeRoot: config.worktreeRoot,
        requestedBy: request.requestedBy,
      }) + '\n'
    )
    return
  }

  process.stderr.write(`Reviewing ${request.prs.length} pull request(s) via Codex...\n`)
  const { result, usage } = await makeReviewRunner(config)(request)

  process.stdout.write(`\n${JSON.stringify(result, null, 2)}\n`)
  process.stdout.write(`\nVerdict: ${verdictFor(result)}\n`)
  process.stdout.write(`\n${renderUsageLine(usage)}\n`)
  process.stdout.write(`\n--- Slack thread that would be posted ---\n${renderThread(result)}\n`)
  // Non-zero exit when anything did not pass, so a CI or shell caller can branch on it.
  process.exitCode = verdictFor(result) === 'pass' ? 0 : 1
}

main().catch(error => {
  process.stderr.write(`${String(error)}\n`)
  process.exit(1)
})
