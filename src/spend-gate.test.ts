import * as fs from 'fs'
import * as path from 'path'
import test from 'tape'
import type { MessageRef } from './job'
import { TaskQueue } from './queue'
import { capCheckedTask, refuseAtAdmission, refuseAtSlot, type RefusalEffects } from './spend-gate'
import { renderCapRefusal } from './spend-messages'

const NOW = Date.UTC(2026, 10, 20, 12)
const DEC_1 = Date.UTC(2026, 11, 1)
const message: MessageRef = { channel: 'C0REVIEWS', ts: '1763640000.000100' }

/** Recording Slack effects; with `fail`, every call throws after being recorded. */
function recorder(fail = false) {
  const calls: string[] = []
  const events: string[] = []
  const call = async (name: string): Promise<void> => {
    calls.push(name)
    if (fail) throw new Error('synthetic Slack failure')
  }
  const fx: RefusalEffects = {
    addReaction: (_message, name) => call(`add:${name}`),
    removeReaction: (_message, name) => call(`remove:${name}`),
    postThreadReply: (_message, text) => call(`reply:${text}`),
    log: event => void events.push(event),
  }
  return { fx, calls, events }
}

// Spec 9: under the cap a request is admitted untouched; at the cap it gets the error reaction and the
// refusal reply, and the caller is told it was refused. Regression caught: a refused request with no
// visible answer, which reads as the bot ignoring it.
test('refuseAtAdmission answers a request only when the cap is reached', async t => {
  const open = recorder()
  t.equal(await refuseAtAdmission({ capped: () => false }, message, 'x', open.fx, NOW), false)
  t.deepEqual(open.calls, [], 'no Slack calls under the cap')
  const shut = recorder()
  t.equal(await refuseAtAdmission({ capped: () => true }, message, 'x', shut.fx, NOW), true)
  t.deepEqual(shut.calls, ['add:x', `reply:${renderCapRefusal(DEC_1)}`])
  t.end()
})

// A Slack failure while refusing is logged and swallowed: the request is still refused and settled,
// never queued because the answer could not be posted.
test('refuseAtAdmission still refuses when Slack fails', async t => {
  const broken = recorder(true)
  t.equal(await refuseAtAdmission({ capped: () => true }, message, 'x', broken.fx, NOW), true)
  t.deepEqual(broken.events, ['reaction.cap.failed', 'thread.cap.failed'])
  t.end()
})

// Spec 9: a request refused at its slot drops its queued (hourglass) reaction, if it got one, before
// the error reaction and the reply. Regression caught: a stale hourglass left on a refused request.
test('refuseAtSlot clears the queued reaction it actually added', async t => {
  const queued = recorder()
  await refuseAtSlot(message, { error: 'x', queued: 'hourglass' }, queued.fx, Promise.resolve(true), NOW)
  t.deepEqual(queued.calls, ['remove:hourglass', 'add:x', `reply:${renderCapRefusal(DEC_1)}`])
  const notAdded = recorder()
  await refuseAtSlot(message, { error: 'x', queued: 'hourglass' }, notAdded.fx, Promise.resolve(false), NOW)
  t.deepEqual(notAdded.calls, ['add:x', `reply:${renderCapRefusal(DEC_1)}`], 'nothing to remove')
  const broken = recorder(true)
  await refuseAtSlot(message, { error: 'x', queued: 'hourglass' }, broken.fx, Promise.resolve(true), NOW)
  t.deepEqual(broken.events, ['reaction.cap.queued.remove.failed', 'reaction.cap.failed', 'thread.cap.failed'])
  t.end()
})

// Spec 9: the cap is checked when a queued request takes its slot, not only when it was admitted. With a
// real one-slot queue, a request admitted under the cap and waiting while the running review pushes spend
// over it is refused instead of run. Regression caught: checking only at admission.
test('capCheckedTask refuses a queued request when the cap is reached while it waits', async t => {
  const queue = new TaskQueue(1)
  let capped = false
  const cap = { capped: () => capped }
  const gate: { release?: (outcome: string) => void } = {}
  let secondRan = false
  const first = queue.run(
    capCheckedTask<string>({
      cap,
      now: () => NOW,
      refuse: async () => 'refused',
      run: () => new Promise<string>(resolve => (gate.release = resolve)),
    })
  )
  const second = queue.run(
    capCheckedTask<string>({
      cap,
      now: () => NOW,
      refuse: async () => 'refused',
      run: async () => {
        secondRan = true
        return 'ran'
      },
    })
  )
  while (!gate.release) await new Promise(resolve => setImmediate(resolve))
  capped = true
  gate.release('ran')
  t.deepEqual(await Promise.all([first, second]), ['ran', 'refused'])
  t.notOk(secondRan, 'the second review never started')
  t.end()
})

// daemon.ts has no unit tests (it needs a live Socket Mode connection), so its wiring is pinned by
// source order. Regressions caught: the cap check placed before the status and help branches (a capped
// bot could not say why); placed after cursors.begin (a refused request would stay unsettled and replay);
// a refusal that is not settled, or that falls through to the queue instead of returning; the slot check
// missing; usage not recorded; the cap opened after Slack connects.
test('daemon.ts wires the cap at admission, at the slot, into usage, status and startup', t => {
  const source = fs.readFileSync(path.join(__dirname, 'daemon.ts'), 'utf8')
  const admission = source.indexOf('await refuseAtAdmission(')
  t.ok(admission > 0, 'admission check present')
  t.ok(admission > source.indexOf('isStatusRequest(event'), 'status is answered first')
  t.ok(admission > source.indexOf('isHelpRequest(event'), 'help is answered first')
  t.ok(admission > source.lastIndexOf('markHandled(key)'), 'after the duplicate guard')
  const begin = source.lastIndexOf('cursors.begin(')
  t.ok(admission < begin, 'before the cursor holds the message for replay')
  const settle = source.indexOf('cursors.record(request.message.channel', admission)
  t.ok(settle > admission && settle < begin, 'the refused request is settled inside the refusal branch')
  const refusedReturn = source.indexOf('return false', admission)
  t.ok(refusedReturn > settle && refusedReturn < begin, 'and the refusal returns before the queue')
  const slot = source.indexOf('capCheckedTask<JobOutcome>(')
  t.ok(slot > 0 && slot < source.indexOf('return runJob('), 'the slot check wraps runJob')
  t.ok(source.includes('void spend.record(u, runIdFor(request), Date.now())'), 'usage is recorded')
  t.ok(source.includes('spend.status(Date.now())'), 'status shows the spend line')
  const opened = source.indexOf('openSpendCap(')
  t.ok(opened > 0 && opened < source.indexOf('await app.start()'), 'opened before connecting to Slack')
  t.end()
})
