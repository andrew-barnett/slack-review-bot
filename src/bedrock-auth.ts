// Engine credentials for AWS Bedrock mode (ENGINE_AUTH=bedrock, issue #69).
//
// In bedrock mode both engines call their models through Bedrock instead of the operator's
// subscriptions. The daemon mints short-lived credentials for a role that can only invoke models
// (`aws sts assume-role`, once per engine attempt so a retry gets a fresh session), or, with no role
// configured, uses static credentials a launcher injected. Those credentials reach an engine child
// only through the env builders here, never through the daemon's own environment.
//
// Security: the subprocess runs through execFile, never a shell. Its stdout carries the credentials,
// so it is parsed and discarded and never appears in an error or a log; on failure only the first
// line of STS's stderr (the AccessDenied or expired-token reason) is reported. Every minted value is
// registered with the redactor, so a PR that prints the engine's environment cannot publish it.

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { EngineName, ReviewConfig } from './config'
import { redactSecrets, registerHeldSecret } from './redact'
import type { Exec } from './registry-auth'

const execFileAsync = promisify(execFile)

const defaultExec: Exec = (file, args) => execFileAsync(file, args, { timeout: 60_000 })

export interface AwsCredentials {
  accessKeyId: string
  secretAccessKey: string
  sessionToken?: string
  /** ISO timestamp the credentials expire at; absent for static keys. */
  expiration?: string
}

/**
 * The environment an `aws` command runs with when it must act as exactly one session: PATH and HOME,
 * the session's keys and region, and every profile file switched off, so no profile, config or
 * credentials file can substitute another identity. Used by the worker doctor and the launcher.
 */
export function awsSessionEnv(base: NodeJS.ProcessEnv, creds: AwsCredentials, region: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { PATH: base.PATH, HOME: base.HOME }
  env.AWS_CONFIG_FILE = '/dev/null'
  env.AWS_SHARED_CREDENTIALS_FILE = '/dev/null'
  env.AWS_REGION = region
  env.AWS_ACCESS_KEY_ID = creds.accessKeyId
  env.AWS_SECRET_ACCESS_KEY = creds.secretAccessKey
  if (creds.sessionToken) env.AWS_SESSION_TOKEN = creds.sessionToken
  return env
}

/** What one engine attempt needs to reach its model on Bedrock. */
export interface BedrockAuth {
  region: string
  model: string
  credentials: AwsCredentials
  /** Codex only: CODEX_BEDROCK_CONTEXT_WINDOW, when configured. */
  contextWindow?: number
}

/** STS's minimum session, and the slack added on top of the run timeout. */
const MIN_SESSION_SECONDS = 900
/** The engine role's maximum session (4 hours). */
const MAX_SESSION_SECONDS = 14400
/** STS's cap on a session reached by role chaining (the source credentials are themselves a role). */
const CHAINED_SESSION_SECONDS = 3600
/** STS's limit on a role session name. */
const MAX_SESSION_NAME = 64
/** The prefix of the error every assume-role failure carries. */
const ASSUME_FAILED = 'could not assume the engine role'
/** Region and model IDs are interpolated into TOML overrides; only this charset is safe. */
const TOML_SAFE_ID = /^[A-Za-z0-9._:-]+$/
/** The variables the engine credentials travel in. */
const AWS_KEY_VARS = ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN'] as const

/**
 * How long a minted session should last: the whole run timeout plus 15 minutes of slack, so the
 * credentials outlive the run they serve, clamped to STS's 15-minute minimum and the role's maximum.
 */
export function engineSessionSeconds(runTimeoutMs: number): number {
  const wanted = Math.ceil(runTimeoutMs / 1000) + MIN_SESSION_SECONDS
  return Math.min(Math.max(wanted, MIN_SESSION_SECONDS), MAX_SESSION_SECONDS)
}

/** A role session name STS accepts (`[\w+=,.@-]`, at most 64 characters), built from the runId. */
export function engineSessionName(runId: string): string {
  return `slack-review-bot-${runId.replace(/[^\w+=,.@-]/g, '-')}`.slice(0, MAX_SESSION_NAME)
}

export interface AssumeEngineRoleOptions {
  roleArn: string
  /** The operator profile to call STS with; empty uses the AWS CLI's default chain. */
  profile: string
  region: string
  durationSeconds: number
  sessionName: string
  /** Injection seam for the subprocess, so tests need not spawn `aws`. */
  exec?: Exec
}

/** The first line of a failed command's stderr, capped; never its stdout. */
function stderrReason(error: unknown): string {
  const stderr = (error as { stderr?: unknown }).stderr
  const line = typeof stderr === 'string' ? stderr.split(/\r?\n/).find(l => l.trim()) ?? '' : ''
  if (line) return redactSecrets(line.trim().slice(0, 300))
  const code = (error as { code?: unknown }).code
  return code === undefined ? 'aws sts assume-role failed' : `aws sts assume-role failed (exit ${String(code)})`
}

/** Mint engine credentials with `aws sts assume-role`. Throws a credential-free error on failure. */
export async function assumeEngineRole(options: AssumeEngineRoleOptions): Promise<AwsCredentials> {
  const exec = options.exec ?? defaultExec
  const args = [
    'sts', 'assume-role',
    '--role-arn', options.roleArn,
    '--role-session-name', options.sessionName,
    '--duration-seconds', String(options.durationSeconds),
    '--region', options.region,
    '--output', 'json',
  ]
  if (options.profile) args.push('--profile', options.profile)
  let stdout: string
  try {
    stdout = (await exec('aws', args)).stdout
  } catch (error) {
    throw new Error(`${ASSUME_FAILED}: ${stderrReason(error)}`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch {
    // The response is not quoted: it may hold a partial credential.
    throw new Error(`${ASSUME_FAILED}: sts returned a response that is not JSON`)
  }
  const c = (parsed as { Credentials?: Record<string, unknown> } | null)?.Credentials
  const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined)
  const accessKeyId = str(c?.AccessKeyId)
  const secretAccessKey = str(c?.SecretAccessKey)
  const sessionToken = str(c?.SessionToken)
  if (!accessKeyId || !secretAccessKey || !sessionToken) {
    throw new Error(`${ASSUME_FAILED}: sts response is missing credential fields`)
  }
  const expiration = str(c?.Expiration)
  return { accessKeyId, secretAccessKey, sessionToken, ...(expiration ? { expiration } : {}) }
}

/** Copy `env` with the credentials' AWS variables set, the profile variables removed, and the region. */
function withAwsCredentials(env: NodeJS.ProcessEnv, auth: BedrockAuth): NodeJS.ProcessEnv {
  const copy: NodeJS.ProcessEnv = { ...env }
  // A profile would let the AWS chain prefer the operator's own credentials over the minted ones.
  delete copy.AWS_PROFILE
  delete copy.AWS_DEFAULT_PROFILE
  // Cleared first, so a stale session token is never paired with static keys that have none.
  for (const name of AWS_KEY_VARS) delete copy[name]
  copy.AWS_REGION = auth.region
  copy.AWS_ACCESS_KEY_ID = auth.credentials.accessKeyId
  copy.AWS_SECRET_ACCESS_KEY = auth.credentials.secretAccessKey
  if (auth.credentials.sessionToken) copy.AWS_SESSION_TOKEN = auth.credentials.sessionToken
  return copy
}

/**
 * The Claude child's environment in bedrock mode: Bedrock on, the model and region set, the minted
 * AWS credentials in, and every other credential path (OAuth token, API key, profiles) out, so
 * exactly one reaches the child. Returns a copy.
 */
export function withBedrockClaudeEnv(env: NodeJS.ProcessEnv, auth: BedrockAuth): NodeJS.ProcessEnv {
  const copy = withAwsCredentials(env, auth)
  delete copy.CLAUDE_CODE_OAUTH_TOKEN
  delete copy.ANTHROPIC_API_KEY
  copy.CLAUDE_CODE_USE_BEDROCK = '1'
  copy.ANTHROPIC_MODEL = auth.model
  return copy
}

/**
 * The Codex child's environment in bedrock mode. Codex reads Bedrock credentials from the standard
 * AWS environment; the `-c` overrides from {@link bedrockCodexArgs} hide them from its shell. Returns a copy.
 */
export function withBedrockCodexEnv(env: NodeJS.ProcessEnv, auth: BedrockAuth): NodeJS.ProcessEnv {
  return withAwsCredentials(env, auth)
}

/**
 * The `codex exec` config overrides for Bedrock (verified with codex-cli 0.169.0): the provider, the
 * model, the region, and an `AWS_*` exclude on the shell environment policy. The exclude is the
 * security-relevant one: the Codex process still signs with the credentials, but model-directed
 * shell commands and untrusted PR test code never see them.
 */
export function bedrockCodexArgs(auth: BedrockAuth): string[] {
  // Second guard behind config validation: the values are spliced into TOML strings.
  if (!TOML_SAFE_ID.test(auth.model)) throw new Error('Bedrock model ID contains characters unsafe for a Codex override')
  if (!TOML_SAFE_ID.test(auth.region)) throw new Error('Bedrock region contains characters unsafe for a Codex override')
  const args = [
    '-c', 'model_provider="amazon-bedrock-runtime"',
    '-c', `model="${auth.model}"`,
    '-c', `model_providers.amazon-bedrock-runtime.aws.region="${auth.region}"`,
    '-c', 'shell_environment_policy.exclude=["AWS_*"]',
  ]
  if (auth.contextWindow !== undefined) {
    if (!Number.isInteger(auth.contextWindow) || auth.contextWindow <= 0) {
      throw new Error('Codex Bedrock context window must be a positive integer')
    }
    args.push('-c', `model_context_window=${auth.contextWindow}`)
  }
  return args
}

/**
 * The per-attempt engine-auth resolver the daemon and CLI wire into the review runner: Bedrock auth
 * in bedrock mode, and always undefined in subscription mode, which leaves every run as it was.
 */
export function makeEngineAuth(
  config: ReviewConfig,
  exec?: Exec
): (engine: EngineName, runId: string) => Promise<BedrockAuth | undefined> {
  return config.engineAuth === 'bedrock'
    ? (engine, runId) => resolveBedrockAuth(config, engine, runId, exec)
    : () => Promise.resolve(undefined)
}

/**
 * The Bedrock auth for one engine attempt: freshly minted role credentials when ENGINE_ROLE_ARN is
 * set, otherwise the captured static credentials. Minted values are registered with the redactor.
 */
export async function resolveBedrockAuth(
  config: ReviewConfig,
  engine: EngineName,
  runId: string,
  exec?: Exec
): Promise<BedrockAuth> {
  let credentials: AwsCredentials
  if (config.engineRoleArn) {
    const assume = (durationSeconds: number) =>
      assumeEngineRole({
        roleArn: config.engineRoleArn,
        profile: config.engineAwsProfile,
        region: config.bedrockRegion,
        durationSeconds,
        sessionName: engineSessionName(runId),
        exec,
      })
    const wanted = engineSessionSeconds(config.runTimeoutMs)
    try {
      credentials = await assume(wanted)
    } catch (error) {
      // When ENGINE_AWS_PROFILE is itself an assumed role, this is a role-chaining hop, which STS
      // caps at one hour whatever the target role allows. Retry once at the cap rather than failing
      // every review; a run longer than an hour then fails on its model calls, which the README
      // documents (an IAM-user profile gets the full session).
      if (wanted <= CHAINED_SESSION_SECONDS || !/role chaining/i.test((error as Error).message)) throw error
      credentials = await assume(CHAINED_SESSION_SECONDS)
    }
  } else if (config.engineAwsStatic) {
    credentials = config.engineAwsStatic
  } else {
    throw new Error('ENGINE_AUTH=bedrock has no engine credentials: set ENGINE_ROLE_ARN or static AWS keys')
  }
  for (const value of [credentials.accessKeyId, credentials.secretAccessKey, credentials.sessionToken]) {
    registerHeldSecret(value)
  }
  const codex = engine === 'codex'
  return {
    region: config.bedrockRegion,
    model: codex ? config.codexBedrockModel : config.claudeBedrockModel,
    credentials,
    ...(codex && config.codexBedrockContextWindow !== undefined ? { contextWindow: config.codexBedrockContextWindow } : {}),
  }
}
