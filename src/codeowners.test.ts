import test from 'tape'
import { ownersFor, parseCodeowners, unsupportedLines } from './codeowners'

const owners = (text: string, path: string) => ownersFor(parseCodeowners(text), path)

// GitHub's own documented examples are the contract, because the pre-flight predicts GitHub's
// behaviour. Each case below is from docs.github.com "About code owners", CODEOWNERS syntax.
test('matches GitHub documented examples', t => {
  t.deepEqual(owners('* @all', 'any/deep/file.txt'), ['@all'], '* matches everything')
  t.deepEqual(owners('*.js @js', 'src/x/a.js'), ['@js'], 'extension pattern matches at any depth')
  t.equal(owners('*.js @js', 'src/a.ts'), null)
  t.deepEqual(owners('/build/logs/ @logs', 'build/logs/x/y.txt'), ['@logs'], 'anchored dir and everything under it')
  t.equal(owners('/build/logs/ @logs', 'other/build/logs/y.txt'), null, 'leading slash anchors to the root')
  t.deepEqual(owners('apps/ @apps', 'deep/apps/a.ts'), ['@apps'], 'unanchored dir matches anywhere')
  t.deepEqual(owners('/docs/ @docs', 'docs/a.md'), ['@docs'])
  t.equal(owners('/docs/ @docs', 'x/docs/a.md'), null)
  t.deepEqual(owners('**/logs @logs', 'a/b/logs/c.txt'), ['@logs'], '**/ matches any leading dirs')
  t.end()
})

// Review Focus 1: a wildcard in the last segment matches direct children only. A gitignore port
// that lets "docs/*" match nested paths over-credits ownership.
test('a last-segment wildcard does not match nested paths', t => {
  t.deepEqual(owners('docs/* @docs', 'docs/getting-started.md'), ['@docs'])
  t.equal(owners('docs/* @docs', 'docs/build-app/troubleshooting.md'), null)
  t.end()
})

// The last matching rule wins, including one with no owners, which means "needs no owner".
test('last match wins, and an ownerless rule clears ownership', t => {
  const text = ['* @all', '/apps/ @apps', '/apps/github'].join('\n')
  t.deepEqual(owners(text, 'apps/web/a.ts'), ['@apps'])
  t.deepEqual(owners(text, 'apps/github'), [], 'matched with no owners')
  t.deepEqual(owners(text, 'README.md'), ['@all'])
  t.end()
})

// GitHub does not support \# escapes, ! negation or [] ranges. Honouring them locally would
// recognise owners GitHub ignores. They must never match or override an earlier rule.
test('unsupported syntax never matches and is reported', t => {
  const text = ['* @all', '\\#notes @x', '!keep.txt @y', '[ab].js @z'].join('\n')
  const rules = parseCodeowners(text)
  t.deepEqual(ownersFor(rules, '#notes'), ['@all'])
  t.deepEqual(ownersFor(rules, 'keep.txt'), ['@all'])
  t.deepEqual(ownersFor(rules, 'a.js'), ['@all'])
  t.deepEqual(unsupportedLines(rules), [2, 3, 4])
  t.end()
})

// Comments and blank lines are skipped, and a trailing "# ..." after the owners is dropped
// rather than read as an owner.
test('comments and blank lines are ignored', t => {
  const text = ['# top comment', '', '/src/ @team # inline note'].join('\n')
  t.deepEqual(owners(text, 'src/a.ts'), ['@team'])
  t.end()
})
