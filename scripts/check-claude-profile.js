#!/usr/bin/env node
// Verify a Claude engine profile dir by value. Used by install-claude-profile.sh (and so by doctor).
// Usage: node scripts/check-claude-profile.js <profile dir> <daemon env dir> <gh config dir>
'use strict'
const fs = require('fs')
const path = require('path')
const [dir, envDir, ghDir] = process.argv.slice(2)
const problems = []
const settingsPath = path.join(dir, 'settings.json')
let s = {}
try {
  s = JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
} catch (error) {
  problems.push(`${settingsPath} is missing or not valid JSON`)
}
const sb = s.sandbox || {}
if (sb.enabled !== true) problems.push('sandbox.enabled is not true')
if (sb.autoAllowBashIfSandboxed !== true) problems.push('sandbox.autoAllowBashIfSandboxed is not true')
if (sb.allowUnsandboxedCommands !== false) problems.push('sandbox.allowUnsandboxedCommands is not false')
const denyRead = (sb.filesystem && sb.filesystem.denyRead) || []
const deny = (s.permissions && s.permissions.deny) || []
for (const d of [envDir, ghDir]) {
  // Both layers are required: denyRead stops Bash, the Read rule stops the in-process Read tool.
  if (!denyRead.includes(d)) problems.push(`sandbox.filesystem.denyRead does not include ${d}`)
  if (!deny.includes(`Read(/${d}/**)`)) problems.push(`permissions.deny does not include Read(/${d}/**)`)
}
if (!s.permissions || s.permissions.defaultMode !== 'dontAsk') problems.push('permissions.defaultMode is not dontAsk')
const hooks = ((s.hooks && s.hooks.PreToolUse) || []).flatMap(h => h.hooks || [])
if (!hooks.some(h => String(h.command).includes(path.join(dir, 'hooks', 'block-secret-reads.py')))) {
  problems.push('the secret-blocking PreToolUse hook is not registered')
}
if (!fs.existsSync(path.join(dir, 'hooks', 'block-secret-reads.py'))) problems.push('hooks/block-secret-reads.py is missing')
if (!fs.existsSync(path.join(dir, 'skills', 'review-pr', 'SKILL.md'))) problems.push('skills/review-pr/SKILL.md is missing')
if (fs.existsSync(path.join(dir, 'CLAUDE.md'))) problems.push('CLAUDE.md is present; the engine must not load personal memory')
if (s.mcpServers || s.enabledPlugins) problems.push('settings.json configures MCP servers or plugins')
if (/__[A-Z_]+__/.test(JSON.stringify(s))) problems.push('settings.json still contains unsubstituted __PLACEHOLDERS__')
if (problems.length) {
  for (const p of problems) console.error(`ERROR: ${p}`)
  process.exit(1)
}
console.log(`profile ${dir} looks correct (sandbox on, env and gh dirs read-denied, hook and skill present)`)
