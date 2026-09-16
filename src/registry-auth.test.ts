import test from 'tape'
import { ensureRegistryAuth, type Exec } from './registry-auth'

/** A recording exec seam: captures its calls and returns a scripted result or throws. */
function fakeExec(result: { throwCode?: number; throwText?: string } = {}): {
  exec: Exec
  calls: Array<{ file: string; args: string[] }>
} {
  const calls: Array<{ file: string; args: string[] }> = []
  const exec: Exec = async (file, args) => {
    calls.push({ file, args })
    if (result.throwCode !== undefined || result.throwText !== undefined) {
      // Mimic execFile's error shape: a numeric .code plus stderr/stdout that may carry the
      // command's output. The token would ride here if the script ever printed it — the test
      // below proves ensureRegistryAuth does not surface any of it.
      const err = new Error(`Command failed: bash ${args.join(' ')}\n${result.throwText ?? ''}`) as Error & {
        code?: number
        stderr?: string
      }
      err.code = result.throwCode ?? 1
      err.stderr = result.throwText ?? ''
      throw err
    }
    return { stdout: '...ok', stderr: '' }
  }
  return { exec, calls }
}

// The kill switch must be honored: with the refresh disabled the bot must not shell out at all.
test('ensureRegistryAuth does nothing when disabled', async t => {
  const { exec, calls } = fakeExec()
  const events: string[] = []
  await ensureRegistryAuth({
    scriptPath: '/x/codeartifact-login.sh',
    enabled: false,
    exec,
    log: e => events.push(e),
  })
  t.equal(calls.length, 0, 'no subprocess spawned')
  t.deepEqual(events, [], 'nothing logged')
  t.end()
})

// The happy path: invoke the vendored script at user scope and record the refresh.
test('ensureRegistryAuth runs the login script at user scope and logs success', async t => {
  const { exec, calls } = fakeExec()
  const events: Array<{ event: string; fields: Record<string, unknown> }> = []
  await ensureRegistryAuth({
    scriptPath: '/x/codeartifact-login.sh',
    enabled: true,
    exec,
    log: (event, fields) => events.push({ event, fields }),
  })
  t.deepEqual(calls, [{ file: 'bash', args: ['/x/codeartifact-login.sh', '-u'] }], 'runs bash script -u')
  t.equal(events.length, 1)
  t.equal(events[0].event, 'codeartifact.refreshed', 'logs the refresh event')
  t.end()
})

// Best-effort contract: a failed refresh must NOT throw — an expired token only means npm ci
// fails exactly as it does today, and the review must still run. It logs the exit code only.
test('ensureRegistryAuth swallows a failed refresh and logs the exit code', async t => {
  const { exec } = fakeExec({ throwCode: 7, throwText: 'aws: some error' })
  const events: Array<{ event: string; fields: Record<string, unknown> }> = []
  await ensureRegistryAuth({
    scriptPath: '/x/codeartifact-login.sh',
    enabled: true,
    exec,
    log: (event, fields) => events.push({ event, fields }),
  })
  t.equal(events.length, 1)
  t.equal(events[0].event, 'codeartifact.refresh-failed', 'logs the failure event')
  t.equal(events[0].fields.exitCode, 7, 'records the exit code for triage')
  t.end()
})

// Security: the failure log must carry no captured subprocess output, so a token the script
// might ever print cannot leak into the daemon log (which is not run through the redactor).
test('ensureRegistryAuth never logs subprocess stdout/stderr on failure', async t => {
  const secretish = 'eyJ2ZXIiOiJzdXBlci1zZWNyZXQtdG9rZW4ifQ'
  const { exec } = fakeExec({ throwCode: 1, throwText: `token was ${secretish}` })
  let logged = ''
  await ensureRegistryAuth({
    scriptPath: '/x/codeartifact-login.sh',
    enabled: true,
    exec,
    log: (event, fields) => {
      logged += `${event} ${JSON.stringify(fields)}`
    },
  })
  t.equal(logged.includes(secretish), false, 'no subprocess output text in the log fields')
  t.end()
})
