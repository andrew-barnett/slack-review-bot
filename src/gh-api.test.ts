import test from 'tape'
import { defaultRunner, GH_COMMAND_TIMEOUT_MS, GhApiError, ghApi, ghApiLines, httpStatusOf } from './gh-api'

// Request bodies can carry finding text written by a model from untrusted PR content. They must go
// over stdin, never argv, so nothing is shell-interpreted or visible in a process listing.
test('ghApi sends a body on stdin with --input -', async t => {
  const calls: { args: string[]; input?: string }[] = []
  const out = await ghApi<{ id: number }>(async (args, opts) => {
    calls.push({ args, input: opts?.input })
    return '{"id":7}'
  }, 'repos/o/r/pulls/1/reviews', { method: 'POST', body: { event: 'COMMENT' } })
  t.deepEqual(calls[0].args, ['api', 'repos/o/r/pulls/1/reviews', '--method', 'POST', '--input', '-'])
  t.equal(calls[0].input, '{"event":"COMMENT"}')
  t.deepEqual(out, { id: 7 })
  t.end()
})

// Callers must tell "absent" (404) from "failed" (anything else). The pre-flight treats an absent
// branch protection as no requirement but a 403 as unreadable.
test('ghApi surfaces the HTTP status of a failed call', async t => {
  const failing = async () => {
    const error = new Error('Command failed') as Error & { stderr: string }
    error.stderr = 'gh: Not Found (HTTP 404)'
    throw error
  }
  try {
    await ghApi(failing, 'repos/o/r/branches/main/protection')
    t.fail('should throw')
  } catch (error) {
    t.ok(error instanceof GhApiError)
    t.equal((error as GhApiError).status, 404)
  }
  t.equal(httpStatusOf(new Error('no status here')), undefined)
  t.end()
})

// Lists span pages. --paginate with --jq '.[]' yields one JSON object per line across all pages,
// so a second page is never silently dropped (Review Focus 5).
test('ghApiLines paginates and parses one object per line', async t => {
  let seen: string[] = []
  const items = await ghApiLines<{ n: number }>(async args => {
    seen = args
    return '{"n":1}\n{"n":2}\n\n{"n":3}\n'
  }, 'repos/o/r/pulls/1/files')
  t.deepEqual(seen, ['api', '--paginate', 'repos/o/r/pulls/1/files', '--jq', '.[]'])
  t.deepEqual(items.map(i => i.n), [1, 2, 3])
  t.end()
})

// The approver token is passed per call through env. The runner must forward env and input to the
// exec, and keep the finite timeout (issue 17's guarantee).
test('defaultRunner forwards env and input with the timeout', async t => {
  let seen: Record<string, unknown> | undefined
  const run = defaultRunner('gh', GH_COMMAND_TIMEOUT_MS, async (_bin, _args, opts) => {
    seen = opts as unknown as Record<string, unknown>
    return { stdout: '' }
  })
  await run(['api', 'user'], { env: { GH_TOKEN: 'placeholder' }, input: '{}' })
  t.equal(seen?.timeout, GH_COMMAND_TIMEOUT_MS)
  t.deepEqual(seen?.env, { GH_TOKEN: 'placeholder' })
  t.equal(seen?.input, '{}')
  t.end()
})
