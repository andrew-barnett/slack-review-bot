// Redact secret-shaped text from raw Codex child output before it reaches any surface that
// persists or transmits it: the run-log transcript, the Slack status line, Slack error threads,
// and the daemon log. Reviews run untrusted PR code with live credentials reachable by design
// (a GitHub token, an npm/registry token, the model token, plus the daemon's Slack tokens in the
// parent environment), so a malicious install or test can simply print those credentials. This is
// the one pass every raw-output surface runs through, so a printed secret never leaves the machine
// verbatim. Issue #31.
//
// Two layers, because neither alone is enough:
//
//  1. Token SHAPES — well-known credential formats. Catches a secret even when this process does
//     not hold its value (e.g. a token belonging to a dependency's own service that a postinstall
//     script prints), which the value layer below cannot see.
//  2. Literal VALUES from the daemon's own environment. Catches a held secret whatever its shape
//     (e.g. a bespoke model key with no recognizable prefix), which the shape layer cannot match.
//
// Neither layer logs a secret: environment values are read, matched, and discarded here.

/** [pattern, placeholder] pairs for well-known credential shapes. */
const SHAPE_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  // PEM private-key blocks first: a multi-line block that could otherwise be partly matched by a
  // narrower rule. Non-greedy so adjacent blocks are redacted separately.
  [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g, '[redacted:private-key]'],
  // Slack bot/user/config tokens (xoxb-, xoxp-, xoxa-, xoxr-, xoxs-) and app-level tokens (xapp-).
  [/xox[baprs]-[A-Za-z0-9-]{6,}/g, '[redacted:slack-token]'],
  [/xapp-[A-Za-z0-9-]{6,}/g, '[redacted:slack-token]'],
  // GitHub tokens: PATs (ghp_), OAuth (gho_), user-to-server (ghu_), server-to-server (ghs_),
  // refresh (ghr_), and fine-grained PATs (github_pat_).
  [/gh[pousr]_[A-Za-z0-9]{20,}/g, '[redacted:github-token]'],
  [/github_pat_[A-Za-z0-9_]{20,}/g, '[redacted:github-token]'],
  // Anthropic keys (sk-ant-…) before the generic OpenAI sk- rule, which would otherwise claim them.
  [/sk-ant-[A-Za-z0-9_-]{20,}/g, '[redacted:anthropic-key]'],
  [/sk-(?:proj-)?[A-Za-z0-9_-]{20,}/g, '[redacted:openai-key]'],
  // AWS access key IDs (long-term AKIA, temporary ASIA): a fixed 16-char base32 tail.
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, '[redacted:aws-key-id]'],
  // npm automation/publish tokens.
  [/npm_[A-Za-z0-9]{36}/g, '[redacted:npm-token]'],
]

// Environment variable NAMES whose value is a secret worth scrubbing by literal match. Deliberately
// specific so it never matches non-secret vars whose value is long and appears in output — notably
// PATH, which `PAT` would catch. Fine-grained GitHub PATs are covered by the shape layer instead.
const SENSITIVE_ENV_NAME = /(TOKEN|SECRET|PASSWORD|CREDENTIAL|API_?KEY|ACCESS_KEY|PRIVATE_KEY)/i

// Below this length an env value is too short to be a credential and too likely to be a common
// substring (a flag, a small number) whose blanket replacement would corrupt legitimate output.
const MIN_ENV_VALUE_LENGTH = 12

/**
 * Return `text` with credential-shaped substrings and any held environment secrets masked.
 *
 * Idempotent: the placeholders it inserts match none of its own rules, so redacting already-
 * redacted text is a no-op. Safe to call at both the capture choke point and each surface's final
 * assembly, which is how a secret split across two read chunks (individually unmatched, but whole
 * once concatenated in the transcript) is still caught before it reaches an off-machine surface.
 */
export function redactSecrets(text: string, env: NodeJS.ProcessEnv = process.env): string {
  if (!text) return text
  let out = text
  for (const [pattern, placeholder] of SHAPE_PATTERNS) {
    out = out.replace(pattern, placeholder)
  }
  // Literal-value layer: replace the exact value of each held secret. split/join avoids having to
  // escape regex metacharacters in the value, and never touches the value beyond matching it.
  for (const name of Object.keys(env)) {
    const value = env[name]
    if (!value || value.length < MIN_ENV_VALUE_LENGTH) continue
    if (!SENSITIVE_ENV_NAME.test(name)) continue
    if (out.includes(value)) out = out.split(value).join('[redacted:env]')
  }
  return out
}

const PEM_BEGIN = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/g
const PEM_END = /-----END [A-Z0-9 ]*PRIVATE KEY-----/

/**
 * How much of a streaming output buffer is safe to redact and publish now, so that redaction never
 * runs on a fragment of a secret that is still arriving. A secret never spans a line, so this is
 * "up to the last newline" — except a PEM private-key block, which does span lines: while a
 * `BEGIN … PRIVATE KEY` marker has no matching `END` yet, hold everything from that marker on, so
 * the whole block is redacted together once its `END` arrives.
 *
 * Returns a cut length in [0, buf.length]. 0 means nothing is safe yet (a partial first line, or an
 * open key block from the start) — the caller holds the whole buffer, flushing it only when it must
 * bound memory or the stream closes. Callers still run {@link redactSecrets} on whatever they cut.
 */
export function safeRedactBoundary(buf: string): number {
  let end = buf.lastIndexOf('\n') + 1
  if (end === 0) return 0
  const region = buf.slice(0, end)
  PEM_BEGIN.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = PEM_BEGIN.exec(region)) !== null) {
    // The first BEGIN with no END after it opens a block that is still arriving: hold from here.
    if (!PEM_END.test(region.slice(match.index))) return match.index
  }
  return end
}
