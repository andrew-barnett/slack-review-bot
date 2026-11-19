import * as fs from 'fs'
import * as path from 'path'
import test from 'tape'
import { loadReviewConfig } from './config'
import { defaultPricesFile, loadPriceTable } from './pricing'

// Ruling 4: the shipped table must price both default Bedrock models, or the container runtime refuses
// to start. Regression caught: a model default changed in config.ts without a price-table entry, found
// only when the orchestrator dies at startup. Also pins the source line format (URL, region, date).
test('the shipped price table prices both default Bedrock models and records its source', t => {
  const review = loadReviewConfig({ HOME: '/home/u' })
  const table = loadPriceTable(defaultPricesFile(), [review.codexBedrockModel, review.claudeBedrockModel])
  t.match(table.source, /^https:\/\/aws\.amazon\.com\/bedrock\/pricing\/ \(on-demand, us-east-2\), checked \d{4}-\d{2}-\d{2}$/)
  t.end()
})

// The orchestrator reads /app/pricing/bedrock-prices.json. Regression caught: the table in the repo but
// not in the image, so the container runtime fails at startup with "cannot read BEDROCK_PRICES_FILE".
test('the image ships the price table', t => {
  const dockerfile = fs.readFileSync(path.join(__dirname, '..', 'Dockerfile'), 'utf8')
  t.ok(/^COPY pricing \.\/pricing$/m.test(dockerfile))
  t.end()
})
