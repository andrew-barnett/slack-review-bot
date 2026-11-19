import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import test from 'tape'
import { inContainer } from './container'

// eslint-disable-next-line @typescript-eslint/no-require-imports
const lib = require('../scripts/claude-profile-lib') as { inContainer(root?: string): boolean }

/** A fake filesystem root holding only the given files. */
function root(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-root-'))
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true })
    fs.writeFileSync(path.join(dir, rel), body)
  }
  return dir
}

// src/container.ts cannot import scripts/claude-profile-lib.js: that file runs its CLI under a
// `require.main === module` guard, which esbuild's scope hoisting makes true inside every bundle. So
// the probe exists twice, and this test keeps the copies identical. Regression caught: the doctor and
// the profile checker disagreeing about whether they run in a container.
test('inContainer agrees with the profile checker on every probe', t => {
  const cases: [string, Record<string, string>, boolean][] = [
    ['empty root', {}, false],
    ['docker marker', { '.dockerenv': '' }, true],
    ['podman marker', { 'run/.containerenv': '' }, true],
    ['docker cgroup', { 'proc/1/cgroup': '0::/docker/abc\n' }, true],
    ['kubepods cgroup', { 'proc/1/cgroup': '0::/kubepods/x\n' }, true],
    ['host cgroup', { 'proc/1/cgroup': '0::/init.scope\n' }, false],
  ]
  for (const [name, files, expected] of cases) {
    const dir = root(files)
    t.equal(inContainer(dir), expected, `ts: ${name}`)
    t.equal(lib.inContainer(dir), expected, `js: ${name}`)
  }
  t.end()
})
