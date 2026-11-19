// Worker container entrypoint (bundled as dist/worker.js). Never imported: see Task 7's note on
// esbuild scope hoisting.

import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { resolveBedrockAuth } from './bedrock-auth'
import { runClaudeReview } from './claude'
import { createChildRegistry, drainChildRegistry, runCodexReportOnly, SHUTDOWN_GRACE_MS, SHUTDOWN_POLL_MS } from './codex'
import { loadReviewConfig, scrubDaemonSecrets } from './config'
import { makeJobClient } from './jobs/client'
import { jsonLog } from './json-log'
import { redactSecrets, registerHeldSecret } from './redact'
import { readSecretBundle, WORKER_BUNDLE } from './secret-bundle'
import { assertWorkerConfig, readFrom, runWorker, WORKER_NPMRC, workerExitCode, writeWorkerNpmrc } from './worker'

const log = jsonLog

async function main(): Promise<void> {
  const bundle = await readSecretBundle(process.stdin, WORKER_BUNDLE)
  const { WORKER_TICKET: ticket, ...exported } = bundle
  // Spec 3.6.1: the worker exports its values into its own environment, as Phase 2a expects. The
  // ticket stays in memory; it is spent on the first claim anyway.
  Object.assign(process.env, exported)
  const config = loadReviewConfig(process.env)
  assertWorkerConfig(config)
  for (const value of [config.engineGhToken, process.env.NPM_TOKEN]) registerHeldSecret(value)
  // Phase 2a: the engine token and AWS keys now live in config and reach a child only by explicit
  // injection; NPM_TOKEN stays, because the engine children's allowlist passes it to npm.
  scrubDaemonSecrets(process.env, config)
  writeWorkerNpmrc(process.env.npm_config_userconfig || WORKER_NPMRC)
  const registry = createChildRegistry()
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'srb-run-'))
  // After the orchestrator has exited, the launcher may SIGTERM a worker (spec 3.6 step 4).
  process.on('SIGTERM', () => {
    void drainChildRegistry(registry, {
      now: Date.now,
      setTimer: (fn, ms) => setTimeout(fn, ms),
      graceMs: SHUTDOWN_GRACE_MS,
      pollMs: SHUTDOWN_POLL_MS,
      log,
    }).then(() => process.exit(0))
  })
  const exit = await runWorker({
    config,
    ticket,
    client: makeJobClient(config.orchestratorUrl),
    runCodex: runCodexReportOnly,
    runClaude: runClaudeReview,
    resolveAuth: (engine, runId) => resolveBedrockAuth(config, engine, runId),
    registry,
    logDir,
    log,
    now: Date.now,
    sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
    every: (ms, fn) => {
      const handle = setInterval(fn, ms)
      return () => clearInterval(handle)
    },
    setTimer: (fn, ms) => {
      setTimeout(fn, ms).unref()
    },
    readFrom,
  })
  // Non-zero only for a refused ticket, so the launcher backs off instead of re-minting at once.
  const code = workerExitCode(exit)
  log('worker.exit', { exit, code })
  process.exit(code)
}

// A start-up failure (bad bundle, bad config) exits 1, which the launcher counts toward its backoff.
main().catch(error => {
  log('worker.fatal', { error: redactSecrets(String(error)) })
  process.exit(1)
})
