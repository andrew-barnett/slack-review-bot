// One-use claim tickets (spec 3.3). The launcher mints one per worker from LAUNCH_KEY, which only it
// and the orchestrator hold; the worker presents it once, before any PR code exists in its container.
// The orchestrator verifies the HMAC in constant time and spends the nonce on the first successful
// claim, so a worker can claim at most one job, ever.

import { createHmac, randomBytes, timingSafeEqual } from 'crypto'

export const LAUNCH_KEY_BYTES = 32
export const NONCE_RANDOM_BYTES = 16
/** How far a ticket's timestamp may be ahead of the verifier's clock (host vs Docker VM skew). */
export const TICKET_FUTURE_SKEW_MS = 60_000

/** `<13-digit ms timestamp>-<32 hex>`: the timestamp prefix makes expiry checkable. */
const NONCE_RE = /^(\d{13})-([0-9a-f]{32})$/
/** base64url of a 32-byte HMAC-SHA256, unpadded. */
const MAC_RE = /^[A-Za-z0-9_-]{43}$/

function mac(key: Buffer, nonce: string): Buffer {
  return createHmac('sha256', key).update(nonce, 'utf8').digest()
}

export function mintTicket(key: Buffer, nowMs: number, random: (n: number) => Buffer = randomBytes): string {
  if (key.length !== LAUNCH_KEY_BYTES) throw new Error(`LAUNCH_KEY must be ${LAUNCH_KEY_BYTES} bytes`)
  const nonce = `${String(Math.floor(nowMs)).padStart(13, '0')}-${random(NONCE_RANDOM_BYTES).toString('hex')}`
  return `${nonce}.${mac(key, nonce).toString('base64url')}`
}

export type TicketCheck = { ok: true; nonce: string } | { ok: false; reason: 'malformed' | 'signature' | 'expired' }

export function verifyTicket(key: Buffer, ticket: string, nowMs: number, maxAgeMs: number): TicketCheck {
  const dot = ticket.lastIndexOf('.')
  const nonce = dot < 0 ? '' : ticket.slice(0, dot)
  const sig = dot < 0 ? '' : ticket.slice(dot + 1)
  const parts = NONCE_RE.exec(nonce)
  if (!parts || !MAC_RE.test(sig)) return { ok: false, reason: 'malformed' }
  const expected = mac(key, nonce)
  const given = Buffer.from(sig, 'base64url')
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return { ok: false, reason: 'signature' }
  const issuedAt = Number(parts[1])
  if (nowMs - issuedAt > maxAgeMs || issuedAt - nowMs > TICKET_FUTURE_SKEW_MS) return { ok: false, reason: 'expired' }
  return { ok: true, nonce }
}

export interface SpentNonces {
  has(nonce: string): boolean
  /** Record the nonce as spent; false when it already was. */
  spend(nonce: string, nowMs: number): boolean
  /** Forget nonces whose tickets can no longer verify (past age plus skew). */
  prune(nowMs: number): void
  size(): number
}

export function createSpentNonces(maxAgeMs: number): SpentNonces {
  // nonce -> the ticket's issue time, read from the nonce itself.
  const spent = new Map<string, number>()
  const issuedAt = (nonce: string, fallback: number): number => {
    const parts = NONCE_RE.exec(nonce)
    return parts ? Number(parts[1]) : fallback
  }
  return {
    has: nonce => spent.has(nonce),
    spend(nonce, nowMs) {
      if (spent.has(nonce)) return false
      spent.set(nonce, issuedAt(nonce, nowMs))
      return true
    },
    prune(nowMs) {
      for (const [nonce, at] of spent) {
        if (nowMs - at > maxAgeMs + TICKET_FUTURE_SKEW_MS) spent.delete(nonce)
      }
    },
    size: () => spent.size,
  }
}
