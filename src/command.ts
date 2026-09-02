// Typo-tolerant command matching.
//
// People misspell `status` as `staus`, `health` as `helth`, `ping` as `pign`. Requiring an
// exact word means those mentions fall through to the help reply, which is safe but not what
// they meant. So a word is matched to a command when it is within a small edit distance —
// with one guard: it must be close to *exactly one* command. A word near two commands (a
// `healp` that could be `help` or `health`) is genuinely ambiguous, so the bot does not guess
// and lets it fall through to help, which lists the real commands.

export type CommandAction = 'status' | 'help'

interface Command {
  word: string
  action: CommandAction
}

/** The commands the bot understands. `health` and `ping` are aliases for `status`. */
export const COMMANDS: Command[] = [
  { word: 'help', action: 'help' },
  { word: 'status', action: 'status' },
  { word: 'health', action: 'status' },
  { word: 'ping', action: 'status' },
]

/**
 * Optimal string alignment distance (restricted Damerau-Levenshtein): like Levenshtein but
 * an adjacent transposition costs 1, since swapping two letters (`pign` for `ping`) is one of
 * the most common typos and Levenshtein would charge it as two edits.
 */
export function editDistance(a: string, b: string): number {
  const m = a.length
  const n = b.length
  if (m === 0) return n
  if (n === 0) return m

  const d: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0))
  for (let i = 0; i <= m; i += 1) d[i][0] = i
  for (let j = 0; j <= n; j += 1) d[0][j] = j

  for (let i = 1; i <= m; i += 1) {
    for (let j = 1; j <= n; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost)
      // Adjacent transposition.
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1)
      }
    }
  }
  return d[m][n]
}

/**
 * How far a word may stray from a command and still count. Shorter commands get a tighter
 * budget: at distance 2 a four-letter word like `ping` or `help` is barely itself anymore,
 * and the looser budget is where false matches to common English words creep in.
 */
function tolerance(command: string): number {
  return command.length <= 4 ? 1 : 2
}

/**
 * The command a single word denotes, or null if it matches none — or is close to more than
 * one, which is treated as no match rather than a guess.
 */
export function matchCommandWord(word: string): Command | null {
  const lower = word.toLowerCase()
  const hits = COMMANDS.filter(command => editDistance(lower, command.word) <= tolerance(command.word))
  return hits.length === 1 ? hits[0] : null
}

/**
 * Split a message into candidate command words, dropping Slack markup (`<@U…>` mentions,
 * `<http…>` links, `<#C…>` channel refs) and anything that is not plain letters.
 */
function words(text: string): string[] {
  return text
    .replace(/<[^>]*>/g, ' ')
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter(word => word.length >= 2)
}

/**
 * The action a mention asks for — `status` (from `status`/`health`/`ping` or a near miss) or
 * `help` (from `help` or a near miss) — or null when nothing in the text resolves to a single
 * command. The first word that resolves wins; an ambiguous word is skipped, not guessed.
 */
export function resolveMentionCommand(text: string): CommandAction | null {
  for (const word of words(text)) {
    const command = matchCommandWord(word)
    if (command) return command.action
  }
  return null
}
