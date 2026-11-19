import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import test from 'tape'
import { loadConfig } from './config'
import { orchestratorConfig } from './orchestrator'
import type { PriceTable } from './pricing'
import { createSpendCap, inactiveSpendCap, spendCapActive, spendPercent, type SpendCapSettings } from './spend-cap'
import { openSpendLedger, spendFileFor, type SpendLedger } from './spend-ledger'
import { renderCapReachedAlert, renderCapRefusal, renderSpendStatusLine, renderThresholdAlert } from './spend-messages'
import type { ClaudeUsageDetail, CodexUsageDetail, RunUsage } from './usage'

/** Mid-November 2026, UTC. */
const NOW = Date.UTC(2026, 10, 20, 12)
const DEC_1 = Date.UTC(2026, 11, 1)
const CODEX = 'test.codex-model'
const CLAUDE = 'test.claude-model'
/**
 * SYNTHETIC prices, not Bedrock's: one US dollar per token in every column, so with a 100-dollar cap
 * one token is one percent and the arithmetic in each test reads directly.
 */
const ONE_DOLLAR_PER_TOKEN = { input: 1_000_000, cachedInput: 1_000_000, cacheWrite: 1_000_000, output: 1_000_000 }
const prices: PriceTable = {
  source: 'synthetic test table, checked 2026-11-19',
  codexTokenSemantics: { cachedIsSubsetOfInput: false, reasoningInOutput: false },
  models: { [CODEX]: ONE_DOLLAR_PER_TOKEN, [CLAUDE]: ONE_DOLLAR_PER_TOKEN },
}

const codexDetail = (input: number): CodexUsageDetail => ({
  inputTokens: input,
  cachedInputTokens: 0,
  cacheWriteTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
})
/** A usage with one Codex engine run of `tokens` tokens (= that many dollars, = that many percent). */
const codexRun = (tokens: number): RunUsage => ({ attempts: 1, engines: [{ engine: 'codex', usage: { attempts: 1, codex: codexDetail(tokens) } }] })

function harness(settings: Partial<SpendCapSettings> = {}, dir: string = fs.mkdtempSync(path.join(os.tmpdir(), 'spend-cap-'))) {
  const posts: Array<{ channel: string; text: string }> = []
  const events: Array<{ event: string; fields: Record<string, unknown> }> = []
  const log = (event: string, fields: Record<string, unknown>) => void events.push({ event, fields })
  let failPosts = false
  const ledger = openSpendLedger(dir, log, NOW)
  const cap = createSpendCap({
    ledger,
    prices,
    models: { codex: CODEX, claude: CLAUDE },
    settings: { capUsd: 100, alertPercents: [25, 50, 75, 90], herePercents: [75, 90], alertChannel: 'C0ALERTS1', ...settings },
    postChannelMessage: async (channel, text) => {
      if (failPosts) throw new Error('synthetic Slack failure')
      posts.push({ channel, text })
    },
    log,
  })
  return { cap, ledger, posts, events, dir, failPosts: () => void (failPosts = true) }
}

/** The percent from an active status, or -1. */
const percentOf = (status: ReturnType<ReturnType<typeof createSpendCap>['status']>): number => (status.active ? status.percent : -1)

// Spec 8: each threshold alerts once, to the alert channel, with the current percent; only the
// SPEND_ALERT_HERE_PERCENTS thresholds carry @here. Regression caught: an alert per record, or the
// threshold number instead of the current percent.
test('each threshold posts once, with the current percent, and @here only where configured', async t => {
  const h = harness()
  await h.cap.record(codexRun(26), 'C1-1', NOW)
  await h.cap.record(codexRun(25), 'C1-2', NOW)
  await h.cap.record(codexRun(25), 'C1-3', NOW)
  await h.cap.record(codexRun(10), 'C1-4', NOW)
  await h.cap.record(codexRun(4), 'C1-5', NOW)
  t.deepEqual(h.posts, [
    { channel: 'C0ALERTS1', text: renderThresholdAlert(26, false) },
    { channel: 'C0ALERTS1', text: renderThresholdAlert(51, false) },
    { channel: 'C0ALERTS1', text: renderThresholdAlert(76, true) },
    { channel: 'C0ALERTS1', text: renderThresholdAlert(90, true) },
  ])
  t.deepEqual(h.ledger.state(NOW).alerted, [25, 50, 75, 90])
  t.notOk(h.cap.capped(NOW))
  fs.rmSync(h.dir, { recursive: true, force: true })
  t.end()
})

// Spec 8: one record crossing several thresholds below 100 posts one message, for the highest.
test('a record crossing several thresholds posts one alert for the highest', async t => {
  const h = harness()
  await h.cap.record(codexRun(80), 'C1-1', NOW)
  t.deepEqual(h.posts.map(p => p.text), [renderThresholdAlert(80, true)])
  t.deepEqual(h.ledger.state(NOW).alerted, [25, 50, 75])
  fs.rmSync(h.dir, { recursive: true, force: true })
  t.end()
})

// Review Focus 4 / ruling 5: a single expensive run that jumps past the cap sends only the cap message,
// marks every threshold, and from then on the cap refuses. A second record sends nothing more.
test('a jump past the cap sends only the cap message and caps', async t => {
  const h = harness()
  await h.cap.record(codexRun(20), 'C1-1', NOW)
  await h.cap.record(codexRun(130), 'C1-2', NOW)
  t.deepEqual(h.posts.map(p => p.text), [renderCapReachedAlert(DEC_1)], 'nothing under 25%, then only the cap message')
  t.deepEqual(h.ledger.state(NOW).alerted, [25, 50, 75, 90])
  t.equal(h.ledger.state(NOW).capAnnouncedFor, 100, 'announced for the 100-dollar cap')
  t.ok(h.cap.capped(NOW))
  t.deepEqual(h.cap.status(NOW), { active: true, percent: 150, resetsAt: DEC_1 })
  await h.cap.record(codexRun(5), 'C1-3', NOW)
  t.equal(h.posts.length, 1, 'the cap is announced once')
  fs.rmSync(h.dir, { recursive: true, force: true })
  t.end()
})

// Spec 8: alert state is persisted, so a restart does not repeat a threshold already announced.
test('a restart does not repeat an alert', async t => {
  const first = harness()
  await first.cap.record(codexRun(30), 'C1-1', NOW)
  const second = harness({}, first.dir)
  await second.cap.record(codexRun(1), 'C1-2', NOW)
  t.equal(first.posts.length, 1)
  t.equal(second.posts.length, 0, 'the 25% alert is not sent again')
  t.equal(percentOf(second.cap.status(NOW)), 31, 'spend survives the restart')
  fs.rmSync(first.dir, { recursive: true, force: true })
  t.end()
})

// Spec 8: raising the cap mid-month (a restart with a higher BEDROCK_MONTHLY_CAP_USD) lifts the refusal,
// re-arms the cap message, and does not repeat thresholds already announced this month.
test('raising the cap mid-month lifts the refusal and re-arms the cap message', async t => {
  const first = harness()
  await first.cap.record(codexRun(100), 'C1-1', NOW)
  t.ok(first.cap.capped(NOW))
  const raised = harness({ capUsd: 200 }, first.dir)
  t.notOk(raised.cap.capped(NOW), '100 of 200 is 50%')
  await raised.cap.record(codexRun(1), 'C1-2', NOW)
  t.equal(raised.posts.length, 0, 'thresholds already announced stay quiet')
  t.equal(raised.ledger.state(NOW).capAnnouncedFor, 100, 'the announcement covers the old cap only')
  await raised.cap.record(codexRun(99), 'C1-3', NOW)
  t.deepEqual(raised.posts.map(p => p.text), [renderCapReachedAlert(DEC_1)], 'reaching the new cap announces again')
  t.equal(raised.ledger.state(NOW).capAnnouncedFor, 200)
  fs.rmSync(first.dir, { recursive: true, force: true })
  t.end()
})

// PR review finding (andrew-barnett/slack-review-bot#78), round 3: after a cap raise, the very first
// record can cross the new cap with no record below 100% in between. The cap message must still go out,
// because the announcement on file was for the lower cap. Regression caught: a boolean "announced" flag
// that only a below-cap record reset, so this record was silently not announced.
test('after a cap raise, the first record that crosses the new cap announces it', async t => {
  const first = harness()
  await first.cap.record(codexRun(100), 'C1-1', NOW)
  t.deepEqual(first.posts.map(p => p.text), [renderCapReachedAlert(DEC_1)])
  const raised = harness({ capUsd: 200 }, first.dir)
  await raised.cap.record(codexRun(150), 'C1-2', NOW)
  t.deepEqual(raised.posts.map(p => p.text), [renderCapReachedAlert(DEC_1)], 'one cap message for the new cap, no threshold alert')
  t.ok(raised.cap.capped(NOW))
  await raised.cap.record(codexRun(1), 'C1-3', NOW)
  t.equal(raised.posts.length, 1, 'and only once')
  fs.rmSync(first.dir, { recursive: true, force: true })
  t.end()
})

// Spec 8: a failed post is logged, never retried, and the threshold stays marked.
test('a failed alert is logged, not retried, and stays marked', async t => {
  const h = harness()
  h.failPosts()
  await h.cap.record(codexRun(30), 'C1-1', NOW)
  await h.cap.record(codexRun(1), 'C1-2', NOW)
  t.equal(h.events.filter(e => e.event === 'spend.alert_failed').length, 1)
  t.deepEqual(h.ledger.state(NOW).alerted, [25])
  fs.rmSync(h.dir, { recursive: true, force: true })
  t.end()
})

// Ruling 7: with no alert channel, alerts are logged and skipped, and the cap is still enforced.
test('with no alert channel the alert is skipped and the cap still applies', async t => {
  const h = harness({ alertChannel: '' })
  await h.cap.record(codexRun(100), 'C1-1', NOW)
  t.equal(h.posts.length, 0)
  t.ok(h.events.some(e => e.event === 'spend.alert_skipped'))
  t.ok(h.cap.capped(NOW))
  fs.rmSync(h.dir, { recursive: true, force: true })
  t.end()
})

// Spec 7: an engine run that reported no usage is recorded at zero and flagged, so the gap is visible
// in the ledger instead of silently missing.
test('an engine run with no usage detail is recorded as noUsage at zero', async t => {
  const h = harness()
  await h.cap.record({ attempts: 1, engines: [{ engine: 'codex', usage: { attempts: 1 } }] }, 'C1-1', NOW)
  const [entry] = h.ledger.state(NOW).entries
  t.equal(entry.noUsage, true)
  t.equal(entry.costUsd, 0)
  t.equal(entry.model, CODEX)
  t.ok(h.events.some(e => e.event === 'spend.no_usage'))
  fs.rmSync(h.dir, { recursive: true, force: true })
  t.end()
})

// Ruling 2 / Review Focus 2: the launchd single-mode runner's usage has no engines list. It is one Codex
// run; reading only `engines` would record nothing and never trip the cap.
test('record reads a usage with no engines list as one Codex run', async t => {
  const h = harness()
  await h.cap.record({ attempts: 1, codex: codexDetail(30) }, 'C1-1', NOW)
  const [entry] = h.ledger.state(NOW).entries
  t.equal(entry.engine, 'codex')
  t.equal(entry.costUsd, 30)
  t.equal(entry.runId, 'C1-1')
  fs.rmSync(h.dir, { recursive: true, force: true })
  t.end()
})

// Spec D2: Claude is priced from its token counts at the table's prices. Its own costUsd (a notional
// subscription figure) is ignored. Regression caught: adding Claude's costUsd to the ledger.
test('a Claude run is priced from its tokens and its costUsd is ignored', async t => {
  const h = harness()
  const claude: ClaudeUsageDetail = { inputTokens: 2, outputTokens: 3, cacheReadTokens: 1, cacheWriteTokens: 4, costUsd: 999, numTurns: 1, durationMs: 1 }
  await h.cap.record({ attempts: 1, engines: [{ engine: 'claude', usage: { attempts: 1, claude } }] }, 'C1-1', NOW)
  const [entry] = h.ledger.state(NOW).entries
  t.equal(entry.engine, 'claude')
  t.equal(entry.model, CLAUDE)
  t.equal(entry.costUsd, 10)
  t.deepEqual(entry.tokens, { input: 2, cachedInput: 1, cacheWrite: 4, output: 3, reasoning: 0 })
  fs.rmSync(h.dir, { recursive: true, force: true })
  t.end()
})

// Recording runs after a review has finished. A ledger failure must never turn into a crashed job.
test('record never throws; a failure is logged', async t => {
  const events: string[] = []
  const fail = (): never => {
    throw new Error('synthetic ledger failure')
  }
  const broken: SpendLedger = { state: fail, recordRuns: fail, recordAlert: fail, recordCapAnnounced: fail }
  const cap = createSpendCap({
    ledger: broken,
    prices,
    models: { codex: CODEX, claude: CLAUDE },
    settings: { capUsd: 100, alertPercents: [25], herePercents: [], alertChannel: 'C0ALERTS1' },
    postChannelMessage: async () => undefined,
    log: event => void events.push(event),
  })
  await cap.record(codexRun(1), 'C1-1', NOW)
  t.deepEqual(events, ['spend.record_failed'])
  t.end()
})

// Ruling 8: a locked month (a bad journal line) reads as at least 100%, so it refuses and says so.
test('a locked ledger refuses and reports the cap reached', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spend-cap-'))
  fs.writeFileSync(spendFileFor(dir, '2026-11'), 'not json\n')
  const h = harness({}, dir)
  t.ok(h.cap.capped(NOW))
  t.equal(spendPercent({ spentUsd: 0, locked: true }, 100), 100)
  t.equal(spendPercent({ spentUsd: 41.9, locked: false }, 100), 41, 'percent is floored')
  t.equal(renderSpendStatusLine(h.cap.status(NOW)), 'Bedrock spend this month: cap reached · resets Nov 30, 7:00 PM ET')
  fs.rmSync(dir, { recursive: true, force: true })
  t.end()
})

// Refines ruling 8 (P2): a locked month (a bad journal line) reads as 100% for admission, but that is a
// storage fault, not spend. Regression caught: record() journaling every threshold plus a cap line and
// posting "reached its cap" at about 1% real spend, which then suppressed the month's real alerts once
// the operator fixed the line.
test('a locked month makes no threshold or cap decision, and real alerts still fire after the fix', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spend-cap-'))
  const file = spendFileFor(dir, '2026-11')
  fs.writeFileSync(file, 'not json\n')
  const h = harness({}, dir)
  t.ok(h.cap.capped(NOW), 'locked still refuses')
  await h.cap.record(codexRun(1), 'C1-1', NOW)
  t.equal(h.posts.length, 0, 'no post from a locked month')
  const journaled = fs.readFileSync(file, 'utf8')
  t.notOk(/"kind":"(alert|cap)"/.test(journaled), 'no alert or cap line journaled')
  await h.cap.record(codexRun(1), 'C1-2', NOW)
  t.equal(h.events.filter(e => e.event === 'spend.locked').length, 1, 'spend.locked logged once per month')
  // The operator removes the bad line; a fresh cap over the same directory sees the real spend.
  fs.writeFileSync(file, journaled.split('\n').filter(l => l && l !== 'not json').join('\n') + '\n')
  const fixed = harness({}, dir)
  await fixed.cap.record(codexRun(30), 'C1-3', NOW)
  t.equal(fixed.posts.length, 1, 'one alert after the fix')
  t.ok(/used 3\d% of its monthly/.test(fixed.posts[0]?.text ?? ''), 'it is the 25% alert, at the real percent')
  t.deepEqual(fixed.ledger.state(NOW).alerted, [25])
  fs.rmSync(dir, { recursive: true, force: true })
  t.end()
})

// Ruling 1 / Review Focus 1: the orchestrator never sees ENGINE_AUTH (its engineAuth is always
// subscription), so the cap must key on the container runtime too. A launchd bedrock install is capped;
// launchd subscription is not.
test('spendCapActive: container always, launchd only under bedrock auth', t => {
  const bundle = {
    SLACK_BOT_TOKEN: 'bot-placeholder',
    SLACK_APP_TOKEN: 'app-placeholder',
    APPROVER_GH_TOKEN: 'approver-placeholder',
    LAUNCH_KEY: Buffer.alloc(32, 9).toString('base64url'),
  }
  t.equal(spendCapActive(orchestratorConfig(bundle, { HOME: '/home/bot' }).config), true, 'the orchestrator')
  const credentials = { SLACK_BOT_TOKEN: 'placeholder', SLACK_APP_TOKEN: 'placeholder', HOME: '/home/u' }
  t.equal(spendCapActive(loadConfig(credentials)), false, 'launchd subscription')
  t.equal(
    spendCapActive(loadConfig({ ...credentials, ENGINE_AUTH: 'bedrock', ENGINE_ROLE_ARN: 'arn:aws:iam::123456789012:role/Example' })),
    true,
    'launchd bedrock'
  )
  t.equal(inactiveSpendCap().capped(NOW), false)
  t.deepEqual(inactiveSpendCap().status(NOW), { active: false })
  t.end()
})

// Spec 1: user-facing text never shows a dollar amount. Every spend message and status line, over a
// range of percents and reset times, carries no "$" followed by a digit. Regression caught: a message
// "helpfully" adding the cap or the spend.
test('no spend message or status line contains a dollar amount', t => {
  const texts: string[] = []
  for (const resetAt of [DEC_1, Date.UTC(2027, 6, 1)]) {
    texts.push(renderCapRefusal(resetAt), renderCapReachedAlert(resetAt), renderSpendStatusLine({ active: false }))
    for (const percent of [0, 1, 25, 76, 99, 100, 250]) {
      texts.push(renderThresholdAlert(percent, true), renderThresholdAlert(percent, false))
      texts.push(renderSpendStatusLine({ active: true, percent, resetsAt: resetAt }))
    }
  }
  for (const text of texts) t.notOk(/\$\s*\d/.test(text), text)
  t.end()
})
