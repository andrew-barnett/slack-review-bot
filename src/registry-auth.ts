// Refreshes the AWS CodeArtifact npm token before a review, so the sandboxed `npm ci` reads a
// live token instead of the stale one a days-old daemon would otherwise carry (issue #42).
//
// Platform repos install `@trade-platform/*` from AWS CodeArtifact, whose auth tokens live at
// most 12 hours. The token is minted by the repos' `login.sh` and written to the user npmrc.
// The bot runs a vendored copy of that script (`scripts/codeartifact-login.sh -u`) before each
// review; the script self-caches by expiry, so it is a cheap no-op until the token expires.

import { execFile } from 'node:child_process'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/** Run a command and resolve with its output, or reject with an error carrying `.code`. */
export type Exec = (file: string, args: string[]) => Promise<{ stdout: string; stderr: string }>

const defaultExec: Exec = (file, args) => execFileAsync(file, args, { timeout: 60_000 })

/**
 * Absolute path to the vendored CodeArtifact login script.
 *
 * At runtime this module is bundled into `dist/app.js`, so `__dirname` is `dist/`; the script
 * lives at `<repo>/scripts/codeartifact-login.sh`, one level up. Resolving it relative to this
 * module keeps the bot self-contained — it never reaches into a sibling checkout.
 */
export function defaultLoginScriptPath(): string {
  return path.resolve(__dirname, '..', 'scripts', 'codeartifact-login.sh')
}

export interface RegistryAuthOptions {
  /** Absolute path to the login script. */
  scriptPath: string
  /** Operator kill switch. When false, this is a no-op. */
  enabled: boolean
  /** Daemon log, for the refresh event. Optional (the CLI may pass nothing). */
  log?: (event: string, fields: Record<string, unknown>) => void
  /** Injection seam for the subprocess, so tests need not spawn a shell. */
  exec?: Exec
}

/**
 * Refresh the CodeArtifact token, best-effort.
 *
 * A failure is logged and swallowed, never thrown: an expired or unrefreshable token only means
 * `npm ci` fails exactly as it does without this step, and the review still produces findings —
 * so a refresh that cannot run must never abort the review.
 *
 * Security: the script mints the token and writes it to the user npmrc itself; it never prints
 * the token. This function discards the script's stdout and, on failure, logs only the process
 * exit code — never the captured stdout/stderr, which the daemon log does not run through the
 * output redactor.
 */
export async function ensureRegistryAuth(options: RegistryAuthOptions): Promise<void> {
  const { scriptPath, enabled, log } = options
  if (!enabled) return
  const exec = options.exec ?? defaultExec
  try {
    await exec('bash', [scriptPath, '-u'])
    log?.('codeartifact.refreshed', {})
  } catch (error) {
    const code = (error as { code?: unknown }).code
    log?.('codeartifact.refresh-failed', {
      exitCode: typeof code === 'number' ? code : undefined,
    })
  }
}
