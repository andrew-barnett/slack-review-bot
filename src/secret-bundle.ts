// Secret delivery over stdin (spec 3.6.1). The launcher writes one JSON line to each container's
// stdin; the entrypoint reads it, closes stdin, and holds the values in memory. Neither `-e` (readable
// with `docker inspect`, stored on the Docker VM's disk) nor Compose `secrets:` (copied into the
// container's filesystem) is used. No error here ever includes a value.

export const BUNDLE_MAX_BYTES = 64 * 1024
export const BUNDLE_TIMEOUT_MS = 10_000

export interface BundleSpec {
  required: readonly string[]
  optional?: readonly string[]
}

export const ORCHESTRATOR_BUNDLE: BundleSpec = {
  required: ['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN', 'APPROVER_GH_TOKEN', 'LAUNCH_KEY'],
}

const WORKER_CREDENTIALS = ['ENGINE_GH_TOKEN', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'NPM_TOKEN'] as const

/** The worker's bundle. It never contains LAUNCH_KEY (spec 3.4). */
export const WORKER_BUNDLE: BundleSpec = { required: [...WORKER_CREDENTIALS, 'WORKER_TICKET'] }

/** `doctor --role worker` gets the same credentials; it claims nothing, so the ticket is optional. */
export const WORKER_DOCTOR_BUNDLE: BundleSpec = { required: [...WORKER_CREDENTIALS], optional: ['WORKER_TICKET'] }

export function encodeSecretBundle(values: Record<string, string>): string {
  // JSON.stringify escapes newlines inside strings, so the result is exactly one line.
  return `${JSON.stringify(values)}\n`
}

export function parseSecretBundle(line: string, spec: BundleSpec): Record<string, string> {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    throw new Error('the secret bundle is not valid JSON')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('the secret bundle is not a JSON object')
  const allowed = new Set([...spec.required, ...(spec.optional ?? [])])
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    // Key names are the launcher's own constants, never secrets, so naming one is safe.
    if (!allowed.has(key)) throw new Error(`the secret bundle has an unexpected key ${JSON.stringify(key.slice(0, 64))}`)
    if (typeof value !== 'string' || !value) throw new Error(`the secret bundle's ${key} is not a non-empty string`)
    out[key] = value
  }
  for (const key of spec.required) {
    if (!(key in out)) throw new Error(`the secret bundle is missing ${key}`)
  }
  return out
}

export function readSecretBundle(
  stream: NodeJS.ReadableStream,
  spec: BundleSpec,
  options: { maxBytes?: number; timeoutMs?: number } = {}
): Promise<Record<string, string>> {
  const maxBytes = options.maxBytes ?? BUNDLE_MAX_BYTES
  const timeoutMs = options.timeoutMs ?? BUNDLE_TIMEOUT_MS
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0)
    let done = false
    const finish = (error: Error | undefined, line?: string) => {
      if (done) return
      done = true
      clearTimeout(timer)
      stream.removeListener('data', onData)
      stream.removeListener('end', onEnd)
      stream.removeListener('error', onError)
      // Close stdin: nothing more is read from it for the life of the process.
      ;(stream as unknown as { destroy?: () => void }).destroy?.()
      if (error) return reject(error)
      try {
        resolve(parseSecretBundle(line ?? '', spec))
      } catch (parseError) {
        reject(parseError as Error)
      }
    }
    const tooBig = () => new Error(`the secret bundle is larger than ${maxBytes} bytes`)
    const onData = (chunk: Buffer | string) => {
      buffer = Buffer.concat([buffer, typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk])
      const newline = buffer.indexOf(0x0a)
      if (newline >= 0) return newline > maxBytes ? finish(tooBig()) : finish(undefined, buffer.subarray(0, newline).toString('utf8'))
      if (buffer.length > maxBytes) finish(tooBig())
    }
    const onEnd = () => {
      if (!buffer.length) return finish(new Error('stdin closed before a secret bundle arrived'))
      return buffer.length > maxBytes ? finish(tooBig()) : finish(undefined, buffer.toString('utf8'))
    }
    const onError = (error: Error) => finish(new Error(`reading the secret bundle failed: ${error.message}`))
    const timer = setTimeout(() => finish(new Error(`no secret bundle arrived on stdin within ${timeoutMs} ms`)), timeoutMs)
    stream.on('data', onData)
    stream.on('end', onEnd)
    stream.on('error', onError)
  })
}
