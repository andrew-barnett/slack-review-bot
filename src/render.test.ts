import test from 'tape'
import { oneSentence, renderDualThread, renderError, renderThread, shortLabel, verdictFor, worstOutcome } from './render'
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

// The dual thread shows, per PR, the outcome, the pre-flight verdict, each engine's state and the
// review link, then the reason, the missing items and any read-back warning (spec 5.9).
test('renderDualThread shows outcome, pre-flight, engines, link, missing and warnings', t => {
  const text = renderDualThread({
    prs: [
      {
        url: 'https://github.com/o/r/pull/1',
        outcome: 'approvedPartial',
        pinnedSha: 'a'.repeat(40),
        eligibility: { verdict: 'partial', reasons: ['the bot approval satisfies some but not all requirements'], missing: ['1 more approval'], lastPushApproval: false, dismissStale: false },
        passes: [
          { engine: 'codex', state: 'clean', detail: 'clean' },
          { engine: 'claude', state: 'clean', detail: 'clean (1 non-blocking)' },
        ],
        reviewUrl: 'https://github.com/o/r/pull/1#pullrequestreview-9',
        warnings: ['pre-flight predicted more approvals were needed, but GitHub reports reviewDecision APPROVED, mergeStateStatus CLEAN'],
      },
      { url: 'https://github.com/o/r/pull/2', outcome: 'blocked', passes: [], warnings: [], reason: 'update-branch was refused (HTTP 422)' },
    ],
  })
  const lines = text.split('\n')
  t.equal(lines[0], 'Dual-engine review of 2 pull requests.')
  t.equal(
    lines[1],
    '• <https://github.com/o/r/pull/1|o/r#1> — *approved (partial)* · pre-flight partial · Codex: clean · Claude: clean (1 non-blocking) · <https://github.com/o/r/pull/1#pullrequestreview-9|(review)>'
  )
  t.ok(text.includes('_still needed: 1 more approval_'))
  t.ok(text.includes(':warning: pre-flight predicted more approvals were needed'))
  t.ok(text.includes('• <https://github.com/o/r/pull/2|o/r#2> — *blocked*\n    _update-branch was refused (HTTP 422)_'))
  t.end()
})

// An idempotency skip says once, in the runner's reason, which earlier review stands. Regression
// caught: the generic "already reviewed" line repeated under it.
test('renderDualThread states an already-reviewed skip once', t => {
  const text = renderDualThread({
    prs: [
      {
        url: 'https://github.com/o/r/pull/1',
        outcome: 'cleanNotCounted',
        pinnedSha: 'a'.repeat(40),
        passes: [],
        alreadyReviewed: true,
        reason: 'already reviewed at aaaaaaa (COMMENTED); that review stands and nothing new was posted',
        warnings: [],
      },
    ],
  })
  t.equal(text.split('already reviewed').length - 1, 1)
  t.ok(text.includes('*clean, approval would not count*'))
  t.end()
})

// The worst outcome decides a mixed request's reaction; the order is spec 5.9's extension of
// single mode's (error and blocked worst, approved best).
test('worstOutcome picks the worst outcome present', t => {
  t.equal(worstOutcome(['approved', 'approvedPartial']), 'approvedPartial')
  t.equal(worstOutcome(['headMoved', 'findings']), 'findings')
  t.equal(worstOutcome(['approved', 'blocked']), 'blocked')
  t.equal(worstOutcome([]), 'error', 'nothing to report is not a pass')
  t.end()
})

// Engine and GitHub text must not reach Slack as control syntax. Regression caught: a
// `<!channel>` or `<@U1>` in engine output pinging people, or `<url|label>` spoofing a link,
// while the bot's own PR link must stay a real link.
test('renderDualThread escapes untrusted text but keeps the bot link', t => {
  const evil = '<!channel> <@U1> <https://x|y> & more'
  const text = renderDualThread({
    prs: [
      {
        url: 'https://github.com/o/r/pull/1',
        outcome: 'blocked',
        passes: [{ engine: 'codex', state: 'error', detail: evil }],
        warnings: [evil],
        reason: evil,
        eligibility: { verdict: 'partial', reasons: [evil], missing: [evil], lastPushApproval: false, dismissStale: false },
      },
    ],
  })
  t.notOk(text.includes('<!channel>') || text.includes('<@U1>') || text.includes('<https://x|y>'))
  t.ok(text.includes('&lt;!channel&gt; &lt;@U1&gt; &lt;https://x|y&gt; &amp; more'))
  t.ok(text.includes('<https://github.com/o/r/pull/1|o/r#1>'))
  t.end()
})

// The same guard for single mode's model-written summary (renderThread).
test('renderThread escapes a summary containing Slack control syntax', t => {
  const text = renderThread({ results: [pr('https://github.com/o/r/pull/1', 'findings', '<!channel> look <@U1>')] } as ReviewRunResult)
  t.notOk(text.includes('<!channel>') || text.includes('<@U1>'))
  t.ok(text.includes('&lt;!channel&gt;'))
  t.ok(text.includes('<https://github.com/o/r/pull/1|o/r#1>'))
  t.end()
})
