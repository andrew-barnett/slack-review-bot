import test from 'tape'
import {
  checkDaemonSecretsAbsent,
  checkEngineRole,
  checkGhLoggedOut,
  checkNoDockerSocket,
  checkPidNamespace,
  checkSecretsDenied,
  checkTokenIdentity,
  engineAwsEnv,
  parseDoctorRole,
  type ContainerProbe,
} from './doctor-container'

type Reply = { code: number; output: string }

/** A clean worker: every probe answers as the spec's acceptance criteria want. */
function probe(over: Partial<ContainerProbe> = {}, replies: Record<string, Reply> = {}): ContainerProbe & { calls: string[]; envs: (NodeJS.ProcessEnv | undefined)[] } {
  const calls: string[] = []
  const envs: (NodeJS.ProcessEnv | undefined)[] = []
  const defaults: Record<string, Reply> = {
    grep: { code: 1, output: '' },
    'gh auth': { code: 1, output: 'You are not logged into any GitHub hosts.' },
    'aws sts': { code: 0, output: '{"Arn":"arn:aws:sts::153538148884:assumed-role/SlackReviewBotEngineRole/slack-review-bot-worker"}' },
    'aws secretsmanager': { code: 254, output: 'An error occurred (AccessDeniedException) when calling the DescribeSecret operation' },
  }
  return {
    calls,
    envs,
    env: { HOME: '/home/bot', ROLE_GH_LOGIN: 'role-bot', OPERATOR_GH_LOGIN: 'operator' },
    exists: () => false,
    readFile: p => (p === '/proc/1/cmdline' ? '/usr/bin/tini\0--\0srb-entrypoint' : undefined),
    runCommand: async (command, args, env) => {
      const key = `${command} ${args[0]}`
      calls.push(`${key} ${args.slice(1).join(' ')}`)
      envs.push(env)
      return replies[key] ?? replies[command] ?? defaults[key] ?? defaults[command] ?? { code: 0, output: '' }
    },
    lookupLogin: async () => ({ login: 'role-bot' }),
    ...over,
  }
}

const status = (r: { status: string }) => r.status

// Spec 3.7, first criterion: no daemon secret in the worker's env or files, and no /run/secrets.
// Each injected condition must fail the check. Regression caught: an approver or Slack token
// reaching the container that runs PR code.
test('checkDaemonSecretsAbsent fails on an env name, a file hit, or /run/secrets', async t => {
  t.equal(status(await checkDaemonSecretsAbsent(probe())), 'ok')
  t.equal(status(await checkDaemonSecretsAbsent(probe({ env: { SLACK_BOT_TOKEN: 'x' } }))), 'fail')
  t.equal(status(await checkDaemonSecretsAbsent(probe({ env: { LAUNCH_KEY: 'x' } }))), 'fail')
  t.equal(status(await checkDaemonSecretsAbsent(probe({ exists: p => p === '/run/secrets' }))), 'fail')
  const hit = await checkDaemonSecretsAbsent(probe({}, { grep: { code: 0, output: '/tmp/leak.txt\n' } }))
  t.equal(hit.status, 'fail')
  t.match(hit.detail, /\/tmp\/leak\.txt/)
  // A scan that could not run is unknown, never "clean".
  t.equal(status(await checkDaemonSecretsAbsent(probe({}, { grep: { code: 2, output: 'grep: error' } }))), 'fail')
  t.end()
})

// Spec 3.7: `gh auth status` with GH_TOKEN unset must report not logged in.
test('checkGhLoggedOut fails when gh has a stored login', async t => {
  const p = probe({ env: { GH_TOKEN: 'should-be-stripped', GITHUB_TOKEN: 'also-stripped' } })
  t.equal(status(await checkGhLoggedOut(p)), 'ok')
  // The check is only meaningful with the token variables removed: gh would otherwise report the
  // per-call token as a login (or hide a stored one behind it).
  t.equal(p.envs.length, 1)
  t.notOk(p.envs[0] && 'GH_TOKEN' in p.envs[0], 'GH_TOKEN is not passed to gh')
  t.notOk(p.envs[0] && 'GITHUB_TOKEN' in p.envs[0], 'GITHUB_TOKEN is not passed to gh')
  t.equal(status(await checkGhLoggedOut(probe({}, { 'gh auth': { code: 0, output: 'Logged in to github.com' } }))), 'fail')
  t.end()
})

// Spec 3.7: the worker's AWS identity is the engine role and nothing else, and that role cannot
// read the bot's secrets.
test('checkEngineRole and checkSecretsDenied fail on the wrong identity or a readable secret', async t => {
  const env = engineAwsEnv({ PATH: '/usr/bin' }, { accessKeyId: 'a', secretAccessKey: 's', sessionToken: 't' }, 'us-east-2')
  t.equal(env.AWS_CONFIG_FILE, '/dev/null', 'no profile can override the engine session')
  const roleProbe = probe()
  t.equal(status(await checkEngineRole(roleProbe, env)), 'ok')
  t.equal(roleProbe.envs[0], env, 'sts runs with the engine session env, not the process env')
  const deniedProbe = probe()
  await checkSecretsDenied(deniedProbe, env, 'us-east-2')
  t.equal(deniedProbe.envs[0], env, 'describe-secret runs with the engine session env')
  const operator = probe({}, { 'aws sts': { code: 0, output: '{"Arn":"arn:aws:iam::153538148884:user/operator"}' } })
  t.equal(status(await checkEngineRole(operator, env)), 'fail')
  t.equal(status(await checkSecretsDenied(probe(), env, 'us-east-2')), 'ok')
  t.equal(status(await checkSecretsDenied(probe({}, { 'aws secretsmanager': { code: 0, output: '{"Name":"x"}' } }), env, 'us-east-2')), 'fail')
  const network = probe({}, { 'aws secretsmanager': { code: 255, output: 'Could not connect to the endpoint URL' } })
  t.equal(status(await checkSecretsDenied(network, env, 'us-east-2')), 'fail', 'a network error is not a denial')
  t.end()
})

// Spec 3.7: the worker sees only its own PID namespace (PID 1 is its init), and no Docker socket.
test('checkPidNamespace and checkNoDockerSocket fail on the host view', async t => {
  t.equal(status(checkPidNamespace(probe())), 'ok')
  t.equal(status(checkPidNamespace(probe({ readFile: () => '/sbin/launchd' }))), 'fail')
  t.equal(status(checkPidNamespace(probe({ readFile: () => undefined }))), 'fail')
  t.equal(status(checkNoDockerSocket(probe())), 'ok')
  t.equal(status(checkNoDockerSocket(probe({ exists: p => p === '/var/run/docker.sock' }))), 'fail')
  t.end()
})

// Ruling 8: each container checks its own token is the role account and not the operator.
test('checkTokenIdentity requires the role login and rejects the operator', async t => {
  t.equal(status(await checkTokenIdentity(probe(), 'engine token', 'tok')), 'ok')
  t.equal(status(await checkTokenIdentity(probe({ lookupLogin: async () => ({ login: 'operator' }) }), 'engine token', 'tok')), 'fail')
  t.equal(status(await checkTokenIdentity(probe({ lookupLogin: async () => ({ login: 'someone' }) }), 'engine token', 'tok')), 'fail')
  t.equal(status(await checkTokenIdentity(probe({ lookupLogin: async () => ({ error: 'HTTP 401' }) }), 'engine token', 'tok')), 'fail')
  t.equal(status(await checkTokenIdentity(probe({ env: {} }), 'engine token', 'tok')), 'fail', 'ROLE_GH_LOGIN unset')
  t.equal(status(await checkTokenIdentity(probe({ env: { ROLE_GH_LOGIN: 'operator', OPERATOR_GH_LOGIN: 'operator' } }), 'engine token', 'tok')), 'fail')
  t.end()
})

// --role is strict: an unknown role is an error, not a silent host doctor.
test('parseDoctorRole accepts only the two roles', t => {
  t.equal(parseDoctorRole([]), undefined)
  t.equal(parseDoctorRole(['--role', 'worker']), 'worker')
  t.equal(parseDoctorRole(['--role=orchestrator']), 'orchestrator')
  t.throws(() => parseDoctorRole(['--role', 'launcher']), /--role/)
  t.throws(() => parseDoctorRole(['--role']), /--role/)
  t.end()
})
