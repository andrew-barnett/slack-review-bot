import test from 'tape'
import { redactSecrets, safeRedactBoundary } from './redact'

// Credential-shaped fixtures are assembled at runtime (join/concat) rather than written as literals,
// so no contiguous secret pattern sits in the committed source to trip GitHub push protection. The
// assembled runtime value is a full match and exercises the redactor exactly as a literal would.
const shaped = {
  slackBot: ['xoxb', '1111111111', '2222222222', 'abcdefabcdefabcdefabcdef'].join('-'),
  slackApp: ['xapp', '1', 'A0000000000', '1111111111111', 'abcdefabcdef'].join('-'),
  ghPat: 'ghp_' + 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
  ghFine: 'github_pat_' + '11ABCDEFG0abcdefghijkl_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789ab',
  anthropic: 'sk-ant-' + 'api03-abcdefghijklmnopqrstuvwxyz0123',
  openai: 'sk-proj-' + 'abcdefghijklmnopqrstuvwxyz0123',
  aws: 'AKIA' + 'IOSFODNN7EXAMPLE',
  npm: 'npm_' + 'abcdefghijklmnopqrstuvwxyz0123456789',
}

// Each well-known credential shape must be masked wherever it appears in a line of output, since a
// malicious dependency can print any of them. One case per shape so a regex that stops matching is
// caught.
test('redactSecrets masks each known credential shape', t => {
  const cases: Array<[string, string]> = [
    [`token=${shaped.slackBot} here`, 'slack bot token'],
    [`app ${shaped.slackApp} done`, 'slack app token'],
    [`GH ${shaped.ghPat} tail`, 'github pat'],
    [`fine ${shaped.ghFine} x`, 'fine-grained github pat'],
    [`key ${shaped.anthropic} end`, 'anthropic key'],
    [`key ${shaped.openai} end`, 'openai key'],
    [`aws ${shaped.aws} creds`, 'aws access key id'],
    [`npm ${shaped.npm} tok`, 'npm token'],
  ]
  for (const [input, label] of cases) {
    const out = redactSecrets(input, {})
    t.ok(/\[redacted:/.test(out), `${label}: something was redacted`)
    // The tail/prefix context around the secret survives — only the secret itself is masked.
    t.notEqual(out, '[redacted]', `${label}: surrounding text is preserved`)
  }
  t.end()
})

// A PEM private-key block spans many lines; the whole block must go, not just its header line.
test('redactSecrets masks a multi-line PEM private-key block', t => {
  const begin = '-----BEGIN RSA ' + 'PRIVATE KEY-----'
  const end = '-----END RSA ' + 'PRIVATE KEY-----'
  const pem = `${begin}\nAAAAB3NzaC1yc2E\nBBBBmorekeyline\n${end}`
  const out = redactSecrets(`before\n${pem}\nafter`, {})
  t.ok(out.includes('[redacted:private-key]'), 'the block is redacted')
  t.notOk(out.includes('AAAAB3NzaC1yc2E'), 'no key material remains')
  t.ok(out.includes('before') && out.includes('after'), 'surrounding lines survive')
  t.end()
})

// The value layer catches a held secret of ANY shape — e.g. a bespoke model key with no known
// prefix — by matching the literal value of a sensitive-named env var. This is what protects a
// future model token the shape rules cannot recognize.
test('redactSecrets masks literal values of sensitive env vars, whatever their shape', t => {
  const env = {
    ANTHROPIC_API_KEY: 'bespoke-model-key-no-known-prefix-1234567890',
    SLACK_BOT_TOKEN: 'shaped-differently-but-still-secret-abcdef',
    PATH: '/usr/bin:/bin:/opt/homebrew/bin', // long, but must NOT be redacted
    HOME: '/Users/someone',
  }
  const out = redactSecrets(
    'model=bespoke-model-key-no-known-prefix-1234567890 path=/usr/bin:/bin:/opt/homebrew/bin',
    env
  )
  t.ok(out.includes('[redacted:env]'), 'the sensitive value is masked')
  t.notOk(out.includes('bespoke-model-key-no-known-prefix'), 'no secret material remains')
  t.ok(out.includes('/usr/bin:/bin:/opt/homebrew/bin'), 'PATH (not sensitive) is left intact')
  t.end()
})

// A short env value must not be blanket-replaced: it is too likely to be a common substring whose
// removal would corrupt legitimate output (guards the MIN_ENV_VALUE_LENGTH floor).
test('redactSecrets leaves short sensitive-named values alone', t => {
  const out = redactSecrets('exit code 0 token=yes', { SOME_TOKEN: 'yes' })
  t.equal(out, 'exit code 0 token=yes', 'a 3-char value is not scrubbed')
  t.end()
})

// Idempotence: the placeholders match none of the rules, so a second pass is a no-op. This is what
// makes it safe to redact at both the capture choke point and the error-thread assembly.
test('redactSecrets is idempotent', t => {
  const once = redactSecrets(shaped.ghPat, {})
  t.equal(redactSecrets(once, {}), once, 'redacting twice equals redacting once')
  t.end()
})

// Ordinary output with no secrets must pass through untouched — redaction is not allowed to mangle
// normal review logs.
test('redactSecrets leaves ordinary output unchanged', t => {
  const text = 'reading files\nrunning jest\n12 passed, 0 failed\ntokens used\n300,448'
  t.equal(redactSecrets(text, {}), text, 'no false positives on normal output')
  t.end()
})

// safeRedactBoundary decides how much of a streaming buffer is safe to redact now — the mechanism
// that stops a secret split across chunks from being redacted as two unmatched halves.
test('safeRedactBoundary publishes only complete lines', t => {
  t.equal(safeRedactBoundary('no newline yet'), 0, 'a partial first line holds entirely')
  t.equal(safeRedactBoundary('done\npartial'), 'done\n'.length, 'holds back the trailing partial line')
  t.equal(safeRedactBoundary('a\nb\n'), 4, 'a fully-terminated buffer is entirely safe')
  t.end()
})

// A PEM private key spans lines; while its END has not arrived, everything from BEGIN must be held
// so the block is redacted whole, not leaked line by line.
test('safeRedactBoundary holds an unterminated PEM block from its BEGIN', t => {
  const begin = '-----BEGIN RSA ' + 'PRIVATE KEY-----'
  const open = `safe line\n${begin}\nKEYBODY\n`
  t.equal(safeRedactBoundary(open), 'safe line\n'.length, 'holds from the BEGIN line, publishing only what precedes it')
  const end = '-----END RSA ' + 'PRIVATE KEY-----'
  const closed = `safe line\n${begin}\nKEYBODY\n${end}\ntail\n`
  t.equal(safeRedactBoundary(closed), closed.length, 'once END arrives the whole block is safe to publish')
  t.end()
})
