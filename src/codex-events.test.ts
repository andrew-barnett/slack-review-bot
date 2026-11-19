import { spawnSync } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import test from 'tape'
import { codexProgressFilter, codexProgressLine, codexReadableTail, createCodexUsageReader, turnUsage } from './codex-events'
import { addCodexUsage, codexTotalTokens } from './usage'

const zero = { inputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 0, reasoningTokens: 0 }
const turn = (usage: Record<string, number>) => JSON.stringify({ type: 'turn.completed', usage })

// Spec 6: usage is summed across every turn.completed event. Regression caught: keeping only the last
// turn's usage, which under-reports a multi-turn run and lets spend slip past the cap.
test('the usage reader sums every turn.completed across turns', t => {
  const reader = createCodexUsageReader()
  reader.push(`${JSON.stringify({ type: 'thread.started', thread_id: 't' })}\n${turn({ input_tokens: 100, cached_input_tokens: 40, cache_write_input_tokens: 5, output_tokens: 20, reasoning_output_tokens: 7 })}\n`)
  reader.push(`${turn({ input_tokens: 50, cached_input_tokens: 10, cache_write_input_tokens: 0, output_tokens: 30, reasoning_output_tokens: 3 })}\n`)
  reader.flush()
  t.deepEqual(reader.usage(), { inputTokens: 150, cachedInputTokens: 50, cacheWriteTokens: 5, outputTokens: 50, reasoningTokens: 10 })
  t.end()
})

// A pipe read can end mid-line. Regression caught: parsing each chunk on its own, which drops a turn
// whose line straddles two reads (Review Focus 3).
test('the usage reader joins an event split across chunks', t => {
  const reader = createCodexUsageReader()
  const line = turn({ input_tokens: 9, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 })
  reader.push(line.slice(0, 10))
  t.equal(reader.usage(), undefined, 'nothing is counted from half a line')
  reader.push(`${line.slice(10)}\n`)
  t.deepEqual(reader.usage(), { ...zero, inputTokens: 9, outputTokens: 1 })
  t.end()
})

// The last line may arrive without a newline when the child exits; flush must still count it.
test('the usage reader counts a final line without a newline on flush', t => {
  const reader = createCodexUsageReader()
  reader.push(turn({ input_tokens: 3, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0 }))
  reader.flush()
  t.deepEqual(reader.usage(), { ...zero, inputTokens: 3 })
  t.end()
})

// A run with no completed turn has unknown usage, not zero usage, so the ledger records the gap
// (noUsage) instead of a free run.
test('the usage reader reports undefined when no turn completed', t => {
  const reader = createCodexUsageReader()
  reader.push('{"type":"turn.started"}\nnot json at all\n{"type":"turn.completed"\n')
  reader.flush()
  t.equal(reader.usage(), undefined)
  t.end()
})

// Malformed numbers must never corrupt the totals: a negative count would lower recorded spend, and
// NaN would poison every later sum.
test('turnUsage clamps missing, negative and non-numeric fields to zero', t => {
  t.deepEqual(turnUsage({ input_tokens: -5, cached_input_tokens: 'x', output_tokens: Number.NaN, reasoning_output_tokens: 2 }), { ...zero, reasoningTokens: 2 })
  t.deepEqual(turnUsage(null), zero)
  t.deepEqual(turnUsage([1, 2]), zero)
  t.end()
})

// Spec 6: tokensUsed is the sum of the five fields; and summing keeps "unknown" distinct from zero.
test('codexTotalTokens sums all five fields and addCodexUsage keeps unknown only when both are', t => {
  const u = { inputTokens: 1, cachedInputTokens: 2, cacheWriteTokens: 3, outputTokens: 4, reasoningTokens: 5 }
  t.equal(codexTotalTokens(u), 15)
  t.equal(addCodexUsage(undefined, undefined), undefined)
  t.deepEqual(addCodexUsage(u, undefined), u)
  t.deepEqual(addCodexUsage(undefined, u), u)
  t.deepEqual(addCodexUsage(u, u), { inputTokens: 2, cachedInputTokens: 4, cacheWriteTokens: 6, outputTokens: 8, reasoningTokens: 10 })
  t.end()
})

// Ruling 10: the status reply shows an agent message or the command being run; turn and thread events,
// and reasoning items, carry nothing a reader wants.
test('codexProgressLine shows agent messages and commands and drops other events', t => {
  t.equal(codexProgressLine({ type: 'item.completed', item: { id: 'i', type: 'agent_message', text: 'reading the diff' } }), 'reading the diff')
  t.equal(codexProgressLine({ type: 'item.started', item: { id: 'i', type: 'command_execution', command: 'npm test' } }), 'npm test')
  t.equal(codexProgressLine({ type: 'turn.completed', usage: {} }), undefined)
  t.equal(codexProgressLine({ type: 'item.completed', item: { id: 'i', type: 'reasoning', text: 'x' } }), undefined)
  t.equal(codexProgressLine({ type: 'item.completed' }), undefined, 'an item event with no item is dropped, not a crash')
  t.end()
})

// Raw JSON must never reach the status line, but plain lines (stderr diagnostics) still do, as before
// --json. Regression caught: the status reply showing `{"type":"turn.started"}` as the run's activity.
test('codexProgressFilter turns events into lines, drops unknown events and keeps plain text', t => {
  const seen: Array<{ line: string; activeMs: number }> = []
  const filter = codexProgressFilter((line, activeMs) => seen.push({ line, activeMs }))
  filter(`{"type":"turn.started"}\n${JSON.stringify({ type: 'item.completed', item: { id: 'a', type: 'agent_message', text: 'checking tests' } })}\n`, 5)
  filter('{"type":"thread.started","thread_id":"t"}\n', 6)
  filter('warning: something on stderr\n', 7)
  filter('{"type": broken json\n', 8)
  t.deepEqual(seen, [
    { line: 'checking tests', activeMs: 5 },
    { line: 'warning: something on stderr', activeMs: 7 },
  ])
  t.end()
})

// A JSON event split across two spans is held until complete, so half an event is never shown raw.
test('codexProgressFilter holds an unfinished event until its newline', t => {
  const seen: string[] = []
  const filter = codexProgressFilter(line => seen.push(line))
  const event = JSON.stringify({ type: 'item.completed', item: { id: 'a', type: 'agent_message', text: 'half and half' } })
  filter(event.slice(0, 20), 1)
  t.deepEqual(seen, [], 'nothing shown for half an event')
  filter(`${event.slice(20)}\n`, 2)
  t.deepEqual(seen, ['half and half'])
  t.end()
})

// The compose smoke drives this stub. It must emit the codex-cli 0.169.0 --json shapes the reader and
// the filter parse. Regression caught: a stub left printing plain text, so the smoke's ledger check
// could never see Codex usage.
test('the smoke stub emits --json events with usage and one progress line', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stub-codex-'))
  const out = path.join(dir, 'final.json')
  const stub = path.join(__dirname, '..', 'scripts', 'smoke', 'stub-codex.js')
  const run = spawnSync(process.execPath, [stub, 'exec', '--json', '--output-last-message', out, 'prompt'], { encoding: 'utf8' })
  t.equal(run.status, 0, run.stderr)
  const reader = createCodexUsageReader()
  reader.push(run.stdout)
  reader.flush()
  t.deepEqual(reader.usage(), { inputTokens: 1200, cachedInputTokens: 200, cacheWriteTokens: 0, outputTokens: 300, reasoningTokens: 40 })
  const lines: string[] = []
  codexProgressFilter(line => lines.push(line))(run.stdout, 0)
  t.deepEqual(lines, ['stub-codex: reviewing'])
  t.deepEqual(JSON.parse(fs.readFileSync(out, 'utf8')), { results: [] })
  const plain = spawnSync(process.execPath, [stub, 'exec', '--output-last-message', out, 'prompt'], { encoding: 'utf8' })
  t.equal(plain.status, 2, 'the stub refuses to run without --json, so a dropped flag fails the smoke')
  fs.rmSync(dir, { recursive: true, force: true })
  t.end()
})

// Ruling P3: the Slack-bound tail must be readable. Failure mode caught: raw JSONL (including a cut-off
// first line from the bounded transcript tail) leaking into the posted error text.
test('codexReadableTail renders events as lines, keeps plain text and never emits {"type":', t => {
  const transcript = [
    'e":"turn.started"}', // the tail of an event cut off by the transcript bound
    JSON.stringify({ type: 'item.completed', item: { id: 'a', type: 'agent_message', text: 'reading the diff' } }),
    '{"type":"turn.completed","usage":{"input_tokens":1}}',
    'warning: plain stderr line',
    '{"type":"item.started","item":{"id":"b","type":"command_execution","command":"npm test"}}',
  ].join('\n')
  const tail = codexReadableTail(transcript)
  t.equal(tail, 'e":"turn.started"}\nreading the diff\nwarning: plain stderr line\nnpm test')
  t.notOk(tail.includes('{"type":'))
  t.equal(codexReadableTail('x'.repeat(2000)).length, 1500, 'bounded to the last 1500 characters')
  t.end()
})
