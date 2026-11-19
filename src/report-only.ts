// `npm run review -- --report-only`: run the engines in review-pr's report-only mode against each
// PR's current head and print what they found. Nothing is posted, approved or pushed: this path
// never builds the approver client, never calls preparePr/finishPr, and its only GitHub call is the
// read that pins each head. Used to compare models on real PRs (the refresh-bot-runtime skill).

import { combineUsage } from './dual'
import type { EnginePass } from './dual-gate'
import type { EngineName } from './config'
import type { Engine, EngineRunOutcome } from './engine'
import { runEngines } from './engine-schedule'
import type { GhRunner } from './gh-api'
import type { PullRequestRef } from './parse-message'
import { redactSecrets } from './redact'
import type { RunUsage } from './usage'

const ENGINES: readonly EngineName[] = ['codex', 'claude']
const SHA = /^[0-9a-f]{40}$/

/** `--engine codex`, `--engine claude` or `--engine codex,claude`; undefined when absent. */
export function parseEngineFlag(argv: string[]): { engines?: EngineName[]; rest: string[] } {
  const rest: string[] = []
  let engines: EngineName[] | undefined
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const value = arg === '--engine' ? argv[++i] : arg.startsWith('--engine=') ? arg.slice('--engine='.length) : undefined
    if (arg !== '--engine' && value === undefined) {
      rest.push(arg)
      continue
    }
    const names = (value ?? '').split(',').map(s => s.trim()).filter(Boolean)
    if (names.length === 0 || names.some(n => !ENGINES.includes(n as EngineName)) || new Set(names).size !== names.length) {
      throw new Error('--engine must be "codex", "claude" or "codex,claude"')
    }
    engines = names as EngineName[]
  }
  return { engines, rest }
}

/** The PR's current head commit, read with `gh api`. A read only; anything but a full SHA is an error. */
export async function pinHead(gh: GhRunner, ref: PullRequestRef, env?: NodeJS.ProcessEnv): Promise<string> {
  let out: string
  try {
    out = await gh(['api', `repos/${ref.owner}/${ref.repo}/pulls/${ref.number}`, '--jq', '.head.sha'], env ? { env } : {})
  } catch (error) {
    throw new Error(`could not read the head of ${ref.url}: ${redactSecrets(error instanceof Error ? error.message : String(error)).split('\n')[0]}`)
  }
  const sha = out.trim().toLowerCase()
  if (!SHA.test(sha)) throw new Error(`could not read the head of ${ref.url}: gh returned no commit SHA`)
  return sha
}

export interface ReportOnlyRequest {
  prs: PullRequestRef[]
  instructions: string
  requestedBy?: string
}

export interface ReportOnlyDeps {
  gh: GhRunner
  /** Environment for the pinning read (e.g. with ENGINE_GH_TOKEN); undefined inherits. */
  ghEnv?: NodeJS.ProcessEnv
  engines: Engine[]
  worktreeRoot: string
  runId: string
  onProgress?: (line: string, activeMs: number) => void
}

export interface ReportOnlyReport {
  prs: { url: string; pinnedSha: string; passes: EnginePass[] }[]
  outcomes: EngineRunOutcome[]
  usage: RunUsage
}

/** Pin every head, then run every engine on every PR (parallel: each engine judges each PR). */
export async function runReportOnly(request: ReportOnlyRequest, deps: ReportOnlyDeps): Promise<ReportOnlyReport> {
  const prs = []
  for (const ref of request.prs) prs.push({ ref, pinnedSha: await pinHead(deps.gh, ref, deps.ghEnv) })
  const { passes, outcomes } = await runEngines(deps.engines, 'parallel', {
    prs,
    instructions: request.instructions,
    requestedBy: request.requestedBy,
    runId: deps.runId,
    worktreeRoot: deps.worktreeRoot,
    onProgress: deps.onProgress,
  })
  return {
    prs: prs.map(pr => ({ url: pr.ref.url, pinnedSha: pr.pinnedSha, passes: passes.get(pr.ref.url) ?? [] })),
    outcomes,
    usage: combineUsage(outcomes),
  }
}

/** 0 when every engine judged every PR clean; 1 for findings or a block; 2 when any pass is unusable. */
export function reportOnlyExitCode(report: ReportOnlyReport): number {
  const states = report.prs.flatMap(pr => pr.passes.map(p => p.state))
  if (states.length === 0 || states.some(s => s === 'invalid' || s === 'skipped')) return 2
  return states.every(s => s === 'clean') ? 0 : 1
}

/** One line per engine per PR, for a human reading the terminal. */
export function renderReportOnly(report: ReportOnlyReport): string {
  const lines: string[] = []
  for (const pr of report.prs) {
    lines.push(`${pr.url} @ ${pr.pinnedSha.slice(0, 12)}`)
    for (const pass of pr.passes) lines.push(`  ${pass.engine}: ${pass.state} (${pass.detail})`)
  }
  return lines.join('\n')
}
