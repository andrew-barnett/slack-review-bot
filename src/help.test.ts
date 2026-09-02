import test from 'tape'
import { renderHelp } from './help'

const emoji = {
  ack: 'eyes',
  queued: 'hourglass_flowing_sand',
  pass: 'approved_stamp',
  findings: 'comments',
  error: 'warning',
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
