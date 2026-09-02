import test from 'tape'
import { makeGitHubEffects } from './github'

const pr = { owner: 'trade-platform', repo: 'deployments', number: 5, url: 'https://github.com/trade-platform/deployments/pull/5' }

// listChangedFiles must ask gh for names only (never the diff contents) and return clean paths.
test('listChangedFiles requests names-only and parses the output', async t => {
  const calls: string[][] = []
  const gh = makeGitHubEffects('gh', async args => {
    calls.push(args)
    return 'apps/web/values.yaml\nREADME.md\n\n'
  })
  const files = await gh.listChangedFiles!(pr)
  t.deepEqual(files, ['apps/web/values.yaml', 'README.md'], 'trimmed, blank lines dropped')
  t.deepEqual(
    calls[0],
    ['pr', 'diff', '5', '--repo', 'trade-platform/deployments', '--name-only'],
    'names only, addressed by number + repo'
  )
  t.end()
})

// postPrComment must target the PR and pass the body through unchanged.
test('postPrComment posts the body to the PR', async t => {
  const calls: string[][] = []
  const gh = makeGitHubEffects('gh', async args => {
    calls.push(args)
    return ''
  })
  await gh.postPrComment!(pr, 'a human must review this')
  t.deepEqual(calls[0], [
    'pr',
    'comment',
    '5',
    '--repo',
    'trade-platform/deployments',
    '--body',
    'a human must review this',
  ])
  t.end()
})
