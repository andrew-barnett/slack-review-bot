import test from 'tape'
import {
  assumeEngineRole,
  bedrockCodexArgs,
  engineSessionName,
  engineSessionSeconds,
  makeEngineAuth,
  resolveBedrockAuth,
  withBedrockClaudeEnv,
  withBedrockCodexEnv,
  type BedrockAuth,
} from './bedrock-auth'
import { loadReviewConfig, type ReviewConfig } from './config'
import type { Exec } from './registry-auth'
import { redactSecrets } from './redact'

// Credential-shaped fixtures are assembled at runtime, never written as contiguous literals, so the
// committed source carries nothing that looks like a real key (same convention as redact.test.ts).
const KEY_ID = 'ASIA' + 'TESTTESTTESTTEST'
const SECRET = 'fake-secret-' + 'value-0123456789abcdef'
const SESSION = 'fake-session-' + 'token-0123456789abcdef'
const ROLE = 'arn:aws:iam::123456789012:role/SlackReviewBotEngineRole'

/** An exec seam that records its calls and answers like `aws sts assume-role --output json`. */
function stsExec(result: { stdout?: string; fail?: { code: number; stderr: string; stdout?: string } } = {}): {
  exec: Exec
  calls: Array<{ file: string; args: string[] }>
} {
  const calls: Array<{ file: string; args: string[] }> = []
  const exec: Exec = async (file, args) => {
    calls.push({ file, args })
    if (result.fail) {
      const err = new Error(`Command failed: ${file} ${args.join(' ')}\n${result.fail.stderr}`) as Error & {
        code?: number
        stderr?: string
        stdout?: string
      }
      err.code = result.fail.code
      err.stderr = result.fail.stderr
      err.stdout = result.fail.stdout ?? ''
      throw err
    }
    return {
      stdout:
        result.stdout ??
        JSON.stringify({
          Credentials: {
            AccessKeyId: KEY_ID,
            SecretAccessKey: SECRET,
            SessionToken: SESSION,
            Expiration: '2026-11-18T20:00:00Z',
          },
        }),
      stderr: '',
    }
  }
  return { exec, calls }
}

const PROJECT = 'proj_testproject123'

const AUTH: BedrockAuth = {
  region: 'us-east-2',
  model: 'us.anthropic.claude-opus-5-5',
  credentials: { accessKeyId: KEY_ID, secretAccessKey: SECRET, sessionToken: SESSION },
}

function bedrockConfig(extra: Record<string, string> = {}): ReviewConfig {
  return loadReviewConfig({ HOME: '/home/test', ENGINE_AUTH: 'bedrock', ENGINE_ROLE_ARN: ROLE, CODEX_BEDROCK_PROJECT: PROJECT, ...extra })
}

// The session must outlive the run it serves (a credential expiring mid-review fails the review) but
// never exceed the role's 4-hour maximum, which STS would reject outright, nor fall below STS's
// 15-minute minimum.
test('engineSessionSeconds covers the run plus slack, within the STS bounds', t => {
  t.equal(engineSessionSeconds(60 * 60 * 1000), 3600 + 900, 'one hour run gets 15 minutes of slack')
  t.equal(engineSessionSeconds(1), 901, 'a sub-second run rounds up, then adds slack')
  t.equal(engineSessionSeconds(0), 900, 'never below the STS minimum')
  t.equal(engineSessionSeconds(5 * 60 * 60 * 1000), 14400, 'capped at the role maximum')
  t.end()
})

// STS rejects a session name outside [\w+=,.@-] or over 64 characters; the runId carries a channel
// id and a dotted timestamp, and a retry suffix, so it must be sanitised and truncated.
test('engineSessionName is STS-safe and at most 64 characters', t => {
  const name = engineSessionName('C0123/1700000000.123456 codex#retry1')
  t.ok(/^[\w+=,.@-]+$/.test(name), 'only STS-allowed characters')
  t.ok(name.startsWith('slack-review-bot-'), 'identifies the bot in CloudTrail')
  t.ok(engineSessionName('x'.repeat(200)).length <= 64, 'truncated to 64')
  t.end()
})

// The happy path: exactly the documented argv, through execFile (no shell), and the four fields
// parsed out of the JSON. The profile flag appears only when one is configured.
test('assumeEngineRole runs sts assume-role and parses the credentials', async t => {
  const { exec, calls } = stsExec()
  const creds = await assumeEngineRole({
    roleArn: ROLE,
    profile: 'operator',
    region: 'us-east-2',
    durationSeconds: 1200,
    sessionName: 'slack-review-bot-run',
    exec,
  })
  t.deepEqual(calls, [
    {
      file: 'aws',
      args: [
        'sts', 'assume-role',
        '--role-arn', ROLE,
        '--role-session-name', 'slack-review-bot-run',
        '--duration-seconds', '1200',
        '--region', 'us-east-2',
        '--output', 'json',
        '--profile', 'operator',
      ],
    },
  ])
  t.deepEqual(creds, { accessKeyId: KEY_ID, secretAccessKey: SECRET, sessionToken: SESSION, expiration: '2026-11-18T20:00:00Z' })

  const bare = stsExec()
  await assumeEngineRole({ roleArn: ROLE, profile: '', region: 'us-east-2', durationSeconds: 900, sessionName: 's', exec: bare.exec })
  t.notOk(bare.calls[0].args.includes('--profile'), 'no --profile when none is configured: the default chain is used')
  t.end()
})

// Failure must explain itself (AccessDenied, expired operator session) using STS's stderr, which
// never carries credentials, and must never echo stdout, which on a partial success could.
test('assumeEngineRole reports the first stderr line and never stdout', async t => {
  const { exec } = stsExec({
    fail: {
      code: 254,
      stderr: 'An error occurred (AccessDenied) when calling the AssumeRole operation: not authorized\nsecond line',
      stdout: `{"SecretAccessKey":"${SECRET}"}`,
    },
  })
  try {
    await assumeEngineRole({ roleArn: ROLE, profile: '', region: 'us-east-2', durationSeconds: 900, sessionName: 's', exec })
    t.fail('should throw')
  } catch (error) {
    const message = (error as Error).message
    t.ok(message.startsWith('could not assume the engine role: An error occurred (AccessDenied)'), 'names the STS reason')
    t.notOk(message.includes('second line'), 'first line only')
    t.notOk(message.includes(SECRET), 'stdout never surfaces')
  }
  const long = stsExec({ fail: { code: 1, stderr: 'x'.repeat(1000) } })
  try {
    await assumeEngineRole({ roleArn: ROLE, profile: '', region: 'us-east-2', durationSeconds: 900, sessionName: 's', exec: long.exec })
  } catch (error) {
    t.ok((error as Error).message.length <= 'could not assume the engine role: '.length + 300, 'capped at 300 characters')
  }
  t.end()
})

// A zero-exit response without the expected fields must fail closed, and the error must not quote
// the response, which may hold a partial credential.
test('assumeEngineRole rejects a malformed response without quoting it', async t => {
  for (const stdout of ['not json', JSON.stringify({ Credentials: { AccessKeyId: KEY_ID, SessionToken: SESSION } })]) {
    const { exec } = stsExec({ stdout })
    try {
      await assumeEngineRole({ roleArn: ROLE, profile: '', region: 'us-east-2', durationSeconds: 900, sessionName: 's', exec })
      t.fail('should throw')
    } catch (error) {
      const message = (error as Error).message
      t.ok(message.startsWith('could not assume the engine role'), 'a clear failure')
      t.notOk(message.includes(KEY_ID) || message.includes(SESSION), 'response not quoted')
    }
  }
  t.end()
})

// Exactly one credential path reaches Claude: the Bedrock switches and the minted keys in, the OAuth
// token, API key, and any profile out. A leftover OAuth token or profile would make the run bill the
// subscription or the operator's own account instead of the engine role.
test('withBedrockClaudeEnv sets Bedrock and removes every other credential path', t => {
  const base = {
    PATH: '/bin',
    CLAUDE_CODE_OAUTH_TOKEN: 'oauth-token',
    ANTHROPIC_API_KEY: 'api-key',
    AWS_PROFILE: 'operator',
    AWS_DEFAULT_PROFILE: 'operator',
  }
  const env = withBedrockClaudeEnv(base, AUTH)
  t.equal(env.CLAUDE_CODE_USE_BEDROCK, '1')
  t.equal(env.AWS_REGION, 'us-east-2')
  t.equal(env.ANTHROPIC_MODEL, 'us.anthropic.claude-opus-5-5')
  t.equal(env.AWS_ACCESS_KEY_ID, KEY_ID)
  t.equal(env.AWS_SECRET_ACCESS_KEY, SECRET)
  t.equal(env.AWS_SESSION_TOKEN, SESSION)
  for (const name of ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'AWS_PROFILE', 'AWS_DEFAULT_PROFILE']) {
    t.notOk(name in env, `${name} removed`)
  }
  t.equal(env.PATH, '/bin', 'everything else kept')
  t.ok('CLAUDE_CODE_OAUTH_TOKEN' in base, 'the input is not mutated')
  t.end()
})

// Static long-term keys have no session token; a stale AWS_SESSION_TOKEN left in the env would be
// paired with the wrong key and every Bedrock call would fail signature checks.
test('withBedrock*Env drops a stale session token when the credentials have none', t => {
  const auth: BedrockAuth = { ...AUTH, credentials: { accessKeyId: KEY_ID, secretAccessKey: SECRET } }
  const base = { AWS_SESSION_TOKEN: 'stale-token' }
  t.notOk('AWS_SESSION_TOKEN' in withBedrockClaudeEnv(base, auth), 'claude')
  t.notOk('AWS_SESSION_TOKEN' in withBedrockCodexEnv(base, auth), 'codex')
  t.end()
})

// Codex reads its Bedrock credentials from the standard AWS environment; a profile variable would
// let the chain pick the operator's own credentials instead of the minted ones.
test('withBedrockCodexEnv sets the AWS variables and removes the profile', t => {
  const env = withBedrockCodexEnv({ PATH: '/bin', AWS_PROFILE: 'operator', AWS_DEFAULT_PROFILE: 'x' }, AUTH)
  t.equal(env.AWS_REGION, 'us-east-2')
  t.equal(env.AWS_ACCESS_KEY_ID, KEY_ID)
  t.equal(env.AWS_SECRET_ACCESS_KEY, SECRET)
  t.equal(env.AWS_SESSION_TOKEN, SESSION)
  t.notOk('AWS_PROFILE' in env || 'AWS_DEFAULT_PROFILE' in env, 'profiles removed')
  t.notOk('CLAUDE_CODE_USE_BEDROCK' in env, 'no Claude switches on the Codex child')
  t.end()
})

// The overrides are exactly what the codex-cli 0.170.0 spike verified (Mantle provider plus the
// OpenAI-Project header), including the AWS_* shell exclude, without which every model-directed
// command and PR test would see the engine keys. Regression caught: falling back to
// bedrock-runtime, where OpenAI models fail on the account's `none` retention mode.
test('bedrockCodexArgs returns the provider, model, region, project header and AWS_* exclude overrides', t => {
  const args = bedrockCodexArgs({ ...AUTH, model: 'openai.gpt-5.5', project: PROJECT })
  t.deepEqual(args, [
    '-c', 'model_provider="amazon-bedrock"',
    '-c', 'model="openai.gpt-5.5"',
    '-c', 'model_providers.amazon-bedrock.aws.region="us-east-2"',
    '-c', 'model_providers.amazon-bedrock.http_headers={"OpenAI-Project"="proj_testproject123"}',
    '-c', 'shell_environment_policy.exclude=["AWS_*"]',
  ])
  t.deepEqual(
    bedrockCodexArgs({ ...AUTH, project: PROJECT, contextWindow: 272000 }).slice(-2),
    ['-c', 'model_context_window=272000'],
    'the context-window override is appended when configured'
  )
  t.end()
})

// The values are interpolated into TOML; config validates them, and this is the second guard, so a
// quote in a model ID can never inject an extra override.
test('bedrockCodexArgs refuses a value that is not TOML-safe', t => {
  t.throws(() => bedrockCodexArgs({ ...AUTH, project: PROJECT, model: 'x" , sandbox_mode="danger' }), /model/)
  t.throws(() => bedrockCodexArgs({ ...AUTH, project: PROJECT, region: 'us-east-2"' }), /region/)
  t.end()
})

// The project ID is spliced into an inline TOML table; a missing project would send no header (and
// hit the retention-`none` default), and a quote would inject an extra override. Both must throw.
test('bedrockCodexArgs refuses a missing or malformed Mantle project', t => {
  t.throws(() => bedrockCodexArgs({ ...AUTH }), /project/)
  t.throws(() => bedrockCodexArgs({ ...AUTH, project: '' }), /project/)
  t.throws(() => bedrockCodexArgs({ ...AUTH, project: 'proj_a"}, sandbox_mode="danger' }), /project/)
  t.throws(() => bedrockCodexArgs({ ...AUTH, project: 'PROJ_ABC' }), /project/)
  t.end()
})

// Role mode mints per call with a session sized to the run, picks the engine's own model, and
// registers the minted values with the redactor so a PR that prints them cannot publish them.
test('resolveBedrockAuth mints role credentials per engine and registers them for redaction', async t => {
  const { exec, calls } = stsExec()
  const config = bedrockConfig({ ENGINE_AWS_PROFILE: 'operator', CODEX_BEDROCK_CONTEXT_WINDOW: '400000' })
  const claude = await resolveBedrockAuth(config, 'claude', 'C1-170.claude', exec)
  t.equal(claude.model, 'us.anthropic.claude-opus-5-5')
  t.equal(claude.region, 'us-east-2')
  t.equal(claude.credentials.secretAccessKey, SECRET)
  t.equal(claude.contextWindow, undefined, 'the Codex context window is not applied to Claude')
  const codex = await resolveBedrockAuth(config, 'codex', 'C1-170.codex', exec)
  t.equal(codex.model, 'openai.gpt-5.6-terra')
  t.equal(codex.project, PROJECT)
  t.equal(claude.project, undefined, 'the Mantle project is not applied to Claude')
  t.equal(codex.contextWindow, 400000)
  t.equal(calls.length, 2, 'one mint per call, so each attempt gets a fresh session')
  const duration = calls[0].args[calls[0].args.indexOf('--duration-seconds') + 1]
  t.equal(duration, String(engineSessionSeconds(config.runTimeoutMs)), 'session sized to the run timeout')
  t.ok(calls[0].args.includes('operator'), 'the configured profile is used')
  t.equal(redactSecrets(`leak ${SESSION}`, {}), 'leak [redacted:env]', 'minted session token is masked')
  t.end()
})

// Static mode never shells out: the captured credentials are used as they are.
test('resolveBedrockAuth uses static credentials without calling sts', async t => {
  const { exec, calls } = stsExec()
  const config = loadReviewConfig({
    HOME: '/home/test',
    ENGINE_AUTH: 'bedrock',
    CODEX_BEDROCK_PROJECT: PROJECT,
    AWS_ACCESS_KEY_ID: KEY_ID,
    AWS_SECRET_ACCESS_KEY: SECRET,
  })
  const auth = await resolveBedrockAuth(config, 'codex', 'run', exec)
  t.equal(calls.length, 0, 'no subprocess')
  t.deepEqual(auth.credentials, { accessKeyId: KEY_ID, secretAccessKey: SECRET })
  t.end()
})

// The wiring the daemon and CLI share: subscription mode must never mint (or shell out), and
// bedrock mode must resolve through the role.
test('makeEngineAuth resolves nothing in subscription mode and mints in bedrock mode', async t => {
  const { exec, calls } = stsExec()
  t.equal(await makeEngineAuth(loadReviewConfig({ HOME: '/home/test' }), exec)('codex', 'run'), undefined)
  t.equal(calls.length, 0, 'subscription mode never calls sts')
  const auth = await makeEngineAuth(bedrockConfig(), exec)('codex', 'run')
  t.equal(auth?.model, 'openai.gpt-5.6-terra')
  t.equal(calls.length, 1)
  t.end()
})

// A config with neither a role nor static keys cannot happen through loadReviewConfig, but a
// hand-built config must still fail with a clear error rather than run the engine unauthenticated.
test('resolveBedrockAuth throws when no credential source is configured', async t => {
  const config = { ...bedrockConfig(), engineRoleArn: '', engineAwsStatic: undefined }
  try {
    await resolveBedrockAuth(config, 'claude', 'run', stsExec().exec)
    t.fail('should throw')
  } catch (error) {
    t.ok(/no engine credentials/.test((error as Error).message))
  }
  t.end()
})

// STS rejects a second AssumeRole hop above one hour even if the target role allows four hours.
test('resolveBedrockAuth supports an assumed-role source with the default run timeout', async t => {
  const response = stsExec()
  const exec: Exec = async (file, args) => {
    const seconds = Number(args[args.indexOf('--duration-seconds') + 1])
    if (seconds > 3600) {
      throw Object.assign(new Error('ValidationError'), {
        code: 254,
        stderr: 'The requested DurationSeconds exceeds the 1 hour session limit for roles assumed by role chaining.',
      })
    }
    return response.exec(file, args)
  }
  try {
    const auth = await resolveBedrockAuth(bedrockConfig({ ENGINE_AWS_PROFILE: 'operator-role' }), 'codex', 'chained', exec)
    t.equal(auth.credentials.accessKeyId, KEY_ID, 'credentials reach the engine')
  } catch (error) {
    t.fail((error as Error).message)
  }
  t.end()
})

// Only the role-chaining rejection earns the one-hour retry: any other STS failure (AccessDenied,
// an expired operator session) must surface after a single call, not be masked by a second attempt.
test('resolveBedrockAuth does not retry a non-chaining assume-role failure', async t => {
  const durations: number[] = []
  const exec: Exec = async (_file, args) => {
    durations.push(Number(args[args.indexOf('--duration-seconds') + 1]))
    throw Object.assign(new Error('AccessDenied'), { code: 254, stderr: 'An error occurred (AccessDenied) when calling the AssumeRole operation' })
  }
  try {
    await resolveBedrockAuth(bedrockConfig({ ENGINE_AWS_PROFILE: 'operator' }), 'claude', 'denied', exec)
    t.fail('expected the mint to fail')
  } catch (error) {
    t.match((error as Error).message, /AccessDenied/, 'the STS reason surfaces')
  }
  t.equal(durations.length, 1, 'assume-role ran exactly once')
  t.end()
})
