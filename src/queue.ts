// A minimal FIFO queue with a concurrency limit.
//
// Reviews are long (tens of minutes) and expensive: they check out worktrees, install
// dependencies, and run test suites. Running several at once on a laptop thrashes the
// machine and multiplies the chance two reviews collide in the same repository's .git,
// so the default limit is 1 and messages queue behind each other in arrival order.
// This is the local equivalent of the /investigate bot's single-MessageGroupId FIFO.

export type Task<T> = () => Promise<T>

export class TaskQueue {
  private readonly limit: number
  private running = 0
  private readonly pending: Array<() => void> = []

  constructor(limit: number) {
    this.limit = Math.max(1, limit)
  }

  /** Number of tasks waiting for a slot. */
  get queued(): number {
    return this.pending.length
  }

  /** Number of tasks currently executing. */
  get active(): number {
    return this.running
  }

  /** True when a task handed to `run` right now would wait for a slot. */
  get saturated(): boolean {
    return this.running >= this.limit
  }

  /**
   * Run `task` when a slot frees up, resolving with its result.
   *
   * A task that throws still releases its slot — otherwise one failed review would
   * permanently shrink the pool and, at the default limit of 1, wedge the bot.
   */
  async run<T>(task: Task<T>): Promise<T> {
    if (this.running >= this.limit) {
      await new Promise<void>(resolve => this.pending.push(resolve))
    }
    this.running += 1
    try {
      return await task()
    } finally {
      this.running -= 1
      const next = this.pending.shift()
      if (next) next()
    }
  }
}
