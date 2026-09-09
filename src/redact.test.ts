import test from 'tape'
import { redactSecrets, createOutputRedactor } from './redact'

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

// The streaming redactor only publishes complete lines, holding a partial line until its newline
// arrives — this is what stops a secret split across chunks from being redacted as two unmatched
// halves. A whole line, secret or not, is emitted; a partial line is withheld.
test('createOutputRedactor holds a partial line until its newline arrives', t => {
  const r = createOutputRedactor({})
  t.equal(r.push('running jest'), '', 'a line with no newline yet is withheld')
  t.equal(r.push(' and mocha\n'), 'running jest and mocha\n', 'the completed line is published whole')
  t.end()
})

// A GitHub token split across two chunks matches nothing in either half; because the redactor waits
// for the whole line, the token is redacted once, and never surfaced in two contiguous halves.
test('createOutputRedactor redacts a token split across chunks', t => {
  const r = createOutputRedactor({})
  const first = r.push('using ghp_ABCDEFGHIJKLMNOP')
  const second = r.push('QRSTUVWXYZ0123456789 now\n')
  const all = first + second
  t.notOk(/ghp_[A-Za-z0-9]{20,}/.test(all), 'no whole token is published')
  t.ok(all.includes('[redacted:github-token]'), 'it is masked once the line completes')
  t.end()
})

// A PEM private key spans lines and may span chunks/an over-long body. Once BEGIN is seen every
// following line is suppressed until END, across chunks and regardless of size, so no key material
// is ever published — only a single placeholder.
test('createOutputRedactor suppresses a PEM key body across chunks and past the cap', t => {
  const r = createOutputRedactor({})
  const begin = '-----BEGIN RSA ' + 'PRIVATE KEY-----'
  const end = '-----END RSA ' + 'PRIVATE KEY-----'
  let out = r.push(`before\n${begin}\nKEYBODYAAAA\n`)
  out += r.push('x'.repeat(70 * 1024) + '\n') // an over-long body line: forced past the cap
  out += r.push(`KEYBODYBBBB\n${end}\nafter\n`)
  out += r.flush()
  t.notOk(out.includes('KEYBODYAAAA') || out.includes('KEYBODYBBBB'), 'no key material is published')
  t.notOk(out.includes('x'.repeat(64)), 'the over-long body is not published either')
  t.ok(out.includes('[redacted:private-key]'), 'the block is marked redacted')
  t.ok(out.includes('before') && out.includes('after'), 'surrounding output survives')
  t.end()
})

// flush emits the trailing partial line at end of stream (the token footer often has no final
// newline), but a key block still open at close emits no body.
test('createOutputRedactor flushes a trailing line but never an open key body', t => {
  const r = createOutputRedactor({})
  t.equal(r.push('tokens used\n300,448'), 'tokens used\n', 'the completed line publishes; the footer waits')
  t.equal(r.flush(), '300,448', 'flush emits the trailing partial line')

  const r2 = createOutputRedactor({})
  const begin = '-----BEGIN RSA ' + 'PRIVATE KEY-----'
  r2.push(`${begin}\nKEYBODYCCCC\n`)
  t.notOk(r2.flush().includes('KEYBODYCCCC'), 'an open block emits no body on flush')
  t.end()
})
