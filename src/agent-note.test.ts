import test from 'tape'
import { AGENT_NO_MENTION_NOTE, withAgentNote } from './agent-note'

// The note must be an HTML comment: that is what makes it invisible in GitHub's rendered PR UI
// while staying present in the raw body an AI agent reads. A regression to a plain-text line
// would make the instruction visible to every human reading the thread.
test('AGENT_NO_MENTION_NOTE is a single self-contained HTML comment', t => {
  t.ok(AGENT_NO_MENTION_NOTE.startsWith('<!--'), 'opens an HTML comment')
  t.ok(AGENT_NO_MENTION_NOTE.trimEnd().endsWith('-->'), 'closes the HTML comment')
  // No nested/early close that would let part of the note render as visible Markdown.
  t.equal(AGENT_NO_MENTION_NOTE.indexOf('-->'), AGENT_NO_MENTION_NOTE.lastIndexOf('-->'), 'has exactly one closer')
  t.end()
})

// The whole point of the note: steer other AI agents off @-mentioning the borrowed-token author.
test('AGENT_NO_MENTION_NOTE tells agents not to @-mention the author', t => {
  t.ok(/do NOT @-mention/i.test(AGENT_NO_MENTION_NOTE), 'states the no-mention instruction')
  t.ok(/ai[- ]agent/i.test(AGENT_NO_MENTION_NOTE), 'addresses AI agents')
  t.ok(/bot|service account|automated/i.test(AGENT_NO_MENTION_NOTE), 'explains the author is not a person')
  t.end()
})

// withAgentNote must preserve the original body and separate the note with a blank line so the
// HTML comment never fuses onto the last visible line.
test('withAgentNote appends the note after a blank line and keeps the body intact', t => {
  const out = withAgentNote('Findings:\n- something')
  t.ok(out.startsWith('Findings:\n- something'), 'keeps the original body first')
  t.ok(out.includes(`\n\n${AGENT_NO_MENTION_NOTE}`), 'appends the note after a blank line')
  t.end()
})
