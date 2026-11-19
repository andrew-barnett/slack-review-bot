// Container detection, the TypeScript twin of inContainer in scripts/claude-profile-lib.js. It is a copy
// on purpose: that script runs its CLI under a `require.main === module` guard, which esbuild's scope
// hoisting makes true inside every bundle. src/container.test.ts keeps the two identical.

import * as fs from 'fs'
import * as path from 'path'

/** True inside a Docker or Podman container. `root` is a test seam. */
export function inContainer(root: string = process.env.CONTAINER_PROBE_ROOT || '/'): boolean {
  if (fs.existsSync(path.join(root, '.dockerenv')) || fs.existsSync(path.join(root, 'run', '.containerenv'))) return true
  try {
    return /docker|containerd|kubepods|libpod/.test(fs.readFileSync(path.join(root, 'proc', '1', 'cgroup'), 'utf8'))
  } catch {
    return false
  }
}
