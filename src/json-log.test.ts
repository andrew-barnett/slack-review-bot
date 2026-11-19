import test from 'tape'
import { jsonLog } from './json-log'

// Container and launcher logs are parsed as JSON lines; the event name and fields must survive as
// top-level keys. Regression caught: a format change that breaks log scraping in every entrypoint.
test('jsonLog writes one JSON line with time, event and fields', t => {
  const written: string[] = []
  const original = process.stdout.write.bind(process.stdout)
  process.stdout.write = ((chunk: string) => (written.push(chunk), true)) as typeof process.stdout.write
  try {
    jsonLog('worker.claimed', { jobId: 'j1' })
  } finally {
    process.stdout.write = original
  }
  t.equal(written.length, 1)
  t.ok(written[0].endsWith('\n'))
  const parsed = JSON.parse(written[0])
  t.equal(parsed.event, 'worker.claimed')
  t.equal(parsed.jobId, 'j1')
  t.ok(!Number.isNaN(Date.parse(parsed.time)))
  t.end()
})
