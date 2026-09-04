import test from 'tape'
import {
  ReviewFailedError,
  formatActive,
  formatTokensCompact,
  formatTokensExact,
  parseTokensUsed,
  renderUsageLine,
} from './usage'

// The real transcript shape: `codex exec` prints the label and the comma-grouped number on the
// next line. Parsing has to survive the commas and the newline between the two.
test('parseTokensUsed reads the two-line codex exec form', t => {
  t.equal(parseTokensUsed('...diff...\ntokens used\n300,448\n{"results":[]}'), 300448)
  t.end()
})

// Other builds print it inline as `tokens used: N`; both forms must parse to the same number.
test('parseTokensUsed reads the inline form', t => {
  t.equal(parseTokensUsed('tokens used: 12345'), 12345)
  t.end()
})

// A run reported more than once (a retry appended to the same transcript, say) is read as its
// final figure, not its first — the last total is the one that reflects the whole run.
test('parseTokensUsed takes the last occurrence', t => {
  t.equal(parseTokensUsed('tokens used\n1,000\n...\ntokens used\n2,500'), 2500)
  t.end()
})

// The normal failure case: a killed run dies before printing a total, so there is nothing to
// read. Undefined (not zero) keeps that distinct from a run that genuinely used no tokens.
test('parseTokensUsed returns undefined when no total was printed', t => {
  t.equal(parseTokensUsed('some output with no total in it'), undefined)
  t.equal(parseTokensUsed(''), undefined)
  t.end()
})

// The transcript also carries the diffs and command output Codex reviewed, which can contain
// the string "tokens used N" (this file does). Only a standalone footer line counts — text
// embedded in a reviewed line must never be mistaken for the run's real total.
test('parseTokensUsed ignores "tokens used" embedded in reviewed content', t => {
  // A diff/comment line mentioning the phrase is not a footer.
  t.equal(parseTokensUsed('+  const re = /tokens used 999/  // tokens used 12345 here'), undefined)
  t.equal(parseTokensUsed('-    assert(parseTokensUsed("tokens used 999"))'), undefined)
  t.end()
})

// When reviewed content contains a fake "tokens used N" AND the run then prints its real footer,
// the real footer (a standalone line, and the last one) wins — not the embedded fake.
test('parseTokensUsed takes the real footer over embedded fakes', t => {
  const transcript = [
    '+  // tokens used 999999 in the diff under review',
    'diff --git a/x b/x',
    'tokens used',
    '300,448',
  ].join('\n')
  t.equal(parseTokensUsed(transcript), 300_448)
  t.end()
})

test('formatTokensExact groups digits with commas', t => {
  t.equal(formatTokensExact(210_482), '210,482')
  t.equal(formatTokensExact(842), '842')
  t.equal(formatTokensExact(1_000_000), '1,000,000')
  t.end()
})

// The status line trades exactness for brevity: millions to one decimal (dropping a bare .0),
// thousands rounded to K, small counts left whole.
test('formatTokensCompact rounds to a short figure', t => {
  t.equal(formatTokensCompact(9_151_858), '9.2M')
  t.equal(formatTokensCompact(9_000_000), '9M', 'a whole number of millions drops the .0')
  t.equal(formatTokensCompact(210_482), '210K')
  t.equal(formatTokensCompact(842), '842')
  t.end()
})

// Active time reads as m+s under an hour, zero-padded so a column of figures lines up, and
// falls back to whole seconds under a minute.
test('formatActive renders minutes and seconds', t => {
  t.equal(formatActive(45_000), '45s')
  t.equal(formatActive(4 * 60_000 + 12_000), '4m12s')
  t.equal(formatActive(6 * 60_000 + 8_000), '6m08s', 'seconds are zero-padded')
  t.equal(formatActive(64 * 60_000), '1h04m')
  t.end()
})

// The happy-path line: exact tokens, active time, and a singular "attempt".
test('renderUsageLine shows tokens, active time, and attempt count', t => {
  t.equal(renderUsageLine({ tokensUsed: 210_482, activeMs: 252_000, attempts: 1 }), '🧮 210,482 tokens · 4m12s active · 1 attempt')
  t.end()
})

// A retry pluralises "attempts" — the reader should see that the review took more than one run.
test('renderUsageLine pluralises attempts', t => {
  t.ok(renderUsageLine({ tokensUsed: 100, activeMs: 1000, attempts: 3 }).endsWith('3 attempts'))
  t.end()
})

// A failed run: no token total and no active-time measurement. The line degrades to "tokens n/a"
// and drops the active clause rather than printing zeros.
test('renderUsageLine degrades gracefully when a run reported nothing', t => {
  t.equal(renderUsageLine({ attempts: 1 }), '🧮 tokens n/a · 1 attempt')
  t.equal(renderUsageLine({ attempts: 2, activeMs: 5000 }), '🧮 tokens n/a · 5s active · 2 attempts')
  t.end()
})

// The failure wrapper keeps the original message (so the Slack error thread reads unchanged) and
// exposes the salvaged usage and the underlying cause.
test('ReviewFailedError preserves the cause message and carries usage', t => {
  const cause = new Error('Codex crashed')
  const err = new ReviewFailedError({ attempts: 2, activeMs: 5000 }, cause)
  t.equal(err.message, 'Codex crashed', 'the thread still sees the real failure message')
  t.equal(err.cause, cause, 'the original error is preserved')
  t.deepEqual(err.usage, { attempts: 2, activeMs: 5000 }, 'the salvaged usage is exposed')
  t.ok(err instanceof ReviewFailedError && err instanceof Error)
  t.end()
})
