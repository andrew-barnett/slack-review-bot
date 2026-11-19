// Container entrypoint for the orchestrator. Reads the launcher's one-line secret bundle from stdin,
// keeps the values in its config object (never its environment), starts the job server and runs
// the daemon. It never runs PR code.

import { installCrashHandlers, log, runDaemon } from './daemon'
import { startContainerRuntime } from './jobs/runtime'
import { orchestratorConfig, smokeJob } from './orchestrator'
import { openSpendCap } from './spend-cap'
import { redactSecrets, registerHeldSecret } from './redact'
import { ORCHESTRATOR_BUNDLE, readSecretBundle } from './secret-bundle'

async function main(): Promise<void> {
  installCrashHandlers()
  const bundle = await readSecretBundle(process.stdin, ORCHESTRATOR_BUNDLE)
  for (const value of Object.values(bundle)) registerHeldSecret(value)
  const { config, launchKey } = orchestratorConfig(bundle, process.env)
  if (process.env.SMOKE === '1') {
    // The job server and the smoke route only; no Slack connection (spec section 6).
    // The real price table and ledger (on the smoke's own state volume); alerts are only logged, since
    // the smoke has no Slack connection.
    const spend = openSpendCap(config, log, async (channel, text) => log('smoke.alert', { channel, chars: text.length }))
    const smoke = await startContainerRuntime(config, launchKey, log, { smoke: smokeJob(config, spend) })
    log('smoke.ready', { port: smoke.port() })
    await new Promise<void>(resolve => process.once('SIGTERM', () => resolve()))
    await smoke.close()
    process.exit(0)
  }
  const container = await startContainerRuntime(config, launchKey, log)
  await runDaemon({ config, container })
}

main().catch(error => {
  log('bot.fatal', { error: redactSecrets(String(error)) })
  process.exit(1)
})
