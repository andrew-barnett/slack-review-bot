import test from 'tape'
import { parseClaimReply, parseWireOptions, ticketMaxAgeMs, toWireOptions } from './protocol'

const good = { prompt: 'review', worktreeRoot: '/work/wt/codex', timeoutMs: 1000, stallTimeoutMs: 500, runId: 'C1-11.codex' }

// Nothing but the five wire fields may leave the orchestrator: not the engine token, not Bedrock
// credentials, not a binary path or profile a worker would then trust (ruling 1). Regression caught:
// spreading the whole run-options object into the claim reply.
test('toWireOptions keeps exactly the five wire fields', t => {
  const full = {
    ...good,
    engineGhToken: 'engine-placeholder',
    bedrock: { region: 'us-east-2', model: 'm', credentials: { accessKeyId: 'a', secretAccessKey: 's' } },
    codexBin: '/evil/codex',
    profile: 'p',
    workspaceRoot: '/',
    disableGitSigning: false,
    envPassthrough: ['APPROVER_GH_TOKEN'],
    registry: {},
    log: () => {},
    onProgress: () => {},
  }
  t.deepEqual(Object.keys(toWireOptions(full)).sort(), ['prompt', 'runId', 'stallTimeoutMs', 'timeoutMs', 'worktreeRoot'])
  t.deepEqual(Object.keys(toWireOptions({ ...good, stallTimeoutMs: undefined })).sort(), ['prompt', 'runId', 'timeoutMs', 'worktreeRoot'])
  t.end()
})

// The worker validates what it is told to run; a run id with a path separator would let the log
// file escape RUN_LOG_DIR, and a relative worktree root would land in the process cwd.
test('parseWireOptions rejects unsafe or missing fields', t => {
  t.deepEqual(parseWireOptions(good), good)
  t.throws(() => parseWireOptions({ ...good, runId: '../x' }), /runId/)
  t.throws(() => parseWireOptions({ ...good, worktreeRoot: 'relative' }), /worktreeRoot/)
  t.throws(() => parseWireOptions({ ...good, prompt: '' }), /prompt/)
  t.throws(() => parseWireOptions({ ...good, timeoutMs: -1 }), /timeoutMs/)
  t.throws(() => parseWireOptions({ ...good, stallTimeoutMs: 'x' }), /stallTimeoutMs/)
  t.throws(() => parseWireOptions(null), /options/)
  t.end()
})

// The claim reply is the job assignment; a malformed one must be refused rather than half-used.
test('parseClaimReply validates id, token and kind', t => {
  const reply = { jobId: 'abc123', jobToken: 'f'.repeat(64), kind: 'claude-review', options: good }
  t.deepEqual(parseClaimReply(reply), reply)
  t.throws(() => parseClaimReply({ ...reply, kind: 'shell' }), /kind/)
  t.throws(() => parseClaimReply({ ...reply, jobToken: 'short' }), /jobToken/)
  t.throws(() => parseClaimReply({ ...reply, jobId: 'a/b' }), /jobId/)
  t.end()
})

// Spec 3.3: tickets older than WORKER_IDLE_EXIT_MS + 1 minute are rejected.
test('ticketMaxAgeMs adds one minute to the idle exit', t => {
  t.equal(ticketMaxAgeMs(600_000), 660_000)
  t.end()
})
