import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import test from 'tape'
import { ClaudeRunError } from '../claude'
import { CodexOutputError, CodexStalledError } from '../codex'
import { createJobBroker, type JobBroker, type JobBrokerOptions } from './broker'
import type { ClaimReply, WireRunOptions } from './protocol'
import { mintTicket } from './ticket'

const key = Buffer.alloc(32, 3)
const T0 = 1_800_000_000_000
const opts: WireRunOptions = { prompt: 'p', worktreeRoot: '/work/wt/codex', timeoutMs: 1000, runId: 'C1-11.codex' }

/** A broker on a controllable clock; long-poll waits are short so tests stay fast. */
function make(over: Partial<JobBrokerOptions> = {}) {
  const clock = { now: T0 }
  const broker = createJobBroker({
    launchKey: key,
    ticketMaxAgeMs: 660_000,
    logDir: '',
    claimWaitMs: 30,
    now: () => clock.now,
    ...over,
  })
  return { broker, clock, ticket: () => mintTicket(key, clock.now) }
}

/** Observe a submit without ever leaving its rejection unhandled. */
const settle = (p: Promise<unknown>) => p.then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error: error as Error }))
const claimed = async (broker: JobBroker, ticket: string): Promise<ClaimReply> => {
  const reply = await broker.claim(ticket)
  if (reply.status !== 200) throw new Error(`claim returned ${reply.status}`)
  return reply.body as ClaimReply
}

// The basic contract (spec 3.3): a valid claim gets the queued job with a fresh job token, and the
// ticket is then spent. Regression caught: a ticket usable twice, which lets one worker take two jobs.
test('broker hands a queued job to a valid claim and spends the ticket', async t => {
  const { broker, ticket } = make()
  const out = settle(broker.submit('codex-report-only', opts))
  const tk = ticket()
  const job = await claimed(broker, tk)
  t.equal(job.kind, 'codex-report-only')
  t.deepEqual(job.options, opts)
  t.match(job.jobToken, /^[0-9a-f]{64}$/)
  broker.submit('claude-review', opts).catch(() => {})
  t.equal((await broker.claim(tk)).status, 403, 'a spent ticket cannot claim again')
  broker.abandonAll()
  await out
  t.end()
})

// A 204 must not spend the ticket, or a worker that started before any job was queued could never
// work (spec 3.3: "the ticket is not spent").
test('broker answers 204 without spending the ticket when no job arrives', async t => {
  const { broker, ticket } = make()
  const tk = ticket()
  t.equal((await broker.claim(tk)).status, 204)
  const out = settle(broker.submit('codex-report-only', opts))
  t.equal((await broker.claim(tk)).status, 200, 'the same ticket still claims')
  broker.abandonAll()
  await out
  t.end()
})

// Forged, malformed and expired tickets never get a job.
test('broker rejects forged and expired tickets', async t => {
  const { broker, clock } = make()
  const out = settle(broker.submit('codex-report-only', opts))
  t.equal((await broker.claim(mintTicket(Buffer.alloc(32, 9), clock.now))).status, 403, 'another key')
  t.equal((await broker.claim('nonsense')).status, 403, 'malformed')
  t.equal((await broker.claim(mintTicket(key, clock.now - 661_000))).status, 403, 'expired')
  t.equal(broker.inFlight(), 1, 'the job is still waiting for an honest worker')
  broker.cancelAll()
  await out
  t.end()
})

// Review Focus 4: two concurrent long-polls with one ticket are both valid until the nonce is spent.
// Only one may receive a job; the other must get 403 and the second job must stay queued.
test('broker gives one ticket at most one job even with two concurrent claims', async t => {
  const { broker, ticket } = make({ claimWaitMs: 1000 })
  const tk = ticket()
  const first = broker.claim(tk)
  const second = broker.claim(tk)
  const a = settle(broker.submit('codex-report-only', opts))
  const b = settle(broker.submit('claude-review', opts))
  const statuses = [(await first).status, (await second).status].sort()
  t.deepEqual(statuses, [200, 403])
  t.equal((await claimed(broker, ticket())).kind, 'claude-review', 'the second job went to a fresh ticket')
  broker.cancelAll()
  broker.abandonAll()
  await Promise.all([a, b])
  t.end()
})

// The job token binds a worker to its own job. Regression caught: accepting any valid token on any
// job, which would let PR code in the Codex worker post the Claude job's result (spec 3.3 threat).
test('broker job tokens are bound to one job', async t => {
  const { broker, ticket } = make()
  const a = settle(broker.submit('codex-report-only', opts))
  const b = settle(broker.submit('claude-review', opts))
  const jobA = await claimed(broker, ticket())
  const jobB = await claimed(broker, ticket())
  t.equal(broker.heartbeat(jobB.jobId, jobA.jobToken).status, 403, "A's token on B")
  t.equal(broker.result(jobB.jobId, jobA.jobToken, { ok: true, outcome: {} }).status, 403)
  t.equal(broker.heartbeat('nosuchjob', jobA.jobToken).status, 404)
  t.equal(broker.heartbeat(jobA.jobId, jobA.jobToken).status, 200)
  broker.abandonAll()
  await Promise.all([a, b])
  t.end()
})

// Progress reaches the request's status sink; the result settles the submit exactly once and kills the
// token. Regression caught: a second result overwriting the first.
test('broker forwards progress and resolves the result once', async t => {
  const { broker, ticket } = make()
  const lines: [string, number][] = []
  let claimedFired = false
  const out = settle(broker.submit('codex-report-only', opts, { onProgress: (l, ms) => lines.push([l, ms]), onClaimed: () => (claimedFired = true) }))
  const job = await claimed(broker, ticket())
  t.ok(claimedFired, 'onClaimed fires when a worker takes the job')
  t.equal(broker.progress(job.jobId, job.jobToken, { line: 'npm ci', activeMs: 1200 }).status, 200)
  t.equal(broker.progress(job.jobId, job.jobToken, { line: 5 }).status, 400)
  t.deepEqual(lines, [['npm ci', 1200]])
  t.equal(broker.result(job.jobId, job.jobToken, { ok: true, outcome: { activeMs: 7 } }).status, 200)
  t.deepEqual(await out, { ok: true, value: { activeMs: 7 } })
  t.equal(broker.result(job.jobId, job.jobToken, { ok: true, outcome: {} }).status, 403, 'the token is dead')
  t.equal(broker.progress(job.jobId, job.jobToken, { line: 'x', activeMs: 1 }).status, 403)
  t.equal(broker.inFlight(), 0)
  t.end()
})

// A failed run comes back as the same class, so the engine's retry decision is unchanged.
test('broker rebuilds the error class from a failed result', async t => {
  const { broker, ticket } = make()
  const out = settle(broker.submit('codex-report-only', opts))
  const job = await claimed(broker, ticket())
  const error = { class: 'CodexStalledError', message: 'stalled', stallMs: 600000, snapshot: { activeMs: 1, wallMs: 1, frozenMs: 0 } }
  t.equal(broker.result(job.jobId, job.jobToken, { ok: false, error }).status, 200)
  const r = await out
  t.ok(!r.ok && r.error instanceof CodexStalledError)
  t.equal(broker.result('x', 'y', { nope: true }).status, 404)
  t.end()
})

// Run logs land in RUN_LOG_DIR under the run id, within the per-request and per-job caps (spec 3.3).
test('broker appends log chunks to the run log and enforces both limits', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'broker-log-'))
  const { broker, ticket } = make({ logDir: dir, logChunkLimit: 10, logJobLimit: 25 })
  const out = settle(broker.submit('codex-report-only', opts))
  const job = await claimed(broker, ticket())
  t.equal(broker.appendLog(job.jobId, job.jobToken, Buffer.from('x'.repeat(11))).status, 413, 'over the per-request cap')
  t.equal(broker.appendLog(job.jobId, job.jobToken, Buffer.from('a'.repeat(10))).status, 200)
  t.equal(broker.appendLog(job.jobId, job.jobToken, Buffer.from('b'.repeat(10))).status, 200)
  t.equal(broker.appendLog(job.jobId, job.jobToken, Buffer.from('c'.repeat(10))).status, 413, 'over the per-job cap')
  t.equal(fs.readFileSync(path.join(dir, 'C1-11.codex.log'), 'utf8'), 'a'.repeat(10) + 'b'.repeat(10))
  broker.abandonAll()
  await out
  t.end()
})

// A run id is a file name under RUN_LOG_DIR; one with a separator must never be queued.
test('broker refuses a run id that could escape the log dir', async t => {
  const { broker } = make()
  const r = await settle(broker.submit('codex-report-only', { ...opts, runId: '../../etc/x' }))
  t.ok(!r.ok && /runId/.test(r.error.message))
  t.end()
})

// Shutdown (issue 32, spec 3.3 cancellation, ruling 6): queued jobs fail at once with the kind's output
// error; claimed jobs get 409 on their next call but may still report; nothing new may queue.
test('broker cancelAll fails queued jobs, signals claimed ones, and refuses new submits', async t => {
  const { broker, ticket } = make()
  const running = settle(broker.submit('claude-review', opts))
  const job = await claimed(broker, ticket())
  const queued = settle(broker.submit('codex-report-only', opts))
  t.equal(broker.cancelAll(), 2)
  const q = await queued
  t.ok(!q.ok && q.error instanceof CodexOutputError && /before a worker claimed it/.test(q.error.message))
  t.equal(broker.heartbeat(job.jobId, job.jobToken).status, 409)
  t.deepEqual(broker.progress(job.jobId, job.jobToken, { line: 'x', activeMs: 1 }), { status: 409, body: { cancel: true } })
  t.equal(broker.result(job.jobId, job.jobToken, { ok: false, error: { class: 'ClaudeRunError', message: 'killed', kind: 'output', activeMs: 3 } }).status, 200)
  const r = await running
  t.ok(!r.ok && r.error instanceof ClaudeRunError && r.error.message === 'killed', 'the worker still reports its own outcome')
  const late = await settle(broker.submit('codex-report-only', opts))
  t.ok(!late.ok && /shutting down/.test(late.error.message), 'a retry during shutdown cannot queue')
  t.end()
})

// Spec 3.3 worker loss: 45 s with no heartbeat fails the job with an OUTPUT error (not a stall, so
// not retried) whose message is "worker lost".
test('broker sweep fails a silent claimed job as worker lost, not stalled', async t => {
  const { broker, clock, ticket } = make()
  const out = settle(broker.submit('claude-review', opts))
  await claimed(broker, ticket())
  for (let i = 0; i < 9; i += 1) {
    clock.now += 5_000
    broker.sweep()
  }
  t.equal(broker.inFlight(), 1, '45 s exactly is not yet lost')
  clock.now += 5_000
  broker.sweep()
  const r = await out
  t.ok(!r.ok && r.error instanceof ClaudeRunError)
  if (!r.ok) {
    t.equal((r.error as ClaudeRunError).kind, 'output')
    t.match(r.error.message, /^worker lost/)
  }
  t.end()
})

// Review Focus 1: after the laptop (or the Docker VM) sleeps, every heartbeat is stale. A sweep that
// fired far later than scheduled must reset the clocks instead of failing every review. Detection is
// only deferred, not disabled: real silence afterwards still fails the job.
test('broker sweep after a freeze does not fail claimed jobs as worker lost', async t => {
  const { broker, clock, ticket } = make()
  const out = settle(broker.submit('codex-report-only', opts))
  await claimed(broker, ticket())
  broker.sweep()
  clock.now += 10 * 60_000
  broker.sweep()
  t.equal(broker.inFlight(), 1, 'a ten-minute nap is not worker loss')
  for (let i = 0; i < 10; i += 1) {
    clock.now += 5_000
    broker.sweep()
  }
  const r = await out
  t.ok(!r.ok && /^worker lost/.test(r.error.message), 'silence after waking is still detected')
  t.end()
})

// Ruling F4: heartbeats alone cannot bound a job. A worker that keeps heartbeating (a wedged engine,
// or PR code holding the job token) must still lose its slot once timeoutMs + the margin has passed.
// Regression caught: a claimed job that pins a CONCURRENCY slot forever.
test('broker fails a heartbeating job that outlives its run deadline', async t => {
  const { broker, clock, ticket } = make({ deadlineMarginMs: 10_000 })
  const out = settle(broker.submit('claude-review', opts))
  const job = await claimed(broker, ticket())
  for (let i = 0; i < 2; i += 1) {
    clock.now += 5_000
    broker.heartbeat(job.jobId, job.jobToken)
    broker.sweep()
  }
  t.equal(broker.inFlight(), 1, 'within timeoutMs + margin (11 s) the job keeps running')
  clock.now += 5_000
  broker.heartbeat(job.jobId, job.jobToken)
  broker.sweep()
  const r = await out
  t.ok(!r.ok && r.error instanceof ClaudeRunError && (r.error as ClaudeRunError).kind === 'output', 'an output error, never retried')
  if (!r.ok) t.equal(r.error.message, 'worker exceeded its run deadline')
  t.end()
})

// Ruling F4 with ruling 7: the run cannot progress while the machine sleeps, so a freeze pushes the
// deadline back by the frozen time. Regression caught: every in-flight review failing on wake because
// its deadline passed during the nap.
test('broker extends the run deadline by a freeze', async t => {
  const { broker, clock, ticket } = make({ deadlineMarginMs: 10_000 })
  const out = settle(broker.submit('codex-report-only', opts))
  const job = await claimed(broker, ticket())
  broker.sweep()
  clock.now += 60_000
  broker.sweep()
  for (let i = 0; i < 2; i += 1) {
    clock.now += 5_000
    broker.heartbeat(job.jobId, job.jobToken)
    broker.sweep()
  }
  t.equal(broker.inFlight(), 1, 'deadline moved from +11 s to +71 s; now at +70 s')
  clock.now += 5_000
  broker.heartbeat(job.jobId, job.jobToken)
  broker.sweep()
  const r = await out
  t.ok(!r.ok && r.error instanceof CodexOutputError && r.error.message === 'worker exceeded its run deadline')
  t.end()
})

// The daemon drains through drainChildRegistry; the adapter maps SIGTERM to cancel and SIGKILL to
// abandon, and size() to in-flight jobs, so the existing shutdown code needs no container branch.
test('broker asRegistry maps SIGTERM to cancel, SIGKILL to abandon, size to in-flight', async t => {
  const { broker, ticket } = make()
  const out = settle(broker.submit('codex-report-only', opts))
  const job = await claimed(broker, ticket())
  const registry = broker.asRegistry()
  t.equal(registry.size(), 1)
  t.equal(registry.killAll('SIGTERM'), 1)
  t.equal(broker.heartbeat(job.jobId, job.jobToken).status, 409, 'cancelled, still in flight')
  t.equal(registry.size(), 1)
  t.equal(registry.killAll('SIGKILL'), 1)
  const r = await out
  t.ok(!r.ok && r.error instanceof CodexOutputError && /did not report back/.test(r.error.message))
  t.equal(registry.size(), 0)
  t.end()
})
