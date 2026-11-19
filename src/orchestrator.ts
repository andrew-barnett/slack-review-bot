// The orchestrator's configuration from the launcher's secret bundle. The values go into the
// config object only, never the process environment (spec 3.6.1).

import * as path from 'path'
import { loadConfig, type Config, type ReviewConfig } from './config'
import type { RemoteRunners } from './jobs/remote'
import { LAUNCH_KEY_BYTES } from './jobs/ticket'
import type { SpendCap } from './spend-cap'

export interface SmokeReply {
  runId: string
  results: unknown[]
  lines: string[]
}

/**
 * SMOKE=1 only (spec section 6): one canned Codex attempt through the job broker. The worker runs
 * it with a stub engine binary; the reply carries the results and every status line seen.
 */
export function smokeJob(config: ReviewConfig, spend?: Pick<SpendCap, 'record'>): (runners: RemoteRunners) => () => Promise<SmokeReply> {
  return runners => async () => {
    const runId = `smoke-${Date.now()}`
    const lines: string[] = []
    const outcome = await runners.runCodex({
      prompt: 'smoke test: report no results',
      codexBin: 'codex',
      profile: config.codexProfile,
      workspaceRoot: config.workspaceRoot,
      worktreeRoot: path.join(config.worktreeRoot, 'codex'),
      timeoutMs: 120_000,
      disableGitSigning: true,
      runId,
      onProgress: line => void lines.push(line),
    })
    // Recorded like a review's engine run, so the compose smoke proves Codex usage reaches the spend journal.
    await spend?.record(
      {
        attempts: 1,
        engines: [
          {
            engine: 'codex',
            usage: {
              attempts: 1,
              activeMs: outcome.activeMs,
              ...(outcome.tokensUsed !== undefined ? { tokensUsed: outcome.tokensUsed } : {}),
              ...(outcome.codexUsage ? { codex: outcome.codexUsage } : {}),
            },
          },
        ],
      },
      runId,
      Date.now()
    )
    return { runId, results: outcome.result.results, lines }
  }
}

/** Variables the orchestrator must never see as config input, even if the container env had them. */
const ENGINE_ONLY_VARS = ['ENGINE_GH_TOKEN', 'ENGINE_AUTH', 'ENGINE_ROLE_ARN', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN']

/** Build config from a merged copy of the env and the bundle. `env` itself is never modified. */
export function orchestratorConfig(bundle: Record<string, string>, env: NodeJS.ProcessEnv): { config: Config; launchKey: Buffer } {
  const merged: NodeJS.ProcessEnv = { ...env }
  for (const name of ENGINE_ONLY_VARS) delete merged[name]
  merged.RUNTIME = 'container'
  merged.SLACK_BOT_TOKEN = bundle.SLACK_BOT_TOKEN
  merged.SLACK_APP_TOKEN = bundle.SLACK_APP_TOKEN
  merged.APPROVER_GH_TOKEN = bundle.APPROVER_GH_TOKEN
  const launchKey = Buffer.from(bundle.LAUNCH_KEY ?? '', 'base64url')
  if (launchKey.length !== LAUNCH_KEY_BYTES) throw new Error(`LAUNCH_KEY must be ${LAUNCH_KEY_BYTES} bytes of base64url`)
  return { config: loadConfig(merged), launchKey }
}
