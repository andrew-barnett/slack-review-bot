import { PassThrough } from 'stream'
import test from 'tape'
import { encodeSecretBundle, parseSecretBundle, readSecretBundle, WORKER_BUNDLE, WORKER_DOCTOR_BUNDLE } from './secret-bundle'

const spec = { required: ['A_TOKEN', 'B_TOKEN'], optional: ['C_TOKEN'] }
const line = encodeSecretBundle({ A_TOKEN: 'alpha-placeholder', B_TOKEN: 'beta-placeholder' })

// Spec 3.6.1: one JSON line on stdin, then stdin is closed. Regression caught: a reader that keeps
// stdin open (so a later write could inject values) or that reads past the first line.
test('readSecretBundle reads exactly one line and closes the stream', async t => {
  const stream = new PassThrough()
  const pending = readSecretBundle(stream, spec)
  stream.write(line.slice(0, 10))
  stream.write(`${line.slice(10)}{"ignored":"second line"}\n`)
  t.deepEqual(await pending, { A_TOKEN: 'alpha-placeholder', B_TOKEN: 'beta-placeholder' })
  t.ok(stream.destroyed, 'stdin is closed after the bundle')
  t.end()
})

// Each failure must exit non-zero rather than start without its secrets, and no error may echo a
// value (it would reach the container log).
test('readSecretBundle fails on timeout, oversize and early EOF without echoing values', async t => {
  const slow = new PassThrough()
  await readSecretBundle(slow, spec, { timeoutMs: 20 }).then(
    () => t.fail('resolved'),
    error => t.match(error.message, /within 20 ms/)
  )
  const big = new PassThrough()
  const pendingBig = readSecretBundle(big, spec, { maxBytes: 16 })
  big.write('{"A_TOKEN":"' + 'x'.repeat(40))
  await pendingBig.then(
    () => t.fail('resolved'),
    error => {
      t.match(error.message, /larger than 16 bytes/)
      t.notOk(error.message.includes('xxxx'), 'the value is not echoed')
    }
  )
  const empty = new PassThrough()
  const pendingEmpty = readSecretBundle(empty, spec)
  empty.end()
  await pendingEmpty.then(
    () => t.fail('resolved'),
    error => t.match(error.message, /closed before/)
  )
  t.end()
})

// The key set is strict: an unknown key, a missing required key, or a non-string value is refused, so
// a launcher bug cannot silently start a container short of a credential or with an extra one.
test('parseSecretBundle enforces the exact key set and string values', t => {
  t.deepEqual(parseSecretBundle('{"A_TOKEN":"a1","B_TOKEN":"b1","C_TOKEN":"c1"}', spec), { A_TOKEN: 'a1', B_TOKEN: 'b1', C_TOKEN: 'c1' })
  t.throws(() => parseSecretBundle('{"A_TOKEN":"a1"}', spec), /missing B_TOKEN/)
  t.throws(() => parseSecretBundle('{"A_TOKEN":"a1","B_TOKEN":"b1","LAUNCH_KEY":"k"}', spec), /unexpected key "LAUNCH_KEY"/)
  // A key that is not a variable name may be a misplaced secret value, so it is never echoed.
  const misplaced = 'gh' + 'p_' + 'A'.repeat(30)
  t.throws(() => parseSecretBundle(JSON.stringify({ A_TOKEN: 'a1', B_TOKEN: 'b1', [misplaced]: 'x' }), spec), (e: Error) => /unexpected key$/.test(e.message) && !e.message.includes('AAAA'))
  t.throws(() => parseSecretBundle('{"A_TOKEN":"a1","B_TOKEN":5}', spec), /B_TOKEN is not a non-empty string/)
  t.throws(() => parseSecretBundle('{"A_TOKEN":"a1","B_TOKEN":""}', spec), /B_TOKEN/)
  try {
    parseSecretBundle('not json secret-value', spec)
    t.fail('a non-JSON line parsed')
  } catch (error) {
    t.notOk(String(error).includes('secret-value'), 'the raw line is not echoed')
  }
  t.throws(() => parseSecretBundle('["A_TOKEN"]', spec), /not a JSON object/)
  t.end()
})

// The worker never receives LAUNCH_KEY (spec 3.4): it is not in either worker key set, so a bundle
// carrying it is refused outright.
test('worker bundle specs exclude LAUNCH_KEY and the daemon-only tokens', t => {
  for (const spec of [WORKER_BUNDLE, WORKER_DOCTOR_BUNDLE]) {
    const keys = [...spec.required, ...(spec.optional ?? [])]
    for (const banned of ['LAUNCH_KEY', 'APPROVER_GH_TOKEN', 'SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN']) t.notOk(keys.includes(banned), banned)
  }
  t.ok(WORKER_DOCTOR_BUNDLE.optional?.includes('WORKER_TICKET'))
  t.end()
})

// The launcher's encoding must be a single line, whatever the values contain.
test('encodeSecretBundle produces one line', t => {
  const encoded = encodeSecretBundle({ A_TOKEN: 'multi\nline' })
  t.equal(encoded.indexOf('\n'), encoded.length - 1)
  t.deepEqual(parseSecretBundle(encoded.trim(), { required: ['A_TOKEN'] }), { A_TOKEN: 'multi\nline' })
  t.end()
})
