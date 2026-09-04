// Pure parsing of a Slack message into the review request it implies:
// which GitHub PRs to review, and what else the user asked for.
//
// Slack does not hand you the text the user typed. It auto-links URLs into
// `<https://…>` or `<https://…|label>`, encodes user mentions as `<@U123>`,
// channel links as `<#C123|name>`, and HTML-escapes &, < and >. All of that has to
// come off before the text is usable either as a URL source or as instructions.

export interface PullRequestRef {
  owner: string
  repo: string
  number: number
  /** Canonical https://github.com/<owner>/<repo>/pull/<number> form. */
  url: string
}

export interface ParsedMessage {
  prs: PullRequestRef[]
  /** Everything the user said that was not a PR URL, normalized to plain text. */
  instructions: string
}

// github.com/<owner>/<repo>/pull/<number>, with optional trailing path (/files),
// query, or fragment that we deliberately drop when canonicalizing. Owner and repo
// use GitHub's allowed character set. The number must not be followed by a word char or a
// hyphen: `(?![\w-])` rejects a glued suffix like `/pull/12abc` or `/pull/12-3` (which would
// otherwise be read as PR 12 and point at the wrong pull request) while still accepting every
// natural terminator — end of string, `/ ? #`, and prose/markup punctuation like `, . ) > |`.
// (A bare `(?!\d)` only blocked a trailing digit, not a letter.)
const PR_URL_RE =
  /https?:\/\/(?:www\.)?github\.com\/([A-Za-z0-9][A-Za-z0-9-_.]*)\/([A-Za-z0-9][A-Za-z0-9-_.]*)\/pull\/(\d+)(?![\w-])/gi

/** Reverse Slack's HTML escaping. Only these three entities are escaped by Slack. */
export function unescapeSlack(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

/**
 * Flatten Slack's angle-bracket markup to plain text.
 *
 * `<url|label>` becomes the URL, not the label, because the label is display text
 * ("this PR") while the URL is the thing we need to parse. `<@U123>` and `<!here>`
 * are dropped entirely — they are addressing, not instructions.
 */
export function flattenSlackMarkup(text: string): string {
  return text
    .replace(/<([@#!])([^>|]*)(?:\|([^>]*))?>/g, (_m, sigil: string, _id: string, label?: string) => {
      // Channel links keep their human-readable label; user/special mentions vanish.
      if (sigil === '#') return label ? `#${label}` : ''
      return ''
    })
    .replace(/<([^>|]+)(?:\|[^>]*)?>/g, (_m, url: string) => url)
}

/** Extract PR references in first-seen order, de-duplicated by canonical URL. */
export function extractPullRequests(text: string): PullRequestRef[] {
  const seen = new Set<string>()
  const refs: PullRequestRef[] = []
  for (const match of text.matchAll(PR_URL_RE)) {
    const [, owner, rawRepo, numberText] = match
    // A trailing ".git" is legal in a clone URL but never part of the repo name in a
    // PR web URL; strip it so github.com/o/r.git/pull/1 and .../r/pull/1 dedupe.
    const repo = rawRepo.replace(/\.git$/i, '')
    const number = Number(numberText)
    const url = `https://github.com/${owner}/${repo}/pull/${number}`
    if (seen.has(url.toLowerCase())) continue
    seen.add(url.toLowerCase())
    refs.push({ owner, repo, number, url })
  }
  return refs
}

/**
 * Remove the PR URLs from the message and tidy what is left into instruction text.
 *
 * The whole URL token is removed, not just the matched prefix, so a link written as
 * `…/pull/12/files#diff-abc` does not leave `/files#diff-abc` behind as a fragment of
 * pseudo-instruction. Bare list punctuation left stranded by the removal is dropped
 * too, so "review: <url>, <url>" does not become the instruction "review: ,".
 */
export function extractInstructions(text: string): string {
  const withoutUrls = text.replace(
    /https?:\/\/(?:www\.)?github\.com\/[A-Za-z0-9][A-Za-z0-9-_.]*\/[A-Za-z0-9][A-Za-z0-9-_.]*\/pull\/\d+\S*/gi,
    ' '
  )
  return withoutUrls
    .split('\n')
    // Leading list punctuation goes (a bullet or comma left where a URL used to be),
    // but a trailing colon stays: "review these:" is the user's own phrasing, not
    // debris from the removal.
    .map(line => line.replace(/[ \t]+/g, ' ').replace(/^[\s,;:•\-*]+|[\s,;]+$/g, '').trim())
    .filter(Boolean)
    .join('\n')
    .trim()
}

/** Parse raw Slack message text into PRs plus leftover instructions. */
export function parseMessage(rawText: string): ParsedMessage {
  const text = flattenSlackMarkup(unescapeSlack(rawText || ''))
  return {
    prs: extractPullRequests(text),
    instructions: extractInstructions(text),
  }
}
