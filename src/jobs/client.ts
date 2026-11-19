// The worker's side of the job protocol (spec 3.3): one claim with the ticket, then every call for
// the job with its job token. Each call is time-bounded so a wedged orchestrator cannot hang a worker.

import { CLAIM_WAIT_MS, parseClaimReply, type ClaimReply, type ProgressBody, type ResultBody } from './protocol'

export type ClaimOutcome = { status: 200; job: ClaimReply } | { status: number; job?: undefined }

export interface JobClient {
  claim(ticket: string): Promise<ClaimOutcome>
  progress(job: ClaimReply, body: ProgressBody): Promise<number>
  heartbeat(job: ClaimReply): Promise<number>
  result(job: ClaimReply, body: ResultBody): Promise<number>
  log(job: ClaimReply, chunk: Buffer): Promise<number>
}

const CALL_TIMEOUT_MS = 15_000
const RESULT_TIMEOUT_MS = 60_000

export function makeJobClient(baseUrl: string, fetchImpl: typeof fetch = fetch): JobClient {
  const call = (route: string, authorization: string, body: string | Buffer | undefined, timeoutMs: number) =>
    fetchImpl(new URL(route, baseUrl), {
      method: 'POST',
      headers: {
        authorization,
        ...(body === undefined ? {} : { 'content-type': typeof body === 'string' ? 'application/json' : 'application/octet-stream' }),
      },
      body,
      signal: AbortSignal.timeout(timeoutMs),
    })
  /** Drain the body so the connection can be reused, and return the status. */
  const status = async (res: Response): Promise<number> => {
    await res.arrayBuffer().catch(() => undefined)
    return res.status
  }
  const jobRoute = (job: ClaimReply, action: string) => `/v1/jobs/${job.jobId}/${action}`
  const auth = (job: ClaimReply) => `Job ${job.jobToken}`
  return {
    async claim(ticket) {
      const res = await call('/v1/claim', `Ticket ${ticket}`, undefined, CLAIM_WAIT_MS + 10_000)
      if (res.status !== 200) return { status: await status(res) }
      return { status: 200, job: parseClaimReply(await res.json()) }
    },
    progress: async (job, body) => status(await call(jobRoute(job, 'progress'), auth(job), JSON.stringify(body), CALL_TIMEOUT_MS)),
    heartbeat: async job => status(await call(jobRoute(job, 'heartbeat'), auth(job), '{}', CALL_TIMEOUT_MS)),
    result: async (job, body) => status(await call(jobRoute(job, 'result'), auth(job), JSON.stringify(body), RESULT_TIMEOUT_MS)),
    log: async (job, chunk) => status(await call(jobRoute(job, 'log'), auth(job), chunk, CALL_TIMEOUT_MS)),
  }
}
