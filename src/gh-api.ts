// The one way the bot talks to `gh`: a bounded runner with an optional per-call environment
// (how the approver token reaches gh without ever entering process.env) and stdin input (how
// request bodies avoid argv), plus small JSON helpers that keep the HTTP status of a failure.

import { execFile } from 'child_process'

export type GhCallOptions = {
  /**
   * Replaces the entire child environment (does not merge with process.env). Callers must pass
   * a complete environment, e.g. `{ ...process.env, GH_TOKEN }`, since token separation requires
   * the approver token to reach the child in isolation without process.env.
   */
  env?: NodeJS.ProcessEnv
  input?: string
}

/** Runs `gh` with the given args and returns stdout. Swapped out in tests. */
export type GhRunner = (args: string[], opts?: GhCallOptions) => Promise<string>

/**
 * Per-call timeout for `gh`. A `gh` wedged on a network stall would otherwise pin the review slot;
 * a finite timeout turns the hang into a rejection the callers already handle.
 */
export const GH_COMMAND_TIMEOUT_MS = 30_000

export type ExecOpts = {
  maxBuffer: number
  timeout: number
  killSignal: NodeJS.Signals
  env?: NodeJS.ProcessEnv
  input?: string
}
type ExecFn = (bin: string, args: string[], opts: ExecOpts) => Promise<{ stdout: string }>

const realExec: ExecFn = (bin, args, opts) =>
  new Promise((resolve, reject) => {
    const { input, ...execOpts } = opts
    const child = execFile(bin, args, execOpts, (error, stdout, stderr) => {
      if (error) {
        // Keep stderr on the error: it carries gh's "(HTTP 404)" marker that httpStatusOf reads.
        Object.assign(error, { stderr: String(stderr) })
        reject(error)
        return
      }
      resolve({ stdout: String(stdout) })
    })
    // Guard against EPIPE if the child exits or is SIGKILLed before stdin drains; the callback
    // already reports the failure, so ignore the error.
    child.stdin?.on('error', () => {})
    child.stdin?.end(input ?? '')
  })

export function defaultRunner(
  bin: string,
  timeoutMs: number = GH_COMMAND_TIMEOUT_MS,
  exec: ExecFn = realExec
): GhRunner {
  return async (args, opts = {}) => {
    const { stdout } = await exec(bin, args, {
      // A large PR can list many files; 10 MB is far more than any real response reaches.
      maxBuffer: 10 * 1024 * 1024,
      timeout: timeoutMs,
      killSignal: 'SIGKILL',
      ...(opts.env ? { env: opts.env } : {}),
      ...(opts.input !== undefined ? { input: opts.input } : {}),
    })
    return stdout
  }
}

/** A failed `gh api` call, with the HTTP status when gh reported one. */
export class GhApiError extends Error {
  constructor(message: string, readonly status: number | undefined) {
    super(message)
    this.name = 'GhApiError'
  }
}

/** Read gh's "(HTTP nnn)" marker from an error's stderr or message. */
export function httpStatusOf(error: unknown): number | undefined {
  const text = `${(error as { stderr?: string })?.stderr ?? ''} ${(error as Error)?.message ?? ''}`
  const match = /\(HTTP (\d{3})\)/.exec(text)
  return match ? Number(match[1]) : undefined
}

function toGhApiError(path: string, error: unknown): GhApiError {
  const status = httpStatusOf(error)
  return new GhApiError(`gh api ${path} failed${status ? ` (HTTP ${status})` : ''}`, status)
}

/** Call `gh api` and parse the JSON response; a body goes over stdin. */
export async function ghApi<T>(
  run: GhRunner,
  path: string,
  opts: { method?: 'GET' | 'POST' | 'PUT'; body?: unknown } = {}
): Promise<T> {
  const args = ['api', path]
  if (opts.method && opts.method !== 'GET') args.push('--method', opts.method)
  if (opts.body !== undefined) args.push('--input', '-')
  let stdout: string
  try {
    stdout = await run(args, opts.body !== undefined ? { input: JSON.stringify(opts.body) } : undefined)
  } catch (error) {
    throw toGhApiError(path, error)
  }
  return (stdout.trim() ? JSON.parse(stdout) : undefined) as T
}

/** Call a list endpoint across every page; returns the concatenated items. */
export async function ghApiLines<T>(run: GhRunner, path: string): Promise<T[]> {
  let stdout: string
  try {
    stdout = await run(['api', '--paginate', path, '--jq', '.[]'])
  } catch (error) {
    throw toGhApiError(path, error)
  }
  return stdout
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => JSON.parse(line) as T)
}
