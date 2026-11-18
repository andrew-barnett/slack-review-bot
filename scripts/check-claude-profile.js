#!/usr/bin/env node
// Verify a Claude engine profile dir by value. Used by install-claude-profile.sh (and so by doctor).
// Fails closed: any mismatch or unreadable file exits 1 with the problems on stderr.
// Usage: node scripts/check-claude-profile.js <profile dir> <workspace root> <worktree root> <daemon env dir> <gh config dir> <home>
'use strict'
const fs = require('fs')
const path = require('path')
const { isDeepStrictEqual } = require('util')
const { expectedSettings } = require('./claude-profile-lib')

const [dir, workspaceRoot, worktreeRoot, envDir, ghDir, home] = process.argv.slice(2)
const problems = []
const fail = () => {
  for (const p of problems) console.error(`ERROR: ${p}`)
  process.exit(1)
}
if (!home) {
  console.error('usage: check-claude-profile.js <profile dir> <workspace root> <worktree root> <env dir> <gh dir> <home>')
  process.exit(2)
}

let expected
try {
  expected = expectedSettings({ profileDir: dir, workspaceRoot, worktreeRoot, envDir, ghDir, home })
} catch (error) {
  problems.push(error.message)
  fail()
}

const settingsPath = path.join(dir, 'settings.json')
let s
try {
  s = JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
} catch (error) {
  problems.push(`${settingsPath} is missing, unreadable or not valid JSON`)
  fail()
}

const sameSet = (a, b) => Array.isArray(a) && isDeepStrictEqual([...a].sort(), [...b].sort())
const isLink = p => {
  try {
    return fs.lstatSync(p).isSymbolicLink()
  } catch (error) {
    return false
  }
}
const entries = name => {
  try {
    return fs.readdirSync(path.join(dir, name)).sort()
  } catch (error) {
    return null
  }
}

const sb = s.sandbox || {}
const sbfs = sb.filesystem || {}
const perms = s.permissions || {}
const deny = perms.deny || []

if (sb.enabled !== true) problems.push('sandbox.enabled is not true')
if (sb.autoAllowBashIfSandboxed !== true) problems.push('sandbox.autoAllowBashIfSandboxed is not true')
if (sb.allowUnsandboxedCommands !== false) problems.push('sandbox.allowUnsandboxedCommands is not false')
if (sb.excludedCommands !== undefined) problems.push('sandbox.excludedCommands is set; excluded commands run outside the sandbox')
if (sbfs.allowRead !== undefined) problems.push('sandbox.filesystem.allowRead is set')
if (perms.allow !== undefined) problems.push('permissions.allow is set')
if (perms.additionalDirectories !== undefined) problems.push('permissions.additionalDirectories is set')
if (perms.defaultMode !== 'dontAsk') problems.push('permissions.defaultMode is not dontAsk')
if (!sameSet(sbfs.denyRead, expected.sandbox.filesystem.denyRead)) {
  problems.push(`sandbox.filesystem.denyRead is not exactly ${JSON.stringify(expected.sandbox.filesystem.denyRead)}`)
}
if (!sameSet(sbfs.allowWrite, expected.sandbox.filesystem.allowWrite)) {
  problems.push(`sandbox.filesystem.allowWrite is not exactly ${JSON.stringify(expected.sandbox.filesystem.allowWrite)}`)
}
for (const rule of expected.permissions.deny) {
  // Both read layers are required: denyRead stops Bash, the Read rule stops the in-process Read tool.
  if (!deny.includes(rule)) problems.push(`permissions.deny does not include ${rule}`)
}
const pre = (s.hooks && s.hooks.PreToolUse) || []
if (!isDeepStrictEqual(pre, expected.hooks.PreToolUse) || Object.keys(s.hooks || {}).length !== 1) {
  problems.push('hooks must be exactly one PreToolUse entry: matcher "*" running the secret-blocking hook command')
}
if (s.mcpServers || s.enabledPlugins) problems.push('settings.json configures MCP servers or plugins')
if (/__[A-Z_]+__/.test(JSON.stringify(s))) problems.push('settings.json still contains unsubstituted __PLACEHOLDERS__')
// Catch-all: anything else that diverges from the rendering (network, extra keys, extra rules).
if (!problems.length && !isDeepStrictEqual(s, expected)) problems.push('settings.json differs from the expected rendering')

// Exact profile contents: only settings.json, skills/review-pr and hooks/block-secret-reads.py.
for (const forbidden of ['settings.local.json', '.claude.json', '.mcp.json', 'plugins', 'agents', 'commands', 'CLAUDE.md']) {
  const p = path.join(dir, forbidden)
  if (fs.existsSync(p) || isLink(p)) problems.push(`${forbidden} is present in the profile dir; the engine must not load it`)
}
if (!isDeepStrictEqual(entries('skills'), ['review-pr'])) problems.push('skills/ must contain exactly review-pr')
if (!isDeepStrictEqual(entries('hooks'), ['block-secret-reads.py'])) problems.push('hooks/ must contain exactly block-secret-reads.py')
const hookPath = path.join(dir, 'hooks', 'block-secret-reads.py')
if (!isLink(hookPath) || !fs.existsSync(hookPath)) problems.push('hooks/block-secret-reads.py is missing or not a working symlink')
const skillPath = path.join(dir, 'skills', 'review-pr')
if (!isLink(skillPath) || !fs.existsSync(path.join(skillPath, 'SKILL.md'))) {
  problems.push('skills/review-pr is missing or not a symlink to a skill with SKILL.md')
}

if (problems.length) fail()
console.log(`profile ${dir} looks correct (sandbox on, secret dirs read-denied in both layers, writes pinned, hook and skill present)`)
