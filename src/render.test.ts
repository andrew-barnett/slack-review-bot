import test from 'tape'
import { oneSentence, renderError, renderThread, shortLabel, verdictFor } from './render'
import type { PullRequestResult, ReviewRunResult } from './schema'

function pr(url: string, status: PullRequestResult['status'], summary = ''): PullRequestResult {
  return { url, status, summary, pushedTestCommits: false, reviewUrl: '' }
}

function run(...results: PullRequestResult[]): ReviewRunResult {
  return { results }
}

test('verdictFor passes only when every PR passed', t => {
  t.equal(verdictFor(run(pr('a', 'passed'), pr('b', 'passed'))), 'pass')
  t.equal(verdictFor(run(pr('a', 'passed'), pr('b', 'findings'))), 'findings')
  t.end()
})

// A PR nobody could review has not cleared review. Counting 'blocked' as a pass would
// stamp :approved_stamp: on a message whose PRs were never actually looked at.
test('verdictFor treats a blocked PR as not passing', t => {
  t.equal(verdictFor(run(pr('a', 'passed'), pr('b', 'blocked', 'stale base'))), 'findings')
  t.end()
})

// An empty result set means Codex reported on nothing. That is a failure to review,
// not a clean bill of health.
test('verdictFor does not pass an empty result set', t => {
  t.equal(verdictFor(run()), 'findings')
  t.end()
})

test('renderThread separates findings, blocked, and passed PRs', t => {
  const text = renderThread(
    run(
      pr('https://github.com/o/a/pull/1', 'passed'),
      pr('https://github.com/o/b/pull/2', 'findings', 'Retry loop double-counts failures.'),
      pr('https://github.com/o/c/pull/3', 'blocked', 'Base branch will not merge cleanly.')
    )
  )
  t.ok(text.includes('Reviewed 3 pull requests.'))
  t.ok(text.includes('*Findings (1)*'))
  t.ok(text.includes('*Not reviewed (1)*'))
  t.ok(text.includes('*No findings (1)*'))
  t.ok(text.includes('Retry loop double-counts failures.'))
  t.ok(text.includes('Base branch will not merge cleanly.'))
  t.end()
})

// Slack mrkdwn only renders <url|text> for API posts; Markdown [text](url) shows
// literally, which would leave raw brackets all over the thread.
test('renderThread emits Slack mrkdwn links, not Markdown links', t => {
  const text = renderThread(run(pr('https://github.com/o/a/pull/1', 'findings', 'Bug.')))
  t.ok(text.includes('<https://github.com/o/a/pull/1|o/a#1>'))
  t.notOk(text.includes(']('), 'no Markdown link syntax')
  t.end()
})

// A passing PR's summary is specified to be empty, but the renderer must not print a
// dangling em dash if the model sends one anyway.
test('renderThread omits summaries for passed PRs', t => {
  const text = renderThread(run(pr('https://github.com/o/a/pull/1', 'passed', 'All good here.')))
  t.notOk(text.includes('All good here.'))
  t.notOk(text.includes('—'))
  t.end()
})

// Unsigned commits appearing on someone's branch need an explanation the author can
// find; the thread that caused them is that explanation.
test('renderThread discloses pushed test commits only when some were pushed', t => {
  const pushed = { ...pr('u', 'findings', 'Bug.'), pushedTestCommits: true }
  t.ok(renderThread(run(pushed)).includes('unsigned'))
  t.notOk(renderThread(run(pr('u', 'findings', 'Bug.'))).includes('unsigned'))
  t.end()
})

// The thread is a scan-at-a-glance surface; a model that ignores "one sentence" would
// otherwise dump a paragraph per PR into the channel.
test('oneSentence keeps the first sentence and caps runaway text', t => {
  t.equal(oneSentence('First thing. Second thing.'), 'First thing.')
  t.equal(oneSentence('Broke in v1.2. Also elsewhere.'), 'Broke in v1.2.')
  t.equal(oneSentence('No trailing period'), 'No trailing period')
  t.equal(oneSentence('  spaced\n out  '), 'spaced out')
  t.equal(oneSentence(''), '')
  t.ok(oneSentence('x'.repeat(400)).endsWith('…'))
  t.end()
})

test('shortLabel abbreviates a PR URL and falls back to the raw value', t => {
  t.equal(shortLabel('https://github.com/example-org/lib/pull/42'), 'example-org/lib#42')
  t.equal(shortLabel('not-a-url'), 'not-a-url')
  t.end()
})

// When the run itself fails the thread must say plainly that nothing was reviewed —
// silence plus a :warning: leaves the user guessing whether the PRs were checked.
test('renderError names the unreviewed PRs and includes the failure', t => {
  const text = renderError(['https://github.com/o/a/pull/1'], new Error('Codex exited with code 1'))
  t.ok(text.includes('*not* reviewed'))
  t.ok(text.includes('o/a#1'))
  t.ok(text.includes('Codex exited with code 1'))
  t.end()
})
