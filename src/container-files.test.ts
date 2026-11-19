import * as fs from 'fs'
import * as path from 'path'
import test from 'tape'

const ROOT = path.join(__dirname, '..')
const read = (file: string) => fs.readFileSync(path.join(ROOT, file), 'utf8')
const SECRET_NAMES = [
  'APPROVER_GH_TOKEN', 'ENGINE_GH_TOKEN', 'SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN', 'LAUNCH_KEY',
  'WORKER_TICKET', 'NPM_TOKEN', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN',
]

/** The lines of a two-space-indented Compose service block. */
function service(compose: string, name: string): string {
  const lines = compose.split('\n')
  const start = lines.indexOf(`  ${name}:`)
  if (start < 0) return ''
  const body: string[] = []
  for (const line of lines.slice(start + 1)) {
    if (/^ {0,2}\S/.test(line)) break
    body.push(line)
  }
  return body.join('\n')
}

// Spec 3.6.1 and 3.8: no secret ever enters the Compose file (no `environment:` value, no
// `secrets:`), no Docker socket, no published port, and no restart policy (the launcher supervises).
// Regression caught: a convenience edit that leaks a token into `docker inspect` or hands a worker
// the host through the socket.
test('compose.yaml carries no secrets, socket, ports or restart policy', t => {
  const compose = read('compose.yaml')
  for (const banned of ['docker.sock', 'secrets:', 'restart:', 'privileged', 'ports:', 'network_mode', 'pid:']) {
    t.notOk(compose.includes(banned), `no ${banned}`)
  }
  // An empty default (`${X:-}`) would pass a variable through even when the operator never set it.
  t.notOk(compose.includes(':-}'), 'no empty-default substitutions')
  for (const name of SECRET_NAMES) t.notOk(new RegExp(`\\b${name}\\b`).test(compose), `${name} not mentioned`)
  t.end()
})

// Spec 3.8: both services are hardened, the job network is internal, and the worker has no volume.
test('compose.yaml hardens both services and isolates the job network', t => {
  const compose = read('compose.yaml')
  for (const name of ['orchestrator', 'worker']) {
    const block = service(compose, name)
    t.ok(block, `${name} service exists`)
    t.match(block, /cap_drop: \[ALL\]/, `${name} drops every capability`)
    t.match(block, /no-new-privileges:true/, `${name} sets no-new-privileges`)
    t.match(block, /stdin_open: true/, `${name} reads its bundle from stdin`)
    t.match(block, /networks: \[jobs, egress\]/, `${name} networks`)
  }
  const worker = service(compose, 'worker')
  t.notOk(/volumes:/.test(worker), 'the worker mounts no volume')
  t.match(worker, /- ENGINE_AUTH=bedrock/)
  t.match(worker, /- npm_config_userconfig=\/home\/bot\/\.npmrc-worker/)
  t.match(worker, /- ORCHESTRATOR_URL=http:\/\/slack-review-bot-orchestrator:8080/)
  t.match(service(compose, 'orchestrator'), /mem_limit: 512m/)
  t.match(compose, /jobs:\n {4}internal: true/)
  t.end()
})

// Spec 3.1: non-root user, tini as PID 1, pinned tool versions, no secret-bearing variable.
test('Dockerfile runs as bot under tini with pinned tools and no secret variables', t => {
  const docker = read('Dockerfile')
  t.match(docker, /--uid 10001/)
  t.match(docker, /^USER bot$/m)
  t.match(docker, /ENTRYPOINT \["\/usr\/bin\/tini", "--", "\/usr\/local\/bin\/srb-entrypoint"\]/)
  for (const pin of ['ARG CODEX_VERSION=0.169.0', 'ARG CLAUDE_CODE_VERSION=2.1.284', 'ARG GH_VERSION=2.103.3', 'ARG AWSCLI_VERSION=2.40.4']) {
    t.ok(docker.includes(pin), pin)
  }
  t.notOk(/@latest|:latest/.test(docker), 'no latest tags')
  for (const name of SECRET_NAMES) t.notOk(new RegExp(`\\b${name}\\b`).test(docker), `${name} not mentioned`)
  t.notOk(docker.includes('docker.sock'))
  t.end()
})

// The entrypoint dispatches exactly three roles and refuses anything else.
test('docker/entrypoint.sh dispatches orchestrator, worker and doctor only', t => {
  const entry = read('docker/entrypoint.sh')
  t.match(entry, /orchestrator\) exec node \/app\/dist\/orchestrator\.js/)
  t.match(entry, /worker\) exec node \/app\/dist\/worker\.js/)
  t.match(entry, /doctor\) exec node \/app\/dist\/doctor\.js/)
  t.match(read('docker/aqua-skills.ref'), /^[0-9a-f]{40}\n$/)
  t.end()
})

// The lockfile resolves every package through the CodeArtifact mirror, and npm rewrites only npmjs
// hosts for --registry, so the build stage must repoint the lockfile before `npm ci` or the image build
// fails with a 401 (it has no registry token, by design). Regression caught: dropping the rewrite.
test('Dockerfile repoints the lockfile at the public registry before npm ci', t => {
  const docker = read('Dockerfile')
  const rewrite = docker.indexOf("sed -i 's#https://trade-platform-153538148884.d.codeartifact.us-east-2.amazonaws.com/npm/trade-platform/#https://registry.npmjs.org/#g' package-lock.json")
  const install = docker.indexOf('npm ci --ignore-scripts')
  t.ok(rewrite > 0 && install > rewrite, 'the rewrite runs before npm ci')
  // The rewrite only helps while every lockfile URL uses this one mirror prefix.
  const urls = [...read('package-lock.json').matchAll(/"resolved": "(https:\/\/[^"]+)"/g)].map(m => m[1])
  t.ok(urls.length > 0)
  t.ok(urls.every(u => u.startsWith('https://trade-platform-153538148884.d.codeartifact.us-east-2.amazonaws.com/npm/trade-platform/') || u.startsWith('https://registry.npmjs.org/')), 'every resolved URL is rewritable')
  t.end()
})

/** The `- NAME` (or `- NAME=value`) entries of a service's environment list. */
function envNames(block: string): Set<string> {
  return new Set([...block.matchAll(/^ {6}- ([A-Za-z_][A-Za-z0-9_]*)/gm)].map(m => m[1]))
}

// Every setting config.ts reads must reach the container that uses it, or it silently reverts to its
// default at cutover (ruling F3). A setting is either passed through to the orchestrator or the worker,
// or listed here with the reason it is not. Regression caught: a new config variable that works under
// launchd and is ignored in the containers.
test('compose.yaml passes every config setting to a service or excludes it on purpose', t => {
  const compose = read('compose.yaml')
  const passed = new Set([...envNames(service(compose, 'orchestrator')), ...envNames(service(compose, 'worker'))])
  const notPassed: Record<string, string> = {
    HOME: 'set by the image',
    RUNTIME: 'set by the image',
    CLAUDE_BIN: 'the image installs claude on PATH',
    CODEX_BIN: 'the image installs codex on PATH',
    CODEX_PROFILE: 'the image installs the review-bot profile',
    CLAUDE_CONFIG_DIR_REVIEW: 'set by the image',
    CURSOR_FILE: 'set by the image, on the state volume',
    RUN_LOG_DIR: 'set by the image, on the runs volume',
    WORKSPACE_ROOT: 'set by the image',
    WORKTREE_ROOT: 'set by the image',
    CODEARTIFACT_REFRESH: 'set by the image; the launcher mints the npm token',
    CODEARTIFACT_LOGIN_SCRIPT: 'host-only; the launcher mints the npm token',
    ENGINE_AWS_PROFILE: 'host-only; workers get static session credentials',
    ENGINE_ROLE_ARN: 'host-only; the launcher assumes the role per worker',
    JOB_PORT: 'fixed at 8080 to match ORCHESTRATOR_URL',
  }
  const configSource = read('src/config.ts')
  const names = new Set([...configSource.matchAll(/env\.([A-Z][A-Z0-9_]+)|env\[['"]([A-Z][A-Z0-9_]+)['"]\]/g)].map(m => m[1] ?? m[2]))
  for (const name of names) {
    if (SECRET_NAMES.includes(name)) continue
    t.ok(passed.has(name) || name in notPassed, `${name} is passed to a service or excluded with a reason`)
  }
  t.end()
})

// Final review (T13): each plist template's header comment is the operator's map of what the installer
// substitutes. Regression caught: a placeholder (such as __EXIT_TIMEOUT__) added to the body but left
// out of the header, so a hand install leaves it unsubstituted and launchd rejects the plist.
test('every launchd template header names each placeholder its body uses', t => {
  for (const file of ['launchd/com.abarnett.slack-review-bot-launcher.plist.template', 'launchd/com.abarnett.slack-review-bot.plist.template']) {
    const text = read(file)
    const header = /<!--([\s\S]*?)-->/.exec(text)?.[1] ?? ''
    const body = text.slice(text.indexOf('<plist'))
    for (const placeholder of new Set(body.match(/__[A-Z_]+__/g) ?? [])) {
      t.ok(header.includes(placeholder), `${file} header names ${placeholder}`)
    }
  }
  t.end()
})

// Spec 4: the orchestrator prices spend, so it needs the spend settings and the model IDs it prices by.
// Regression caught: CODEX_BEDROCK_MODEL reaching only the worker, so the orchestrator priced a custom
// model at the default model's entry.
test('compose.yaml gives the orchestrator the spend settings and the Bedrock model IDs', t => {
  const orchestrator = envNames(service(read('compose.yaml'), 'orchestrator'))
  for (const name of [
    'BEDROCK_MONTHLY_CAP_USD',
    'SPEND_ALERT_PERCENTS',
    'SPEND_ALERT_HERE_PERCENTS',
    'SPEND_ALERT_CHANNEL',
    'BEDROCK_PRICES_FILE',
    'CODEX_BEDROCK_MODEL',
    'CLAUDE_BEDROCK_MODEL',
  ]) {
    t.ok(orchestrator.has(name), `${name} reaches the orchestrator`)
  }
  t.end()
})
