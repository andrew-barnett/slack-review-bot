import { spawnSync } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import test from 'tape'

const SCRIPT = path.join(__dirname, '..', 'scripts', 'install-claude-profile.sh')

/** A throwaway HOME with a fake review-pr skill and hook, and the dirs the profile must deny. */
function sandboxHome() {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'claude-profile-test-')))
  const skill = path.join(home, 'skills-src', 'review-pr')
  fs.mkdirSync(skill, { recursive: true })
  fs.writeFileSync(path.join(skill, 'SKILL.md'), '# review-pr\n')
  const hook = path.join(home, 'hooks-src', 'block-secret-reads.py')
  fs.mkdirSync(path.dirname(hook), { recursive: true })
  fs.writeFileSync(hook, '# hook\n')
  const dir = path.join(home, 'profile')
  const args = [
    '--dir', dir,
    '--workspace-root', path.join(home, 'src'),
    '--worktree-root', path.join(home, 'wt'),
    '--skill-src', skill,
    '--hook-src', hook,
    '--env-file', path.join(home, 'daemon-config', 'env'),
    '--gh-config-dir', path.join(home, 'gh-config'),
  ]
  const run = (extra: string[] = []) =>
    spawnSync(SCRIPT, [...args, ...extra], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: home } })
  return { home, dir, run }
}

// The engine profile is the Claude engine's whole isolation story (spec 5.5, 9). Both read-deny
// layers must name the daemon's config dir and the gh config dir: denyRead alone does not stop the
// in-process Read tool (V2 spike). Regression caught: a profile that leaks the approver token file
// or the operator's gh login to untrusted PR code.
test('install-claude-profile writes both read-deny layers, the sandbox and the hook', t => {
  const { home, dir, run } = sandboxHome()
  const out = run()
  t.equal(out.status, 0, out.stderr)
  const s = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'))
  const envDir = path.join(home, 'daemon-config')
  const ghDir = path.join(home, 'gh-config')
  t.deepEqual(s.sandbox.filesystem.denyRead, [envDir, ghDir])
  t.ok(s.permissions.deny.includes(`Read(/${envDir}/**)`), 'Read tool denied on the daemon config dir')
  t.ok(s.permissions.deny.includes(`Read(/${ghDir}/**)`), 'Read tool denied on the gh config dir')
  t.ok(s.permissions.deny.includes(`Edit(/${path.join(home, 'src')}/**)`), 'the workspace root is read-only')
  t.equal(s.sandbox.enabled, true)
  t.equal(s.sandbox.allowUnsandboxedCommands, false)
  t.ok(s.sandbox.filesystem.allowWrite.includes(path.join(home, 'wt')), 'the worktree root is writable')
  t.ok(fs.existsSync(path.join(dir, 'skills', 'review-pr', 'SKILL.md')), 'skill linked')
  t.ok(fs.lstatSync(path.join(dir, 'hooks', 'block-secret-reads.py')).isSymbolicLink(), 'hook linked')
  t.notOk(fs.existsSync(path.join(dir, 'CLAUDE.md')), 'no personal memory')
  t.match(out.stdout, /looks correct/)
  t.end()
})

// Claude Code silently ignores an invalid settings file, which would drop the sandbox and the read
// denies with no error at all. --check must catch a profile missing a deny layer, so doctor fails.
test('install-claude-profile --check fails when a read-deny layer is missing', t => {
  const { dir, run } = sandboxHome()
  t.equal(run().status, 0)
  const file = path.join(dir, 'settings.json')
  const s = JSON.parse(fs.readFileSync(file, 'utf8'))
  s.permissions.deny = s.permissions.deny.filter((rule: string) => !rule.startsWith('Read('))
  fs.writeFileSync(file, JSON.stringify(s))
  const out = run(['--check'])
  t.equal(out.status, 1)
  t.match(out.stderr, /permissions\.deny does not include Read\(/)
  t.end()
})

// The installer must refuse to build a profile without the skill or the hook rather than produce
// an engine that reviews without review-pr or without the secret-blocking hook.
test('install-claude-profile refuses a missing skill source', t => {
  const { home, run } = sandboxHome()
  fs.rmSync(path.join(home, 'skills-src'), { recursive: true })
  const out = run()
  t.equal(out.status, 1)
  t.match(out.stderr, /no review-pr skill/)
  t.end()
})
