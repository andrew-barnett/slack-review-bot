#!/usr/bin/env node
// Stub engine for scripts/compose-smoke.sh: prints the `codex exec --json` events a one-turn run emits
// (codex-cli 0.169.0 shapes) with a fixed, synthetic usage, and writes an empty, valid report-only
// result to the path after --output-last-message. It reads nothing and calls nothing.
'use strict'
const fs = require('fs')

const args = process.argv.slice(2)
const at = args.indexOf('--output-last-message')
if (at < 0 || !args[at + 1]) {
  console.error('stub-codex: no --output-last-message')
  process.exit(2)
}
if (!args.includes('--json')) {
  console.error('stub-codex: expected --json (the bot reads usage from turn.completed events)')
  process.exit(2)
}
const emit = event => console.log(JSON.stringify(event))
emit({ type: 'thread.started', thread_id: 'smoke-thread' })
emit({ type: 'turn.started' })
emit({ type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: 'stub-codex: reviewing' } })
fs.writeFileSync(args[at + 1], JSON.stringify({ results: [] }))
emit({
  type: 'turn.completed',
  usage: { input_tokens: 1200, cached_input_tokens: 200, cache_write_input_tokens: 0, output_tokens: 300, reasoning_output_tokens: 40 },
})
