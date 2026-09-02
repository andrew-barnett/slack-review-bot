import test from 'tape'
import {
  isDeploymentsValuesFile,
  protectedDeploymentsFiles,
  renderHumanReviewComment,
  renderHumanReviewThread,
} from './gate'

// The file matcher: values.yaml and its per-environment siblings in any directory, but never
// the encrypted twin (which is ciphertext and safe) or an unrelated yaml.
test('isDeploymentsValuesFile matches values files and nothing else', t => {
  t.equal(isDeploymentsValuesFile('values.yaml'), true, 'the plain file')
  t.equal(isDeploymentsValuesFile('apps/web/values.yaml'), true, 'in a subdirectory')
  t.equal(isDeploymentsValuesFile('values-prod.yaml'), true, 'a per-environment sibling')
  t.equal(isDeploymentsValuesFile('values.staging.yaml'), true, 'a dotted per-environment sibling')
  t.equal(isDeploymentsValuesFile('values.yml'), true, 'the .yml spelling')
  t.equal(isDeploymentsValuesFile('values.yaml.enc'), false, 'the encrypted twin is safe to read')
  t.equal(isDeploymentsValuesFile('myvalues.yaml'), false, 'not a file that merely ends in values')
  t.equal(isDeploymentsValuesFile('chart/templates/deployment.yaml'), false, 'an unrelated yaml')
  t.equal(isDeploymentsValuesFile('README.md'), false, 'a non-yaml')
  t.end()
})

// The gate only bites in the deployments repo — an ordinary chart's values.yaml elsewhere is
// the bot's to review.
test('protectedDeploymentsFiles gates only within the deployments repo', t => {
  t.deepEqual(
    protectedDeploymentsFiles({ repo: 'deployments' }, ['values.yaml', 'README.md']),
    ['values.yaml'],
    'the values file is flagged'
  )
  t.deepEqual(protectedDeploymentsFiles({ repo: 'deployments' }, ['README.md']), [], 'nothing flagged')
  t.deepEqual(
    protectedDeploymentsFiles({ repo: 'orders-service' }, ['values.yaml']),
    [],
    'a values.yaml in another repo is not gated'
  )
  t.end()
})

// The PR comment is the developer-facing half of the feature: it must say, unambiguously, that
// a human has to review, and name the files when they are known.
test('renderHumanReviewComment names the files when verified', t => {
  const text = renderHumanReviewComment(['values.yaml'], true)
  t.ok(/human review is required/i.test(text), 'states a human review is required')
  t.ok(text.includes('`values.yaml`'), 'names the offending file')
  t.ok(text.includes('deployments'), 'names the repo')
  t.end()
})

// When the files could not be listed, the comment still declines the review, framed as caution
// rather than a specific file.
test('renderHumanReviewComment explains the unverified case', t => {
  const text = renderHumanReviewComment([], false)
  t.ok(/human review is required/i.test(text), 'still requires a human')
  t.ok(/couldn't confirm|could not confirm|caution/i.test(text), 'frames it as caution')
  t.end()
})

// The Slack note points the requester at the PR.
test('renderHumanReviewThread names the gated PRs', t => {
  const text = renderHumanReviewThread(['deployments#5'])
  t.ok(/human review required/i.test(text))
  t.ok(text.includes('deployments#5'))
  t.end()
})
