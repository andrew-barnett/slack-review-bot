// A pure CODEOWNERS parser and matcher, following GitHub's documented syntax (not full
// gitignore): last match wins; a leading or middle slash anchors to the root; a trailing slash
// matches a directory and everything under it; a wildcard in the last segment matches direct
// children only; \# escapes, ! negation and [] ranges are unsupported and never match.

export interface CodeownersRule {
  pattern: string
  owners: string[]
  line: number
  supported: boolean
  /** Compiled matcher; null for unsupported syntax. Not exported in the interface contract. */
  regex?: RegExp | null
}

const escapeRe = (s: string) => s.replace(/[.+^${}()|\\]/g, '\\$&')

function globToRegex(glob: string): string {
  let out = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '*') {
      if (glob[i + 1] === '*') {
        if (glob[i + 2] === '/') {
          // "**/" matches zero or more leading directories.
          out += '(?:.*/)?'
          i += 2
        } else {
          // A trailing "**" matches anything, slashes included.
          out += '.*'
          i += 1
        }
      } else {
        out += '[^/]*'
      }
    } else if (c === '?') {
      out += '[^/]'
    } else {
      out += escapeRe(c)
    }
  }
  return out
}

function compile(pattern: string): RegExp {
  const anchored = pattern.startsWith('/') || pattern.slice(0, -1).includes('/')
  let body = pattern.replace(/^\//, '')
  const dirOnly = body.endsWith('/')
  if (dirOnly) body = body.slice(0, -1)
  const lastSegment = body.split('/').pop() ?? ''
  const lastHasWildcard = /[*?]/.test(lastSegment) && lastSegment !== '**'
  const prefix = anchored ? '^' : '^(?:.*/)?'
  // A directory pattern needs something beneath it; a plain name also covers everything beneath
  // it; a last-segment wildcard covers direct children only (GitHub's "docs/*" example).
  const suffix = dirOnly ? '/.*$' : lastHasWildcard ? '$' : '(?:/.*)?$'
  return new RegExp(prefix + globToRegex(body) + suffix)
}

export function parseCodeowners(text: string): CodeownersRule[] {
  const rules: CodeownersRule[] = []
  text.split('\n').forEach((raw, index) => {
    const trimmed = raw.trim()
    if (!trimmed || trimmed.startsWith('#')) return
    const tokens = trimmed.split(/\s+/)
    const pattern = tokens[0]
    const ownerTokens: string[] = []
    for (const token of tokens.slice(1)) {
      if (token.startsWith('#')) break
      ownerTokens.push(token)
    }
    const supported = !(pattern.startsWith('\\#') || pattern.startsWith('!') || /[[\]]/.test(pattern))
    rules.push({ pattern, owners: ownerTokens, line: index + 1, supported, regex: supported ? compile(pattern) : null })
  })
  return rules
}

export function ownersFor(rules: CodeownersRule[], filePath: string): string[] | null {
  let found: string[] | null = null
  for (const rule of rules) {
    if (rule.regex && rule.regex.test(filePath)) found = rule.owners
  }
  return found
}

export function unsupportedLines(rules: CodeownersRule[]): number[] {
  return rules.filter(rule => !rule.supported).map(rule => rule.line)
}
