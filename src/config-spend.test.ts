import * as path from 'path'
import test from 'tape'
import { loadConfig, parseAlertChannel, parseAlertPercents, parseCapUsd, parseHerePercents } from './config'

/** The two required keys, so a test can vary only the knob it cares about. */
const credentials = { SLACK_BOT_TOKEN: 'placeholder', SLACK_APP_TOKEN: 'placeholder' }

// Spec 4: every default as the table gives it. Regression caught: a default drifting from the spec, which
// would move the cap or the alert points without anyone deciding to.
test('the spend settings default as the spec says', t => {
  const c = loadConfig({ ...credentials, HOME: '/home/u', SLACK_CHANNEL_IDS: 'C0123456789,C0987654321' })
  t.equal(c.spendCapUsd, 1000)
  t.deepEqual(c.spendAlertPercents, [25, 50, 75, 90])
  t.deepEqual(c.spendAlertHerePercents, [75, 90])
  t.equal(c.spendAlertChannel, 'C0123456789', 'the first allowlisted channel')
  t.ok(c.bedrockPricesFile.endsWith(path.join('pricing', 'bedrock-prices.json')), c.bedrockPricesFile)
  t.equal(c.spendDir, '/home/u/.local/state/slack-review-bot')
  t.end()
})

// Spec 7 / ruling 9: the monthly journals sit beside CURSOR_FILE (the container's state volume), and an
// empty CURSOR_FILE, which disables the cursor, must not disable the ledger with it.
test('the spend journals sit beside CURSOR_FILE, and an empty CURSOR_FILE never disables them', t => {
  const container = loadConfig({ ...credentials, HOME: '/home/bot', CURSOR_FILE: '/var/lib/slack-review-bot/state/cursors.json' })
  t.equal(container.spendDir, '/var/lib/slack-review-bot/state')
  const noCursor = loadConfig({ ...credentials, HOME: '/home/u', CURSOR_FILE: '' })
  t.equal(noCursor.spendDir, '/home/u/.local/state/slack-review-bot')
  t.end()
})

// Spec 4: a positive finite number of US dollars, otherwise startup fails. A typo must not become an
// unlimited or zero cap.
test('parseCapUsd accepts a positive number and refuses anything else', t => {
  t.equal(parseCapUsd(undefined), 1000)
  t.equal(parseCapUsd(''), 1000)
  t.equal(parseCapUsd('250'), 250)
  t.equal(parseCapUsd('1500.50'), 1500.5)
  for (const bad of ['0', '-5', 'abc', '1e3', 'Infinity', '12,000']) {
    t.throws(() => parseCapUsd(bad), /BEDROCK_MONTHLY_CAP_USD must be a positive number/, bad)
  }
  t.throws(() => loadConfig({ ...credentials, HOME: '/home/u', BEDROCK_MONTHLY_CAP_USD: '0' }), /BEDROCK_MONTHLY_CAP_USD/, 'startup fails')
  t.end()
})

// Spec 4: integers 1-99, strictly ascending, no duplicates.
test('parseAlertPercents wants integers from 1 to 99 in strictly ascending order', t => {
  t.deepEqual(parseAlertPercents(undefined), [25, 50, 75, 90])
  t.deepEqual(parseAlertPercents('10, 20 80'), [10, 20, 80])
  for (const bad of ['50,25', '25,25', '0,50', '50,100', '12.5', 'x']) {
    t.throws(() => parseAlertPercents(bad), /SPEND_ALERT_PERCENTS must be integers from 1 to 99/, bad)
  }
  t.end()
})

// Ruling 6 / Review Focus 5: each @here percent must be an alert percent; unset means whichever of 75 and
// 90 are alert percents, so a custom alert list does not break startup; empty means no @here.
test('parseHerePercents must be a subset of the alert percents, and its default follows them', t => {
  t.deepEqual(parseHerePercents(undefined, [25, 50, 75, 90]), [75, 90])
  t.deepEqual(parseHerePercents(undefined, [50, 80]), [], 'a custom list without 75 or 90 still starts')
  t.deepEqual(parseHerePercents(undefined, [50, 90]), [90])
  t.deepEqual(parseHerePercents('', [25, 50, 75, 90]), [], 'explicitly empty: no @here on thresholds')
  t.deepEqual(parseHerePercents('50', [50, 80]), [50])
  t.throws(() => parseHerePercents('75', [50, 80]), /SPEND_ALERT_HERE_PERCENTS: 75 is not in SPEND_ALERT_PERCENTS/)
  t.throws(() => parseHerePercents('x', [50, 80]), /SPEND_ALERT_HERE_PERCENTS/)
  t.end()
})

// Spec 4 / ruling 7: the alert channel defaults to the first allowlisted channel, may be empty when there
// is none, and an explicit value must look like a channel ID (a #name never matches a Slack channel).
test('parseAlertChannel defaults to the first allowlisted channel and checks an explicit ID', t => {
  t.equal(parseAlertChannel(undefined, ['C0AAAA111', 'C0BBBB222']), 'C0AAAA111')
  t.equal(parseAlertChannel(undefined, []), '')
  t.equal(parseAlertChannel('G0123ABCD', []), 'G0123ABCD')
  t.throws(() => parseAlertChannel('#reviews', []), /SPEND_ALERT_CHANNEL must be a Slack channel ID/)
  t.end()
})

// The price file path is an operator override. Regression caught: the setting being read but ignored, so
// the daemon prices spend from the bundled table even when the operator pointed it at another file.
test('BEDROCK_PRICES_FILE overrides the default price file', t => {
  t.equal(loadConfig({ ...credentials, HOME: '/home/u', BEDROCK_PRICES_FILE: '/etc/srb/prices.json' }).bedrockPricesFile, '/etc/srb/prices.json')
  t.end()
})
