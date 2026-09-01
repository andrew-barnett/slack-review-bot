import test from 'tape'
import { TaskQueue } from './queue'

function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

// The default limit of 1 is what stops two reviews colliding in the same repository's
// .git and thrashing the machine with parallel test suites.
test('TaskQueue runs one task at a time at limit 1', async t => {
  const queue = new TaskQueue(1)
  const first = deferred()
  const order: string[] = []

  const a = queue.run(async () => {
    order.push('a-start')
    await first.promise
    order.push('a-end')
  })
  const b = queue.run(async () => {
    order.push('b-start')
  })

  await new Promise(resolve => setTimeout(resolve, 10))
  t.deepEqual(order, ['a-start'], 'b has not started while a is running')
  t.equal(queue.queued, 1)

  first.resolve()
  await Promise.all([a, b])
  t.deepEqual(order, ['a-start', 'a-end', 'b-start'], 'b runs only after a finishes')
  t.end()
})

// If a rejected task kept its slot, one failed review would permanently shrink the pool
// — and at the default limit of 1 the bot would stop reviewing anything, silently.
test('TaskQueue releases the slot when a task throws', async t => {
  const queue = new TaskQueue(1)
  let caught: unknown
  try {
    await queue.run(async () => { throw new Error('boom') })
  } catch (error) {
    caught = error
  }
  t.equal((caught as Error)?.message, 'boom', 'the failure propagates to the caller')
  t.equal(queue.active, 0, 'slot released')
  const value = await queue.run(async () => 'ok')
  t.equal(value, 'ok', 'queue still works after a failure')
  t.end()
})

test('TaskQueue runs up to the limit concurrently', async t => {
  const queue = new TaskQueue(2)
  const gate = deferred()
  let peak = 0
  const task = async () => {
    peak = Math.max(peak, queue.active)
    await gate.promise
  }
  const runs = [queue.run(task), queue.run(task), queue.run(task)]
  await new Promise(resolve => setTimeout(resolve, 10))
  t.equal(peak, 2, 'never exceeds the limit')
  t.equal(queue.queued, 1)
  gate.resolve()
  await Promise.all(runs)
  t.end()
})

// Reviews should be served in the order they were asked for; a queue that reordered
// them would make the bot look like it skipped someone.
test('TaskQueue preserves arrival order', async t => {
  const queue = new TaskQueue(1)
  const gate = deferred()
  const order: number[] = []
  const runs = [
    queue.run(async () => { await gate.promise; order.push(0) }),
    queue.run(async () => { order.push(1) }),
    queue.run(async () => { order.push(2) }),
  ]
  gate.resolve()
  await Promise.all(runs)
  t.deepEqual(order, [0, 1, 2])
  t.end()
})

// The dispatcher decides whether to add the queued reaction from this flag, read just before
// it hands the job over. It has to flip exactly when a new task would wait, or a message that
// waits gets no reaction (or one that starts at once gets an hourglass it never loses).
test('TaskQueue.saturated is true exactly while every slot is taken', async t => {
  const queue = new TaskQueue(1)
  t.equal(queue.saturated, false, 'an idle queue has a free slot')
  const first = deferred()
  const running = queue.run(async () => { await first.promise })
  await new Promise(resolve => setTimeout(resolve, 0))
  t.equal(queue.saturated, true, 'the only slot is taken')
  first.resolve()
  await running
  t.equal(queue.saturated, false, 'the slot is free again once the task settles')
  t.end()
})
