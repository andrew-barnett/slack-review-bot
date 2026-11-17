# Dual-Engine Approval Gate — Plan 1: Foundations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the pieces of the dual-engine approval gate that the V1-V4 spike does not block: config and credential separation, shared process supervision, GitHub calls made with the approver token, the CODEOWNERS matcher, and the approval-eligibility pre-flight. Ship them with **no behaviour change** while `REVIEW_ENGINES=codex`.

**Architecture:** Every unit added here is either pure (the matcher, the evaluator, the patch parser) or sits behind an injected runner (`GhRunner`, `Spawner`), so each one is tested without the network or a real child process. Dual mode (`REVIEW_ENGINES=codex,claude`) is parsed and validated, but startup refuses it until Plan 2 lands the orchestrator.

**Tech Stack:** TypeScript 5.9 (CommonJS via ts-node), Node 22, `tape` tests, the `gh` CLI 2.103.

**Spec:** `docs/superpowers/specs/2026-11-17-dual-engine-approval-design.md` (sections 5.1, 5.2, 5.4, 5.7, 9). Epic: https://github.com/andrew-barnett/slack-review-bot/issues/52. Sub-issues: https://github.com/andrew-barnett/slack-review-bot/issues/55, https://github.com/andrew-barnett/slack-review-bot/issues/56, https://github.com/andrew-barnett/slack-review-bot/issues/57, https://github.com/andrew-barnett/slack-review-bot/issues/60.

**Plan 2 (separate, after https://github.com/andrew-barnett/slack-review-bot/issues/54 and https://github.com/trade-platform/aqua-skills/issues/192):** the Claude engine, the report-only prompt and schema v2, the orchestrator (update-branch, pinning, gate, posting, idempotency, read-back), rendering, and the doctor checks.

## Global Constraints

- `REVIEW_ENGINES` accepts only `codex` (the default) or `codex,claude`.
- `ENGINE_SCHEDULE` accepts only `parallel` (the default) or `serial`.
- `ENGINE_ORDER` defaults to `codex,claude` and is validated only in dual mode: each engine exactly once.
- `APPROVER_GH_TOKEN` must **never** reach an engine child. It is dropped even when named in `CODEX_ENV_PASSTHROUGH`, and it is deleted from `process.env` at startup.
- In dual mode the child's `GH_TOKEN` is set from `ENGINE_GH_TOKEN`, and `GITHUB_TOKEN` and `GH_ENTERPRISE_TOKEN` are removed.
- Dual mode requires both tokens to be set, and the two must differ. The same-login check needs the network, so it lands in Plan 2 with doctor.
- Every `gh` call keeps the existing finite timeout (`GH_COMMAND_TIMEOUT_MS`) and SIGKILL.
- Request bodies are sent to `gh api` on stdin (`--input -`), never in argv.
- Log messages use constant event names, with variable data in the fields object (the existing `log(event, fields)` style). Never log a token.
- Commits use Conventional Commits with `(refs andrew-barnett/slack-review-bot#<sub-issue>)`. Production code uses `feat`/`fix`/`refactor`, tests-only `test`, docs `docs`. This repo has no semantic-release, so the type is descriptive only.
- Every test carries a comment stating its purpose and the regression or failure mode it catches (repo and user convention).
- Run tests with `npm test` (the whole suite) or `npx ts-node --compiler-options '{"module":"commonjs"}' --transpile-only src/<file>.test.ts` (one file). Typecheck with `npm run typecheck`.

## Review Focus

1. **A CODEOWNERS wildcard in the last segment must not match nested paths.** `docs/*` matches `docs/a.md` but not `docs/x/a.md`, per GitHub's docs. A naive gitignore port matches both and over-credits ownership. Pinned in Task 6.
2. **Mixed-case logins.** GitHub logins are case-insensitive. `@Role-Bot` in CODEOWNERS and a login of `role-bot` must match, and so must an author check against `Role-Bot`. Pinned in Tasks 6 and 7.
3. **An approval from a user whose permission lookup failed must not silently count.** That makes the result `wontCount` with a named reason, never a quiet `counts`. Pinned in Task 7.
4. **A latest-push record whose `after` SHA is not the PR head is stale.** The activity API can lag. Treating it as the latest push would misjudge `require_last_push_approval`, so it reads as unreadable. Pinned in Task 8.
5. **Paginated `gh api` output.** The files and reviews lists span pages. Parsing only the first page drops commentable lines and reviews. Pinned in Task 5 by using `--paginate --jq '.[]'` and parsing one JSON object per line.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/config.ts` (modify) | New settings, parsers, mode validation, the daemon-secret names, startup scrub |
| `src/config.test.ts` (modify) | Tests for the above |
| `src/supervise.ts` (create) | Spawning one detached child under active-time deadline, stall detection, redaction, transcript tail, log file, kill escalation; child registry and shutdown drain |
| `src/supervise.test.ts` (create) | Two-child drain and the log-prefix contract |
| `src/codex.ts` (modify) | Keeps Codex-specific args, env, result parsing and errors; delegates the process lifecycle to `supervise.ts`; re-exports the moved symbols so existing imports keep working |
| `src/codex.test.ts` (modify) | New env-routing tests; existing tests unchanged |
| `src/review.ts` (modify) | Pass the engine token through in dual mode |
| `src/app.ts`, `src/cli.ts` (modify) | Scrub daemon secrets after loading config; refuse dual mode; warn on a denied passthrough name |
| `src/gh-api.ts` (create) | `GhRunner` with per-call env and stdin, `GhApiError` with HTTP status, `ghApi`, `ghApiLines` |
| `src/gh-api.test.ts` (create) | Its tests |
| `src/github.ts` (modify) | Use the new runner type (no behaviour change for the existing two effects) |
| `src/approver-github.ts` (create) | `ApproverGitHub`: every call made with the approver token |
| `src/approver-github.test.ts` (create) | Argument, stdin and parse tests; `parsePatchLines` |
| `src/codeowners.ts` (create) | Pure CODEOWNERS parser and matcher |
| `src/codeowners.test.ts` (create) | GitHub's documented examples, unsupported syntax, case |
| `src/preflight.ts` (create) | Pure rule merging and `evaluateEligibility`; `gatherEligibilityFacts` fetch layer |
| `src/preflight.test.ts` (create) | Evaluator table tests and fetch-layer tests with a fake `ApproverGitHub` |
| `README.md`, `docs/superpowers/specs/2026-11-17-dual-engine-approval-design.md` (modify) | Config docs; V1 status in the spec |

---

### Task 1: Engine and credential settings in config

**Files:**
- Modify: `src/config.ts` (the `ReviewConfig` interface near line 18; `loadReviewConfig` near line 269)
- Test: `src/config.test.ts`

**Interfaces:**
- Produces:
  - `type EngineName = 'codex' | 'claude'`
  - `type EngineSchedule = 'parallel' | 'serial'`
  - `const APPROVER_TOKEN_VAR = 'APPROVER_GH_TOKEN'`
  - `const ENGINE_TOKEN_VAR = 'ENGINE_GH_TOKEN'`
  - `const DAEMON_SECRET_VARS: readonly string[]`
  - `const DUAL_MODE_AVAILABLE: boolean` (false until Plan 2)
  - `parseEngines(raw: string | undefined): EngineName[]`
  - `parseSchedule(raw: string | undefined): EngineSchedule`
  - `parseEngineOrder(raw: string | undefined, engines: EngineName[]): EngineName[]`
  - `isDualMode(config: Pick<ReviewConfig, 'reviewEngines'>): boolean`
  - `scrubDaemonSecrets(env: NodeJS.ProcessEnv): void`
  - New `ReviewConfig` fields: `reviewEngines: EngineName[]`, `engineSchedule: EngineSchedule`, `engineOrder: EngineName[]`, `approverGhToken: string`, `engineGhToken: string`, `claudeBin: string`, `claudeConfigDir: string`

- [ ] **Step 1: Write the failing tests**

Append to `src/config.test.ts`. Extend the import line to `import { APPROVER_TOKEN_VAR, DAEMON_SECRET_VARS, ENGINE_TOKEN_VAR, isDualMode, loadConfig, loadReviewConfig, looksLikeUserId, parseEngineOrder, parseEngines, parseMsList, parseSchedule, parseUserIds, scrubDaemonSecrets } from './config'`.

```ts
// Single-engine Codex must stay the default, so an install that sets nothing keeps today's
// behaviour exactly. Regression: a default that silently enabled dual mode would refuse to start.
test('parseEngines defaults to codex alone', t => {
  t.deepEqual(parseEngines(undefined), ['codex'])
  t.deepEqual(parseEngines(''), ['codex'])
  t.end()
})

// Only the two supported shapes are accepted; anything else is a startup error rather than a
// half-configured run. Catches a typo like "codx" or a claude-only mode that is out of scope.
test('parseEngines accepts codex or codex,claude and rejects everything else', t => {
  t.deepEqual(parseEngines('codex,claude'), ['codex', 'claude'])
  t.deepEqual(parseEngines('claude codex'), ['claude', 'codex'])
  t.throws(() => parseEngines('claude'), /REVIEW_ENGINES/)
  t.throws(() => parseEngines('codex,codex'), /REVIEW_ENGINES/)
  t.throws(() => parseEngines('codx'), /unknown engine "codx"/)
  t.end()
})

// The schedule is a two-value switch so serial can be turned on without code changes.
test('parseSchedule defaults to parallel and rejects unknown values', t => {
  t.equal(parseSchedule(undefined), 'parallel')
  t.equal(parseSchedule('serial'), 'serial')
  t.throws(() => parseSchedule('sequential'), /ENGINE_SCHEDULE/)
  t.end()
})

// The serial order must name each configured engine exactly once; a missing engine would never
// run and a duplicate would run twice.
test('parseEngineOrder requires a permutation of the configured engines', t => {
  t.deepEqual(parseEngineOrder(undefined, ['codex', 'claude']), ['codex', 'claude'])
  t.deepEqual(parseEngineOrder('claude,codex', ['codex', 'claude']), ['claude', 'codex'])
  t.throws(() => parseEngineOrder('codex', ['codex', 'claude']), /ENGINE_ORDER/)
  t.throws(() => parseEngineOrder('codex,codex', ['codex', 'claude']), /ENGINE_ORDER/)
  t.deepEqual(parseEngineOrder('claude,codex', ['codex']), ['codex'], 'ignored in single mode')
  t.end()
})

// Dual mode without both tokens would either approve with the wrong identity or hand engines a
// write-capable token; refuse to start instead.
test('loadReviewConfig refuses dual mode without both tokens', t => {
  t.throws(() => loadReviewConfig({ REVIEW_ENGINES: 'codex,claude' }), /APPROVER_GH_TOKEN/)
  t.throws(
    () => loadReviewConfig({ REVIEW_ENGINES: 'codex,claude', [APPROVER_TOKEN_VAR]: 'a' }),
    /ENGINE_GH_TOKEN/
  )
  t.end()
})

// The engine token must be read-only. The same value as the approver token means the engines
// would hold an approving credential, which is the attack the split exists to prevent.
test('loadReviewConfig refuses identical approver and engine tokens', t => {
  t.throws(
    () => loadReviewConfig({ REVIEW_ENGINES: 'codex,claude', [APPROVER_TOKEN_VAR]: 'same', [ENGINE_TOKEN_VAR]: 'same' }),
    /must be different tokens/
  )
  t.end()
})

// A valid dual configuration loads, and isDualMode reports it.
test('loadReviewConfig loads a valid dual configuration', t => {
  const c = loadReviewConfig({
    REVIEW_ENGINES: 'codex,claude',
    ENGINE_SCHEDULE: 'serial',
    [APPROVER_TOKEN_VAR]: 'approver-placeholder',
    [ENGINE_TOKEN_VAR]: 'engine-placeholder',
  })
  t.ok(isDualMode(c))
  t.equal(c.engineSchedule, 'serial')
  t.deepEqual(c.engineOrder, ['codex', 'claude'])
  t.equal(c.claudeBin, 'claude')
  t.ok(c.claudeConfigDir.endsWith('.claude-review-bot'))
  t.end()
})

// Single mode ignores the tokens entirely, so today's installs need no new variables.
test('loadReviewConfig in single mode needs no tokens', t => {
  const c = loadReviewConfig({})
  t.notOk(isDualMode(c))
  t.equal(c.approverGhToken, '')
  t.end()
})

// The approver token must not linger in process.env, where any later spawn that inherits the
// environment (the CodeArtifact login script, gh) would carry it.
test('scrubDaemonSecrets removes both token variables and nothing else', t => {
  const env: NodeJS.ProcessEnv = { [APPROVER_TOKEN_VAR]: 'a', [ENGINE_TOKEN_VAR]: 'e', PATH: '/bin' }
  scrubDaemonSecrets(env)
  t.deepEqual(env, { PATH: '/bin' })
  t.deepEqual([...DAEMON_SECRET_VARS].sort(), [APPROVER_TOKEN_VAR, ENGINE_TOKEN_VAR].sort())
  t.end()
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx ts-node --compiler-options '{"module":"commonjs"}' --transpile-only src/config.test.ts`
Expected: FAIL. The new exports are `undefined`, so `parseEngines is not a function`.

- [ ] **Step 3: Implement**

In `src/config.ts`, add after the imports:

```ts
/** The review engines the bot can run. */
export type EngineName = 'codex' | 'claude'
/** Whether a dual run starts both engines at once or one after the other. */
export type EngineSchedule = 'parallel' | 'serial'

const ENGINE_NAMES: readonly EngineName[] = ['codex', 'claude']

/** The role account's PAT the daemon approves with. Never reaches an engine child. */
export const APPROVER_TOKEN_VAR = 'APPROVER_GH_TOKEN'
/** The role account's read-only token, handed to engines as GH_TOKEN in dual mode. */
export const ENGINE_TOKEN_VAR = 'ENGINE_GH_TOKEN'
/** Daemon-held secrets: denied to every child and deleted from process.env at startup. */
export const DAEMON_SECRET_VARS: readonly string[] = [APPROVER_TOKEN_VAR, ENGINE_TOKEN_VAR]

/**
 * Whether dual mode can run in this build. False until the orchestrator lands
 * (https://github.com/andrew-barnett/slack-review-bot/issues/61); startup refuses dual mode while it is.
 */
export const DUAL_MODE_AVAILABLE = false
```

Add the fields to `ReviewConfig`, after `codeartifactLoginScript`:

```ts
  /** Engines to run: `['codex']` (single mode) or both (dual mode). */
  reviewEngines: EngineName[]
  /** Dual mode only: run the engines at once or one after the other. */
  engineSchedule: EngineSchedule
  /** Serial order; equals `reviewEngines` in single mode. */
  engineOrder: EngineName[]
  /** Dual mode only: the approver PAT. Empty in single mode. Never logged, never passed to a child. */
  approverGhToken: string
  /** Dual mode only: the read-only engine token. Empty in single mode. */
  engineGhToken: string
  /** Claude Code binary (Plan 2). */
  claudeBin: string
  /** Dedicated Claude config dir for the engine (Plan 2). */
  claudeConfigDir: string
```

Add the parsers after `parseList`:

```ts
/** Parse REVIEW_ENGINES: unset means Codex alone; the only other accepted shape is both engines. */
export function parseEngines(raw: string | undefined): EngineName[] {
  const list = parseList(raw)
  if (list.length === 0) return ['codex']
  for (const name of list) {
    if (!ENGINE_NAMES.includes(name as EngineName)) {
      throw new Error(`REVIEW_ENGINES: unknown engine "${name}" (expected "codex" or "codex,claude")`)
    }
  }
  const shape = [...list].sort().join(',')
  if (list.length !== new Set(list).size || (shape !== 'codex' && shape !== 'claude,codex')) {
    throw new Error(`REVIEW_ENGINES must be "codex" or "codex,claude" (got "${raw}")`)
  }
  return list as EngineName[]
}

/** Parse ENGINE_SCHEDULE: parallel unless set to serial. */
export function parseSchedule(raw: string | undefined): EngineSchedule {
  if (raw === undefined || raw.trim() === '') return 'parallel'
  if (raw === 'parallel' || raw === 'serial') return raw
  throw new Error(`ENGINE_SCHEDULE must be "parallel" or "serial" (got "${raw}")`)
}

/** Parse ENGINE_ORDER as a permutation of the configured engines; ignored in single mode. */
export function parseEngineOrder(raw: string | undefined, engines: EngineName[]): EngineName[] {
  if (engines.length < 2) return [...engines]
  const order = raw === undefined || raw.trim() === '' ? ['codex', 'claude'] : parseList(raw)
  const valid =
    order.length === engines.length &&
    new Set(order).size === order.length &&
    engines.every(engine => order.includes(engine))
  if (!valid) {
    throw new Error(`ENGINE_ORDER must list each of ${engines.join(', ')} exactly once (got "${raw}")`)
  }
  return order as EngineName[]
}

/** True when more than one engine is configured. */
export function isDualMode(config: Pick<ReviewConfig, 'reviewEngines'>): boolean {
  return config.reviewEngines.length > 1
}

/**
 * Delete the daemon-held GitHub tokens from an environment once config has read them, so no
 * later spawn that inherits process.env (the CodeArtifact login script, a bare `gh`) carries them.
 */
export function scrubDaemonSecrets(env: NodeJS.ProcessEnv): void {
  for (const name of DAEMON_SECRET_VARS) delete env[name]
}
```

Replace the body of `loadReviewConfig` so that it builds the object, validates it, and returns it:

```ts
export function loadReviewConfig(env: NodeJS.ProcessEnv = process.env): ReviewConfig {
  const home = env.HOME || os.homedir()
  const reviewEngines = parseEngines(env.REVIEW_ENGINES)
  const dual = reviewEngines.length > 1
  const config: ReviewConfig = {
    // ... every existing field exactly as it is today ...
    reviewEngines,
    engineSchedule: parseSchedule(env.ENGINE_SCHEDULE),
    engineOrder: parseEngineOrder(env.ENGINE_ORDER, reviewEngines),
    approverGhToken: dual ? env[APPROVER_TOKEN_VAR] ?? '' : '',
    engineGhToken: dual ? env[ENGINE_TOKEN_VAR] ?? '' : '',
    claudeBin: env.CLAUDE_BIN || 'claude',
    claudeConfigDir: env.CLAUDE_CONFIG_DIR_REVIEW || path.join(home, '.claude-review-bot'),
  }
  if (dual) {
    if (!config.approverGhToken) throw new Error(`${APPROVER_TOKEN_VAR} is required when REVIEW_ENGINES=codex,claude`)
    if (!config.engineGhToken) throw new Error(`${ENGINE_TOKEN_VAR} is required when REVIEW_ENGINES=codex,claude`)
    if (config.approverGhToken === config.engineGhToken) {
      throw new Error(`${APPROVER_TOKEN_VAR} and ${ENGINE_TOKEN_VAR} must be different tokens (the engine token must be read-only)`)
    }
  }
  return config
}
```

Keep every existing field and its comment unchanged where the `// ...` line is. Only the wrapping (`const config: ReviewConfig = {` … `return config`) and the new fields are added.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx ts-node --compiler-options '{"module":"commonjs"}' --transpile-only src/config.test.ts && npm run typecheck`
Expected: all `ok`; the typecheck exits 0.

- [ ] **Step 5: Confirm no code logs the whole config**

Run: `grep -nE "JSON\.stringify\(config|log\([^)]*config[,)]" src/*.ts | grep -v test`
Expected: no output. If anything prints, the new token fields would be logged; stop and report it.

- [ ] **Step 6: Commit**

```bash
git add src/config.ts src/config.test.ts
git commit -m "feat(config): add engine mode and role-account token settings (refs andrew-barnett/slack-review-bot#55)"
```

---

### Task 2: Keep the approver token out of children; route the engine token

**Files:**
- Modify: `src/codex.ts` (`buildChildEnv` near line 175; `CodexRunOptions`; `runCodexReview` near line 276)
- Modify: `src/review.ts:84-99`, `src/app.ts:80-82`, `src/cli.ts:30`
- Test: `src/codex.test.ts`

**Interfaces:**
- Consumes: `DAEMON_SECRET_VARS`, `DUAL_MODE_AVAILABLE`, `isDualMode`, `scrubDaemonSecrets` (Task 1)
- Produces:
  - `buildChildEnv(env, extraNames?)`: same signature; it now never returns a `DAEMON_SECRET_VARS` name
  - `deniedPassthrough(extraNames: readonly string[]): string[]`
  - `withEngineGhToken(env: NodeJS.ProcessEnv, token: string): NodeJS.ProcessEnv`
  - `CodexRunOptions.engineGhToken?: string`

- [ ] **Step 1: Write the failing tests**

Append to `src/codex.test.ts`, and add `deniedPassthrough, withEngineGhToken` to the `./codex` import:

```ts
// The approver token can approve PRs. If an operator names it in CODEX_ENV_PASSTHROUGH it must
// still be dropped, or untrusted PR code could read it and approve itself.
test('buildChildEnv drops daemon secrets even when passed through', t => {
  const env = buildChildEnv(
    { PATH: '/bin', APPROVER_GH_TOKEN: 'approver', ENGINE_GH_TOKEN: 'engine' },
    ['APPROVER_GH_TOKEN', 'ENGINE_GH_TOKEN']
  )
  t.deepEqual(env, { PATH: '/bin' })
  t.deepEqual(deniedPassthrough(['APPROVER_GH_TOKEN', 'FOO']), ['APPROVER_GH_TOKEN'], 'the denied name is reported for a warning')
  t.end()
})

// In dual mode engines must authenticate as the read-only engine token. An inherited
// GITHUB_TOKEN or enterprise token would otherwise give them whatever the operator's token can do.
test('withEngineGhToken sets GH_TOKEN and strips the other GitHub tokens', t => {
  const env = withEngineGhToken({ PATH: '/bin', GH_TOKEN: 'operator', GITHUB_TOKEN: 'operator2', GH_ENTERPRISE_TOKEN: 'ent' }, 'engine')
  t.deepEqual(env, { PATH: '/bin', GH_TOKEN: 'engine' })
  t.end()
})

// The runner must apply the engine token to the spawned child when one is configured.
test('runCodexReview hands the engine token to the child as GH_TOKEN', async t => {
  const child = new FakeChild()
  let seenEnv: NodeJS.ProcessEnv | undefined
  const spawner = ((_bin: string, _args: string[], opts: { env: NodeJS.ProcessEnv }) => {
    seenEnv = opts.env
    return child
  }) as unknown as Spawner
  const clock = fakeClock()
  const run = runCodexReview({ ...runOptions(), engineGhToken: 'engine-placeholder' }, spawner, clock.deps).catch(() => undefined)
  await settle()
  child.emit('close', 1)
  await run
  t.equal(seenEnv?.GH_TOKEN, 'engine-placeholder')
  t.notOk('GITHUB_TOKEN' in (seenEnv ?? {}), 'no other GitHub token survives')
  t.end()
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx ts-node --compiler-options '{"module":"commonjs"}' --transpile-only src/codex.test.ts`
Expected: FAIL. `deniedPassthrough is not a function`.

- [ ] **Step 3: Implement in `src/codex.ts`**

Change the config import to `import { CODEX_ENV_ALLOWLIST, CODEX_ENV_ALLOWLIST_PREFIXES, DAEMON_SECRET_VARS } from './config'`. Replace `buildChildEnv`, and add the two helpers after it:

```ts
export function buildChildEnv(
  env: NodeJS.ProcessEnv,
  extraNames: readonly string[] = []
): NodeJS.ProcessEnv {
  const allowed = new Set<string>([...CODEX_ENV_ALLOWLIST, ...extraNames])
  // Daemon-held tokens are denied outright, even when an operator names them as passthrough:
  // the approver token can approve PRs, and engines run untrusted PR code.
  for (const name of DAEMON_SECRET_VARS) allowed.delete(name)
  const out: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue
    if (DAEMON_SECRET_VARS.includes(key)) continue
    if (allowed.has(key) || CODEX_ENV_ALLOWLIST_PREFIXES.some(prefix => key.startsWith(prefix))) {
      out[key] = value
    }
  }
  return out
}

/** The passthrough names that will be ignored because they are daemon secrets; for a startup warning. */
export function deniedPassthrough(extraNames: readonly string[]): string[] {
  return extraNames.filter(name => DAEMON_SECRET_VARS.includes(name))
}

/**
 * Point the child's `gh` at the read-only engine token. GH_TOKEN wins over GITHUB_TOKEN in gh,
 * but both other token variables are removed anyway, so nothing else the child runs (a PR's test
 * script, for example) finds a broader credential.
 */
export function withEngineGhToken(env: NodeJS.ProcessEnv, token: string): NodeJS.ProcessEnv {
  const copy: NodeJS.ProcessEnv = { ...env }
  delete copy.GITHUB_TOKEN
  delete copy.GH_ENTERPRISE_TOKEN
  copy.GH_TOKEN = token
  return copy
}
```

Add to `CodexRunOptions` after `envPassthrough`:

```ts
  /** Dual mode: the read-only engine token, set as the child's GH_TOKEN. Undefined in single mode. */
  engineGhToken?: string
```

In `runCodexReview`, after `if (options.disableGitSigning) env = withGitSigningDisabled(env)`, add:

```ts
  if (options.engineGhToken) env = withEngineGhToken(env, options.engineGhToken)
```

- [ ] **Step 4: Wire the callers**

In `src/review.ts`, add `isDualMode` to the `./config` import and pass the token in the `runCodex({...})` call (after `envPassthrough: config.codexEnvPassthrough,`):

```ts
          engineGhToken: isDualMode(config) ? config.engineGhToken : undefined,
```

In `src/app.ts`, change the import on line 23 to `import { DUAL_MODE_AVAILABLE, isDualMode, loadConfig, looksLikeUserId, scrubDaemonSecrets } from './config'`, add `deniedPassthrough` to the `./codex` import, and directly after `const config = loadConfig()` in `main()` add:

```ts
  // The tokens now live only in `config`; drop them from the environment every later spawn inherits.
  scrubDaemonSecrets(process.env)
  if (isDualMode(config) && !DUAL_MODE_AVAILABLE) {
    throw new Error('REVIEW_ENGINES=codex,claude is not available in this build yet (https://github.com/andrew-barnett/slack-review-bot/issues/61)')
  }
  const denied = deniedPassthrough(config.codexEnvPassthrough)
  if (denied.length) {
    log('config.passthrough_denied', { names: denied, hint: 'daemon-held tokens never reach the review child' })
  }
```

In `src/cli.ts`, change the import to `import { DUAL_MODE_AVAILABLE, isDualMode, loadReviewConfig, scrubDaemonSecrets } from './config'`, and after `const config = loadReviewConfig()` add:

```ts
  scrubDaemonSecrets(process.env)
  if (isDualMode(config) && !DUAL_MODE_AVAILABLE) {
    process.stderr.write('REVIEW_ENGINES=codex,claude is not available in this build yet.\n')
    process.exitCode = 2
    return
  }
```

- [ ] **Step 5: Run the full suite and typecheck**

Run: `npm test 2>&1 | tail -5 && npm run typecheck`
Expected: `# fail  0` (no failures); the typecheck exits 0.

- [ ] **Step 6: Commit**

```bash
git add src/codex.ts src/codex.test.ts src/review.ts src/app.ts src/cli.ts
git commit -m "feat(security): deny daemon tokens to review children and route the engine token (refs andrew-barnett/slack-review-bot#55)"
```

---

### Task 3: Extract process supervision into `supervise.ts`

No behaviour change. The existing `codex.test.ts` suite is the regression net, and it must pass **unmodified** apart from the Task 2 additions. Moved symbols are re-exported from `codex.ts`, so `app.ts`, `review.ts`, `config.test.ts` and `codex.test.ts` keep importing from `./codex`.

**Files:**
- Create: `src/supervise.ts`, `src/supervise.test.ts`
- Modify: `src/codex.ts`

**Interfaces:**
- Produces (in `src/supervise.ts`):
  - `TRANSCRIPT_TAIL_LIMIT`, `appendBoundedTail`, `ChildRegistry`, `createChildRegistry`, `SHUTDOWN_GRACE_MS`, `SHUTDOWN_POLL_MS`, `DrainDeps` and `drainChildRegistry`, moved verbatim
  - `killProcessTree(child: ChildProcess, signal: NodeJS.Signals): void`, now exported
  - `type Spawner = typeof spawn`
  - `interface SuperviseOptions { bin: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number; stallTimeoutMs?: number; registry?: ChildRegistry; logDir?: string; logName: string; runId: string; logPrefix: string; log?: (event: string, fields: Record<string, unknown>) => void; onProgress?: (line: string, activeMs: number) => void }`
  - `interface SupervisedExit { code: number | null; timedOut?: DeadlineSnapshot; stalled?: DeadlineSnapshot; activeMs: number; transcript: string }`
  - `superviseChild(options: SuperviseOptions, spawner?: Spawner, clock?: Partial<DeadlineDeps>): Promise<SupervisedExit>`

- [ ] **Step 1: Write the failing tests**

Create `src/supervise.test.ts`:

```ts
import type { ChildProcess } from 'child_process'
import { EventEmitter } from 'events'
import { PassThrough } from 'stream'
import test from 'tape'
import { createChildRegistry, drainChildRegistry, superviseChild, type Spawner } from './supervise'

class FakeChild extends EventEmitter {
  pid: number | undefined = undefined
  stdout = new PassThrough()
  stderr = new PassThrough()
  signals: string[] = []
  kill(signal?: NodeJS.Signals | number): boolean {
    this.signals.push(String(signal))
    this.emit('close', null)
    return true
  }
}

// Dual mode runs two engine children at once. Shutdown must stop both, not just the first one
// registered. Regression: a drain that returned after one child exited would orphan the other.
test('drainChildRegistry stops two concurrent children', async t => {
  const registry = createChildRegistry()
  const a = new FakeChild()
  const b = new FakeChild()
  registry.add(a as unknown as ChildProcess)
  registry.add(b as unknown as ChildProcess)
  // FakeChild exits on the first signal; deregister on close as the real run's close handler does.
  a.on('close', () => registry.remove(a as unknown as ChildProcess))
  b.on('close', () => registry.remove(b as unknown as ChildProcess))
  let now = 0
  await drainChildRegistry(registry, {
    now: () => now,
    setTimer: (fn, ms) => {
      now += ms
      return setTimeout(fn, 0)
    },
    graceMs: 1_000,
    pollMs: 100,
  })
  t.deepEqual(a.signals, ['SIGTERM'])
  t.deepEqual(b.signals, ['SIGTERM'])
  t.equal(registry.size(), 0, 'both deregistered')
  t.end()
})

// Each engine's events must stay distinguishable in the daemon log, so the event names carry the
// caller's prefix. Codex keeps "codex.*" (the names operators already grep for).
test('superviseChild returns the redacted transcript and uses the log prefix', async t => {
  const child = new FakeChild()
  const spawner = (() => child) as unknown as Spawner
  const events: string[] = []
  const run = superviseChild(
    {
      bin: 'x', args: [], cwd: '/', env: {}, timeoutMs: 60_000, stallTimeoutMs: 0,
      logName: 'n', runId: 'r', logPrefix: 'claude', log: event => events.push(event),
    },
    spawner,
    { setInterval: () => 1 as unknown as ReturnType<typeof setInterval>, clearInterval: () => {} }
  )
  child.stdout.write('hello\n')
  await new Promise(resolve => setImmediate(resolve))
  child.emit('close', 0)
  const exit = await run
  t.equal(exit.code, 0)
  t.ok(exit.transcript.includes('hello'), 'output reaches the transcript')
  t.ok(events.every(event => event.startsWith('claude.')), 'any event uses the given prefix')
  t.end()
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx ts-node --compiler-options '{"module":"commonjs"}' --transpile-only src/supervise.test.ts`
Expected: FAIL with `Cannot find module './supervise'`.

- [ ] **Step 3: Create `src/supervise.ts`**

1. Start the file with:

```ts
// Running one detached child under an active-time deadline, with stall detection, output
// redaction, a bounded transcript tail and a run log. Shared by every review engine so each
// gets the same supervision; the engines keep only their own arguments and output parsing.

import { spawn, type ChildProcess } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'
import { startActiveDeadline, type DeadlineDeps, type DeadlineSnapshot } from './deadline'
import { createOutputRedactor } from './redact'

/** Injection seam so tests can drive the process lifecycle without a real child. */
export type Spawner = typeof spawn
```

2. **Move verbatim** from `src/codex.ts` into `supervise.ts`, keeping every comment:
   - `TRANSCRIPT_TAIL_LIMIT` and its doc comment
   - `appendBoundedTail`
   - `ChildRegistry` and `createChildRegistry`
   - `SHUTDOWN_GRACE_MS` and `SHUTDOWN_POLL_MS`
   - `DrainDeps` and `drainChildRegistry`
   - `killProcessTree` (add `export`)
   - `makeLogAppender`

   Change its file-name parameter: `makeLogAppender(logDir: string | undefined, logName: string)`, writing `${logName}.log`.

3. Add `SuperviseOptions` and `SupervisedExit` exactly as in **Interfaces** above, each field with a one-line doc comment copied from the matching `CodexRunOptions` field. `logName` is "Base name of the run log file (without .log)". `logPrefix` is "Prefix for this child's log events: `<prefix>.frozen`, `<prefix>.stalled`".

4. Add `superviseChild`. Its body is the `new Promise<...>((resolve, reject) => { ... })` block moved **verbatim** from `runCodexReview` in `src/codex.ts` (from `const child = spawner(options.codexBin, args, {` through `resolve({ code, timedOut, stalled, activeMs })`), wrapped like this, with only the substitutions listed below:

```ts
export function superviseChild(
  options: SuperviseOptions,
  spawner: Spawner = spawn,
  clock: Partial<DeadlineDeps> = {}
): Promise<SupervisedExit> {
  let transcript = ''
  // makeLogAppender creates logDir itself; superviseChild creates no other directory.
  const appendLog = makeLogAppender(options.logDir, options.logName)
  return new Promise<SupervisedExit>((resolve, reject) => {
    // <moved block>
  })
}
```

   Substitutions inside the moved block:
   - `spawner(options.codexBin, args, { cwd: options.workspaceRoot, env, ...` → `spawner(options.bin, options.args, { cwd: options.cwd, env: options.env, ...`
   - `'codex.frozen'` → `` `${options.logPrefix}.frozen` ``
   - `'codex.stalled'` → `` `${options.logPrefix}.stalled` ``
   - the final `resolve({ code, timedOut, stalled, activeMs })` → `resolve({ code, timedOut, stalled, activeMs, transcript })`

   All other lines are unchanged: the kill escalation, `cleanupChild`, the deadline wiring, `publish`, the two redactors, `flushOutput`, and the `error`/`close` handlers.

- [ ] **Step 4: Make `runCodexReview` delegate**

In `src/codex.ts`:
- Delete the moved definitions.
- Remove the now-unused imports (`spawn`/`ChildProcess` if unused, `startActiveDeadline`, `createOutputRedactor`).
- Add:

```ts
import {
  appendBoundedTail,
  createChildRegistry,
  drainChildRegistry,
  SHUTDOWN_GRACE_MS,
  SHUTDOWN_POLL_MS,
  superviseChild,
  TRANSCRIPT_TAIL_LIMIT,
  type ChildRegistry,
  type DrainDeps,
  type Spawner,
} from './supervise'
import { spawn } from 'child_process'

// Re-exported so existing imports from './codex' keep working after the extraction.
export {
  appendBoundedTail,
  createChildRegistry,
  drainChildRegistry,
  SHUTDOWN_GRACE_MS,
  SHUTDOWN_POLL_MS,
  TRANSCRIPT_TAIL_LIMIT,
  type ChildRegistry,
  type DrainDeps,
  type Spawner,
}
```

Delete the old `export type Spawner = typeof spawn`. In `runCodexReview`:
- delete the `let transcript = ''` and `const appendLog = ...` lines;
- replace the whole `const exit = await new Promise<...>(...)` statement with:

```ts
    const exit = await superviseChild(
      {
        bin: options.codexBin,
        args,
        cwd: options.workspaceRoot,
        env,
        timeoutMs: options.timeoutMs,
        stallTimeoutMs: options.stallTimeoutMs,
        registry: options.registry,
        logDir: options.logDir,
        logName: options.runId,
        runId: options.runId,
        logPrefix: 'codex',
        log: options.log,
        onProgress: options.onProgress,
      },
      spawner,
      clock
    )
    const transcript = exit.transcript
```

Everything after it (the timeout and stall throws, `parseTokensUsed(transcript)`, the final-message handling) stays unchanged.

- [ ] **Step 5: Run the full suite and typecheck**

Run: `npm test 2>&1 | tail -5 && npm run typecheck && git diff --stat src/codex.test.ts`
Expected:
- `# fail  0`;
- the typecheck exits 0;
- `codex.test.ts` shows only the Task 2 additions (no edits to existing tests).

- [ ] **Step 6: Commit**

```bash
git add src/supervise.ts src/supervise.test.ts src/codex.ts
git commit -m "refactor: extract child-process supervision into supervise.ts (refs andrew-barnett/slack-review-bot#57)"
```

---

### Task 4: `gh` runner with per-call env and stdin

**Files:**
- Create: `src/gh-api.ts`, `src/gh-api.test.ts`
- Modify: `src/github.ts` (move `GhRunner`, `defaultRunner`, `GH_COMMAND_TIMEOUT_MS` into `gh-api.ts` and re-export them)

**Interfaces:**
- Produces:
  - `type GhCallOptions = { env?: NodeJS.ProcessEnv; input?: string }`
  - `type GhRunner = (args: string[], opts?: GhCallOptions) => Promise<string>`
  - `GH_COMMAND_TIMEOUT_MS = 30_000`
  - `defaultRunner(bin: string, timeoutMs?: number, exec?: ExecFn): GhRunner`
  - `class GhApiError extends Error { status: number | undefined }`
  - `httpStatusOf(error: unknown): number | undefined`
  - `ghApi<T>(run: GhRunner, path: string, opts?: { method?: 'GET' | 'POST' | 'PUT'; body?: unknown }): Promise<T>`
  - `ghApiLines<T>(run: GhRunner, path: string): Promise<T[]>` (paginated)

- [ ] **Step 1: Write the failing tests**

Create `src/gh-api.test.ts`:

```ts
import test from 'tape'
import { defaultRunner, GH_COMMAND_TIMEOUT_MS, GhApiError, ghApi, ghApiLines, httpStatusOf } from './gh-api'

// Request bodies can carry finding text written by a model from untrusted PR content. They must go
// over stdin, never argv, so nothing is shell-interpreted or visible in a process listing.
test('ghApi sends a body on stdin with --input -', async t => {
  const calls: { args: string[]; input?: string }[] = []
  const out = await ghApi<{ id: number }>(async (args, opts) => {
    calls.push({ args, input: opts?.input })
    return '{"id":7}'
  }, 'repos/o/r/pulls/1/reviews', { method: 'POST', body: { event: 'COMMENT' } })
  t.deepEqual(calls[0].args, ['api', 'repos/o/r/pulls/1/reviews', '--method', 'POST', '--input', '-'])
  t.equal(calls[0].input, '{"event":"COMMENT"}')
  t.deepEqual(out, { id: 7 })
  t.end()
})

// Callers must tell "absent" (404) from "failed" (anything else). The pre-flight treats an absent
// branch protection as no requirement but a 403 as unreadable.
test('ghApi surfaces the HTTP status of a failed call', async t => {
  const failing = async () => {
    const error = new Error('Command failed') as Error & { stderr: string }
    error.stderr = 'gh: Not Found (HTTP 404)'
    throw error
  }
  try {
    await ghApi(failing, 'repos/o/r/branches/main/protection')
    t.fail('should throw')
  } catch (error) {
    t.ok(error instanceof GhApiError)
    t.equal((error as GhApiError).status, 404)
  }
  t.equal(httpStatusOf(new Error('no status here')), undefined)
  t.end()
})

// Lists span pages. --paginate with --jq '.[]' yields one JSON object per line across all pages,
// so a second page is never silently dropped (Review Focus 5).
test('ghApiLines paginates and parses one object per line', async t => {
  let seen: string[] = []
  const items = await ghApiLines<{ n: number }>(async args => {
    seen = args
    return '{"n":1}\n{"n":2}\n\n{"n":3}\n'
  }, 'repos/o/r/pulls/1/files')
  t.deepEqual(seen, ['api', '--paginate', 'repos/o/r/pulls/1/files', '--jq', '.[]'])
  t.deepEqual(items.map(i => i.n), [1, 2, 3])
  t.end()
})

// The approver token is passed per call through env. The runner must forward env and input to the
// exec, and keep the finite timeout (issue 17's guarantee).
test('defaultRunner forwards env and input with the timeout', async t => {
  let seen: Record<string, unknown> | undefined
  const run = defaultRunner('gh', GH_COMMAND_TIMEOUT_MS, async (_bin, _args, opts) => {
    seen = opts as unknown as Record<string, unknown>
    return { stdout: '' }
  })
  await run(['api', 'user'], { env: { GH_TOKEN: 'placeholder' }, input: '{}' })
  t.equal(seen?.timeout, GH_COMMAND_TIMEOUT_MS)
  t.deepEqual(seen?.env, { GH_TOKEN: 'placeholder' })
  t.equal(seen?.input, '{}')
  t.end()
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx ts-node --compiler-options '{"module":"commonjs"}' --transpile-only src/gh-api.test.ts`
Expected: FAIL with `Cannot find module './gh-api'`.

- [ ] **Step 3: Create `src/gh-api.ts`**

```ts
// The one way the bot talks to `gh`: a bounded runner with an optional per-call environment
// (how the approver token reaches gh without ever entering process.env) and stdin input (how
// request bodies avoid argv), plus small JSON helpers that keep the HTTP status of a failure.

import { execFile } from 'child_process'

export type GhCallOptions = { env?: NodeJS.ProcessEnv; input?: string }

/** Runs `gh` with the given args and returns stdout. Swapped out in tests. */
export type GhRunner = (args: string[], opts?: GhCallOptions) => Promise<string>

/**
 * Per-call timeout for `gh`. A `gh` wedged on a network stall would otherwise pin the review slot;
 * a finite timeout turns the hang into a rejection the callers already handle.
 */
export const GH_COMMAND_TIMEOUT_MS = 30_000

export type ExecOpts = {
  maxBuffer: number
  timeout: number
  killSignal: NodeJS.Signals
  env?: NodeJS.ProcessEnv
  input?: string
}
type ExecFn = (bin: string, args: string[], opts: ExecOpts) => Promise<{ stdout: string }>

const realExec: ExecFn = (bin, args, opts) =>
  new Promise((resolve, reject) => {
    const { input, ...execOpts } = opts
    const child = execFile(bin, args, execOpts, (error, stdout, stderr) => {
      if (error) {
        // Keep stderr on the error: it carries gh's "(HTTP 404)" marker that httpStatusOf reads.
        Object.assign(error, { stderr: String(stderr) })
        reject(error)
        return
      }
      resolve({ stdout: String(stdout) })
    })
    child.stdin?.end(input ?? '')
  })

export function defaultRunner(
  bin: string,
  timeoutMs: number = GH_COMMAND_TIMEOUT_MS,
  exec: ExecFn = realExec
): GhRunner {
  return async (args, opts = {}) => {
    const { stdout } = await exec(bin, args, {
      // A large PR can list many files; 10 MB is far more than any real response reaches.
      maxBuffer: 10 * 1024 * 1024,
      timeout: timeoutMs,
      killSignal: 'SIGKILL',
      ...(opts.env ? { env: opts.env } : {}),
      ...(opts.input !== undefined ? { input: opts.input } : {}),
    })
    return stdout
  }
}

/** A failed `gh api` call, with the HTTP status when gh reported one. */
export class GhApiError extends Error {
  constructor(message: string, readonly status: number | undefined) {
    super(message)
    this.name = 'GhApiError'
  }
}

/** Read gh's "(HTTP nnn)" marker from an error's stderr or message. */
export function httpStatusOf(error: unknown): number | undefined {
  const text = `${(error as { stderr?: string })?.stderr ?? ''} ${(error as Error)?.message ?? ''}`
  const match = /\(HTTP (\d{3})\)/.exec(text)
  return match ? Number(match[1]) : undefined
}

function toGhApiError(path: string, error: unknown): GhApiError {
  const status = httpStatusOf(error)
  return new GhApiError(`gh api ${path} failed${status ? ` (HTTP ${status})` : ''}`, status)
}

/** Call `gh api` and parse the JSON response; a body goes over stdin. */
export async function ghApi<T>(
  run: GhRunner,
  path: string,
  opts: { method?: 'GET' | 'POST' | 'PUT'; body?: unknown } = {}
): Promise<T> {
  const args = ['api', path]
  if (opts.method && opts.method !== 'GET') args.push('--method', opts.method)
  if (opts.body !== undefined) args.push('--input', '-')
  let stdout: string
  try {
    stdout = await run(args, opts.body !== undefined ? { input: JSON.stringify(opts.body) } : undefined)
  } catch (error) {
    throw toGhApiError(path, error)
  }
  return (stdout.trim() ? JSON.parse(stdout) : undefined) as T
}

/** Call a list endpoint across every page; returns the concatenated items. */
export async function ghApiLines<T>(run: GhRunner, path: string): Promise<T[]> {
  let stdout: string
  try {
    stdout = await run(['api', '--paginate', path, '--jq', '.[]'])
  } catch (error) {
    throw toGhApiError(path, error)
  }
  return stdout
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => JSON.parse(line) as T)
}
```

- [ ] **Step 4: Point `src/github.ts` at it**

In `src/github.ts`:
- delete `execFile`, `promisify`, `execFileAsync`, `GhRunner`, `GH_COMMAND_TIMEOUT_MS`, `ExecFn` and `defaultRunner`;
- add:

```ts
import { defaultRunner, GH_COMMAND_TIMEOUT_MS, type GhRunner } from './gh-api'

// Re-exported so existing imports from './github' keep working.
export { defaultRunner, GH_COMMAND_TIMEOUT_MS, type GhRunner }
```

The existing `github.test.ts` timeout test passes a three-argument fake exec. It must still pass, because `defaultRunner`'s exec parameter type is a superset.

- [ ] **Step 5: Run the full suite and typecheck**

Run: `npm test 2>&1 | tail -5 && npm run typecheck`
Expected: `# fail  0`; the typecheck exits 0.

- [ ] **Step 6: Commit**

```bash
git add src/gh-api.ts src/gh-api.test.ts src/github.ts
git commit -m "feat(github): add gh runner with per-call env and stdin input (refs andrew-barnett/slack-review-bot#60)"
```

---

### Task 5: `ApproverGitHub` effects

**Files:**
- Create: `src/approver-github.ts`, `src/approver-github.test.ts`

**Interfaces:**
- Consumes: `GhRunner`, `defaultRunner`, `ghApi`, `ghApiLines`, `GhApiError` (Task 4); `PullRequestRef` from `src/parse-message.ts` (`{ owner, repo, number, url }`)
- Produces:

```ts
export type Permission = 'admin' | 'maintain' | 'write' | 'triage' | 'read' | 'none'
export interface PullRequestInfo { author: string; base: string; headRef: string; headSha: string; headRepo: string; baseRepo: string; state: string; draft: boolean }
export interface ReviewFact { login: string; state: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED' | 'PENDING'; submittedAt: string }
export interface LatestPush { actor: string; at: string; afterSha: string }
export interface ReviewComment { path: string; line: number; side: 'RIGHT'; body: string }
export interface PostedReview { id: number; url: string }
export interface BotReview { login: string; commitId: string; state: string }
export interface Decision { reviewDecision: string | null; mergeStateStatus: string }
export interface ApproverGitHub {
  login(): Promise<string>
  getPullRequest(pr: PullRequestRef): Promise<PullRequestInfo>
  permission(pr: PullRequestRef, login: string): Promise<Permission>
  branchRules(pr: PullRequestRef, branch: string): Promise<unknown[]>
  classicProtection(pr: PullRequestRef, branch: string): Promise<unknown | null>   // null = not protected (404)
  fileAt(pr: PullRequestRef, path: string, ref: string): Promise<string | null>      // null = no such file (404)
  codeownersErrorCount(pr: PullRequestRef, ref: string): Promise<number>
  isTeamMember(org: string, team: string, login: string): Promise<boolean>
  reviews(pr: PullRequestRef): Promise<ReviewFact[]>
  latestPush(pr: PullRequestRef, headRef: string): Promise<LatestPush | null>          // null = no record
  commentableLines(pr: PullRequestRef): Promise<Map<string, Set<number>>>
  updateBranch(pr: PullRequestRef, expectedHeadSha: string): Promise<{ ok: true } | { ok: false; status: number | undefined }>
  postReview(pr: PullRequestRef, review: { commitId: string; event: 'APPROVE' | 'COMMENT'; body: string; comments: ReviewComment[] }): Promise<PostedReview>
  botReviews(pr: PullRequestRef, botLogin: string): Promise<BotReview[]>
  decision(pr: PullRequestRef): Promise<Decision>
}
export function parsePatchLines(patch: string): Set<number>
export function makeApproverGitHub(token: string, run?: GhRunner): ApproverGitHub
```

Every method rejects with `GhApiError` on failure, except the documented 404 → `null` / `false` cases. Callers decide what a failure means.

- [ ] **Step 1: Write the failing tests**

Create `src/approver-github.test.ts`:

```ts
import test from 'tape'
import { makeApproverGitHub, parsePatchLines } from './approver-github'
import type { GhCallOptions } from './gh-api'

const pr = { owner: 'o', repo: 'r', number: 5, url: 'https://github.com/o/r/pull/5' }

function recorder(responses: Record<string, string | Error>) {
  const calls: { args: string[]; opts?: GhCallOptions }[] = []
  const run = async (args: string[], opts?: GhCallOptions) => {
    calls.push({ args, opts })
    const key = args.find(a => a.startsWith('repos/') || a.startsWith('orgs/') || a === 'graphql' || a === 'user') ?? ''
    const response = responses[key]
    if (response instanceof Error) throw response
    return response ?? ''
  }
  return { calls, run }
}

function httpError(status: number): Error {
  return Object.assign(new Error('failed'), { stderr: `gh: x (HTTP ${status})` })
}

// Every call must carry the approver token as GH_TOKEN in its own env, so the token never needs
// to live in process.env (spec section 5.7).
test('every approver call passes the token in the per-call env', async t => {
  const { calls, run } = recorder({ user: '{"login":"role-bot"}' })
  const gh = makeApproverGitHub('approver-placeholder', run)
  t.equal(await gh.login(), 'role-bot')
  t.equal(calls[0].opts?.env?.GH_TOKEN, 'approver-placeholder')
  t.end()
})

// An approval tied to commit_id is the whole point: the review applies to the commit both
// engines reviewed, never to whatever the head became. Body and comments go over stdin.
test('postReview posts commit_id, event, body and RIGHT-side comments on stdin', async t => {
  const { calls, run } = recorder({ 'repos/o/r/pulls/5/reviews': '{"id":9,"html_url":"https://x/9"}' })
  const gh = makeApproverGitHub('tok', run)
  const posted = await gh.postReview(pr, {
    commitId: 'a'.repeat(40),
    event: 'APPROVE',
    body: 'both clean',
    comments: [{ path: 'src/a.ts', line: 3, side: 'RIGHT', body: '**[Codex · NON-BLOCKING]** nit' }],
  })
  t.deepEqual(posted, { id: 9, url: 'https://x/9' })
  t.deepEqual(calls[0].args, ['api', 'repos/o/r/pulls/5/reviews', '--method', 'POST', '--input', '-'])
  t.deepEqual(JSON.parse(calls[0].opts?.input ?? '{}'), {
    commit_id: 'a'.repeat(40),
    event: 'APPROVE',
    body: 'both clean',
    comments: [{ path: 'src/a.ts', line: 3, side: 'RIGHT', body: '**[Codex · NON-BLOCKING]** nit' }],
  })
  t.end()
})

// 404 on classic protection means "not protected" (no requirement), while 403 means the token
// could not read it. Conflating them would either invent or hide a requirement.
test('classicProtection maps 404 to null and rethrows other failures', async t => {
  const absent = makeApproverGitHub('tok', recorder({ 'repos/o/r/branches/main/protection': httpError(404) }).run)
  t.equal(await absent.classicProtection(pr, 'main'), null)
  const denied = makeApproverGitHub('tok', recorder({ 'repos/o/r/branches/main/protection': httpError(403) }).run)
  try {
    await denied.classicProtection(pr, 'main')
    t.fail('403 must throw')
  } catch (error) {
    t.equal((error as { status?: number }).status, 403)
  }
  t.end()
})

// A 422 from update-branch is a merge conflict or a moved head. It is a normal outcome the
// orchestrator reports, not a crash.
test('updateBranch reports 422 as not ok', async t => {
  const gh = makeApproverGitHub('tok', recorder({ 'repos/o/r/pulls/5/update-branch': httpError(422) }).run)
  t.deepEqual(await gh.updateBranch(pr, 'b'.repeat(40)), { ok: false, status: 422 })
  t.end()
})

// Membership is "active" only. A pending invitation does not make someone an owner, and 404 (not
// a member) is false rather than an error.
test('isTeamMember is true only for an active membership', async t => {
  t.equal(await makeApproverGitHub('tok', recorder({ 'orgs/acme/teams/pay/memberships/u': '{"state":"active"}' }).run).isTeamMember('acme', 'pay', 'u'), true)
  t.equal(await makeApproverGitHub('tok', recorder({ 'orgs/acme/teams/pay/memberships/u': '{"state":"pending"}' }).run).isTeamMember('acme', 'pay', 'u'), false)
  t.equal(await makeApproverGitHub('tok', recorder({ 'orgs/acme/teams/pay/memberships/u': httpError(404) }).run).isTeamMember('acme', 'pay', 'u'), false)
  t.end()
})

// Only added and context lines on the new side can carry an inline comment. Deleted lines and
// lines outside every hunk must fall back to the review body.
test('parsePatchLines returns RIGHT-side added and context lines', t => {
  const patch = ['@@ -1,3 +1,4 @@', ' keep', '-gone', '+new1', '+new2', ' tail', '@@ -20,2 +21,1 @@', '-x', ' y'].join('\n')
  t.deepEqual([...parsePatchLines(patch)].sort((a, b) => a - b), [1, 2, 3, 4, 21])
  t.deepEqual([...parsePatchLines('')], [], 'a binary or empty patch has no commentable lines')
  t.end()
})

// The latest-push record must be for the current head. The activity API can lag, and a stale
// record would misjudge require_last_push_approval (Review Focus 4). The fetch layer compares
// afterSha with the head; this test pins that the field is populated.
test('latestPush returns actor, time and after-SHA of the newest push', async t => {
  const { calls, run } = recorder({
    'repos/o/r/activity?ref=refs%2Fheads%2Ffeat%2Fx&activity_type=push&per_page=1':
      '[{"actor":{"login":"dev"},"timestamp":"2026-11-17T10:00:00Z","after":"c0ffee"}]',
  })
  const push = await makeApproverGitHub('tok', run).latestPush(pr, 'feat/x')
  t.deepEqual(push, { actor: 'dev', at: '2026-11-17T10:00:00Z', afterSha: 'c0ffee' })
  t.ok(calls[0].args.includes('repos/o/r/activity?ref=refs%2Fheads%2Ffeat%2Fx&activity_type=push&per_page=1'))
  t.end()
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx ts-node --compiler-options '{"module":"commonjs"}' --transpile-only src/approver-github.test.ts`
Expected: FAIL with `Cannot find module './approver-github'`.

- [ ] **Step 3: Implement `src/approver-github.ts`**

```ts
// Every GitHub call the daemon makes as the role account, with the approver token. The token is
// handed to gh per call (GH_TOKEN in that call's env) and never placed in process.env, and it is
// never given to an engine child (spec sections 5.7 and 9).

import { defaultRunner, ghApi, ghApiLines, GhApiError, type GhRunner } from './gh-api'
import type { PullRequestRef } from './parse-message'

// <paste the exported types from this task's Interfaces block here, unchanged>

const repoPath = (pr: PullRequestRef) => `repos/${pr.owner}/${pr.repo}`

/** Commentable new-side line numbers in a unified-diff patch: added (+) and context ( ) lines. */
export function parsePatchLines(patch: string): Set<number> {
  const lines = new Set<number>()
  let next = 0
  let inHunk = false
  for (const raw of patch.split('\n')) {
    const header = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw)
    if (header) {
      next = Number(header[1])
      inHunk = true
      continue
    }
    if (!inHunk) continue
    if (raw.startsWith('+') || raw.startsWith(' ')) {
      lines.add(next)
      next += 1
    }
    // '-' lines and '\ No newline at end of file' do not advance the new side.
  }
  return lines
}

async function orNullOn404<T>(call: Promise<T>): Promise<T | null> {
  try {
    return await call
  } catch (error) {
    if (error instanceof GhApiError && error.status === 404) return null
    throw error
  }
}

export function makeApproverGitHub(token: string, run: GhRunner = defaultRunner('gh')): ApproverGitHub {
  // Every call made through this runner authenticates as the role account.
  const asApprover: GhRunner = (args, opts = {}) =>
    run(args, { ...opts, env: { ...process.env, ...opts.env, GH_TOKEN: token } })

  const graphql = <T>(query: string, variables: Record<string, unknown>) =>
    ghApi<{ data: T }>(asApprover, 'graphql', { method: 'POST', body: { query, variables } }).then(r => r.data)

  return {
    async login() {
      return (await ghApi<{ login: string }>(asApprover, 'user')).login
    },
    async getPullRequest(pr) {
      const p = await ghApi<{
        user: { login: string }
        base: { ref: string; repo: { full_name: string } }
        head: { ref: string; sha: string; repo: { full_name: string } | null }
        state: string
        draft: boolean
      }>(asApprover, `${repoPath(pr)}/pulls/${pr.number}`)
      return {
        author: p.user.login,
        base: p.base.ref,
        baseRepo: p.base.repo.full_name,
        headRef: p.head.ref,
        headSha: p.head.sha,
        // A deleted fork has no repo; treat it as foreign so the latest pusher reads as unverifiable.
        headRepo: p.head.repo?.full_name ?? '',
        state: p.state,
        draft: p.draft,
      }
    },
    async permission(pr, login) {
      const r = await ghApi<{ permission: Permission; role_name?: string }>(
        asApprover,
        `${repoPath(pr)}/collaborators/${encodeURIComponent(login)}/permission`
      )
      // role_name carries maintain/triage, which the legacy `permission` field folds into write/read.
      const role = r.role_name as Permission | undefined
      return role && ['admin', 'maintain', 'write', 'triage', 'read'].includes(role) ? role : r.permission
    },
    async branchRules(pr, branch) {
      return ghApiLines<unknown>(asApprover, `${repoPath(pr)}/rules/branches/${encodeURIComponent(branch)}`)
    },
    async classicProtection(pr, branch) {
      return orNullOn404(ghApi<unknown>(asApprover, `${repoPath(pr)}/branches/${encodeURIComponent(branch)}/protection`))
    },
    async fileAt(pr, filePath, ref) {
      const file = await orNullOn404(
        ghApi<{ content: string; encoding: string }>(asApprover, `${repoPath(pr)}/contents/${filePath}?ref=${encodeURIComponent(ref)}`)
      )
      return file ? Buffer.from(file.content, 'base64').toString('utf8') : null
    },
    async codeownersErrorCount(pr, ref) {
      const r = await orNullOn404(ghApi<{ errors: unknown[] }>(asApprover, `${repoPath(pr)}/codeowners/errors?ref=${encodeURIComponent(ref)}`))
      // 404 means there is no CODEOWNERS file, so there are no errors to report.
      return r ? r.errors.length : 0
    },
    async isTeamMember(org, team, login) {
      const r = await orNullOn404(
        ghApi<{ state: string }>(asApprover, `orgs/${org}/teams/${team}/memberships/${encodeURIComponent(login)}`)
      )
      return r?.state === 'active'
    },
    async reviews(pr) {
      const data = await graphql<{
        repository: { pullRequest: { latestOpinionatedReviews: { nodes: { author: { login: string } | null; state: ReviewFact['state']; submittedAt: string }[] } } }
      }>(
        `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){latestOpinionatedReviews(first:100){nodes{author{login} state submittedAt}}}}}`,
        { owner: pr.owner, name: pr.repo, number: pr.number }
      )
      return data.repository.pullRequest.latestOpinionatedReviews.nodes
        .filter(n => n.author)
        .map(n => ({ login: n.author!.login, state: n.state, submittedAt: n.submittedAt }))
    },
    async latestPush(pr, headRef) {
      const ref = encodeURIComponent(`refs/heads/${headRef}`)
      const items = await ghApi<{ actor: { login: string } | null; timestamp: string; after: string }[]>(
        asApprover,
        `${repoPath(pr)}/activity?ref=${ref}&activity_type=push&per_page=1`
      )
      const top = items[0]
      return top && top.actor ? { actor: top.actor.login, at: top.timestamp, afterSha: top.after } : null
    },
    async commentableLines(pr) {
      const files = await ghApiLines<{ filename: string; patch?: string }>(asApprover, `${repoPath(pr)}/pulls/${pr.number}/files?per_page=100`)
      return new Map(files.map(f => [f.filename, parsePatchLines(f.patch ?? '')]))
    },
    async updateBranch(pr, expectedHeadSha) {
      try {
        await ghApi(asApprover, `${repoPath(pr)}/pulls/${pr.number}/update-branch`, {
          method: 'PUT',
          body: { expected_head_sha: expectedHeadSha },
        })
        return { ok: true }
      } catch (error) {
        if (error instanceof GhApiError && error.status === 422) return { ok: false, status: 422 }
        throw error
      }
    },
    async postReview(pr, review) {
      const r = await ghApi<{ id: number; html_url: string }>(asApprover, `${repoPath(pr)}/pulls/${pr.number}/reviews`, {
        method: 'POST',
        body: { commit_id: review.commitId, event: review.event, body: review.body, comments: review.comments },
      })
      return { id: r.id, url: r.html_url }
    },
    async botReviews(pr, botLogin) {
      const all = await ghApiLines<{ user: { login: string } | null; commit_id: string; state: string }>(
        asApprover,
        `${repoPath(pr)}/pulls/${pr.number}/reviews?per_page=100`
      )
      return all
        .filter(r => r.user && r.user.login.toLowerCase() === botLogin.toLowerCase())
        .map(r => ({ login: r.user!.login, commitId: r.commit_id, state: r.state }))
    },
    async decision(pr) {
      const data = await graphql<{ repository: { pullRequest: { reviewDecision: string | null; mergeStateStatus: string } } }>(
        `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewDecision mergeStateStatus}}}`,
        { owner: pr.owner, name: pr.repo, number: pr.number }
      )
      return data.repository.pullRequest
    },
  }
}
```

The `recorder` in the tests keys on the first arg that starts with `repos/`, `orgs/`, `graphql` or `user`. `branchRules` and `botReviews` go through `ghApiLines`, which puts `--paginate` before the path, so the key still matches.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx ts-node --compiler-options '{"module":"commonjs"}' --transpile-only src/approver-github.test.ts && npm run typecheck`
Expected: all `ok`; the typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add src/approver-github.ts src/approver-github.test.ts
git commit -m "feat(github): add role-account effects for reviews, rules and update-branch (refs andrew-barnett/slack-review-bot#60)"
```

---

### Task 6: CODEOWNERS matcher

**Files:**
- Create: `src/codeowners.ts`, `src/codeowners.test.ts`

**Interfaces:**
- Produces:

```ts
export interface CodeownersRule { pattern: string; owners: string[]; line: number; supported: boolean }
export function parseCodeowners(text: string): CodeownersRule[]
/** Owners of the last matching rule; null when no rule matches; [] when the matching rule lists no owners. */
export function ownersFor(rules: CodeownersRule[], path: string): string[] | null
/** Line numbers of rules using syntax GitHub does not support (\#, !, []). */
export function unsupportedLines(rules: CodeownersRule[]): number[]
```

- [ ] **Step 1: Write the failing tests**

Create `src/codeowners.test.ts`:

```ts
import test from 'tape'
import { ownersFor, parseCodeowners, unsupportedLines } from './codeowners'

const owners = (text: string, path: string) => ownersFor(parseCodeowners(text), path)

// GitHub's own documented examples are the contract, because the pre-flight predicts GitHub's
// behaviour. Each case below is from docs.github.com "About code owners", CODEOWNERS syntax.
test('matches GitHub documented examples', t => {
  t.deepEqual(owners('* @all', 'any/deep/file.txt'), ['@all'], '* matches everything')
  t.deepEqual(owners('*.js @js', 'src/x/a.js'), ['@js'], 'extension pattern matches at any depth')
  t.equal(owners('*.js @js', 'src/a.ts'), null)
  t.deepEqual(owners('/build/logs/ @logs', 'build/logs/x/y.txt'), ['@logs'], 'anchored dir and everything under it')
  t.equal(owners('/build/logs/ @logs', 'other/build/logs/y.txt'), null, 'leading slash anchors to the root')
  t.deepEqual(owners('apps/ @apps', 'deep/apps/a.ts'), ['@apps'], 'unanchored dir matches anywhere')
  t.deepEqual(owners('/docs/ @docs', 'docs/a.md'), ['@docs'])
  t.equal(owners('/docs/ @docs', 'x/docs/a.md'), null)
  t.deepEqual(owners('**/logs @logs', 'a/b/logs/c.txt'), ['@logs'], '**/ matches any leading dirs')
  t.end()
})

// Review Focus 1: a wildcard in the last segment matches direct children only. A gitignore port
// that lets "docs/*" match nested paths over-credits ownership.
test('a last-segment wildcard does not match nested paths', t => {
  t.deepEqual(owners('docs/* @docs', 'docs/getting-started.md'), ['@docs'])
  t.equal(owners('docs/* @docs', 'docs/build-app/troubleshooting.md'), null)
  t.end()
})

// The last matching rule wins, including one with no owners, which means "needs no owner".
test('last match wins, and an ownerless rule clears ownership', t => {
  const text = ['* @all', '/apps/ @apps', '/apps/github'].join('\n')
  t.deepEqual(owners(text, 'apps/web/a.ts'), ['@apps'])
  t.deepEqual(owners(text, 'apps/github'), [], 'matched with no owners')
  t.deepEqual(owners(text, 'README.md'), ['@all'])
  t.end()
})

// GitHub does not support \# escapes, ! negation or [] ranges. Honouring them locally would
// recognise owners GitHub ignores. They must never match or override an earlier rule.
test('unsupported syntax never matches and is reported', t => {
  const text = ['* @all', '\\#notes @x', '!keep.txt @y', '[ab].js @z'].join('\n')
  const rules = parseCodeowners(text)
  t.deepEqual(ownersFor(rules, '#notes'), ['@all'])
  t.deepEqual(ownersFor(rules, 'keep.txt'), ['@all'])
  t.deepEqual(ownersFor(rules, 'a.js'), ['@all'])
  t.deepEqual(unsupportedLines(rules), [2, 3, 4])
  t.end()
})

// Comments and blank lines are skipped, and a trailing "# ..." after the owners is dropped
// rather than read as an owner.
test('comments and blank lines are ignored', t => {
  const text = ['# top comment', '', '/src/ @team # inline note'].join('\n')
  t.deepEqual(owners(text, 'src/a.ts'), ['@team'])
  t.end()
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx ts-node --compiler-options '{"module":"commonjs"}' --transpile-only src/codeowners.test.ts`
Expected: FAIL with `Cannot find module './codeowners'`.

- [ ] **Step 3: Implement `src/codeowners.ts`**

```ts
// A pure CODEOWNERS parser and matcher, following GitHub's documented syntax (not full
// gitignore): last match wins; a leading or middle slash anchors to the root; a trailing slash
// matches a directory and everything under it; a wildcard in the last segment matches direct
// children only; \# escapes, ! negation and [] ranges are unsupported and never match.

export interface CodeownersRule {
  pattern: string
  owners: string[]
  line: number
  supported: boolean
  /** Compiled matcher; null for unsupported syntax. Not exported in the interface contract. */
  regex?: RegExp | null
}

const escapeRe = (s: string) => s.replace(/[.+^${}()|\\]/g, '\\$&')

function globToRegex(glob: string): string {
  let out = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '*') {
      if (glob[i + 1] === '*') {
        if (glob[i + 2] === '/') {
          // "**/" matches zero or more leading directories.
          out += '(?:.*/)?'
          i += 2
        } else {
          // A trailing "**" matches anything, slashes included.
          out += '.*'
          i += 1
        }
      } else {
        out += '[^/]*'
      }
    } else if (c === '?') {
      out += '[^/]'
    } else {
      out += escapeRe(c)
    }
  }
  return out
}

function compile(pattern: string): RegExp {
  const anchored = pattern.startsWith('/') || pattern.slice(0, -1).includes('/')
  let body = pattern.replace(/^\//, '')
  const dirOnly = body.endsWith('/')
  if (dirOnly) body = body.slice(0, -1)
  const lastSegment = body.split('/').pop() ?? ''
  const lastHasWildcard = /[*?]/.test(lastSegment) && lastSegment !== '**'
  const prefix = anchored ? '^' : '^(?:.*/)?'
  // A directory pattern needs something beneath it; a plain name also covers everything beneath
  // it; a last-segment wildcard covers direct children only (GitHub's "docs/*" example).
  const suffix = dirOnly ? '/.*$' : lastHasWildcard ? '$' : '(?:/.*)?$'
  return new RegExp(prefix + globToRegex(body) + suffix)
}

export function parseCodeowners(text: string): CodeownersRule[] {
  const rules: CodeownersRule[] = []
  text.split('\n').forEach((raw, index) => {
    const trimmed = raw.trim()
    if (!trimmed || trimmed.startsWith('#')) return
    const tokens = trimmed.split(/\s+/)
    const pattern = tokens[0]
    const ownerTokens: string[] = []
    for (const token of tokens.slice(1)) {
      if (token.startsWith('#')) break
      ownerTokens.push(token)
    }
    const supported = !(pattern.startsWith('\\#') || pattern.startsWith('!') || /[[\]]/.test(pattern))
    rules.push({ pattern, owners: ownerTokens, line: index + 1, supported, regex: supported ? compile(pattern) : null })
  })
  return rules
}

export function ownersFor(rules: CodeownersRule[], filePath: string): string[] | null {
  let found: string[] | null = null
  for (const rule of rules) {
    if (rule.regex && rule.regex.test(filePath)) found = rule.owners
  }
  return found
}

export function unsupportedLines(rules: CodeownersRule[]): number[] {
  return rules.filter(rule => !rule.supported).map(rule => rule.line)
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx ts-node --compiler-options '{"module":"commonjs"}' --transpile-only src/codeowners.test.ts && npm run typecheck`
Expected: all `ok`; the typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add src/codeowners.ts src/codeowners.test.ts
git commit -m "feat(preflight): add a CODEOWNERS matcher following GitHub's syntax (refs andrew-barnett/slack-review-bot#56)"
```

---

### Task 7: Eligibility evaluator (pure)

**Files:**
- Create: `src/preflight.ts` (the evaluator part), `src/preflight.test.ts`

**Interfaces:**
- Consumes: `Permission`, `ReviewFact`, `LatestPush` (Task 5); `parseCodeowners`, `ownersFor` (Task 6)
- Produces:

```ts
export type EligibilityVerdict = 'counts' | 'partial' | 'wontCount'
export interface Eligibility { verdict: EligibilityVerdict; reasons: string[]; missing: string[]; lastPushApproval: boolean; dismissStale: boolean }
export interface PullRequestRules { requiredApprovals: number; requireCodeOwnerReview: boolean; requireLastPushApproval: boolean; dismissStaleReviews: boolean }
export interface EligibilityFacts {
  botLogin: string
  prAuthor: string
  changedFiles: string[]
  botPermission: Permission | null                         // null = unreadable
  ruleSources: { name: string; rules: PullRequestRules | null }[]   // rules null = unreadable source
  codeowners: string | null                                 // '' = no file; null = unreadable
  codeownersErrors: number | null                           // null = unreadable
  reviews: ReviewFact[] | null                              // null = unreadable
  reviewerPermissions: Record<string, Permission | null>   // keyed by lower-case login
  teamMembership: Record<string, boolean | null>           // key `${team lower}|${login lower}`, e.g. '@acme/pay|role-bot'
  latestPush: LatestPush | null                            // null = unreadable or not needed (see rule 7)
}
export const NO_RULES: PullRequestRules
export function rulesFromRulesets(rules: unknown[]): PullRequestRules
export function rulesFromClassic(protection: unknown | null): PullRequestRules
export function mergeRules(rules: PullRequestRules[]): PullRequestRules
export function evaluateEligibility(facts: EligibilityFacts): Eligibility
```

- [ ] **Step 1: Write the failing tests**

Create `src/preflight.test.ts`:

```ts
import test from 'tape'
import { evaluateEligibility, mergeRules, NO_RULES, rulesFromClassic, rulesFromRulesets, type EligibilityFacts, type PullRequestRules } from './preflight'

const rules = (r: Partial<PullRequestRules>): PullRequestRules => ({ ...NO_RULES, ...r })

/** A PR with no requirements, a write-access bot, and nothing unreadable; each test varies one thing. */
function facts(over: Partial<EligibilityFacts> = {}): EligibilityFacts {
  return {
    botLogin: 'role-bot',
    prAuthor: 'dev',
    changedFiles: ['src/a.ts'],
    botPermission: 'write',
    ruleSources: [{ name: 'rulesets', rules: NO_RULES }, { name: 'classic protection', rules: NO_RULES }],
    codeowners: '',
    codeownersErrors: 0,
    reviews: [],
    reviewerPermissions: {},
    teamMembership: {},
    latestPush: null,
    ...over,
  }
}

// Rules come from rulesets and classic protection; the effective rule is the strictest of all.
// Taking only one source would under-state requirements on a repo that uses both.
test('mergeRules takes the strictest of every source', t => {
  const merged = mergeRules([rules({ requiredApprovals: 1, dismissStaleReviews: true }), rules({ requiredApprovals: 2, requireCodeOwnerReview: true })])
  t.deepEqual(merged, { requiredApprovals: 2, requireCodeOwnerReview: true, requireLastPushApproval: false, dismissStaleReviews: true })
  t.end()
})

// Classic protection and rulesets use different field names (require_code_owner_reviews vs
// require_code_owner_review, dismiss_stale_reviews vs dismiss_stale_reviews_on_push). A mix-up
// silently drops a requirement.
test('rule parsers read each source field names', t => {
  t.deepEqual(
    rulesFromRulesets([{ type: 'pull_request', parameters: { required_approving_review_count: 2, require_code_owner_review: true, require_last_push_approval: true, dismiss_stale_reviews_on_push: true } }, { type: 'deletion' }]),
    { requiredApprovals: 2, requireCodeOwnerReview: true, requireLastPushApproval: true, dismissStaleReviews: true }
  )
  t.deepEqual(
    rulesFromClassic({ required_pull_request_reviews: { required_approving_review_count: 1, require_code_owner_reviews: true, require_last_push_approval: false, dismiss_stale_reviews: true } }),
    { requiredApprovals: 1, requireCodeOwnerReview: true, requireLastPushApproval: false, dismissStaleReviews: true }
  )
  t.deepEqual(rulesFromClassic(null), NO_RULES, 'an unprotected branch has no requirement')
  t.end()
})

// No requirements at all: a valid bot approval trivially counts.
test('counts when nothing is required', t => {
  t.equal(evaluateEligibility(facts()).verdict, 'counts')
  t.end()
})

// Rule 3: the bot authored the PR. GitHub forbids self-approval. Review Focus 2: case-insensitive.
test('wontCount when the bot authored the PR, case-insensitively', t => {
  const e = evaluateEligibility(facts({ prAuthor: 'Role-Bot' }))
  t.equal(e.verdict, 'wontCount')
  t.match(e.reasons.join(' '), /authored this PR/)
  t.end()
})

// Rule 3: read or triage permission cannot approve in a way that counts.
test('wontCount when the bot lacks write permission', t => {
  t.equal(evaluateEligibility(facts({ botPermission: 'read' })).verdict, 'wontCount')
  t.end()
})

// Rule 3: under require_last_push_approval the latest pusher's approval does not satisfy it.
test('wontCount when the bot made the latest push under the last-push rule', t => {
  const e = evaluateEligibility(facts({
    ruleSources: [{ name: 'rulesets', rules: rules({ requireLastPushApproval: true }) }],
    latestPush: { actor: 'role-bot', at: '2026-11-17T10:00:00Z', afterSha: 'h' },
  }))
  t.equal(e.verdict, 'wontCount')
  t.ok(e.lastPushApproval)
  t.end()
})

// Rule 2: a read-only reviewer's approval is shown by GitHub but never counts. Counting it would
// predict "counts" while GitHub still wants another approval.
test('a read-only reviewer approval does not count toward the number', t => {
  const e = evaluateEligibility(facts({
    ruleSources: [{ name: 'rulesets', rules: rules({ requiredApprovals: 2 }) }],
    reviews: [{ login: 'reader', state: 'APPROVED', submittedAt: '2026-11-17T09:00:00Z' }],
    reviewerPermissions: { reader: 'read' },
  }))
  t.equal(e.verdict, 'partial')
  t.deepEqual(e.missing, ['1 more approval'])
  t.end()
})

// Rule 2: GitHub's DISMISSED state is authoritative. An APPROVED review on an older SHA still
// counts (an empty-commit push does not dismiss it).
test('dismissed approvals are excluded, older-SHA approvals still count', t => {
  const base = { ruleSources: [{ name: 'rulesets', rules: rules({ requiredApprovals: 2, dismissStaleReviews: true }) }], reviewerPermissions: { alice: 'write' as const } }
  t.equal(evaluateEligibility(facts({ ...base, reviews: [{ login: 'alice', state: 'APPROVED', submittedAt: '2026-11-17T09:00:00Z' }] })).verdict, 'counts')
  t.equal(evaluateEligibility(facts({ ...base, reviews: [{ login: 'alice', state: 'DISMISSED', submittedAt: '2026-11-17T09:00:00Z' }] })).verdict, 'partial')
  t.end()
})

// Rule 4: an existing code-owner approval satisfies the path even though the bot does not own it;
// the bot then fills the count, so the result is counts.
test('an existing owner approval plus the bot filling the count gives counts', t => {
  const e = evaluateEligibility(facts({
    ruleSources: [{ name: 'rulesets', rules: rules({ requiredApprovals: 2, requireCodeOwnerReview: true }) }],
    codeowners: '/src/ @alice',
    reviews: [{ login: 'alice', state: 'APPROVED', submittedAt: '2026-11-17T09:00:00Z' }],
    reviewerPermissions: { alice: 'write' },
  }))
  t.equal(e.verdict, 'counts')
  t.end()
})

// Rule 4 through team membership. Review Focus 2: an owner written with different case still matches.
test('the bot satisfies an owner path through active team membership', t => {
  const e = evaluateEligibility(facts({
    ruleSources: [{ name: 'rulesets', rules: rules({ requiredApprovals: 1, requireCodeOwnerReview: true }) }],
    codeowners: '/src/ @Acme/Pay',
    teamMembership: { '@acme/pay|role-bot': true },
  }))
  t.equal(e.verdict, 'counts')
  t.end()
})

// Rule 6: the bot owns one path but another needs a different owner: partial, naming what remains.
test('partial when some owner paths remain after the bot approval', t => {
  const e = evaluateEligibility(facts({
    changedFiles: ['src/a.ts', 'billing/b.ts'],
    ruleSources: [{ name: 'rulesets', rules: rules({ requiredApprovals: 1, requireCodeOwnerReview: true }) }],
    codeowners: ['/src/ @role-bot', '/billing/ @acme/finance'].join('\n'),
    teamMembership: { '@acme/finance|role-bot': false },
  }))
  t.equal(e.verdict, 'partial')
  t.deepEqual(e.missing, ['@acme/finance for billing/b.ts'])
  t.end()
})

// Rule 6: a valid approval that reduces nothing does not move the PR, so wontCount.
test('wontCount when the bot approval reduces no requirement', t => {
  const e = evaluateEligibility(facts({
    ruleSources: [{ name: 'rulesets', rules: rules({ requiredApprovals: 1, requireCodeOwnerReview: true }) }],
    codeowners: '/src/ @alice',
    reviews: [{ login: 'carol', state: 'APPROVED', submittedAt: '2026-11-17T09:00:00Z' }],
    reviewerPermissions: { carol: 'write' },
  }))
  t.equal(e.verdict, 'wontCount')
  t.end()
})

// Rule 5: an approval before the latest push still counts toward the number but cannot satisfy
// the latest-push requirement; the bot (not the pusher) satisfies it, so counts.
test('pre-push approvals count toward the number; the bot satisfies the latest push', t => {
  const e = evaluateEligibility(facts({
    ruleSources: [{ name: 'rulesets', rules: rules({ requiredApprovals: 2, requireLastPushApproval: true }) }],
    reviews: [{ login: 'alice', state: 'APPROVED', submittedAt: '2026-11-17T08:00:00Z' }],
    reviewerPermissions: { alice: 'write' },
    latestPush: { actor: 'dev', at: '2026-11-17T09:00:00Z', afterSha: 'h' },
  }))
  t.equal(e.verdict, 'counts')
  t.end()
})

// Rule 7 / Review Focus 3: anything needed but unreadable is wontCount with the source named,
// never a quiet "counts".
test('wontCount naming each unreadable source', t => {
  const e = evaluateEligibility(facts({
    ruleSources: [{ name: 'classic protection', rules: null }],
    reviews: [{ login: 'alice', state: 'APPROVED', submittedAt: '2026-11-17T09:00:00Z' }],
    reviewerPermissions: { alice: null },
  }))
  t.equal(e.verdict, 'wontCount')
  t.match(e.reasons.join(' '), /classic protection/)
  t.match(e.reasons.join(' '), /permission of alice/)
  t.end()
})

// Rule 7: CODEOWNERS errors matter only when code-owner review is required. With it required,
// a broken file is unverifiable.
test('CODEOWNERS errors make the result unverifiable only when owners are required', t => {
  t.equal(evaluateEligibility(facts({ codeownersErrors: 2 })).verdict, 'counts')
  t.equal(evaluateEligibility(facts({ codeownersErrors: 2, ruleSources: [{ name: 'rulesets', rules: rules({ requireCodeOwnerReview: true }) }] })).verdict, 'wontCount')
  t.end()
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx ts-node --compiler-options '{"module":"commonjs"}' --transpile-only src/preflight.test.ts`
Expected: FAIL with `Cannot find module './preflight'`.

- [ ] **Step 3: Implement the evaluator in `src/preflight.ts`**

```ts
// Approval-eligibility pre-flight (spec section 5.2). The evaluator is pure: given facts about a
// PR, it predicts whether an approval from the role account would satisfy the base branch's
// rules. The fetch layer that gathers the facts is at the bottom of this file.

import type { LatestPush, Permission, ReviewFact } from './approver-github'
import { ownersFor, parseCodeowners } from './codeowners'

// <paste the exported types from this task's Interfaces block here, unchanged>

export const NO_RULES: PullRequestRules = {
  requiredApprovals: 0,
  requireCodeOwnerReview: false,
  requireLastPushApproval: false,
  dismissStaleReviews: false,
}

const WRITE_OR_ABOVE: ReadonlySet<string> = new Set(['admin', 'maintain', 'write'])
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

export function mergeRules(all: PullRequestRules[]): PullRequestRules {
  return all.reduce(
    (acc, r) => ({
      requiredApprovals: Math.max(acc.requiredApprovals, r.requiredApprovals),
      requireCodeOwnerReview: acc.requireCodeOwnerReview || r.requireCodeOwnerReview,
      requireLastPushApproval: acc.requireLastPushApproval || r.requireLastPushApproval,
      dismissStaleReviews: acc.dismissStaleReviews || r.dismissStaleReviews,
    }),
    NO_RULES
  )
}

type Params = Record<string, unknown>
const num = (v: unknown) => (typeof v === 'number' ? v : 0)
const bool = (v: unknown) => v === true

export function rulesFromRulesets(rules: unknown[]): PullRequestRules {
  return mergeRules(
    rules
      .filter((r): r is { type: string; parameters?: Params } => (r as { type?: string })?.type === 'pull_request')
      .map(r => {
        const p = r.parameters ?? {}
        return {
          requiredApprovals: num(p.required_approving_review_count),
          requireCodeOwnerReview: bool(p.require_code_owner_review),
          requireLastPushApproval: bool(p.require_last_push_approval),
          dismissStaleReviews: bool(p.dismiss_stale_reviews_on_push),
        }
      })
  )
}

export function rulesFromClassic(protection: unknown | null): PullRequestRules {
  const reviews = (protection as { required_pull_request_reviews?: Params } | null)?.required_pull_request_reviews
  if (!reviews) return NO_RULES
  return {
    requiredApprovals: num(reviews.required_approving_review_count),
    requireCodeOwnerReview: bool(reviews.require_code_owner_reviews),
    requireLastPushApproval: bool(reviews.require_last_push_approval),
    dismissStaleReviews: bool(reviews.dismiss_stale_reviews),
  }
}

/** Whether `login` is one of `owners`, directly or through an active team membership. */
function ownedBy(owners: string[], login: string, membership: EligibilityFacts['teamMembership']): boolean | null {
  let unknown = false
  for (const owner of owners) {
    if (!owner.startsWith('@')) continue // email owners cannot be resolved; never counted
    if (owner.includes('/')) {
      const member = membership[`${owner.toLowerCase()}|${login.toLowerCase()}`]
      if (member === true) return true
      if (member === null || member === undefined) unknown = true
    } else if (same(owner.slice(1), login)) {
      return true
    }
  }
  return unknown ? null : false
}

const MAX_LISTED_PATHS = 5

export function evaluateEligibility(f: EligibilityFacts): Eligibility {
  const unreadable: string[] = []
  for (const source of f.ruleSources) if (!source.rules) unreadable.push(source.name)
  const rules = mergeRules(f.ruleSources.flatMap(s => (s.rules ? [s.rules] : [])))
  const base = { lastPushApproval: rules.requireLastPushApproval, dismissStale: rules.dismissStaleReviews }
  const wont = (reasons: string[]): Eligibility => ({ verdict: 'wontCount', reasons, missing: [], ...base })

  // Rule 3: bot validity. These are definitive even if other sources are unreadable.
  const invalid: string[] = []
  if (same(f.botLogin, f.prAuthor)) invalid.push('the bot account authored this PR')
  if (f.botPermission && !WRITE_OR_ABOVE.has(f.botPermission)) {
    invalid.push(`the bot account has ${f.botPermission} permission; a counting approval needs write or higher`)
  }
  if (rules.requireLastPushApproval && f.latestPush && same(f.latestPush.actor, f.botLogin)) {
    invalid.push('the bot account made the latest push, and this branch requires the latest push to be approved by someone else')
  }
  if (invalid.length) return wont(invalid)

  // Rule 7: everything the remaining rules need must be readable.
  if (f.botPermission === null) unreadable.push('bot permission')
  if (f.reviews === null) unreadable.push('PR reviews')
  if (rules.requireLastPushApproval && !f.latestPush) unreadable.push('latest pusher')
  if (rules.requireCodeOwnerReview) {
    if (f.codeowners === null) unreadable.push('CODEOWNERS')
    if (f.codeownersErrors === null) unreadable.push('CODEOWNERS errors')
    else if (f.codeownersErrors > 0) unreadable.push(`CODEOWNERS (${f.codeownersErrors} error(s) reported by GitHub)`)
  }

  // Rule 2: eligible existing approvals.
  const approvals: ReviewFact[] = []
  for (const r of f.reviews ?? []) {
    if (r.state !== 'APPROVED' || same(r.login, f.botLogin) || same(r.login, f.prAuthor)) continue
    const permission = f.reviewerPermissions[r.login.toLowerCase()]
    if (permission === null || permission === undefined) {
      unreadable.push(`permission of ${r.login}`)
      continue
    }
    if (WRITE_OR_ABOVE.has(permission)) approvals.push(r)
  }

  // Rule 4: owner coverage.
  type OwnerPath = { path: string; owners: string[]; byOthers: boolean; byBot: boolean }
  const ownerPaths: OwnerPath[] = []
  if (rules.requireCodeOwnerReview && f.codeowners !== null) {
    const parsed = parseCodeowners(f.codeowners)
    for (const path of f.changedFiles) {
      const owners = ownersFor(parsed, path)
      if (!owners || owners.length === 0) continue
      const others = approvals.map(a => ownedBy(owners, a.login, f.teamMembership))
      const bot = ownedBy(owners, f.botLogin, f.teamMembership)
      if (bot === null || others.some(o => o === null)) unreadable.push(`team membership for ${owners.join(' ')}`)
      ownerPaths.push({ path, owners, byOthers: others.some(o => o === true), byBot: bot === true })
    }
  }

  if (unreadable.length) return wont([...new Set(unreadable)].map(u => `could not verify: ${u}`))

  // Rule 5: remaining requirements with and without the bot.
  const shortfallWithout = Math.max(0, rules.requiredApprovals - approvals.length)
  const shortfallWith = Math.max(0, rules.requiredApprovals - approvals.length - 1)
  const unsatisfiedWithout = ownerPaths.filter(p => !p.byOthers)
  const unsatisfiedWith = unsatisfiedWithout.filter(p => !p.byBot)
  const lastPushSatisfiedWithout =
    !rules.requireLastPushApproval ||
    approvals.some(a => f.latestPush && !same(a.login, f.latestPush.actor) && a.submittedAt > f.latestPush.at)

  const missing: string[] = []
  if (shortfallWith > 0) missing.push(`${shortfallWith} more approval${shortfallWith === 1 ? '' : 's'}`)
  const byOwners = new Map<string, string[]>()
  for (const p of unsatisfiedWith) byOwners.set(p.owners.join(' or '), [...(byOwners.get(p.owners.join(' or ')) ?? []), p.path])
  for (const [owners, paths] of byOwners) {
    const shown = paths.slice(0, MAX_LISTED_PATHS).join(', ')
    const more = paths.length > MAX_LISTED_PATHS ? ` and ${paths.length - MAX_LISTED_PATHS} more` : ''
    missing.push(`${owners} for ${shown}${more}`)
  }

  // Rule 6: verdict.
  if (missing.length === 0) return { verdict: 'counts', reasons: [], missing: [], ...base }
  const reduced =
    shortfallWith < shortfallWithout || unsatisfiedWith.length < unsatisfiedWithout.length || !lastPushSatisfiedWithout
  if (reduced) return { verdict: 'partial', reasons: ['the bot approval satisfies some but not all requirements'], missing, ...base }
  return { verdict: 'wontCount', reasons: ['the bot approval would not satisfy any remaining requirement'], missing, ...base }
}
```

`submittedAt > f.latestPush.at` compares ISO-8601 UTC strings, which order correctly as strings because GitHub returns both in `YYYY-MM-DDTHH:MM:SSZ`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx ts-node --compiler-options '{"module":"commonjs"}' --transpile-only src/preflight.test.ts && npm run typecheck`
Expected: all `ok`; the typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add src/preflight.ts src/preflight.test.ts
git commit -m "feat(preflight): add the approval-eligibility evaluator (refs andrew-barnett/slack-review-bot#56)"
```

---

### Task 8: Pre-flight fetch layer

**Files:**
- Modify: `src/preflight.ts` (append), `src/preflight.test.ts` (append)

**Interfaces:**
- Consumes: `ApproverGitHub`, `PullRequestInfo` (Task 5); `parseCodeowners`, `ownersFor` (Task 6); the Task 7 types
- Produces:
  - `CODEOWNERS_PATHS = ['.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS']`
  - `gatherEligibilityFacts(gh: ApproverGitHub, pr: PullRequestRef, info: PullRequestInfo, changedFiles: string[], botLogin: string): Promise<EligibilityFacts>`

Every individual read that fails becomes `null` in the facts, so the evaluator reports it as unreadable. The function itself never rejects.

- [ ] **Step 1: Write the failing tests**

Append to `src/preflight.test.ts`. Add `import type { ApproverGitHub, PullRequestInfo } from './approver-github'` and `gatherEligibilityFacts` to the `./preflight` import.

```ts
const prRef = { owner: 'acme', repo: 'svc', number: 1, url: 'https://github.com/acme/svc/pull/1' }
const info: PullRequestInfo = { author: 'dev', base: 'main', baseRepo: 'acme/svc', headRef: 'feat/x', headSha: 'h1', headRepo: 'acme/svc', state: 'open', draft: false }

/** A fake ApproverGitHub with sensible defaults; each test overrides what it exercises. */
function fakeGh(over: Partial<ApproverGitHub> = {}): ApproverGitHub {
  const unused = async () => { throw new Error('not used in pre-flight') }
  return {
    login: async () => 'role-bot',
    getPullRequest: async () => info,
    permission: async () => 'write',
    branchRules: async () => [],
    classicProtection: async () => null,
    fileAt: async () => null,
    codeownersErrorCount: async () => 0,
    isTeamMember: async () => false,
    reviews: async () => [],
    latestPush: async () => null,
    commentableLines: unused,
    updateBranch: unused,
    postReview: unused,
    botReviews: unused,
    decision: unused,
    ...over,
  } as ApproverGitHub
}

// A failing read must become "unreadable" in the facts, so the evaluator says wontCount and names
// it. The fetch layer must never reject, or one flaky call would crash the review.
test('a failing read becomes null instead of rejecting', async t => {
  const f = await gatherEligibilityFacts(fakeGh({ classicProtection: async () => { throw new Error('HTTP 403') } }), prRef, info, ['a.ts'], 'role-bot')
  t.equal(f.ruleSources.find(s => s.name === 'classic protection')?.rules, null)
  t.end()
})

// CODEOWNERS lives in one of three places; GitHub uses the first that exists in that order.
test('CODEOWNERS is read from the first location that exists, at the base branch', async t => {
  const asked: string[] = []
  const f = await gatherEligibilityFacts(
    fakeGh({
      // CODEOWNERS is only read when code-owner review is required.
      branchRules: async () => [{ type: 'pull_request', parameters: { require_code_owner_review: true } }],
      fileAt: async (_pr, p, ref) => { asked.push(`${p}@${ref}`); return p === 'CODEOWNERS' ? '* @x' : null },
    }),
    prRef, info, ['a.ts'], 'role-bot'
  )
  t.deepEqual(asked, ['.github/CODEOWNERS@main', 'CODEOWNERS@main'])
  t.equal(f.codeowners, '* @x')
  t.end()
})

// Review Focus 4: a latest-push record for a different SHA than the head is stale and must read
// as unreadable, not as the latest push.
test('a latest-push record that does not match the head is treated as unreadable', async t => {
  const f = await gatherEligibilityFacts(
    fakeGh({
      branchRules: async () => [{ type: 'pull_request', parameters: { require_last_push_approval: true } }],
      latestPush: async () => ({ actor: 'dev', at: '2026-11-17T09:00:00Z', afterSha: 'old' }),
    }),
    prRef, info, ['a.ts'], 'role-bot'
  )
  t.equal(f.latestPush, null)
  t.equal(evaluateEligibility(f).verdict, 'wontCount')
  t.end()
})

// The latest pusher cannot be read for a head branch in a fork, so it is unreadable when needed.
test('the latest push of a fork head is unreadable', async t => {
  let called = false
  const f = await gatherEligibilityFacts(
    fakeGh({
      branchRules: async () => [{ type: 'pull_request', parameters: { require_last_push_approval: true } }],
      latestPush: async () => { called = true; return null },
    }),
    prRef, { ...info, headRepo: 'someone/svc' }, ['a.ts'], 'role-bot'
  )
  t.equal(f.latestPush, null)
  t.notOk(called, 'not queried for a fork')
  t.end()
})

// Team membership is looked up only for teams that own a changed path, and for each candidate
// (the bot and every approver), with keys matching the evaluator's format.
test('team membership is fetched for owning teams and candidates only', async t => {
  const asked: string[] = []
  const f = await gatherEligibilityFacts(
    fakeGh({
      branchRules: async () => [{ type: 'pull_request', parameters: { require_code_owner_review: true, required_approving_review_count: 1 } }],
      fileAt: async (_pr, p) => (p === '.github/CODEOWNERS' ? ['/src/ @Acme/Pay', '/other/ @acme/ops'].join('\n') : null),
      reviews: async () => [{ login: 'Alice', state: 'APPROVED', submittedAt: '2026-11-17T09:00:00Z' }],
      isTeamMember: async (org, team, login) => { asked.push(`${org}/${team}/${login}`); return login === 'role-bot' },
    }),
    prRef, info, ['src/a.ts'], 'role-bot'
  )
  t.deepEqual(asked.sort(), ['Acme/Pay/Alice', 'Acme/Pay/role-bot'])
  t.equal(f.teamMembership['@acme/pay|role-bot'], true)
  t.equal(f.reviewerPermissions['alice'], 'write')
  t.equal(evaluateEligibility(f).verdict, 'counts')
  t.end()
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx ts-node --compiler-options '{"module":"commonjs"}' --transpile-only src/preflight.test.ts`
Expected: FAIL. `gatherEligibilityFacts is not a function`.

- [ ] **Step 3: Implement (append to `src/preflight.ts`)**

Add `import type { ApproverGitHub, PullRequestInfo } from './approver-github'` and `import type { PullRequestRef } from './parse-message'` to the top imports, then append:

```ts
/** Where GitHub looks for CODEOWNERS, in its order of precedence. */
export const CODEOWNERS_PATHS = ['.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS'] as const

/** Resolve a read to its value, or null when it fails; the evaluator reports null as unreadable. */
async function attempt<T>(read: () => Promise<T>): Promise<T | null> {
  try {
    return await read()
  } catch {
    return null
  }
}

/**
 * Gather every fact `evaluateEligibility` needs, with the approver token, read-only. Never
 * rejects: a failed read becomes null and is reported as unreadable by the evaluator.
 */
export async function gatherEligibilityFacts(
  gh: ApproverGitHub,
  pr: PullRequestRef,
  info: PullRequestInfo,
  changedFiles: string[],
  botLogin: string
): Promise<EligibilityFacts> {
  const [rulesets, classic, botPermission, reviews] = await Promise.all([
    attempt(() => gh.branchRules(pr, info.base)),
    attempt(async () => rulesFromClassic(await gh.classicProtection(pr, info.base))),
    attempt(() => gh.permission(pr, botLogin)),
    attempt(() => gh.reviews(pr)),
  ])
  const ruleSources = [
    { name: 'rulesets', rules: rulesets === null ? null : rulesFromRulesets(rulesets) },
    { name: 'classic protection', rules: classic },
  ]
  const rules = mergeRules(ruleSources.flatMap(s => (s.rules ? [s.rules] : [])))

  // CODEOWNERS: the first file that exists, read from the base branch.
  let codeowners: string | null = ''
  if (rules.requireCodeOwnerReview) {
    for (const candidate of CODEOWNERS_PATHS) {
      // fileAt resolves null for a missing file (try the next location) and rejects on any other
      // failure (CODEOWNERS unreadable). Not wrapped in attempt(), which would conflate the two.
      try {
        const text = await gh.fileAt(pr, candidate, info.base)
        if (text === null) continue
        codeowners = text
      } catch {
        codeowners = null
      }
      break
    }
  }
  const codeownersErrors = rules.requireCodeOwnerReview ? await attempt(() => gh.codeownersErrorCount(pr, info.base)) : 0

  // Permissions of every other approver.
  const approvers = (reviews ?? []).filter(r => r.state === 'APPROVED')
  const reviewerPermissions: Record<string, Permission | null> = {}
  await Promise.all(
    approvers.map(async r => {
      reviewerPermissions[r.login.toLowerCase()] = await attempt(() => gh.permission(pr, r.login))
    })
  )

  // Team membership: only teams that own a changed path, for the bot and each approver.
  const teamMembership: Record<string, boolean | null> = {}
  if (rules.requireCodeOwnerReview && codeowners) {
    const parsed = parseCodeowners(codeowners)
    const teams = new Set<string>()
    for (const file of changedFiles) for (const owner of ownersFor(parsed, file) ?? []) if (owner.startsWith('@') && owner.includes('/')) teams.add(owner)
    const candidates = [botLogin, ...approvers.map(a => a.login)]
    await Promise.all(
      [...teams].flatMap(team =>
        candidates.map(async login => {
          const [org, slug] = team.slice(1).split('/')
          teamMembership[`${team.toLowerCase()}|${login.toLowerCase()}`] = await attempt(() => gh.isTeamMember(org, slug, login))
        })
      )
    )
  }

  // Latest pusher: needed only under the last-push rule; unreadable for a fork head or a stale record.
  let latestPush: LatestPush | null = null
  if (rules.requireLastPushApproval && info.headRepo === info.baseRepo) {
    const push = await attempt(() => gh.latestPush(pr, info.headRef))
    latestPush = push && push.afterSha === info.headSha ? push : null
  }

  return {
    botLogin,
    prAuthor: info.author,
    changedFiles,
    botPermission,
    ruleSources,
    codeowners,
    codeownersErrors,
    reviews,
    reviewerPermissions,
    teamMembership,
    latestPush,
  }
}
```

- [ ] **Step 4: Run the full suite and typecheck**

Run: `npm test 2>&1 | tail -5 && npm run typecheck`
Expected: `# fail  0`; the typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add src/preflight.ts src/preflight.test.ts
git commit -m "feat(preflight): gather eligibility facts with the role-account token (refs andrew-barnett/slack-review-bot#56)"
```

---

### Task 9: Docs

**Files:**
- Modify: `README.md` (the configuration table near line 640-660)
- Modify: `docs/superpowers/specs/2026-11-17-dual-engine-approval-design.md` (section 8, V1; and the classic-protection row in section 5.2)

- [ ] **Step 1: Add the config rows to the README table**, directly after the `CODEX_ENV_PASSTHROUGH` row:

```markdown
| `REVIEW_ENGINES` | `codex` | `codex` (single engine, today's behaviour) or `codex,claude` (dual-engine approval gate; not available until the orchestrator ships). |
| `ENGINE_SCHEDULE` | `parallel` | Dual mode: `parallel` or `serial`. |
| `ENGINE_ORDER` | `codex,claude` | Dual mode, serial: the order the engines run in. |
| `APPROVER_GH_TOKEN` | *(none)* | Dual mode: the role account's fine-grained PAT (Administration: read, Contents: write, Pull requests: write, Metadata: read, org Members: read). Held by the daemon only; never passed to a review child, and dropped even if named in `CODEX_ENV_PASSTHROUGH`. |
| `ENGINE_GH_TOKEN` | *(none)* | Dual mode: the role account's read-only token, given to review engines as `GH_TOKEN`. Must differ from `APPROVER_GH_TOKEN`. |
| `CLAUDE_BIN` | `claude` | Dual mode: the Claude Code binary. |
| `CLAUDE_CONFIG_DIR_REVIEW` | `~/.claude-review-bot` | Dual mode: the dedicated Claude config dir for the engine. |
```

- [ ] **Step 2: Update the spec.** In section 8, replace the V1 bullet's text with:

```markdown
- **V1.** Settled in part (https://github.com/andrew-barnett/slack-review-bot/issues/54): the role account has admin, so classic branch protection is readable. Still to confirm with the real fine-grained token: Administration: read suffices for classic protection, secret-team membership reads, `codeowners/errors`, and the repository activity API for the latest pusher.
```

In section 5.2's fetch table, change the classic-protection cell from "**readability to be verified** (V1)" to "readable with Administration: read (V1)".

- [ ] **Step 3: Commit**

```bash
git add README.md docs/superpowers/specs/2026-11-17-dual-engine-approval-design.md
git commit -m "docs: document dual-mode settings and record V1 status (refs andrew-barnett/slack-review-bot#55)"
```

---

## Self-review notes

- **Spec coverage (Plan 1 scope):**
  - 5.1 → Tasks 1-2
  - 5.2 → Tasks 6-8
  - 5.4 → Task 3
  - 5.7 → Tasks 4-5
  - 9 (approver token never in the child, engine-token routing) → Task 2
  - 8/V1 status → Task 9
  - Plan 2 owns: 5.3, 5.5, 5.6, 5.8, 5.9, 5.10, and the human-gate comment moving to the approver token (5.7, last bullet). These are listed in the header.
- **Spec interpretation:** rule 7's "`codeowners/errors` non-empty → `wontCount`" applies only when code-owner review is required, because that rule covers sources "that rules 1-5 need". This is pinned by a Task 7 test.
- **Type consistency:**
  - `Permission`, `ReviewFact` and `LatestPush` are defined once (Task 5) and imported by Task 7.
  - `teamMembership` keys are `@team-lower|login-lower`, produced in Task 8 and consumed in Task 7.
  - `reviewerPermissions` keys are lower-case logins in both.
