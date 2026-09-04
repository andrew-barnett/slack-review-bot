import test from 'tape'
import type { ActivitySnapshot } from './progress'
import { createStats, formatDuration, renderStatus } from './status'

const MINUTE = 60_000
const HOUR = 60 * MINUTE

const config = {
  codexProfile: 'review-bot',
  concurrency: 1,
  runTimeoutMs: 3 * HOUR,
  channels: 1,
  ignoredUsers: 1,
}

// The units carry the meaning here: a status reply saying "180m" instead of "3h" makes the
// reader do arithmetic to answer "has this been up since I started it".
test('formatDuration steps up through units', t => {
  t.equal(formatDuration(0), '0s')
  t.equal(formatDuration(45_000), '45s')
  t.equal(formatDuration(5 * MINUTE), '5m')
  t.equal(formatDuration(3 * HOUR + 12 * MINUTE), '3h 12m')
  t.equal(formatDuration(50 * HOUR), '2d 2h')
  t.equal(formatDuration(-1000), '0s', 'clock skew must not render a negative uptime')
  t.end()
})

// A fresh daemon is the state you are most likely to be asking about — right after
// launching it — so it has to render without a last-review line rather than blank or NaN.
test('renderStatus reports a daemon that has reviewed nothing', t => {
  const stats = createStats(0)
  const text = renderStatus(stats.snapshot(90 * MINUTE, 0, 0, config))
  t.ok(text.includes('*Up* 1h 30m'), 'uptime')
  t.ok(text.includes('none since start'), 'no reviews yet')
  t.notOk(text.includes('*Last*'), 'no last-review line')
  t.ok(text.includes('concurrency 1'), 'config summary')
  t.end()
})

// The queue depth is the one number that distinguishes "wedged on a long review" from
// "idle and ignoring you", which is the question a status request is usually asking.
test('renderStatus reports queue depth and the last outcome', t => {
  const stats = createStats(0)
  stats.record('pass', 1, 10 * MINUTE)
  stats.record('findings', 2, 20 * MINUTE)
  const text = renderStatus(stats.snapshot(30 * MINUTE, 1, 2, config))
  t.ok(text.includes('1 running, 2 waiting'), 'queue depth')
  t.ok(text.includes('1 passed, 1 with findings, 0 errored'), 'counts')
  t.ok(text.includes('*Last* findings — 2 PRs, 10m ago'), 'last review')
  t.end()
})

// The token line sums only the reviews that reported a count, and the average's denominator is
// those same reviews — so a run that reported none (a killed run, recorded with no tokens) does
// not drag the average toward zero. Figures are compact: total, last, and the mean per review.
test('renderStatus reports token totals, average, and the last review only over reviews that reported', t => {
  const stats = createStats(0)
  stats.record('pass', 1, 5 * MINUTE, 200_000)
  stats.record('findings', 1, 10 * MINUTE, 300_000)
  stats.record('error', 1, 12 * MINUTE) // a killed run reported no tokens
  const text = renderStatus(stats.snapshot(15 * MINUTE, 0, 0, config))
  // total 500K over the two reporting reviews -> 250K average; the error is excluded from both.
  t.ok(text.includes('*Tokens* 500K total · 300K last · 250K avg'), text)
  t.end()
})

// Before any review has reported a count the line is omitted entirely: a "0 tokens" line on a
// fresh daemon would read as a malfunction rather than a clean slate.
test('renderStatus omits the token line until a review reports a count', t => {
  const stats = createStats(0)
  t.notOk(renderStatus(stats.snapshot(MINUTE, 0, 0, config)).includes('*Tokens*'), 'nothing recorded yet')
  // A review that ran but reported no tokens still leaves the line off — there is no figure to show.
  stats.record('error', 1, 2 * MINUTE)
  t.notOk(renderStatus(stats.snapshot(3 * MINUTE, 0, 0, config)).includes('*Tokens*'), 'no count means no line')
  t.end()
})

// Counters describe this process only. Sharing the object between snapshots would let a
// later snapshot mutate an earlier one, which matters because snapshot() is what the
// message handler hands to the renderer while reviews are still finishing.
test('createStats snapshots do not alias the live counters', t => {
  const stats = createStats(0)
  stats.record('pass', 1, 1000)
  const before = stats.snapshot(2000, 0, 0, config)
  stats.record('error', 1, 3000)
  t.equal(before.counts.error, 0, 'the earlier snapshot is unchanged')
  t.equal(stats.snapshot(4000, 0, 0, config).counts.error, 1)
  t.end()
})

// Singular/plural in the config line: "1 channels" reads like a bug in a message whose
// whole job is to inspire confidence that the bot is healthy.
test('renderStatus pluralises the config summary', t => {
  const stats = createStats(0)
  const one = renderStatus(stats.snapshot(1000, 0, 0, config))
  t.ok(one.includes('1 channel,'), 'singular channel')
  t.ok(one.includes('1 ignored user'), 'singular user')
  const many = renderStatus(
    stats.snapshot(1000, 0, 0, { ...config, channels: 0, ignoredUsers: 3 })
  )
  t.ok(many.includes('any channel'), 'no allowlist reads as any channel')
  t.ok(many.includes('3 ignored users'), 'plural users')
  t.end()
})

// A catch-up is the moment the bot is most likely to have found something it missed, and the
// status reply is where anyone would look. Without this line, a catch-up that requeued three
// reviews and one that silently dropped them look identical from Slack.
test('renderStatus reports the last catch-up and its cadence', t => {
  const stats = createStats(0)
  const idle = renderStatus(stats.snapshot(10 * MINUTE, 0, 0, config), {
    enabled: true,
    intervalMs: 5 * MINUTE,
    last: { reason: 'timer', at: 8 * MINUTE, summary: { channels: 1, dispatched: 0, skipped: 0, failed: 0 } },
  })
  t.ok(idle.includes('*Catch-up* nothing missed, 2m ago (timer)'), 'a clean pass')
  t.ok(idle.includes('every 5m'), 'and how often it happens')

  const busy = renderStatus(stats.snapshot(10 * MINUTE, 1, 2, config), {
    enabled: true,
    intervalMs: 5 * MINUTE,
    last: { reason: 'reconnect', at: 9 * MINUTE, summary: { channels: 2, dispatched: 3, skipped: 1, failed: 1 } },
  })
  t.ok(busy.includes('3 requeued, 1 skipped'), 'what it picked up and what it dropped')
  t.ok(busy.includes('1 channel unreadable'), 'and a channel it could not read')
  t.ok(busy.includes('(reconnect)'), 'a reconnect-driven pass is distinguishable from a timer one')
  t.end()
})

// "Off" and "has not finished one yet" need different words: the first is a configuration
// mistake that loses messages forever, the second is a daemon that started ten seconds ago.
// The old startup-only line rendered both as absent, which is what made this worth splitting.
test('renderStatus distinguishes catch-up off from catch-up pending', t => {
  const stats = createStats(0)
  const off = renderStatus(stats.snapshot(MINUTE, 0, 0, config), { enabled: false, intervalMs: 0 })
  t.ok(off.includes('*Catch-up* off'), 'disabled is worth saying out loud')

  const pending = renderStatus(stats.snapshot(MINUTE, 0, 0, config), { enabled: true, intervalMs: 5 * MINUTE })
  t.ok(pending.includes('none finished yet'), 'not the same as off')
  t.notOk(pending.includes('*Catch-up* off'), 'and must not read as off')

  const noTimer = renderStatus(stats.snapshot(MINUTE, 0, 0, config), { enabled: true, intervalMs: 0 })
  t.ok(noTimer.includes('on reconnect only'), 'a disabled timer is visible, since it is the backstop')
  t.end()
})

// A failed catch-up must not render as a successful one. Silence was the original bug; a
// status reply that says "nothing missed" when conversations.history is 403ing would be worse
// than silence, because it actively argues the bot is healthy.
test('renderStatus reports a catch-up that failed', t => {
  const stats = createStats(0)
  const text = renderStatus(stats.snapshot(10 * MINUTE, 0, 0, config), {
    enabled: true,
    intervalMs: 5 * MINUTE,
    last: { reason: 'timer', at: 9 * MINUTE, error: 'Error: missing_scope' },
  })
  t.ok(text.includes('failed 1m ago (timer)'), 'the failure leads')
  t.ok(text.includes('missing_scope'), 'with the reason attached')
  t.notOk(text.includes('nothing missed'), 'and never reads as a clean pass')
  t.end()
})

// A pass that hangs is the one way the coalescing can turn against us: it holds the runner
// busy, every later request is dropped, and nothing logs an error. A normal pass takes
// milliseconds, so this line must stay absent in the common case or it is just noise.
test('renderStatus calls out a catch-up pass that looks stuck', t => {
  const stats = createStats(0)
  const base = { enabled: true, intervalMs: 5 * MINUTE }

  const quick = renderStatus(stats.snapshot(MINUTE, 0, 0, config), { ...base, runningForMs: 40 })
  t.notOk(quick.includes('STUCK'), 'a pass in flight is normal and says nothing')

  const wedged = renderStatus(stats.snapshot(30 * MINUTE, 0, 0, config), {
    ...base,
    runningForMs: 12 * MINUTE,
    last: { reason: 'startup', at: 0, summary: { channels: 1, dispatched: 0, skipped: 0, failed: 0 } },
  })
  t.ok(wedged.includes('STUCK: a pass has been running for 12m'), 'a wedged one is named')
  t.ok(wedged.includes('nothing missed'), 'without hiding when the last one did finish')
  t.end()
})

// The link line is what separates "idle because nobody asked" from "idle because the socket
// has been down for an hour" — the two states that produced identical silence in the channel
// and sent us to the log file to tell them apart.
test('renderStatus reports the socket state', t => {
  const stats = createStats(0)
  const up = renderStatus(stats.snapshot(30 * MINUTE, 0, 0, config), undefined, {
    connected: true,
    reconnects: 20,
    lastConnectedAt: 25 * MINUTE,
  })
  t.ok(up.includes('*Link* connected for 5m'), 'how long the current connection has held')
  t.ok(up.includes('20 reconnects'), 'churn is the tell for a flaky network')

  const down = renderStatus(stats.snapshot(30 * MINUTE, 0, 0, config), undefined, {
    connected: false,
    reconnects: 3,
    lastDisconnectedAt: 28 * MINUTE,
  })
  t.ok(down.includes('down for 2m'), 'a live outage is stated, not implied')

  const fresh = renderStatus(stats.snapshot(MINUTE, 0, 0, config), undefined, {
    connected: false,
    reconnects: 0,
  })
  t.ok(fresh.includes('not connected yet'), 'a daemon that never connected reads sensibly')
  t.notOk(fresh.includes('reconnect'), 'and does not claim churn it has not had')
  t.end()
})

// A skipped request (a deleted message the bot declined to review) is reported alongside the
// verdicts, not folded into them, so "errored" still means a review that actually failed.
test('renderStatus reports skipped requests separately from verdicts', t => {
  const stats = createStats(0)
  stats.record('pass', 1, 10 * MINUTE)
  stats.record('skipped', 1, 20 * MINUTE)
  const text = renderStatus(stats.snapshot(30 * MINUTE, 0, 0, config))
  t.ok(text.includes('1 passed, 0 with findings, 0 errored, 1 skipped'), 'skipped appended to the counts')
  t.end()
})

// Skips alone must not read as "none since start": the bot has been doing something, and the
// distinction is exactly what this line exists to show.
test('renderStatus shows counts when only skips have happened', t => {
  const stats = createStats(0)
  stats.record('skipped', 1, 10 * MINUTE)
  const text = renderStatus(stats.snapshot(30 * MINUTE, 0, 0, config))
  t.notOk(text.includes('none since start'), 'a skip is activity, not silence')
  t.ok(text.includes('1 skipped'), 'and it is counted')
  t.end()
})

// --- Live activity block: what the bot is working on right now. ---

// The headline feature: the status reply names the active review, how long it has run, how
// much of that was active, which attempt it is on, and the last thing Codex printed.
test('renderStatus shows the active review with duration, attempt, and last output', t => {
  const stats = createStats(0)
  const activity: ActivitySnapshot = {
    active: [
      {
        labels: ['trade-platform-monorepo#304', 'aix-ui#5459'],
        wallMs: 6 * MINUTE,
        activeMs: 4 * MINUTE,
        attempt: 1,
        attempts: 4,
        lastLine: 'running jest in libs/orders',
        sinceOutputMs: 12_000,
      },
    ],
    waiting: [],
  }
  const text = renderStatus(stats.snapshot(30 * MINUTE, 1, 0, config), undefined, undefined, activity)
  t.ok(
    text.includes('*Reviewing* trade-platform-monorepo#304, aix-ui#5459 — in review 6m (4m active) · attempt 1/4'),
    'names, duration, active time and attempt'
  )
  t.ok(text.includes('_last update 12s ago:_ `running jest in libs/orders`'), 'the live output line')
  t.end()
})

// Waiting requests are named, not just counted — the second half of what a backlog check wants.
test('renderStatus lists waiting reviews by name', t => {
  const stats = createStats(0)
  const activity: ActivitySnapshot = {
    active: [],
    waiting: [{ labels: ['aix-ui#5460'] }, { labels: ['deployments#1230'] }],
  }
  const text = renderStatus(stats.snapshot(30 * MINUTE, 0, 2, config), undefined, undefined, activity)
  t.ok(text.includes('*Waiting* aix-ui#5460, deployments#1230'), 'waiting PRs named')
  t.end()
})

// The noise-control cases: a single-attempt run shows no "attempt" clause, a run that has not
// printed yet shows no "last update" line, and zero active time is not rendered as "(0s active)".
test('renderStatus omits attempt, active time, and last-output when they add nothing', t => {
  const stats = createStats(0)
  const activity: ActivitySnapshot = {
    active: [{ labels: ['repo#1'], wallMs: 5000, activeMs: 0, attempt: 1, attempts: 1 }],
    waiting: [],
  }
  const text = renderStatus(stats.snapshot(30 * MINUTE, 1, 0, config), undefined, undefined, activity)
  t.ok(text.includes('*Reviewing* repo#1 — in review 5s'), 'just the review and its duration')
  t.notOk(text.includes('attempt'), 'no attempt clause for a single-attempt run')
  t.notOk(text.includes('active)'), 'no active-time clause before any is measured')
  t.notOk(text.includes('last update'), 'no output line before the run prints')
  t.end()
})

// An idle daemon passes an empty activity snapshot; the block simply does not appear.
test('renderStatus shows no activity block when nothing is running or waiting', t => {
  const stats = createStats(0)
  const text = renderStatus(stats.snapshot(30 * MINUTE, 0, 0, config), undefined, undefined, { active: [], waiting: [] })
  t.notOk(text.includes('*Reviewing*'), 'nothing to report')
  t.notOk(text.includes('*Waiting*'), 'and nothing waiting')
  t.end()
})
