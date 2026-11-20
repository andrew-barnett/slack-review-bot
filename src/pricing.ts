// The Bedrock price table (spec section 5): USD per million tokens for each configured model ID, kept in
// the repo at pricing/bedrock-prices.json and maintained by the refresh-bot-runtime skill. Spend is
// tokens × these prices. Nothing here is ever shown to a user (spec section 1).

import * as fs from 'fs'
import * as path from 'path'
import type { ClaudeUsageDetail, CodexUsageDetail } from './usage'

/** One model's on-demand prices, in USD per million tokens. */
export interface ModelPrice {
  input: number
  cachedInput: number
  cacheWrite: number
  output: number
}

/**
 * How Codex's usage fields relate (spec section 5, ruling 15). Both false is the conservative reading:
 * cached tokens are not subtracted from input, and reasoning tokens are added to output. Codex copies
 * the Responses API usage object, whose `input_tokens_details` and `output_tokens_details` are
 * breakdowns of `input_tokens` and `output_tokens`, so the shipped table sets both true.
 */
export interface CodexTokenSemantics {
  /**
   * True when `cached_input_tokens` and `cache_write_input_tokens` are already counted inside
   * `input_tokens`; both are then billed at their own rates and only the rest at the input rate.
   */
  cachedIsSubsetOfInput: boolean
  /** True when `reasoning_output_tokens` is already counted inside `output_tokens`. */
  reasoningInOutput: boolean
}

export interface PriceTable {
  /** The pricing page and the date it was checked. */
  source: string
  codexTokenSemantics: CodexTokenSemantics
  /** Keyed by the exact configured model value (a `us.` profile ID today). */
  models: Record<string, ModelPrice>
}

/** The raw token counts a ledger entry keeps, whichever engine ran. */
export interface LedgerTokens {
  input: number
  cachedInput: number
  cacheWrite: number
  output: number
  reasoning: number
}

export interface PricedRun {
  tokens: LedgerTokens
  costUsd: number
}

/**
 * `<repo>/pricing/bedrock-prices.json`. Bundled, this module lives in `dist/`, so one level up is the
 * repo (or `/app` in the image); under ts-node it lives in `src/`, with the same result.
 */
export function defaultPricesFile(): string {
  return path.resolve(__dirname, '..', 'pricing', 'bedrock-prices.json')
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

/** Parse and validate a price table. Every error names the file; a missing model is named too. */
export function parsePriceTable(text: string, file: string, requiredModels: readonly string[]): PriceTable {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (error) {
    throw new Error(`BEDROCK_PRICES_FILE ${file} is not valid JSON: ${String(error)}`)
  }
  if (!isObject(value)) throw new Error(`BEDROCK_PRICES_FILE ${file} must hold a JSON object`)
  const source = value.source
  if (typeof source !== 'string' || !/\d{4}-\d{2}-\d{2}/.test(source)) {
    throw new Error(`BEDROCK_PRICES_FILE ${file}: "source" must name the pricing page and the date it was checked (YYYY-MM-DD)`)
  }
  const semantics = value.codexTokenSemantics
  if (!isObject(semantics) || typeof semantics.cachedIsSubsetOfInput !== 'boolean' || typeof semantics.reasoningInOutput !== 'boolean') {
    throw new Error(`BEDROCK_PRICES_FILE ${file}: "codexTokenSemantics" needs boolean "cachedIsSubsetOfInput" and "reasoningInOutput"`)
  }
  if (!isObject(value.models)) throw new Error(`BEDROCK_PRICES_FILE ${file}: "models" must be an object keyed by model ID`)
  const models: Record<string, ModelPrice> = {}
  for (const [model, entry] of Object.entries(value.models)) {
    const p = isObject(entry) ? entry : {}
    const valid =
      finite(p.input) && p.input > 0 &&
      finite(p.output) && p.output > 0 &&
      finite(p.cachedInput) && p.cachedInput >= 0 &&
      finite(p.cacheWrite) && p.cacheWrite >= 0
    if (!valid) {
      throw new Error(
        `BEDROCK_PRICES_FILE ${file}: model "${model}" needs "input" and "output" above zero and "cachedInput" and "cacheWrite" at zero or above (USD per million tokens)`
      )
    }
    models[model] = { input: p.input as number, cachedInput: p.cachedInput as number, cacheWrite: p.cacheWrite as number, output: p.output as number }
  }
  for (const model of requiredModels) {
    if (!Object.hasOwn(models, model)) {
      throw new Error(`BEDROCK_PRICES_FILE ${file} has no price for model "${model}"; add it from https://aws.amazon.com/bedrock/pricing/`)
    }
  }
  return {
    source,
    codexTokenSemantics: {
      cachedIsSubsetOfInput: semantics.cachedIsSubsetOfInput as boolean,
      reasoningInOutput: semantics.reasoningInOutput as boolean,
    },
    models,
  }
}

/** Read and validate the price table file. */
export function loadPriceTable(file: string, requiredModels: readonly string[]): PriceTable {
  let text: string
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (error) {
    throw new Error(`cannot read BEDROCK_PRICES_FILE ${file}: ${String(error)}`)
  }
  return parsePriceTable(text, file, requiredModels)
}

const dollars = (input: number, cachedInput: number, cacheWrite: number, output: number, p: ModelPrice): number =>
  (input * p.input + cachedInput * p.cachedInput + cacheWrite * p.cacheWrite + output * p.output) / 1_000_000

/** Price one Codex engine run. The ledger keeps the raw counts; the flags decide what is billed. */
export function priceCodex(usage: CodexUsageDetail, price: ModelPrice, semantics: CodexTokenSemantics): PricedRun {
  const billedInput = semantics.cachedIsSubsetOfInput
    ? Math.max(0, usage.inputTokens - usage.cachedInputTokens - usage.cacheWriteTokens)
    : usage.inputTokens
  const billedOutput = semantics.reasoningInOutput ? usage.outputTokens : usage.outputTokens + usage.reasoningTokens
  return {
    tokens: {
      input: usage.inputTokens,
      cachedInput: usage.cachedInputTokens,
      cacheWrite: usage.cacheWriteTokens,
      output: usage.outputTokens,
      reasoning: usage.reasoningTokens,
    },
    costUsd: dollars(billedInput, usage.cachedInputTokens, usage.cacheWriteTokens, billedOutput, price),
  }
}

/** Price one Claude engine run from its token breakdown; `costUsd` (notional) is never used (spec D2). */
export function priceClaude(usage: ClaudeUsageDetail, price: ModelPrice): PricedRun {
  return {
    tokens: {
      input: usage.inputTokens,
      cachedInput: usage.cacheReadTokens,
      cacheWrite: usage.cacheWriteTokens,
      output: usage.outputTokens,
      reasoning: 0,
    },
    costUsd: dollars(usage.inputTokens, usage.cacheReadTokens, usage.cacheWriteTokens, usage.outputTokens, price),
  }
}
