// The orchestrator's configuration from the launcher's secret bundle. The values go into the
// config object only, never the process environment (spec 3.6.1).

import { loadConfig, type Config } from './config'
import { LAUNCH_KEY_BYTES } from './jobs/ticket'

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
