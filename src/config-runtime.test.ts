import test from 'tape'
import { loadReviewConfig, parseEngines, parseRuntime } from './config'

// RUNTIME is opt-in: unset must stay the launchd daemon, so an existing install changes nothing.
test('parseRuntime defaults to launchd and accepts only the two runtimes', t => {
  t.equal(parseRuntime(undefined), 'launchd')
  t.equal(parseRuntime(''), 'launchd')
  t.equal(parseRuntime('container'), 'container')
  t.throws(() => parseRuntime('ecs'), /RUNTIME must be/)
  t.end()
})

// Ruling 4 / spec D8: single mode in the container runtime may use either engine; the launchd runtime
// keeps today's shapes, and the error says what would make "claude" valid.
test('parseEngines accepts claude alone only in the container runtime', t => {
  t.deepEqual(parseEngines('claude', 'container'), ['claude'])
  t.deepEqual(parseEngines('codex', 'container'), ['codex'])
  t.deepEqual(parseEngines('codex,claude', 'container'), ['codex', 'claude'])
  t.throws(() => parseEngines('claude'), /RUNTIME=container/)
  t.throws(() => parseEngines('claude,claude', 'container'), /REVIEW_ENGINES/)
  t.end()
})

// Spec D8: in the container runtime every review is posted by the role account, so the approver token
// is read in single mode too (and the worker's engine token likewise). Launchd single mode reads neither.
test('the container runtime reads the role tokens in single mode', t => {
  const env = { HOME: '/home/u', APPROVER_GH_TOKEN: 'approver-placeholder', ENGINE_GH_TOKEN: 'engine-placeholder' }
  const container = loadReviewConfig({ ...env, RUNTIME: 'container' })
  t.equal(container.runtime, 'container')
  t.equal(container.approverGhToken, 'approver-placeholder')
  t.equal(container.engineGhToken, 'engine-placeholder')
  const launchd = loadReviewConfig(env)
  t.equal(launchd.runtime, 'launchd')
  t.equal(launchd.approverGhToken, '', 'launchd single mode is unchanged')
  t.equal(launchd.engineGhToken, '')
  t.end()
})

// Spec 3.2: no container process holds both tokens, so the "both present and different" startup
// check moves to the launcher. The orchestrator must still load with only the approver token.
test('container dual mode loads with only the approver token', t => {
  const config = loadReviewConfig({ HOME: '/home/u', RUNTIME: 'container', REVIEW_ENGINES: 'codex,claude', APPROVER_GH_TOKEN: 'approver-placeholder' })
  t.deepEqual(config.reviewEngines, ['codex', 'claude'])
  t.equal(config.engineGhToken, '')
  t.throws(() => loadReviewConfig({ HOME: '/home/u', REVIEW_ENGINES: 'codex,claude', APPROVER_GH_TOKEN: 'a' }), /ENGINE_GH_TOKEN/, 'launchd keeps the check')
  t.end()
})

// The worker and orchestrator settings have spec defaults (3.3, 3.4).
test('container settings default to the spec values', t => {
  const config = loadReviewConfig({ HOME: '/home/u' })
  t.equal(config.workerIdleExitMs, 600_000)
  t.equal(config.orchestratorUrl, 'http://slack-review-bot-orchestrator:8080')
  t.equal(config.jobPort, 8080)
  const overridden = loadReviewConfig({ HOME: '/h', WORKER_IDLE_EXIT_MS: '1000', JOB_PORT: '9090' })
  t.equal(overridden.jobPort, 9090)
  t.equal(overridden.workerIdleExitMs, 1000)
  t.end()
})
