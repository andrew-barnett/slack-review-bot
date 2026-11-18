// The dual-mode preflight checks (spec 5.10). Kept apart from doctor.ts so each check is a pure
// function, or takes an injected gh runner, and can be tested without Slack or the network.
//
// None of these checks writes anything. The engine-token probe posts a review with an event
// GitHub rejects, so the only possible outcomes are a 403 (no write access) or a 422 (write
// access, invalid body): no review is ever created.

import { buildClaudeEnv } from './claude'
import { buildChildEnv, withEngineGhToken, withGitSigningDisabled } from './codex'
import { APPROVER_TOKEN_VAR, DAEMON_SECRET_VARS, ENGINE_TOKEN_VAR, type ReviewConfig } from './config'
import { ghApi, type GhRunner } from './gh-api'
import { extractPullRequests } from './parse-message'
import type { CheckResult } from './doctor'

/** A doctor-only setting: an open PR the role account can read, used by the read-only probe. */
export const DOCTOR_PROBE_PR_VAR = 'DOCTOR_PROBE_PR'

/** A review event GitHub does not accept, so a write-capable token gets a 422 and nothing is posted. */
export const PROBE_EVENT = 'DOCTOR_READ_ONLY_PROBE'

/**
 * The environment for one `gh` call as one identity. Every GitHub token variable and every daemon
 * secret is removed first, so the call cannot fall back to a different identity. With no token,
 * gh uses its own stored login: the operator.
 */
export function ghEnvAs(base: NodeJS.ProcessEnv, token?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base }
  delete env.GH_TOKEN
  delete env.GITHUB_TOKEN
  delete env.GH_ENTERPRISE_TOKEN
  for (const name of DAEMON_SECRET_VARS) delete env[name]
  if (token !== undefined) env.GH_TOKEN = token
  return env
}

/** A runner that pins every call to one environment. */
function runnerAs(run: GhRunner, env: NodeJS.ProcessEnv): GhRunner {
  return (args, opts = {}) => run(args, { ...opts, env })
}

export type LoginLookup = { login: string } | { error: string }

/** `GET /user` as the identity `env` carries; never throws. */
export async function lookupLogin(run: GhRunner, env: NodeJS.ProcessEnv): Promise<LoginLookup> {
  try {
    return { login: (await ghApi<{ login: string }>(runnerAs(run, env), 'user')).login }
  } catch (error) {
    return { error: (error as Error).message }
  }
}

/**
 * Both tokens must belong to the role account, and the role account must not be the operator:
 * an approval from the operator's own login is not an independent review, and on the operator's
 * own PRs it is a self-approval that never counts.
 */
export function checkRoleIdentity(approver: LoginLookup, engine: LoginLookup, operator: LoginLookup): CheckResult {
  const name = 'role account'
  if ('error' in approver) return { name, status: 'fail', detail: `${APPROVER_TOKEN_VAR}: GET /user failed: ${approver.error}` }
  if ('error' in engine) return { name, status: 'fail', detail: `${ENGINE_TOKEN_VAR}: GET /user failed: ${engine.error}` }
  if (approver.login.toLowerCase() !== engine.login.toLowerCase()) {
    return {
      name,
      status: 'fail',
      detail: `${APPROVER_TOKEN_VAR} is ${approver.login} but ${ENGINE_TOKEN_VAR} is ${engine.login} — both must be the role account`,
    }
  }
  if ('error' in operator) {
    // Unverifiable is not safe: this is the only guard against the role account being the operator
    // (self-approvals that never count), so a skipped comparison must not pass.
    return {
      name,
      status: 'fail',
      detail: `the operator's gh login is unreadable (${operator.error}), so the role account cannot be checked against it — make the operator's gh login readable to the doctor (gh auth login as the operator, with gh on the doctor's PATH)`,
    }
  }
  if (operator.login.toLowerCase() === approver.login.toLowerCase()) {
    return {
      name,
      status: 'fail',
      detail: `${approver.login} is also the operator's gh login — the tokens must belong to a separate role account`,
    }
  }
  return { name, status: 'ok', detail: `${approver.login} (both tokens); the operator is ${operator.login}` }
}

/** Read the probe's HTTP status. `undefined` with `accepted` means the POST succeeded. */
export function classifyProbe(outcome: { accepted: true } | { status: number | undefined }): CheckResult {
  const name = 'engine token read-only'
  if ('accepted' in outcome) {
    return { name, status: 'fail', detail: `GitHub accepted the probe review — ${ENGINE_TOKEN_VAR} can write; delete that review and replace the token` }
  }
  if (outcome.status === 403) {
    return { name, status: 'ok', detail: `${ENGINE_TOKEN_VAR} cannot submit reviews (HTTP 403)` }
  }
  if (outcome.status === 422) {
    return {
      name,
      status: 'fail',
      detail: `${ENGINE_TOKEN_VAR} can submit reviews (HTTP 422 on an invalid event) — use a read-only fine-grained token`,
    }
  }
  return {
    name,
    status: 'fail',
    detail: `the probe returned ${outcome.status === undefined ? 'no HTTP status' : `HTTP ${outcome.status}`} — cannot confirm ${ENGINE_TOKEN_VAR} is read-only`,
  }
}

/** The V4 probe (spec section 8): POST a review with an invalid event as the engine token. */
export async function probeEngineReadOnly(
  run: GhRunner,
  base: NodeJS.ProcessEnv,
  engineToken: string,
  probePr: string | undefined
): Promise<CheckResult> {
  const name = 'engine token read-only'
  if (!probePr) {
    return {
      name,
      status: 'fail',
      detail: `${DOCTOR_PROBE_PR_VAR} is unset — set it to an open pull request the role account can read`,
    }
  }
  const [ref] = extractPullRequests(probePr)
  if (!ref) return { name, status: 'fail', detail: `${DOCTOR_PROBE_PR_VAR} is not a pull request URL` }
  try {
    await ghApi(runnerAs(run, ghEnvAs(base, engineToken)), `repos/${ref.owner}/${ref.repo}/pulls/${ref.number}/reviews`, {
      method: 'POST',
      body: { event: PROBE_EVENT },
    })
    return classifyProbe({ accepted: true })
  } catch (error) {
    // A 2xx whose body would not parse threw SyntaxError after GitHub accepted the request: that
    // is a created review, not a missing status.
    if (error instanceof SyntaxError) return classifyProbe({ accepted: true })
    return classifyProbe({ status: (error as { status?: number }).status })
  }
}

/**
 * Build both engines' child environments the way the runners do, from a base that deliberately
 * holds the approver token, and confirm it reaches neither: not under its own name, and not as the
 * value of any other variable (an operator passthrough, or the engine token set to the same PAT).
 * Reports variable names only, never values.
 */
export function checkChildEnvIsolation(
  config: Pick<ReviewConfig, 'approverGhToken' | 'engineGhToken' | 'codexEnvPassthrough' | 'claudeConfigDir' | 'disableGitSigning'>,
  base: NodeJS.ProcessEnv
): CheckResult {
  const name = 'engine env isolation'
  if (!config.approverGhToken) return { name, status: 'fail', detail: `${APPROVER_TOKEN_VAR} is unset` }
  const seeded: NodeJS.ProcessEnv = {
    ...base,
    [APPROVER_TOKEN_VAR]: config.approverGhToken,
    [ENGINE_TOKEN_VAR]: config.engineGhToken,
  }
  let codexEnv = buildChildEnv(seeded, config.codexEnvPassthrough)
  if (config.disableGitSigning) codexEnv = withGitSigningDisabled(codexEnv)
  codexEnv = withEngineGhToken(codexEnv, config.engineGhToken)
  const claudeEnv = buildClaudeEnv(seeded, {
    configDir: config.claudeConfigDir,
    engineGhToken: config.engineGhToken,
    envPassthrough: config.codexEnvPassthrough,
    disableGitSigning: config.disableGitSigning,
  })

  const leaks: string[] = []
  for (const [engine, env] of [['codex', codexEnv], ['claude', claudeEnv]] as const) {
    const keys = Object.entries(env)
      .filter(([key, value]) => key === APPROVER_TOKEN_VAR || (value !== undefined && value.includes(config.approverGhToken)))
      .map(([key]) => key)
    if (keys.length) leaks.push(`${engine} via ${keys.join(', ')}`)
  }
  if (leaks.length) {
    return { name, status: 'fail', detail: `the approver token reaches an engine: ${leaks.join('; ')}` }
  }
  return { name, status: 'ok', detail: 'the approver token is absent from both engine environments, by name and by value' }
}
