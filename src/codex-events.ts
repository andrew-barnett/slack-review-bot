// Reading `codex exec --json` (codex-cli 0.169.0). Stdout is one JSON event per line: thread.started,
// turn.started, item.started / item.completed (agent messages, commands and other items) and
// turn.completed, whose `usage` is the source of truth for what a run cost (spec 6). Two readers share
// the line format: the usage reader sums every turn.completed on the raw stdout, and the progress
// filter turns events into the human status lines the status reply shows (ruling 10).

import { addCodexUsage, type CodexUsageDetail } from './usage'

/** Longest line held while waiting for its newline; Codex events are far smaller. */
export const CODEX_EVENT_LINE_LIMIT = 8 * 1024 * 1024

/** A finite, non-negative count, or 0. */
const count = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0)

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}

/** One turn.completed `usage` object as a CodexUsageDetail; absent or malformed fields read as 0. */
export function turnUsage(value: unknown): CodexUsageDetail {
  const u = asRecord(value)
  return {
    inputTokens: count(u.input_tokens),
    cachedInputTokens: count(u.cached_input_tokens),
    cacheWriteTokens: count(u.cache_write_input_tokens),
    outputTokens: count(u.output_tokens),
    reasoningTokens: count(u.reasoning_output_tokens),
  }
}

/** Parse one line as a JSON event object, or undefined. */
function parseEvent(line: string): Record<string, unknown> | undefined {
  const trimmed = line.trim()
  if (!trimmed.startsWith('{')) return undefined
  try {
    const value = JSON.parse(trimmed) as unknown
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

/**
 * Sums the usage of every turn.completed event on Codex's raw stdout. Lines are split on newlines across
 * chunks, so an event that straddles two pipe reads still counts. Only the numbers are kept.
 */
export function createCodexUsageReader(lineLimit: number = CODEX_EVENT_LINE_LIMIT): {
  push(text: string): void
  flush(): void
  usage(): CodexUsageDetail | undefined
} {
  let partial = ''
  let overflowed = false
  let total: CodexUsageDetail | undefined
  const take = (line: string) => {
    if (!line.includes('turn.completed')) return
    const event = parseEvent(line)
    if (event?.type === 'turn.completed') total = addCodexUsage(total, turnUsage(event.usage))
  }
  return {
    push(text) {
      const pieces = (partial + text).split('\n')
      partial = pieces.pop() ?? ''
      for (const piece of pieces) {
        if (overflowed) {
          // The rest of an over-long line; drop it and resume at the next line.
          overflowed = false
          continue
        }
        take(piece)
      }
      if (partial.length > lineLimit) {
        partial = ''
        overflowed = true
      }
    },
    flush() {
      if (!overflowed && partial) take(partial)
      partial = ''
      overflowed = false
    },
    usage: () => total,
  }
}

/** The human status line for one event: an agent message's text or a command; undefined for anything else. */
export function codexProgressLine(event: Record<string, unknown>): string | undefined {
  if (event.type !== 'item.started' && event.type !== 'item.completed') return undefined
  const item = asRecord(event.item)
  if (item.type === 'agent_message' && typeof item.text === 'string') return item.text
  if (item.type === 'command_execution' && typeof item.command === 'string') return item.command
  return undefined
}

/**
 * Wrap a progress sink so it receives human lines instead of raw JSON events. `span` is output the
 * supervisor has already redacted (stdout and stderr interleaved). A JSON line becomes the line
 * codexProgressLine gives, or nothing; a line that is not JSON passes through as before --json; a line
 * that starts with `{` but does not parse is never shown. An unfinished JSON line is held until its
 * newline arrives. Called once per span with every shown line, or not at all.
 */
export function codexProgressFilter(
  sink: (line: string, activeMs: number) => void,
  lineLimit: number = CODEX_EVENT_LINE_LIMIT
): (span: string, activeMs: number) => void {
  let partial = ''
  return (span, activeMs) => {
    const pieces = (partial + span).split('\n')
    const last = pieces.pop() ?? ''
    partial = ''
    if (last.trimStart().startsWith('{') && last.length <= lineLimit) {
      // A JSON event in flight: wait for the rest of it.
      partial = last
    } else if (last) {
      pieces.push(last)
    }
    const shown: string[] = []
    for (const piece of pieces) {
      if (!piece.trim()) continue
      const event = parseEvent(piece)
      if (event) {
        const line = codexProgressLine(event)
        if (line) shown.push(line)
        continue
      }
      if (piece.trimStart().startsWith('{')) continue
      shown.push(piece)
    }
    if (shown.length) sink(shown.join('\n'), activeMs)
  }
}

/**
 * The readable tail of a Codex transcript, for the error text posted to Slack: each JSON event as its
 * codexProgressLine (or nothing), plus any non-JSON lines, then the last `limit` characters. Raw JSONL is
 * never included. The transcript is a bounded tail, so its first line may be the end of a cut-off event;
 * any line still carrying an event's `{"type":` marker is dropped.
 */
export function codexReadableTail(transcript: string, limit = 1500): string {
  const lines: string[] = []
  codexProgressFilter(line => lines.push(line))(`${transcript}\n`, 0)
  return lines
    .join('\n')
    .split('\n')
    .filter(line => !line.includes('{"type":'))
    .join('\n')
    .slice(-limit)
    .trim()
}
