// The contract between Codex and the bot.
//
// The bot has to decide, mechanically, whether to react :approved_stamp: or :comments:.
// Scraping that out of a prose summary is brittle, so instead we hand Codex a JSON
// Schema via `codex exec --output-schema` and it emits a structured final message.
//
// Every property is listed in `required` and every object sets additionalProperties:
// false, because structured-output enforcement rejects schemas that do not. Optional
// values are modelled as required-but-possibly-empty strings rather than omitted keys.

/** Outcome for one PR. */
export type ReviewStatus =
  /** Reviewed end to end, no actionable findings remain. */
  | 'passed'
  /** Reviewed, actionable findings exist. */
  | 'findings'
  /** Could not be reviewed to a verdict (stale base that would not merge cleanly,
   *  missing issue reference on an in-scope repo, inaccessible PR, ...). */
  | 'blocked'

export interface PullRequestResult {
  url: string
  status: ReviewStatus
  /** One sentence or shorter. Empty is acceptable for `passed`. */
  summary: string
  /** True when the review pushed regression-test commits to the PR branch. */
  pushedTestCommits: boolean
  /** Link to the posted GitHub review/comment, or '' when nothing was posted. */
  reviewUrl: string
}

export interface ReviewRunResult {
  results: PullRequestResult[]
}

export const REVIEW_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['results'],
  properties: {
    results: {
      type: 'array',
      description: 'One entry per pull request that was requested, in the order requested.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['url', 'status', 'summary', 'pushedTestCommits', 'reviewUrl'],
        properties: {
          url: {
            type: 'string',
            description: 'The canonical https://github.com/<owner>/<repo>/pull/<number> URL exactly as it was given to you.',
          },
          status: {
            type: 'string',
            enum: ['passed', 'findings', 'blocked'],
            description:
              "'passed' = reviewed with no actionable findings. 'findings' = reviewed and actionable findings exist. 'blocked' = could not be reviewed to a verdict.",
          },
          summary: {
            type: 'string',
            description:
              "One sentence or shorter summarising the findings, or the reason it was blocked. Empty string when status is 'passed'.",
          },
          pushedTestCommits: {
            type: 'boolean',
            description: 'True if regression-test commits were pushed to this PR branch.',
          },
          reviewUrl: {
            type: 'string',
            description: 'URL of the GitHub review or comment that was posted, or an empty string if nothing was posted.',
          },
        },
      },
    },
  },
} as const

const STATUSES: ReadonlySet<string> = new Set<ReviewStatus>(['passed', 'findings', 'blocked'])

/**
 * Validate Codex's final message into a ReviewRunResult.
 *
 * Structured output makes a malformed payload unlikely but not impossible — the run
 * can end early, or the model can emit the JSON wrapped in prose. Everything that
 * fails here is surfaced to Slack as a run error rather than being coerced into a
 * pass, so a broken run can never be mistaken for a clean review.
 */
export function parseReviewResult(raw: string): ReviewRunResult {
  const text = stripCodeFence(raw.trim())
  if (!text) throw new Error('Codex returned an empty final message')

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new Error(`Codex final message is not valid JSON: ${(error as Error).message}`)
  }

  const root = parsed as { results?: unknown }
  if (!root || typeof root !== 'object' || !Array.isArray(root.results)) {
    throw new Error('Codex final message has no "results" array')
  }

  const results = root.results.map((entry, index) => validateResult(entry, index))
  return { results }
}

function validateResult(entry: unknown, index: number): PullRequestResult {
  const where = `results[${index}]`
  if (!entry || typeof entry !== 'object') throw new Error(`${where} is not an object`)
  const item = entry as Record<string, unknown>

  if (typeof item.url !== 'string' || !item.url) throw new Error(`${where}.url is missing`)
  if (typeof item.status !== 'string' || !STATUSES.has(item.status)) {
    throw new Error(`${where}.status is not one of passed/findings/blocked (got ${JSON.stringify(item.status)})`)
  }
  // Every field is `required` in REVIEW_OUTPUT_SCHEMA, so a missing one means the output did not
  // match the contract — a truncated or malformed result. Enforce the required fields rather than
  // defaulting them: coercing a missing `pushedTestCommits` to false, say, could quietly claim no
  // test commits were pushed when the run's real result was lost. (An empty `summary`/`reviewUrl`
  // string is allowed — the schema permits those — but the key must be present and the right type.)
  if (typeof item.summary !== 'string') throw new Error(`${where}.summary is missing or not a string`)
  if (typeof item.pushedTestCommits !== 'boolean') {
    throw new Error(`${where}.pushedTestCommits is missing or not a boolean`)
  }
  if (typeof item.reviewUrl !== 'string') throw new Error(`${where}.reviewUrl is missing or not a string`)

  return {
    url: item.url,
    status: item.status as ReviewStatus,
    summary: item.summary.trim(),
    pushedTestCommits: item.pushedTestCommits,
    reviewUrl: item.reviewUrl,
  }
}

/**
 * Force the result set to cover exactly the PRs that were requested.
 *
 * The prompt asks for one entry per PR, but a model that runs long, loses track of a
 * batch, or decides two URLs are "the same PR" can return fewer. A dropped PR would
 * otherwise vanish: it appears in no thread section at all, and if the entries that did
 * come back all passed, the message gets :approved_stamp: — silently claiming a clean
 * review of a PR that was never looked at. Missing entries become `blocked` instead.
 *
 * Entries Codex returned for URLs nobody asked about are kept, so a genuine mismatch
 * shows up in the thread rather than being quietly discarded.
 */
export function reconcileResults(requestedUrls: string[], result: ReviewRunResult): ReviewRunResult {
  const byUrl = new Map(result.results.map(entry => [entry.url.toLowerCase(), entry]))
  const reconciled: PullRequestResult[] = requestedUrls.map(url => {
    const found = byUrl.get(url.toLowerCase())
    if (found) return { ...found, url }
    return {
      url,
      status: 'blocked',
      summary: 'Codex did not report a result for this pull request.',
      pushedTestCommits: false,
      reviewUrl: '',
    }
  })

  const requested = new Set(requestedUrls.map(url => url.toLowerCase()))
  for (const entry of result.results) {
    if (!requested.has(entry.url.toLowerCase())) reconciled.push(entry)
  }

  return { results: reconciled }
}

/** Tolerate a ```json fenced payload, which models emit even under structured output. */
function stripCodeFence(text: string): string {
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n?```$/.exec(text)
  return fenced ? fenced[1].trim() : text
}
