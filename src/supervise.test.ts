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
// caller's prefix. Codex keeps "codex.*" (the names operators already grep for).
test('superviseChild returns the redacted transcript and uses the log prefix', async t => {
  const child = new FakeChild()
  const spawner = (() => child) as unknown as Spawner
  const events: string[] = []
  const run = superviseChild(
    {
      bin: 'x', args: [], cwd: '/', env: {}, timeoutMs: 60_000, stallTimeoutMs: 0,
      logName: 'n', runId: 'r', logPrefix: 'claude', log: event => events.push(event),
    },
    spawner,
    { setInterval: () => 1 as unknown as ReturnType<typeof setInterval>, clearInterval: () => {} }
  )
  child.stdout.write('hello\n')
  await new Promise(resolve => setImmediate(resolve))
  child.emit('close', 0)
  const exit = await run
  t.equal(exit.code, 0)
  t.ok(exit.transcript.includes('hello'), 'output reaches the transcript')
  t.ok(events.every(event => event.startsWith('claude.')), 'any event uses the given prefix')
  t.end()
})
