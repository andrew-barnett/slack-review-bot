// launchd entry point (dist/app.js): load config from the environment, drop the secrets from the
// environment, and run the daemon. The container runtime starts from src/orchestrator.ts instead.

import { loadConfig, scrubDaemonSecrets } from './config'
import { installCrashHandlers, log, runDaemon } from './daemon'

async function main(): Promise<void> {
  installCrashHandlers()
  const config = loadConfig()
  // The tokens (and any static engine AWS keys) now live only in `config`; drop them from the
  // environment every later spawn inherits.
  scrubDaemonSecrets(process.env, config)
  if (config.runtime === 'container') {
    throw new Error('RUNTIME=container runs as dist/orchestrator.js under the launcher, not dist/app.js')
  }
  await runDaemon({ config })
}

main().catch(error => {
  log('bot.fatal', { error: String(error) })
  process.exit(1)
})
