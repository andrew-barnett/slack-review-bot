#!/usr/bin/env node
// Shared by install-claude-profile.sh (renders settings.json) and check-claude-profile.js (compares
// the installed settings.json to the same rendering, by value).
// CLI: node scripts/claude-profile-lib.js render [--container] [--npmrc FILE] <profile dir> <workspace root> <worktree root> <env dir> <gh dir> <home>
'use strict'
const fs = require('fs')
const path = require('path')

// The container rendering turns the sandbox off (the container is the boundary, spec D4) and keeps
// every deny rule and the hook.
const TEMPLATES = {
  host: path.join(__dirname, '..', 'claude', 'review-bot.settings.json.template'),
  container: path.join(__dirname, '..', 'claude', 'review-bot.settings.container.json.template'),
}

/**
 * True inside a Docker or Podman container. `root` is a test seam (CONTAINER_PROBE_ROOT). The single
 * implementation for JS and TS (src/container.ts re-exports it); its bash twin is in_container in
 * scripts/install-codex-profile.sh.
 */
function inContainer(root = process.env.CONTAINER_PROBE_ROOT || '/') {
  if (fs.existsSync(path.join(root, '.dockerenv')) || fs.existsSync(path.join(root, 'run', '.containerenv'))) return true
  try {
    return /docker|containerd|kubepods|libpod/.test(fs.readFileSync(path.join(root, 'proc', '1', 'cgroup'), 'utf8'))
  } catch (error) {
    return false
  }
}

/** Split `--container`, `--build` and `--npmrc FILE` from the positional arguments. */
function parseFlags(argv) {
  const out = { container: false, build: false, npmrc: undefined, positional: [] }
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--container') out.container = true
    else if (argv[i] === '--build') out.build = true
    else if (argv[i] === '--npmrc') out.npmrc = argv[++i]
    else out.positional.push(argv[i])
  }
  return out
}

/** Resolve symlinks when the path exists, else keep it as given. */
function resolveDir(p) {
  try {
    return fs.realpathSync(p)
  } catch (error) {
    return p
  }
}

/** Every directory the engine may never read: the daemon's env dir, gh login, and operator secrets. */
function denyDirs(envDir, ghDir, home, extra = []) {
  const dirs = [envDir, ghDir, '.ssh', '.aws', '.npmrc', '.claude', '.codex', '.gnupg'].map((d, i) =>
    resolveDir(i < 2 ? d : path.join(home, d)),
  )
  return [...new Set([...dirs, ...extra.map(resolveDir)])]
}

function isInside(child, parent) {
  const rel = path.relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

/** Render the expected settings object. Throws if the profile dir would sit inside a denied dir. */
function expectedSettings({ profileDir, workspaceRoot, worktreeRoot, envDir, ghDir, home, mode = 'host', npmrc }) {
  if (!TEMPLATES[mode]) throw new Error(`unknown profile mode ${mode}`)
  const profile = resolveDir(profileDir)
  // The worker's npmrc names its registry token by reference only, but it is denied all the same.
  const deny = denyDirs(envDir, ghDir, home, npmrc ? [npmrc] : [])
  for (const d of deny) {
    if (isInside(profile, d)) throw new Error(`profile dir ${profile} is inside the read-denied dir ${d}; the engine could not load it`)
  }
  const workspace = resolveDir(workspaceRoot)
  const values = {
    __PROFILE_DIR__: profile,
    __WORKSPACE_ROOT__: workspace,
    __ENGINE_WORKTREE_ROOT__: path.join(resolveDir(worktreeRoot), 'claude'),
  }
  const expansions = {
    __DENY_DIRS__: deny,
    // The Read tool is denied separately from Bash: sandbox denyRead alone does not stop it.
    __DENY_READ_RULES__: deny.flatMap(d => [`Read(/${d}/**)`, `Read(/${d})`]),
    // The profile dir is denied too: an Edit/Write there could rewrite the engine's own settings,
    // hook or skill. It stays readable, since Claude loads its settings, hook and skill from it.
    __DENY_EDIT_RULES__: [...deny, profile].flatMap(d => [`Edit(/${d}/**)`, `Edit(/${d})`]),
  }
  const walk = node => {
    if (Array.isArray(node)) return node.flatMap(e => (typeof e === 'string' && expansions[e] ? expansions[e] : [walk(e)]))
    if (typeof node === 'string') return Object.entries(values).reduce((acc, [k, v]) => acc.split(k).join(v), node)
    if (node && typeof node === 'object') return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, walk(v)]))
    return node
  }
  return walk(JSON.parse(fs.readFileSync(TEMPLATES[mode], 'utf8')))
}

module.exports = { expectedSettings, resolveDir, inContainer, parseFlags }

if (require.main === module) {
  const flags = parseFlags(process.argv.slice(2))
  const [cmd, profileDir, workspaceRoot, worktreeRoot, envDir, ghDir, home] = flags.positional
  if (cmd !== 'render' || !home) {
    console.error('usage: claude-profile-lib.js render [--container] [--npmrc FILE] <profile dir> <workspace root> <worktree root> <env dir> <gh dir> <home>')
    process.exit(2)
  }
  const mode = flags.container ? 'container' : 'host'
  try {
    const settings = expectedSettings({ profileDir, workspaceRoot, worktreeRoot, envDir, ghDir, home, mode, npmrc: flags.npmrc })
    process.stdout.write(JSON.stringify(settings, null, 2) + '\n')
  } catch (error) {
    console.error(`ERROR: ${error.message}`)
    process.exit(1)
  }
}
