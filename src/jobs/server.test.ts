import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import type { AddressInfo } from 'net'
import test from 'tape'
import { createJobBroker, type JobBrokerOptions } from './broker'
import type { ClaimReply, WireRunOptions } from './protocol'
import { startJobServer } from './server'
import { mintTicket } from './ticket'

const key = Buffer.alloc(32, 5)
const opts: WireRunOptions = { prompt: 'p', worktreeRoot: '/work/wt/codex', timeoutMs: 1000, runId: 'C1-11.codex' }
const settle = (p: Promise<unknown>) => p.then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error: error as Error }))

/** A broker behind a real HTTP server on a loopback port. */
async function stack(over: Partial<JobBrokerOptions> = {}, smoke?: () => Promise<unknown>) {
  const broker = createJobBroker({ launchKey: key, ticketMaxAgeMs: 660_000, logDir: '', claimWaitMs: 2000, ...over })
  const server = await startJobServer({ broker, port: 0, host: '127.0.0.1', smoke })
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const post = (path: string, auth?: string, body?: string | Buffer, signal?: AbortSignal) =>
    fetch(base + path, { method: 'POST', headers: auth ? { authorization: auth, 'content-type': 'application/json' } : {}, body, signal })
  const close = () => {
    broker.cancelAll()
    broker.abandonAll()
    broker.stop()
    return new Promise<void>(resolve => server.close(() => resolve()))
  }
  return { broker, base, post, close }
}

// Unauthenticated or unknown requests get nothing: no ticket is 403, unknown paths 404, non-POST 405,
// and the health probe answers without revealing anything.
test('server rejects missing credentials and unknown routes', async t => {
  const s = await stack()
  t.equal((await s.post('/v1/claim')).status, 403)
  t.equal((await s.post('/v1/jobs/abc/heartbeat')).status, 403)
  t.equal((await s.post('/v1/other', 'Ticket x')).status, 404)
  t.equal((await fetch(`${s.base}/v1/claim`)).status, 405)
  const health = await fetch(`${s.base}/healthz`)
  t.equal(health.status, 200)
  t.deepEqual(await health.json(), { ok: true })
  await s.close()
  t.end()
})

// The whole protocol over real HTTP: claim with a ticket, then progress, heartbeat, log and result
// with the job token; the submit resolves with the worker's outcome.
test('server carries a full job round-trip', async t => {
  const s = await stack()
  const lines: string[] = []
  const out = settle(s.broker.submit('codex-report-only', opts, { onProgress: line => lines.push(line) }))
  const claim = await s.post('/v1/claim', `Ticket ${mintTicket(key, Date.now())}`)
  t.equal(claim.status, 200)
  const job = (await claim.json()) as ClaimReply
  const auth = `Job ${job.jobToken}`
  t.equal((await s.post(`/v1/jobs/${job.jobId}/progress`, auth, JSON.stringify({ line: 'hello', activeMs: 5 }))).status, 200)
  t.equal((await s.post(`/v1/jobs/${job.jobId}/heartbeat`, auth, '{}')).status, 200)
  t.equal((await s.post(`/v1/jobs/${job.jobId}/log`, auth, Buffer.from('log text'))).status, 200)
  t.equal((await s.post(`/v1/jobs/${job.jobId}/progress`, auth, 'not json')).status, 400)
  t.equal((await s.post(`/v1/jobs/${job.jobId}/result`, auth, JSON.stringify({ ok: true, outcome: { activeMs: 9 } }))).status, 200)
  t.deepEqual(await out, { ok: true, value: { activeMs: 9 } })
  t.deepEqual(lines, ['hello'])
  await s.close()
  t.end()
})

// Review Focus 2: a worker whose claim connection dies mid long-poll must not leave a waiter behind
// that "claims" the next job for nobody (which would then fail 45 s later as worker lost).
test('server: a claim aborted by the client does not swallow the next job', async t => {
  const s = await stack()
  const abort = new AbortController()
  const dead = s.post('/v1/claim', `Ticket ${mintTicket(key, Date.now())}`, undefined, abort.signal).catch(() => 'aborted')
  await new Promise(resolve => setTimeout(resolve, 50))
  abort.abort()
  t.equal(await dead, 'aborted')
  await new Promise(resolve => setTimeout(resolve, 100))
  const out = settle(s.broker.submit('codex-report-only', opts))
  const claim = await s.post('/v1/claim', `Ticket ${mintTicket(key, Date.now())}`)
  t.equal(claim.status, 200, 'the job went to the live claim')
  const job = (await claim.json()) as ClaimReply
  await s.post(`/v1/jobs/${job.jobId}/result`, `Job ${job.jobToken}`, JSON.stringify({ ok: true, outcome: {} }))
  t.ok((await out).ok)
  await s.close()
  t.end()
})

// The per-request log cap is enforced before the body is buffered in full.
// A connection reset alone would also satisfy the status check, so the test also proves nothing was
// written and the job was not disturbed.
test('server answers 413 for an oversized log chunk', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'server-log-'))
  const s = await stack({ logChunkLimit: 10, logDir: dir })
  const out = settle(s.broker.submit('codex-report-only', opts))
  const job = (await (await s.post('/v1/claim', `Ticket ${mintTicket(key, Date.now())}`)).json()) as ClaimReply
  const before = s.broker.inFlight()
  const res = await s.post(`/v1/jobs/${job.jobId}/log`, `Job ${job.jobToken}`, Buffer.alloc(11, 120)).catch(() => undefined)
  t.ok(res === undefined || res.status === 413, 'refused (or the connection closed after the 413)')
  const logFile = path.join(dir, `${opts.runId}.log`)
  t.ok(!fs.existsSync(logFile) || fs.statSync(logFile).size === 0, 'nothing reached the run log')
  t.equal(s.broker.inFlight(), before, 'the job is still in flight, untouched')
  await s.close()
  await out
  t.end()
})

// The smoke route is a test hook; it must not exist unless SMOKE=1 wired it (spec 6).
test('server exposes the smoke route only when enabled', async t => {
  const off = await stack()
  t.equal((await off.post('/v1/smoke/submit')).status, 404)
  await off.close()
  const on = await stack({}, async () => ({ ran: true }))
  const res = await on.post('/v1/smoke/submit')
  t.equal(res.status, 200)
  t.deepEqual(await res.json(), { ran: true })
  await on.close()
  t.end()
})
