import test from 'tape'
import { editDistance, matchCommandWord, resolveMentionCommand } from './command'

// The distance metric, including the transposition case that is the reason it is OSA rather
// than plain Levenshtein — `pign` for `ping` must cost 1, not 2.
test('editDistance counts edits, and a transposition as one', t => {
  t.equal(editDistance('ping', 'ping'), 0, 'identical')
  t.equal(editDistance('staus', 'status'), 1, 'a single insertion')
  t.equal(editDistance('pign', 'ping'), 1, 'an adjacent transposition is one edit')
  t.equal(editDistance('', 'abc'), 3, 'from empty')
  t.equal(editDistance('help', ''), 4, 'to empty')
  t.end()
})

// The core of the feature: a near miss resolves to the command it obviously means.
test('matchCommandWord resolves exact words and near misses', t => {
  t.equal(matchCommandWord('status')?.word, 'status', 'exact')
  t.equal(matchCommandWord('staus')?.word, 'status', 'transposed status')
  t.equal(matchCommandWord('helth')?.word, 'health', 'health missing a letter')
  t.equal(matchCommandWord('pign')?.word, 'ping', 'transposed ping')
  t.equal(matchCommandWord('HELP')?.word, 'help', 'case-insensitive')
  t.end()
})

// The guard the feature turns on: a word within reach of two different commands is not a
// command, because guessing between `help` and `health` would as often be wrong as right.
test('matchCommandWord refuses a word that is close to two commands', t => {
  t.equal(matchCommandWord('healp'), null, 'could be help or health — no guess')
  t.end()
})

// And a word that is nothing like a command is simply not one.
test('matchCommandWord returns null for an unrelated word', t => {
  t.equal(matchCommandWord('deploy'), null)
  t.equal(matchCommandWord('thanks'), null)
  t.equal(matchCommandWord('hi'), null)
  t.end()
})

// Over a whole message: markup is dropped, the first resolvable word wins, and an ambiguous
// word is skipped rather than guessed.
test('resolveMentionCommand reads the intended action from a message', t => {
  t.equal(resolveMentionCommand('<@U0BOT> staus'), 'status', 'a status near miss')
  t.equal(resolveMentionCommand('<@U0BOT> helth'), 'status', 'health is a status alias')
  t.equal(resolveMentionCommand('<@U0BOT> pign'), 'status', 'ping too')
  t.equal(resolveMentionCommand('<@U0BOT> please halp'), 'help', 'a help near miss')
  t.equal(resolveMentionCommand('<@U0BOT> healp'), null, 'the ambiguous word resolves to nothing')
  t.equal(resolveMentionCommand('<@U0BOT>'), null, 'a bare mention resolves to nothing')
  t.equal(resolveMentionCommand('<@U0BOT> deploy the thing'), null, 'no command word present')
  t.end()
})

// The mention itself must not be mistaken for a command word — its inner id is stripped before
// matching, so `<@U0BOT>` never accidentally resolves.
test('resolveMentionCommand ignores the mention markup', t => {
  t.equal(resolveMentionCommand('<@Uststus> hello there'), null, 'the id is not a candidate word')
  t.end()
})
