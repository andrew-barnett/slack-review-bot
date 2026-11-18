import test from 'tape'
import { loadReviewConfig } from './config'
import { agentTools, bedrockProbeEnv, checkBedrock, type CommandRunner } from './doctor'
import type { Exec } from './registry-auth'

// Fixture key values are assembled at runtime, never committed as contiguous literals.
const KEY_ID = 'ASIA' + 'TESTTESTTESTTEST'
const SECRET = 'fake-secret-' + 'value-0123456789'
const SESSION = 'fake-session-' + 'token-0123456789'
const ROLE = 'arn:aws:iam::123456789012:role/SlackReviewBotEngineRole'

const roleConfig = loadReviewConfig({ HOME: '/home/u', ENGINE_AUTH: 'bedrock', ENGINE_ROLE_ARN: ROLE })
const staticConfig = loadReviewConfig({
  HOME: '/home/u',
  ENGINE_AUTH: 'bedrock',
  AWS_ACCESS_KEY_ID: KEY_ID,
  AWS_SECRET_ACCESS_KEY: SECRET,
})

/** An assume-role exec seam answering with fixed credentials, or failing with an STS reason. */
function stsExec(fail?: string): { exec: Exec; calls: number } {
  const state = { exec: undefined as unknown as Exec, calls: 0 }
  state.exec = async () => {
    state.calls += 1
    if (fail) throw Object.assign(new Error('Command failed'), { code: 254, stderr: fail })
    return {
      stdout: JSON.stringify({ Credentials: { AccessKeyId: KEY_ID, SecretAccessKey: SECRET, SessionToken: SESSION } }),
      stderr: '',
    }
  }
  return state
}

/** A command runner that records the probe and answers with a caller identity. */
function identity(arn: string, code = 0): { runCommand: CommandRunner; seen: Array<{ command: string; args: string[]; env?: NodeJS.ProcessEnv }> } {
  const seen: Array<{ command: string; args: string[]; env?: NodeJS.ProcessEnv }> = []
  const runCommand: CommandRunner = async (command, args, env) => {
    seen.push({ command, args, env })
    return { code, output: code === 0 ? JSON.stringify({ UserId: 'AROA:x', Account: '123456789012', Arn: arn }) : 'An error occurred (InvalidClientTokenId)' }
  }
  return { runCommand, seen }
}

const found = () => '/usr/local/bin/aws'

// The daemon mints with `aws`; a missing CLI on the agent's PATH must fail the doctor rather than
// surface as a failed first review. Static mode never shells out to mint, so it does not need it.
test('agentTools requires aws only in bedrock role mode', t => {
  t.ok(agentTools(roleConfig).includes('aws'))
  t.notOk(agentTools(staticConfig).includes('aws'))
  t.notOk(agentTools(loadReviewConfig({ HOME: '/home/u' })).includes('aws'))
  t.end()
})

// The probe must see only the minted credentials: no inherited profile, and the AWS config files
// pointed at /dev/null, so a passing identity cannot come from the operator's own setup.
test('bedrockProbeEnv carries only the engine credentials and disables the AWS files', t => {
  const env = bedrockProbeEnv('/bin', '/home/u', {
    region: 'us-east-2',
    model: 'm',
    credentials: { accessKeyId: KEY_ID, secretAccessKey: SECRET, sessionToken: SESSION },
  })
  t.deepEqual(Object.keys(env).sort(), [
    'AWS_ACCESS_KEY_ID', 'AWS_CONFIG_FILE', 'AWS_REGION', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN',
    'AWS_SHARED_CREDENTIALS_FILE', 'HOME', 'PATH',
  ])
  t.equal(env.AWS_CONFIG_FILE, '/dev/null')
  t.equal(env.AWS_SHARED_CREDENTIALS_FILE, '/dev/null')
  t.end()
})

// The happy path in role mode: aws resolves, the mint works, and the minted credentials identify as
// the engine role. No result line may carry a credential.
test('checkBedrock passes when the minted credentials are the engine role', async t => {
  const sts = stsExec()
  const probe = identity('arn:aws:sts::123456789012:assumed-role/SlackReviewBotEngineRole/slack-review-bot-doctor')
  const results = await checkBedrock(roleConfig, '/usr/bin', { exec: sts.exec, runCommand: probe.runCommand, find: found, home: '/home/u' })
  t.deepEqual(results.map(r => r.status), ['ok', 'ok', 'ok'])
  t.deepEqual(probe.seen[0].args, ['sts', 'get-caller-identity', '--output', 'json'])
  t.equal(probe.seen[0].env?.AWS_SESSION_TOKEN, SESSION, 'the probe ran with the minted credentials')
  const text = JSON.stringify(results)
  t.notOk(text.includes(SECRET) || text.includes(SESSION) || text.includes(KEY_ID), 'no credential in the report')
  t.end()
})

// Credentials that work but belong to something else (a misconfigured trust that hands back a
// broader role) must fail: the engines would run with more than invoke-model rights.
test('checkBedrock fails when the identity is not the engine role', async t => {
  const probe = identity('arn:aws:sts::123456789012:assumed-role/AdminRole/x')
  const results = await checkBedrock(roleConfig, '/usr/bin', { exec: stsExec().exec, runCommand: probe.runCommand, find: found })
  t.equal(results[2].status, 'fail')
  t.match(results[2].detail, /not the role/)
  t.end()
})

// A missing CLI stops before any mint; a failed mint reports the STS reason and runs no probe.
test('checkBedrock fails early when aws is missing or the mint fails', async t => {
  const sts = stsExec()
  const missing = await checkBedrock(roleConfig, '/usr/bin', { exec: sts.exec, runCommand: identity('x').runCommand, find: () => undefined })
  t.deepEqual(missing.map(r => [r.name, r.status]), [['bedrock aws cli', 'fail']])
  t.equal(sts.calls, 0, 'no mint without the CLI')

  const probe = identity('x')
  const denied = await checkBedrock(roleConfig, '/usr/bin', {
    exec: stsExec('An error occurred (AccessDenied) when calling the AssumeRole operation').exec,
    runCommand: probe.runCommand,
    find: found,
  })
  t.equal(denied[1].status, 'fail')
  t.match(denied[1].detail, /AccessDenied/)
  t.equal(probe.seen.length, 0, 'no identity probe after a failed mint')
  t.end()
})

// Static mode: nothing to mint, and no role to compare against, so the identity is reported.
// A rejected key fails the check.
test('checkBedrock reports the static identity and fails a rejected key', async t => {
  const ok = await checkBedrock(staticConfig, '/usr/bin', { runCommand: identity('arn:aws:iam::123456789012:user/engine').runCommand })
  t.deepEqual(ok.map(r => r.status), ['ok', 'ok'])
  t.equal(ok[1].detail, 'arn:aws:iam::123456789012:user/engine')
  const bad = await checkBedrock(staticConfig, '/usr/bin', { runCommand: identity('', 255).runCommand })
  t.equal(bad[1].status, 'fail')
  t.match(bad[1].detail, /InvalidClientTokenId/)
  t.end()
})
