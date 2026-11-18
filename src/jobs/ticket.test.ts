import test from 'tape'
import { createSpentNonces, mintTicket, verifyTicket } from './ticket'

const key = Buffer.alloc(32, 7)
const other = Buffer.alloc(32, 8)
const T0 = 1_800_000_000_000
const TEN_MIN = 10 * 60_000

// The ticket is a worker's only credential (spec 3.3). It must verify under the launch key that
// minted it and carry a nonce the orchestrator can spend exactly once.
test('a minted ticket verifies and yields its nonce', t => {
  const ticket = mintTicket(key, T0)
  t.match(ticket, /^\d{13}-[0-9a-f]{32}\.[A-Za-z0-9_-]{43}$/, 'nonce = ms timestamp + 16 random bytes; HMAC is base64url')
  const check = verifyTicket(key, ticket, T0 + 1000, TEN_MIN + 60_000)
  t.deepEqual(check, { ok: true, nonce: ticket.split('.')[0] })
  t.end()
})

// Forgery: a ticket minted under another key, or with its nonce or MAC altered, must not verify.
// Regression caught: comparing only part of the MAC, or trusting the nonce without the MAC.
test('a ticket from another key or with any byte changed is rejected', t => {
  const ticket = mintTicket(key, T0)
  t.deepEqual(verifyTicket(other, ticket, T0, TEN_MIN), { ok: false, reason: 'signature' })
  const [nonce, mac] = ticket.split('.')
  const flipped = nonce.slice(0, -1) + (nonce.endsWith('0') ? '1' : '0')
  t.deepEqual(verifyTicket(key, `${flipped}.${mac}`, T0, TEN_MIN), { ok: false, reason: 'signature' })
  // The first base64url character carries six fully used bits, so changing it always changes the MAC.
  const forged = (mac[0] === 'A' ? 'B' : 'A') + mac.slice(1)
  t.deepEqual(verifyTicket(key, `${nonce}.${forged}`, T0, TEN_MIN), { ok: false, reason: 'signature' })
  t.end()
})

// Garbage must be rejected without throwing (the header comes from any container on the network).
test('malformed tickets are rejected without throwing', t => {
  for (const bad of ['', 'x', 'a.b', '.', `${'1'.repeat(13)}-${'a'.repeat(32)}.`, `${'1'.repeat(13)}-${'a'.repeat(32)}.${'!'.repeat(43)}`]) {
    t.deepEqual(verifyTicket(key, bad, T0, TEN_MIN), { ok: false, reason: 'malformed' }, JSON.stringify(bad))
  }
  t.end()
})

// Expiry: a ticket older than WORKER_IDLE_EXIT_MS + 1 minute is dead, so a ticket stolen from a
// long-gone worker cannot be replayed. A ticket "from the future" beyond a minute of clock skew
// between the host and the Docker VM is also refused.
test('verifyTicket enforces the age limit and bounds future skew', t => {
  const ticket = mintTicket(key, T0)
  const max = TEN_MIN + 60_000
  t.equal(verifyTicket(key, ticket, T0 + max, max).ok, true, 'exactly at the limit')
  t.deepEqual(verifyTicket(key, ticket, T0 + max + 1, max), { ok: false, reason: 'expired' })
  t.equal(verifyTicket(key, ticket, T0 - 59_000, max).ok, true, 'small skew tolerated')
  t.deepEqual(verifyTicket(key, ticket, T0 - 61_000, max), { ok: false, reason: 'expired' })
  t.end()
})

// The spent set is what makes a ticket one-use. Pruning must only drop nonces whose tickets would be
// rejected as expired anyway, or a pruned nonce would become replayable.
test('spent nonces are one-use and pruned only after their tickets expire', t => {
  const max = TEN_MIN + 60_000
  const spent = createSpentNonces(max)
  const nonce = mintTicket(key, T0).split('.')[0]
  t.equal(spent.spend(nonce, T0), true)
  t.equal(spent.spend(nonce, T0 + 1), false, 'a second spend fails')
  t.equal(spent.has(nonce), true)
  spent.prune(T0 + max)
  t.equal(spent.has(nonce), true, 'kept while its ticket could still verify')
  spent.prune(T0 + max + 60_001)
  t.equal(spent.has(nonce), false, 'dropped once the ticket is past age and skew')
  t.end()
})

// Each ticket must differ even when minted in the same millisecond.
test('mintTicket uses fresh randomness per ticket', t => {
  t.notEqual(mintTicket(key, T0), mintTicket(key, T0))
  t.throws(() => mintTicket(Buffer.alloc(16), T0), /32 bytes/)
  t.end()
})
