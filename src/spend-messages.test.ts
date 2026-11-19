import test from 'tape'
import {
  formatResetEt,
  renderCapReachedAlert,
  renderCapRefusal,
  renderSpendStatusLine,
  renderThresholdAlert,
} from './spend-messages'

const DEC_1 = Date.UTC(2026, 11, 1)
const JUL_1 = Date.UTC(2027, 6, 1)

// D5: the reset is 00:00 UTC on the 1st, shown in New York time. In winter that is 7:00 PM the day
// before, in summer 8:00 PM. Regression caught: formatting in the host's zone, or printing "Dec 1".
test('formatResetEt shows the UTC month start in New York time, across daylight saving', t => {
  t.deepEqual(formatResetEt(DEC_1), { date: 'Nov 30', time: '7:00 PM' })
  t.deepEqual(formatResetEt(JUL_1), { date: 'Jun 30', time: '8:00 PM' })
  t.end()
})

// Spec 8 and 9: the user-facing texts, verbatim. Regression caught: wording drifting from the spec,
// or ICU's U+202F narrow no-break space sneaking in before "PM" (it renders the same and matches nothing).
test('the refusal, alert and cap texts are the spec text verbatim', t => {
  t.equal(
    renderCapRefusal(DEC_1),
    "This bot's monthly Bedrock spend cap has been reached, so it isn't starting new reviews. Reviews resume on Nov 30 at 7:00 PM ET (the start of the next UTC month), or sooner if the cap is raised."
  )
  t.equal(renderThresholdAlert(76, true), '<!here> This bot has used 76% of its monthly Bedrock spend cap. New reviews stop at 100%.')
  t.equal(renderThresholdAlert(26, false), 'This bot has used 26% of its monthly Bedrock spend cap. New reviews stop at 100%.')
  t.equal(
    renderCapReachedAlert(DEC_1),
    '<!here> This bot has reached its monthly Bedrock spend cap. New review requests will be declined until Nov 30 at 7:00 PM ET.'
  )
  t.notOk(/\u202f/.test(renderCapRefusal(DEC_1) + renderCapReachedAlert(DEC_1)), 'plain spaces only')
  t.end()
})

// Spec 9 and ruling 16: the status line, verbatim, in its three states. Regression caught: the line
// drifting from the spec text, or showing a percent above 100 instead of "cap reached".
test('renderSpendStatusLine reads inactive, a percent, or cap reached', t => {
  t.equal(renderSpendStatusLine({ active: false }), 'Bedrock spend cap: not active (subscription auth)')
  t.equal(renderSpendStatusLine({ active: true, percent: 41, resetsAt: DEC_1 }), 'Bedrock spend this month: 41% of cap · resets Nov 30, 7:00 PM ET')
  t.equal(renderSpendStatusLine({ active: true, percent: 100, resetsAt: DEC_1 }), 'Bedrock spend this month: cap reached · resets Nov 30, 7:00 PM ET')
  t.equal(renderSpendStatusLine({ active: true, percent: 134, resetsAt: DEC_1 }), 'Bedrock spend this month: cap reached · resets Nov 30, 7:00 PM ET', 'never over 100%')
  t.end()
})
