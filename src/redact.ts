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
  // An UNTERMINATED key block: a BEGIN whose END has not arrived. The streaming redactor suppresses
  // open blocks line by line, so this rule is the backstop for the non-streaming callers of
  // redactSecrets — the error-tail redaction of a transcript that ends mid-key, and the over-long
  // single-line-with-a-BEGIN case in the redactor's cap path. Runs after the terminated rule above,
  // so any BEGIN left here is genuinely open; redact it through end-of-text.
  [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*$/g, '[redacted:private-key]'],
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
    // A multiline secret (e.g. a private key held in an env var) is published one line at a time by
    // the streaming redactor, so the whole value never appears in a single span. Match the whole
    // value AND each of its lines, longest first, so a surfaced fragment is masked too.
    const needles = [value, ...value.split(/\r?\n/)]
      .filter(n => n.length >= MIN_ENV_VALUE_LENGTH)
      .sort((a, b) => b.length - a.length)
    for (const needle of needles) {
      if (out.includes(needle)) out = out.split(needle).join('[redacted:env]')
    }
  }
  return out
}

/**
 * Cap on the streaming redactor's hold buffer. Output is normally published at each line boundary;
 * this only forces progress when a single line (or a suppressed key body) grows past it, so a run
 * that never emits a newline cannot grow the buffer without limit.
 */
export const OUTPUT_FLUSH_LIMIT = 64 * 1024

const KEY_BEGIN_LINE = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/
const KEY_END_LINE = /-----END [A-Z0-9 ]*PRIVATE KEY-----/

/** Whether `s` contains a BEGIN PRIVATE KEY marker with no matching END after the last one. */
function hasOpenPrivateKeyBegin(s: string): boolean {
  const all = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/g
  let match: RegExpExecArray | null
  let open = false
  while ((match = all.exec(s)) !== null) {
    open = !KEY_END_LINE.test(s.slice(match.index))
  }
  return open
}

/** A stateful redactor for one output stream: feed raw chunks, get back safe-to-publish text. */
export interface OutputRedactor {
  /** Feed a raw chunk; returns redacted text safe to publish now (may be empty while buffering). */
  push(text: string): string
  /** Flush the buffered tail at end of stream; returns the final redacted text. */
  flush(): string
}

/**
 * A streaming redactor that is correct across chunk boundaries, which stateless per-chunk redaction
 * is not. It processes output a line at a time (a single-line secret is always whole within a line)
 * and carries key-block state ACROSS chunks: once a `BEGIN … PRIVATE KEY` line is seen, every
 * following line is suppressed until the matching `END`, however many chunks or bytes that spans, so
 * an over-long or chunk-split key can never leak its body. One redactor per stream (stdout, stderr)
 * keeps each stream's lines contiguous, so the other stream cannot splice bytes into a token.
 *
 * A line longer than the cap has no safe cut (a cut inside a token would orphan one half), so such a
 * line is dropped behind a notice — and, if it opened a key block, the block state is entered so the
 * body is suppressed too. Over-long single lines are not normal Codex output.
 */
export function createOutputRedactor(env: NodeJS.ProcessEnv = process.env): OutputRedactor {
  let pending = '' // raw output not yet safe to publish: a partial line, or a suppressed key body
  let inKeyBlock = false // between a BEGIN and END PRIVATE KEY line, tracked across chunks
  // Discarding the rest of an over-long non-key line: set when the cap drops such a line, so the
  // remainder — which may carry the tail of a credential whose head was dropped — is discarded too,
  // through its terminating newline, rather than published prefix-less.
  let droppingLine = false

  const emitLine = (line: string): string => {
    if (inKeyBlock) {
      if (KEY_END_LINE.test(line)) inKeyBlock = false
      return '' // suppress every line of the block; BEGIN already emitted the one placeholder
    }
    if (KEY_BEGIN_LINE.test(line)) {
      if (KEY_END_LINE.test(line)) return redactSecrets(line, env) // whole block on a single line
      inKeyBlock = true
      return '[redacted:private-key]\n'
    }
    return redactSecrets(line, env)
  }

  const drainLines = (): string => {
    let out = ''
    let nl = pending.indexOf('\n')
    while (nl !== -1) {
      out += emitLine(pending.slice(0, nl + 1))
      pending = pending.slice(nl + 1)
      nl = pending.indexOf('\n')
    }
    return out
  }

  return {
    push(text) {
      pending += text
      let out = ''
      // Finish discarding a dropped over-long line: swallow everything up to and including its next
      // newline before any normal processing resumes.
      if (droppingLine) {
        const nl = pending.indexOf('\n')
        if (nl === -1) {
          pending = ''
          return ''
        }
        pending = pending.slice(nl + 1)
        droppingLine = false
      }
      out += drainLines()
      if (pending.length >= OUTPUT_FLUSH_LIMIT) {
        if (inKeyBlock) {
          pending = '' // suppressed key body with no newline in sight: keep nothing
        } else if (hasOpenPrivateKeyBegin(pending)) {
          // The over-long line opened a key block (a BEGIN with no END yet). Enter the block so
          // every following line is suppressed until END — the marker itself will not survive the
          // drop, so remembering the state here is what prevents the body leaking afterwards.
          inKeyBlock = true
          out += '[redacted:private-key]\n'
          pending = ''
        } else {
          // An over-long non-key line with no newline. There is no cut that can redact a partial
          // credential safely (a cut inside a token orphans one half), and an over-long single line
          // is not normal Codex output, so drop it behind a notice and keep dropping until it ends.
          out += '[redacted:over-long output line]\n'
          droppingLine = true
          pending = ''
        }
      }
      return out
    },
    flush() {
      let out = ''
      if (!droppingLine) {
        out += drainLines()
        if (pending && !inKeyBlock) out += redactSecrets(pending, env)
      }
      pending = ''
      inKeyBlock = false
      droppingLine = false
      return out
    },
  }
}
