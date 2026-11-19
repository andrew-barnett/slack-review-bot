#!/usr/bin/env node
// Stub engine for scripts/compose-smoke.sh: prints one progress line and writes an empty, valid
// report-only result to the path after --output-last-message. It reads nothing and calls nothing.
'use strict'
const fs = require('fs')

const args = process.argv.slice(2)
const at = args.indexOf('--output-last-message')
if (at < 0 || !args[at + 1]) {
  console.error('stub-codex: no --output-last-message')
  process.exit(2)
}
console.log('stub-codex: reviewing')
fs.writeFileSync(args[at + 1], JSON.stringify({ results: [] }))
