import test from 'tape'
import { loadConfig, looksLikeUserId, parseMsList, parseUserIds } from './config'

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

// The Codex env allowlist is the mechanism; CODEX_ENV_PASSTHROUGH is the operator escape hatch.
// It defaults to nothing (deny-by-default) and parses the same comma/whitespace list form as the
// other list vars.
test('CODEX_ENV_PASSTHROUGH defaults empty and parses a list', t => {
  t.deepEqual(loadConfig({ ...credentials }).codexEnvPassthrough, [], 'nothing passed through by default')
  t.deepEqual(
    loadConfig({ ...credentials, CODEX_ENV_PASSTHROUGH: 'FOO, BAR BAZ' }).codexEnvPassthrough,
    ['FOO', 'BAR', 'BAZ'],
    'commas and whitespace separate names'
  )
  t.end()
})

// The Slack request timeout defaults to a finite value so a wedged call can never hang the
// catch-up (issue #6), and is tunable for a slow network. A typo falls back rather than
// silently disabling the timeout.
test('SLACK_REQUEST_TIMEOUT_MS defaults finite and is tunable', t => {
  t.equal(loadConfig({ ...credentials }).slackRequestTimeoutMs, 30_000, 'default 30s')
  t.equal(
    loadConfig({ ...credentials, SLACK_REQUEST_TIMEOUT_MS: '60000' }).slackRequestTimeoutMs,
    60_000,
    'override honoured'
  )
  t.equal(
    loadConfig({ ...credentials, SLACK_REQUEST_TIMEOUT_MS: 'soon' }).slackRequestTimeoutMs,
    30_000,
    'a typo falls back to the default, not to no timeout'
  )
  t.end()
})

// The per-review usage reply defaults on — the feature is only useful if it appears without
// configuration — but an operator who finds it noisy has to be able to switch it off, while the
// status totals it feeds keep accruing regardless.
test('USAGE_REPLY_ENABLED defaults on and can be turned off', t => {
  t.equal(loadConfig({ ...credentials }).usageReplyEnabled, true, 'default on')
  t.equal(
    loadConfig({ ...credentials, USAGE_REPLY_ENABLED: 'false' }).usageReplyEnabled,
    false,
    'explicitly disabled'
  )
  t.equal(loadConfig({ ...credentials, USAGE_REPLY_ENABLED: 'off' }).usageReplyEnabled, false, 'off is honoured too')
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

// --- Stall back-off schedule and its 15-minute ceiling. ---

const MIN = 60 * 1000

// The operator's schedule, verbatim: 2, 5, 7, 12 minutes, then give up. Shipping it as the
// default means the bot behaves as specified with no configuration.
test('loadConfig defaults the stall back-off to the specified escalating schedule', t => {
  t.deepEqual(loadConfig({ ...credentials }).stallBackoffMs, [2, 5, 7, 12].map(m => m * MIN))
  t.equal(loadConfig({ ...credentials }).stallMaxMs, 15 * MIN, 'and caps a single wait at 15 minutes')
  t.end()
})

// STALL_BACKOFF_MS lets the schedule be retuned; every entry is still held under the ceiling
// so no override can make the bot wait longer than the cap for a sign of life.
test('loadConfig parses and clamps a custom stall schedule to the ceiling', t => {
  const config = loadConfig({ ...credentials, STALL_BACKOFF_MS: '60000, 120000, 3600000' })
  t.deepEqual(config.stallBackoffMs, [60_000, 120_000, 15 * MIN], 'the over-cap entry is clamped to 15 minutes')
  t.end()
})

// A lower ceiling clamps even the built-in default schedule, so the ceiling is a true upper
// bound rather than only a filter on overrides.
test('loadConfig clamps the default schedule to a lowered ceiling', t => {
  const config = loadConfig({ ...credentials, STALL_MAX_MS: String(3 * MIN) })
  t.deepEqual(config.stallBackoffMs, [2, 3, 3, 3].map(m => m * MIN), 'nothing exceeds a 3-minute ceiling')
  t.end()
})

// parseMsList in isolation. Three distinct cases (#13): unset uses the default, an explicitly
// empty value disables (returns []), and a non-empty typo falls back so a mistake cannot
// silently disable the feature.
test('parseMsList keeps valid entries, clamps them, and distinguishes empty from a typo', t => {
  const fallback = [1000, 2000]
  t.deepEqual(parseMsList('100, 200, 300', fallback, 250), [100, 200, 250], 'valid values, clamped')
  t.deepEqual(parseMsList('nope, -5, 0', fallback, 5000), fallback, 'a non-empty typo uses the fallback')
  t.deepEqual(parseMsList(undefined, fallback, 1500), [1000, 1500], 'an absent value uses the clamped fallback')
  t.deepEqual(parseMsList('', fallback, 5000), [], 'an explicit empty string disables (returns [])')
  t.deepEqual(parseMsList('   ', fallback, 5000), [], 'whitespace-only is also explicitly empty')
  t.end()
})

// #13: the README documents STALL_BACKOFF_MS= as the way to turn stall detection and retries
// off. An unset variable keeps the built-in schedule; an explicit empty value disables it.
test('STALL_BACKOFF_MS empty disables the schedule, unset keeps the default', t => {
  t.ok(loadConfig({ ...credentials }).stallBackoffMs.length > 0, 'unset uses the built-in schedule')
  t.deepEqual(loadConfig({ ...credentials, STALL_BACKOFF_MS: '' }).stallBackoffMs, [], 'empty disables it')
  t.deepEqual(
    loadConfig({ ...credentials, STALL_BACKOFF_MS: '1000,2000' }).stallBackoffMs,
    [1000, 2000],
    'an explicit schedule is honoured'
  )
  t.end()
})
