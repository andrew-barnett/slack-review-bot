// Run one review from the terminal, with no Slack involved.
//
//   npm run review -- https://github.com/o/r/pull/1 [more urls...] [free-text instructions]
//   npm run review -- --dry-run https://github.com/o/r/pull/1   # print the prompt only
//   npm run review -- --report-only [--engine codex|claude|codex,claude] https://github.com/o/r/pull/1
//       # review-pr's report-only mode at the PR's current head: findings printed, nothing posted
//
// This is the same prompt, profile, and output contract the daemon uses, so a review
// that misbehaves in Slack can be reproduced and iterated on here. Without --report-only the
// review is real: single mode posts (and can approve) through the engine's own GitHub login, and
// dual mode posts through the approver token.

import { makeEngineAuth } from './bedrock-auth'
import { assertModeAvailable, isDualMode, loadReviewConfig, scrubDaemonSecrets } from './config'
import { engineWorktreeRoot, makeClaudeEngine, makeCodexEngine, type EngineDeps } from './engine'
import { defaultRunner } from './gh-api'
import { parseMessage } from './parse-message'
import { buildPrompt, buildReportOnlyPrompt } from './prompt'
import { renderDualThread, renderThread, verdictFor, worstOutcome } from './render'
import { renderReportOnly, reportOnlyExitCode, parseEngineFlag, runReportOnly } from './report-only'
import { runIdFor, selectReviewRunner, serialized } from './review'
import { ensureRegistryAuth } from './registry-auth'
import type { ReviewRequest } from './job'
import { renderUsageLine } from './usage'

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const dryRun = args.includes('--dry-run')
  const reportOnly = args.includes('--report-only')
  let flag: ReturnType<typeof parseEngineFlag>
  try {
    flag = parseEngineFlag(args.filter(arg => arg !== '--dry-run' && arg !== '--report-only'))
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`)
    process.exitCode = 2
    return
  }
  if (flag.engines && !reportOnly) {
    process.stderr.write('--engine applies only with --report-only; otherwise REVIEW_ENGINES decides\n')
    process.exitCode = 2
    return
  }
  const text = flag.rest.join(' ')

  const parsed = parseMessage(text)
  if (parsed.prs.length === 0) {
    process.stderr.write('No GitHub pull request URLs found in the arguments.\n')
    process.exitCode = 2
    return
  }

  const config = loadReviewConfig()
  scrubDaemonSecrets(process.env, config)
  if (config.runtime === 'container') {
    // The CLI runs engines locally; the container runtime runs them only in worker containers.
    process.stderr.write('RUNTIME=container is for the orchestrator; unset RUNTIME to review from the terminal\n')
    process.exitCode = 2
    return
  }
  try {
    // The dual-mode gate guards approvals; report-only never posts, so it runs either engine set.
    if (!reportOnly) assertModeAvailable(config)
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

  const reportEngines = flag.engines ?? config.engineOrder
  if (dryRun) {
    // Dual mode and --report-only pin each head at run time, so the dry run shows the report-only
    // prompt with a placeholder where each pinned SHA goes.
    const engine = reportOnly ? reportEngines[0] : 'codex'
    const prompt = isDualMode(config) || reportOnly
      ? buildReportOnlyPrompt({
          engine,
          prs: request.prs.map(ref => ({ ref, pinnedSha: '<pinned at run time>' })),
          instructions: request.instructions,
          worktreeRoot: engineWorktreeRoot(config.worktreeRoot, engine),
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

  // Same private-registry refresh the daemon does, so a terminal review of a platform repo does
  // not fail `npm ci` on a stale CodeArtifact token (issue #42).
  const refreshAuth = (): Promise<void> =>
    ensureRegistryAuth({
      scriptPath: config.codeartifactLoginScript,
      enabled: config.codeartifactRefreshEnabled,
    })

  if (reportOnly) {
    process.stderr.write(`Report-only review of ${request.prs.length} pull request(s) via ${reportEngines.join(', ')}; nothing is posted...\n`)
    const log = () => {}
    const engineDeps: EngineDeps = { log, refreshAuth: serialized(refreshAuth), engineAuth: makeEngineAuth(config) }
    const makers = { codex: makeCodexEngine, claude: makeClaudeEngine }
    const report = await runReportOnly(request, {
      gh: defaultRunner('gh'),
      engines: reportEngines.map(name => makers[name](config, engineDeps)),
      worktreeRoot: config.worktreeRoot,
      runId: runIdFor(request),
      onProgress: line => process.stderr.write(line.endsWith('\n') ? line : `${line}\n`),
    })
    process.stdout.write(`\n${JSON.stringify(report, null, 2)}\n`)
    process.stdout.write(`\n${renderUsageLine(report.usage)}\n\n${renderReportOnly(report)}\n`)
    process.exitCode = reportOnlyExitCode(report)
    return
  }

  process.stderr.write(`Reviewing ${request.prs.length} pull request(s) via ${isDualMode(config) ? 'Codex and Claude' : 'Codex'}...\n`)
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
