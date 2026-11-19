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
  // Operator secret paths are denied in both layers too (single files such as the npm credentials too).
  const secretDirs = ['.ssh', '.aws', '.npmrc', '.claude', '.codex', '.gnupg'].map(d => path.join(home, d))
  t.deepEqual(s.sandbox.filesystem.denyRead, [envDir, ghDir, ...secretDirs])
  for (const d of [envDir, ghDir, ...secretDirs]) {
    t.ok(s.permissions.deny.includes(`Read(/${d}/**)`), `Read tool denied on ${d}`)
    t.ok(s.permissions.deny.includes(`Read(/${d})`), `Read tool denied on ${d} itself (single files)`)
  }
  t.ok(s.permissions.deny.includes(`Read(/${envDir}/**)`), 'Read tool denied on the daemon config dir')
  t.ok(s.permissions.deny.includes(`Read(/${ghDir}/**)`), 'Read tool denied on the gh config dir')
  t.ok(s.permissions.deny.includes(`Edit(/${path.join(home, 'src')}/**)`), 'the workspace root is read-only')
  t.equal(s.sandbox.enabled, true)
  t.equal(s.sandbox.allowUnsandboxedCommands, false)
  t.deepEqual(s.sandbox.filesystem.allowWrite, [path.join(home, 'wt', 'claude')], 'only the Claude engine root is writable')
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

/** Install a good profile, mutate settings.json (or the profile dir), and run --check on it. */
function checkMutated(mutate: (s: any, dir: string) => void) {
  const { dir, run } = sandboxHome()
  const installed = run()
  if (installed.status !== 0) throw new Error(`baseline install failed: ${installed.stderr}`)
  const file = path.join(dir, 'settings.json')
  const s = JSON.parse(fs.readFileSync(file, 'utf8'))
  mutate(s, dir)
  fs.writeFileSync(file, JSON.stringify(s))
  return run(['--check'])
}

// The write boundary is the engine's blast radius. An extra allowWrite must fail the check; the
// checker compares the set exactly, not by presence.
test('check-claude-profile rejects an extra allowWrite entry', t => {
  const out = checkMutated(s => s.sandbox.filesystem.allowWrite.push('/tmp/elsewhere'))
  t.equal(out.status, 1)
  t.match(out.stderr, /allowWrite is not exactly/)
  t.end()
})

// Dropping any single deny rule (here the ssh Read-tool rule) reopens a secret to untrusted PR code.
test('check-claude-profile rejects a missing deny rule for an operator secret dir', t => {
  const out = checkMutated(s => {
    s.permissions.deny = s.permissions.deny.filter((r: string) => !/\.ssh\/\*\*\)$/.test(r))
  })
  t.equal(out.status, 1)
  t.match(out.stderr, /permissions\.deny does not include Read\(.*\.ssh/)
  t.end()
})

// The engine's Edit/Write tools run in-process, outside the Bash sandbox's allowWrite pin, so the
// profile dir needs its own Edit deny. Regression caught: untrusted PR content steering the engine
// to rewrite its own settings.json, hook or skill, disabling the sandbox and denies for later runs.
test('install-claude-profile denies Edit/Write into the profile dir', t => {
  const { dir, run } = sandboxHome()
  t.equal(run().status, 0)
  const s = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'))
  t.ok(s.permissions.deny.includes(`Edit(/${dir}/**)`), 'Edit denied inside the profile dir')
  t.ok(s.permissions.deny.includes(`Edit(/${dir})`), 'Edit denied on the profile dir itself')
  t.notOk(s.permissions.deny.includes(`Read(/${dir}/**)`), 'the profile stays readable so Claude can load it')
  t.end()
})

// The checker derives its required rules from the same rendering, so dropping either profile Edit
// rule must fail --check. Regression caught: a hand-edited profile that silently reopens itself.
test('check-claude-profile rejects a missing profile-dir Edit deny', t => {
  for (const suffix of ['/**)', ')']) {
    const out = checkMutated((s, dir) => {
      s.permissions.deny = s.permissions.deny.filter((r: string) => r !== `Edit(/${dir}${suffix}`)
    })
    t.equal(out.status, 1, `missing Edit(/<profile>${suffix} fails`)
    t.match(out.stderr, /permissions\.deny does not include Edit\(\/\/.*profile/)
  }
  t.end()
})

// excludedCommands run outside the sandbox, silently voiding denyRead and the write pin.
test('check-claude-profile rejects sandbox.excludedCommands', t => {
  const out = checkMutated(s => (s.sandbox.excludedCommands = ['git']))
  t.equal(out.status, 1)
  t.match(out.stderr, /excludedCommands/)
  t.end()
})

// permissions.allow (and additionalDirectories / allowRead) would widen what dontAsk mode permits.
test('check-claude-profile rejects permissions.allow, additionalDirectories and allowRead', t => {
  const cases: Array<[(s: any) => void, RegExp]> = [
    [s => (s.permissions.allow = ['Bash(*)']), /permissions\.allow/],
    [s => (s.permissions.additionalDirectories = ['/']), /additionalDirectories/],
    [s => (s.sandbox.filesystem.allowRead = ['/']), /allowRead/],
  ]
  for (const [mutate, re] of cases) {
    const out = checkMutated(mutate)
    t.equal(out.status, 1)
    t.match(out.stderr, re)
  }
  t.end()
})

// A hook that points elsewhere (or a narrowed matcher) would leave the secret blocker inert while the
// profile still "has" a hook; the command and matcher are compared exactly.
test('check-claude-profile rejects a wrong hook command or matcher', t => {
  const wrongCommand = checkMutated(s => (s.hooks.PreToolUse[0].hooks[0].command = 'true'))
  t.equal(wrongCommand.status, 1)
  t.match(wrongCommand.stderr, /hooks must be exactly/)
  const wrongMatcher = checkMutated(s => (s.hooks.PreToolUse[0].matcher = 'Bash'))
  t.equal(wrongMatcher.status, 1)
  t.match(wrongMatcher.stderr, /hooks must be exactly/)
  t.end()
})

// Files Claude Code would load on top of settings.json (local overrides, MCP, plugins) break isolation.
test('check-claude-profile rejects forbidden profile files and dirs', t => {
  for (const name of ['settings.local.json', 'unknown-file', '.mcp.json', 'plugins', 'agents', 'commands']) {
    const out = checkMutated((_s, dir) => {
      const p = path.join(dir, name)
      if (!['plugins', 'agents', 'commands'].includes(name)) fs.writeFileSync(p, '{}')
      else fs.mkdirSync(p)
    })
    t.equal(out.status, 1, name)
    t.match(out.stderr, new RegExp(`${name.replace('.', '\\.')} is present`), name)
  }
  t.end()
})

// An unreadable or corrupt settings.json must fail closed (Claude Code would silently ignore it).
test('check-claude-profile fails closed on invalid settings.json', t => {
  const { dir, run } = sandboxHome()
  t.equal(run().status, 0)
  fs.writeFileSync(path.join(dir, 'settings.json'), '{not json')
  const out = run(['--check'])
  t.equal(out.status, 1)
  t.match(out.stderr, /not valid JSON/)
  t.end()
})

// Paths become sandbox grants and deny rules: a relative, root, empty or dot-dot directory would
// silently widen or void them, so the installer refuses each before writing anything.
test('install-claude-profile rejects relative, root, empty and dot-dot directories', t => {
  const { home, run } = sandboxHome()
  const cases: Array<[string, string, RegExp]> = [
    ['--dir', 'relative/profile', /absolute/],
    ['--dir', '/', /root/],
    ['--dir', '', /empty/],
    ['--worktree-root', '/', /root/],
    ['--workspace-root', 'src', /absolute/],
    ['--gh-config-dir', `${home}/x/../y` /* path.join would normalize the dot-dot away */, /\.\./],
  ]
  for (const [flag, value, re] of cases) {
    const out = run([flag, value])
    t.equal(out.status, 1, `${flag} ${value}`)
    t.match(out.stderr, re, `${flag} ${value}`)
  }
  t.notOk(fs.existsSync(path.join(home, 'profile')), 'nothing was installed')
  t.end()
})

// The operator's home config dir is read-denied; a profile dir inside it could never be loaded by the
// engine, so the installer refuses rather than silently producing an unusable (or unprotected) profile.
test('install-claude-profile refuses a profile dir inside a read-denied dir', t => {
  const { home, run } = sandboxHome()
  const out = run(['--dir', path.join(home, '.claude', 'review-bot')])
  t.equal(out.status, 1)
  t.match(out.stderr, /inside the read-denied dir/)
  t.end()
})

/** Install a good profile, then let `setup` add files to the profile dir before --check runs. */
function checkWithState(setup: (dir: string) => void) {
  const { dir, run } = sandboxHome()
  const installed = run()
  if (installed.status !== 0) throw new Error(`baseline install failed: ${installed.stderr}`)
  setup(dir)
  return run(['--check'])
}

// Claude Code writes these into CLAUDE_CONFIG_DIR on every run (probed on 2.1.284, even unauthenticated).
// Regression caught: a checker that rejects them would fail doctor after the first engine run.
test('check-claude-profile accepts Claude runtime state', t => {
  const out = checkWithState(dir => {
    fs.writeFileSync(path.join(dir, '.claude.json'), '{}')
    for (const d of ['backups', 'projects', 'sessions']) fs.mkdirSync(path.join(dir, d))
    fs.writeFileSync(path.join(dir, 'backups', '.claude.json.backup.1'), '{}')
  })
  t.equal(out.status, 0, out.stderr)
  t.end()
})

// Runtime state must not smuggle in MCP servers: top-level, per-project, or enabled project servers.
test('check-claude-profile rejects MCP servers in .claude.json', t => {
  const cases: Array<[unknown, RegExp]> = [
    [{ mcpServers: { evil: { command: 'x' } } }, /top-level mcpServers/],
    [{ projects: { '/some/repo': { mcpServers: { evil: { command: 'x' } } } } }, /configures mcpServers/],
    [{ projects: { '/some/repo': { enabledMcpjsonServers: ['evil'] } } }, /enabledMcpjsonServers/],
    [{ mcpServers: {}, projects: { '/some/repo': { mcpServers: {}, enabledMcpjsonServers: [] } } }, /^$/],
  ]
  for (const [state, re] of cases) {
    const out = checkWithState(dir => fs.writeFileSync(path.join(dir, '.claude.json'), JSON.stringify(state)))
    if (String(re) === String(/^$/)) {
      t.equal(out.status, 0, 'empty MCP containers are benign')
    } else {
      t.equal(out.status, 1)
      t.match(out.stderr, re)
    }
  }
  t.end()
})

// An unparseable .claude.json cannot be verified MCP-free, so the check fails closed.
test('check-claude-profile fails closed on an unparseable .claude.json', t => {
  const out = checkWithState(dir => fs.writeFileSync(path.join(dir, '.claude.json'), '{nope'))
  t.equal(out.status, 1)
  t.match(out.stderr, /\.claude\.json is unreadable or not valid JSON/)
  t.end()
})

// The runtime-state allowance is by name only: an unknown file is still rejected.
test('check-claude-profile still rejects an unknown extra file next to runtime state', t => {
  const out = checkWithState(dir => {
    fs.writeFileSync(path.join(dir, '.claude.json'), '{}')
    fs.writeFileSync(path.join(dir, 'extra.txt'), 'x')
  })
  t.equal(out.status, 1)
  t.match(out.stderr, /extra\.txt is present/)
  t.end()
})

// --- Container profile (spec D4, ruling 14) ---

/** A fake filesystem root for the container probe: with or without /.dockerenv. */
function probeRoot(inside: boolean): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-root-'))
  fs.mkdirSync(path.join(root, 'proc', '1'), { recursive: true })
  fs.writeFileSync(path.join(root, 'proc', '1', 'cgroup'), '0::/\n')
  if (inside) fs.writeFileSync(path.join(root, '.dockerenv'), '')
  return root
}

/** The installer with the container flags and a chosen probe root. */
function containerRun(home: string, dir: string, extra: string[], inside: boolean) {
  const skill = path.join(home, 'skills-src', 'review-pr')
  const hook = path.join(home, 'hooks-src', 'block-secret-reads.py')
  const args = [
    '--dir', dir,
    '--workspace-root', path.join(home, 'src'),
    '--worktree-root', path.join(home, 'wt'),
    '--skill-src', skill,
    '--hook-src', hook,
    '--env-file', path.join(home, 'daemon-config', 'env'),
    '--gh-config-dir', path.join(home, 'gh-config'),
    '--container',
    ...extra,
  ]
  return spawnSync(SCRIPT, args, {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: home, CONTAINER_PROBE_ROOT: probeRoot(inside) },
  })
}

// The container is the sandbox boundary (spec D4): sandbox off, but both read-deny layers stay, and
// the worker's npmrc is denied too. Regression caught: a container profile that drops the deny rules
// along with the sandbox.
test('install-claude-profile --container writes sandbox off with every deny rule kept', t => {
  const { home, dir } = sandboxHome()
  const out = containerRun(home, dir, [], true)
  t.equal(out.status, 0, out.stderr)
  const s = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'))
  t.deepEqual(s.sandbox, { enabled: false })
  t.equal(s.permissions.defaultMode, 'dontAsk')
  const npmrc = path.join(home, '.npmrc-worker')
  for (const d of [path.join(home, 'gh-config'), npmrc, path.join(home, '.aws')]) {
    t.ok(s.permissions.deny.includes(`Read(/${d}/**)`), `Read denied on ${d}`)
  }
  t.ok(s.permissions.deny.includes(`Edit(/${dir}/**)`), 'the profile dir stays unwritable')
  t.equal(s.hooks.PreToolUse[0].hooks[0].command, `python3 "${dir}/hooks/block-secret-reads.py"`)
  t.match(out.stdout, /looks correct/)
  t.end()
})

// A sandbox-off profile must never be installed on the laptop, where it would run PR code with the
// operator's whole filesystem in reach. Regression caught: the container profile passing --check
// on the host.
test('check-claude-profile --container fails outside a container unless --build', t => {
  const { home, dir } = sandboxHome()
  t.equal(containerRun(home, dir, [], true).status, 0)
  const outside = containerRun(home, dir, ['--check'], false)
  t.equal(outside.status, 1)
  t.match(outside.stderr, /only be installed inside a container/)
  t.equal(containerRun(home, dir, ['--check', '--build'], false).status, 0, 'docker build has no /.dockerenv')
  t.end()
})

// The host check must reject a container rendering: sandbox off is only safe inside the container.
test('check-claude-profile (host) rejects a container profile', t => {
  const { home, dir, run } = sandboxHome()
  t.equal(containerRun(home, dir, [], true).status, 0)
  const out = run(['--check'])
  t.equal(out.status, 1)
  t.match(out.stderr, /sandbox\.enabled is not true/)
  t.end()
})

// The container check is by value too: a sandbox block other than exactly {enabled:false} (for
// example one re-enabling network rules nobody enforces) is rejected.
test('check-claude-profile --container rejects any other sandbox block', t => {
  const { home, dir } = sandboxHome()
  t.equal(containerRun(home, dir, [], true).status, 0)
  const file = path.join(dir, 'settings.json')
  const s = JSON.parse(fs.readFileSync(file, 'utf8'))
  s.sandbox = { enabled: false, excludedCommands: ['curl'] }
  fs.writeFileSync(file, JSON.stringify(s))
  const out = containerRun(home, dir, ['--check'], true)
  t.equal(out.status, 1)
  t.match(out.stderr, /sandbox must be exactly/)
  t.end()
})

// A mistaken --container install on the laptop must leave the host profile exactly as it was: the
// probe runs before anything is written. Regression caught: the installer overwriting settings.json
// with sandbox off and only then failing its check, so the next host review runs unsandboxed.
test('install-claude-profile --container on the host refuses before writing', t => {
  const { home, dir, run } = sandboxHome()
  t.equal(run([]).status, 0, 'the host profile is installed')
  const before = fs.readFileSync(path.join(dir, 'settings.json'), 'utf8')
  const out = containerRun(home, dir, [], false)
  t.equal(out.status, 1)
  t.match(out.stderr, /only be installed inside a container/)
  t.equal(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'), before, 'the host settings are untouched')
  t.end()
})

