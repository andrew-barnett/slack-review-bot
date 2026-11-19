import type { AddressInfo } from 'net'
import test from 'tape'
import { loadReviewConfig } from '../config'
import { startContainerRuntime } from './runtime'

const config = loadReviewConfig({ HOME: '/home/bot', RUNTIME: 'container', REVIEW_ENGINES: 'codex', APPROVER_GH_TOKEN: 'approver-placeholder', RUN_LOG_DIR: '' })

// The orchestrator's job server answers /healthz and exposes the broker as the child registry the
// shutdown path drains. Regression caught: a runtime whose registry is not the broker, so shutdown
// would exit with jobs still claimed.
test('startContainerRuntime serves /healthz and exposes the broker as the registry', async t => {
  const runtime = await startContainerRuntime(config, Buffer.alloc(32, 1), () => {}, { port: 0, host: '127.0.0.1' })
  const res = await fetch(`http://127.0.0.1:${runtime.port()}/healthz`)
  t.equal(res.status, 200)
  t.equal(runtime.registry.size(), 0)
  void runtime.runners.runCodex({ prompt: 'p', codexBin: '', profile: '', workspaceRoot: '', worktreeRoot: '/work/wt/codex', timeoutMs: 1000, disableGitSigning: true, runId: 'C1-11.codex' }).catch(() => {})
  t.equal(runtime.registry.size(), 1, 'a queued job is in flight')
  t.equal(runtime.registry.killAll('SIGKILL'), 1)
  await runtime.close()
  t.end()
})

// The smoke route exists only when asked for; a normal orchestrator answers 404 there.
test('startContainerRuntime exposes the smoke route only in smoke mode', async t => {
  const plain = await startContainerRuntime(config, Buffer.alloc(32, 1), () => {}, { port: 0, host: '127.0.0.1' })
  t.equal((await fetch(`http://127.0.0.1:${plain.port()}/v1/smoke/submit`, { method: 'POST' })).status, 404)
  await plain.close()
  const smoke = await startContainerRuntime(config, Buffer.alloc(32, 1), () => {}, { port: 0, host: '127.0.0.1', smoke: () => async () => ({ ok: 1 }) })
  const res = await fetch(`http://127.0.0.1:${smoke.port()}/v1/smoke/submit`, { method: 'POST' })
  t.deepEqual(await res.json(), { ok: 1 })
  await smoke.close()
  t.end()
})

// A wrong-sized key would make every ticket unverifiable, and a missing approver token means the
// orchestrator cannot post; both stop the orchestrator at startup.
test('startContainerRuntime refuses a bad launch key or a missing approver token', async t => {
  await startContainerRuntime(config, Buffer.alloc(16), () => {}, { port: 0 }).then(
    () => t.fail('started'),
    error => t.match(error.message, /LAUNCH_KEY/)
  )
  await startContainerRuntime({ ...config, approverGhToken: '' }, Buffer.alloc(32), () => {}, { port: 0 }).then(
    () => t.fail('started'),
    error => t.match(error.message, /APPROVER_GH_TOKEN/)
  )
  t.end()
})
