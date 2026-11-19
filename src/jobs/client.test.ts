import type { AddressInfo } from 'net'
import test from 'tape'
import { createJobBroker } from './broker'
import { makeJobClient } from './client'
import { startJobServer } from './server'
import { mintTicket } from './ticket'

const key = Buffer.alloc(32, 6)

// The worker's client against the real server: it must authenticate each call the right way and
// surface the status codes the worker acts on (403 rejected, 409 cancel). Regression caught: a client
// that sends the ticket on job calls or the job token on claims.
test('the job client claims, heartbeats, logs and reports over HTTP', async t => {
  const broker = createJobBroker({ launchKey: key, ticketMaxAgeMs: 660_000, logDir: '', claimWaitMs: 50 })
  const server = await startJobServer({ broker, port: 0, host: '127.0.0.1' })
  const client = makeJobClient(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)
  t.deepEqual(await client.claim(mintTicket(key, Date.now())), { status: 204 })
  t.deepEqual(await client.claim('forged'), { status: 403 })
  const out = broker.submit('claude-review', { prompt: 'p', worktreeRoot: '/work/wt/claude', timeoutMs: 1000, runId: 'C1-11.claude' })
  const claim = await client.claim(mintTicket(key, Date.now()))
  t.equal(claim.status, 200)
  if (claim.status !== 200 || !claim.job) return t.end()
  t.equal(claim.job.kind, 'claude-review')
  t.equal(await client.heartbeat(claim.job), 200)
  t.equal(await client.progress(claim.job, { line: 'x', activeMs: 1 }), 200)
  t.equal(await client.log(claim.job, Buffer.from('log')), 200)
  t.equal(await client.result(claim.job, { ok: true, outcome: { activeMs: 1 } }), 200)
  t.deepEqual(await out, { activeMs: 1 })
  t.equal(await client.heartbeat(claim.job), 403, 'the token is dead after the result')
  broker.stop()
  await new Promise<void>(resolve => server.close(() => resolve()))
  t.end()
})
