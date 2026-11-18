import test from 'tape'
import { loadReviewConfig } from './config'
import { agentTools, wantedEmoji } from './doctor'
import {
  PROBE_EVENT,
  checkChildEnvIsolation,
  checkRoleIdentity,
  classifyProbe,
  ghEnvAs,
  lookupLogin,
  probeEngineReadOnly,
} from './doctor-dual'
import type { GhCallOptions, GhRunner } from './gh-api'

const APPROVER = 'approver-placeholder-value'
const ENGINE = 'engine-placeholder-value'
const dual = loadReviewConfig({
  HOME: '/home/u',
  REVIEW_ENGINES: 'codex,claude',
  APPROVER_GH_TOKEN: APPROVER,
  ENGINE_GH_TOKEN: ENGINE,
})
const single = loadReviewConfig({ HOME: '/home/u' })

/** A gh runner that fails the way gh does, with "(HTTP nnn)" on stderr. */
function failingWith(status: number, calls: { args: string[]; opts?: GhCallOptions }[] = []): GhRunner {
  return async (args, opts) => {
    calls.push({ args, opts })
    throw Object.assign(new Error('gh: exit 1'), { stderr: `gh: request failed (HTTP ${status})` })
  }
}

// Dual mode reacts with three more emoji; a preflight that only checks the v1 set passes while
// the gate's reactions fail at runtime.
test('wantedEmoji adds the gate emoji only in dual mode', t => {
  t.ok(wantedEmoji(dual).includes(dual.approvalPartialEmoji))
  t.ok(wantedEmoji(dual).includes(dual.headMovedEmoji))
  t.notOk(wantedEmoji(single).includes(single.approvalPartialEmoji))
  t.end()
})

// The agent PATH check must cover the Claude binary in dual mode, or the first dual review fails
// with spawn claude ENOENT after a clean preflight.
test('agentTools adds claude only in dual mode', t => {
  t.ok(agentTools(dual).includes('claude'))
  t.notOk(agentTools(single).includes('claude'))
  t.end()
})

// Each lookup must run as exactly one identity: a stray GITHUB_TOKEN or a daemon token in the
// base would let the "operator" lookup authenticate as the role account and hide a collision.
test('ghEnvAs keeps exactly one GitHub identity', t => {
  const base = { PATH: '/bin', GH_TOKEN: 'x', GITHUB_TOKEN: 'y', GH_ENTERPRISE_TOKEN: 'z', APPROVER_GH_TOKEN: 'a', ENGINE_GH_TOKEN: 'e' }
  t.deepEqual(ghEnvAs(base), { PATH: '/bin' }, 'no token: gh falls back to its own login')
  t.deepEqual(ghEnvAs(base, 'only'), { PATH: '/bin', GH_TOKEN: 'only' })
  t.end()
})

// lookupLogin is called three times in parallel; one failure must become a result, not a
// rejection that takes the whole doctor run down.
test('lookupLogin returns an error instead of throwing', async t => {
  t.deepEqual(await lookupLogin(async () => '{"login":"role-bot"}', {}), { login: 'role-bot' })
  const failed = await lookupLogin(failingWith(401), {})
  t.ok('error' in failed && /HTTP 401/.test(failed.error))
  t.end()
})

// The role-account rule: both tokens one login, and that login is not the operator. Regression
// caught: the approver token created under the operator's own account, so every approval on the
// operator's PRs is a self-approval that never counts.
test('checkRoleIdentity enforces one role account distinct from the operator', t => {
  const role = { login: 'role-bot' }
  t.equal(checkRoleIdentity(role, { login: 'Role-Bot' }, { login: 'operator' }).status, 'ok', 'logins compare case-insensitively')
  t.equal(checkRoleIdentity(role, { login: 'someone-else' }, { login: 'operator' }).status, 'fail', 'two different accounts')
  t.equal(checkRoleIdentity(role, role, { login: 'role-bot' }).status, 'fail', 'the role account is the operator')
  t.equal(checkRoleIdentity({ error: 'HTTP 401' }, role, { login: 'operator' }).status, 'fail', 'a dead approver token')
  t.equal(checkRoleIdentity(role, role, { error: 'not logged in' }).status, 'warn', 'operator unknown is unverifiable, not wrong')
  t.end()
})

// The V4 probe reads only the status: 403 is the only pass. Regression caught: treating any
// error as "cannot write", which passes a write-capable token whenever the probe PR is missing.
test('classifyProbe passes only a 403', t => {
  t.equal(classifyProbe({ status: 403 }).status, 'ok')
  t.equal(classifyProbe({ status: 422 }).status, 'fail', 'write-capable')
  t.equal(classifyProbe({ status: 404 }).status, 'fail', 'probe PR not readable')
  t.equal(classifyProbe({ status: undefined }).status, 'fail', 'a network failure')
  t.equal(classifyProbe({ accepted: true }).status, 'fail', 'a review was created')
  t.end()
})

// The probe must go out as the engine token, to the reviews endpoint, with an event GitHub
// rejects, so a write-capable token can never create a review.
test('probeEngineReadOnly posts an invalid event as the engine token', async t => {
  const calls: { args: string[]; opts?: GhCallOptions }[] = []
  const result = await probeEngineReadOnly(failingWith(403, calls), { PATH: '/bin', GH_TOKEN: 'operator' }, ENGINE, 'https://github.com/o/r/pull/7')
  t.equal(result.status, 'ok')
  t.deepEqual(calls[0].args, ['api', 'repos/o/r/pulls/7/reviews', '--method', 'POST', '--input', '-'])
  t.deepEqual(JSON.parse(calls[0].opts?.input ?? '{}'), { event: PROBE_EVENT })
  t.equal(calls[0].opts?.env?.GH_TOKEN, ENGINE, 'runs as the engine token, not the operator')
  t.end()
})

// An unset or malformed probe PR fails in dual mode: the read-only property is load-bearing and
// must not silently go unchecked.
test('probeEngineReadOnly fails without a usable probe PR', async t => {
  t.equal((await probeEngineReadOnly(failingWith(403), {}, ENGINE, undefined)).status, 'fail')
  t.equal((await probeEngineReadOnly(failingWith(403), {}, ENGINE, 'not a url')).status, 'fail')
  t.end()
})

// The real child-env builders keep the approver token out of both engines.
test('checkChildEnvIsolation passes with the real env builders', t => {
  const result = checkChildEnvIsolation(dual, { PATH: '/bin', HOME: '/home/u' })
  t.equal(result.status, 'ok')
  t.end()
})

// The by-value half: the same PAT as both tokens reaches the engine as GH_TOKEN. loadReviewConfig
// already refuses that, so this builds the config by hand: the doctor check is the second layer
// and must hold even if the config guard regresses. The detail never prints the value.
test('checkChildEnvIsolation catches the approver token by value', t => {
  const same = { ...dual, engineGhToken: APPROVER }
  const result = checkChildEnvIsolation(same, { PATH: '/bin' })
  t.equal(result.status, 'fail')
  t.ok(result.detail.includes('GH_TOKEN'))
  t.notOk(result.detail.includes(APPROVER), 'the value is never printed')
  t.end()
})

// A passthrough an operator adds that happens to hold the approver PAT is a leak by value even
// though its name is innocent.
test('checkChildEnvIsolation catches the approver token under a passthrough name', t => {
  const leaky = loadReviewConfig({
    HOME: '/home/u',
    REVIEW_ENGINES: 'codex,claude',
    APPROVER_GH_TOKEN: APPROVER,
    ENGINE_GH_TOKEN: ENGINE,
    CODEX_ENV_PASSTHROUGH: 'MY_TOOL_TOKEN',
  })
  const result = checkChildEnvIsolation(leaky, { PATH: '/bin', MY_TOOL_TOKEN: APPROVER })
  t.equal(result.status, 'fail')
  t.ok(result.detail.includes('codex via MY_TOOL_TOKEN'))
  t.ok(result.detail.includes('claude via MY_TOOL_TOKEN'))
  t.end()
})
