import test from 'tape'
import { orchestratorConfig } from './orchestrator'

const key = Buffer.alloc(32, 9).toString('base64url')
const bundle = { SLACK_BOT_TOKEN: 'bot-placeholder', SLACK_APP_TOKEN: 'app-placeholder', APPROVER_GH_TOKEN: 'approver-placeholder', LAUNCH_KEY: key }

// Spec 3.6.1: the orchestrator keeps its secrets in its config object and never in its environment,
// so no later spawn (gh, git) inherits them. Regression caught: Object.assign(process.env, bundle).
test('orchestratorConfig reads the bundle without touching the environment', t => {
  const env: NodeJS.ProcessEnv = { HOME: '/home/bot', REVIEW_ENGINES: 'claude' }
  const before = JSON.stringify(env)
  const { config, launchKey } = orchestratorConfig(bundle, env)
  t.equal(JSON.stringify(env), before, 'env is unchanged')
  t.equal(config.runtime, 'container')
  t.equal(config.botToken, 'bot-placeholder')
  t.equal(config.approverGhToken, 'approver-placeholder')
  t.equal(launchKey.length, 32)
  t.end()
})

// The orchestrator never holds the engine token or engine AWS keys, even if the container env had
// them by mistake, and its engine auth is never bedrock (it runs no engine).
test('orchestratorConfig drops engine credentials from what config sees', t => {
  const env: NodeJS.ProcessEnv = {
    HOME: '/home/bot',
    ENGINE_GH_TOKEN: 'engine-placeholder',
    ENGINE_AUTH: 'bedrock',
    AWS_ACCESS_KEY_ID: 'id-placeholder',
    AWS_SECRET_ACCESS_KEY: 'secret-placeholder',
  }
  const { config } = orchestratorConfig(bundle, env)
  t.equal(config.engineGhToken, '')
  t.equal(config.engineAuth, 'subscription')
  t.equal(config.engineAwsStatic, undefined)
  t.end()
})

// A LAUNCH_KEY that is not 32 bytes of base64url cannot verify tickets; refuse rather than start.
test('orchestratorConfig rejects a malformed LAUNCH_KEY', t => {
  t.throws(() => orchestratorConfig({ ...bundle, LAUNCH_KEY: 'c2hvcnQ' }, { HOME: '/h' }), /LAUNCH_KEY/)
  t.end()
})
