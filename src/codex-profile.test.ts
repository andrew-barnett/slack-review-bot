import { spawnSync } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import test from 'tape'

const SCRIPT = path.join(__dirname, '..', 'scripts', 'install-codex-profile.sh')

function setup(inside: boolean) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codex-profile-test-')))
  const probe = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-root-'))
  if (inside) fs.writeFileSync(path.join(probe, '.dockerenv'), '')
  const codexHome = path.join(home, '.codex')
  const run = (args: string[]) =>
    spawnSync(SCRIPT, args, { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: home, CODEX_HOME: codexHome, CONTAINER_PROBE_ROOT: probe } })
  return { file: path.join(codexHome, 'review-bot.config.toml'), run }
}

// Spec D4: in the container Codex runs with danger-full-access, and model-generated shell commands
// must not see the engine's AWS session (exclude AWS_*). Regression caught: a container profile that
// hands the Bedrock credentials to every command the model runs.
test('install-codex-profile --container writes full access with AWS_* excluded', t => {
  const { file, run } = setup(true)
  const out = run(['--container'])
  t.equal(out.status, 0, out.stderr)
  const text = fs.readFileSync(file, 'utf8')
  t.match(text, /^sandbox_mode = "danger-full-access"$/m)
  t.match(text, /^exclude = \["AWS_\*"\]$/m)
  t.notOk(/writable_roots/.test(text), 'no writable_roots under full access')
  t.end()
})

// The container check fails outside a container (except during docker build), and a container
// profile missing the AWS_* exclusion is rejected.
test('install-codex-profile --container --check guards the environment and the exclusion', t => {
  const inside = setup(true)
  t.equal(inside.run(['--container']).status, 0)
  fs.writeFileSync(inside.file, fs.readFileSync(inside.file, 'utf8').replace('exclude = ["AWS_*"]', ''))
  const missing = inside.run(['--container', '--check'])
  t.equal(missing.status, 1)
  t.match(missing.stderr, /AWS_\*/)

  const outside = setup(false)
  t.equal(outside.run(['--container', '--build']).status, 0, 'docker build has no /.dockerenv')
  const check = outside.run(['--container', '--check'])
  t.equal(check.status, 1)
  t.match(check.stderr, /only be installed inside a container/)
  t.end()
})

// The laptop profile must never be full access: a host --check on a container rendering fails.
test('install-codex-profile host check rejects danger-full-access', t => {
  const { file, run } = setup(true)
  t.equal(run(['--container']).status, 0)
  const out = run(['--check'])
  t.equal(out.status, 1)
  t.match(out.stderr, /danger-full-access/)
  t.ok(fs.existsSync(file))
  t.end()
})
