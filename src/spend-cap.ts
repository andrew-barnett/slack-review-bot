// The monthly Bedrock spend cap (spec sections 3, 5, 8). The daemon asks it whether new reviews are
// refused, and hands it each settled request's usage: every engine run is priced into the ledger and
// any threshold now crossed is announced in the alert channel. Recording never throws.

import type { Config, EngineName } from './config'
import { loadPriceTable, priceClaude, priceCodex, type LedgerTokens, type PriceTable } from './pricing'
import { nextMonthStart, openSpendLedger, utcMonth, type SpendLedger, type SpendRun, type SpendState } from './spend-ledger'
import { renderCapReachedAlert, renderThresholdAlert, type SpendStatus } from './spend-messages'
import type { RunUsage } from './usage'

type Log = (event: string, fields: Record<string, unknown>) => void
type PostChannelMessage = (channel: string, text: string) => Promise<void>

export interface SpendCapSettings {
  capUsd: number
  /** Ascending. */
  alertPercents: number[]
  /** A subset of alertPercents. */
  herePercents: number[]
  /** Empty: alerts are logged, not posted (ruling 7). */
  alertChannel: string
}

export interface SpendCap {
  readonly active: boolean
  /** True when new reviews are refused: this month's percent is 100 or more. */
  capped(nowMs: number): boolean
  /** Price a settled request's engine runs into the ledger and send any alert now due. Never throws. */
  record(usage: RunUsage, runId: string, nowMs: number): Promise<void>
  status(nowMs: number): SpendStatus
}

export interface SpendCapDeps {
  ledger: SpendLedger
  prices: PriceTable
  /** The configured Bedrock model each engine runs, which keys the price table. */
  models: Record<EngineName, string>
  settings: SpendCapSettings
  postChannelMessage: PostChannelMessage
  log: Log
}

export type SpendCapConfig = Pick<
  Config,
  | 'runtime'
  | 'engineAuth'
  | 'codexBedrockModel'
  | 'claudeBedrockModel'
  | 'spendCapUsd'
  | 'spendAlertPercents'
  | 'spendAlertHerePercents'
  | 'spendAlertChannel'
  | 'bedrockPricesFile'
  | 'spendDir'
>

/** Ruling 1: the container runtime always runs on Bedrock; launchd only under ENGINE_AUTH=bedrock. */
export function spendCapActive(config: Pick<Config, 'runtime' | 'engineAuth'>): boolean {
  return config.runtime === 'container' || config.engineAuth === 'bedrock'
}

/** floor(spent / cap × 100); a locked month (ruling 8) reads as at least 100. */
export function spendPercent(state: Pick<SpendState, 'spentUsd' | 'locked'>, capUsd: number): number {
  const percent = Math.floor((state.spentUsd / capUsd) * 100)
  return state.locked ? Math.max(100, percent) : percent
}

/** Subscription auth: nothing is priced and nothing is refused. */
export function inactiveSpendCap(): SpendCap {
  return {
    active: false,
    capped: () => false,
    record: async () => undefined,
    status: () => ({ active: false }),
  }
}

const NO_TOKENS: LedgerTokens = { input: 0, cachedInput: 0, cacheWrite: 0, output: 0, reasoning: 0 }

export function createSpendCap(deps: SpendCapDeps): SpendCap {
  const { ledger, prices, models, settings, postChannelMessage, log } = deps

  const entryFor = (engine: EngineName, usage: RunUsage, runId: string, at: string): SpendRun => {
    const model = models[engine]
    const price = Object.hasOwn(prices.models, model) ? prices.models[model] : undefined
    const base = { at, runId, engine, model }
    const codex = engine === 'codex' ? usage.codex : undefined
    const claude = engine === 'claude' ? usage.claude : undefined
    if (!codex && !claude) {
      log('spend.no_usage', { runId, engine, model })
      return { ...base, tokens: { ...NO_TOKENS }, costUsd: 0, noUsage: true }
    }
    if (!price) {
      // openSpendCap refuses to start without both prices, so this is a defect, not a configuration.
      log('spend.price_missing', { runId, engine, model })
      return { ...base, tokens: { ...NO_TOKENS }, costUsd: 0, noUsage: true }
    }
    const priced = codex ? priceCodex(codex, price, prices.codexTokenSemantics) : priceClaude(claude!, price)
    return { ...base, tokens: priced.tokens, costUsd: priced.costUsd }
  }

  const send = async (text: string, fields: Record<string, unknown>): Promise<void> => {
    const channel = settings.alertChannel
    if (!channel) {
      log('spend.alert_skipped', { ...fields, reason: 'no alert channel (SPEND_ALERT_CHANNEL and SLACK_CHANNEL_IDS are empty)' })
      return
    }
    try {
      await postChannelMessage(channel, text)
      log('spend.alert_sent', { ...fields, channel })
    } catch (error) {
      // Never retried: the threshold is already persisted as alerted (spec section 8).
      log('spend.alert_failed', { ...fields, channel, error: String(error) })
    }
  }

  let lockedLoggedFor: string | undefined

  /** Spec section 8 and ruling 5. Every decision is journaled before anything is posted. */
  const announce = async (nowMs: number): Promise<void> => {
    const state = ledger.state(nowMs)
    // Refines ruling 8: a locked month reads as at least 100% for admission and status, but that is a
    // storage fault, not spend. Deciding thresholds or the cap from it would journal every threshold and
    // announce a cap nobody reached, then suppress the month's real alerts once the line is fixed.
    if (state.locked) {
      const month = utcMonth(nowMs)
      if (lockedLoggedFor !== month) {
        lockedLoggedFor = month
        log('spend.locked', { month })
      }
      return
    }
    const percent = spendPercent(state, settings.capUsd)
    const due = settings.alertPercents.filter(p => p <= percent && !state.alerted.includes(p))
    for (const threshold of due) ledger.recordAlert(threshold, nowMs)
    if (percent >= 100) {
      // Announced only for a cap at or above the configured one, so raising the cap re-arms the message.
      if (state.capAnnouncedFor !== undefined && state.capAnnouncedFor >= settings.capUsd) return
      ledger.recordCapAnnounced(settings.capUsd, nowMs)
      await send(renderCapReachedAlert(nextMonthStart(nowMs)), { kind: 'cap', percent })
      return
    }
    if (!due.length) return
    const highest = due[due.length - 1]
    await send(renderThresholdAlert(percent, settings.herePercents.includes(highest)), { kind: 'threshold', threshold: highest, percent })
  }

  return {
    active: true,
    capped: nowMs => spendPercent(ledger.state(nowMs), settings.capUsd) >= 100,
    async record(usage, runId, nowMs) {
      try {
        const at = new Date(nowMs).toISOString()
        // Ruling 2: a usage with no engines list is the launchd single-mode runner's: one Codex run.
        const runs = usage.engines ?? [{ engine: 'codex' as const, usage }]
        ledger.recordRuns(runs.map(run => entryFor(run.engine, run.usage, runId, at)), nowMs)
        await announce(nowMs)
      } catch (error) {
        log('spend.record_failed', { runId, error: String(error) })
      }
    },
    status: nowMs => ({
      active: true,
      percent: spendPercent(ledger.state(nowMs), settings.capUsd),
      resetsAt: nextMonthStart(nowMs),
    }),
  }
}

/**
 * The daemon's spend cap. Inactive under subscription auth. When active, the price table must parse and
 * price both configured models (ruling 4), or this throws and the daemon stops before connecting to Slack.
 */
export function openSpendCap(
  config: SpendCapConfig,
  log: Log,
  postChannelMessage: PostChannelMessage,
  nowMs: number = Date.now()
): SpendCap {
  if (!spendCapActive(config)) {
    log('spend.cap_inactive', { reason: 'subscription auth' })
    return inactiveSpendCap()
  }
  const prices = loadPriceTable(config.bedrockPricesFile, [config.codexBedrockModel, config.claudeBedrockModel])
  const ledger = openSpendLedger(config.spendDir, log, nowMs)
  const settings: SpendCapSettings = {
    capUsd: config.spendCapUsd,
    alertPercents: config.spendAlertPercents,
    herePercents: config.spendAlertHerePercents,
    alertChannel: config.spendAlertChannel,
  }
  log('spend.cap_active', {
    pricesFile: config.bedrockPricesFile,
    priceSource: prices.source,
    spendDir: config.spendDir,
    percent: spendPercent(ledger.state(nowMs), settings.capUsd),
    alertChannel: settings.alertChannel || 'none',
  })
  return createSpendCap({
    ledger,
    prices,
    models: { codex: config.codexBedrockModel, claude: config.claudeBedrockModel },
    settings,
    postChannelMessage,
    log,
  })
}
