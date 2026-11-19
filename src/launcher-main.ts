// Host launcher entrypoint (dist/launcher.js), run by scripts/launcher under launchd.

import { jsonLog } from './json-log'
import { createLauncher, defaultRandomKey, loadLauncherSettings, makeAwsOps, makeDockerOps, runDoctor, type LauncherDeps } from './launcher'
import { redactSecrets } from './redact'

const log = jsonLog

async function main(): Promise<number> {
  const settings = loadLauncherSettings(process.env)
  const deps: LauncherDeps = {
    settings,
    aws: makeAwsOps(settings),
    docker: makeDockerOps(settings, process.env, undefined, undefined, log),
    log,
    now: Date.now,
    randomKey: defaultRandomKey,
  }
  const [command, role] = process.argv.slice(2)
  if (command === 'doctor') {
    if (role !== 'orchestrator' && role !== 'worker') {
      process.stderr.write('usage: launcher doctor orchestrator|worker\n')
      return 2
    }
    return runDoctor(deps, role)
  }
  if (command !== undefined) {
    process.stderr.write('usage: launcher [doctor orchestrator|worker]\n')
    return 2
  }
  const launcher = createLauncher(deps)
  for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => launcher.requestStop())
  return launcher.start()
}

main().then(
  code => process.exit(code),
  error => {
    // An AWS or docker error can quote what it was handed; redact before it reaches the log.
    log('launcher.fatal', { error: redactSecrets(String(error instanceof Error ? error.message : error).split('\n')[0]) })
    process.exit(1)
  }
)
