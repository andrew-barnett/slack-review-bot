import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import test from 'tape'
import { loadPriceTable, parsePriceTable, priceClaude, priceCodex, type ModelPrice } from './pricing'

const CODEX = 'us.openai.gpt-5.5'
const CLAUDE = 'us.anthropic.claude-opus-5-5'
// SYNTHETIC prices chosen for easy arithmetic. They are not AWS prices and must never be copied into
// pricing/bedrock-prices.json.
const codexPrice: ModelPrice = { input: 1, cachedInput: 0.25, cacheWrite: 0, output: 8 }
const claudePrice: ModelPrice = { input: 3, cachedInput: 0.5, cacheWrite: 4, output: 20 }
const SOURCE = 'https://aws.amazon.com/bedrock/pricing/ (on-demand, us-east-2), checked 2026-11-19'

/** A complete fixture table; a test overrides one field at a time. */
function table(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    source: SOURCE,
    codexTokenSemantics: { cachedIsSubsetOfInput: false, reasoningInOutput: false },
    models: { [CODEX]: codexPrice, [CLAUDE]: claudePrice },
    ...over,
  })
}

// A well-formed table loads, with both configured models priced. Regression caught: a loader that
// rejects valid tables, or drops a configured model, would stop the container runtime at startup.
test('parsePriceTable accepts a complete table', t => {
  const parsed = parsePriceTable(table(), 'prices.json', [CODEX, CLAUDE])
  t.deepEqual(parsed.models[CODEX], codexPrice)
  t.deepEqual(parsed.models[CLAUDE], claudePrice)
  t.equal(parsed.source, SOURCE)
  t.deepEqual(parsed.codexTokenSemantics, { cachedIsSubsetOfInput: false, reasoningInOutput: false })
  t.end()
})

// Spec 4: a configured model with no price stops startup with a message naming the model and the file,
// so spend is never priced at an unknown rate. Regression caught: a model bump without its price.
test('parsePriceTable rejects a missing model, naming the model and the file', t => {
  t.throws(
    () => parsePriceTable(table({ models: { [CODEX]: codexPrice } }), '/app/pricing/bedrock-prices.json', [CODEX, CLAUDE]),
    /\/app\/pricing\/bedrock-prices\.json has no price for model "us\.anthropic\.claude-opus-5-5"/
  )
  // A prototype key must not count as a priced model.
  t.throws(() => parsePriceTable(table(), 'prices.json', ['constructor']), /no price for model "constructor"/)
  t.end()
})

// Spec 5: the placeholder zeros can never ship. Zero input or output is rejected; a zero cache price is a
// real possibility (a model with no cache-write charge) and is allowed. Regression caught: a placeholder-zero
// table would price spend at $0, so the cap would never trip.
test('parsePriceTable rejects a zero input or output price and allows a zero cache price', t => {
  for (const bad of [{ ...codexPrice, input: 0 }, { ...codexPrice, output: 0 }]) {
    t.throws(() => parsePriceTable(table({ models: { [CODEX]: bad, [CLAUDE]: claudePrice } }), 'p.json', [CODEX, CLAUDE]), /model "us\.openai\.gpt-5\.5" needs "input" and "output" above zero/)
  }
  const free = parsePriceTable(table({ models: { [CODEX]: { ...codexPrice, cachedInput: 0, cacheWrite: 0 }, [CLAUDE]: claudePrice } }), 'p.json', [CODEX, CLAUDE])
  t.equal(free.models[CODEX].cacheWrite, 0)
  t.end()
})

// Negative, missing or non-numeric prices are as wrong as zero, and must not reach the arithmetic. Regression caught:
// a malformed price loads as NaN or a negative number and corrupts every cost.
test('parsePriceTable rejects negative, missing and non-numeric prices', t => {
  const cases = [{ ...codexPrice, cachedInput: -1 }, { input: 1, output: 8 }, { ...codexPrice, output: '8' }]
  for (const bad of cases) {
    t.throws(() => parsePriceTable(table({ models: { [CODEX]: bad, [CLAUDE]: claudePrice } }), 'p.json', [CODEX, CLAUDE]), /needs "input" and "output"/)
  }
  t.end()
})

// Spec 4 "must parse": bad JSON fails with the file named, not a bare SyntaxError.
test('parsePriceTable rejects bad JSON naming the file', t => {
  t.throws(() => parsePriceTable('{ "models": ', 'p.json', [CODEX]), /BEDROCK_PRICES_FILE p\.json is not valid JSON/)
  t.throws(() => parsePriceTable('[]', 'p.json', [CODEX]), /must hold a JSON object/)
  t.end()
})

// Spec 5: `source` records the URL and the date checked. The spec's own example date "2026-11-XX" is a
// placeholder and must not load. Regression caught: an undated or placeholder source loads, so nobody can tell
// how stale the prices are.
test('parsePriceTable requires a dated source', t => {
  t.throws(() => parsePriceTable(table({ source: 'https://aws.amazon.com/bedrock/pricing/ checked 2026-11-XX' }), 'p.json', [CODEX]), /"source" must name the pricing page and the date/)
  t.throws(() => parsePriceTable(table({ source: undefined }), 'p.json', [CODEX]), /"source"/)
  t.end()
})

// Ruling 15: the two Codex flags are required booleans, so the reading in use is always a decision. Regression caught:
// a missing or non-boolean flag is silently read as one of the two readings.
test('parsePriceTable requires both codexTokenSemantics flags', t => {
  t.throws(() => parsePriceTable(table({ codexTokenSemantics: { cachedIsSubsetOfInput: false } }), 'p.json', [CODEX]), /codexTokenSemantics/)
  t.throws(() => parsePriceTable(table({ codexTokenSemantics: { cachedIsSubsetOfInput: 'no', reasoningInOutput: false } }), 'p.json', [CODEX]), /codexTokenSemantics/)
  t.end()
})

// A missing or unreadable file fails with the path, so the operator knows which setting to fix. Regression caught:
// an unreadable file surfaces as a bare ENOENT that does not name BEDROCK_PRICES_FILE.
test('loadPriceTable reads a file and names it when it cannot', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prices-'))
  const file = path.join(dir, 'bedrock-prices.json')
  t.throws(() => loadPriceTable(file, [CODEX]), /cannot read BEDROCK_PRICES_FILE \S*prices-\S*bedrock-prices\.json/)
  fs.writeFileSync(file, table())
  t.deepEqual(loadPriceTable(file, [CODEX, CLAUDE]).models[CODEX], codexPrice)
  fs.rmSync(dir, { recursive: true, force: true })
  t.end()
})

// Spec 5 / 9: until the semantics are confirmed, cached tokens are not subtracted from input and reasoning
// tokens are added to output, which overcounts (the safe direction for a cap). The confirmed reading
// does neither, and costs less. Regression caught: the flags read backwards.
test('the conservative Codex reading overcounts and the confirmed reading does not', t => {
  const usage = { inputTokens: 1000, cachedInputTokens: 400, cacheWriteTokens: 0, outputTokens: 200, reasoningTokens: 50 }
  const conservative = priceCodex(usage, codexPrice, { cachedIsSubsetOfInput: false, reasoningInOutput: false })
  const confirmed = priceCodex(usage, codexPrice, { cachedIsSubsetOfInput: true, reasoningInOutput: true })
  // (1000 × 1 + 400 × 0.25 + 250 × 8) / 1e6 = 0.0031; (600 × 1 + 400 × 0.25 + 200 × 8) / 1e6 = 0.0023
  t.ok(Math.abs(conservative.costUsd - 0.0031) < 1e-12, String(conservative.costUsd))
  t.ok(Math.abs(confirmed.costUsd - 0.0023) < 1e-12, String(confirmed.costUsd))
  t.ok(conservative.costUsd > confirmed.costUsd)
  t.deepEqual(conservative.tokens, { input: 1000, cachedInput: 400, cacheWrite: 0, output: 200, reasoning: 50 }, 'the ledger keeps the raw counts')
  t.end()
})

// Claude's cache reads and writes are separate from its input (spec D2), and its notional costUsd is
// never used. Regression caught: pricing Claude from costUsd.
test('priceClaude prices each field and ignores the notional costUsd', t => {
  const usage = { inputTokens: 100, outputTokens: 10, cacheReadTokens: 1000, cacheWriteTokens: 50, costUsd: 999, numTurns: 3, durationMs: 1 }
  const priced = priceClaude(usage, claudePrice)
  // (100 × 3 + 1000 × 0.5 + 50 × 4 + 10 × 20) / 1e6 = 0.0012
  t.ok(Math.abs(priced.costUsd - 0.0012) < 1e-12, String(priced.costUsd))
  t.deepEqual(priced.tokens, { input: 100, cachedInput: 1000, cacheWrite: 50, output: 10, reasoning: 0 })
  t.end()
})
