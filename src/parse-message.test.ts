import test from 'tape'
import { extractInstructions, extractPullRequests, parseMessage } from './parse-message'

// Slack never delivers the text the user typed: it wraps bare URLs in angle brackets.
// If the markup is not flattened first the URL regex sees a trailing '>' and the bot
// silently ignores every link, which is the whole trigger path.
test('parseMessage finds a PR URL inside Slack angle-bracket markup', t => {
  const parsed = parseMessage('please review <https://github.com/example-org/lib/pull/42>')
  t.equal(parsed.prs.length, 1)
  t.equal(parsed.prs[0].url, 'https://github.com/example-org/lib/pull/42')
  t.equal(parsed.prs[0].owner, 'example-org')
  t.equal(parsed.prs[0].repo, 'lib')
  t.equal(parsed.prs[0].number, 42)
  t.end()
})

// Slack renders a pasted link with custom text as <url|label>. Taking the label instead
// of the URL would yield "this one" and find no PR at all.
test('parseMessage takes the URL, not the label, from a labelled link', t => {
  const parsed = parseMessage('<https://github.com/o/r/pull/7|this one> looks risky')
  t.equal(parsed.prs.length, 1)
  t.equal(parsed.prs[0].url, 'https://github.com/o/r/pull/7')
  t.equal(parsed.instructions, 'looks risky')
  t.end()
})

// A message addressed to the bot carries <@U123>. Left in place it becomes noise at the
// front of the instructions handed to Codex.
test('parseMessage strips user mentions from the instructions', t => {
  const parsed = parseMessage('<@U01ABC> review https://github.com/o/r/pull/1 focus on the migration')
  t.equal(parsed.instructions, 'review focus on the migration')
  t.end()
})

// Slack HTML-escapes &, < and > in message text. An unescaped '&amp;' inside a URL
// query string would break the URL, and escaped brackets would defeat markup flattening.
test('parseMessage reverses Slack HTML escaping', t => {
  const parsed = parseMessage('&lt;https://github.com/o/r/pull/9&gt; ship it &amp; move on')
  t.equal(parsed.prs.length, 1)
  t.equal(parsed.instructions, 'ship it & move on')
  t.end()
})

// The same PR pasted twice (common when someone re-links it mid-sentence) must not be
// reviewed twice — a duplicate entry doubles the Codex work and the thread bullets.
test('extractPullRequests de-duplicates repeats and normalises trailing paths', t => {
  const prs = extractPullRequests(
    'https://github.com/o/r/pull/3/files https://github.com/o/r/pull/3 http://www.github.com/o/r/pull/3#discussion_r1'
  )
  t.equal(prs.length, 1)
  t.equal(prs[0].url, 'https://github.com/o/r/pull/3')
  t.end()
})

// Order matters: the output contract asks Codex for one entry per PR "in the order
// requested", and the thread reads better when it matches the message.
test('extractPullRequests preserves first-seen order', t => {
  const prs = extractPullRequests(
    'https://github.com/o/b/pull/2 and https://github.com/o/a/pull/1'
  )
  t.deepEqual(prs.map(p => p.repo), ['b', 'a'])
  t.end()
})

// Only pull requests trigger a review. Issue and commit links are shared in the same
// channels constantly; reviewing them would fail and burn a Codex run each time.
test('extractPullRequests ignores non-PR GitHub URLs and other hosts', t => {
  const prs = extractPullRequests(
    'https://github.com/o/r/issues/5 https://github.com/o/r/commit/abc https://gitlab.com/o/r/pull/1 https://example.com/pull/1'
  )
  t.equal(prs.length, 0)
  t.end()
})

// #15: '/pull/12abc' is not PR 12. The number must be followed by a real URL boundary, or the
// bot would match the '12' prefix and review the wrong pull request. (A bare `(?!\d)` only
// blocked a trailing digit, so 'abc' slipped through.)
test('extractPullRequests rejects a PR number with trailing junk glued on', t => {
  t.equal(extractPullRequests('https://github.com/o/r/pull/12abc').length, 0, '12abc is not a PR')
  t.equal(extractPullRequests('https://github.com/o/r/pull/12-3').length, 0, 'no hyphen-glued suffix')
  t.equal(extractPullRequests('https://github.com/o/r/pullx/12').length, 0, 'pullx is not pull')
  // A genuine boundary after the number is still accepted, and canonicalises to just the number.
  t.equal(extractPullRequests('https://github.com/o/r/pull/12')[0]?.number, 12, 'end of string')
  t.equal(extractPullRequests('https://github.com/o/r/pull/12/files')[0]?.number, 12, 'a path boundary')
  t.equal(extractPullRequests('https://github.com/o/r/pull/12?tab=x')[0]?.number, 12, 'a query boundary')
  t.equal(extractPullRequests('https://github.com/o/r/pull/12#discussion')[0]?.number, 12, 'a fragment boundary')
  t.equal(extractPullRequests('review https://github.com/o/r/pull/12 now')[0]?.number, 12, 'whitespace boundary')
  t.end()
})

// The boundary must NOT reject natural prose/markup punctuation — that was the round-1 regression
// where the terminator was too narrow and dropped comma/period/paren-delimited links.
test('extractPullRequests accepts PR URLs delimited by ordinary punctuation', t => {
  t.equal(extractPullRequests('https://github.com/o/r/pull/12, thanks')[0]?.number, 12, 'comma')
  t.equal(extractPullRequests('see https://github.com/o/r/pull/12.')[0]?.number, 12, 'period')
  t.equal(extractPullRequests('(https://github.com/o/r/pull/12)')[0]?.number, 12, 'parenthesis')
  // A comma-separated pair must yield BOTH PRs, not just the last one.
  const both = extractPullRequests('https://github.com/o/r/pull/12, https://github.com/o/r/pull/13')
  t.deepEqual(
    both.map(p => p.number),
    [12, 13],
    'both PRs in a comma-separated list are extracted'
  )
  t.end()
})

// Removing only the matched URL prefix would leave '/files#diff-abc' behind, which then
// reaches Codex as if the user had asked for something.
test('extractInstructions removes the whole URL token, not just the matched prefix', t => {
  t.equal(
    extractInstructions('check https://github.com/o/r/pull/4/files#diff-abc123 for the null case'),
    'check for the null case'
  )
  t.end()
})

// A bare list of PRs carries no instructions. Punctuation left stranded by URL removal
// would otherwise become the instruction ',' or '-'.
test('extractInstructions yields empty text for a message that is only links', t => {
  t.equal(
    extractInstructions('https://github.com/o/r/pull/1, https://github.com/o/r/pull/2'),
    ''
  )
  t.equal(extractInstructions('- https://github.com/o/r/pull/1'), '')
  t.end()
})

// Multi-line requests are normal in Slack; the line structure is meaningful to the
// reader and should survive into the prompt.
test('extractInstructions keeps line breaks between non-empty lines', t => {
  const text = 'review these:\nhttps://github.com/o/r/pull/1\nskip the coverage gate'
  t.equal(extractInstructions(text), 'review these:\nskip the coverage gate')
  t.end()
})
