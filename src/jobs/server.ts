// HTTP/1.1 adapter for the job broker (spec 3.3). Listens on the internal `jobs` Compose network; the
// orchestrator publishes no ports. Every route but /healthz needs a ticket or a job token, and every
// body is read under a size cap before it is parsed.

import * as http from 'http'
import type { BrokerReply, JobBroker } from './broker'
import { serializeRunError } from './errors'
import { JSON_BODY_LIMIT } from './protocol'

/** Progress and heartbeat bodies are tiny. */
const CONTROL_BODY_LIMIT = 64 * 1024
const JOB_PATH = /^\/v1\/jobs\/([A-Za-z0-9]{1,64})\/(progress|heartbeat|result|log)$/

export interface JobServerOptions {
  broker: JobBroker
  /** SMOKE=1 only: POST /v1/smoke/submit runs one canned job. Absent means the route does not exist. */
  smoke?: () => Promise<unknown>
  log?: (event: string, fields: Record<string, unknown>) => void
}

function send(res: http.ServerResponse, reply: BrokerReply): void {
  if (res.writableEnded || res.destroyed) return
  if (reply.body === undefined) {
    res.writeHead(reply.status)
    res.end()
    return
  }
  const text = JSON.stringify(reply.body)
  res.writeHead(reply.status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) })
  res.end(text)
}

/** The body, or null as soon as it exceeds `limit` (the rest is never buffered). */
function readBody(req: http.IncomingMessage, limit: number): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    let over = false
    req.on('data', (chunk: Buffer) => {
      if (over) return
      size += chunk.length
      if (size > limit) {
        over = true
        chunks.length = 0
        resolve(null)
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (!over) resolve(Buffer.concat(chunks))
    })
    req.on('error', reject)
  })
}

function credential(req: http.IncomingMessage, scheme: 'Ticket' | 'Job'): string | undefined {
  const header = req.headers.authorization
  if (typeof header !== 'string' || !header.startsWith(`${scheme} `)) return undefined
  return header.slice(scheme.length + 1).trim() || undefined
}

const NOT_JSON = Symbol('not json')
function parseJson(body: Buffer): unknown {
  try {
    return JSON.parse(body.toString('utf8'))
  } catch {
    return NOT_JSON
  }
}

export function createJobRequestHandler(options: JobServerOptions): http.RequestListener {
  const { broker } = options
  const log = options.log ?? (() => {})

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = (req.url ?? '').split('?')[0]
    if (req.method === 'GET' && url === '/healthz') {
      req.resume()
      return send(res, { status: 200, body: { ok: true } })
    }
    if (req.method !== 'POST') {
      req.resume()
      return send(res, { status: 405, body: { error: 'method not allowed' } })
    }
    if (url === '/v1/claim') {
      req.resume()
      const ticket = credential(req, 'Ticket')
      if (!ticket) return send(res, { status: 403, body: { error: 'missing ticket' } })
      // A worker that hangs up mid long-poll must not leave a waiter behind (Review Focus 2).
      const abort = new AbortController()
      res.on('close', () => {
        if (!res.writableFinished) abort.abort()
      })
      return send(res, await broker.claim(ticket, abort.signal))
    }
    if (url === '/v1/smoke/submit' && options.smoke) {
      req.resume()
      try {
        return send(res, { status: 200, body: await options.smoke() })
      } catch (error) {
        return send(res, { status: 500, body: { error: serializeRunError(error) } })
      }
    }
    const match = JOB_PATH.exec(url)
    if (!match) {
      req.resume()
      return send(res, { status: 404, body: { error: 'not found' } })
    }
    const [, id, action] = match
    const token = credential(req, 'Job')
    if (!token) {
      req.resume()
      return send(res, { status: 403, body: { error: 'missing job token' } })
    }
    const limit = action === 'log' ? broker.limits.logChunk : action === 'result' ? JSON_BODY_LIMIT : CONTROL_BODY_LIMIT
    const body = await readBody(req, limit)
    if (body === null) {
      res.setHeader('connection', 'close')
      res.on('finish', () => req.destroy())
      return send(res, { status: 413, body: { error: 'body too large' } })
    }
    if (action === 'log') return send(res, broker.appendLog(id, token, body))
    if (action === 'heartbeat') return send(res, broker.heartbeat(id, token))
    const parsed = parseJson(body)
    if (parsed === NOT_JSON) return send(res, { status: 400, body: { error: 'body is not JSON' } })
    return send(res, action === 'progress' ? broker.progress(id, token, parsed) : broker.result(id, token, parsed))
  }

  return (req, res) => {
    handle(req, res).catch(error => {
      log('jobs.http_error', { error: String(error) })
      send(res, { status: 500, body: { error: 'internal error' } })
    })
  }
}

export function startJobServer(options: JobServerOptions & { port: number; host: string }): Promise<http.Server> {
  const server = http.createServer(createJobRequestHandler(options))
  server.headersTimeout = 60_000
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port, options.host, () => {
      server.off('error', reject)
      resolve(server)
    })
  })
}
