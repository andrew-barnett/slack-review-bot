import type { ChildProcess } from 'child_process'
import { EventEmitter } from 'events'
import { PassThrough } from 'stream'
import test from 'tape'
import { createChildRegistry, drainChildRegistry, superviseChild, type Spawner } from './supervise'

class FakeChild extends EventEmitter {
  pid: number | undefined = undefined
  stdout = new PassThrough()
  stderr = new PassThrough()
  signals: string[] = []
  kill(signal?: NodeJS.Signals | number): boolean {
    this.signals.push(String(signal))
    this.emit('close', null)
    return true
  }
}

// Dual mode runs two engine children at once. Shutdown must stop both, not just the first one
// registered. Regression: a drain that returned after one child exited would orphan the other.
test('drainChildRegistry stops two concurrent children', async t => {
  const registry = createChildRegistry()
  const a = new FakeChild()
  const b = new FakeChild()
  registry.add(a as unknown as ChildProcess)
  registry.add(b as unknown as ChildProcess)
  // FakeChild exits on the first signal; deregister on close as the real run's close handler does.
  a.on('close', () => registry.remove(a as unknown as ChildProcess))
  b.on('close', () => registry.remove(b as unknown as ChildProcess))
  let now = 0
  await drainChildRegistry(registry, {
    now: () => now,
    setTimer: (fn, ms) => {
      now += ms
      return setTimeout(fn, 0)
    },
    graceMs: 1_000,
    pollMs: 100,
  })
  t.deepEqual(a.signals, ['SIGTERM'])
  t.deepEqual(b.signals, ['SIGTERM'])
  t.equal(registry.size(), 0, 'both deregistered')
  t.end()
})

// Each engine's events must stay distinguishable in the daemon log, so the event names carry the
// caller's prefix. Codex keeps "codex.*" (the names operators already grep for). Regression: a
// hardcoded or dropped prefix would pass a check that only inspects events that never fire, so this
// drives a real stall and asserts the exact event name.
test('superviseChild names its stall event with the caller log prefix', async t => {
  const child = new FakeChild()
  const spawner = (() => child) as unknown as Spawner
  let now = 1_000_000
  let heartbeat: (() => void) | undefined
  const events: string[] = []
  const run = superviseChild(
    {
      bin: 'x', args: [], cwd: '/', env: {}, timeoutMs: 600_000, stallTimeoutMs: 40_000,
      logName: 'n', runId: 'r', logPrefix: 'claude', log: event => events.push(event),
    },
    spawner,
    {
      now: () => now,
      setInterval: (cb: () => void) => {
        heartbeat = cb
        return 1 as unknown as ReturnType<typeof setInterval>
      },
      clearInterval: () => {},
      checkMs: 10_000,
      toleranceMs: 5_000,
    }
  )
  await new Promise(resolve => setImmediate(resolve))
  // Four silent heartbeats reach the 40s grace; the stall kills the child (FakeChild closes on signal).
  for (let i = 0; i < 4; i += 1) {
    now += 10_000
    heartbeat?.()
  }
  const exit = await run
  t.ok(exit.stalled, 'the run is reported stalled')
  t.deepEqual(child.signals, ['SIGTERM'], 'the stalled child is signalled')
  t.deepEqual(events, ['claude.stalled'], 'the event carries the caller prefix')
  t.end()
})

// The supervised exit must hand the caller the child's output, since engines parse results from it.
test('superviseChild returns the child output as the transcript', async t => {
  const child = new FakeChild()
  const spawner = (() => child) as unknown as Spawner
  const run = superviseChild(
    { bin: 'x', args: [], cwd: '/', env: {}, timeoutMs: 60_000, logName: 'n', runId: 'r', logPrefix: 'claude' },
    spawner,
    { setInterval: () => 1 as unknown as ReturnType<typeof setInterval>, clearInterval: () => {} }
  )
  child.stdout.write('hello\n')
  await new Promise(resolve => setImmediate(resolve))
  child.emit('close', 0)
  const exit = await run
  t.equal(exit.code, 0)
  t.ok(exit.transcript.includes('hello'), 'output reaches the transcript')
  t.end()
})

// Claude's result arrives on stdout and can exceed the bounded transcript tail, so the engine reads
// raw stdout through onStdout. Only stdout is delivered, and a throwing parser must not take the run
// down. Regression caught: stderr noise reaching the result parser, or a parser bug crashing a review.
test('superviseChild hands raw stdout, and only stdout, to onStdout', async t => {
  const child = new FakeChild()
  const spawner = (() => child) as unknown as Spawner
  const seen: string[] = []
  const run = superviseChild(
    {
      bin: 'x', args: [], cwd: '/', env: {}, timeoutMs: 60_000, logName: 'n', runId: 'r', logPrefix: 'claude',
      onStdout: text => {
        seen.push(text)
        throw new Error('parser bug')
      },
    },
    spawner,
    { setInterval: () => 1 as unknown as ReturnType<typeof setInterval>, clearInterval: () => {} }
  )
  child.stdout.write('{"type":"result"}\n')
  child.stderr.write('warning on stderr\n')
  await new Promise(resolve => setImmediate(resolve))
  child.emit('close', 0)
  const exit = await run
  t.deepEqual(seen, ['{"type":"result"}\n'])
  t.equal(exit.code, 0, 'the run still completes')
  t.end()
})
