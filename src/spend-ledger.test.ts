import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import test from 'tape'
import { nextMonthStart, openSpendLedger, spendFileFor, utcMonth, type SpendRun } from './spend-ledger'

const NOV_20 = Date.UTC(2026, 10, 20, 14, 3, 11)
/** 02:00 UTC on Dec 1 is 21:00 on Nov 30 in New York: a new month by UTC, still November in ET. */
const DEC_1_0200Z = Date.UTC(2026, 11, 1, 2, 0)
/** Permission tests mean nothing as root, which ignores file modes. */
const ROOT = process.getuid?.() === 0

/** A fresh state directory that does not exist yet, as on a new volume. */
function scratch(): { base: string; dir: string; nov: string; dec: string } {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'spend-ledger-'))
  const dir = path.join(base, 'state')
  return { base, dir, nov: spendFileFor(dir, '2026-11'), dec: spendFileFor(dir, '2026-12') }
}

function logger() {
  const events: Array<{ event: string; fields: Record<string, unknown> }> = []
  return { events, log: (event: string, fields: Record<string, unknown>) => void events.push({ event, fields }) }
}

/** A synthetic engine run costing `costUsd`. */
const run = (costUsd: number, runId = 'C1-11'): SpendRun => ({
  at: new Date(NOV_20).toISOString(),
  runId,
  engine: 'codex',
  model: 'us.openai.gpt-5.5',
  tokens: { input: 1, cachedInput: 0, cacheWrite: 0, output: 1, reasoning: 0 },
  costUsd,
})

/** A well-formed `run` journal line. */
const runLine = (costUsd: number): string => JSON.stringify({ type: 'run', ...run(costUsd) })

// D5: months are UTC calendar months. The reset is 00:00 UTC on the 1st, including across a year end.
// Regression caught: a local-time or off-by-one month calculation, or December failing to roll into
// January of the next year.
test('utcMonth and nextMonthStart follow the UTC calendar', t => {
  t.equal(utcMonth(Date.UTC(2026, 10, 30, 23, 59)), '2026-11')
  t.equal(utcMonth(DEC_1_0200Z), '2026-12')
  t.equal(nextMonthStart(NOV_20), Date.UTC(2026, 11, 1))
  t.equal(nextMonthStart(Date.UTC(2026, 11, 15)), Date.UTC(2027, 0, 1), 'December rolls into January of the next year')
  t.end()
})

// A first start has no journal: the month opens at zero, and what is recorded survives a restart. Each
// record is one JSON line with its type first. Regression caught: a run counted only in memory, so a
// restart reopened a reached cap at zero.
test('a new month starts at zero and its runs round-trip through a restart', t => {
  const { base, dir, nov } = scratch()
  const first = openSpendLedger(dir, logger().log, NOV_20)
  t.equal(first.state(NOV_20).month, '2026-11')
  t.equal(first.state(NOV_20).spentUsd, 0)
  t.equal(first.state(NOV_20).locked, false)
  first.recordRuns([run(2.5, 'C1-1'), run(1, 'C1-2')], NOV_20)
  const lines = fs.readFileSync(nov, 'utf8').split('\n')
  t.equal(lines.length, 3, 'two lines, each ending in a newline')
  t.ok(lines[0].startsWith('{"type":"run","at":'), lines[0])
  const second = openSpendLedger(dir, logger().log, NOV_20)
  t.equal(second.state(NOV_20).spentUsd, 3.5)
  t.deepEqual(second.state(NOV_20).entries.map(e => e.runId), ['C1-1', 'C1-2'])
  t.equal(second.state(NOV_20).locked, false)
  fs.rmSync(base, { recursive: true, force: true })
  t.end()
})

// Spec 7 / D5: a run at 02:00 UTC on Dec 1 (still Nov 30 in New York) is December's. Regression caught:
// switching months on the ET calendar, which would charge five hours of December spend to November's cap,
// or touching November's journal when December starts.
test('a run just after 00:00 UTC lands in the new month and leaves the old journal untouched', t => {
  const { base, dir, nov, dec } = scratch()
  openSpendLedger(dir, logger().log, NOV_20).recordRuns([run(7)], NOV_20)
  const november = fs.readFileSync(nov, 'utf8')
  const ledger = openSpendLedger(dir, logger().log, DEC_1_0200Z)
  ledger.recordRuns([{ ...run(3), at: new Date(DEC_1_0200Z).toISOString() }], DEC_1_0200Z)
  t.equal(ledger.state(DEC_1_0200Z).month, '2026-12')
  t.equal(ledger.state(DEC_1_0200Z).spentUsd, 3, 'November is not counted')
  t.equal(fs.readFileSync(dec, 'utf8').split('\n').length, 2, 'one line in spend-2026-12.jsonl')
  t.equal(fs.readFileSync(nov, 'utf8'), november, 'spend-2026-11.jsonl is byte for byte unchanged')
  fs.rmSync(base, { recursive: true, force: true })
  t.end()
})

// Spec 7 / ruling 8: a line that does not parse makes the month untrustworthy, so it reads as capped, and
// the log names the line. Removing the line and restarting unlocks it with the good lines still counted.
// Regression caught: skipping a bad line, which silently drops a charge and reopens spending.
test('a bad line locks the month until it is removed', t => {
  const { base, dir, nov } = scratch()
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(nov, `${runLine(4)}\n{"type":"run","costUsd":\n${runLine(6)}\n`)
  const { events, log } = logger()
  const ledger = openSpendLedger(dir, log, NOV_20)
  t.equal(ledger.state(NOV_20).locked, true)
  t.equal(ledger.state(NOV_20).spentUsd, 10, 'the good lines still count')
  const unreadable = events.filter(e => e.event === 'spend.unreadable')
  t.equal(unreadable.length, 1)
  t.equal(unreadable[0].fields.line, 2, 'the log names the bad line')
  t.equal(unreadable[0].fields.file, nov)
  fs.writeFileSync(nov, `${runLine(4)}\n${runLine(6)}\n`)
  const repaired = openSpendLedger(dir, logger().log, NOV_20)
  t.equal(repaired.state(NOV_20).locked, false, 'removing the line and restarting unlocks the month')
  t.equal(repaired.state(NOV_20).spentUsd, 10)
  fs.rmSync(base, { recursive: true, force: true })
  t.end()
})

// A crash mid-append leaves a last line with no newline. It is treated as unreadable (the conservative
// choice), and the next append starts on a fresh line, so removing the partial line loses nothing else.
// Regression caught: the next record glued onto the partial line, making both unrecoverable.
test('a partial last line locks the month, and later records start on their own line', t => {
  const { base, dir, nov } = scratch()
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(nov, `${runLine(4)}\n{"type":"ru`)
  const { events, log } = logger()
  const ledger = openSpendLedger(dir, log, NOV_20)
  t.equal(ledger.state(NOV_20).locked, true)
  t.equal(events.find(e => e.event === 'spend.unreadable')?.fields.line, 2)
  ledger.recordRuns([run(5)], NOV_20)
  t.equal(fs.readFileSync(nov, 'utf8'), `${runLine(4)}\n{"type":"ru\n${runLine(5)}\n`, 'the new record is on its own line')
  fs.writeFileSync(nov, `${runLine(4)}\n${runLine(5)}\n`)
  t.equal(openSpendLedger(dir, logger().log, NOV_20).state(NOV_20).spentUsd, 9, 'removing the partial line keeps the later record')
  fs.rmSync(base, { recursive: true, force: true })
  t.end()
})

// A line in a shape this code does not know (another type, a hand edit, a negative cost) is as
// untrustworthy as bad JSON, and gets the same treatment. Regression caught: a validator that accepts
// a malformed record and counts it (or drops it) while the month stays open.
test('a line with an unknown type or invalid fields locks the month', t => {
  const at = new Date(NOV_20).toISOString()
  for (const bad of [
    { type: 'refund', at, costUsd: 1 },
    { ...JSON.parse(runLine(1)), costUsd: -1 },
    { ...JSON.parse(runLine(1)), engine: 'gemini' },
    { ...JSON.parse(runLine(1)), tokens: { input: 1 } },
    { type: 'alert', at, percent: 25.5 },
    { type: 'cap', at, capUsd: 0 },
    { type: 'cap', capUsd: 100 },
    [1, 2],
  ]) {
    const { base, dir, nov } = scratch()
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(nov, `${JSON.stringify(bad)}\n`)
    t.equal(openSpendLedger(dir, logger().log, NOV_20).state(NOV_20).locked, true, JSON.stringify(bad))
    fs.rmSync(base, { recursive: true, force: true })
  }
  t.end()
})

// When the state directory cannot be written, opening the ledger already reads as capped: the probe on
// open fails. Every state() retries the probe, so the month reopens on its own once storage recovers.
// Regression caught: a restart onto read-only storage admitting reviews whose spend can never be
// recorded, or a lock that only a restart clears.
test('unwritable storage on open starts locked and unlocks once it is writable again', { skip: ROOT }, t => {
  const { base, dir } = scratch()
  openSpendLedger(dir, logger().log, NOV_20).recordRuns([run(5)], NOV_20)
  fs.chmodSync(dir, 0o500)
  try {
    const { events, log } = logger()
    const ledger = openSpendLedger(dir, log, NOV_20)
    t.equal(ledger.state(NOV_20).spentUsd, 5, 'the journal is still read')
    t.equal(ledger.state(NOV_20).locked, true)
    t.ok(events.some(e => e.event === 'spend.write_failed'))
    fs.chmodSync(dir, 0o700)
    t.equal(ledger.state(NOV_20).locked, false, 'the next state() probes again and unlocks')
    t.ok(events.some(e => e.event === 'spend.write_recovered'))
  } finally {
    fs.chmodSync(dir, 0o700)
  }
  fs.rmSync(base, { recursive: true, force: true })
  t.end()
})

// Ruling 17: a run whose append fails still counts in this process (so it stays capped and counting),
// and the process is locked until an append or probe succeeds. Once storage recovers the lock clears.
// Only the failed run's cost is lost to a later restart: the accepted residual, which the AWS Budget
// backstop covers. Regression caught: dropping the failed run from the in-memory total, or never clearing
// the lock after storage recovers.
test('a failed run append is counted in memory and locks until storage recovers', { skip: ROOT }, t => {
  const { base, dir, nov } = scratch()
  const { events, log } = logger()
  const ledger = openSpendLedger(dir, log, NOV_20)
  ledger.recordRuns([run(90, 'C1-1')], NOV_20)
  fs.chmodSync(nov, 0o400)
  ledger.recordRuns([run(20, 'C1-2')], NOV_20)
  t.equal(ledger.state(NOV_20).spentUsd, 110, 'the failed run still counts in this process')
  t.equal(ledger.state(NOV_20).locked, true, 'and the process reads as capped')
  t.ok(events.some(e => e.event === 'spend.write_failed'))
  t.equal(openSpendLedger(dir, logger().log, NOV_20).state(NOV_20).locked, true, 'a restart while storage still fails starts locked')
  fs.chmodSync(nov, 0o600)
  ledger.recordRuns([run(1, 'C1-3')], NOV_20)
  t.equal(ledger.state(NOV_20).locked, false, 'the next successful append clears the lock')
  t.equal(ledger.state(NOV_20).spentUsd, 111)
  t.deepEqual(
    openSpendLedger(dir, logger().log, NOV_20).state(NOV_20).entries.map(e => e.runId),
    ['C1-1', 'C1-3'],
    'after a restart only the failed run is missing (the accepted residual)'
  )
  fs.rmSync(base, { recursive: true, force: true })
  t.end()
})

// A write can fail after appending part of a line (a full disk, an I/O error). Regression caught: the next
// successful record joined the damaged prefix, so the restart locked the month and deleting the bad line
// also deleted a real charge.
test('a record after a part-written failed append starts on its own line', t => {
  const { base, dir, nov } = scratch()
  let failNext = false
  const appendFile = (file: string, text: string): void => {
    if (failNext && text !== '') {
      failNext = false
      fs.appendFileSync(file, text.slice(0, 10))
      throw new Error('ENOSPC: no space left on device')
    }
    fs.appendFileSync(file, text)
  }
  const ledger = openSpendLedger(dir, logger().log, NOV_20, appendFile)
  ledger.recordRuns([run(4, 'C1-1')], NOV_20)
  failNext = true
  ledger.recordRuns([run(6, 'C1-2')], NOV_20)
  ledger.recordRuns([run(5, 'C1-3')], NOV_20)
  t.equal(
    fs.readFileSync(nov, 'utf8'),
    `${JSON.stringify({ type: 'run', ...run(4, 'C1-1') })}\n${JSON.stringify({ type: 'run', ...run(6, 'C1-2') }).slice(0, 10)}\n${JSON.stringify({ type: 'run', ...run(5, 'C1-3') })}\n`,
    'the record after the failure is on its own line'
  )
  t.equal(openSpendLedger(dir, logger().log, NOV_20).state(NOV_20).locked, true, 'the damaged line still locks the month')
  const lines = fs.readFileSync(nov, 'utf8').split('\n')
  fs.writeFileSync(nov, [lines[0], lines[2], ''].join('\n'))
  t.deepEqual(
    openSpendLedger(dir, logger().log, NOV_20).state(NOV_20).entries.map(e => e.runId),
    ['C1-1', 'C1-3'],
    'removing the damaged line keeps the run recorded after it'
  )
  fs.rmSync(base, { recursive: true, force: true })
  t.end()
})

// Spec 8: alert and cap decisions are journaled before posting, so a restart never re-sends them. The cap
// line records the cap it was sent for; a higher configured cap is not covered by it, which is how a cap
// raise re-arms the message with no extra state. Regression caught: a boolean "announced" flag that a cap
// raise never reset, so reaching the new cap was silent.
test('alerts and the cap announcement persist across a restart, and the highest cap wins', t => {
  const { base, dir } = scratch()
  const ledger = openSpendLedger(dir, logger().log, NOV_20)
  ledger.recordAlert(50, NOV_20)
  ledger.recordAlert(25, NOV_20)
  ledger.recordCapAnnounced(100, NOV_20)
  const restarted = openSpendLedger(dir, logger().log, NOV_20)
  t.deepEqual(restarted.state(NOV_20).alerted, [25, 50], 'ascending')
  // Announced for 100 only, so a cap raised to 150 is therefore still unannounced.
  t.equal(restarted.state(NOV_20).capAnnouncedFor, 100)
  restarted.recordCapAnnounced(150, NOV_20)
  restarted.recordCapAnnounced(120, NOV_20)
  t.equal(openSpendLedger(dir, logger().log, NOV_20).state(NOV_20).capAnnouncedFor, 150, 'the highest cap announced')
  t.equal(openSpendLedger(dir, logger().log, DEC_1_0200Z).state(DEC_1_0200Z).capAnnouncedFor, undefined, 'a new month starts unannounced')
  fs.rmSync(base, { recursive: true, force: true })
  t.end()
})

// The bot runs across a month end. The first call in the new UTC month switches to the new journal and
// starts at zero, and nothing is renamed or deleted. Regression caught: last month's spend or alerts
// counting against this month, or the old journal being moved away.
test('a month change mid-process switches journals without renaming or deleting anything', t => {
  const { base, dir, nov, dec } = scratch()
  const { events, log } = logger()
  const ledger = openSpendLedger(dir, log, NOV_20)
  ledger.recordRuns([run(5)], NOV_20)
  ledger.recordAlert(25, NOV_20)
  const november = fs.readFileSync(nov, 'utf8')
  const december = ledger.state(DEC_1_0200Z)
  t.equal(december.month, '2026-12')
  t.equal(december.spentUsd, 0)
  t.deepEqual(december.alerted, [], 'alerts start over each month')
  t.ok(events.some(e => e.event === 'spend.month_started'))
  t.deepEqual(fs.readdirSync(dir).sort(), [path.basename(nov), path.basename(dec)], 'both journals, nothing else')
  t.equal(fs.readFileSync(nov, 'utf8'), november, 'November is untouched')
  fs.rmSync(base, { recursive: true, force: true })
  t.end()
})
