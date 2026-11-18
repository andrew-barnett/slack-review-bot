// Running the configured engines for one request, in parallel or serially (spec Q2 and 5.8).
//
// Parallel starts every engine on every PR at once; the request still holds one CONCURRENCY slot.
// Serial decides per PR: the next engine receives only the PRs every earlier engine passed as
// clean, so a defect in one PR never denies another PR its second review. A PR that dropped out
// gets `skipped` for each later engine, naming the earlier engine that was not clean.

import type { EngineSchedule } from './config'
import { passFor, skippedPass, type EnginePass } from './dual-gate'
import { engineWorktreeRoot, type Engine, type EnginePr, type EngineRunOutcome } from './engine'
import { redactSecrets } from './redact'

export interface ScheduleInput {
  prs: EnginePr[]
  instructions: string
  requestedBy?: string
  runId: string
  /** The configured WORKTREE_ROOT; each engine gets its own subdirectory. */
  worktreeRoot: string
  onProgress?: (line: string, activeMs: number) => void
}

export interface ScheduledRun {
  /** Per PR URL, one pass per engine, in engine order. */
  passes: Map<string, EnginePass[]>
  /** Every engine run that actually happened, for usage. */
  outcomes: EngineRunOutcome[]
}

/** `engines` must already be in ENGINE_ORDER; parallel mode uses the same order for reporting. */
export async function runEngines(engines: Engine[], schedule: EngineSchedule, input: ScheduleInput): Promise<ScheduledRun> {
  const passes = new Map<string, EnginePass[]>(input.prs.map(pr => [pr.ref.url, []]))
  const runOne = async (engine: Engine, prs: EnginePr[]): Promise<EngineRunOutcome> => {
    try {
      return await engine.run({
        prs,
        instructions: input.instructions,
        requestedBy: input.requestedBy,
        worktreeRoot: engineWorktreeRoot(input.worktreeRoot, engine.name),
        runId: input.runId,
        onProgress: input.onProgress,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { engine: engine.name, results: [], usage: { attempts: 0 }, error: redactSecrets(message) }
    }
  }

  if (schedule === 'parallel') {
    const outcomes = await Promise.all(engines.map(engine => runOne(engine, input.prs)))
    for (const outcome of outcomes) {
      for (const pr of input.prs) passes.get(pr.ref.url)!.push(passFor(outcome, pr.ref.url, pr.pinnedSha))
    }
    return { passes, outcomes }
  }

  const outcomes: EngineRunOutcome[] = []
  // The first earlier engine that was not clean, per PR that dropped out.
  const stoppedBy = new Map<string, Engine['name']>()
  for (const engine of engines) {
    const remaining = input.prs.filter(pr => !stoppedBy.has(pr.ref.url))
    if (remaining.length > 0) {
      const outcome = await runOne(engine, remaining)
      outcomes.push(outcome)
      for (const pr of remaining) {
        const pass = passFor(outcome, pr.ref.url, pr.pinnedSha)
        passes.get(pr.ref.url)!.push(pass)
        if (pass.state !== 'clean') stoppedBy.set(pr.ref.url, engine.name)
      }
    }
    for (const pr of input.prs) {
      const earlier = stoppedBy.get(pr.ref.url)
      if (earlier && earlier !== engine.name) passes.get(pr.ref.url)!.push(skippedPass(engine.name, earlier))
    }
  }
  return { passes, outcomes }
}
