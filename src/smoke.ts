// Host-side compose smoke (spec section 6), run by scripts/compose-smoke.sh with ts-node. Starts an
// orchestrator in SMOKE=1 mode and one worker with a stub engine, both with dummy bundles (no real
// credential is involved), submits one job, and checks the result, the status lines and the run
// log. Uses its own Compose project and container names, so it never touches the real stack.

import { execFileSync, spawn, type ChildProcess } from 'child_process'
import { randomBytes } from 'crypto'
import * as path from 'path'
import { CLAIMED_LINE, WAITING_LINE } from './jobs/remote'
import { mintTicket } from './jobs/ticket'
import { encodeSecretBundle } from './secret-bundle'

const ROOT = path.join(__dirname, '..')
const PROJECT = 'slack-review-bot-smoke'
const ORCH = 'srb-smoke-orchestrator'
const WORKER = 'srb-smoke-worker'
const compose = (args: string[]) => ['compose', '-f', path.join(ROOT, 'compose.yaml'), '-p', PROJECT, ...args]
const dummy = (name: string) => `smoke-${name}-not-a-credential`

function docker(args: string[]): string {
  return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] })
}

function start(args: string[], bundle: string): { child: ChildProcess; exited: Promise<number> } {
  const child = spawn('docker', args, { stdio: ['pipe', 'inherit', 'inherit'] })
  child.stdin?.end(bundle)
  return { child, exited: new Promise(resolve => child.on('exit', code => resolve(code ?? 1))) }
}

/** `node -e` inside the orchestrator container, against its own job server. */
function inOrchestrator(script: string): string {
  return docker(['exec', ORCH, 'node', '-e', script])
}

async function waitForHealth(): Promise<void> {
  for (let i = 0; i < 60; i += 1) {
    try {
      inOrchestrator("fetch('http://127.0.0.1:8080/healthz').then(r => process.exit(r.status === 200 ? 0 : 1), () => process.exit(1))")
      return
    } catch {
      await new Promise(resolve => setTimeout(resolve, 1000))
    }
  }
  throw new Error('the orchestrator did not answer /healthz within 60 s')
}

function teardown(): void {
  for (const name of [ORCH, WORKER]) {
    try {
      docker(['rm', '-f', name])
    } catch {
      // Not running.
    }
  }
  try {
    docker(compose(['down', '-v']))
  } catch {
    // Nothing to remove.
  }
}

async function main(): Promise<void> {
  teardown()
  const key = randomBytes(32)
  const orch = start(
    compose(['run', '--rm', '-T', '--name', ORCH, '-e', 'SMOKE=1', 'orchestrator']),
    encodeSecretBundle({ SLACK_BOT_TOKEN: dummy('bot'), SLACK_APP_TOKEN: dummy('app'), APPROVER_GH_TOKEN: dummy('approver'), LAUNCH_KEY: key.toString('base64url') })
  )
  try {
    await waitForHealth()
    const worker = start(
      compose([
        'run', '--rm', '-T', '--name', WORKER,
        '-e', `ORCHESTRATOR_URL=http://${ORCH}:8080`,
        '-e', 'CODEX_BIN=/app/scripts/smoke/stub-codex.js',
        '-e', 'WORKER_IDLE_EXIT_MS=60000',
        'worker',
      ]),
      encodeSecretBundle({
        ENGINE_GH_TOKEN: dummy('engine'),
        AWS_ACCESS_KEY_ID: dummy('id'),
        AWS_SECRET_ACCESS_KEY: dummy('key'),
        AWS_SESSION_TOKEN: dummy('session'),
        NPM_TOKEN: dummy('npm'),
        WORKER_TICKET: mintTicket(key, Date.now()),
      })
    )
    const reply = JSON.parse(
      inOrchestrator("fetch('http://127.0.0.1:8080/v1/smoke/submit', { method: 'POST' }).then(r => r.text()).then(t => process.stdout.write(t))")
    ) as { runId?: string; results?: unknown[]; lines?: string[]; error?: unknown }
    if (!Array.isArray(reply.results) || reply.results.length !== 0) throw new Error(`unexpected smoke reply: ${JSON.stringify(reply)}`)
    if (!reply.lines?.includes(WAITING_LINE)) throw new Error('the waiting status line never arrived')
    if (!reply.lines.includes(CLAIMED_LINE)) throw new Error('the claimed status line never arrived')
    if (!reply.lines.some(line => line.includes('stub-codex: reviewing'))) throw new Error("the stub's progress line never arrived")
    const log = inOrchestrator(`process.stdout.write(require('fs').readFileSync('/var/lib/slack-review-bot/runs/${reply.runId}.log', 'utf8'))`)
    if (!log.includes('stub-codex: reviewing')) throw new Error('the run log was not shipped to the orchestrator')
    // Spec 6/7: the stub's --json usage crossed the worker wire and was priced into the month's journal.
    // Every spend-YYYY-MM.jsonl is read, so a smoke that straddles 00:00 UTC on the 1st still finds it.
    const journal = inOrchestrator(
      "const fs = require('fs'); const dir = '/var/lib/slack-review-bot/state'; " +
        "for (const name of fs.readdirSync(dir).filter(n => /^spend-\\d{4}-\\d{2}\\.jsonl$/.test(n))) process.stdout.write(fs.readFileSync(dir + '/' + name, 'utf8'))"
    )
    const runLine = journal
      .split('\n')
      .filter(line => line.trim() !== '')
      .map(line => JSON.parse(line) as { type?: string; runId?: string; engine?: string; noUsage?: boolean; tokens?: { input?: number } })
      .find(line => line.type === 'run' && line.runId === reply.runId)
    if (!runLine || runLine.engine !== 'codex' || runLine.noUsage || !(Number(runLine.tokens?.input) > 0)) {
      throw new Error(`the smoke's Codex usage never reached the spend journal: ${JSON.stringify(runLine)}`)
    }
    const workerCode = await worker.exited
    if (workerCode !== 0) throw new Error(`the worker exited ${workerCode}`)
    process.stdout.write('compose smoke passed: result, status lines, run log and spend ledger entry all arrived\n')
  } finally {
    try {
      docker(['kill', '--signal', 'SIGTERM', ORCH])
    } catch {
      // Already gone.
    }
    await orch.exited
    teardown()
  }
}

main().catch(error => {
  process.stderr.write(`compose smoke FAILED: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
})
