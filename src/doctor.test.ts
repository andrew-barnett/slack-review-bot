import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import test from 'tape'
import { loadConfig, type Config } from './config'
import {
  checkCursor,
  checkIgnoreList,
  explainHistoryError,
  findOnPath,
  parseAgentPathPrefix,
  summarise,
  type CheckResult,
} from './doctor'

const ok = (name: string): CheckResult => ({ name, status: 'ok', detail: 'fine' })
const warn = (name: string): CheckResult => ({ name, status: 'warn', detail: 'unverifiable' })
const fail = (name: string): CheckResult => ({ name, status: 'fail', detail: 'broken' })

// The exit code is what makes doctor usable as a launch gate, so warnings must not fail the
// run: they mark things this tool cannot verify (a scope it lacks), not things that are wrong.
test('summarise fails only on failures', t => {
  t.equal(summarise([ok('a'), ok('b')]).exitCode, 0)
  t.equal(summarise([ok('a'), warn('b')]).exitCode, 0, 'warnings alone still exit 0')
  t.equal(summarise([ok('a'), fail('b')]).exitCode, 1)
  t.end()
})

// An empty result list would make the column-width reduce return -Infinity and padEnd throw,
// taking the tool down instead of reporting anything.
test('summarise handles an empty result list', t => {
  const { lines, exitCode } = summarise([])
  t.equal(exitCode, 0)
  t.ok(lines.join('\n').includes('All checks passed'))
  t.end()
})

// The report is read as a column, so every status marker has to occupy the same width or the
// detail text stops lining up and the failures stop standing out.
test('summarise aligns names and marks every row', t => {
  const { lines } = summarise([ok('short'), fail('a much longer name')])
  t.ok(lines[0].startsWith('ok  '), 'ok marker')
  t.ok(lines[1].startsWith('FAIL'), 'failure marker')
  t.equal(
    lines[0].indexOf('fine'),
    lines[1].indexOf('broken'),
    'details start at the same column'
  )
  t.end()
})

// The mistake worth catching: a handle or display name in the ignore list. It normalises to
// something that can never match a Slack event, so the filter silently does nothing — which
// is precisely the failure doctor exists to make visible, hence fail rather than warn.
test('checkIgnoreList fails on entries that are not user IDs', t => {
  t.equal(checkIgnoreList([]).status, 'ok', 'an empty list is a valid configuration')
  t.equal(checkIgnoreList(['U012AB3CD']).status, 'ok')
  t.equal(checkIgnoreList(['W012AB3CD']).status, 'ok', 'Enterprise Grid IDs')
  const bad = checkIgnoreList(['U012AB3CD', 'ANDREW'])
  t.equal(bad.status, 'fail')
  t.ok(bad.detail.includes('ANDREW'), 'names the offending entry')
  t.end()
})

// `not_in_channel` on a history read is not a replay problem: the bot receives no live events
// from a channel it is not in either, so the channel has never worked. Reporting it as "replay
// will skip this channel" would send the reader hunting for a bug in the catch-up instead of
// typing /invite.
test('explainHistoryError separates membership from scope from everything else', t => {
  const slack = (code: string) => ({ data: { error: code } })
  const notIn = explainHistoryError(slack('not_in_channel'))
  t.ok(notIn.includes('/invite'), 'says what to do')
  t.ok(notIn.includes('receives no messages'), 'and that live delivery is broken too, not just replay')
  t.ok(
    explainHistoryError(slack('channel_not_found')).includes('/invite'),
    'a private channel the bot is not in reports the other code for the same cause'
  )
  t.ok(
    explainHistoryError(slack('missing_scope')).includes('channels:history'),
    'names the scope rather than the method'
  )
  const other = explainHistoryError(slack('ratelimited'))
  t.ok(other.includes('ratelimited') && other.includes('replay will skip'), 'anything else is replay-only')
  t.end()
})

function configWith(env: Record<string, string>): Config {
  return loadConfig({ SLACK_BOT_TOKEN: 'xoxb-fake', SLACK_APP_TOKEN: 'xapp-fake', ...env })
}

// The cursor is the only daemon state that has to outlive the process. If it cannot be
// written the bot still reviews, so nothing looks wrong — it just silently stops picking up
// anything posted while it was down, which is the failure this whole file exists to surface.
test('checkCursor reports whether the position can be kept', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-test-'))

  const creatable = checkCursor(configWith({ CURSOR_FILE: path.join(dir, 'sub', 'cursors.json') }))
  t.equal(creatable[0].status, 'ok', 'a path that does not exist yet is fine')
  t.ok(creatable[0].detail.includes('created on first message'))

  const file = path.join(dir, 'cursors.json')
  fs.writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      channels: { C1: { ts: '1.000000', done: [], updatedAt: '' } },
    })
  )
  const existing = checkCursor(configWith({ CURSOR_FILE: file }))
  t.equal(existing[0].status, 'ok')
  t.ok(existing[0].detail.includes('1 channel recorded'), 'reports what it has been tracking')

  const off = checkCursor(configWith({ CURSOR_FILE: '' }))
  t.equal(off[0].status, 'warn', 'turning it off is a choice, not a fault')

  const noReplay = checkCursor(configWith({ CURSOR_FILE: file, REPLAY_ENABLED: 'false' }))
  t.equal(noReplay.length, 2, 'a cursor kept but never acted on gets its own line')
  t.equal(noReplay[1].status, 'warn')

  fs.rmSync(dir, { recursive: true, force: true })
  t.end()
})

// Two variables that read like tuning knobs can between them switch the bot back to
// catching up only at startup — which is the behaviour that lost a message and took a
// manual restart to recover. Doctor has to say so, because nothing else will.
test('checkCursor reports which catch-up triggers are live', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-catchup-'))
  const file = path.join(dir, 'cursors.json')

  const defaults = checkCursor(configWith({ CURSOR_FILE: file }))
  const catchUp = defaults.find(r => r.name === 'catch-up')
  t.equal(catchUp?.status, 'ok', 'the defaults are healthy')
  t.ok(catchUp?.detail.includes('reconnect'), 'and name the triggers')
  t.ok(catchUp?.detail.includes('every 5m'), 'including the timer, in readable units')

  const startupOnly = checkCursor(
    configWith({ CURSOR_FILE: file, CATCHUP_INTERVAL_MS: '0', CATCHUP_ON_RECONNECT: 'false' })
  )
  const degraded = startupOnly.find(r => r.name === 'catch-up')
  t.equal(degraded?.status, 'warn', 'startup-only is the old broken behaviour and warns')
  t.ok(degraded?.detail.includes('waits for a restart'), 'and says what it costs')

  const timerOnly = checkCursor(configWith({ CURSOR_FILE: file, CATCHUP_ON_RECONNECT: 'false' }))
  t.equal(
    timerOnly.find(r => r.name === 'catch-up')?.status,
    'ok',
    'the timer alone is still a backstop'
  )

  fs.rmSync(dir, { recursive: true, force: true })
  t.end()
})

// The whole point of reading PATH back out of the plist is that it is the agent's PATH and
// not the invoking shell's. If this parse silently returns undefined the toolchain check
// degrades to a warning and the ENOENT it exists to catch sails straight through.
test('parseAgentPathPrefix recovers the baked-in prefix', t => {
  const plist = '<string>export PATH="/a/bin:/opt/homebrew/bin:$PATH"; set -a; . "/x/env"; set +a; exec "/n" "/app"</string>'
  t.equal(parseAgentPathPrefix(plist), '/a/bin:/opt/homebrew/bin')
  t.end()
})

// A plist written before this fix has no export at all. That has to read as "unknown" so the
// check warns, rather than as an empty prefix that would resolve against the wrong PATH.
test('parseAgentPathPrefix returns undefined for a pre-fix plist', t => {
  t.equal(parseAgentPathPrefix('<string>set -a; . "/x/env"; set +a; exec "/n" "/app"</string>'), undefined)
  t.end()
})

// Resolution has to match execvp: first hit wins, left to right. Getting the order wrong is
// how `npm` ends up being a Homebrew npm bound to a different node than the agent runs.
test('findOnPath takes the leftmost match', t => {
  const present = new Set(['/second/npm', '/first/npm'])
  t.equal(findOnPath('npm', '/first:/second', c => present.has(c)), '/first/npm')
  t.equal(findOnPath('npm', '/second:/first', c => present.has(c)), '/second/npm')
  t.end()
})

// Empty segments appear in a real PATH (a trailing colon), and path.join would turn one into
// a relative lookup in the cwd — a wrong answer that reads as success.
test('findOnPath skips empty segments and reports a genuine miss', t => {
  t.equal(findOnPath('codex', '/nope::/also-nope', () => false), undefined)
  t.equal(findOnPath('codex', ':/bin', c => c === 'codex'), undefined, 'never resolves relative to cwd')
  t.end()
})
