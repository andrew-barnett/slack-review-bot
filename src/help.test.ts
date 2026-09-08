import test from 'tape'
import { renderHelp } from './help'

const emoji = {
  ack: 'eyes',
  queued: 'hourglass_flowing_sand',
  pass: 'approved_stamp',
  findings: 'comments',
  error: 'warning',
  humanReview: 'raising_hand',
}

// The help reply has to answer the three questions someone new to the bot actually has: what
// is it, how do I talk to it, and why might it be quiet. Assert each is covered rather than
// pinning the exact prose, so wording can evolve without breaking the test.
test('renderHelp covers what it does, the commands, and the shortfalls', t => {
  const text = renderHelp(emoji)
  t.ok(/pull-request/i.test(text), 'says what it reviews')
  t.ok(text.includes('`help`'), 'documents the help command')
  t.ok(text.includes('`status`'), 'documents the status command')
  t.ok(/health.*ping/i.test(text), 'notes the status aliases')
  t.ok(/one PR at a time/i.test(text), 'warns that reviews are serialised')
  t.end()
})

// A common surprise is that the bot reads more than the diff: the PR body, commit messages,
// and the whole discussion feed the review. The help must say so, since it is what makes the
// steering-via-comments guidance below make sense.
test('renderHelp says it reads the PR body and discussion, not just the diff', t => {
  const text = renderHelp(emoji)
  t.ok(/description|body/i.test(text), 'mentions the PR description/body')
  t.ok(/discussion|comments/i.test(text), 'mentions the PR discussion/comments')
  t.end()
})

// The point of documenting this is that a reviewer can steer what the bot flags by commenting
// on the PR — marking a finding intentional/out of scope — and that later comments override
// earlier ones. If this guidance regresses, users lose a real control surface, so assert it.
test('renderHelp explains steering the review via PR comments', t => {
  const text = renderHelp(emoji)
  t.ok(/steer|shape|focus/i.test(text), 'frames it as steering the review')
  t.ok(/comment on the PR/i.test(text), 'tells users to comment on the PR')
  t.ok(/out of scope|intentional|deferred|narrowed/i.test(text), 'can mark a finding as not a defect')
  t.ok(/later comments/i.test(text), 'later comments override earlier ones')
  t.end()
})

// The steering guidance must not read as "comment to silence any finding": a real
// correctness/security bug is still flagged regardless of a scope note. This guards the honest
// caveat so the help never over-promises suppression.
test('renderHelp notes that real defects are still flagged despite a scope note', t => {
  const text = renderHelp(emoji)
  t.ok(/correctness or security|real bug/i.test(text), 'genuine defects still surface')
  t.end()
})

// The laptop-asleep shortfall is the single most common reason the bot looks broken, and the
// reason this command exists — it must be spelled out.
test('renderHelp explains the laptop-asleep shortfall', t => {
  const text = renderHelp(emoji)
  t.ok(/laptop/i.test(text), 'mentions the laptop')
  t.ok(/asleep|offline/i.test(text), 'and that it pauses when the laptop is not awake')
  t.end()
})

// The reaction legend has to match what people actually see, so it is rendered from the
// configured emoji names, not hard-coded.
test('renderHelp builds the reaction legend from the configured emoji', t => {
  const text = renderHelp({ ...emoji, pass: 'white_check_mark' })
  t.ok(text.includes(':white_check_mark:'), 'uses the configured pass emoji')
  t.ok(text.includes(':eyes:'), 'and the configured ack emoji')
  t.notOk(text.includes(':approved_stamp:'), 'not a stale default')
  t.end()
})
