import test from 'tape'
import { defaultRunner, GH_COMMAND_TIMEOUT_MS, makeGitHubEffects } from './github'

const pr = { owner: 'trade-platform', repo: 'deployments', number: 5, url: 'https://github.com/trade-platform/deployments/pull/5' }

// listChangedFiles must ask gh for names only (never the diff contents) and return clean paths.
test('listChangedFiles requests names-only and parses the output', async t => {
  const calls: string[][] = []
  const gh = makeGitHubEffects('gh', async args => {
    calls.push(args)
    return 'apps/web/values.yaml\nREADME.md\n\n'
  })
  const files = await gh.listChangedFiles!(pr)
  t.deepEqual(files, ['apps/web/values.yaml', 'README.md'], 'trimmed, blank lines dropped')
  t.deepEqual(
    calls[0],
    ['pr', 'diff', '5', '--repo', 'trade-platform/deployments', '--name-only'],
    'names only, addressed by number + repo'
  )
  t.end()
})

// postPrComment must target the PR and pass the body through unchanged.
test('postPrComment posts the body to the PR', async t => {
  const calls: string[][] = []
  const gh = makeGitHubEffects('gh', async args => {
    calls.push(args)
    return ''
  })
  await gh.postPrComment!(pr, 'a human must review this')
  t.deepEqual(calls[0], [
    'pr',
    'comment',
    '5',
    '--repo',
    'trade-platform/deployments',
    '--body',
    'a human must review this',
  ])
  t.end()
})

// #17: the gate runs inside the concurrency slot, so a wedged `gh` would pin the whole queue.
// Every gh invocation must carry a finite timeout (and SIGKILL) so a hang becomes a rejection —
// which the gate already handles by failing safe to human review.
test('the gh runner bounds each call with a finite timeout', async t => {
  let seen: { maxBuffer: number; timeout: number; killSignal: NodeJS.Signals } | undefined
  const fakeExec = async (
    _bin: string,
    _args: string[],
    opts: { maxBuffer: number; timeout: number; killSignal: NodeJS.Signals }
  ) => {
    seen = opts
    return { stdout: 'values.yaml\n' }
  }
  const run = defaultRunner('gh', GH_COMMAND_TIMEOUT_MS, fakeExec)
  await run(['pr', 'diff', '5', '--repo', 'trade-platform/deployments', '--name-only'])
  t.ok(seen, 'the exec was invoked')
  t.equal(seen?.timeout, GH_COMMAND_TIMEOUT_MS, 'a finite per-call timeout is passed')
  t.ok((seen?.timeout ?? 0) > 0, 'and it is positive')
  t.equal(seen?.killSignal, 'SIGKILL', 'a wedged gh is SIGKILLed, not left to linger')
  t.end()
})

// A rejection (a real timeout would reject) propagates out of the runner, so the gate's
// existing fail-safe catch treats the PR as needing a human.
test('the gh runner surfaces a timeout rejection to the caller', async t => {
  const run = defaultRunner('gh', 5, async () => {
    throw Object.assign(new Error('gh timed out'), { killed: true, signal: 'SIGKILL' })
  })
  try {
    await run(['pr', 'diff', '5'])
    t.fail('a timed-out gh must reject')
  } catch (error) {
    t.ok(String(error).includes('timed out'), 'the rejection reaches the gate')
  }
  t.end()
})
