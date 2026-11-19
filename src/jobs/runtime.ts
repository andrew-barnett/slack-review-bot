// The orchestrator's job side (spec 3.2): the broker, its HTTP server on the internal network, the
// remote run functions, and the approver-token changed-file lister. The daemon plugs these in where
// the launchd runtime has local children.

import type { AddressInfo } from 'net'
import type { ChildRegistry } from '../codex'
import type { ReviewConfig } from '../config'
import { makeApproverGitHubEffects } from '../github'
import type { PullRequestRef } from '../parse-message'
import { createJobBroker, type JobBroker } from './broker'
import { ticketMaxAgeMs } from './protocol'
import { makeRemoteRunners, type RemoteRunners } from './remote'
import { startJobServer } from './server'
import { LAUNCH_KEY_BYTES } from './ticket'

export interface ContainerRuntime {
  broker: JobBroker
  /** The broker as a child registry: shutdown's SIGTERM cancels, SIGKILL abandons. */
  registry: ChildRegistry
  runners: RemoteRunners
  listChangedFiles(pr: PullRequestRef): Promise<string[]>
  port(): number
  close(): Promise<void>
}

export interface ContainerRuntimeOptions {
  port?: number
  host?: string
  /** SMOKE=1 only: build the canned job the smoke route runs. */
  smoke?: (runners: RemoteRunners) => () => Promise<unknown>
}

export async function startContainerRuntime(
  config: ReviewConfig,
  launchKey: Buffer,
  log: (event: string, fields: Record<string, unknown>) => void,
  options: ContainerRuntimeOptions = {}
): Promise<ContainerRuntime> {
  if (launchKey.length !== LAUNCH_KEY_BYTES) throw new Error(`LAUNCH_KEY must be ${LAUNCH_KEY_BYTES} bytes`)
  if (!config.approverGhToken) throw new Error('RUNTIME=container requires APPROVER_GH_TOKEN')
  const broker = createJobBroker({ launchKey, ticketMaxAgeMs: ticketMaxAgeMs(config.workerIdleExitMs), logDir: config.runLogDir, log })
  const runners = makeRemoteRunners(broker)
  const server = await startJobServer({
    broker,
    port: options.port ?? config.jobPort,
    // Inside the container; Compose publishes no port, and `jobs` is an internal network.
    host: options.host ?? '0.0.0.0',
    log,
    smoke: options.smoke?.(runners),
  })
  broker.start()
  log('jobs.listening', { port: (server.address() as AddressInfo).port })
  const effects = makeApproverGitHubEffects(config.approverGhToken)
  return {
    broker,
    registry: broker.asRegistry(),
    runners,
    listChangedFiles: pr => effects.listChangedFiles!(pr),
    port: () => (server.address() as AddressInfo).port,
    close: () =>
      new Promise<void>(resolve => {
        broker.stop()
        server.close(() => resolve())
        // A worker's open long-poll would otherwise hold close() for up to 25 s.
        server.closeAllConnections()
      }),
  }
}
