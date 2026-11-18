import test from 'tape'
import { ClaudeRunError } from '../claude'
import { CodexOutputError, CodexStalledError, CodexTimeoutError } from '../codex'
import { deserializeRunError, serializeRunError } from './errors'

const snapshot = { activeMs: 5000, wallMs: 9000, frozenMs: 4000 }
const usage = { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4, costUsd: 0.5, numTurns: 6, durationMs: 7 }
/** Round-trip through JSON, exactly as the HTTP body does. */
const wire = (error: unknown) => deserializeRunError(JSON.parse(JSON.stringify(serializeRunError(error))))

// The orchestrator's retry logic decides by instanceof: only a stall is retried. If a stall from a
// worker came back as a plain Error, every remote stall would be terminal (spec 3.3 error round-trip).
test('a CodexStalledError survives the wire with its class, stallMs and snapshot', t => {
  const back = wire(new CodexStalledError('stalled', 600_000, snapshot))
  t.ok(back instanceof CodexStalledError)
  const stalled = back as CodexStalledError
  t.equal(stalled.message, 'stalled')
  t.equal(stalled.stallMs, 600_000)
  t.deepEqual(stalled.snapshot, snapshot)
  t.end()
})

// A timeout must stay terminal and keep the active time it spent, or usage would under-report it.
test('a CodexTimeoutError survives the wire with its snapshot', t => {
  const back = wire(new CodexTimeoutError('timed out', snapshot))
  t.ok(back instanceof CodexTimeoutError)
  t.deepEqual((back as CodexTimeoutError).snapshot, snapshot)
  t.end()
})

// An output error carries the tokens and time the run spent; dropping them would report a costly
// failed run as free.
test('a CodexOutputError survives the wire with tokensUsed and activeMs', t => {
  const back = wire(new CodexOutputError('bad output', 1234, 99)) as CodexOutputError
  t.ok(back instanceof CodexOutputError)
  t.equal(back.tokensUsed, 1234)
  t.equal(back.activeMs, 99)
  const none = wire(new CodexOutputError('bad output', undefined, 0)) as CodexOutputError
  t.equal(none.tokensUsed, undefined, 'an unknown token count stays unknown, not 0')
  t.end()
})

// Claude's kind decides retry (only 'stall'), and its usage is charged across attempts.
test('a ClaudeRunError survives the wire with kind, activeMs and usage', t => {
  const back = wire(new ClaudeRunError('stalled', 'stall', 42, usage)) as ClaudeRunError
  t.ok(back instanceof ClaudeRunError)
  t.equal(back.kind, 'stall')
  t.equal(back.activeMs, 42)
  t.deepEqual(back.usage, usage)
  t.equal((wire(new ClaudeRunError('x', 'output', 1)) as ClaudeRunError).usage, undefined)
  t.end()
})

// Any other class (a spawn ENOENT, a bug) must come back as a plain Error whose message is redacted:
// it reaches the Slack error thread, and the worker ran untrusted code that may have printed a token.
test('an unknown error class comes back as a plain Error with a redacted message', t => {
  const fake = 'gh' + 'p_' + 'A'.repeat(30)
  const back = wire(new TypeError(`boom ${fake}`))
  t.equal(back.constructor, Error)
  t.notOk(back.message.includes(fake), 'the token-shaped text is masked')
  t.ok(back.message.startsWith('boom '))
  t.equal(wire('a thrown string').message, 'a thrown string')
  t.end()
})

// The body is attacker-controlled (a compromised worker). Nonsense must never throw, and must never
// produce negative or NaN numbers that would corrupt usage totals.
test('deserializeRunError tolerates hostile shapes', t => {
  t.equal(deserializeRunError(null).constructor, Error)
  t.equal(deserializeRunError({ class: 'CodexStalledError' }).constructor, CodexStalledError)
  const stalled = deserializeRunError({ class: 'CodexStalledError', message: 1, stallMs: -5, snapshot: { activeMs: 'x' } }) as CodexStalledError
  t.equal(stalled.stallMs, 0)
  t.deepEqual(stalled.snapshot, { activeMs: 0, wallMs: 0, frozenMs: 0 })
  const claude = deserializeRunError({ class: 'ClaudeRunError', message: 'm', kind: 'reboot', activeMs: Number.NaN }) as ClaudeRunError
  t.equal(claude.kind, 'output', 'an unknown kind is never retryable')
  t.equal(claude.activeMs, 0)
  t.equal(deserializeRunError({ class: 'Error', message: 'x'.repeat(20_000) }).message.length, 8000, 'messages are capped')
  t.end()
})
