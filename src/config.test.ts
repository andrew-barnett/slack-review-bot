import test from 'tape'
import { loadConfig, looksLikeUserId, parseUserIds } from './config'

/** The two required keys, so a test can vary only the knob it cares about. */
const credentials = { SLACK_BOT_TOKEN: 'placeholder', SLACK_APP_TOKEN: 'placeholder' }
const FIVE_MINUTES = 5 * 60 * 1000

// Slack offers a member ID two ways: "Copy member ID" gives a bare U…, while pasting a
// mention gives <@U…>. Both have to reduce to what a message event carries, or the ignore
// list quietly never matches and the bot keeps reviewing the PRs it was told to skip.
test('parseUserIds normalises every form an ID arrives in', t => {
  t.deepEqual(parseUserIds('U012AB3CD, <@U045EF6GH>, <@U078IJ9KL|andrew>, @U0MNO12PQ, u0rst34uv'), [
    'U012AB3CD',
    'U045EF6GH',
    'U078IJ9KL',
    'U0MNO12PQ',
    'U0RST34UV',
  ])
  t.end()
})

// Unset must mean "ignore nobody" rather than throwing or ignoring everybody — the
// variable is optional and most installs will not set it.
test('parseUserIds treats unset and empty values as no one ignored', t => {
  t.deepEqual(parseUserIds(undefined), [])
  t.deepEqual(parseUserIds(''), [])
  t.deepEqual(parseUserIds('   '), [])
  t.end()
})

// Same separator rules as SLACK_CHANNEL_IDS, so the two lines in the credentials file do
// not behave differently from each other.
test('parseUserIds accepts commas and whitespace as separators', t => {
  t.deepEqual(parseUserIds('U012AB3CD U045EF6GH\tU078IJ9KL'), ['U012AB3CD', 'U045EF6GH', 'U078IJ9KL'])
  t.end()
})

// This only drives a startup warning, but it has to catch the mistake people actually
// make — listing a handle or display name, which can never match an event — without
// crying wolf on an Enterprise Grid W… account.
test('looksLikeUserId accepts U… and W… IDs and rejects names', t => {
  t.equal(looksLikeUserId('U012AB3CD'), true)
  t.equal(looksLikeUserId('W012AB3CD'), true)
  t.equal(looksLikeUserId('ANDREW'), false, 'a handle normalises to this and never matches')
  t.equal(looksLikeUserId('C012AB3CD'), false, 'a channel ID pasted by mistake')
  t.equal(looksLikeUserId(''), false)
  t.end()
})

// 0 has to mean "off" and not "unset". Every other interval in config.ts goes through
// parsePositiveInt, which reads 0 as out of range and hands back the default — so an
// operator who deliberately disabled the timer would silently get the 5-minute default and
// nothing anywhere would say so.
test('CATCHUP_INTERVAL_MS treats 0 as off but still rejects nonsense', t => {
  t.equal(loadConfig({ ...credentials }).catchUpIntervalMs, FIVE_MINUTES, 'default')
  t.equal(loadConfig({ ...credentials, CATCHUP_INTERVAL_MS: '0' }).catchUpIntervalMs, 0, 'off')
  t.equal(loadConfig({ ...credentials, CATCHUP_INTERVAL_MS: '60000' }).catchUpIntervalMs, 60_000)
  t.equal(
    loadConfig({ ...credentials, CATCHUP_INTERVAL_MS: 'soon' }).catchUpIntervalMs,
    FIVE_MINUTES,
    'a typo falls back to the default rather than switching the backstop off'
  )
  t.equal(loadConfig({ ...credentials, CATCHUP_INTERVAL_MS: '-1' }).catchUpIntervalMs, FIVE_MINUTES)
  t.end()
})

// The catch-up is the thing that makes a missed message recoverable without a restart, so
// both triggers default to on: an install that sets neither variable has to end up with the
// safe behaviour, since the failure mode of the old default was silence.
test('both catch-up triggers default to on', t => {
  const defaults = loadConfig({ ...credentials })
  t.equal(defaults.catchUpOnReconnect, true, 'reconnect trigger on')
  t.ok(defaults.catchUpIntervalMs > 0, 'timer on')
  t.equal(
    loadConfig({ ...credentials, CATCHUP_ON_RECONNECT: 'false' }).catchUpOnReconnect,
    false,
    'and it can be turned off explicitly'
  )
  t.end()
})

// The queued reaction is what tells a requester their message is waiting rather than missed.
// It needs a default that exists in every workspace, and it must differ from the ack — the
// job removes it by name once the ack is on, and an identical name would remove the ack.
test('loadConfig defaults the queued emoji and lets QUEUED_EMOJI override it', t => {
  const defaults = loadConfig({ ...credentials })
  t.equal(defaults.queuedEmoji, 'hourglass_flowing_sand')
  t.notEqual(defaults.queuedEmoji, defaults.ackEmoji, 'queued and ack must be distinct reactions')
  t.equal(loadConfig({ ...credentials, QUEUED_EMOJI: 'clock1' }).queuedEmoji, 'clock1')
  t.end()
})
