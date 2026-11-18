import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import test from 'tape'
import { loadConfig, loadReviewConfig } from './config'
import { CHECK_COMMAND_TIMEOUT_MS, agentTools, checkClaudeProfile, checkDualMode, run, wantedEmoji } from './doctor'
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
  // An unreadable operator login (gh logged out, timed out, no auth under launchd) must fail: it is
  // the only guard against a self-approving role account, and a skipped comparison must not pass.
  t.equal(checkRoleIdentity(role, role, { error: 'not logged in' }).status, 'fail', 'operator unreadable fails closed')
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

// A probe the runner completes (exit 0), with a body that parses or not, means GitHub accepted the
// POST. Regression caught: an unparseable 2xx body surfaced as "no HTTP status", hiding that a
// review may have been created; it must be the loud "can write; delete that review" failure.
test('probeEngineReadOnly treats a completed probe as accepted, even with an unparseable body', async t => {
  const pr = 'https://github.com/o/r/pull/7'
  for (const body of ['{"id":1}', '', '<html>not json']) {
    const result = await probeEngineReadOnly(async () => body, {}, ENGINE, pr)
    t.equal(result.status, 'fail', `body ${JSON.stringify(body)} fails`)
    t.ok(result.detail.includes('can write'), `body ${JSON.stringify(body)} is reported as write-capable`)
  }
  t.end()
})

// Only 403 passes through the runner path: 422 (write-capable) and 404 (probe PR unreadable)
// must both fail, so a missing probe PR can never pass a write-capable token.
test('probeEngineReadOnly fails on 422 and 404', async t => {
  const pr = 'https://github.com/o/r/pull/7'
  t.equal((await probeEngineReadOnly(failingWith(422), {}, ENGINE, pr)).status, 'fail', '422')
  t.equal((await probeEngineReadOnly(failingWith(404), {}, ENGINE, pr)).status, 'fail', '404')
  t.end()
})

// run() must be bounded: a wedged `claude --version` or installer --check would otherwise hang the
// doctor forever. A command that never exits has to come back as a failed result.
test('run kills a command that never exits', async t => {
  t.ok(CHECK_COMMAND_TIMEOUT_MS > 0 && Number.isFinite(CHECK_COMMAND_TIMEOUT_MS), 'the default bound is finite')
  const result = await run(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { PATH: '/usr/bin' }, 300)
  t.equal(result.code, -1)
  t.ok(/timed out/.test(result.output))
  t.end()
})

// The installer check runs as bash → node; killing only bash left the grandchild holding the pipes,
// so 'close' never fired and the doctor hung despite the timeout. Regression caught: run() waiting
// on 'close' after the timer, and a SIGKILL that reached only the direct child.
test('run resolves on time and kills the group when a grandchild holds the pipes', async t => {
  const pidFile = path.join(os.tmpdir(), `srb-run-grandchild-${process.pid}-${Date.now()}`)
  const started = Date.now()
  const result = await run('/bin/bash', ['-c', `sleep 30 & echo $! > '${pidFile}'; wait`], { PATH: '/usr/bin:/bin' }, 500)
  const elapsed = Date.now() - started
  t.equal(result.code, -1)
  t.equal(result.output, 'timed out after 500ms')
  t.ok(elapsed < 3_000, `resolved within the bound (${elapsed}ms)`)
  const pid = Number(fs.readFileSync(pidFile, 'utf8').trim())
  fs.rmSync(pidFile, { force: true })
  // The grandchild was in the killed group; allow a moment for it to be reaped.
  let alive = true
  for (let i = 0; i < 20 && alive; i += 1) {
    try {
      process.kill(pid, 0)
      await new Promise(resolve => setTimeout(resolve, 50))
    } catch {
      alive = false
    }
  }
  t.notOk(alive, 'the sleeping grandchild was killed with the group')
  if (alive) process.kill(pid, 'SIGKILL')
  t.end()
})

const fullConfig = loadConfig({
  HOME: '/home/u',
  SLACK_BOT_TOKEN: 'xoxb-fake',
  SLACK_APP_TOKEN: 'xapp-fake',
  REVIEW_ENGINES: 'codex,claude',
  APPROVER_GH_TOKEN: APPROVER,
  ENGINE_GH_TOKEN: ENGINE,
  WORKSPACE_ROOT: '/ws/root',
  WORKTREE_ROOT: '/wt/root',
  CLAUDE_CONFIG_DIR_REVIEW: '/profile/dir',
})

// The installer must validate the same roots the engine runs with. Regression caught: omitting the
// roots lets --check validate the installer's defaults instead of the configured grants.
test('checkClaudeProfile passes the configured roots to the installer', async t => {
  const calls: string[][] = []
  const result = await checkClaudeProfile(fullConfig, async (_cmd, args) => {
    calls.push(args)
    return { code: 0, output: 'profile ok\n' }
  })
  t.equal(result.status, 'ok')
  const args = calls[0]
  t.equal(args[args.indexOf('--dir') + 1], '/profile/dir')
  t.equal(args[args.indexOf('--workspace-root') + 1], '/ws/root')
  t.equal(args[args.indexOf('--worktree-root') + 1], '/wt/root')
  t.ok(args.includes('--check'))
  t.end()
})

// A checker that fails without printing anything must still say why. Regression caught: `??` kept
// the empty string, producing a failure with a blank detail.
test('checkClaudeProfile falls back to the exit code on empty output', async t => {
  const failed = await checkClaudeProfile(fullConfig, async () => ({ code: 3, output: '  \n' }))
  t.equal(failed.status, 'fail')
  t.equal(failed.detail, 'exit 3')
  const ok = await checkClaudeProfile(fullConfig, async () => ({ code: 0, output: '' }))
  t.equal(ok.detail, 'valid')
  t.end()
})

// Each identity lookup must run under its own token. Regression caught: the approver lookup using
// the engine token (or the reverse) would pass the role-account check without testing the approver
// token at all. Tokens are identified by label only; no value is ever asserted or printed.
test('checkDualMode runs the approver lookup with the approver token', async t => {
  const labels: string[] = []
  const gh: GhRunner = async (args, opts) => {
    const token = opts?.env?.GH_TOKEN
    const label = token === APPROVER ? 'approver' : token === ENGINE ? 'engine' : 'none'
    if (args[1] === 'user') {
      labels.push(label)
      return JSON.stringify({ login: label === 'none' ? 'operator' : 'role-bot' })
    }
    throw Object.assign(new Error('gh: exit 1'), { stderr: 'gh: forbidden (HTTP 403)' })
  }
  const results = await checkDualMode(fullConfig, undefined, {
    gh,
    base: { PATH: '/bin' },
    runCommand: async () => ({ code: 0, output: 'ok' }),
  })
  t.deepEqual(labels, ['approver', 'engine', 'none'], 'approver, engine and operator lookups each use their own identity')
  t.equal(results.find(r => r.name === 'role account')?.status, 'ok')
  t.end()
})
