# Container Split — Plan 2b: Orchestrator and One-Shot Worker Containers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split the bot into an always-on orchestrator container that holds the Slack and approver tokens and never runs PR code, and one-shot worker containers that each run exactly one engine attempt with only low-value, short-lived engine credentials, supervised on the laptop by a host launcher, behind `RUNTIME=container`.

**Architecture:** The seam is the two report-only engine run functions (`runCodexReportOnly`, `runClaudeReview`). In the container runtime they are replaced by remote functions with the same signatures that queue a job on an in-process job broker. Workers pull jobs over HTTP on an internal Compose network, authenticate with a one-use HMAC claim ticket the launcher minted, receive a per-job token, stream progress, heartbeats and run-log chunks back, and post one result whose error classes are rebuilt on the orchestrator so the existing retry logic is unchanged. Secrets reach both containers as one JSON line on stdin from the launcher, which alone holds the operator's AWS login. Single mode in the container runtime becomes the dual runner with one engine and approvals disabled.

**Tech Stack:** TypeScript 5.9 (CommonJS via ts-node for tests, esbuild bundles for `dist/`), Node 22 (`http`, `crypto`, global `fetch`), `tape` tests, Docker Desktop with Compose v5 and Buildx, the AWS CLI v2, `gh` 2.103, codex-cli 0.169.0, Claude Code 2.1.284, `tini`.

**Spec:** `docs/superpowers/specs/2026-11-18-container-split-design.md` (the binding authority; sections 2, 3, 5, 6 and 7; section 4 is out of scope). Tracking: https://github.com/andrew-barnett/slack-review-bot/issues/70. Resolves the gate in https://github.com/andrew-barnett/slack-review-bot/issues/64 and the split in https://github.com/andrew-barnett/slack-review-bot/issues/34. Infrastructure: https://github.com/andrew-barnett/slack-review-bot/issues/68.

**Builds on Phase 2a, which must be merged first:** https://github.com/andrew-barnett/slack-review-bot/pull/73 (branch `feat/bedrock-engine-auth`, https://github.com/andrew-barnett/slack-review-bot/issues/69). Every task assumes these 2a interfaces exist on `main`:

- `src/bedrock-auth.ts`: `AwsCredentials`, `BedrockAuth`, `engineSessionSeconds(runTimeoutMs)`, `engineSessionName(runId)`, `assumeEngineRole(options)`, `resolveBedrockAuth(config, engine, runId, exec?)`, `makeEngineAuth(config, exec?)`.
- `src/config.ts`: `ReviewConfig.engineAuth` (`'subscription' | 'bedrock'`), `bedrockRegion`, `codexBedrockModel`, `claudeBedrockModel`, `engineRoleArn`, `engineAwsProfile`, `engineAwsStatic?: AwsCredentials`; `scrubDaemonSecrets(env, config?)` also deleting `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`/`AWS_SESSION_TOKEN` when static credentials were captured.
- `src/engine.ts`: `EngineAuthResolver`, `EngineDeps.engineAuth?`; `src/review.ts`: `RunnerDeps.engineAuth?`.
- `src/codex.ts` / `src/claude.ts`: `CodexRunOptions.bedrock?: BedrockAuth`, `ClaudeRunOptions.bedrock?: BedrockAuth`.
- `src/redact.ts`: `registerHeldSecret(value)`.
- `src/app.ts`: `scrubDaemonSecrets(process.env, config)` and `engineAuth: makeEngineAuth(config)` in the `selectReviewRunner` deps.

Before Task 1, confirm the merge: `git log --oneline origin/main | grep -c 'bedrock'` must print a number greater than 0, and `test -f src/bedrock-auth.ts` must succeed. If either fails, stop: this plan cannot start.

**Binding rulings on spec ambiguities (the spec wins on any conflict):**

1. **Wire options are a strict subset.** The claim reply's `options` carries only `prompt`, `worktreeRoot`, `timeoutMs`, `stallTimeoutMs` and `runId`. Everything machine-local (`codexBin`, `profile`, `claudeBin`, `configDir`, `workspaceRoot`, `envPassthrough`, `disableGitSigning`) and every credential (`engineGhToken`, `bedrock`) comes from the worker's own config. This is "the run-options object with its function fields removed" made stricter, so no orchestrator value can widen what a worker does.
2. **Report-only clean outcome.** With `approvals: false`, every outcome that would have approved (`approved`, `approvedPartial`) or noted a non-counting approval (`cleanNotCounted`) becomes a new `PrOutcome` `'clean'`, posted as one `COMMENT`. Slack shows it with `APPROVAL_NOT_COUNTED_EMOJI` (never the approval stamp) and counts it as a `pass` in `status`.
3. **update-branch stays on with approvals off.** Single mode in the container runtime is the dual runner, so it updates a branch whose base moved exactly as dual mode does (never under `require_last_push_approval`). Without it, every stale-base PR would come back `blocked`, because report-only engines never merge the base.
4. **`REVIEW_ENGINES=claude` is accepted only with `RUNTIME=container`.** The launchd runtime keeps `codex` or `codex,claude`.
5. **Waiting for a worker** is shown as the run's last status line (`[codex] waiting for a worker`), not by moving the request back to the Waiting list: the request already holds its `CONCURRENCY` slot, and the status registry has no per-attempt state for it.
6. **Cancellation of a job no worker has claimed** rejects it at once with the kind's output error (`cancelled by shutdown before a worker claimed it`). A claimed job is cancelled through the `409` path. When `drainChildRegistry` escalates to `SIGKILL`, every unsettled job is rejected (`abandonAll`). After `cancelAll`, the broker refuses new submissions, so a retry started during shutdown cannot queue.
7. **Laptop sleep is not worker loss.** The broker's 5 s sweep discounts a sweep that fired more than 15 s late (the machine or the Docker VM was suspended) by resetting every claimed job's heartbeat clock, the same idea as `deadline.ts`.
8. **Role identity in containers.** No container holds both role tokens. The orchestrator doctor checks that the approver token's login equals `ROLE_GH_LOGIN` and differs from `OPERATOR_GH_LOGIN`; the worker doctor checks the same for the engine token. Together they give "both tokens are the role account, which is not the operator". `ROLE_GH_LOGIN` is a new non-secret launcher setting alongside `OPERATOR_GH_LOGIN`.
9. **Launcher in TypeScript.** `scripts/launcher` is a thin wrapper around `node dist/launcher.js`, so the credential-minting arguments, the backoff and the shutdown ordering are unit-tested with injected `exec` and Docker doubles (spec section 6).
10. **Stale containers.** At start-up the launcher force-removes a leftover `slack-review-bot-orchestrator` first, then leftover `slack-review-bot-worker-<slot>` containers, and only then starts anything. Workers are named per slot so the launcher can signal them by name.
11. **An orchestrator that exits on its own** makes the launcher stop its workers (the orchestrator is gone, so this is allowed) and exit 1; launchd's `KeepAlive` restarts the whole stack with fresh secrets and a fresh `LAUNCH_KEY`.
12. **The `review-pr` skill and the secret-blocking hook** enter the image through a named build context built from `git archive` of a pinned commit in the operator's local `aqua-skills` clone (`docker/aqua-skills.ref`). No GitHub token is used during the build.
13. **The npm token never touches disk.** The worker's npmrc names the registry and reads the token through npm's `${NPM_TOKEN}` substitution; the value stays in the worker's environment, which is allowlisted to engine children already.
14. **Profile checker build mode.** `docker build` steps have no `/.dockerenv`, so the image build runs the container-mode checker with `--build`, which skips only the "running in a container" probe. The worker doctor runs the full check.

## Global Constraints

- Phase 2a (https://github.com/andrew-barnett/slack-review-bot/pull/73) is merged before Task 1. Use its interfaces as listed above; do not re-implement them.
- Scope is the laptop (Compose) runtime only. Nothing in spec section 4 (ECS) is built.
- `RUNTIME=container` is opt-in. With `RUNTIME` unset (`launchd`), behaviour is unchanged: `dist/app.js`, the LaunchAgent, today's single mode, every existing test.
- `DUAL_MODE_AVAILABLE` in `src/config.ts` stays `false` in every task, in both runtimes.
- Image: base `node:22-bookworm-slim`; installs `git`, `gh`, `python3`, `jq`, `tini` (PID 1), the AWS CLI v2, and pinned `@openai/codex` and `@anthropic-ai/claude-code`. Pins are bumped by PR, never `latest`. Runs as a non-root `bot` user (UID 10001). No Docker socket and no host home mount. Two entrypoints: `node dist/orchestrator.js` and `node dist/worker.js`.
- `LAUNCH_KEY`: a random 32-byte key the launcher generates per boot and gives **only** to the orchestrator.
- Claim ticket: `ticket = nonce + "." + base64url(HMAC-SHA256(LAUNCH_KEY, nonce))`, with a fresh random 16-byte nonce carrying a timestamp prefix. The orchestrator verifies the HMAC in constant time, records the nonce as spent on its first successful claim (a spent nonce gets `403`), and rejects tickets older than `WORKER_IDLE_EXIT_MS` + 1 minute.
- `POST /v1/claim` long-polls up to 25 s; `204` means no job yet and the ticket is **not** spent; `403` is a bad, spent or expired ticket; `200 {jobId, jobToken, kind, options}`; `kind` is `codex-report-only` or `claude-review`.
- A job token for job A is rejected on job B (`403`). The result is accepted once; after that the token is dead.
- Heartbeat every 10 s. No heartbeat for 45 s fails the job with `CodexOutputError` / `ClaudeRunError('output')` and the message "worker lost"; that is not a stall and is not retried.
- Run-log chunks: UTF-8, at most 1 MiB per request and 50 MiB per job, appended to `<RUN_LOG_DIR>/<runId>.log` on the orchestrator.
- `SerializedRunError` is `{class, message, ...fields}` for `CodexStalledError` (snapshot), `CodexTimeoutError` (snapshot), `CodexOutputError` (`activeMs`, `tokensUsed`) and `ClaudeRunError` (`kind`, `activeMs`, `usage`); any other class comes back as a plain `Error` with a redacted message.
- Secret delivery: both entrypoints read **one** JSON line from stdin, at most 64 KiB and within 10 s, or exit non-zero; then close stdin. The worker exports its values into its own process environment; the orchestrator puts its values only into its config object, never its environment. No secret-bearing variable in the image or `compose.yaml`; no Compose `secrets:`; no `-e`/`environment:` secrets.
- Worker: `ENGINE_AUTH=bedrock` with no `ENGINE_ROLE_ARN` (Phase 2a's static-credentials mode). It never receives `LAUNCH_KEY`. `npm_config_userconfig=/home/bot/.npmrc-worker`.
- `WORKER_IDLE_EXIT_MS` default 10 minutes. `WORKER_SLOTS` default `2 × CONCURRENCY`. After a worker exits the slot backs off 1 s; failing to mint credentials backs off exponentially up to 5 minutes and logs the STS error line, never a credential.
- CodeArtifact token: domain `trade-platform`, owner `153538148884`, `us-east-2`.
- The launcher assumes `SlackReviewBotSecretsReaderRole` (from `LAUNCHER_AWS_PROFILE`, default `staging`) and `SlackReviewBotEngineRole` once per worker, each directly from the operator's IAM user, never chained. It checks `APPROVER_GH_TOKEN` ≠ `ENGINE_GH_TOKEN`.
- **The launcher never stops a worker while the orchestrator is alive.** On SIGTERM: stop starting workers; SIGTERM the orchestrator only and wait; only after it exits, SIGTERM remaining workers, wait up to 30 s, then SIGKILL. A repeated SIGTERM to the launcher is ignored. The only escalation is the hard bound `SHUTDOWN_DRAIN_MS` + `SHUTDOWN_GRACE_MS` + 30 s, after which it `docker kill`s the orchestrator first, waits for it, then does the worker step.
- Codex container profile: `sandbox_mode = "danger-full-access"`, no `writable_roots`, `shell_environment_policy.inherit = "all"`, `exclude = ["AWS_*"]`. Claude container profile: `sandbox.enabled: false`, the same `permissions.deny` Read/Edit rules, `dontAsk`, and the secret-blocking hook.
- Compose: `orchestrator` (networks `jobs` + `egress`, volumes `orchestrator-state` and `runs`), `worker` (networks `jobs` + `egress`, no volumes, `read_only: false`, `tmpfs: /tmp`); both `cap_drop: [ALL]`, `security_opt: [no-new-privileges:true]`, `stdin_open: true`; memory orchestrator 512 MiB, worker `WORKER_MEMORY` default 6 GiB; `jobs` is `internal: true`; no published ports; no `restart:` on workers. The orchestrator runs with the fixed name `slack-review-bot-orchestrator`; `ORCHESTRATOR_URL` is `http://slack-review-bot-orchestrator:8080`.
- Log messages use constant event names with variable data in the fields object (the existing `log(event, fields)` style). Never log a token, a credential, a ticket or a bundle.
- Every test carries a comment stating its purpose and the regression or failure mode it catches. Tests use synthetic values only; a value that must look like a credential is assembled from pieces (`'gh' + 'p_' + 'A'.repeat(30)`).
- `Replace` blocks give the exact existing text and its replacement; apply them with the editor tool. `Create` blocks are the whole file. Make all file edits with the editor tools, not shell heredocs: the operator's secret-blocking hook rejects shell commands whose text mentions credentials or env files.
- Every new executable script gets `chmod +x` before it is committed.
- Bundles are built with esbuild's `name=path` entry form into `dist/` (`app`, `worker`, `orchestrator`, `doctor`, `launcher`). Entrypoint modules (`src/app.ts`, `src/*-main.ts`) are never imported by another module, and library modules have no top-level side effects: esbuild hoists every imported module into one scope, where a `require.main === module` guard is true for all of them. (`src/doctor.ts` keeps its existing guard because only tests import it.)
- Commits use Conventional Commits ending `(refs andrew-barnett/slack-review-bot#70)`, with `[cc](https://claude.com/claude-code)` as the last line. Production code `feat`/`fix`/`refactor`, tests-only `test`, docs `docs`, build files `build`. Commit with `git commit -F <file>`.
- Run one test file with `npx ts-node --compiler-options '{"module":"commonjs"}' --transpile-only src/<path>.test.ts`; the suite with `npm test`; typecheck with `npm run typecheck`; bundle with `npm run build`.

## Review Focus

1. **A laptop that slept with a review in flight.** On wake, every claimed job's last heartbeat is minutes old. Without a freeze discount the first sweep would fail every in-flight review as "worker lost" (and, being an output error, never retry it). A sweep that fires far later than scheduled resets the heartbeat clocks instead. Pinned in Task 3 (`broker sweep after a freeze does not fail claimed jobs as worker lost`).
2. **A worker whose claim connection drops mid long-poll.** If the broker kept the dead waiter, the next job would be "claimed" by nobody and then fail 45 s later as worker lost. An aborted claim must remove its waiter so the job goes to the next live claim. Pinned in Task 3 (`server: a claim aborted by the client does not swallow the next job`).
3. **A malformed or hostile result body.** A compromised worker controls its result JSON: `result.results` may be missing, findings may have the wrong types, numbers may be negative or `NaN`. That must become the engine's output error (an invalid pass), never a crash in the orchestrator and never a clean pass. Pinned in Task 4 (`remote runCodex turns a malformed outcome into CodexOutputError`, `remote runClaude normalizes hostile usage numbers`).
4. **The same ticket presented twice at once.** Two concurrent long-polls with one ticket are both valid until the nonce is spent; only one may receive a job, and the other must get `403` rather than a second job. Pinned in Task 3 (`broker gives one ticket at most one job even with two concurrent claims`).
5. **A launcher restarted after a crash with the old orchestrator still running.** A leftover `slack-review-bot-orchestrator` would make `run --name` fail, and a still-connected old orchestrator would double-review. Start-up removes the old orchestrator first, then the old workers, then starts the new stack. Pinned in Task 13 (`launcher removes the stale orchestrator before stale workers and before starting anything`).

---

## File Structure

| File | Responsibility |
|---|---|
| `src/jobs/errors.ts` (create) | `SerializedRunError`, `serializeRunError`, `deserializeRunError` |
| `src/jobs/ticket.ts` (create) | `mintTicket`, `verifyTicket`, `createSpentNonces` |
| `src/jobs/protocol.ts` (create) | Constants, wire types, `toWireOptions`, `parseWireOptions`, `parseClaimReply` |
| `src/jobs/broker.ts` (create) | Transport-free job queue: claims, tokens, progress, logs, results, cancel, worker loss, `ChildRegistry` adapter |
| `src/jobs/server.ts` (create) | HTTP/1.1 adapter for the broker; `/healthz`; optional smoke route |
| `src/jobs/remote.ts` (create) | Remote `runCodex` / `runClaude` with the local signatures; outcome normalization |
| `src/jobs/client.ts` (create) | The worker's HTTP client |
| `src/jobs/runtime.ts` (create) | `startContainerRuntime`: broker + server + remote runners + approver changed-files lister |
| `src/secret-bundle.ts` (create) | `readSecretBundle`, `parseSecretBundle`, the bundle key sets |
| `src/worker.ts` (create) | `runWorker`, `assertWorkerConfig`, the npmrc writer (library, no side effects) |
| `src/worker-main.ts` (create) | Worker entrypoint, bundled as `dist/worker.js` |
| `src/orchestrator.ts` (create) | `orchestratorConfig` and `smokeJob` (library, no side effects) |
| `src/orchestrator-main.ts` (create) | Orchestrator entrypoint, bundled as `dist/orchestrator.js`: stdin bundle → config → `runDaemon`; `SMOKE=1` mode |
| `src/daemon.ts` (moved from `src/app.ts`) | `runDaemon(options)`; container wiring |
| `src/app.ts` (new, small) | launchd entrypoint |
| `src/container.ts` (create) | `inContainer()` detection |
| `src/doctor-container.ts` (create) | Pure container doctor checks with an injected probe |
| `src/launcher.ts` (create) | Launcher library: settings, AWS ops, Docker ops, worker loops, shutdown ordering, doctor subcommand |
| `src/launcher-main.ts` (create) | Launcher entrypoint, bundled as `dist/launcher.js` |
| `src/smoke.ts` (create) | Host-side compose smoke driver (run with ts-node, not bundled) |
| `src/config.ts`, `src/review.ts`, `src/github.ts`, `src/cli.ts` (modify) | `RUNTIME`, container runner selection, approver effects |
| `src/dual-gate.ts`, `src/dual.ts`, `src/render.ts`, `src/job.ts` (modify) | `approvals: false`, single-engine gate, `'clean'` outcome |
| `src/doctor.ts` (modify) | `--role orchestrator|worker` |
| `scripts/claude-profile-lib.js`, `scripts/check-claude-profile.js`, `scripts/install-claude-profile.sh` (modify), `claude/review-bot.settings.container.json.template` (create) | Claude container profile |
| `scripts/install-codex-profile.sh` (modify), `codex/review-bot.config.container.toml` (create) | Codex container profile |
| `Dockerfile`, `.dockerignore`, `docker/entrypoint.sh`, `docker/aqua-skills.ref`, `scripts/build-image.sh`, `compose.yaml` (create) | Image and stack |
| `scripts/launcher`, `scripts/install-launcher.sh`, `launchd/com.abarnett.slack-review-bot-launcher.plist.template` (create) | Host supervisor and its LaunchAgent |
| `scripts/compose-smoke.sh`, `scripts/smoke/stub-codex.js` (create) | Local integration smoke |
| `package.json` (modify) | Test runner covers `src/jobs`; build bundles every entrypoint |
| `README.md` (modify) | Container runtime, settings, doctor, smoke, cutover and rollback |
| `src/**/*.test.ts` | One test file per unit above |

---

### Task 1: Error serialization (`src/jobs/errors.ts`)

**Files:**
- Create: `src/jobs/errors.ts`
- Test: `src/jobs/errors.test.ts`
- Modify: `package.json` (the `test` script also runs `src/jobs/*.test.ts`)

**Interfaces:**
- Consumes: `CodexStalledError`, `CodexTimeoutError`, `CodexOutputError` from `src/codex.ts`; `ClaudeRunError`, `ClaudeFailureKind` from `src/claude.ts`; `DeadlineSnapshot` from `src/deadline.ts`; `ClaudeUsageDetail` from `src/usage.ts`; `redactSecrets` from `src/redact.ts`.
- Produces:
  - `type SerializedRunError = { class: 'CodexStalledError'; message: string; stallMs: number; snapshot: DeadlineSnapshot } | { class: 'CodexTimeoutError'; message: string; snapshot: DeadlineSnapshot } | { class: 'CodexOutputError'; message: string; tokensUsed?: number; activeMs: number } | { class: 'ClaudeRunError'; message: string; kind: ClaudeFailureKind; activeMs: number; usage?: ClaudeUsageDetail } | { class: 'Error'; message: string }`
  - `serializeRunError(error: unknown): SerializedRunError`
  - `deserializeRunError(value: unknown): Error`
  - `usageOf(value: unknown): ClaudeUsageDetail | undefined` (also used by Task 4)
  - `nonNegative(value: unknown): number` and `optionalNonNegative(value: unknown): number | undefined` (also used by Task 4)

- [ ] **Step 1: Let the test runner reach `src/jobs`**

In `package.json`, replace:

```json
    "test": "ts-node --compiler-options '{\"module\":\"commonjs\"}' --transpile-only -e \"const fs=require('fs');const path=require('path');for(const f of fs.readdirSync('src').filter(n=>n.endsWith('.test.ts')).sort()){require(path.resolve('src',f));}\"",
```

with:

```json
    "test": "ts-node --compiler-options '{\"module\":\"commonjs\"}' --transpile-only -e \"const fs=require('fs');const path=require('path');for(const d of ['src','src/jobs']){if(!fs.existsSync(d))continue;for(const f of fs.readdirSync(d).filter(n=>n.endsWith('.test.ts')).sort()){require(path.resolve(d,f));}}\"",
```

- [ ] **Step 2: Write the failing tests**

Create `src/jobs/errors.test.ts`:

```ts
import test from 'tape'
import { ClaudeRunError } from '../claude'
import { CodexOutputError, CodexStalledError, CodexTimeoutError } from '../codex'
import { deserializeRunError, serializeRunError } from './errors'

const snapshot = { activeMs: 5000, wallMs: 9000, frozenMs: 4000 }
const usage = { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4, costUsd: 0.5, numTurns: 6, durationMs: 7 }
/** Round-trip through JSON, exactly as the HTTP body does. */
const wire = (error: unknown) => deserializeRunError(JSON.parse(JSON.stringify(serializeRunError(error))))

// The orchestrator's retry logic decides by instanceof: only a stall is retried. If a stall from a
// worker came back as a plain Error, every remote stall would be terminal (spec 3.3 error round-trip).
test('a CodexStalledError survives the wire with its class, stallMs and snapshot', t => {
  const back = wire(new CodexStalledError('stalled', 600_000, snapshot))
  t.ok(back instanceof CodexStalledError)
  const stalled = back as CodexStalledError
  t.equal(stalled.message, 'stalled')
  t.equal(stalled.stallMs, 600_000)
  t.deepEqual(stalled.snapshot, snapshot)
  t.end()
})

// A timeout must stay terminal and keep the active time it spent, or usage would under-report it.
test('a CodexTimeoutError survives the wire with its snapshot', t => {
  const back = wire(new CodexTimeoutError('timed out', snapshot))
  t.ok(back instanceof CodexTimeoutError)
  t.deepEqual((back as CodexTimeoutError).snapshot, snapshot)
  t.end()
})

// An output error carries the tokens and time the run spent; dropping them would report a costly
// failed run as free.
test('a CodexOutputError survives the wire with tokensUsed and activeMs', t => {
  const back = wire(new CodexOutputError('bad output', 1234, 99)) as CodexOutputError
  t.ok(back instanceof CodexOutputError)
  t.equal(back.tokensUsed, 1234)
  t.equal(back.activeMs, 99)
  const none = wire(new CodexOutputError('bad output', undefined, 0)) as CodexOutputError
  t.equal(none.tokensUsed, undefined, 'an unknown token count stays unknown, not 0')
  t.end()
})

// Claude's kind decides retry (only 'stall'), and its usage is charged across attempts.
test('a ClaudeRunError survives the wire with kind, activeMs and usage', t => {
  const back = wire(new ClaudeRunError('stalled', 'stall', 42, usage)) as ClaudeRunError
  t.ok(back instanceof ClaudeRunError)
  t.equal(back.kind, 'stall')
  t.equal(back.activeMs, 42)
  t.deepEqual(back.usage, usage)
  t.equal((wire(new ClaudeRunError('x', 'output', 1)) as ClaudeRunError).usage, undefined)
  t.end()
})

// Any other class (a spawn ENOENT, a bug) must come back as a plain Error whose message is redacted:
// it reaches the Slack error thread, and the worker ran untrusted code that may have printed a token.
test('an unknown error class comes back as a plain Error with a redacted message', t => {
  const fake = 'gh' + 'p_' + 'A'.repeat(30)
  const back = wire(new TypeError(`boom ${fake}`))
  t.equal(back.constructor, Error)
  t.notOk(back.message.includes(fake), 'the token-shaped text is masked')
  t.ok(back.message.startsWith('boom '))
  t.equal(wire('a thrown string').message, 'a thrown string')
  t.end()
})

// The body is attacker-controlled (a compromised worker). Nonsense must never throw, and must never
// produce negative or NaN numbers that would corrupt usage totals.
test('deserializeRunError tolerates hostile shapes', t => {
  t.equal(deserializeRunError(null).constructor, Error)
  t.equal(deserializeRunError({ class: 'CodexStalledError' }).constructor, CodexStalledError)
  const stalled = deserializeRunError({ class: 'CodexStalledError', message: 1, stallMs: -5, snapshot: { activeMs: 'x' } }) as CodexStalledError
  t.equal(stalled.stallMs, 0)
  t.deepEqual(stalled.snapshot, { activeMs: 0, wallMs: 0, frozenMs: 0 })
  const claude = deserializeRunError({ class: 'ClaudeRunError', message: 'm', kind: 'reboot', activeMs: Number.NaN }) as ClaudeRunError
  t.equal(claude.kind, 'output', 'an unknown kind is never retryable')
  t.equal(claude.activeMs, 0)
  t.equal(deserializeRunError({ class: 'Error', message: 'x'.repeat(20_000) }).message.length, 8000, 'messages are capped')
  t.end()
})
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx ts-node --compiler-options '{"module":"commonjs"}' --transpile-only src/jobs/errors.test.ts`
Expected: FAIL with `Cannot find module './errors'`.

- [ ] **Step 4: Write the implementation**

Create `src/jobs/errors.ts`:

```ts
// The error round-trip of the job protocol (spec 3.3). A worker serializes the error its local run
// function threw; the orchestrator rebuilds the same class, so the engines' instanceof-based retry
// logic (only a stall is retried) works unchanged across the process boundary. The body comes from a
// container that ran untrusted PR code, so every field is validated and every message redacted.

import { ClaudeRunError, type ClaudeFailureKind } from '../claude'
import { CodexOutputError, CodexStalledError, CodexTimeoutError } from '../codex'
import type { DeadlineSnapshot } from '../deadline'
import { redactSecrets } from '../redact'
import type { ClaudeUsageDetail } from '../usage'

export type SerializedRunError =
  | { class: 'CodexStalledError'; message: string; stallMs: number; snapshot: DeadlineSnapshot }
  | { class: 'CodexTimeoutError'; message: string; snapshot: DeadlineSnapshot }
  | { class: 'CodexOutputError'; message: string; tokensUsed?: number; activeMs: number }
  | { class: 'ClaudeRunError'; message: string; kind: ClaudeFailureKind; activeMs: number; usage?: ClaudeUsageDetail }
  | { class: 'Error'; message: string }

/** Longest message kept; an error tail is already capped at 1500 characters by the runners. */
const MAX_MESSAGE = 8000
const CLAUDE_KINDS: ReadonlySet<string> = new Set<ClaudeFailureKind>(['timeout', 'stall', 'output'])

const text = (value: unknown): string => redactSecrets(typeof value === 'string' ? value : String(value ?? '')).slice(0, MAX_MESSAGE)

/** A finite, non-negative number, or 0. */
export function nonNegative(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
}

/** A finite, non-negative number, or undefined (an unknown count stays unknown). */
export function optionalNonNegative(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}

function snapshotOf(value: unknown): DeadlineSnapshot {
  const s = record(value)
  return { activeMs: nonNegative(s.activeMs), wallMs: nonNegative(s.wallMs), frozenMs: nonNegative(s.frozenMs) }
}

/** Claude's usage breakdown with every field forced to a finite, non-negative number. */
export function usageOf(value: unknown): ClaudeUsageDetail | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const u = value as Record<string, unknown>
  return {
    inputTokens: nonNegative(u.inputTokens),
    outputTokens: nonNegative(u.outputTokens),
    cacheReadTokens: nonNegative(u.cacheReadTokens),
    cacheWriteTokens: nonNegative(u.cacheWriteTokens),
    costUsd: nonNegative(u.costUsd),
    numTurns: nonNegative(u.numTurns),
    durationMs: nonNegative(u.durationMs),
  }
}

/** The worker side: describe a thrown value so the orchestrator can rebuild it. */
export function serializeRunError(error: unknown): SerializedRunError {
  if (error instanceof CodexStalledError) {
    return { class: 'CodexStalledError', message: text(error.message), stallMs: error.stallMs, snapshot: { ...error.snapshot } }
  }
  if (error instanceof CodexTimeoutError) {
    return { class: 'CodexTimeoutError', message: text(error.message), snapshot: { ...error.snapshot } }
  }
  if (error instanceof CodexOutputError) {
    return {
      class: 'CodexOutputError',
      message: text(error.message),
      activeMs: error.activeMs,
      ...(error.tokensUsed !== undefined ? { tokensUsed: error.tokensUsed } : {}),
    }
  }
  if (error instanceof ClaudeRunError) {
    return {
      class: 'ClaudeRunError',
      message: text(error.message),
      kind: error.kind,
      activeMs: error.activeMs,
      ...(error.usage ? { usage: { ...error.usage } } : {}),
    }
  }
  return { class: 'Error', message: text(error instanceof Error ? error.message : error) }
}

/** The orchestrator side: rebuild the error class the worker's run function threw. Never throws. */
export function deserializeRunError(value: unknown): Error {
  const e = record(value)
  const message = text(e.message)
  switch (e.class) {
    case 'CodexStalledError':
      return new CodexStalledError(message, nonNegative(e.stallMs), snapshotOf(e.snapshot))
    case 'CodexTimeoutError':
      return new CodexTimeoutError(message, snapshotOf(e.snapshot))
    case 'CodexOutputError':
      return new CodexOutputError(message, optionalNonNegative(e.tokensUsed), nonNegative(e.activeMs))
    case 'ClaudeRunError': {
      // An unknown kind is treated as output: never retryable, never a timeout's budget claim.
      const kind = typeof e.kind === 'string' && CLAUDE_KINDS.has(e.kind) ? (e.kind as ClaudeFailureKind) : 'output'
      return new ClaudeRunError(message, kind, nonNegative(e.activeMs), usageOf(e.usage))
    }
    default:
      return new Error(message)
  }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx ts-node --compiler-options '{"module":"commonjs"}' --transpile-only src/jobs/errors.test.ts`
Expected: PASS (all six tests).

Run: `npm test 2>&1 | tail -5`
Expected: the summary line ends with `# ok`; the new tests are included in the count.

- [ ] **Step 6: Commit**

Write the message to `/tmp/srb-commit-msg.txt` with the editor tool:

```text
feat(jobs): serialize engine run errors across the job protocol (refs andrew-barnett/slack-review-bot#70)

Workers run the engines in another container, so the error classes the
retry logic depends on must survive a JSON round-trip. Hostile fields are
clamped and every message is redacted.

[cc](https://claude.com/claude-code)
```

Run: `git add package.json src/jobs/errors.ts src/jobs/errors.test.ts && git commit -F /tmp/srb-commit-msg.txt`

---

### Task 2: Claim tickets and the wire protocol (`src/jobs/ticket.ts`, `src/jobs/protocol.ts`)

**Files:**
- Create: `src/jobs/ticket.ts`, `src/jobs/protocol.ts`
- Test: `src/jobs/ticket.test.ts`, `src/jobs/protocol.test.ts`

**Interfaces:**
- Consumes: `SerializedRunError` (Task 1).
- Produces (ticket.ts):
  - `LAUNCH_KEY_BYTES = 32`, `NONCE_RANDOM_BYTES = 16`, `TICKET_FUTURE_SKEW_MS = 60_000`
  - `mintTicket(key: Buffer, nowMs: number, random?: (n: number) => Buffer): string`
  - `type TicketCheck = { ok: true; nonce: string } | { ok: false; reason: 'malformed' | 'signature' | 'expired' }`
  - `verifyTicket(key: Buffer, ticket: string, nowMs: number, maxAgeMs: number): TicketCheck`
  - `interface SpentNonces { has(nonce: string): boolean; spend(nonce: string, nowMs: number): boolean; prune(nowMs: number): void; size(): number }`
  - `createSpentNonces(maxAgeMs: number): SpentNonces`
- Produces (protocol.ts):
  - Constants: `JOB_PORT = 8080`, `CLAIM_WAIT_MS = 25_000`, `HEARTBEAT_MS = 10_000`, `WORKER_LOST_MS = 45_000`, `LOG_CHUNK_LIMIT = 1024 * 1024`, `LOG_JOB_LIMIT = 50 * 1024 * 1024`, `JSON_BODY_LIMIT = 16 * 1024 * 1024`, `PROGRESS_LINE_LIMIT = 4096`, `TICKET_GRACE_MS = 60_000`, `RUN_ID_RE`, `JOB_ID_RE`, `JOB_TOKEN_RE`
  - `type JobKind = 'codex-report-only' | 'claude-review'`; `JOB_KINDS: readonly JobKind[]`
  - `interface WireRunOptions { prompt: string; worktreeRoot: string; timeoutMs: number; stallTimeoutMs?: number; runId: string }`
  - `interface ClaimReply { jobId: string; jobToken: string; kind: JobKind; options: WireRunOptions }`
  - `interface ProgressBody { line: string; activeMs: number }`
  - `type ResultBody = { ok: true; outcome: unknown } | { ok: false; error: SerializedRunError }`
  - `toWireOptions(options: WireRunOptions): WireRunOptions` (picks exactly the five fields from any larger options object)
  - `parseWireOptions(value: unknown): WireRunOptions` (throws on anything invalid)
  - `parseClaimReply(value: unknown): ClaimReply` (throws on anything invalid)
  - `ticketMaxAgeMs(workerIdleExitMs: number): number`

- [ ] **Step 1: Write the failing tests**

Create `src/jobs/ticket.test.ts`:

```ts
import test from 'tape'
import { createSpentNonces, mintTicket, verifyTicket } from './ticket'

const key = Buffer.alloc(32, 7)
const other = Buffer.alloc(32, 8)
const T0 = 1_800_000_000_000
const TEN_MIN = 10 * 60_000

// The ticket is a worker's only credential (spec 3.3). It must verify under the launch key that
// minted it and carry a nonce the orchestrator can spend exactly once.
test('a minted ticket verifies and yields its nonce', t => {
  const ticket = mintTicket(key, T0)
  t.match(ticket, /^\d{13}-[0-9a-f]{32}\.[A-Za-z0-9_-]{43}$/, 'nonce = ms timestamp + 16 random bytes; HMAC is base64url')
  const check = verifyTicket(key, ticket, T0 + 1000, TEN_MIN + 60_000)
  t.deepEqual(check, { ok: true, nonce: ticket.split('.')[0] })
  t.end()
})

// Forgery: a ticket minted under another key, or with its nonce or MAC altered, must not verify.
// Regression caught: comparing only part of the MAC, or trusting the nonce without the MAC.
test('a ticket from another key or with any byte changed is rejected', t => {
  const ticket = mintTicket(key, T0)
  t.deepEqual(verifyTicket(other, ticket, T0, TEN_MIN), { ok: false, reason: 'signature' })
  const [nonce, mac] = ticket.split('.')
  const flipped = nonce.slice(0, -1) + (nonce.endsWith('0') ? '1' : '0')
  t.deepEqual(verifyTicket(key, `${flipped}.${mac}`, T0, TEN_MIN), { ok: false, reason: 'signature' })
  // The first base64url character carries six fully used bits, so changing it always changes the MAC.
  const forged = (mac[0] === 'A' ? 'B' : 'A') + mac.slice(1)
  t.deepEqual(verifyTicket(key, `${nonce}.${forged}`, T0, TEN_MIN), { ok: false, reason: 'signature' })
  t.end()
})

// Garbage must be rejected without throwing (the header comes from any container on the network).
test('malformed tickets are rejected without throwing', t => {
  for (const bad of ['', 'x', 'a.b', '.', `${'1'.repeat(13)}-${'a'.repeat(32)}.`, `${'1'.repeat(13)}-${'a'.repeat(32)}.${'!'.repeat(43)}`]) {
    t.deepEqual(verifyTicket(key, bad, T0, TEN_MIN), { ok: false, reason: 'malformed' }, JSON.stringify(bad))
  }
  t.end()
})

// Expiry: a ticket older than WORKER_IDLE_EXIT_MS + 1 minute is dead, so a ticket stolen from a
// long-gone worker cannot be replayed. A ticket "from the future" beyond a minute of clock skew
// between the host and the Docker VM is also refused.
test('verifyTicket enforces the age limit and bounds future skew', t => {
  const ticket = mintTicket(key, T0)
  const max = TEN_MIN + 60_000
  t.equal(verifyTicket(key, ticket, T0 + max, max).ok, true, 'exactly at the limit')
  t.deepEqual(verifyTicket(key, ticket, T0 + max + 1, max), { ok: false, reason: 'expired' })
  t.equal(verifyTicket(key, ticket, T0 - 59_000, max).ok, true, 'small skew tolerated')
  t.deepEqual(verifyTicket(key, ticket, T0 - 61_000, max), { ok: false, reason: 'expired' })
  t.end()
})

// The spent set is what makes a ticket one-use. Pruning must only drop nonces whose tickets would be
// rejected as expired anyway, or a pruned nonce would become replayable.
test('spent nonces are one-use and pruned only after their tickets expire', t => {
  const max = TEN_MIN + 60_000
  const spent = createSpentNonces(max)
  const nonce = mintTicket(key, T0).split('.')[0]
  t.equal(spent.spend(nonce, T0), true)
  t.equal(spent.spend(nonce, T0 + 1), false, 'a second spend fails')
  t.equal(spent.has(nonce), true)
  spent.prune(T0 + max)
  t.equal(spent.has(nonce), true, 'kept while its ticket could still verify')
  spent.prune(T0 + max + 60_001)
  t.equal(spent.has(nonce), false, 'dropped once the ticket is past age and skew')
  t.end()
})

// Each ticket must differ even when minted in the same millisecond.
test('mintTicket uses fresh randomness per ticket', t => {
  t.notEqual(mintTicket(key, T0), mintTicket(key, T0))
  t.throws(() => mintTicket(Buffer.alloc(16), T0), /32 bytes/)
  t.end()
})
```

Create `src/jobs/protocol.test.ts`:

```ts
import test from 'tape'
import { parseClaimReply, parseWireOptions, ticketMaxAgeMs, toWireOptions } from './protocol'

const good = { prompt: 'review', worktreeRoot: '/work/wt/codex', timeoutMs: 1000, stallTimeoutMs: 500, runId: 'C1-11.codex' }

// Nothing but the five wire fields may leave the orchestrator: not the engine token, not Bedrock
// credentials, not a binary path or profile a worker would then trust (ruling 1). Regression caught:
// spreading the whole run-options object into the claim reply.
test('toWireOptions keeps exactly the five wire fields', t => {
  const full = {
    ...good,
    engineGhToken: 'engine-placeholder',
    bedrock: { region: 'us-east-2', model: 'm', credentials: { accessKeyId: 'a', secretAccessKey: 's' } },
    codexBin: '/evil/codex',
    profile: 'p',
    workspaceRoot: '/',
    disableGitSigning: false,
    envPassthrough: ['APPROVER_GH_TOKEN'],
    registry: {},
    log: () => {},
    onProgress: () => {},
  }
  t.deepEqual(Object.keys(toWireOptions(full)).sort(), ['prompt', 'runId', 'stallTimeoutMs', 'timeoutMs', 'worktreeRoot'])
  t.deepEqual(Object.keys(toWireOptions({ ...good, stallTimeoutMs: undefined })).sort(), ['prompt', 'runId', 'timeoutMs', 'worktreeRoot'])
  t.end()
})

// The worker validates what it is told to run; a run id with a path separator would let the log
// file escape RUN_LOG_DIR, and a relative worktree root would land in the process cwd.
test('parseWireOptions rejects unsafe or missing fields', t => {
  t.deepEqual(parseWireOptions(good), good)
  t.throws(() => parseWireOptions({ ...good, runId: '../x' }), /runId/)
  t.throws(() => parseWireOptions({ ...good, worktreeRoot: 'relative' }), /worktreeRoot/)
  t.throws(() => parseWireOptions({ ...good, prompt: '' }), /prompt/)
  t.throws(() => parseWireOptions({ ...good, timeoutMs: -1 }), /timeoutMs/)
  t.throws(() => parseWireOptions({ ...good, stallTimeoutMs: 'x' }), /stallTimeoutMs/)
  t.throws(() => parseWireOptions(null), /options/)
  t.end()
})

// The claim reply is the job assignment; a malformed one must be refused rather than half-used.
test('parseClaimReply validates id, token and kind', t => {
  const reply = { jobId: 'abc123', jobToken: 'f'.repeat(64), kind: 'claude-review', options: good }
  t.deepEqual(parseClaimReply(reply), reply)
  t.throws(() => parseClaimReply({ ...reply, kind: 'shell' }), /kind/)
  t.throws(() => parseClaimReply({ ...reply, jobToken: 'short' }), /jobToken/)
  t.throws(() => parseClaimReply({ ...reply, jobId: 'a/b' }), /jobId/)
  t.end()
})

// Spec 3.3: tickets older than WORKER_IDLE_EXIT_MS + 1 minute are rejected.
test('ticketMaxAgeMs adds one minute to the idle exit', t => {
  t.equal(ticketMaxAgeMs(600_000), 660_000)
  t.end()
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx ts-node --compiler-options '{"module":"commonjs"}' --transpile-only src/jobs/ticket.test.ts`
Expected: FAIL with `Cannot find module './ticket'`.

- [ ] **Step 3: Write the implementation**

Create `src/jobs/ticket.ts`:

```ts
// One-use claim tickets (spec 3.3). The launcher mints one per worker from LAUNCH_KEY, which only it
// and the orchestrator hold; the worker presents it once, before any PR code exists in its container.
// The orchestrator verifies the HMAC in constant time and spends the nonce on the first successful
// claim, so a worker can claim at most one job, ever.

import { createHmac, randomBytes, timingSafeEqual } from 'crypto'

export const LAUNCH_KEY_BYTES = 32
export const NONCE_RANDOM_BYTES = 16
/** How far a ticket's timestamp may be ahead of the verifier's clock (host vs Docker VM skew). */
export const TICKET_FUTURE_SKEW_MS = 60_000

/** `<13-digit ms timestamp>-<32 hex>`: the timestamp prefix makes expiry checkable. */
const NONCE_RE = /^(\d{13})-([0-9a-f]{32})$/
/** base64url of a 32-byte HMAC-SHA256, unpadded. */
const MAC_RE = /^[A-Za-z0-9_-]{43}$/

function mac(key: Buffer, nonce: string): Buffer {
  return createHmac('sha256', key).update(nonce, 'utf8').digest()
}

export function mintTicket(key: Buffer, nowMs: number, random: (n: number) => Buffer = randomBytes): string {
  if (key.length !== LAUNCH_KEY_BYTES) throw new Error(`LAUNCH_KEY must be ${LAUNCH_KEY_BYTES} bytes`)
  const nonce = `${String(Math.floor(nowMs)).padStart(13, '0')}-${random(NONCE_RANDOM_BYTES).toString('hex')}`
  return `${nonce}.${mac(key, nonce).toString('base64url')}`
}

export type TicketCheck = { ok: true; nonce: string } | { ok: false; reason: 'malformed' | 'signature' | 'expired' }

export function verifyTicket(key: Buffer, ticket: string, nowMs: number, maxAgeMs: number): TicketCheck {
  const dot = ticket.lastIndexOf('.')
  const nonce = dot < 0 ? '' : ticket.slice(0, dot)
  const sig = dot < 0 ? '' : ticket.slice(dot + 1)
  const parts = NONCE_RE.exec(nonce)
  if (!parts || !MAC_RE.test(sig)) return { ok: false, reason: 'malformed' }
  const expected = mac(key, nonce)
  const given = Buffer.from(sig, 'base64url')
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return { ok: false, reason: 'signature' }
  const issuedAt = Number(parts[1])
  if (nowMs - issuedAt > maxAgeMs || issuedAt - nowMs > TICKET_FUTURE_SKEW_MS) return { ok: false, reason: 'expired' }
  return { ok: true, nonce }
}

export interface SpentNonces {
  has(nonce: string): boolean
  /** Record the nonce as spent; false when it already was. */
  spend(nonce: string, nowMs: number): boolean
  /** Forget nonces whose tickets can no longer verify (past age plus skew). */
  prune(nowMs: number): void
  size(): number
}

export function createSpentNonces(maxAgeMs: number): SpentNonces {
  // nonce -> the ticket's issue time, read from the nonce itself.
  const spent = new Map<string, number>()
  const issuedAt = (nonce: string, fallback: number): number => {
    const parts = NONCE_RE.exec(nonce)
    return parts ? Number(parts[1]) : fallback
  }
  return {
    has: nonce => spent.has(nonce),
    spend(nonce, nowMs) {
      if (spent.has(nonce)) return false
      spent.set(nonce, issuedAt(nonce, nowMs))
      return true
    },
    prune(nowMs) {
      for (const [nonce, at] of spent) {
        if (nowMs - at > maxAgeMs + TICKET_FUTURE_SKEW_MS) spent.delete(nonce)
      }
    },
    size: () => spent.size,
  }
}
```

Create `src/jobs/protocol.ts`:

```ts
// The job protocol between the orchestrator and one-shot workers (spec 3.3): HTTP/1.1 with JSON
// bodies on the internal `jobs` network. These are the shared constants, wire types and validators.

import * as path from 'path'
import type { SerializedRunError } from './errors'

export const JOB_PORT = 8080
/** How long POST /v1/claim waits for a job before answering 204. */
export const CLAIM_WAIT_MS = 25_000
export const HEARTBEAT_MS = 10_000
/** No heartbeat (or progress, or log) for this long fails the job as "worker lost". */
export const WORKER_LOST_MS = 45_000
export const LOG_CHUNK_LIMIT = 1024 * 1024
export const LOG_JOB_LIMIT = 50 * 1024 * 1024
/** A result body; findings can be long, but not this long. */
export const JSON_BODY_LIMIT = 16 * 1024 * 1024
export const PROGRESS_LINE_LIMIT = 4096
/** Spec 3.3: tickets older than WORKER_IDLE_EXIT_MS + 1 minute are rejected. */
export const TICKET_GRACE_MS = 60_000

/** A run id names a log file under RUN_LOG_DIR, so it may hold no path separator. */
export const RUN_ID_RE = /^[A-Za-z0-9._-]{1,200}$/
export const JOB_ID_RE = /^[A-Za-z0-9]{1,64}$/
export const JOB_TOKEN_RE = /^[0-9a-f]{64}$/

export type JobKind = 'codex-report-only' | 'claude-review'
export const JOB_KINDS: readonly JobKind[] = ['codex-report-only', 'claude-review']

/**
 * What crosses the wire about a run (ruling 1). Machine-local settings and every credential come
 * from the worker's own config, never from here.
 */
export interface WireRunOptions {
  prompt: string
  worktreeRoot: string
  timeoutMs: number
  stallTimeoutMs?: number
  runId: string
}

export interface ClaimReply {
  jobId: string
  jobToken: string
  kind: JobKind
  options: WireRunOptions
}

export interface ProgressBody {
  line: string
  activeMs: number
}

export type ResultBody = { ok: true; outcome: unknown } | { ok: false; error: SerializedRunError }

export function ticketMaxAgeMs(workerIdleExitMs: number): number {
  return workerIdleExitMs + TICKET_GRACE_MS
}

/** Pick exactly the wire fields from a full run-options object. */
export function toWireOptions(options: WireRunOptions): WireRunOptions {
  const out: WireRunOptions = {
    prompt: options.prompt,
    worktreeRoot: options.worktreeRoot,
    timeoutMs: options.timeoutMs,
    runId: options.runId,
  }
  if (options.stallTimeoutMs !== undefined) out.stallTimeoutMs = options.stallTimeoutMs
  return out
}

const positive = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0

export function parseWireOptions(value: unknown): WireRunOptions {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('options is not an object')
  const o = value as Record<string, unknown>
  if (typeof o.prompt !== 'string' || !o.prompt) throw new Error('options.prompt is missing')
  if (typeof o.worktreeRoot !== 'string' || !path.isAbsolute(o.worktreeRoot)) throw new Error('options.worktreeRoot is not an absolute path')
  if (!positive(o.timeoutMs)) throw new Error('options.timeoutMs is not a positive number')
  if (o.stallTimeoutMs !== undefined && !positive(o.stallTimeoutMs)) throw new Error('options.stallTimeoutMs is not a positive number')
  if (typeof o.runId !== 'string' || !RUN_ID_RE.test(o.runId)) throw new Error('options.runId is not a safe run id')
  return toWireOptions(o as unknown as WireRunOptions)
}

export function parseClaimReply(value: unknown): ClaimReply {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('claim reply is not an object')
  const r = value as Record<string, unknown>
  if (typeof r.jobId !== 'string' || !JOB_ID_RE.test(r.jobId)) throw new Error('claim reply jobId is invalid')
  if (typeof r.jobToken !== 'string' || !JOB_TOKEN_RE.test(r.jobToken)) throw new Error('claim reply jobToken is invalid')
  if (typeof r.kind !== 'string' || !(JOB_KINDS as readonly string[]).includes(r.kind)) throw new Error('claim reply kind is invalid')
  return { jobId: r.jobId, jobToken: r.jobToken, kind: r.kind as JobKind, options: parseWireOptions(r.options) }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx ts-node --compiler-options '{"module":"commonjs"}' --transpile-only src/jobs/ticket.test.ts && npx ts-node --compiler-options '{"module":"commonjs"}' --transpile-only src/jobs/protocol.test.ts`
Expected: PASS for both files.

Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 5: Commit**

Write `/tmp/srb-commit-msg.txt`:

```text
feat(jobs): add one-use claim tickets and the job wire protocol (refs andrew-barnett/slack-review-bot#70)

A worker's only credential is a ticket the launcher mints from a per-boot
key the orchestrator holds. The wire carries only the five run fields, so
no credential or machine-local path crosses to a worker.

[cc](https://claude.com/claude-code)
```

Run: `git add src/jobs/ticket.ts src/jobs/ticket.test.ts src/jobs/protocol.ts src/jobs/protocol.test.ts && git commit -F /tmp/srb-commit-msg.txt`

---

### Task 3: Job broker and HTTP server (`src/jobs/broker.ts`, `src/jobs/server.ts`)

**Files:**
- Create: `src/jobs/broker.ts`, `src/jobs/server.ts`
- Test: `src/jobs/broker.test.ts`, `src/jobs/server.test.ts`

**Interfaces:**
- Consumes: Task 1 `deserializeRunError`, `serializeRunError`; Task 2 `verifyTicket`, `createSpentNonces`, `mintTicket`, protocol constants and types; `ChildRegistry` from `src/supervise.ts`; `CodexOutputError` from `src/codex.ts`; `ClaudeRunError` from `src/claude.ts`.
- Produces (broker.ts):
  - `interface BrokerReply { status: number; body?: unknown }`
  - `interface SubmitHooks { onProgress?: (line: string, activeMs: number) => void; onClaimed?: () => void }`
  - `interface JobBrokerOptions { launchKey: Buffer; ticketMaxAgeMs: number; logDir: string; claimWaitMs?: number; workerLostMs?: number; sweepMs?: number; logChunkLimit?: number; logJobLimit?: number; now?: () => number; log?: (event: string, fields: Record<string, unknown>) => void; token?: () => string; jobId?: () => string }`
  - `interface JobBroker { submit(kind: JobKind, options: WireRunOptions, hooks?: SubmitHooks): Promise<unknown>; claim(ticket: string, signal?: AbortSignal): Promise<BrokerReply>; progress(id: string, token: string, body: unknown): BrokerReply; heartbeat(id: string, token: string): BrokerReply; result(id: string, token: string, body: unknown): BrokerReply; appendLog(id: string, token: string, chunk: Buffer): BrokerReply; cancelAll(): number; abandonAll(): number; inFlight(): number; sweep(): void; asRegistry(): ChildRegistry; start(): void; stop(): void; readonly limits: { logChunk: number; logJob: number } }`
  - `createJobBroker(options: JobBrokerOptions): JobBroker`
  - `SWEEP_MS = 5_000`, `FREEZE_TOLERANCE_MS = 15_000`, `DONE_RETENTION_MS = 600_000`
- Produces (server.ts):
  - `interface JobServerOptions { broker: JobBroker; smoke?: () => Promise<unknown>; log?: (event: string, fields: Record<string, unknown>) => void }`
  - `createJobRequestHandler(options: JobServerOptions): http.RequestListener`
  - `startJobServer(options: JobServerOptions & { port: number; host: string }): Promise<http.Server>`

- [ ] **Step 1: Write the failing broker tests**

Create `src/jobs/broker.test.ts`:

```ts
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import test from 'tape'
import { ClaudeRunError } from '../claude'
import { CodexOutputError, CodexStalledError } from '../codex'
import { createJobBroker, type JobBroker, type JobBrokerOptions } from './broker'
import type { ClaimReply, WireRunOptions } from './protocol'
import { mintTicket } from './ticket'

const key = Buffer.alloc(32, 3)
const T0 = 1_800_000_000_000
const opts: WireRunOptions = { prompt: 'p', worktreeRoot: '/work/wt/codex', timeoutMs: 1000, runId: 'C1-11.codex' }

/** A broker on a controllable clock; long-poll waits are short so tests stay fast. */
function make(over: Partial<JobBrokerOptions> = {}) {
  const clock = { now: T0 }
  const broker = createJobBroker({
    launchKey: key,
    ticketMaxAgeMs: 660_000,
    logDir: '',
    claimWaitMs: 30,
    now: () => clock.now,
    ...over,
  })
  return { broker, clock, ticket: () => mintTicket(key, clock.now) }
}

/** Observe a submit without ever leaving its rejection unhandled. */
const settle = (p: Promise<unknown>) => p.then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error: error as Error }))
const claimed = async (broker: JobBroker, ticket: string): Promise<ClaimReply> => {
  const reply = await broker.claim(ticket)
  if (reply.status !== 200) throw new Error(`claim returned ${reply.status}`)
  return reply.body as ClaimReply
}

// The basic contract (spec 3.3): a valid claim gets the queued job with a fresh job token, and the
// ticket is then spent. Regression caught: a ticket usable twice, which lets one worker take two jobs.
test('broker hands a queued job to a valid claim and spends the ticket', async t => {
  const { broker, ticket } = make()
  const out = settle(broker.submit('codex-report-only', opts))
  const tk = ticket()
  const job = await claimed(broker, tk)
  t.equal(job.kind, 'codex-report-only')
  t.deepEqual(job.options, opts)
  t.match(job.jobToken, /^[0-9a-f]{64}$/)
  broker.submit('claude-review', opts).catch(() => {})
  t.equal((await broker.claim(tk)).status, 403, 'a spent ticket cannot claim again')
  broker.abandonAll()
  await out
  t.end()
})

// A 204 must not spend the ticket, or a worker that started before any job was queued could never
// work (spec 3.3: "the ticket is not spent").
test('broker answers 204 without spending the ticket when no job arrives', async t => {
  const { broker, ticket } = make()
  const tk = ticket()
  t.equal((await broker.claim(tk)).status, 204)
  const out = settle(broker.submit('codex-report-only', opts))
  t.equal((await broker.claim(tk)).status, 200, 'the same ticket still claims')
  broker.abandonAll()
  await out
  t.end()
})

// Forged, malformed and expired tickets never get a job.
test('broker rejects forged and expired tickets', async t => {
  const { broker, clock } = make()
  const out = settle(broker.submit('codex-report-only', opts))
  t.equal((await broker.claim(mintTicket(Buffer.alloc(32, 9), clock.now))).status, 403, 'another key')
  t.equal((await broker.claim('nonsense')).status, 403, 'malformed')
  t.equal((await broker.claim(mintTicket(key, clock.now - 661_000))).status, 403, 'expired')
  t.equal(broker.inFlight(), 1, 'the job is still waiting for an honest worker')
  broker.cancelAll()
  await out
  t.end()
})

// Review Focus 4: two concurrent long-polls with one ticket are both valid until the nonce is spent.
// Only one may receive a job; the other must get 403 and the second job must stay queued.
test('broker gives one ticket at most one job even with two concurrent claims', async t => {
  const { broker, ticket } = make({ claimWaitMs: 1000 })
  const tk = ticket()
  const first = broker.claim(tk)
  const second = broker.claim(tk)
  const a = settle(broker.submit('codex-report-only', opts))
  const b = settle(broker.submit('claude-review', opts))
  const statuses = [(await first).status, (await second).status].sort()
  t.deepEqual(statuses, [200, 403])
  t.equal((await claimed(broker, ticket())).kind, 'claude-review', 'the second job went to a fresh ticket')
  broker.cancelAll()
  broker.abandonAll()
  await Promise.all([a, b])
  t.end()
})

// The job token binds a worker to its own job. Regression caught: accepting any valid token on any
// job, which would let PR code in the Codex worker post the Claude job's result (spec 3.3 threat).
test('broker job tokens are bound to one job', async t => {
  const { broker, ticket } = make()
  const a = settle(broker.submit('codex-report-only', opts))
  const b = settle(broker.submit('claude-review', opts))
  const jobA = await claimed(broker, ticket())
  const jobB = await claimed(broker, ticket())
  t.equal(broker.heartbeat(jobB.jobId, jobA.jobToken).status, 403, "A's token on B")
  t.equal(broker.result(jobB.jobId, jobA.jobToken, { ok: true, outcome: {} }).status, 403)
  t.equal(broker.heartbeat('nosuchjob', jobA.jobToken).status, 404)
  t.equal(broker.heartbeat(jobA.jobId, jobA.jobToken).status, 200)
  broker.abandonAll()
  await Promise.all([a, b])
  t.end()
})

// Progress reaches the request's status sink; the result settles the submit exactly once and kills the
// token. Regression caught: a second result overwriting the first.
test('broker forwards progress and resolves the result once', async t => {
  const { broker, ticket } = make()
  const lines: [string, number][] = []
  let claimedFired = false
  const out = settle(broker.submit('codex-report-only', opts, { onProgress: (l, ms) => lines.push([l, ms]), onClaimed: () => (claimedFired = true) }))
  const job = await claimed(broker, ticket())
  t.ok(claimedFired, 'onClaimed fires when a worker takes the job')
  t.equal(broker.progress(job.jobId, job.jobToken, { line: 'npm ci', activeMs: 1200 }).status, 200)
  t.equal(broker.progress(job.jobId, job.jobToken, { line: 5 }).status, 400)
  t.deepEqual(lines, [['npm ci', 1200]])
  t.equal(broker.result(job.jobId, job.jobToken, { ok: true, outcome: { activeMs: 7 } }).status, 200)
  t.deepEqual(await out, { ok: true, value: { activeMs: 7 } })
  t.equal(broker.result(job.jobId, job.jobToken, { ok: true, outcome: {} }).status, 403, 'the token is dead')
  t.equal(broker.progress(job.jobId, job.jobToken, { line: 'x', activeMs: 1 }).status, 403)
  t.equal(broker.inFlight(), 0)
  t.end()
})

// A failed run comes back as the same class, so the engine's retry decision is unchanged.
test('broker rebuilds the error class from a failed result', async t => {
  const { broker, ticket } = make()
  const out = settle(broker.submit('codex-report-only', opts))
  const job = await claimed(broker, ticket())
  const error = { class: 'CodexStalledError', message: 'stalled', stallMs: 600000, snapshot: { activeMs: 1, wallMs: 1, frozenMs: 0 } }
  t.equal(broker.result(job.jobId, job.jobToken, { ok: false, error }).status, 200)
  const r = await out
  t.ok(!r.ok && r.error instanceof CodexStalledError)
  t.equal(broker.result('x', 'y', { nope: true }).status, 404)
  t.end()
})

// Run logs land in RUN_LOG_DIR under the run id, within the per-request and per-job caps (spec 3.3).
test('broker appends log chunks to the run log and enforces both limits', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'broker-log-'))
  const { broker, ticket } = make({ logDir: dir, logChunkLimit: 10, logJobLimit: 25 })
  const out = settle(broker.submit('codex-report-only', opts))
  const job = await claimed(broker, ticket())
  t.equal(broker.appendLog(job.jobId, job.jobToken, Buffer.from('x'.repeat(11))).status, 413, 'over the per-request cap')
  t.equal(broker.appendLog(job.jobId, job.jobToken, Buffer.from('a'.repeat(10))).status, 200)
  t.equal(broker.appendLog(job.jobId, job.jobToken, Buffer.from('b'.repeat(10))).status, 200)
  t.equal(broker.appendLog(job.jobId, job.jobToken, Buffer.from('c'.repeat(10))).status, 413, 'over the per-job cap')
  t.equal(fs.readFileSync(path.join(dir, 'C1-11.codex.log'), 'utf8'), 'a'.repeat(10) + 'b'.repeat(10))
  broker.abandonAll()
  await out
  t.end()
})

// A run id is a file name under RUN_LOG_DIR; one with a separator must never be queued.
test('broker refuses a run id that could escape the log dir', async t => {
  const { broker } = make()
  const r = await settle(broker.submit('codex-report-only', { ...opts, runId: '../../etc/x' }))
  t.ok(!r.ok && /runId/.test(r.error.message))
  t.end()
})

// Shutdown (issue 32, spec 3.3 cancellation, ruling 6): queued jobs fail at once with the kind's output
// error; claimed jobs get 409 on their next call but may still report; nothing new may queue.
test('broker cancelAll fails queued jobs, signals claimed ones, and refuses new submits', async t => {
  const { broker, ticket } = make()
  const running = settle(broker.submit('claude-review', opts))
  const job = await claimed(broker, ticket())
  const queued = settle(broker.submit('codex-report-only', opts))
  t.equal(broker.cancelAll(), 2)
  const q = await queued
  t.ok(!q.ok && q.error instanceof CodexOutputError && /before a worker claimed it/.test(q.error.message))
  t.equal(broker.heartbeat(job.jobId, job.jobToken).status, 409)
  t.deepEqual(broker.progress(job.jobId, job.jobToken, { line: 'x', activeMs: 1 }), { status: 409, body: { cancel: true } })
  t.equal(broker.result(job.jobId, job.jobToken, { ok: false, error: { class: 'ClaudeRunError', message: 'killed', kind: 'output', activeMs: 3 } }).status, 200)
  const r = await running
  t.ok(!r.ok && r.error instanceof ClaudeRunError && r.error.message === 'killed', 'the worker still reports its own outcome')
  const late = await settle(broker.submit('codex-report-only', opts))
  t.ok(!late.ok && /shutting down/.test(late.error.message), 'a retry during shutdown cannot queue')
  t.end()
})

// Spec 3.3 worker loss: 45 s with no heartbeat fails the job with an OUTPUT error (not a stall, so
// not retried) whose message is "worker lost".
test('broker sweep fails a silent claimed job as worker lost, not stalled', async t => {
  const { broker, clock, ticket } = make()
  const out = settle(broker.submit('claude-review', opts))
  await claimed(broker, ticket())
  for (let i = 0; i < 9; i += 1) {
    clock.now += 5_000
    broker.sweep()
  }
  t.equal(broker.inFlight(), 1, '45 s exactly is not yet lost')
  clock.now += 5_000
  broker.sweep()
  const r = await out
  t.ok(!r.ok && r.error instanceof ClaudeRunError)
  if (!r.ok) {
    t.equal((r.error as ClaudeRunError).kind, 'output')
    t.match(r.error.message, /^worker lost/)
  }
  t.end()
})

// Review Focus 1: after the laptop (or the Docker VM) sleeps, every heartbeat is stale. A sweep that
// fired far later than scheduled must reset the clocks instead of failing every review. Detection is
// only deferred, not disabled: real silence afterwards still fails the job.
test('broker sweep after a freeze does not fail claimed jobs as worker lost', async t => {
  const { broker, clock, ticket } = make()
  const out = settle(broker.submit('codex-report-only', opts))
  await claimed(broker, ticket())
  broker.sweep()
  clock.now += 10 * 60_000
  broker.sweep()
  t.equal(broker.inFlight(), 1, 'a ten-minute nap is not worker loss')
  for (let i = 0; i < 10; i += 1) {
    clock.now += 5_000
    broker.sweep()
  }
  const r = await out
  t.ok(!r.ok && /^worker lost/.test(r.error.message), 'silence after waking is still detected')
  t.end()
})

// The daemon drains through drainChildRegistry; the adapter maps SIGTERM to cancel and SIGKILL to
// abandon, and size() to in-flight jobs, so the existing shutdown code needs no container branch.
test('broker asRegistry maps SIGTERM to cancel, SIGKILL to abandon, size to in-flight', async t => {
  const { broker, ticket } = make()
  const out = settle(broker.submit('codex-report-only', opts))
  const job = await claimed(broker, ticket())
  const registry = broker.asRegistry()
  t.equal(registry.size(), 1)
  t.equal(registry.killAll('SIGTERM'), 1)
  t.equal(broker.heartbeat(job.jobId, job.jobToken).status, 409, 'cancelled, still in flight')
  t.equal(registry.size(), 1)
  t.equal(registry.killAll('SIGKILL'), 1)
  const r = await out
  t.ok(!r.ok && r.error instanceof CodexOutputError && /did not report back/.test(r.error.message))
  t.equal(registry.size(), 0)
  t.end()
})
```

- [ ] **Step 2: Run the broker tests to verify they fail**

Run: `npx ts-node --compiler-options '{"module":"commonjs"}' --transpile-only src/jobs/broker.test.ts`
Expected: FAIL with `Cannot find module './broker'`.

- [ ] **Step 3: Write the broker**

Create `src/jobs/broker.ts`:

```ts
// The orchestrator's side of the job protocol (spec 3.3), with no transport: a queue of engine
// attempts waiting for a worker, one-use claim tickets, per-job tokens, progress and log forwarding,
// result settlement, cancellation, and worker-loss detection. server.ts adapts it to HTTP, so every
// rule here is testable without a socket.
//
// Threat model: every worker runs untrusted PR code as the same UID as the worker process, so PR code
// can read the worker's ticket and job token. The ticket is spent before PR code exists, and the job
// token only reaches that worker's own job, so the worst a compromised worker can do is lie about its
// own engine's result.

import { randomBytes, timingSafeEqual } from 'crypto'
import * as fs from 'fs'
import * as path from 'path'
import { ClaudeRunError } from '../claude'
import { CodexOutputError } from '../codex'
import type { ChildRegistry } from '../supervise'
import { deserializeRunError } from './errors'
import {
  CLAIM_WAIT_MS,
  LOG_CHUNK_LIMIT,
  LOG_JOB_LIMIT,
  PROGRESS_LINE_LIMIT,
  RUN_ID_RE,
  WORKER_LOST_MS,
  type ClaimReply,
  type JobKind,
  type WireRunOptions,
} from './protocol'
import { createSpentNonces, verifyTicket } from './ticket'

export interface BrokerReply {
  status: number
  body?: unknown
}

export interface SubmitHooks {
  /** The request's live-status sink; called with each progress line the worker posts. */
  onProgress?: (line: string, activeMs: number) => void
  /** A worker took the job (for the "waiting for a worker" status line). */
  onClaimed?: () => void
}

export interface JobBrokerOptions {
  launchKey: Buffer
  ticketMaxAgeMs: number
  /** RUN_LOG_DIR; empty disables run logs. */
  logDir: string
  claimWaitMs?: number
  workerLostMs?: number
  sweepMs?: number
  logChunkLimit?: number
  logJobLimit?: number
  now?: () => number
  log?: (event: string, fields: Record<string, unknown>) => void
  token?: () => string
  jobId?: () => string
}

export interface JobBroker {
  submit(kind: JobKind, options: WireRunOptions, hooks?: SubmitHooks): Promise<unknown>
  claim(ticket: string, signal?: AbortSignal): Promise<BrokerReply>
  progress(id: string, token: string, body: unknown): BrokerReply
  heartbeat(id: string, token: string): BrokerReply
  result(id: string, token: string, body: unknown): BrokerReply
  appendLog(id: string, token: string, chunk: Buffer): BrokerReply
  /** Shutdown, step one: fail queued jobs, mark claimed ones cancelled (409), refuse new submits. */
  cancelAll(): number
  /** Shutdown, step two: fail every job still unsettled. */
  abandonAll(): number
  inFlight(): number
  /** Worker-loss and housekeeping pass; run every SWEEP_MS by start(). */
  sweep(): void
  asRegistry(): ChildRegistry
  start(): void
  stop(): void
  readonly limits: { logChunk: number; logJob: number }
}

export const SWEEP_MS = 5_000
/** A sweep this much later than scheduled means the process (or the Docker VM) was suspended. */
export const FREEZE_TOLERANCE_MS = 15_000
/** Settled jobs are kept this long so a late call gets 403 (dead token) rather than 404. */
export const DONE_RETENTION_MS = 10 * 60_000

type Settlement = { ok: true; value: unknown } | { ok: false; error: Error }

interface Job {
  id: string
  kind: JobKind
  options: WireRunOptions
  hooks: SubmitHooks
  state: 'queued' | 'claimed' | 'done'
  cancelled: boolean
  token?: string
  lastBeatAt: number
  logBytes: number
  doneAt?: number
  settle(result: Settlement): void
}

interface Waiter {
  nonce: string
  reply(reply: BrokerReply): void
}

/** The error a job fails with when no worker result arrives: the kind's non-retryable output error. */
function outputError(kind: JobKind, message: string): Error {
  return kind === 'codex-report-only' ? new CodexOutputError(message, undefined, 0) : new ClaudeRunError(message, 'output', 0)
}

const FORBIDDEN: BrokerReply = { status: 403, body: { error: 'token not valid for this job' } }

export function createJobBroker(o: JobBrokerOptions): JobBroker {
  const now = o.now ?? Date.now
  const log = o.log ?? (() => {})
  const newToken = o.token ?? (() => randomBytes(32).toString('hex'))
  const newId = o.jobId ?? (() => randomBytes(12).toString('hex'))
  const claimWaitMs = o.claimWaitMs ?? CLAIM_WAIT_MS
  const workerLostMs = o.workerLostMs ?? WORKER_LOST_MS
  const sweepMs = o.sweepMs ?? SWEEP_MS
  const limits = { logChunk: o.logChunkLimit ?? LOG_CHUNK_LIMIT, logJob: o.logJobLimit ?? LOG_JOB_LIMIT }
  const spent = createSpentNonces(o.ticketMaxAgeMs)
  const jobs = new Map<string, Job>()
  const queue: Job[] = []
  const waiters: Waiter[] = []
  let closed = false
  let lastSweepAt: number | undefined
  let interval: ReturnType<typeof setInterval> | undefined

  const dequeue = (job: Job) => {
    const i = queue.indexOf(job)
    if (i >= 0) queue.splice(i, 1)
  }

  const finish = (job: Job, result: Settlement) => {
    if (job.state === 'done') return
    job.state = 'done'
    job.doneAt = now()
    dequeue(job)
    job.settle(result)
  }

  /** Give `job` to the holder of `nonce`; undefined when the nonce was already spent. */
  const assign = (job: Job, nonce: string): ClaimReply | undefined => {
    if (!spent.spend(nonce, now())) return undefined
    dequeue(job)
    job.state = 'claimed'
    job.token = newToken()
    job.lastBeatAt = now()
    log('jobs.claimed', { jobId: job.id, kind: job.kind, runId: job.options.runId })
    try {
      job.hooks.onClaimed?.()
    } catch {
      // A status-side failure is not the job's problem.
    }
    return { jobId: job.id, jobToken: job.token, kind: job.kind, options: job.options }
  }

  /** Hand a new job to the oldest live waiter, or queue it. */
  const offer = (job: Job) => {
    while (waiters.length) {
      const waiter = waiters.shift()!
      const reply = assign(job, waiter.nonce)
      if (reply) {
        waiter.reply({ status: 200, body: reply })
        return
      }
      // Another long-poll with the same ticket already took a job (Review Focus 4).
      waiter.reply({ status: 403, body: { error: 'spent' } })
    }
    queue.push(job)
  }

  const authed = (id: string, token: string): Job | BrokerReply => {
    const job = jobs.get(id)
    if (!job) return { status: 404, body: { error: 'unknown job' } }
    if (job.state !== 'claimed' || !job.token) return FORBIDDEN
    const given = Buffer.from(token, 'utf8')
    const expected = Buffer.from(job.token, 'utf8')
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return FORBIDDEN
    return job
  }
  const isReply = (value: Job | BrokerReply): value is BrokerReply => 'status' in value

  const broker: JobBroker = {
    limits,

    submit(kind, options, hooks = {}) {
      if (closed) return Promise.reject(outputError(kind, 'the orchestrator is shutting down; the job was not queued'))
      if (!RUN_ID_RE.test(options.runId)) return Promise.reject(new Error('runId is not safe for a log file name'))
      return new Promise((resolve, reject) => {
        const job: Job = {
          id: newId(),
          kind,
          options,
          hooks,
          state: 'queued',
          cancelled: false,
          lastBeatAt: now(),
          logBytes: 0,
          settle: result => (result.ok ? resolve(result.value) : reject(result.error)),
        }
        jobs.set(job.id, job)
        log('jobs.queued', { jobId: job.id, kind, runId: options.runId })
        offer(job)
      })
    },

    async claim(ticket, signal) {
      const check = verifyTicket(o.launchKey, ticket, now(), o.ticketMaxAgeMs)
      if (!check.ok) {
        log('jobs.claim_rejected', { reason: check.reason })
        return { status: 403, body: { error: check.reason } }
      }
      if (spent.has(check.nonce)) {
        log('jobs.claim_rejected', { reason: 'spent' })
        return { status: 403, body: { error: 'spent' } }
      }
      const next = queue[0]
      if (next) {
        const reply = assign(next, check.nonce)
        return reply ? { status: 200, body: reply } : { status: 403, body: { error: 'spent' } }
      }
      if (signal?.aborted) return { status: 204 }
      return new Promise<BrokerReply>(resolve => {
        let done = false
        const waiter: Waiter = {
          nonce: check.nonce,
          reply: reply => {
            if (done) return
            done = true
            clearTimeout(timer)
            signal?.removeEventListener('abort', onAbort)
            resolve(reply)
          },
        }
        const drop = () => {
          const i = waiters.indexOf(waiter)
          if (i >= 0) waiters.splice(i, 1)
        }
        const timer = setTimeout(() => {
          drop()
          waiter.reply({ status: 204 })
        }, claimWaitMs)
        // Review Focus 2: a dropped connection must not keep a waiter that would swallow a job.
        const onAbort = () => {
          drop()
          waiter.reply({ status: 204 })
        }
        signal?.addEventListener('abort', onAbort, { once: true })
        waiters.push(waiter)
      })
    },

    progress(id, token, body) {
      const job = authed(id, token)
      if (isReply(job)) return job
      job.lastBeatAt = now()
      if (job.cancelled) return { status: 409, body: { cancel: true } }
      const b = body as { line?: unknown; activeMs?: unknown } | null
      if (!b || typeof b !== 'object' || typeof b.line !== 'string' || typeof b.activeMs !== 'number' || !Number.isFinite(b.activeMs) || b.activeMs < 0) {
        return { status: 400, body: { error: 'want {line, activeMs}' } }
      }
      try {
        job.hooks.onProgress?.(b.line.slice(0, PROGRESS_LINE_LIMIT), b.activeMs)
      } catch {
        // Reporting what a run is doing is never worth failing it.
      }
      return { status: 200, body: {} }
    },

    heartbeat(id, token) {
      const job = authed(id, token)
      if (isReply(job)) return job
      job.lastBeatAt = now()
      return job.cancelled ? { status: 409, body: { cancel: true } } : { status: 200, body: {} }
    },

    result(id, token, body) {
      const job = authed(id, token)
      if (isReply(job)) return job
      const b = body as { ok?: unknown; outcome?: unknown; error?: unknown } | null
      if (!b || typeof b !== 'object' || (b.ok !== true && b.ok !== false)) return { status: 400, body: { error: 'want {ok, outcome|error}' } }
      log('jobs.result', { jobId: job.id, runId: job.options.runId, ok: b.ok })
      // Accepted even after a cancel: the worker's own outcome (a killed run) is the truest report.
      finish(job, b.ok === true ? { ok: true, value: b.outcome } : { ok: false, error: deserializeRunError(b.error) })
      return { status: 200, body: {} }
    },

    appendLog(id, token, chunk) {
      const job = authed(id, token)
      if (isReply(job)) return job
      job.lastBeatAt = now()
      if (chunk.length > limits.logChunk || job.logBytes + chunk.length > limits.logJob) {
        return { status: 413, body: { error: 'log limit reached' } }
      }
      job.logBytes += chunk.length
      if (o.logDir) {
        try {
          fs.mkdirSync(o.logDir, { recursive: true })
          fs.appendFileSync(path.join(o.logDir, `${job.options.runId}.log`), chunk)
        } catch (error) {
          // Logging must never take the run down.
          log('jobs.log_write_failed', { jobId: job.id, error: String(error) })
        }
      }
      return { status: 200, body: {} }
    },

    cancelAll() {
      closed = true
      let count = 0
      for (const job of jobs.values()) {
        if (job.state === 'done') continue
        count += 1
        job.cancelled = true
        if (job.state === 'queued') finish(job, { ok: false, error: outputError(job.kind, 'cancelled by shutdown before a worker claimed it') })
      }
      if (count) log('jobs.cancel_all', { count })
      return count
    },

    abandonAll() {
      closed = true
      let count = 0
      for (const job of jobs.values()) {
        if (job.state === 'done') continue
        count += 1
        finish(job, { ok: false, error: outputError(job.kind, 'cancelled by shutdown; the worker did not report back in time') })
      }
      if (count) log('jobs.abandon_all', { count })
      return count
    },

    inFlight() {
      let count = 0
      for (const job of jobs.values()) if (job.state !== 'done') count += 1
      return count
    },

    sweep() {
      const t = now()
      // Ruling 7: a late sweep means the machine slept; nobody could heartbeat while it did.
      const frozen = lastSweepAt !== undefined && t - lastSweepAt > sweepMs + FREEZE_TOLERANCE_MS
      if (frozen) log('jobs.freeze', { frozenForMs: t - (lastSweepAt as number) })
      lastSweepAt = t
      for (const job of [...jobs.values()]) {
        if (job.state === 'claimed') {
          if (frozen) {
            job.lastBeatAt = t
          } else if (t - job.lastBeatAt > workerLostMs) {
            log('jobs.worker_lost', { jobId: job.id, runId: job.options.runId, silentMs: t - job.lastBeatAt })
            finish(job, { ok: false, error: outputError(job.kind, `worker lost (no heartbeat for ${Math.round(workerLostMs / 1000)} s)`) })
          }
        } else if (job.state === 'done' && job.doneAt !== undefined && t - job.doneAt > DONE_RETENTION_MS) {
          jobs.delete(job.id)
        }
      }
      spent.prune(t)
    },

    asRegistry() {
      return {
        add: () => {},
        remove: () => {},
        killAll: signal => (signal === 'SIGKILL' ? broker.abandonAll() : broker.cancelAll()),
        size: () => broker.inFlight(),
      }
    },

    start() {
      if (interval) return
      interval = setInterval(() => broker.sweep(), sweepMs)
      interval.unref?.()
    },

    stop() {
      if (interval) clearInterval(interval)
      interval = undefined
      for (const waiter of waiters.splice(0)) waiter.reply({ status: 204 })
    },
  }
  return broker
}
```

- [ ] **Step 4: Run the broker tests to verify they pass**

Run: `npx ts-node --compiler-options '{"module":"commonjs"}' --transpile-only src/jobs/broker.test.ts`
Expected: PASS (all 13 tests).

- [ ] **Step 5: Write the failing server tests**

Create `src/jobs/server.test.ts`:

```ts
import type { AddressInfo } from 'net'
import test from 'tape'
import { createJobBroker, type JobBrokerOptions } from './broker'
import type { ClaimReply, WireRunOptions } from './protocol'
import { startJobServer } from './server'
import { mintTicket } from './ticket'

const key = Buffer.alloc(32, 5)
const opts: WireRunOptions = { prompt: 'p', worktreeRoot: '/work/wt/codex', timeoutMs: 1000, runId: 'C1-11.codex' }
const settle = (p: Promise<unknown>) => p.then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error: error as Error }))

/** A broker behind a real HTTP server on a loopback port. */
async function stack(over: Partial<JobBrokerOptions> = {}, smoke?: () => Promise<unknown>) {
  const broker = createJobBroker({ launchKey: key, ticketMaxAgeMs: 660_000, logDir: '', claimWaitMs: 2000, ...over })
  const server = await startJobServer({ broker, port: 0, host: '127.0.0.1', smoke })
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const post = (path: string, auth?: string, body?: string | Buffer, signal?: AbortSignal) =>
    fetch(base + path, { method: 'POST', headers: auth ? { authorization: auth, 'content-type': 'application/json' } : {}, body, signal })
  const close = () => {
    broker.cancelAll()
    broker.abandonAll()
    broker.stop()
    return new Promise<void>(resolve => server.close(() => resolve()))
  }
  return { broker, base, post, close }
}

// Unauthenticated or unknown requests get nothing: no ticket is 403, unknown paths 404, non-POST 405,
// and the health probe answers without revealing anything.
test('server rejects missing credentials and unknown routes', async t => {
  const s = await stack()
  t.equal((await s.post('/v1/claim')).status, 403)
  t.equal((await s.post('/v1/jobs/abc/heartbeat')).status, 403)
  t.equal((await s.post('/v1/other', 'Ticket x')).status, 404)
  t.equal((await fetch(`${s.base}/v1/claim`)).status, 405)
  const health = await fetch(`${s.base}/healthz`)
  t.equal(health.status, 200)
  t.deepEqual(await health.json(), { ok: true })
  await s.close()
  t.end()
})

// The whole protocol over real HTTP: claim with a ticket, then progress, heartbeat, log and result
// with the job token; the submit resolves with the worker's outcome.
test('server carries a full job round-trip', async t => {
  const s = await stack()
  const lines: string[] = []
  const out = settle(s.broker.submit('codex-report-only', opts, { onProgress: line => lines.push(line) }))
  const claim = await s.post('/v1/claim', `Ticket ${mintTicket(key, Date.now())}`)
  t.equal(claim.status, 200)
  const job = (await claim.json()) as ClaimReply
  const auth = `Job ${job.jobToken}`
  t.equal((await s.post(`/v1/jobs/${job.jobId}/progress`, auth, JSON.stringify({ line: 'hello', activeMs: 5 }))).status, 200)
  t.equal((await s.post(`/v1/jobs/${job.jobId}/heartbeat`, auth, '{}')).status, 200)
  t.equal((await s.post(`/v1/jobs/${job.jobId}/log`, auth, Buffer.from('log text'))).status, 200)
  t.equal((await s.post(`/v1/jobs/${job.jobId}/progress`, auth, 'not json')).status, 400)
  t.equal((await s.post(`/v1/jobs/${job.jobId}/result`, auth, JSON.stringify({ ok: true, outcome: { activeMs: 9 } }))).status, 200)
  t.deepEqual(await out, { ok: true, value: { activeMs: 9 } })
  t.deepEqual(lines, ['hello'])
  await s.close()
  t.end()
})

// Review Focus 2: a worker whose claim connection dies mid long-poll must not leave a waiter behind
// that "claims" the next job for nobody (which would then fail 45 s later as worker lost).
test('server: a claim aborted by the client does not swallow the next job', async t => {
  const s = await stack()
  const abort = new AbortController()
  const dead = s.post('/v1/claim', `Ticket ${mintTicket(key, Date.now())}`, undefined, abort.signal).catch(() => 'aborted')
  await new Promise(resolve => setTimeout(resolve, 50))
  abort.abort()
  t.equal(await dead, 'aborted')
  await new Promise(resolve => setTimeout(resolve, 100))
  const out = settle(s.broker.submit('codex-report-only', opts))
  const claim = await s.post('/v1/claim', `Ticket ${mintTicket(key, Date.now())}`)
  t.equal(claim.status, 200, 'the job went to the live claim')
  const job = (await claim.json()) as ClaimReply
  await s.post(`/v1/jobs/${job.jobId}/result`, `Job ${job.jobToken}`, JSON.stringify({ ok: true, outcome: {} }))
  t.ok((await out).ok)
  await s.close()
  t.end()
})

// The per-request log cap is enforced before the body is buffered in full.
test('server answers 413 for an oversized log chunk', async t => {
  const s = await stack({ logChunkLimit: 10 })
  const out = settle(s.broker.submit('codex-report-only', opts))
  const job = (await (await s.post('/v1/claim', `Ticket ${mintTicket(key, Date.now())}`)).json()) as ClaimReply
  const res = await s.post(`/v1/jobs/${job.jobId}/log`, `Job ${job.jobToken}`, Buffer.alloc(11, 120)).catch(() => undefined)
  t.ok(res === undefined || res.status === 413, 'refused (or the connection closed after the 413)')
  await s.close()
  await out
  t.end()
})

// The smoke route is a test hook; it must not exist unless SMOKE=1 wired it (spec 6).
test('server exposes the smoke route only when enabled', async t => {
  const off = await stack()
  t.equal((await off.post('/v1/smoke/submit')).status, 404)
  await off.close()
  const on = await stack({}, async () => ({ ran: true }))
  const res = await on.post('/v1/smoke/submit')
  t.equal(res.status, 200)
  t.deepEqual(await res.json(), { ran: true })
  await on.close()
  t.end()
})
```

- [ ] **Step 6: Run the server tests to verify they fail**

Run: `npx ts-node --compiler-options '{"module":"commonjs"}' --transpile-only src/jobs/server.test.ts`
Expected: FAIL with `Cannot find module './server'`.

- [ ] **Step 7: Write the server**

Create `src/jobs/server.ts`:

```ts
// HTTP/1.1 adapter for the job broker (spec 3.3). Listens on the internal `jobs` Compose network; the
// orchestrator publishes no ports. Every route but /healthz needs a ticket or a job token, and every
// body is read under a size cap before it is parsed.

import * as http from 'http'
import type { BrokerReply, JobBroker } from './broker'
import { serializeRunError } from './errors'
import { JSON_BODY_LIMIT } from './protocol'

/** Progress and heartbeat bodies are tiny. */
const CONTROL_BODY_LIMIT = 64 * 1024
const JOB_PATH = /^\/v1\/jobs\/([A-Za-z0-9]{1,64})\/(progress|heartbeat|result|log)$/

export interface JobServerOptions {
  broker: JobBroker
  /** SMOKE=1 only: POST /v1/smoke/submit runs one canned job. Absent means the route does not exist. */
  smoke?: () => Promise<unknown>
  log?: (event: string, fields: Record<string, unknown>) => void
}

function send(res: http.ServerResponse, reply: BrokerReply): void {
  if (res.writableEnded || res.destroyed) return
  if (reply.body === undefined) {
    res.writeHead(reply.status)
    res.end()
    return
  }
  const text = JSON.stringify(reply.body)
  res.writeHead(reply.status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) })
  res.end(text)
}

/** The body, or null as soon as it exceeds `limit` (the rest is never buffered). */
function readBody(req: http.IncomingMessage, limit: number): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    let over = false
    req.on('data', (chunk: Buffer) => {
      if (over) return
      size += chunk.length
      if (size > limit) {
        over = true
        chunks.length = 0
        resolve(null)
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (!over) resolve(Buffer.concat(chunks))
    })
    req.on('error', reject)
  })
}

function credential(req: http.IncomingMessage, scheme: 'Ticket' | 'Job'): string | undefined {
  const header = req.headers.authorization
  if (typeof header !== 'string' || !header.startsWith(`${scheme} `)) return undefined
  return header.slice(scheme.length + 1).trim() || undefined
}

const NOT_JSON = Symbol('not json')
function parseJson(body: Buffer): unknown {
  try {
    return JSON.parse(body.toString('utf8'))
  } catch {
    return NOT_JSON
  }
}

export function createJobRequestHandler(options: JobServerOptions): http.RequestListener {
  const { broker } = options
  const log = options.log ?? (() => {})

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = (req.url ?? '').split('?')[0]
    if (req.method === 'GET' && url === '/healthz') {
      req.resume()
      return send(res, { status: 200, body: { ok: true } })
    }
    if (req.method !== 'POST') {
      req.resume()
      return send(res, { status: 405, body: { error: 'method not allowed' } })
    }
    if (url === '/v1/claim') {
      req.resume()
      const ticket = credential(req, 'Ticket')
      if (!ticket) return send(res, { status: 403, body: { error: 'missing ticket' } })
      // A worker that hangs up mid long-poll must not leave a waiter behind (Review Focus 2).
      const abort = new AbortController()
      res.on('close', () => {
        if (!res.writableFinished) abort.abort()
      })
      return send(res, await broker.claim(ticket, abort.signal))
    }
    if (url === '/v1/smoke/submit' && options.smoke) {
      req.resume()
      try {
        return send(res, { status: 200, body: await options.smoke() })
      } catch (error) {
        return send(res, { status: 500, body: { error: serializeRunError(error) } })
      }
    }
    const match = JOB_PATH.exec(url)
    if (!match) {
      req.resume()
      return send(res, { status: 404, body: { error: 'not found' } })
    }
    const [, id, action] = match
    const token = credential(req, 'Job')
    if (!token) {
      req.resume()
      return send(res, { status: 403, body: { error: 'missing job token' } })
    }
    const limit = action === 'log' ? broker.limits.logChunk : action === 'result' ? JSON_BODY_LIMIT : CONTROL_BODY_LIMIT
    const body = await readBody(req, limit)
    if (body === null) {
      res.setHeader('connection', 'close')
      res.on('finish', () => req.destroy())
      return send(res, { status: 413, body: { error: 'body too large' } })
    }
    if (action === 'log') return send(res, broker.appendLog(id, token, body))
    if (action === 'heartbeat') return send(res, broker.heartbeat(id, token))
    const parsed = parseJson(body)
    if (parsed === NOT_JSON) return send(res, { status: 400, body: { error: 'body is not JSON' } })
    return send(res, action === 'progress' ? broker.progress(id, token, parsed) : broker.result(id, token, parsed))
  }

  return (req, res) => {
    handle(req, res).catch(error => {
      log('jobs.http_error', { error: String(error) })
      send(res, { status: 500, body: { error: 'internal error' } })
    })
  }
}

export function startJobServer(options: JobServerOptions & { port: number; host: string }): Promise<http.Server> {
  const server = http.createServer(createJobRequestHandler(options))
  server.headersTimeout = 60_000
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port, options.host, () => {
      server.off('error', reject)
      resolve(server)
    })
  })
}
```

- [ ] **Step 8: Run all job tests to verify they pass**

Run: `npx ts-node --compiler-options '{"module":"commonjs"}' --transpile-only src/jobs/server.test.ts && npx ts-node --compiler-options '{"module":"commonjs"}' --transpile-only src/jobs/broker.test.ts`
Expected: PASS for both files.

Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 9: Commit**

Write `/tmp/srb-commit-msg.txt`:

```text
feat(jobs): add the job broker and its HTTP server (refs andrew-barnett/slack-review-bot#70)

Engine attempts queue on the orchestrator until a worker claims one with a
one-use ticket. A job token binds each later call to its own job, a dead
worker fails as "worker lost" without counting a laptop nap, and the
broker drains through the existing child-registry shutdown.

[cc](https://claude.com/claude-code)
```

Run: `git add src/jobs/broker.ts src/jobs/broker.test.ts src/jobs/server.ts src/jobs/server.test.ts && git commit -F /tmp/srb-commit-msg.txt`

---

### Task 4: Remote run functions (`src/jobs/remote.ts`)

**Files:**
- Create: `src/jobs/remote.ts`
- Test: `src/jobs/remote.test.ts`

**Interfaces:**
- Consumes: Task 3 `JobBroker['submit']`, `SubmitHooks`; Task 2 `toWireOptions`; Task 1 `usageOf`, `nonNegative`, `optionalNonNegative`; `runCodexReportOnly`, `CodexOutputError` from `src/codex.ts`; `runClaudeReview`, `ClaudeRunError`, `totalTokens` from `src/claude.ts`; `parseReviewResultV2` from `src/schema.ts`; `redactSecrets`.
- Produces:
  - `interface RemoteRunners { runCodex: typeof runCodexReportOnly; runClaude: typeof runClaudeReview }`
  - `makeRemoteRunners(broker: Pick<JobBroker, 'submit'>): RemoteRunners`
  - `normalizeCodexOutcome(raw: unknown): CodexRunOutcome<EngineRunResult>` (throws `CodexOutputError`)
  - `normalizeClaudeOutcome(raw: unknown): ClaudeRunOutcome` (throws `ClaudeRunError('output')`)
  - `WAITING_LINE = 'waiting for a worker'`, `CLAIMED_LINE = 'a worker claimed the job'`

- [ ] **Step 1: Write the failing tests**

Create `src/jobs/remote.test.ts`:

```ts
import test from 'tape'
import { ClaudeRunError } from '../claude'
import { CodexOutputError, CodexStalledError, type CodexRunOptions } from '../codex'
import { loadReviewConfig } from '../config'
import { makeCodexEngine } from '../engine'
import type { SubmitHooks } from './broker'
import type { JobKind, WireRunOptions } from './protocol'
import { CLAIMED_LINE, makeRemoteRunners, WAITING_LINE } from './remote'

const URL1 = 'https://github.com/o/r/pull/1'
const SHA = 'c'.repeat(40)
const clean = { results: [{ url: URL1, reviewedSha: SHA, verdict: 'clean', findings: [], summary: '', environmentProblems: [] }] }
const codexOptions: CodexRunOptions = {
  prompt: 'p',
  codexBin: 'codex',
  profile: 'review-bot',
  workspaceRoot: '/work/src',
  worktreeRoot: '/work/wt/codex',
  timeoutMs: 1000,
  stallTimeoutMs: 500,
  disableGitSigning: true,
  engineGhToken: 'engine-placeholder',
  runId: 'C1-11.codex',
}

/** A fake broker that records submissions and answers from a script of outcomes or errors. */
function fakeBroker(script: (Error | unknown)[]) {
  const calls: { kind: JobKind; options: WireRunOptions; hooks?: SubmitHooks }[] = []
  return {
    calls,
    submit: async (kind: JobKind, options: WireRunOptions, hooks?: SubmitHooks) => {
      calls.push({ kind, options, hooks })
      hooks?.onClaimed?.()
      const next = script.shift()
      if (next instanceof Error) throw next
      return next
    },
  }
}

// The remote function must submit the codex job kind with only the wire fields, announce that it is
// waiting for a worker, and return the local outcome shape. Regression caught: the engine token or a
// Bedrock credential riding along in the job options.
test('remote runCodex submits a codex-report-only job with only the wire fields', async t => {
  const broker = fakeBroker([{ result: clean, tokensUsed: 10, activeMs: 20, rawFinalMessage: 'ignored' }])
  const lines: string[] = []
  const out = await makeRemoteRunners(broker).runCodex({ ...codexOptions, onProgress: line => lines.push(line) })
  t.equal(broker.calls[0].kind, 'codex-report-only')
  t.deepEqual(Object.keys(broker.calls[0].options).sort(), ['prompt', 'runId', 'stallTimeoutMs', 'timeoutMs', 'worktreeRoot'])
  t.deepEqual(lines, [WAITING_LINE, CLAIMED_LINE])
  t.deepEqual(out.result, clean)
  t.equal(out.tokensUsed, 10)
  t.equal(out.activeMs, 20)
  t.equal(out.rawFinalMessage, '', 'the raw final message never crosses the wire')
  t.end()
})

// Review Focus 3: the result body is attacker-controlled. Anything that is not a valid v2 result must
// become the engine's output error (an invalid pass), never a crash and never a clean pass.
test('remote runCodex turns a malformed outcome into CodexOutputError', async t => {
  const hostile = [null, 'text', {}, { result: { results: 'no' } }, { result: { results: [{ url: URL1, verdict: 'clean' }] } }]
  for (const raw of hostile) {
    try {
      await makeRemoteRunners(fakeBroker([raw])).runCodex(codexOptions)
      t.fail(`accepted ${JSON.stringify(raw)}`)
    } catch (error) {
      t.ok(error instanceof CodexOutputError, `rejected ${JSON.stringify(raw)}`)
    }
  }
  t.end()
})

// Usage numbers from a worker feed the status totals; negative or NaN values must be clamped, and
// Claude's token total recomputed from the breakdown rather than trusted.
test('remote runClaude normalizes hostile usage numbers', async t => {
  const usage = { inputTokens: 5, outputTokens: -3, cacheReadTokens: Number.NaN, cacheWriteTokens: 1, costUsd: 'x', numTurns: 2, durationMs: 1 }
  const broker = fakeBroker([{ result: clean, usage, tokensUsed: 999999, activeMs: -1, permissionDenials: 2.5 }])
  const out = await makeRemoteRunners(broker).runClaude({ ...codexOptions, claudeBin: 'claude', configDir: '/c', engineGhToken: 'e' })
  t.equal(broker.calls[0].kind, 'claude-review')
  t.deepEqual(out.usage, { inputTokens: 5, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 1, costUsd: 0, numTurns: 2, durationMs: 1 })
  t.equal(out.tokensUsed, 6, 'recomputed from the breakdown')
  t.equal(out.activeMs, 0)
  t.equal(out.permissionDenials, 2)
  try {
    await makeRemoteRunners(fakeBroker([{ usage }])).runClaude({ ...codexOptions, claudeBin: 'claude', configDir: '/c', engineGhToken: 'e' })
    t.fail('accepted a missing result')
  } catch (error) {
    t.ok(error instanceof ClaudeRunError && error.kind === 'output')
  }
  t.end()
})

// Spec D1: retries, scheduling and the gate stay in the orchestrator unchanged. A stall from a worker
// must make the Codex engine retry with a fresh job (a fresh container), exactly as a local stall does.
test('a remote stall makes the Codex engine retry with a new job', async t => {
  const stalled = new CodexStalledError('stalled', 600_000, { activeMs: 5, wallMs: 5, frozenMs: 0 })
  const broker = fakeBroker([stalled, { result: clean, tokensUsed: 1, activeMs: 2 }])
  const config = { ...loadReviewConfig({ HOME: '/home/bot' }), stallBackoffMs: [1000, 2000] }
  const engine = makeCodexEngine(config, { runCodex: makeRemoteRunners(broker).runCodex })
  const outcome = await engine.run({ prs: [{ ref: { owner: 'o', repo: 'r', number: 1, url: URL1 }, pinnedSha: SHA }], instructions: '', worktreeRoot: '/work/wt/codex', runId: 'C1-11' })
  t.equal(broker.calls.length, 2, 'two jobs: the retry ran in a fresh worker')
  t.deepEqual(broker.calls.map(c => c.options.stallTimeoutMs), [1000, 2000], 'the escalating stall schedule crosses the wire')
  t.deepEqual(broker.calls.map(c => c.options.runId), ['C1-11.codex', 'C1-11.codex.retry1'])
  t.equal(outcome.usage.attempts, 2)
  t.equal(outcome.error, undefined)
  t.end()
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx ts-node --compiler-options '{"module":"commonjs"}' --transpile-only src/jobs/remote.test.ts`
Expected: FAIL with `Cannot find module './remote'`.

- [ ] **Step 3: Write the implementation**

Create `src/jobs/remote.ts`:

```ts
// Remote implementations of the two report-only engine run functions (spec D1). Same signatures as
// runCodexReportOnly and runClaudeReview, so the engines, their stall retries, the scheduler and the
// gate run unchanged; each call is one job, run by one fresh worker container. The worker's outcome is
// untrusted (it ran PR code), so it is re-validated here exactly as a local final message would be.

import { ClaudeRunError, totalTokens, type ClaudeRunOptions, type ClaudeRunOutcome, type runClaudeReview } from '../claude'
import { CodexOutputError, type CodexRunOptions, type CodexRunOutcome, type runCodexReportOnly } from '../codex'
import { redactSecrets } from '../redact'
import { parseReviewResultV2, type EngineRunResult } from '../schema'
import type { ClaudeUsageDetail } from '../usage'
import type { JobBroker, SubmitHooks } from './broker'
import { nonNegative, optionalNonNegative, usageOf } from './errors'
import { toWireOptions } from './protocol'

export const WAITING_LINE = 'waiting for a worker'
export const CLAIMED_LINE = 'a worker claimed the job'

export interface RemoteRunners {
  runCodex: typeof runCodexReportOnly
  runClaude: typeof runClaudeReview
}

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}

const message = (error: unknown) => redactSecrets(error instanceof Error ? error.message : String(error))

/** Validate a worker's Codex outcome; anything unusable is an output error carrying what it claimed to cost. */
export function normalizeCodexOutcome(raw: unknown): CodexRunOutcome<EngineRunResult> {
  const o = record(raw)
  const activeMs = nonNegative(o.activeMs)
  const tokensUsed = optionalNonNegative(o.tokensUsed)
  let result: EngineRunResult
  try {
    result = parseReviewResultV2(JSON.stringify(o.result ?? null))
  } catch (error) {
    throw new CodexOutputError(`the worker returned an unusable result: ${message(error)}`, tokensUsed, activeMs)
  }
  return { result, rawFinalMessage: '', tokensUsed, activeMs }
}

const ZERO_USAGE: ClaudeUsageDetail = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, numTurns: 0, durationMs: 0 }

/** Validate a worker's Claude outcome; the token total is recomputed, never trusted. */
export function normalizeClaudeOutcome(raw: unknown): ClaudeRunOutcome {
  const o = record(raw)
  const activeMs = nonNegative(o.activeMs)
  const usage = usageOf(o.usage) ?? ZERO_USAGE
  let result: EngineRunResult
  try {
    result = parseReviewResultV2(JSON.stringify(o.result ?? null))
  } catch (error) {
    throw new ClaudeRunError(`the worker returned an unusable result: ${message(error)}`, 'output', activeMs, usage)
  }
  return { result, usage, tokensUsed: totalTokens(usage), activeMs, permissionDenials: Math.floor(nonNegative(o.permissionDenials)) }
}

/** Status hooks: the request shows "waiting for a worker" until one claims the job (ruling 5). */
function hooksFor(onProgress: ((line: string, activeMs: number) => void) | undefined): SubmitHooks {
  const say = (line: string) => {
    try {
      onProgress?.(line, 0)
    } catch {
      // Status is best-effort.
    }
  }
  say(WAITING_LINE)
  return { onProgress, onClaimed: () => say(CLAIMED_LINE) }
}

export function makeRemoteRunners(broker: Pick<JobBroker, 'submit'>): RemoteRunners {
  return {
    runCodex: async (options: CodexRunOptions) =>
      // A rejection is already the rebuilt error class (CodexStalledError and friends): rethrown as is.
      normalizeCodexOutcome(await broker.submit('codex-report-only', toWireOptions(options), hooksFor(options.onProgress))),
    runClaude: async (options: ClaudeRunOptions) =>
      normalizeClaudeOutcome(await broker.submit('claude-review', toWireOptions(options), hooksFor(options.onProgress))),
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx ts-node --compiler-options '{"module":"commonjs"}' --transpile-only src/jobs/remote.test.ts`
Expected: PASS (all four tests).

Run: `npm run typecheck`
Expected: exit 0. (`typeof runCodexReportOnly` accepts a one-parameter implementation, because its other two parameters are optional.)

- [ ] **Step 5: Commit**

Write `/tmp/srb-commit-msg.txt`:

```text
feat(jobs): add remote engine run functions backed by the job broker (refs andrew-barnett/slack-review-bot#70)

The remote functions keep the local signatures, so the engines' retries,
the scheduler and the gate are unchanged. A worker's outcome is validated
like a local final message, so a hostile body is an invalid pass.

[cc](https://claude.com/claude-code)
```

Run: `git add src/jobs/remote.ts src/jobs/remote.test.ts && git commit -F /tmp/srb-commit-msg.txt`

---

### Task 5: Secret delivery over stdin (`src/secret-bundle.ts`)

**Files:**
- Create: `src/secret-bundle.ts`
- Test: `src/secret-bundle.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `BUNDLE_MAX_BYTES = 64 * 1024`, `BUNDLE_TIMEOUT_MS = 10_000`
  - `interface BundleSpec { required: readonly string[]; optional?: readonly string[] }`
  - `ORCHESTRATOR_BUNDLE: BundleSpec` (required `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, `APPROVER_GH_TOKEN`, `LAUNCH_KEY`)
  - `WORKER_BUNDLE: BundleSpec` (required `ENGINE_GH_TOKEN`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`, `NPM_TOKEN`, `WORKER_TICKET`)
  - `WORKER_DOCTOR_BUNDLE: BundleSpec` (the worker keys, with `WORKER_TICKET` optional)
  - `parseSecretBundle(line: string, spec: BundleSpec): Record<string, string>`
  - `readSecretBundle(stream: NodeJS.ReadableStream, spec: BundleSpec, options?: { maxBytes?: number; timeoutMs?: number }): Promise<Record<string, string>>`
  - `encodeSecretBundle(values: Record<string, string>): string` (one JSON line ending in `\n`)

- [ ] **Step 1: Write the failing tests**

Create `src/secret-bundle.test.ts`:

```ts
import { PassThrough } from 'stream'
import test from 'tape'
import { encodeSecretBundle, parseSecretBundle, readSecretBundle, WORKER_BUNDLE, WORKER_DOCTOR_BUNDLE } from './secret-bundle'

const spec = { required: ['A_TOKEN', 'B_TOKEN'], optional: ['C_TOKEN'] }
const line = encodeSecretBundle({ A_TOKEN: 'alpha-placeholder', B_TOKEN: 'beta-placeholder' })

// Spec 3.6.1: one JSON line on stdin, then stdin is closed. Regression caught: a reader that keeps
// stdin open (so a later write could inject values) or that reads past the first line.
test('readSecretBundle reads exactly one line and closes the stream', async t => {
  const stream = new PassThrough()
  const pending = readSecretBundle(stream, spec)
  stream.write(line.slice(0, 10))
  stream.write(`${line.slice(10)}{"ignored":"second line"}\n`)
  t.deepEqual(await pending, { A_TOKEN: 'alpha-placeholder', B_TOKEN: 'beta-placeholder' })
  t.ok(stream.destroyed, 'stdin is closed after the bundle')
  t.end()
})

// Each failure must exit non-zero rather than start without its secrets, and no error may echo a
// value (it would reach the container log).
test('readSecretBundle fails on timeout, oversize and early EOF without echoing values', async t => {
  const slow = new PassThrough()
  await readSecretBundle(slow, spec, { timeoutMs: 20 }).then(
    () => t.fail('resolved'),
    error => t.match(error.message, /within 20 ms/)
  )
  const big = new PassThrough()
  const pendingBig = readSecretBundle(big, spec, { maxBytes: 16 })
  big.write('{"A_TOKEN":"' + 'x'.repeat(40))
  await pendingBig.then(
    () => t.fail('resolved'),
    error => {
      t.match(error.message, /larger than 16 bytes/)
      t.notOk(error.message.includes('xxxx'), 'the value is not echoed')
    }
  )
  const empty = new PassThrough()
  const pendingEmpty = readSecretBundle(empty, spec)
  empty.end()
  await pendingEmpty.then(
    () => t.fail('resolved'),
    error => t.match(error.message, /closed before/)
  )
  t.end()
})

// The key set is strict: an unknown key, a missing required key, or a non-string value is refused, so
// a launcher bug cannot silently start a container short of a credential or with an extra one.
test('parseSecretBundle enforces the exact key set and string values', t => {
  t.deepEqual(parseSecretBundle('{"A_TOKEN":"a1","B_TOKEN":"b1","C_TOKEN":"c1"}', spec), { A_TOKEN: 'a1', B_TOKEN: 'b1', C_TOKEN: 'c1' })
  t.throws(() => parseSecretBundle('{"A_TOKEN":"a1"}', spec), /missing B_TOKEN/)
  t.throws(() => parseSecretBundle('{"A_TOKEN":"a1","B_TOKEN":"b1","LAUNCH_KEY":"k"}', spec), /unexpected key "LAUNCH_KEY"/)
  t.throws(() => parseSecretBundle('{"A_TOKEN":"a1","B_TOKEN":5}', spec), /B_TOKEN is not a non-empty string/)
  t.throws(() => parseSecretBundle('{"A_TOKEN":"a1","B_TOKEN":""}', spec), /B_TOKEN/)
  try {
    parseSecretBundle('not json secret-value', spec)
    t.fail('a non-JSON line parsed')
  } catch (error) {
    t.notOk(String(error).includes('secret-value'), 'the raw line is not echoed')
  }
  t.throws(() => parseSecretBundle('["A_TOKEN"]', spec), /not a JSON object/)
  t.end()
})

// The worker never receives LAUNCH_KEY (spec 3.4): it is not in either worker key set, so a bundle
// carrying it is refused outright.
test('worker bundle specs exclude LAUNCH_KEY and the daemon-only tokens', t => {
  for (const spec of [WORKER_BUNDLE, WORKER_DOCTOR_BUNDLE]) {
    const keys = [...spec.required, ...(spec.optional ?? [])]
    for (const banned of ['LAUNCH_KEY', 'APPROVER_GH_TOKEN', 'SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN']) t.notOk(keys.includes(banned), banned)
  }
  t.ok(WORKER_DOCTOR_BUNDLE.optional?.includes('WORKER_TICKET'))
  t.end()
})

// The launcher's encoding must be a single line, whatever the values contain.
test('encodeSecretBundle produces one line', t => {
  const encoded = encodeSecretBundle({ A_TOKEN: 'multi\nline' })
  t.equal(encoded.indexOf('\n'), encoded.length - 1)
  t.deepEqual(parseSecretBundle(encoded.trim(), { required: ['A_TOKEN'] }), { A_TOKEN: 'multi\nline' })
  t.end()
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx ts-node --compiler-options '{"module":"commonjs"}' --transpile-only src/secret-bundle.test.ts`
Expected: FAIL with `Cannot find module './secret-bundle'`.

- [ ] **Step 3: Write the implementation**

Create `src/secret-bundle.ts`:

```ts
// Secret delivery over stdin (spec 3.6.1). The launcher writes one JSON line to each container's
// stdin; the entrypoint reads it, closes stdin, and holds the values in memory. Neither `-e` (readable
// with `docker inspect`, stored on the Docker VM's disk) nor Compose `secrets:` (copied into the
// container's filesystem) is used. No error here ever includes a value.

export const BUNDLE_MAX_BYTES = 64 * 1024
export const BUNDLE_TIMEOUT_MS = 10_000

export interface BundleSpec {
  required: readonly string[]
  optional?: readonly string[]
}

export const ORCHESTRATOR_BUNDLE: BundleSpec = {
  required: ['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN', 'APPROVER_GH_TOKEN', 'LAUNCH_KEY'],
}

const WORKER_CREDENTIALS = ['ENGINE_GH_TOKEN', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'NPM_TOKEN'] as const

/** The worker's bundle. It never contains LAUNCH_KEY (spec 3.4). */
export const WORKER_BUNDLE: BundleSpec = { required: [...WORKER_CREDENTIALS, 'WORKER_TICKET'] }

/** `doctor --role worker` gets the same credentials; it claims nothing, so the ticket is optional. */
export const WORKER_DOCTOR_BUNDLE: BundleSpec = { required: [...WORKER_CREDENTIALS], optional: ['WORKER_TICKET'] }

export function encodeSecretBundle(values: Record<string, string>): string {
  // JSON.stringify escapes newlines inside strings, so the result is exactly one line.
  return `${JSON.stringify(values)}\n`
}

export function parseSecretBundle(line: string, spec: BundleSpec): Record<string, string> {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    throw new Error('the secret bundle is not valid JSON')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('the secret bundle is not a JSON object')
  const allowed = new Set([...spec.required, ...(spec.optional ?? [])])
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    // Key names are the launcher's own constants, never secrets, so naming one is safe.
    if (!allowed.has(key)) throw new Error(`the secret bundle has an unexpected key ${JSON.stringify(key.slice(0, 64))}`)
    if (typeof value !== 'string' || !value) throw new Error(`the secret bundle's ${key} is not a non-empty string`)
    out[key] = value
  }
  for (const key of spec.required) {
    if (!(key in out)) throw new Error(`the secret bundle is missing ${key}`)
  }
  return out
}

export function readSecretBundle(
  stream: NodeJS.ReadableStream,
  spec: BundleSpec,
  options: { maxBytes?: number; timeoutMs?: number } = {}
): Promise<Record<string, string>> {
  const maxBytes = options.maxBytes ?? BUNDLE_MAX_BYTES
  const timeoutMs = options.timeoutMs ?? BUNDLE_TIMEOUT_MS
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0)
    let done = false
    const finish = (error: Error | undefined, line?: string) => {
      if (done) return
      done = true
      clearTimeout(timer)
      stream.removeListener('data', onData)
      stream.removeListener('end', onEnd)
      stream.removeListener('error', onError)
      // Close stdin: nothing more is read from it for the life of the process.
      ;(stream as unknown as { destroy?: () => void }).destroy?.()
      if (error) return reject(error)
      try {
        resolve(parseSecretBundle(line ?? '', spec))
      } catch (parseError) {
        reject(parseError as Error)
      }
    }
    const tooBig = () => new Error(`the secret bundle is larger than ${maxBytes} bytes`)
    const onData = (chunk: Buffer | string) => {
      buffer = Buffer.concat([buffer, typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk])
      const newline = buffer.indexOf(0x0a)
      if (newline >= 0) return newline > maxBytes ? finish(tooBig()) : finish(undefined, buffer.subarray(0, newline).toString('utf8'))
      if (buffer.length > maxBytes) finish(tooBig())
    }
    const onEnd = () => {
      if (!buffer.length) return finish(new Error('stdin closed before a secret bundle arrived'))
      return buffer.length > maxBytes ? finish(tooBig()) : finish(undefined, buffer.toString('utf8'))
    }
    const onError = (error: Error) => finish(new Error(`reading the secret bundle failed: ${error.message}`))
    const timer = setTimeout(() => finish(new Error(`no secret bundle arrived on stdin within ${timeoutMs} ms`)), timeoutMs)
    stream.on('data', onData)
    stream.on('end', onEnd)
    stream.on('error', onError)
  })
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx ts-node --compiler-options '{"module":"commonjs"}' --transpile-only src/secret-bundle.test.ts`
Expected: PASS (all five tests).

- [ ] **Step 5: Commit**

Write `/tmp/srb-commit-msg.txt`:

```text
feat: read container secrets as one JSON line on stdin (refs andrew-barnett/slack-review-bot#70)

Environment flags and Compose secrets both leave values readable on the
Docker VM's disk or in the container's filesystem. One bounded,
time-limited line on stdin with a strict key set keeps them in memory.

[cc](https://claude.com/claude-code)
```

Run: `git add src/secret-bundle.ts src/secret-bundle.test.ts && git commit -F /tmp/srb-commit-msg.txt`

---

### Task 6: `RUNTIME=container` configuration (`src/config.ts`)

**Files:**
- Modify: `src/config.ts`
- Test: `src/config-runtime.test.ts`

**Interfaces:**
- Consumes: Phase 2a `loadReviewConfig` as merged.
- Produces:
  - `type Runtime = 'launchd' | 'container'`; `parseRuntime(raw: string | undefined): Runtime`
  - `parseEngines(raw: string | undefined, runtime?: Runtime): EngineName[]` (accepts `claude` alone only in `container`)
  - `ReviewConfig.runtime: Runtime`, `ReviewConfig.workerIdleExitMs: number` (default 600000), `ReviewConfig.orchestratorUrl: string` (default `http://slack-review-bot-orchestrator:8080`), `ReviewConfig.jobPort: number` (default 8080)
  - In `container`, `approverGhToken` and `engineGhToken` are read in single mode too, and the both-tokens check is skipped (the launcher does it).

- [ ] **Step 1: Write the failing tests**

Create `src/config-runtime.test.ts`:

```ts
import test from 'tape'
import { loadReviewConfig, parseEngines, parseRuntime } from './config'

// RUNTIME is opt-in: unset must stay the launchd daemon, so an existing install changes nothing.
test('parseRuntime defaults to launchd and accepts only the two runtimes', t => {
  t.equal(parseRuntime(undefined), 'launchd')
  t.equal(parseRuntime(''), 'launchd')
  t.equal(parseRuntime('container'), 'container')
  t.throws(() => parseRuntime('ecs'), /RUNTIME must be/)
  t.end()
})

// Ruling 4 / spec D8: single mode in the container runtime may use either engine; the launchd runtime
// keeps today's shapes, and the error says what would make "claude" valid.
test('parseEngines accepts claude alone only in the container runtime', t => {
  t.deepEqual(parseEngines('claude', 'container'), ['claude'])
  t.deepEqual(parseEngines('codex', 'container'), ['codex'])
  t.deepEqual(parseEngines('codex,claude', 'container'), ['codex', 'claude'])
  t.throws(() => parseEngines('claude'), /RUNTIME=container/)
  t.throws(() => parseEngines('claude,claude', 'container'), /REVIEW_ENGINES/)
  t.end()
})

// Spec D8: in the container runtime every review is posted by the role account, so the approver token
// is read in single mode too (and the worker's engine token likewise). Launchd single mode reads neither.
test('the container runtime reads the role tokens in single mode', t => {
  const env = { HOME: '/home/u', APPROVER_GH_TOKEN: 'approver-placeholder', ENGINE_GH_TOKEN: 'engine-placeholder' }
  const container = loadReviewConfig({ ...env, RUNTIME: 'container' })
  t.equal(container.runtime, 'container')
  t.equal(container.approverGhToken, 'approver-placeholder')
  t.equal(container.engineGhToken, 'engine-placeholder')
  const launchd = loadReviewConfig(env)
  t.equal(launchd.runtime, 'launchd')
  t.equal(launchd.approverGhToken, '', 'launchd single mode is unchanged')
  t.equal(launchd.engineGhToken, '')
  t.end()
})

// Spec 3.2: no container process holds both tokens, so the "both present and different" startup
// check moves to the launcher. The orchestrator must still load with only the approver token.
test('container dual mode loads with only the approver token', t => {
  const config = loadReviewConfig({ HOME: '/home/u', RUNTIME: 'container', REVIEW_ENGINES: 'codex,claude', APPROVER_GH_TOKEN: 'approver-placeholder' })
  t.deepEqual(config.reviewEngines, ['codex', 'claude'])
  t.equal(config.engineGhToken, '')
  t.throws(() => loadReviewConfig({ HOME: '/home/u', REVIEW_ENGINES: 'codex,claude', APPROVER_GH_TOKEN: 'a' }), /ENGINE_GH_TOKEN/, 'launchd keeps the check')
  t.end()
})

// The worker and orchestrator settings have spec defaults (3.3, 3.4).
test('container settings default to the spec values', t => {
  const config = loadReviewConfig({ HOME: '/home/u' })
  t.equal(config.workerIdleExitMs, 600_000)
  t.equal(config.orchestratorUrl, 'http://slack-review-bot-orchestrator:8080')
  t.equal(config.jobPort, 8080)
  t.equal(loadReviewConfig({ HOME: '/h', WORKER_IDLE_EXIT_MS: '1000', JOB_PORT: '9090' }).jobPort, 9090)
  t.end()
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx ts-node --compiler-options '{"module":"commonjs"}' --transpile-only src/config-runtime.test.ts`
Expected: FAIL with `parseRuntime is not a function`.

- [ ] **Step 3: Implement**

In `src/config.ts`, replace:

```ts
/** Whether a dual run starts both engines at once or one after the other. */
export type EngineSchedule = 'parallel' | 'serial'
```

with:

```ts
/** Whether a dual run starts both engines at once or one after the other. */
export type EngineSchedule = 'parallel' | 'serial'
/**
 * Where the bot runs: the launchd daemon (the default), or the orchestrator and one-shot worker
 * containers (https://github.com/andrew-barnett/slack-review-bot/issues/70).
 */
export type Runtime = 'launchd' | 'container'
```

Replace:

```ts
  /** Dedicated Claude config dir for the engine (Plan 2). */
  claudeConfigDir: string
```

with:

```ts
  /** Dedicated Claude config dir for the engine (Plan 2). */
  claudeConfigDir: string
  /** RUNTIME: the launchd daemon (default) or the orchestrator and worker containers. */
  runtime: Runtime
  /** Container runtime: a worker with no job after this long exits; its ticket lives one minute longer. */
  workerIdleExitMs: number
  /** Container runtime, worker side: the orchestrator's job server. */
  orchestratorUrl: string
  /** Container runtime, orchestrator side: the job server's port on the internal network. */
  jobPort: number
```

Replace:

```ts
/** Parse REVIEW_ENGINES: unset means Codex alone; the only other accepted shape is both engines. */
export function parseEngines(raw: string | undefined): EngineName[] {
```

with:

```ts
/** Parse RUNTIME: unset means the launchd daemon. */
export function parseRuntime(raw: string | undefined): Runtime {
  if (raw === undefined || raw.trim() === '') return 'launchd'
  if (raw === 'launchd' || raw === 'container') return raw
  throw new Error(`RUNTIME must be "launchd" or "container" (got "${raw}")`)
}

/**
 * Parse REVIEW_ENGINES: unset means Codex alone; the other accepted shape is both engines. In the
 * container runtime, single mode may also be Claude alone (spec D8).
 */
export function parseEngines(raw: string | undefined, runtime: Runtime = 'launchd'): EngineName[] {
```

Replace:

```ts
  const shape = [...list].sort().join(',')
  if (list.length !== new Set(list).size || (shape !== 'codex' && shape !== 'claude,codex')) {
    throw new Error(`REVIEW_ENGINES must be "codex" or "codex,claude" (got "${raw}")`)
  }
  return list as EngineName[]
```

with:

```ts
  const shape = [...list].sort().join(',')
  const shapes = runtime === 'container' ? ['codex', 'claude', 'claude,codex'] : ['codex', 'claude,codex']
  if (list.length !== new Set(list).size || !shapes.includes(shape)) {
    throw new Error(
      runtime === 'container'
        ? `REVIEW_ENGINES must be "codex", "claude" or "codex,claude" (got "${raw}")`
        : `REVIEW_ENGINES must be "codex" or "codex,claude" (got "${raw}"); "claude" alone needs RUNTIME=container`
    )
  }
  return list as EngineName[]
```

Replace:

```ts
  const home = env.HOME || os.homedir()
  const reviewEngines = parseEngines(env.REVIEW_ENGINES)
  const dual = reviewEngines.length > 1
```

with:

```ts
  const home = env.HOME || os.homedir()
  const runtime = parseRuntime(env.RUNTIME)
  const reviewEngines = parseEngines(env.REVIEW_ENGINES, runtime)
  const dual = reviewEngines.length > 1
  // The container runtime posts every review as the role account (spec D8), so the role tokens are
  // read in single mode too: the orchestrator receives the approver token, a worker the engine token.
  const container = runtime === 'container'
```

Replace:

```ts
    approverGhToken: dual ? env[APPROVER_TOKEN_VAR] ?? '' : '',
    engineGhToken: dual ? env[ENGINE_TOKEN_VAR] ?? '' : '',
```

with:

```ts
    approverGhToken: dual || container ? env[APPROVER_TOKEN_VAR] ?? '' : '',
    engineGhToken: dual || container ? env[ENGINE_TOKEN_VAR] ?? '' : '',
```

Replace:

```ts
    claudeConfigDir: env.CLAUDE_CONFIG_DIR_REVIEW || path.join(home, '.claude-review-bot'),
```

with:

```ts
    claudeConfigDir: env.CLAUDE_CONFIG_DIR_REVIEW || path.join(home, '.claude-review-bot'),
    runtime,
    workerIdleExitMs: parsePositiveInt(env.WORKER_IDLE_EXIT_MS, 10 * 60 * 1000),
    orchestratorUrl: env.ORCHESTRATOR_URL || 'http://slack-review-bot-orchestrator:8080',
    jobPort: parsePositiveInt(env.JOB_PORT, 8080),
```

Replace:

```ts
  if (dual) {
    if (!config.approverGhToken) throw new Error(`${APPROVER_TOKEN_VAR} is required when REVIEW_ENGINES=codex,claude`)
```

with:

```ts
  // In the container runtime no process holds both tokens; the launcher checks they differ (spec 3.2),
  // the orchestrator requires the approver token and the worker the engine token.
  if (dual && !container) {
    if (!config.approverGhToken) throw new Error(`${APPROVER_TOKEN_VAR} is required when REVIEW_ENGINES=codex,claude`)
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx ts-node --compiler-options '{"module":"commonjs"}' --transpile-only src/config-runtime.test.ts && npx ts-node --compiler-options '{"module":"commonjs"}' --transpile-only src/config.test.ts`
Expected: PASS for both (the existing `parseEngines('claude')` test still matches `/REVIEW_ENGINES/`).

Run: `npm run typecheck`
Expected: exit 0. If a test file builds a `ReviewConfig` literal by hand and now misses `runtime`, `workerIdleExitMs`, `orchestratorUrl` or `jobPort`, build it from `loadReviewConfig({...})` with an override spread instead of adding the fields by hand.

- [ ] **Step 5: Commit**

Write `/tmp/srb-commit-msg.txt`:

```text
feat(config): add RUNTIME=container and its worker settings (refs andrew-barnett/slack-review-bot#70)

The container runtime reads the role tokens in single mode, accepts
REVIEW_ENGINES=claude, and leaves the both-tokens check to the launcher,
because no container holds both. Launchd behaviour is unchanged.

[cc](https://claude.com/claude-code)
```

Run: `git add src/config.ts src/config-runtime.test.ts && git commit -F /tmp/srb-commit-msg.txt`

---

### Task 7: The one-shot worker (`src/jobs/client.ts`, `src/worker.ts`)

**Files:**
- Create: `src/jobs/client.ts`, `src/worker.ts` (library, no side effects), `src/worker-main.ts` (entrypoint)
- Test: `src/jobs/client.test.ts`, `src/worker.test.ts`
- Modify: `package.json` (`build` also bundles `src/worker-main.ts` as `dist/worker.js`)

Why two files: esbuild hoists every imported module into one bundle scope, where `require.main === module` is true for all of them. Task 11's doctor bundle imports `assertWorkerConfig`, so a `require.main` guard in `src/worker.ts` would start a worker inside `dist/doctor.js`. Entrypoint modules (`src/app.ts`, `src/*-main.ts`) are therefore never imported by anything, and library modules have no top-level side effects.

**Interfaces:**
- Consumes: Task 1 `serializeRunError`; Task 2 protocol (`CLAIM_WAIT_MS`, `HEARTBEAT_MS`, `LOG_CHUNK_LIMIT`, `parseClaimReply`, `ClaimReply`, `ProgressBody`, `ResultBody`); Task 3 `createJobBroker`, `startJobServer` (tests only); Task 5 `readSecretBundle`, `WORKER_BUNDLE`; Task 6 `ReviewConfig.runtime`, `workerIdleExitMs`, `orchestratorUrl`; Phase 2a `resolveBedrockAuth`, `BedrockAuth`, `registerHeldSecret`, `scrubDaemonSecrets(env, config)`; `runCodexReportOnly`, `runClaudeReview`, `createChildRegistry`, `drainChildRegistry`, `SHUTDOWN_GRACE_MS`, `SHUTDOWN_POLL_MS`.
- Produces (client.ts):
  - `type ClaimOutcome = { status: 200; job: ClaimReply } | { status: number; job?: undefined }`
  - `interface JobClient { claim(ticket: string): Promise<ClaimOutcome>; progress(job: ClaimReply, body: ProgressBody): Promise<number>; heartbeat(job: ClaimReply): Promise<number>; result(job: ClaimReply, body: ResultBody): Promise<number>; log(job: ClaimReply, chunk: Buffer): Promise<number> }`
  - `makeJobClient(baseUrl: string, fetchImpl?: typeof fetch): JobClient`
- Produces (worker.ts):
  - `interface WorkerDeps { config: ReviewConfig; ticket: string; client: JobClient; runCodex: typeof runCodexReportOnly; runClaude: typeof runClaudeReview; resolveAuth(engine: EngineName, runId: string): Promise<BedrockAuth>; registry: ChildRegistry; logDir: string; log(event: string, fields?: Record<string, unknown>): void; now(): number; sleep(ms: number): Promise<void>; every(ms: number, fn: () => void): () => void; setTimer(fn: () => void, ms: number): void; readFrom(file: string, offset: number, max: number): Buffer }`
  - `type WorkerExit = 'done' | 'cancelled' | 'idle' | 'rejected' | 'lost'`
  - `runWorker(deps: WorkerDeps): Promise<WorkerExit>`
  - `assertWorkerConfig(config: ReviewConfig): void`
  - `workerWorktreeRoot(given: string, root: string): string`
  - `renderWorkerNpmrc(): string`, `writeWorkerNpmrc(file: string): void`, `WORKER_NPMRC = '/home/bot/.npmrc-worker'`, `CODEARTIFACT_REGISTRY`
  - `CLAIM_RETRY_MS = 2_000`, `LOG_POLL_MS = 2_000`, `CHILD_KILL_GRACE_MS = 10_000`, `HEARTBEAT_FAILURE_LIMIT = 6`

- [ ] **Step 1: Write the failing client test**

Create `src/jobs/client.test.ts`:

```ts
import type { AddressInfo } from 'net'
import test from 'tape'
import { createJobBroker } from './broker'
import { makeJobClient } from './client'
import { startJobServer } from './server'
import { mintTicket } from './ticket'

const key = Buffer.alloc(32, 6)

// The worker's client against the real server: it must authenticate each call the right way and
// surface the status codes the worker acts on (403 rejected, 409 cancel). Regression caught: a client
// that sends the ticket on job calls or the job token on claims.
test('the job client claims, heartbeats, logs and reports over HTTP', async t => {
  const broker = createJobBroker({ launchKey: key, ticketMaxAgeMs: 660_000, logDir: '', claimWaitMs: 50 })
  const server = await startJobServer({ broker, port: 0, host: '127.0.0.1' })
  const client = makeJobClient(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)
  t.deepEqual(await client.claim(mintTicket(key, Date.now())), { status: 204 })
  t.deepEqual(await client.claim('forged'), { status: 403 })
  const out = broker.submit('claude-review', { prompt: 'p', worktreeRoot: '/work/wt/claude', timeoutMs: 1000, runId: 'C1-11.claude' })
  const claim = await client.claim(mintTicket(key, Date.now()))
  t.equal(claim.status, 200)
  if (claim.status !== 200 || !claim.job) return t.end()
  t.equal(claim.job.kind, 'claude-review')
  t.equal(await client.heartbeat(claim.job), 200)
  t.equal(await client.progress(claim.job, { line: 'x', activeMs: 1 }), 200)
  t.equal(await client.log(claim.job, Buffer.from('log')), 200)
  t.equal(await client.result(claim.job, { ok: true, outcome: { activeMs: 1 } }), 200)
  t.deepEqual(await out, { activeMs: 1 })
  t.equal(await client.heartbeat(claim.job), 403, 'the token is dead after the result')
  broker.stop()
  await new Promise<void>(resolve => server.close(() => resolve()))
  t.end()
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx ts-node --compiler-options '{"module":"commonjs"}' --transpile-only src/jobs/client.test.ts`
Expected: FAIL with `Cannot find module './client'`.

- [ ] **Step 3: Write the client**

Create `src/jobs/client.ts`:

```ts
// The worker's side of the job protocol (spec 3.3): one claim with the ticket, then every call for
// the job with its job token. Each call is time-bounded so a wedged orchestrator cannot hang a worker.

import { CLAIM_WAIT_MS, parseClaimReply, type ClaimReply, type ProgressBody, type ResultBody } from './protocol'

export type ClaimOutcome = { status: 200; job: ClaimReply } | { status: number; job?: undefined }

export interface JobClient {
  claim(ticket: string): Promise<ClaimOutcome>
  progress(job: ClaimReply, body: ProgressBody): Promise<number>
  heartbeat(job: ClaimReply): Promise<number>
  result(job: ClaimReply, body: ResultBody): Promise<number>
  log(job: ClaimReply, chunk: Buffer): Promise<number>
}

const CALL_TIMEOUT_MS = 15_000
const RESULT_TIMEOUT_MS = 60_000

export function makeJobClient(baseUrl: string, fetchImpl: typeof fetch = fetch): JobClient {
  const call = (route: string, authorization: string, body: string | Buffer | undefined, timeoutMs: number) =>
    fetchImpl(new URL(route, baseUrl), {
      method: 'POST',
      headers: {
        authorization,
        ...(body === undefined ? {} : { 'content-type': typeof body === 'string' ? 'application/json' : 'application/octet-stream' }),
      },
      body,
      signal: AbortSignal.timeout(timeoutMs),
    })
  /** Drain the body so the connection can be reused, and return the status. */
  const status = async (res: Response): Promise<number> => {
    await res.arrayBuffer().catch(() => undefined)
    return res.status
  }
  const jobRoute = (job: ClaimReply, action: string) => `/v1/jobs/${job.jobId}/${action}`
  const auth = (job: ClaimReply) => `Job ${job.jobToken}`
  return {
    async claim(ticket) {
      const res = await call('/v1/claim', `Ticket ${ticket}`, undefined, CLAIM_WAIT_MS + 10_000)
      if (res.status !== 200) return { status: await status(res) }
      return { status: 200, job: parseClaimReply(await res.json()) }
    },
    progress: async (job, body) => status(await call(jobRoute(job, 'progress'), auth(job), JSON.stringify(body), CALL_TIMEOUT_MS)),
    heartbeat: async job => status(await call(jobRoute(job, 'heartbeat'), auth(job), '{}', CALL_TIMEOUT_MS)),
    result: async (job, body) => status(await call(jobRoute(job, 'result'), auth(job), JSON.stringify(body), RESULT_TIMEOUT_MS)),
    log: async (job, chunk) => status(await call(jobRoute(job, 'log'), auth(job), chunk, CALL_TIMEOUT_MS)),
  }
}
```

- [ ] **Step 4: Run the client test to verify it passes**

Run: `npx ts-node --compiler-options '{"module":"commonjs"}' --transpile-only src/jobs/client.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing worker tests**

Create `src/worker.test.ts`:

```ts
import test from 'tape'
import type { BedrockAuth } from './bedrock-auth'
import { ClaudeRunError } from './claude'
import { CodexOutputError } from './codex'
import { loadReviewConfig } from './config'
import type { ClaimOutcome, JobClient } from './jobs/client'
import type { ClaimReply, ProgressBody, ResultBody } from './jobs/protocol'
import {
  assertWorkerConfig,
  CODEARTIFACT_REGISTRY,
  HEARTBEAT_FAILURE_LIMIT,
  renderWorkerNpmrc,
  runWorker,
  workerWorktreeRoot,
  type WorkerDeps,
} from './worker'

const config = loadReviewConfig({
  HOME: '/home/bot',
  RUNTIME: 'container',
  ENGINE_AUTH: 'bedrock',
  AWS_ACCESS_KEY_ID: 'id-placeholder-value',
  AWS_SECRET_ACCESS_KEY: 'secret-placeholder-value',
  AWS_SESSION_TOKEN: 'session-placeholder-value',
  ENGINE_GH_TOKEN: 'engine-placeholder',
  WORKSPACE_ROOT: '/work/src',
  WORKTREE_ROOT: '/work/wt',
  CODEX_BIN: '/usr/local/bin/codex',
  CLAUDE_BIN: '/usr/local/bin/claude',
  CLAUDE_CONFIG_DIR_REVIEW: '/home/bot/.claude-review-bot',
})
const auth: BedrockAuth = { region: 'us-east-2', model: 'us.openai.gpt-5.5', credentials: { accessKeyId: 'a', secretAccessKey: 's', sessionToken: 't' } }
const SHA = 'd'.repeat(40)
const clean = { results: [{ url: 'https://github.com/o/r/pull/1', reviewedSha: SHA, verdict: 'clean' as const, findings: [], summary: '', environmentProblems: [] }] }
const codexJob: ClaimReply = {
  jobId: 'j1',
  jobToken: 'f'.repeat(64),
  kind: 'codex-report-only',
  options: { prompt: 'p', worktreeRoot: '/work/wt/codex', timeoutMs: 1000, stallTimeoutMs: 500, runId: 'C1-11.codex' },
}
const tick = () => new Promise(resolve => setImmediate(resolve))

/** A worker wired to fakes; `every` callbacks are captured (heartbeat first, then log polling). */
function harness(claims: (ClaimOutcome | Error)[] = [{ status: 200, job: codexJob }]) {
  let clock = 0
  const calls = { progress: [] as ProgressBody[], results: [] as ResultBody[], logs: [] as string[], heartbeats: 0 }
  const heartbeat = { status: 200 as number | Error }
  const killed: string[] = []
  const timers: (() => void)[] = []
  const client: JobClient = {
    claim: async () => {
      clock += 25_000 // a long-poll that found nothing takes its full wait
      const next = claims.length > 1 ? claims.shift()! : claims[0]
      if (next instanceof Error) throw next
      return next
    },
    progress: async (_job, body) => {
      calls.progress.push(body)
      return 200
    },
    heartbeat: async () => {
      calls.heartbeats += 1
      if (heartbeat.status instanceof Error) throw heartbeat.status
      return heartbeat.status
    },
    result: async (_job, body) => {
      calls.results.push(body)
      return 200
    },
    log: async (_job, chunk) => {
      calls.logs.push(chunk.toString())
      return 200
    },
  }
  const deps: WorkerDeps = {
    config,
    ticket: 'ticket-placeholder',
    client,
    runCodex: async () => ({ result: clean, rawFinalMessage: 'raw', tokensUsed: 3, activeMs: 4 }),
    runClaude: async () => ({ result: clean, usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, numTurns: 1, durationMs: 1 }, tokensUsed: 2, activeMs: 5, permissionDenials: 0 }),
    resolveAuth: async () => auth,
    registry: { add: () => {}, remove: () => {}, killAll: signal => (killed.push(signal), 1), size: () => 0 },
    logDir: '/tmp/srb-run-test',
    log: () => {},
    now: () => clock,
    sleep: async ms => {
      clock += ms
    },
    every: (_ms, fn) => {
      timers.push(fn)
      return () => {}
    },
    setTimer: fn => fn(),
    readFrom: () => Buffer.alloc(0),
  }
  return { deps, calls, heartbeat, killed, timers }
}

// Spec 3.4 step 3: a worker that never gets a job exits 0 after WORKER_IDLE_EXIT_MS, so the launcher
// replaces it with fresh credentials. Regression caught: a worker idling forever on expiring STS keys.
test('worker exits idle when no job arrives before WORKER_IDLE_EXIT_MS', async t => {
  const h = harness([{ status: 204 }])
  let ran = false
  h.deps.runCodex = async () => {
    ran = true
    throw new Error('should not run')
  }
  t.equal(await runWorker(h.deps), 'idle')
  t.notOk(ran)
  t.end()
})

// A 403 means a bad, spent or expired ticket: the worker can never get a job, so it exits at once.
test('worker exits rejected when its ticket is refused', async t => {
  const h = harness([{ status: 403 }])
  t.equal(await runWorker(h.deps), 'rejected')
  t.deepEqual(h.calls.results, [])
  t.end()
})

// Ruling 1: the job supplies only the prompt, the worktree root, the budget and the run id. The binary,
// profile, workspace, engine token and Bedrock credentials come from the worker's own config. The raw
// final message is not sent back.
test('worker runs the claimed codex job with its own config and credentials', async t => {
  const h = harness()
  const seen: Record<string, unknown>[] = []
  const authCalls: string[] = []
  h.deps.resolveAuth = async (engine, runId) => {
    authCalls.push(`${engine}:${runId}`)
    return auth
  }
  h.deps.runCodex = async options => {
    seen.push(options as unknown as Record<string, unknown>)
    options.onProgress?.('npm ci', 9)
    await tick()
    return { result: clean, rawFinalMessage: 'raw final message', tokensUsed: 3, activeMs: 4 }
  }
  t.equal(await runWorker(h.deps), 'done')
  const o = seen[0]
  t.equal(o.codexBin, '/usr/local/bin/codex')
  t.equal(o.profile, config.codexProfile)
  t.equal(o.workspaceRoot, '/work/src')
  t.equal(o.worktreeRoot, '/work/wt/codex')
  t.equal(o.engineGhToken, 'engine-placeholder')
  t.equal(o.bedrock, auth)
  t.equal(o.prompt, 'p')
  t.equal(o.runId, 'C1-11.codex')
  t.equal(o.stallTimeoutMs, 500)
  t.equal(o.logDir, '/tmp/srb-run-test')
  t.deepEqual(authCalls, ['codex:C1-11.codex'], 'fresh Bedrock auth per attempt, for the right engine')
  t.deepEqual(h.calls.progress, [{ line: 'npm ci', activeMs: 9 }])
  t.deepEqual(h.calls.results, [{ ok: true, outcome: { result: clean, tokensUsed: 3, activeMs: 4 } }])
  t.end()
})

// Spec 3.3 cancellation: a 409 on a heartbeat makes the worker SIGTERM, then SIGKILL, its children,
// and the killed run's own outcome is still reported, exactly as a locally killed child would be.
test('worker cancels its children on 409 and still reports the outcome', async t => {
  const h = harness()
  h.heartbeat.status = 409
  h.deps.runCodex = async () => {
    h.timers[0]()
    await tick()
    throw new CodexOutputError('Codex exited with code null and produced no final message', undefined, 1)
  }
  t.equal(await runWorker(h.deps), 'cancelled')
  t.deepEqual(h.killed, ['SIGTERM', 'SIGKILL'])
  t.equal(h.calls.results.length, 1)
  const body = h.calls.results[0]
  t.ok(!body.ok && body.error.class === 'CodexOutputError')
  t.end()
})

// Spec section 5: when the orchestrator restarted, the next call gets 404; the worker kills its
// children and exits without posting into a job nobody owns.
test('worker treats 404 as the orchestrator gone: kills children, posts nothing', async t => {
  const h = harness()
  h.heartbeat.status = 404
  h.deps.runCodex = async () => {
    h.timers[0]()
    await tick()
    throw new CodexOutputError('killed', undefined, 1)
  }
  t.equal(await runWorker(h.deps), 'lost')
  t.ok(h.killed.includes('SIGTERM'))
  t.deepEqual(h.calls.results, [])
  t.end()
})

// An orchestrator that vanished entirely (no 404, just connection errors) must not keep a worker
// running PR code for hours: about a minute of failed heartbeats counts as lost.
test('worker treats a minute of failed heartbeats as the orchestrator gone', async t => {
  const h = harness()
  h.heartbeat.status = new Error('getaddrinfo ENOTFOUND')
  h.deps.runCodex = async () => {
    for (let i = 0; i < HEARTBEAT_FAILURE_LIMIT; i += 1) {
      h.timers[0]()
      await tick()
    }
    throw new CodexOutputError('killed', undefined, 1)
  }
  t.equal(await runWorker(h.deps), 'lost')
  t.ok(h.killed.includes('SIGTERM'))
  t.end()
})

// The orchestrator's retry logic needs the class and the kind: a Claude stall must arrive as a
// ClaudeRunError with kind 'stall' (spec 3.3 error round-trip).
test('worker serializes a Claude stall for the orchestrator', async t => {
  const h = harness([{ status: 200, job: { ...codexJob, kind: 'claude-review', options: { ...codexJob.options, worktreeRoot: '/work/wt/claude', runId: 'C1-11.claude' } } }])
  let options: Record<string, unknown> = {}
  h.deps.runClaude = async o => {
    options = o as unknown as Record<string, unknown>
    throw new ClaudeRunError('stalled', 'stall', 7)
  }
  t.equal(await runWorker(h.deps), 'done')
  t.equal(options.claudeBin, '/usr/local/bin/claude')
  t.equal(options.configDir, '/home/bot/.claude-review-bot')
  t.deepEqual(h.calls.results, [{ ok: false, error: { class: 'ClaudeRunError', message: 'stalled', kind: 'stall', activeMs: 7 } }])
  t.end()
})

// A job naming a worktree outside WORKTREE_ROOT is refused before the engine runs.
test('worker refuses a worktree root outside WORKTREE_ROOT', async t => {
  const h = harness([{ status: 200, job: { ...codexJob, options: { ...codexJob.options, worktreeRoot: '/home/bot' } } }])
  let ran = false
  h.deps.runCodex = async () => {
    ran = true
    return { result: clean, rawFinalMessage: '', activeMs: 0 }
  }
  t.equal(await runWorker(h.deps), 'done')
  t.notOk(ran)
  const body = h.calls.results[0]
  t.ok(!body.ok && /outside WORKTREE_ROOT/.test(body.error.message))
  t.equal(workerWorktreeRoot('/work/wt/claude', '/work/wt'), '/work/wt/claude')
  t.throws(() => workerWorktreeRoot('/work/wt/../../etc', '/work/wt'), /outside/)
  t.end()
})

// The run log reaches the orchestrator: whatever the local run wrote is streamed, and a final flush
// after the run ships the tail.
test('worker streams the run log and flushes it after the run', async t => {
  const h = harness()
  const chunks = [Buffer.from('first part'), Buffer.alloc(0)]
  h.deps.readFrom = () => chunks.shift() ?? Buffer.alloc(0)
  t.equal(await runWorker(h.deps), 'done')
  t.deepEqual(h.calls.logs, ['first part'])
  t.end()
})

// Spec 3.4: the worker runs only as a container worker with launcher-minted static Bedrock
// credentials and the engine token. Each missing piece is refused at startup, not mid-review.
test('assertWorkerConfig requires the container runtime, static Bedrock credentials and the engine token', t => {
  t.doesNotThrow(() => assertWorkerConfig(config))
  t.throws(() => assertWorkerConfig({ ...config, runtime: 'launchd' }), /RUNTIME=container/)
  t.throws(() => assertWorkerConfig({ ...config, engineAuth: 'subscription' }), /ENGINE_AUTH=bedrock/)
  t.throws(() => assertWorkerConfig({ ...config, engineRoleArn: 'arn:aws:iam::123456789012:role/x' }), /ENGINE_ROLE_ARN/)
  t.throws(() => assertWorkerConfig({ ...config, engineAwsStatic: undefined }), /AWS credentials/)
  t.throws(() => assertWorkerConfig({ ...config, engineGhToken: '' }), /ENGINE_GH_TOKEN/)
  t.end()
})

// Ruling 13: the npmrc names the token by reference, so the value never touches the filesystem.
test('renderWorkerNpmrc references the token by name, never by value', t => {
  const text = renderWorkerNpmrc()
  t.ok(text.includes(`@trade-platform:registry=${CODEARTIFACT_REGISTRY}`))
  t.ok(text.includes('//trade-platform-153538148884.d.codeartifact.us-east-2.amazonaws.com/npm/trade-platform/:_authToken=${NPM_TOKEN}'))
  t.end()
})
```

- [ ] **Step 6: Run the worker tests to verify they fail**

Run: `npx ts-node --compiler-options '{"module":"commonjs"}' --transpile-only src/worker.test.ts`
Expected: FAIL with `Cannot find module './worker'`.

- [ ] **Step 7: Write the worker**

Create `src/worker.ts`:

```ts
// The one-shot worker (spec 3.4). It claims exactly one job, runs one engine attempt with the local
// run function, streams progress and the run log back, posts the result and exits 0 whatever the
// result. It holds only low-value, short-lived engine credentials from its stdin bundle, never
// LAUNCH_KEY and never a daemon token, and its workspace starts empty (spec D7).

import * as fs from 'fs'
import * as path from 'path'
import type { BedrockAuth } from './bedrock-auth'
import type { runClaudeReview } from './claude'
import type { ChildRegistry, runCodexReportOnly } from './codex'
import type { EngineName, ReviewConfig } from './config'
import type { JobClient } from './jobs/client'
import { serializeRunError } from './jobs/errors'
import { HEARTBEAT_MS, LOG_CHUNK_LIMIT, type ClaimReply, type ProgressBody, type ResultBody } from './jobs/protocol'
import { redactSecrets } from './redact'

export const CLAIM_RETRY_MS = 2_000
export const LOG_POLL_MS = 2_000
export const CHILD_KILL_GRACE_MS = 10_000
/** Consecutive failed heartbeats (about a minute at 10 s) after which the orchestrator is gone. */
export const HEARTBEAT_FAILURE_LIMIT = 6
export const WORKER_NPMRC = '/home/bot/.npmrc-worker'
export const CODEARTIFACT_REGISTRY = 'https://trade-platform-153538148884.d.codeartifact.us-east-2.amazonaws.com/npm/trade-platform/'

export interface WorkerDeps {
  config: ReviewConfig
  ticket: string
  client: JobClient
  runCodex: typeof runCodexReportOnly
  runClaude: typeof runClaudeReview
  resolveAuth(engine: EngineName, runId: string): Promise<BedrockAuth>
  registry: ChildRegistry
  logDir: string
  log(event: string, fields?: Record<string, unknown>): void
  now(): number
  sleep(ms: number): Promise<void>
  every(ms: number, fn: () => void): () => void
  setTimer(fn: () => void, ms: number): void
  readFrom(file: string, offset: number, max: number): Buffer
}

export type WorkerExit = 'done' | 'cancelled' | 'idle' | 'rejected' | 'lost'

/** Spec 3.4: only a container worker with launcher-minted static Bedrock credentials may run. */
export function assertWorkerConfig(config: ReviewConfig): void {
  if (config.runtime !== 'container') throw new Error('the worker runs only with RUNTIME=container')
  if (config.engineAuth !== 'bedrock') throw new Error('the worker needs ENGINE_AUTH=bedrock')
  if (config.engineRoleArn) throw new Error('the worker uses launcher-minted static credentials; unset ENGINE_ROLE_ARN')
  if (!config.engineAwsStatic) throw new Error('the worker has no engine AWS credentials')
  if (!config.engineGhToken) throw new Error('the worker has no ENGINE_GH_TOKEN')
}

/** The job's worktree root, which must sit under the worker's own WORKTREE_ROOT. */
export function workerWorktreeRoot(given: string, root: string): string {
  const resolved = path.resolve(given)
  const rel = path.relative(path.resolve(root), resolved)
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('the job named a worktree root outside WORKTREE_ROOT')
  return resolved
}

/** Ruling 13: npm reads the token from the environment; the file holds only its name. */
export function renderWorkerNpmrc(): string {
  const host = CODEARTIFACT_REGISTRY.replace(/^https:/, '')
  return [`@trade-platform:registry=${CODEARTIFACT_REGISTRY}`, `${host}:_authToken=\${NPM_TOKEN}`, ''].join('\n')
}

export function writeWorkerNpmrc(file: string): void {
  fs.writeFileSync(file, renderWorkerNpmrc(), { mode: 0o600 })
}

/** Read up to `max` bytes of `file` from `offset`; empty when the file does not exist yet. */
export function readFrom(file: string, offset: number, max: number): Buffer {
  let fd: number
  try {
    fd = fs.openSync(file, 'r')
  } catch {
    return Buffer.alloc(0)
  }
  try {
    const buffer = Buffer.alloc(max)
    const read = fs.readSync(fd, buffer, 0, max, offset)
    return buffer.subarray(0, read)
  } finally {
    fs.closeSync(fd)
  }
}

async function claimOne(deps: WorkerDeps): Promise<ClaimReply | 'idle' | 'rejected'> {
  const deadline = deps.now() + deps.config.workerIdleExitMs
  while (deps.now() < deadline) {
    const started = deps.now()
    try {
      const reply = await deps.client.claim(deps.ticket)
      if (reply.status === 200 && reply.job) return reply.job
      if (reply.status === 403) return 'rejected'
      if (reply.status === 204 && deps.now() - started >= 1_000) continue
      if (reply.status !== 204) deps.log('worker.claim_status', { status: reply.status })
    } catch (error) {
      deps.log('worker.claim_failed', { error: redactSecrets(String(error)) })
    }
    // An error, an unexpected status, or a 204 that came back too fast to be a long-poll.
    await deps.sleep(CLAIM_RETRY_MS)
  }
  return 'idle'
}

export async function runWorker(deps: WorkerDeps): Promise<WorkerExit> {
  const claimed = await claimOne(deps)
  if (claimed === 'idle' || claimed === 'rejected') {
    deps.log(`worker.${claimed}`, {})
    return claimed
  }
  const job = claimed
  const engine: EngineName = job.kind === 'codex-report-only' ? 'codex' : 'claude'
  deps.log('worker.claimed', { jobId: job.jobId, kind: job.kind, runId: job.options.runId })

  let cancelled = false
  let lost = false
  const cancel = (why: 'cancel' | 'lost') => {
    if (why === 'lost') lost = true
    if (cancelled) return
    cancelled = true
    deps.log('worker.cancelling', { jobId: job.jobId, why })
    deps.registry.killAll('SIGTERM')
    deps.setTimer(() => deps.registry.killAll('SIGKILL'), CHILD_KILL_GRACE_MS)
  }
  const onStatus = (status: number) => {
    if (status === 409) cancel('cancel')
    else if (status === 403 || status === 404) cancel('lost')
  }

  let heartbeatFailures = 0
  const beat = async () => {
    try {
      onStatus(await deps.client.heartbeat(job))
      heartbeatFailures = 0
    } catch (error) {
      heartbeatFailures += 1
      deps.log('worker.heartbeat_failed', { failures: heartbeatFailures, error: redactSecrets(String(error)) })
      if (heartbeatFailures >= HEARTBEAT_FAILURE_LIMIT) cancel('lost')
    }
  }
  const stopBeat = deps.every(HEARTBEAT_MS, () => void beat())

  // Progress: at most one post in flight; the newest line replaces any line still waiting.
  let posting = false
  let pending: ProgressBody | undefined
  const pump = async (): Promise<void> => {
    if (posting || !pending) return
    posting = true
    const body = pending
    pending = undefined
    try {
      onStatus(await deps.client.progress(job, body))
    } catch {
      // Progress is best-effort; the heartbeat decides whether the orchestrator is gone.
    } finally {
      posting = false
    }
    return pump()
  }
  const onProgress = (line: string, activeMs: number) => {
    pending = { line, activeMs }
    void pump()
  }

  // Run log: superviseChild writes <logDir>/<runId>.log; ship whatever is new, in capped chunks.
  const logFile = path.join(deps.logDir, `${job.options.runId}.log`)
  let offset = 0
  let shipping = true
  let logChain: Promise<void> = Promise.resolve()
  const shipLog = (): Promise<void> => {
    logChain = logChain.then(async () => {
      while (shipping) {
        const chunk = deps.readFrom(logFile, offset, LOG_CHUNK_LIMIT)
        if (!chunk.length) return
        try {
          const status = await deps.client.log(job, chunk)
          if (status === 413) {
            shipping = false
            deps.log('worker.log_limit', { jobId: job.jobId })
            return
          }
          if (status !== 200) return onStatus(status)
          offset += chunk.length
        } catch {
          return
        }
      }
    })
    return logChain
  }
  const stopLog = deps.every(LOG_POLL_MS, () => void shipLog())

  let body: ResultBody
  try {
    const worktreeRoot = workerWorktreeRoot(job.options.worktreeRoot, deps.config.worktreeRoot)
    const bedrock = await deps.resolveAuth(engine, job.options.runId)
    const common = {
      prompt: job.options.prompt,
      workspaceRoot: deps.config.workspaceRoot,
      worktreeRoot,
      timeoutMs: job.options.timeoutMs,
      stallTimeoutMs: job.options.stallTimeoutMs,
      disableGitSigning: deps.config.disableGitSigning,
      envPassthrough: deps.config.codexEnvPassthrough,
      engineGhToken: deps.config.engineGhToken,
      bedrock,
      registry: deps.registry,
      logDir: deps.logDir,
      runId: job.options.runId,
      log: deps.log,
      onProgress,
    }
    if (engine === 'codex') {
      const o = await deps.runCodex({ ...common, codexBin: deps.config.codexBin, profile: deps.config.codexProfile })
      // The raw final message is not sent: the orchestrator re-validates `result` and needs nothing else.
      body = { ok: true, outcome: { result: o.result, tokensUsed: o.tokensUsed, activeMs: o.activeMs } }
    } else {
      const o = await deps.runClaude({ ...common, claudeBin: deps.config.claudeBin, configDir: deps.config.claudeConfigDir })
      body = { ok: true, outcome: { result: o.result, usage: o.usage, tokensUsed: o.tokensUsed, activeMs: o.activeMs, permissionDenials: o.permissionDenials } }
    }
  } catch (error) {
    body = { ok: false, error: serializeRunError(error) }
  }
  stopBeat()
  stopLog()
  await shipLog()
  if (lost) {
    deps.log('worker.lost', { jobId: job.jobId })
    return 'lost'
  }
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const status = await deps.client.result(job, body)
      deps.log('worker.result_posted', { jobId: job.jobId, status, ok: body.ok })
      break
    } catch (error) {
      deps.log('worker.result_failed', { attempt, error: redactSecrets(String(error)) })
      await deps.sleep(CLAIM_RETRY_MS)
    }
  }
  return cancelled ? 'cancelled' : 'done'
}
```

- [ ] **Step 8: Write the worker entrypoint**

Create `src/worker-main.ts`:

```ts
// Worker container entrypoint (bundled as dist/worker.js). Never imported: see Task 7's note on
// esbuild scope hoisting.

import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { resolveBedrockAuth } from './bedrock-auth'
import { runClaudeReview } from './claude'
import { createChildRegistry, drainChildRegistry, runCodexReportOnly, SHUTDOWN_GRACE_MS, SHUTDOWN_POLL_MS } from './codex'
import { loadReviewConfig, scrubDaemonSecrets } from './config'
import { makeJobClient } from './jobs/client'
import { redactSecrets, registerHeldSecret } from './redact'
import { readSecretBundle, WORKER_BUNDLE } from './secret-bundle'
import { assertWorkerConfig, readFrom, runWorker, WORKER_NPMRC, writeWorkerNpmrc } from './worker'

function log(event: string, fields: Record<string, unknown> = {}): void {
  process.stdout.write(`${JSON.stringify({ time: new Date().toISOString(), event, ...fields })}\n`)
}

async function main(): Promise<void> {
  const bundle = await readSecretBundle(process.stdin, WORKER_BUNDLE)
  const { WORKER_TICKET: ticket, ...exported } = bundle
  // Spec 3.6.1: the worker exports its values into its own environment, as Phase 2a expects. The
  // ticket stays in memory; it is spent on the first claim anyway.
  Object.assign(process.env, exported)
  const config = loadReviewConfig(process.env)
  assertWorkerConfig(config)
  for (const value of [config.engineGhToken, process.env.NPM_TOKEN]) registerHeldSecret(value)
  // Phase 2a: the engine token and AWS keys now live in config and reach a child only by explicit
  // injection; NPM_TOKEN stays, because the engine children's allowlist passes it to npm.
  scrubDaemonSecrets(process.env, config)
  writeWorkerNpmrc(process.env.npm_config_userconfig || WORKER_NPMRC)
  const registry = createChildRegistry()
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'srb-run-'))
  // After the orchestrator has exited, the launcher may SIGTERM a worker (spec 3.6 step 4).
  process.on('SIGTERM', () => {
    void drainChildRegistry(registry, {
      now: Date.now,
      setTimer: (fn, ms) => setTimeout(fn, ms),
      graceMs: SHUTDOWN_GRACE_MS,
      pollMs: SHUTDOWN_POLL_MS,
      log,
    }).then(() => process.exit(0))
  })
  const exit = await runWorker({
    config,
    ticket,
    client: makeJobClient(config.orchestratorUrl),
    runCodex: runCodexReportOnly,
    runClaude: runClaudeReview,
    resolveAuth: (engine, runId) => resolveBedrockAuth(config, engine, runId),
    registry,
    logDir,
    log,
    now: Date.now,
    sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
    every: (ms, fn) => {
      const handle = setInterval(fn, ms)
      return () => clearInterval(handle)
    },
    setTimer: (fn, ms) => {
      setTimeout(fn, ms).unref()
    },
    readFrom,
  })
  log('worker.exit', { exit })
  process.exit(0)
}

main().catch(error => {
  log('worker.fatal', { error: redactSecrets(String(error)) })
  process.exit(1)
})
```

- [ ] **Step 9: Bundle the worker entrypoint**

In `package.json`, replace:

```json
    "build": "esbuild src/app.ts --bundle --platform=node --target=node22 --format=cjs --outfile=dist/app.js --sourcemap",
```

with (the `name=path` form fixes each output file name):

```json
    "build": "esbuild app=src/app.ts worker=src/worker-main.ts --bundle --platform=node --target=node22 --format=cjs --outdir=dist --sourcemap",
```

- [ ] **Step 10: Run the tests and the build**

Run: `npx ts-node --compiler-options '{"module":"commonjs"}' --transpile-only src/worker.test.ts`
Expected: PASS (all eleven tests).

Run: `npm run typecheck && npm run build && ls dist/app.js dist/worker.js`
Expected: exit 0; both bundles listed.

- [ ] **Step 11: Commit**

Write `/tmp/srb-commit-msg.txt`:

```text
feat(worker): add the one-shot worker and its job client (refs andrew-barnett/slack-review-bot#70)

A worker claims one job with its ticket, runs one engine attempt with its
own config and launcher-minted credentials, streams progress and the run
log, and posts the result. A 409 kills its children; a 404 or a minute
of failed heartbeats means the orchestrator is gone.

[cc](https://claude.com/claude-code)
```

Run: `git add package.json src/jobs/client.ts src/jobs/client.test.ts src/worker.ts src/worker-main.ts src/worker.test.ts && git commit -F /tmp/srb-commit-msg.txt`

---

### Task 8: Report-only single mode (`approvals: false` on the dual runner)

**Files:**
- Modify: `src/dual-gate.ts`, `src/dual.ts`, `src/render.ts`, `src/job.ts`
- Test: `src/dual-gate.test.ts`, `src/dual.test.ts`, `src/render.test.ts`, `src/job.test.ts` (append)

**Interfaces:**
- Consumes: the existing `decide`, `composeReview`, `makeDualReviewRunner`, `renderDualThread`, `runJob`.
- Produces:
  - `PrOutcome` gains `'clean'` (ruling 2).
  - `reportOnly(decision: GateDecision): GateDecision` in `src/dual-gate.ts`.
  - `DualDeps.approvals?: boolean` (default `true`); `DualReport.engines?: EngineName[]`.
  - `finishPr` decides against the configured engines (`deps.engines.map(e => e.name)`), so a one-engine run is not an `error` for a "missing" engine.
  - `DUAL_JOB_OUTCOME.clean = 'pass'`; the `clean` reaction is `approvalNotCounted`.

- [ ] **Step 1: Write the failing tests**

Append to `src/dual-gate.test.ts`:

```ts
// Ruling 2: with approvals off, every outcome that would approve, or note a non-counting approval,
// becomes one COMMENT with the outcome 'clean'. Regression caught: a report-only run posting APPROVE.
test('reportOnly turns every approving outcome into a clean COMMENT and leaves the rest', t => {
  t.deepEqual(reportOnly({ event: 'APPROVE', outcome: 'approved' }), { event: 'COMMENT', outcome: 'clean' })
  t.deepEqual(reportOnly({ event: 'APPROVE', outcome: 'approvedPartial' }), { event: 'COMMENT', outcome: 'clean' })
  t.deepEqual(reportOnly({ event: 'COMMENT', outcome: 'cleanNotCounted' }), { event: 'COMMENT', outcome: 'clean' })
  t.deepEqual(reportOnly({ event: 'COMMENT', outcome: 'findings' }), { event: 'COMMENT', outcome: 'findings' })
  t.deepEqual(reportOnly({ event: null, outcome: 'blocked' }), { event: null, outcome: 'blocked' })
  t.deepEqual(reportOnly({ event: null, outcome: 'error' }), { event: null, outcome: 'error' })
  t.end()
})

// A one-engine gate needs exactly that engine's pass; the default engine list (both) would call it
// "missing an engine". The single-engine review body must not claim to be a dual-engine review.
test('decide and composeReview handle a single configured engine', t => {
  t.deepEqual(decide([pass('claude', 'clean')], counts, ['claude']), { event: 'APPROVE', outcome: 'approved' })
  t.deepEqual(decide([pass('claude', 'clean')], counts), { event: null, outcome: 'error' }, 'the default is still both engines')
  const { body } = composeReview({ pinnedSha: SHA, passes: [pass('claude', 'clean')], eligibility: counts, outcome: 'clean', commentable: new Map() })
  t.ok(body.startsWith(`**Review at \`${SHA}\`.** Clean. This review is report-only, so it is a comment, not an approval.`))
  t.notOk(body.includes('Dual-engine'))
  t.end()
})
```

In the same file, replace:

```ts
import { composeReview, decide, passFor, skippedPass, type EnginePass, type PassState } from './dual-gate'
```

with:

```ts
import { composeReview, decide, passFor, reportOnly, skippedPass, type EnginePass, type PassState } from './dual-gate'
```

Append to `src/dual.test.ts`:

```ts
// Spec D8 / ruling 2: single mode in the container runtime is the dual runner with one engine and
// approvals off. A clean result is one COMMENT at the pinned SHA, never an APPROVE.
test('dual runner with approvals off posts a clean COMMENT for one clean engine', async t => {
  const w = world()
  const out = await run(deps(w, [engine('claude')], { approvals: false }))
  t.deepEqual(w.posted.map(p => [p.event, p.commitId]), [['COMMENT', OLD]])
  t.equal(out.dual!.prs[0].outcome, 'clean')
  t.deepEqual(out.dual!.engines, ['claude'])
  t.equal(out.result.results[0].status, 'passed', 'clean counts as passed in the legacy summary')
  t.end()
})

// Findings still post a COMMENT; a report-only run changes nothing else about the gate.
test('dual runner with approvals off still posts findings as a COMMENT', async t => {
  const w = world()
  const out = await run(deps(w, [engine('codex', 'findings')], { approvals: false }))
  t.deepEqual(w.posted.map(p => p.event), ['COMMENT'])
  t.equal(out.dual!.prs[0].outcome, 'findings')
  t.end()
})

// An approval the bot already left at this SHA (from before the switch to report-only) stands; the
// report-only run posts nothing new and reports 'clean', never 'approved'.
test('dual runner with approvals off reports clean when an earlier review stands', async t => {
  const w = world([OLD], {
    botReviews: async () => [{ login: 'role-bot', state: 'APPROVED', commitId: OLD }],
  })
  const out = await run(deps(w, [engine('codex')], { approvals: false }))
  t.deepEqual(w.posted, [])
  t.equal(out.dual!.prs[0].outcome, 'clean')
  t.ok(out.dual!.prs[0].alreadyReviewed)
  t.end()
})
```

Append to `src/render.test.ts`:

```ts
// A one-engine (report-only) thread names its engine and says it is report-only, so nobody reads a
// clean result as an approval.
test('renderDualThread titles a single-engine report-only run', t => {
  const text = renderDualThread({
    engines: ['claude'],
    prs: [{ url: 'https://github.com/o/r/pull/1', outcome: 'clean', passes: [], warnings: [] }],
  })
  t.ok(text.startsWith('Claude review (report-only) of 1 pull request.'))
  t.ok(text.includes('*clean (report-only comment)*'))
  t.equal(worstOutcome(['clean', 'findings']), 'findings')
  t.equal(worstOutcome(['clean']), 'clean')
  t.end()
})
```

Append to `src/job.test.ts`:

```ts
// Ruling 2: a report-only clean result counts as a pass in `status` and reacts with the
// not-counted emoji, never the approval stamp.
test('runJob reacts to a report-only clean result without the approval stamp', async t => {
  const rec = dualRecorder(dualReport('clean'))
  t.equal(await runJob(request, emoji, rec.deps), 'pass')
  t.deepEqual(rec.added, ['eyes', 'white_circle'])
  t.notOk(rec.added.includes('approved_stamp'))
  t.end()
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx ts-node --compiler-options '{"module":"commonjs"}' --transpile-only src/dual-gate.test.ts`
Expected: FAIL with `reportOnly is not a function`.

- [ ] **Step 3: Implement the gate change**

In `src/dual-gate.ts`, replace:

```ts
export type PrOutcome = 'approved' | 'approvedPartial' | 'cleanNotCounted' | 'findings' | 'blocked' | 'error' | 'headMoved'
```

with:

```ts
/** `clean` is the report-only outcome (approvals off): every engine clean, posted as a COMMENT. */
export type PrOutcome = 'approved' | 'approvedPartial' | 'cleanNotCounted' | 'clean' | 'findings' | 'blocked' | 'error' | 'headMoved'
```

Replace:

```ts
/** GitHub caps a review body and each comment at 65,536 characters; stay well under it. */
export const MAX_GITHUB_TEXT = 60_000
```

with:

```ts
/**
 * Approvals off (container single mode, spec D8): anything that would approve, or would note that an
 * approval does not count, is posted as one COMMENT with the outcome `clean`. Everything else stands.
 */
export function reportOnly(decision: GateDecision): GateDecision {
  if (decision.outcome === 'approved' || decision.outcome === 'approvedPartial' || decision.outcome === 'cleanNotCounted') {
    return { event: 'COMMENT', outcome: 'clean' }
  }
  return decision
}

/** GitHub caps a review body and each comment at 65,536 characters; stay well under it. */
export const MAX_GITHUB_TEXT = 60_000
```

Replace:

```ts
  cleanNotCounted: "Both engines are clean, but an approval from this account would not satisfy this PR's rules, so this is a comment, not an approval.",
  findings: 'Findings. Not approved.',
```

with:

```ts
  cleanNotCounted: "Both engines are clean, but an approval from this account would not satisfy this PR's rules, so this is a comment, not an approval.",
  clean: 'Clean. This review is report-only, so it is a comment, not an approval.',
  findings: 'Findings. Not approved.',
```

Replace:

```ts
  const lines: string[] = [`**Dual-engine review at \`${pinnedSha}\`.** ${HEADLINE[outcome]}`, '']
```

with:

```ts
  const title = passes.length === 1 ? 'Review' : 'Dual-engine review'
  const lines: string[] = [`**${title} at \`${pinnedSha}\`.** ${HEADLINE[outcome]}`, '']
```

- [ ] **Step 4: Implement the runner change**

In `src/dual.ts`, replace:

```ts
import type { EngineSchedule } from './config'
import { composeReview, decide, type EnginePass, type GateDecision, type PrOutcome } from './dual-gate'
```

with:

```ts
import type { EngineName, EngineSchedule } from './config'
import { composeReview, decide, reportOnly, type EnginePass, type GateDecision, type PrOutcome } from './dual-gate'
```

Replace:

```ts
export interface DualReport {
  prs: DualPrReport[]
}
```

with:

```ts
export interface DualReport {
  prs: DualPrReport[]
  /** The configured engines, in order; the thread title names a lone engine. */
  engines?: EngineName[]
}
```

Replace:

```ts
  isShuttingDown?(): boolean
}

type Prepared =
```

with:

```ts
  isShuttingDown?(): boolean
  /**
   * False in container single mode (spec D8): the run is report-only, so an approving decision is
   * posted as a `clean` COMMENT. Defaults to true.
   */
  approvals?: boolean
}

type Prepared =
```

Replace:

```ts
  const decision = decide(passes, eligibility)
  if (!decision.event) return { ...report, outcome: decision.outcome }
```

with:

```ts
  const gate = decide(passes, eligibility, deps.engines.map(e => e.name))
  const decision = deps.approvals === false ? reportOnly(gate) : gate
  if (!decision.event) return { ...report, outcome: decision.outcome }
```

Replace:

```ts
      ? [`an earlier approval by the bot at ${short(pinnedSha)} still stands, although this review found ${decision.outcome === 'findings' ? 'blocking findings' : 'that the approval would not count'}`]
```

with:

```ts
      ? [`an earlier approval by the bot at ${short(pinnedSha)} still stands, although this review found ${decision.outcome === 'findings' ? 'blocking findings' : decision.outcome === 'clean' ? 'the PR clean in report-only mode' : 'that the approval would not count'}`]
```

Replace:

```ts
  const passed = report.outcome === 'approved' || report.outcome === 'approvedPartial' || report.outcome === 'cleanNotCounted'
```

with:

```ts
  const passed =
    report.outcome === 'approved' || report.outcome === 'approvedPartial' || report.outcome === 'cleanNotCounted' || report.outcome === 'clean'
```

Replace:

```ts
    return { result: { results: prs.map(legacyResult) }, usage: combineUsage(outcomes), dual: { prs } }
```

with:

```ts
    return { result: { results: prs.map(legacyResult) }, usage: combineUsage(outcomes), dual: { prs, engines: deps.engines.map(e => e.name) } }
```

- [ ] **Step 5: Implement the Slack side**

In `src/render.ts`, replace:

```ts
export const DUAL_SEVERITY: readonly PrOutcome[] = ['error', 'blocked', 'findings', 'headMoved', 'cleanNotCounted', 'approvedPartial', 'approved']
```

with:

```ts
export const DUAL_SEVERITY: readonly PrOutcome[] = ['error', 'blocked', 'findings', 'headMoved', 'clean', 'cleanNotCounted', 'approvedPartial', 'approved']
```

Replace:

```ts
  cleanNotCounted: '*clean, approval would not count*',
```

with:

```ts
  cleanNotCounted: '*clean, approval would not count*',
  clean: '*clean (report-only comment)*',
```

Replace:

```ts
  const total = report.prs.length
  return [`Dual-engine review of ${total} pull request${total === 1 ? '' : 's'}.`, ...report.prs.flatMap(dualLines)].join('\n')
```

with:

```ts
  const total = report.prs.length
  const prs = `${total} pull request${total === 1 ? '' : 's'}`
  const title =
    report.engines?.length === 1 ? `${ENGINE_LABEL[report.engines[0]]} review (report-only) of ${prs}.` : `Dual-engine review of ${prs}.`
  return [title, ...report.prs.flatMap(dualLines)].join('\n')
```

In `src/job.ts`, replace:

```ts
  cleanNotCounted: 'cleanNotCounted',
  findings: 'findings',
```

with:

```ts
  cleanNotCounted: 'cleanNotCounted',
  // Report-only clean (ruling 2): a pass in `status`, never an approval.
  clean: 'pass',
  findings: 'findings',
```

Replace:

```ts
    case 'cleanNotCounted':
      return emoji.approvalNotCounted
```

with:

```ts
    case 'cleanNotCounted':
    case 'clean':
      return emoji.approvalNotCounted
```

Replace:

```ts
  const clean = worst === 'approved' || worst === 'approvedPartial' || worst === 'cleanNotCounted'
```

with:

```ts
  const clean = worst === 'approved' || worst === 'approvedPartial' || worst === 'cleanNotCounted' || worst === 'clean'
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `for f in dual-gate dual render job; do npx ts-node --compiler-options '{"module":"commonjs"}' --transpile-only "src/${f}.test.ts" || exit 1; done`
Expected: PASS for all four files, including every existing test (the dual-engine title and the both-engines decision are unchanged).

Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 7: Commit**

Write `/tmp/srb-commit-msg.txt`:

```text
feat(dual): add a report-only mode to the dual runner (refs andrew-barnett/slack-review-bot#70)

Container single mode runs the dual runner with one engine and approvals
off, so a clean review is posted as the role account's COMMENT rather
than an approval. The gate now decides against the configured engines.

[cc](https://claude.com/claude-code)
```

Run: `git add src/dual-gate.ts src/dual.ts src/render.ts src/job.ts src/dual-gate.test.ts src/dual.test.ts src/render.test.ts src/job.test.ts && git commit -F /tmp/srb-commit-msg.txt`

---

### Task 9: Orchestrator wiring (`src/jobs/runtime.ts`, `src/daemon.ts`, `src/orchestrator.ts`)

**Files:**
- Create: `src/jobs/runtime.ts`, `src/orchestrator.ts` (library), `src/orchestrator-main.ts` (entrypoint), new small `src/app.ts`
- Move: `src/app.ts` → `src/daemon.ts` (then modify)
- Modify: `src/review.ts`, `src/github.ts`, `src/cli.ts`, `package.json`
- Test: `src/jobs/runtime.test.ts`, `src/orchestrator.test.ts`, `src/review-container.test.ts`, `src/github.test.ts` (append)

**Interfaces:**
- Consumes: Task 2 `LAUNCH_KEY_BYTES`, `ticketMaxAgeMs`, `JOB_PORT`; Task 3 `createJobBroker`, `startJobServer`, `JobBroker`; Task 4 `makeRemoteRunners`, `RemoteRunners`; Task 5 `readSecretBundle`, `ORCHESTRATOR_BUNDLE`; Task 6 `ReviewConfig.runtime`, `jobPort`, `workerIdleExitMs`; Task 8 `DualDeps.approvals`.
- Produces:
  - `makeApproverGitHubEffects(token: string, run?: GhRunner): Pick<JobDeps, 'listChangedFiles' | 'postPrComment'>` (github.ts); `makeJobGitHubEffects` posts as the approver in the container runtime too.
  - `makeContainerReviewRunner(config: ReviewConfig, deps: RunnerDeps, available?: boolean)` (review.ts); `selectReviewRunner` routes `RUNTIME=container` to it.
  - `interface ContainerRuntime { broker: JobBroker; registry: ChildRegistry; runners: RemoteRunners; listChangedFiles(pr: PullRequestRef): Promise<string[]>; port(): number; close(): Promise<void> }`
  - `startContainerRuntime(config: ReviewConfig, launchKey: Buffer, log: (event: string, fields: Record<string, unknown>) => void, options?: { port?: number; host?: string; smoke?: (runners: RemoteRunners) => () => Promise<unknown> }): Promise<ContainerRuntime>`
  - `src/daemon.ts`: `log`, `installCrashHandlers`, `interface DaemonOptions { config: Config; container?: ContainerRuntime }`, `runDaemon(options: DaemonOptions): Promise<void>`.
  - `src/orchestrator.ts`: `orchestratorConfig(bundle: Record<string, string>, env: NodeJS.ProcessEnv): { config: Config; launchKey: Buffer }`.

- [ ] **Step 1: Write the failing tests**

Create `src/review-container.test.ts`:

```ts
import test from 'tape'
import type { ApproverGitHub, PullRequestInfo } from './approver-github'
import { loadReviewConfig } from './config'
import type { ReviewRequest } from './job'
import { makeContainerReviewRunner, selectReviewRunner } from './review'

const SHA = 'c'.repeat(40)
const URL1 = 'https://github.com/o/r/pull/1'
const request: ReviewRequest = { message: { channel: 'C1', ts: '1.1' }, prs: [{ owner: 'o', repo: 'r', number: 1, url: URL1 }], instructions: '' }
const config = loadReviewConfig({ HOME: '/home/bot', RUNTIME: 'container', REVIEW_ENGINES: 'claude', APPROVER_GH_TOKEN: 'approver-placeholder' })
const info: PullRequestInfo = { author: 'dev', base: 'main', baseRepo: 'o/r', headRef: 'feat/x', headSha: SHA, headRepo: 'o/r', state: 'open', draft: false }

/** A role-account fake on an unprotected branch; records what was posted. */
function fakeGh(posted: string[]): ApproverGitHub {
  return {
    login: async () => 'role-bot',
    getPullRequest: async () => info,
    permission: async () => 'write',
    branchRules: async () => [],
    classicProtection: async () => null,
    fileAt: async () => null,
    codeownersErrorCount: async () => null,
    isTeamMember: async () => false,
    reviews: async () => [],
    latestPush: async () => null,
    behindBy: async () => 0,
    postIssueComment: async () => {},
    commentableLines: async () => new Map(),
    updateBranch: async () => ({ ok: true as const }),
    postReview: async (_pr: unknown, review: { event: string }) => {
      posted.push(review.event)
      return { id: 1, url: `${URL1}#pullrequestreview-1` }
    },
    botReviews: async () => [],
    decision: async () => ({ reviewDecision: 'APPROVED', mergeStateStatus: 'CLEAN' }),
  } as unknown as ApproverGitHub
}

const remote = {
  runCodex: async () => {
    throw new Error('codex is not configured')
  },
  runClaude: async () => ({
    result: { results: [{ url: URL1, reviewedSha: SHA, verdict: 'clean' as const, findings: [], summary: '', environmentProblems: [] }] },
    usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, numTurns: 1, durationMs: 1 },
    tokensUsed: 2,
    activeMs: 3,
    permissionDenials: 0,
  }),
}

// Spec D8: container single mode is the dual runner with one engine and approvals off, posting as
// the role account. Regression caught: the container runtime falling through to the local
// single-engine runner, which would run Codex inside the orchestrator.
test('selectReviewRunner sends RUNTIME=container to the report-only remote runner', async t => {
  const posted: string[] = []
  const runner = selectReviewRunner(config, { gh: fakeGh(posted), engineDeps: remote, listChangedFiles: async () => ['src/a.ts'] })
  const out = await runner(request)
  t.deepEqual(posted, ['COMMENT'])
  t.equal(out.dual!.prs[0].outcome, 'clean')
  t.end()
})

// The orchestrator holds no engine credential: a container runner wired with an engine-auth
// resolver or a CodeArtifact refresh, or without the remote run functions, is refused at startup.
test('makeContainerReviewRunner refuses local engine wiring', t => {
  const base = { gh: fakeGh([]), engineDeps: remote, listChangedFiles: async () => [] }
  t.doesNotThrow(() => makeContainerReviewRunner(config, base))
  t.throws(() => makeContainerReviewRunner(config, { ...base, engineDeps: undefined }), /remote run functions/)
  t.throws(() => makeContainerReviewRunner(config, { ...base, engineAuth: async () => undefined }), /holds no engine credential/)
  t.throws(() => makeContainerReviewRunner(config, { ...base, refreshAuth: async () => {} }), /holds no engine credential/)
  t.throws(() => makeContainerReviewRunner(config, { ...base, listChangedFiles: undefined }), /listChangedFiles/)
  t.throws(() => makeContainerReviewRunner({ ...config, approverGhToken: '' }, { ...base, gh: undefined }), /APPROVER_GH_TOKEN/)
  t.end()
})

// DUAL_MODE_AVAILABLE stays false in both runtimes (Global Constraints).
test('container dual mode stays behind DUAL_MODE_AVAILABLE', t => {
  const dual = loadReviewConfig({ HOME: '/home/bot', RUNTIME: 'container', REVIEW_ENGINES: 'codex,claude', APPROVER_GH_TOKEN: 'a' })
  t.throws(() => makeContainerReviewRunner(dual, { gh: fakeGh([]), engineDeps: remote, listChangedFiles: async () => [] }), /REVIEW_ENGINES|dual/i)
  t.end()
})
```

Append to `src/github.test.ts`:

```ts
// Spec D8: in the container runtime the orchestrator has no gh login, so both the changed-file read
// and the human-gate comment go through the approver token, injected per call and never into
// process.env. Regression caught: the gate comment posted with an ambient (operator) login.
test('container runtime routes the job GitHub effects through the approver token', async t => {
  const calls: { args: string[]; token?: string }[] = []
  const run = async (args: string[], opts?: { env?: NodeJS.ProcessEnv }) => {
    calls.push({ args, token: opts?.env?.GH_TOKEN })
    return 'src/a.ts\n'
  }
  const effects = makeApproverGitHubEffects('approver-placeholder', run)
  const pr = { owner: 'o', repo: 'r', number: 1, url: 'https://github.com/o/r/pull/1' }
  t.deepEqual(await effects.listChangedFiles!(pr), ['src/a.ts'])
  t.equal(calls[0].token, 'approver-placeholder')
  t.equal(process.env.GH_TOKEN === 'approver-placeholder', false, 'never placed in process.env')
  const posted: string[] = []
  const approver = { postIssueComment: async (_pr: unknown, body: string) => void posted.push(body) } as never
  const job = makeJobGitHubEffects({ reviewEngines: ['claude'], runtime: 'container' }, approver, effects)
  await job.postPrComment!(pr, 'gate')
  t.deepEqual(posted, ['gate'])
  t.throws(() => makeJobGitHubEffects({ reviewEngines: ['claude'], runtime: 'container' }, undefined, effects), /role-account client/)
  t.end()
})
```

In the same file, replace:

```ts
import { defaultRunner, GH_COMMAND_TIMEOUT_MS, makeGitHubEffects, makeJobGitHubEffects } from './github'
```

with:

```ts
import { defaultRunner, GH_COMMAND_TIMEOUT_MS, makeApproverGitHubEffects, makeGitHubEffects, makeJobGitHubEffects } from './github'
```

Create `src/jobs/runtime.test.ts`:

```ts
import type { AddressInfo } from 'net'
import test from 'tape'
import { loadReviewConfig } from '../config'
import { startContainerRuntime } from './runtime'

const config = loadReviewConfig({ HOME: '/home/bot', RUNTIME: 'container', REVIEW_ENGINES: 'codex', APPROVER_GH_TOKEN: 'approver-placeholder', RUN_LOG_DIR: '' })

// The orchestrator's job server answers /healthz and exposes the broker as the child registry the
// shutdown path drains. Regression caught: a runtime whose registry is not the broker, so shutdown
// would exit with jobs still claimed.
test('startContainerRuntime serves /healthz and exposes the broker as the registry', async t => {
  const runtime = await startContainerRuntime(config, Buffer.alloc(32, 1), () => {}, { port: 0, host: '127.0.0.1' })
  const res = await fetch(`http://127.0.0.1:${runtime.port()}/healthz`)
  t.equal(res.status, 200)
  t.equal(runtime.registry.size(), 0)
  void runtime.runners.runCodex({ prompt: 'p', codexBin: '', profile: '', workspaceRoot: '', worktreeRoot: '/work/wt/codex', timeoutMs: 1000, disableGitSigning: true, runId: 'C1-11.codex' }).catch(() => {})
  t.equal(runtime.registry.size(), 1, 'a queued job is in flight')
  t.equal(runtime.registry.killAll('SIGKILL'), 1)
  await runtime.close()
  t.end()
})

// The smoke route exists only when asked for; a normal orchestrator answers 404 there.
test('startContainerRuntime exposes the smoke route only in smoke mode', async t => {
  const plain = await startContainerRuntime(config, Buffer.alloc(32, 1), () => {}, { port: 0, host: '127.0.0.1' })
  t.equal((await fetch(`http://127.0.0.1:${plain.port()}/v1/smoke/submit`, { method: 'POST' })).status, 404)
  await plain.close()
  const smoke = await startContainerRuntime(config, Buffer.alloc(32, 1), () => {}, { port: 0, host: '127.0.0.1', smoke: () => async () => ({ ok: 1 }) })
  const res = await fetch(`http://127.0.0.1:${smoke.port()}/v1/smoke/submit`, { method: 'POST' })
  t.deepEqual(await res.json(), { ok: 1 })
  await smoke.close()
  t.end()
})

// A wrong-sized key would make every ticket unverifiable, and a missing approver token means the
// orchestrator cannot post; both stop the orchestrator at startup.
test('startContainerRuntime refuses a bad launch key or a missing approver token', async t => {
  await startContainerRuntime(config, Buffer.alloc(16), () => {}, { port: 0 }).then(
    () => t.fail('started'),
    error => t.match(error.message, /LAUNCH_KEY/)
  )
  await startContainerRuntime({ ...config, approverGhToken: '' }, Buffer.alloc(32), () => {}, { port: 0 }).then(
    () => t.fail('started'),
    error => t.match(error.message, /APPROVER_GH_TOKEN/)
  )
  t.end()
})
```

Create `src/orchestrator.test.ts`:

```ts
import test from 'tape'
import { orchestratorConfig } from './orchestrator'

const key = Buffer.alloc(32, 9).toString('base64url')
const bundle = { SLACK_BOT_TOKEN: 'bot-placeholder', SLACK_APP_TOKEN: 'app-placeholder', APPROVER_GH_TOKEN: 'approver-placeholder', LAUNCH_KEY: key }

// Spec 3.6.1: the orchestrator keeps its secrets in its config object and never in its environment,
// so no later spawn (gh, git) inherits them. Regression caught: Object.assign(process.env, bundle).
test('orchestratorConfig reads the bundle without touching the environment', t => {
  const env: NodeJS.ProcessEnv = { HOME: '/home/bot', REVIEW_ENGINES: 'claude' }
  const before = JSON.stringify(env)
  const { config, launchKey } = orchestratorConfig(bundle, env)
  t.equal(JSON.stringify(env), before, 'env is unchanged')
  t.equal(config.runtime, 'container')
  t.equal(config.botToken, 'bot-placeholder')
  t.equal(config.approverGhToken, 'approver-placeholder')
  t.equal(launchKey.length, 32)
  t.end()
})

// The orchestrator never holds the engine token or engine AWS keys, even if the container env had
// them by mistake, and its engine auth is never bedrock (it runs no engine).
test('orchestratorConfig drops engine credentials from what config sees', t => {
  const env: NodeJS.ProcessEnv = {
    HOME: '/home/bot',
    ENGINE_GH_TOKEN: 'engine-placeholder',
    ENGINE_AUTH: 'bedrock',
    AWS_ACCESS_KEY_ID: 'id-placeholder',
    AWS_SECRET_ACCESS_KEY: 'secret-placeholder',
  }
  const { config } = orchestratorConfig(bundle, env)
  t.equal(config.engineGhToken, '')
  t.equal(config.engineAuth, 'subscription')
  t.equal(config.engineAwsStatic, undefined)
  t.end()
})

// A LAUNCH_KEY that is not 32 bytes of base64url cannot verify tickets; refuse rather than start.
test('orchestratorConfig rejects a malformed LAUNCH_KEY', t => {
  t.throws(() => orchestratorConfig({ ...bundle, LAUNCH_KEY: 'c2hvcnQ' }, { HOME: '/h' }), /LAUNCH_KEY/)
  t.end()
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx ts-node --compiler-options '{"module":"commonjs"}' --transpile-only src/review-container.test.ts`
Expected: FAIL with `makeContainerReviewRunner is not a function`.

- [ ] **Step 3: Add the approver GitHub effects**

In `src/github.ts`, replace:

```ts
export function makeJobGitHubEffects(
  config: Pick<ReviewConfig, 'reviewEngines'>,
  approver: ApproverGitHub | undefined,
  base: Pick<JobDeps, 'listChangedFiles' | 'postPrComment'> = makeGitHubEffects()
): Pick<JobDeps, 'listChangedFiles' | 'postPrComment'> {
  if (!isDualMode(config)) return base
```

with:

```ts
export function makeJobGitHubEffects(
  config: Pick<ReviewConfig, 'reviewEngines'> & Partial<Pick<ReviewConfig, 'runtime'>>,
  approver: ApproverGitHub | undefined,
  base: Pick<JobDeps, 'listChangedFiles' | 'postPrComment'> = makeGitHubEffects()
): Pick<JobDeps, 'listChangedFiles' | 'postPrComment'> {
  // The container runtime posts everything as the role account, in single mode too (spec D8).
  if (!isDualMode(config) && config.runtime !== 'container') return base
```

Then append to `src/github.ts`:

```ts
/**
 * The two gate effects authenticated as the role account: the approver token reaches each `gh` call
 * through that call's env only. The orchestrator container has no gh login (spec 3.2), so this is
 * how it lists changed files and posts the gate comment.
 */
export function makeApproverGitHubEffects(
  token: string,
  run: GhRunner = defaultRunner('gh')
): Pick<JobDeps, 'listChangedFiles' | 'postPrComment'> {
  return makeGitHubEffects('gh', (args, opts = {}) => run(args, { ...opts, env: { ...process.env, ...opts.env, GH_TOKEN: token } }))
}
```

- [ ] **Step 4: Add the container review runner**

In `src/review.ts`, replace:

```ts
): (request: ReviewRequest) => Promise<ReviewOutcome> {
  if (!isDualMode(config)) {
    return makeReviewRunner(config, deps.log, runCodexReview, deps.reviews, deps.registry, deps.refreshAuth, deps.engineAuth)
  }
```

with:

```ts
): (request: ReviewRequest) => Promise<ReviewOutcome> {
  if (config.runtime === 'container') return makeContainerReviewRunner(config, deps, available)
  if (!isDualMode(config)) {
    return makeReviewRunner(config, deps.log, runCodexReview, deps.reviews, deps.registry, deps.refreshAuth, deps.engineAuth)
  }
```

Then append to `src/review.ts`:

```ts
/**
 * The container runtime's runner (spec 3.2, D8): always the dual runner, whose engines run in worker
 * containers through the remote run functions. Single mode is one engine with approvals off; dual
 * mode stays behind DUAL_MODE_AVAILABLE. The orchestrator holds no engine credential, so engine auth
 * and the CodeArtifact refresh are refused rather than ignored.
 */
export function makeContainerReviewRunner(
  config: ReviewConfig,
  deps: RunnerDeps,
  available: boolean = DUAL_MODE_AVAILABLE
): (request: ReviewRequest) => Promise<ReviewOutcome> {
  assertModeAvailable(config, available)
  const runCodex = deps.engineDeps?.runCodex
  const runClaude = deps.engineDeps?.runClaude
  if (!runCodex || !runClaude) throw new Error('RUNTIME=container needs the remote run functions')
  if (deps.engineAuth || deps.refreshAuth) {
    throw new Error('RUNTIME=container: the orchestrator holds no engine credential; the launcher mints them for workers')
  }
  if (!deps.listChangedFiles) throw new Error('RUNTIME=container needs listChangedFiles through the approver token')
  if (!deps.gh && !config.approverGhToken) throw new Error('RUNTIME=container requires APPROVER_GH_TOKEN')
  const log = deps.log ?? (() => {})
  const engineDeps: EngineDeps = { runCodex, runClaude, log, registry: deps.registry }
  const makers = { codex: makeCodexEngine, claude: makeClaudeEngine }
  return makeDualReviewRunner({
    gh: deps.gh ?? makeApproverGitHub(config.approverGhToken),
    engines: config.engineOrder.map(name => makers[name](config, engineDeps)),
    schedule: config.engineSchedule,
    worktreeRoot: config.worktreeRoot,
    listChangedFiles: deps.listChangedFiles,
    runIdFor,
    log,
    reviews: deps.reviews,
    isShuttingDown: deps.isShuttingDown,
    approvals: isDualMode(config),
  })
}
```

- [ ] **Step 5: Create the container runtime**

Create `src/jobs/runtime.ts`:

```ts
// The orchestrator's job side (spec 3.2): the broker, its HTTP server on the internal network, the
// remote run functions, and the approver-token changed-file lister. The daemon plugs these in where
// the launchd runtime has local children.

import type { AddressInfo } from 'net'
import type { ChildRegistry } from '../codex'
import type { ReviewConfig } from '../config'
import { makeApproverGitHubEffects } from '../github'
import type { PullRequestRef } from '../parse-message'
import { createJobBroker, type JobBroker } from './broker'
import { ticketMaxAgeMs } from './protocol'
import { makeRemoteRunners, type RemoteRunners } from './remote'
import { startJobServer } from './server'
import { LAUNCH_KEY_BYTES } from './ticket'

export interface ContainerRuntime {
  broker: JobBroker
  /** The broker as a child registry: shutdown's SIGTERM cancels, SIGKILL abandons. */
  registry: ChildRegistry
  runners: RemoteRunners
  listChangedFiles(pr: PullRequestRef): Promise<string[]>
  port(): number
  close(): Promise<void>
}

export interface ContainerRuntimeOptions {
  port?: number
  host?: string
  /** SMOKE=1 only: build the canned job the smoke route runs. */
  smoke?: (runners: RemoteRunners) => () => Promise<unknown>
}

export async function startContainerRuntime(
  config: ReviewConfig,
  launchKey: Buffer,
  log: (event: string, fields: Record<string, unknown>) => void,
  options: ContainerRuntimeOptions = {}
): Promise<ContainerRuntime> {
  if (launchKey.length !== LAUNCH_KEY_BYTES) throw new Error(`LAUNCH_KEY must be ${LAUNCH_KEY_BYTES} bytes`)
  if (!config.approverGhToken) throw new Error('RUNTIME=container requires APPROVER_GH_TOKEN')
  const broker = createJobBroker({ launchKey, ticketMaxAgeMs: ticketMaxAgeMs(config.workerIdleExitMs), logDir: config.runLogDir, log })
  const runners = makeRemoteRunners(broker)
  const server = await startJobServer({
    broker,
    port: options.port ?? config.jobPort,
    // Inside the container; Compose publishes no port, and `jobs` is an internal network.
    host: options.host ?? '0.0.0.0',
    log,
    smoke: options.smoke?.(runners),
  })
  broker.start()
  log('jobs.listening', { port: (server.address() as AddressInfo).port })
  const effects = makeApproverGitHubEffects(config.approverGhToken)
  return {
    broker,
    registry: broker.asRegistry(),
    runners,
    listChangedFiles: pr => effects.listChangedFiles!(pr),
    port: () => (server.address() as AddressInfo).port,
    close: () =>
      new Promise<void>(resolve => {
        broker.stop()
        server.close(() => resolve())
        // A worker's open long-poll would otherwise hold close() for up to 25 s.
        server.closeAllConnections()
      }),
  }
}
```

- [ ] **Step 6: Split the daemon from its launchd entrypoint**

Run: `git mv src/app.ts src/daemon.ts`

In `src/daemon.ts`, replace:

```ts
// Daemon entry point. Connects to Slack over Socket Mode, watches for messages
// carrying GitHub PR URLs, and runs the Codex $review-pr skill against them.
```

with:

```ts
// The Slack daemon. Connects to Slack over Socket Mode, watches for messages carrying GitHub PR
// URLs, and reviews them. Started by src/app.ts (launchd) or src/orchestrator.ts (container), which
// load config first; this module has no side effects on import.
```

Replace:

```ts
import { assertModeAvailable, isDualMode, loadConfig, looksLikeUserId, scrubDaemonSecrets } from './config'
```

with:

```ts
import { assertModeAvailable, isDualMode, looksLikeUserId, type Config } from './config'
import type { ContainerRuntime } from './jobs/runtime'
```

Replace:

```ts
import { makeJobGitHubEffects } from './github'
```

with:

```ts
import { makeApproverGitHubEffects, makeJobGitHubEffects } from './github'
```

Replace:

```ts
function log(event: string, fields: Record<string, unknown> = {}): void {
```

with:

```ts
export function log(event: string, fields: Record<string, unknown> = {}): void {
```

Replace:

```ts
function installCrashHandlers(): void {
```

with:

```ts
export function installCrashHandlers(): void {
```

Replace:

```ts
async function main(): Promise<void> {
  installCrashHandlers()
  const config = loadConfig()
  // The tokens (and any static engine AWS keys) now live only in `config`; drop them from the
  // environment every later spawn inherits.
  scrubDaemonSecrets(process.env, config)
  assertModeAvailable(config)
```

with:

```ts
export interface DaemonOptions {
  /** Loaded by the entrypoint, which has already scrubbed the secrets from the environment. */
  config: Config
  /** RUNTIME=container: the job broker and remote runners; engines run in worker containers. */
  container?: ContainerRuntime
}

export async function runDaemon(options: DaemonOptions): Promise<void> {
  const { config, container } = options
  assertModeAvailable(config)
  if (config.runtime === 'container' && !container) {
    throw new Error('RUNTIME=container runs as dist/orchestrator.js under the launcher')
  }
```

Replace:

```ts
  // Tracks live `codex exec` children so shutdown can signal them instead of orphaning them.
  const childRegistry = createChildRegistry()
```

with:

```ts
  // Tracks live `codex exec` children so shutdown can signal them instead of orphaning them. In the
  // container runtime the "children" are jobs on the broker: SIGTERM cancels, SIGKILL abandons.
  const childRegistry = container ? container.registry : createChildRegistry()
```

Replace:

```ts
  const approverGh = isDualMode(config) ? makeApproverGitHub(config.approverGhToken) : undefined
  // One runner for either mode. The child registry is shared, so a shutdown drains both of a
  // parallel dual run's children.
  const runReview = selectReviewRunner(config, {
    log,
    reviews,
    registry: childRegistry,
    gh: approverGh,
    isShuttingDown: () => shutdown.forced,
    // ENGINE_AUTH=bedrock mints engine credentials per attempt; subscription mode resolves nothing.
    engineAuth: makeEngineAuth(config),
    refreshAuth: () =>
      ensureRegistryAuth({
        scriptPath: config.codeartifactLoginScript,
        enabled: config.codeartifactRefreshEnabled,
        log,
      }),
  })
```

with:

```ts
  // The container runtime posts as the role account in single mode too (spec D8).
  const approverGh = isDualMode(config) || container ? makeApproverGitHub(config.approverGhToken) : undefined
  // One runner for either mode. The child registry is shared, so a shutdown drains both of a
  // parallel dual run's children.
  const runReview = selectReviewRunner(config, {
    log,
    reviews,
    registry: childRegistry,
    gh: approverGh,
    isShuttingDown: () => shutdown.forced,
    ...(container
      ? // The engines run in workers; the orchestrator holds no engine credential.
        { engineDeps: container.runners, listChangedFiles: container.listChangedFiles }
      : {
          // ENGINE_AUTH=bedrock mints engine credentials per attempt; subscription mode resolves nothing.
          engineAuth: makeEngineAuth(config),
          refreshAuth: () =>
            ensureRegistryAuth({
              scriptPath: config.codeartifactLoginScript,
              enabled: config.codeartifactRefreshEnabled,
              log,
            }),
        }),
  })
```

Replace:

```ts
              dual: isDualMode(config)
```

with:

```ts
              dual: isDualMode(config) || container
```

Replace:

```ts
      ...makeJobGitHubEffects(config, approverGh),
```

with:

```ts
      ...makeJobGitHubEffects(config, approverGh, container ? makeApproverGitHubEffects(config.approverGhToken) : undefined),
```

Replace:

```ts
        await socketStopped
        process.exit(0)
```

with:

```ts
        await socketStopped
        // Every job has settled or been abandoned; stop answering workers.
        await container?.close()
        process.exit(0)
```

Replace:

```ts
main().catch(error => {
  log('bot.fatal', { error: String(error) })
  process.exit(1)
})
```

with nothing (delete those four lines, so importing `src/daemon.ts` starts nothing).

Create `src/app.ts`:

```ts
// launchd entry point (dist/app.js): load config from the environment, drop the secrets from the
// environment, and run the daemon. The container runtime starts from src/orchestrator.ts instead.

import { loadConfig, scrubDaemonSecrets } from './config'
import { installCrashHandlers, log, runDaemon } from './daemon'

async function main(): Promise<void> {
  installCrashHandlers()
  const config = loadConfig()
  // The tokens (and any static engine AWS keys) now live only in `config`; drop them from the
  // environment every later spawn inherits.
  scrubDaemonSecrets(process.env, config)
  if (config.runtime === 'container') {
    throw new Error('RUNTIME=container runs as dist/orchestrator.js under the launcher, not dist/app.js')
  }
  await runDaemon({ config })
}

main().catch(error => {
  log('bot.fatal', { error: String(error) })
  process.exit(1)
})
```

- [ ] **Step 7: Create the orchestrator entrypoint**

Create `src/orchestrator.ts` (a library with no side effects; Task 11's doctor imports it):

```ts
// The orchestrator's configuration from the launcher's secret bundle. The values go into the
// config object only, never the process environment (spec 3.6.1).

import { loadConfig, type Config } from './config'
import { LAUNCH_KEY_BYTES } from './jobs/ticket'

/** Variables the orchestrator must never see as config input, even if the container env had them. */
const ENGINE_ONLY_VARS = ['ENGINE_GH_TOKEN', 'ENGINE_AUTH', 'ENGINE_ROLE_ARN', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN']

/** Build config from a merged copy of the env and the bundle. `env` itself is never modified. */
export function orchestratorConfig(bundle: Record<string, string>, env: NodeJS.ProcessEnv): { config: Config; launchKey: Buffer } {
  const merged: NodeJS.ProcessEnv = { ...env }
  for (const name of ENGINE_ONLY_VARS) delete merged[name]
  merged.RUNTIME = 'container'
  merged.SLACK_BOT_TOKEN = bundle.SLACK_BOT_TOKEN
  merged.SLACK_APP_TOKEN = bundle.SLACK_APP_TOKEN
  merged.APPROVER_GH_TOKEN = bundle.APPROVER_GH_TOKEN
  const launchKey = Buffer.from(bundle.LAUNCH_KEY ?? '', 'base64url')
  if (launchKey.length !== LAUNCH_KEY_BYTES) throw new Error(`LAUNCH_KEY must be ${LAUNCH_KEY_BYTES} bytes of base64url`)
  return { config: loadConfig(merged), launchKey }
}
```

Create `src/orchestrator-main.ts` (the entrypoint, bundled as `dist/orchestrator.js`; never imported):

```ts
// Container entrypoint for the orchestrator. Reads the launcher's one-line secret bundle from stdin,
// keeps the values in its config object (never its environment), starts the job server and runs
// the daemon. It never runs PR code.

import { installCrashHandlers, log, runDaemon } from './daemon'
import { startContainerRuntime } from './jobs/runtime'
import { orchestratorConfig } from './orchestrator'
import { redactSecrets, registerHeldSecret } from './redact'
import { ORCHESTRATOR_BUNDLE, readSecretBundle } from './secret-bundle'

async function main(): Promise<void> {
  installCrashHandlers()
  const bundle = await readSecretBundle(process.stdin, ORCHESTRATOR_BUNDLE)
  for (const value of Object.values(bundle)) registerHeldSecret(value)
  const { config, launchKey } = orchestratorConfig(bundle, process.env)
  const container = await startContainerRuntime(config, launchKey, log)
  await runDaemon({ config, container })
}

main().catch(error => {
  log('bot.fatal', { error: redactSecrets(String(error)) })
  process.exit(1)
})
```

- [ ] **Step 8: Refuse the container runtime in the CLI**

In `src/cli.ts`, replace:

```ts
  const config = loadReviewConfig()
  scrubDaemonSecrets(process.env, config)
  try {
    assertModeAvailable(config)
```

with:

```ts
  const config = loadReviewConfig()
  scrubDaemonSecrets(process.env, config)
  if (config.runtime === 'container') {
    // The CLI runs engines locally; the container runtime runs them only in worker containers.
    process.stderr.write('RUNTIME=container is for the orchestrator; unset RUNTIME to review from the terminal\n')
    process.exitCode = 2
    return
  }
  try {
    assertModeAvailable(config)
```

- [ ] **Step 9: Bundle the orchestrator**

In `package.json`, replace:

```json
    "build": "esbuild app=src/app.ts worker=src/worker-main.ts --bundle --platform=node --target=node22 --format=cjs --outdir=dist --sourcemap",
```

with:

```json
    "build": "esbuild app=src/app.ts worker=src/worker-main.ts orchestrator=src/orchestrator-main.ts --bundle --platform=node --target=node22 --format=cjs --outdir=dist --sourcemap",
```

- [ ] **Step 10: Run the tests and the build**

Run: `for f in review-container github orchestrator jobs/runtime review; do npx ts-node --compiler-options '{"module":"commonjs"}' --transpile-only "src/${f}.test.ts" || exit 1; done`
Expected: PASS for all five files.

Run: `npm test && npm run typecheck && npm run build && ls dist/app.js dist/worker.js dist/orchestrator.js`
Expected: every suite passes; typecheck exit 0; three bundles listed.

Run: `test ! -f dist/daemon.js && echo 'daemon is not a separate bundle'`
Expected: `daemon is not a separate bundle` (it is inlined into `dist/app.js` and `dist/orchestrator.js`).

Run: `grep -c "runDaemon" dist/orchestrator.js`
Expected: a number greater than 0.

- [ ] **Step 11: Commit**

Write `/tmp/srb-commit-msg.txt`:

```text
feat(orchestrator): run the daemon with remote engines under RUNTIME=container (refs andrew-barnett/slack-review-bot#70)

The daemon moves to src/daemon.ts with no import side effects, so the
launchd entrypoint and the new orchestrator entrypoint share it. The
orchestrator reads its secrets from stdin into config only, serves jobs,
and posts every review as the role account.

[cc](https://claude.com/claude-code)
```

Run: `git add package.json src/app.ts src/daemon.ts src/orchestrator.ts src/orchestrator-main.ts src/orchestrator.test.ts src/jobs/runtime.ts src/jobs/runtime.test.ts src/review.ts src/review-container.test.ts src/github.ts src/github.test.ts src/cli.ts && git commit -F /tmp/srb-commit-msg.txt`

---

### Task 10: Container engine profiles (Claude and Codex)

**Files:**
- Create: `claude/review-bot.settings.container.json.template`, `codex/review-bot.config.container.toml`
- Modify: `scripts/claude-profile-lib.js`, `scripts/check-claude-profile.js`, `scripts/install-claude-profile.sh`, `scripts/install-codex-profile.sh`
- Test: `src/claude-profile.test.ts` (append), `src/codex-profile.test.ts` (create)

**Interfaces:**
- Consumes: the existing profile installers and checker.
- Produces:
  - `claude-profile-lib.js`: `expectedSettings({ ..., mode?: 'host' | 'container', npmrc?: string })`, `inContainer(root?: string): boolean` (root defaults to `CONTAINER_PROBE_ROOT` or `/`), `parseFlags(argv: string[]): { container: boolean; build: boolean; npmrc?: string; positional: string[] }`.
  - `check-claude-profile.js [--container [--build]] [--npmrc FILE] <6 positional>`.
  - `install-claude-profile.sh ... [--container] [--npmrc FILE] [--build]` (`--npmrc` defaults to `${HOME}/.npmrc-worker` in container mode).
  - `install-codex-profile.sh [--name N] [--check] [--container] [--build]`.
  - Both container checks fail outside a container unless `--build` (ruling 14); both host checks reject a container profile.

- [ ] **Step 1: Write the failing tests**

Append to `src/claude-profile.test.ts`:

```ts
// --- Container profile (spec D4, ruling 14) ---

/** A fake filesystem root for the container probe: with or without /.dockerenv. */
function probeRoot(inside: boolean): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-root-'))
  fs.mkdirSync(path.join(root, 'proc', '1'), { recursive: true })
  fs.writeFileSync(path.join(root, 'proc', '1', 'cgroup'), '0::/\n')
  if (inside) fs.writeFileSync(path.join(root, '.dockerenv'), '')
  return root
}

/** The installer with the container flags and a chosen probe root. */
function containerRun(home: string, dir: string, extra: string[], inside: boolean) {
  const skill = path.join(home, 'skills-src', 'review-pr')
  const hook = path.join(home, 'hooks-src', 'block-secret-reads.py')
  const args = [
    '--dir', dir,
    '--workspace-root', path.join(home, 'src'),
    '--worktree-root', path.join(home, 'wt'),
    '--skill-src', skill,
    '--hook-src', hook,
    '--env-file', path.join(home, 'daemon-config', 'env'),
    '--gh-config-dir', path.join(home, 'gh-config'),
    '--container',
    ...extra,
  ]
  return spawnSync(SCRIPT, args, {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: home, CONTAINER_PROBE_ROOT: probeRoot(inside) },
  })
}

// The container is the sandbox boundary (spec D4): sandbox off, but both read-deny layers stay, and
// the worker's npmrc is denied too. Regression caught: a container profile that drops the deny rules
// along with the sandbox.
test('install-claude-profile --container writes sandbox off with every deny rule kept', t => {
  const { home, dir } = sandboxHome()
  const out = containerRun(home, dir, [], true)
  t.equal(out.status, 0, out.stderr)
  const s = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'))
  t.deepEqual(s.sandbox, { enabled: false })
  t.equal(s.permissions.defaultMode, 'dontAsk')
  const npmrc = path.join(home, '.npmrc-worker')
  for (const d of [path.join(home, 'gh-config'), npmrc, path.join(home, '.aws')]) {
    t.ok(s.permissions.deny.includes(`Read(/${d}/**)`), `Read denied on ${d}`)
  }
  t.ok(s.permissions.deny.includes(`Edit(/${dir}/**)`), 'the profile dir stays unwritable')
  t.equal(s.hooks.PreToolUse[0].hooks[0].command, `python3 "${dir}/hooks/block-secret-reads.py"`)
  t.match(out.stdout, /looks correct/)
  t.end()
})

// A sandbox-off profile must never be installed on the laptop, where it would run PR code with the
// operator's whole filesystem in reach. Regression caught: the container profile passing --check
// on the host.
test('check-claude-profile --container fails outside a container unless --build', t => {
  const { home, dir } = sandboxHome()
  t.equal(containerRun(home, dir, [], true).status, 0)
  const outside = containerRun(home, dir, ['--check'], false)
  t.equal(outside.status, 1)
  t.match(outside.stderr, /only be installed inside a container/)
  t.equal(containerRun(home, dir, ['--check', '--build'], false).status, 0, 'docker build has no /.dockerenv')
  t.end()
})

// The host check must reject a container rendering: sandbox off is only safe inside the container.
test('check-claude-profile (host) rejects a container profile', t => {
  const { home, dir, run } = sandboxHome()
  t.equal(containerRun(home, dir, [], true).status, 0)
  const out = run(['--check'])
  t.equal(out.status, 1)
  t.match(out.stderr, /sandbox\.enabled is not true/)
  t.end()
})

// The container check is by value too: a sandbox block other than exactly {enabled:false} (for
// example one re-enabling network rules nobody enforces) is rejected.
test('check-claude-profile --container rejects any other sandbox block', t => {
  const { home, dir } = sandboxHome()
  t.equal(containerRun(home, dir, [], true).status, 0)
  const file = path.join(dir, 'settings.json')
  const s = JSON.parse(fs.readFileSync(file, 'utf8'))
  s.sandbox = { enabled: false, excludedCommands: ['curl'] }
  fs.writeFileSync(file, JSON.stringify(s))
  const out = containerRun(home, dir, ['--check'], true)
  t.equal(out.status, 1)
  t.match(out.stderr, /sandbox must be exactly/)
  t.end()
})
```

Create `src/codex-profile.test.ts`:

```ts
import { spawnSync } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import test from 'tape'

const SCRIPT = path.join(__dirname, '..', 'scripts', 'install-codex-profile.sh')

function setup(inside: boolean) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codex-profile-test-')))
  const probe = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-root-'))
  if (inside) fs.writeFileSync(path.join(probe, '.dockerenv'), '')
  const codexHome = path.join(home, '.codex')
  const run = (args: string[]) =>
    spawnSync(SCRIPT, args, { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: home, CODEX_HOME: codexHome, CONTAINER_PROBE_ROOT: probe } })
  return { file: path.join(codexHome, 'review-bot.config.toml'), run }
}

// Spec D4: in the container Codex runs with danger-full-access, and model-generated shell commands
// must not see the engine's AWS session (exclude AWS_*). Regression caught: a container profile that
// hands the Bedrock credentials to every command the model runs.
test('install-codex-profile --container writes full access with AWS_* excluded', t => {
  const { file, run } = setup(true)
  const out = run(['--container'])
  t.equal(out.status, 0, out.stderr)
  const text = fs.readFileSync(file, 'utf8')
  t.match(text, /^sandbox_mode = "danger-full-access"$/m)
  t.match(text, /^exclude = \["AWS_\*"\]$/m)
  t.notOk(/writable_roots/.test(text), 'no writable_roots under full access')
  t.end()
})

// The container check fails outside a container (except during docker build), and a container
// profile missing the AWS_* exclusion is rejected.
test('install-codex-profile --container --check guards the environment and the exclusion', t => {
  const inside = setup(true)
  t.equal(inside.run(['--container']).status, 0)
  fs.writeFileSync(inside.file, fs.readFileSync(inside.file, 'utf8').replace('exclude = ["AWS_*"]', ''))
  const missing = inside.run(['--container', '--check'])
  t.equal(missing.status, 1)
  t.match(missing.stderr, /AWS_\*/)

  const outside = setup(false)
  t.equal(outside.run(['--container', '--build']).status, 0, 'docker build has no /.dockerenv')
  const check = outside.run(['--container', '--check'])
  t.equal(check.status, 1)
  t.match(check.stderr, /only be installed inside a container/)
  t.end()
})

// The laptop profile must never be full access: a host --check on a container rendering fails.
test('install-codex-profile host check rejects danger-full-access', t => {
  const { file, run } = setup(true)
  t.equal(run(['--container']).status, 0)
  const out = run(['--check'])
  t.equal(out.status, 1)
  t.match(out.stderr, /danger-full-access/)
  t.ok(fs.existsSync(file))
  t.end()
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx ts-node --compiler-options '{"module":"commonjs"}' --transpile-only src/codex-profile.test.ts`
Expected: FAIL (`unknown argument: --container`, so the status is 2, not 0).

- [ ] **Step 3: Add the container templates**

Create `claude/review-bot.settings.container.json.template`:

```json
{
  "permissions": {
    "defaultMode": "dontAsk",
    "deny": [
      "__DENY_READ_RULES__",
      "__DENY_EDIT_RULES__",
      "Edit(/__WORKSPACE_ROOT__/**)"
    ]
  },
  "sandbox": {
    "enabled": false
  },
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "*",
        "hooks": [
          { "type": "command", "command": "python3 \"__PROFILE_DIR__/hooks/block-secret-reads.py\"" }
        ]
      }
    ]
  }
}
```

Create `codex/review-bot.config.container.toml`:

```toml
# Codex config profile for the review bot's WORKER CONTAINER. Installed by
# `scripts/install-codex-profile.sh --container` inside the image only; the host check rejects it.
#
# The container is the sandbox boundary (spec D4): bubblewrap cannot create namespaces in an
# unprivileged container, so Codex runs with full access inside it. The worker holds only a
# read-only GitHub token, a short-lived Bedrock-only AWS session and an npm read token.

approval_policy = "never"
sandbox_mode = "danger-full-access"

# Model-generated shell commands inherit the environment (gh, git, npm need it), except the AWS
# session, which only Codex itself needs to reach Bedrock.
[shell_environment_policy]
inherit = "all"
exclude = ["AWS_*"]

model = "gpt-5.5"
model_reasoning_effort = "high"
```

- [ ] **Step 4: Teach the Claude profile library the container mode**

In `scripts/claude-profile-lib.js`, replace:

```js
// CLI: node scripts/claude-profile-lib.js render <profile dir> <workspace root> <worktree root> <env dir> <gh dir> <home>
'use strict'
const fs = require('fs')
const path = require('path')

const TEMPLATE = path.join(__dirname, '..', 'claude', 'review-bot.settings.json.template')
```

with:

```js
// CLI: node scripts/claude-profile-lib.js render [--container] [--npmrc FILE] <profile dir> <workspace root> <worktree root> <env dir> <gh dir> <home>
'use strict'
const fs = require('fs')
const path = require('path')

// The container rendering turns the sandbox off (the container is the boundary, spec D4) and keeps
// every deny rule and the hook.
const TEMPLATES = {
  host: path.join(__dirname, '..', 'claude', 'review-bot.settings.json.template'),
  container: path.join(__dirname, '..', 'claude', 'review-bot.settings.container.json.template'),
}

/** True inside a Docker or Podman container. `root` is a test seam (CONTAINER_PROBE_ROOT). */
function inContainer(root = process.env.CONTAINER_PROBE_ROOT || '/') {
  if (fs.existsSync(path.join(root, '.dockerenv')) || fs.existsSync(path.join(root, 'run', '.containerenv'))) return true
  try {
    return /docker|containerd|kubepods|libpod/.test(fs.readFileSync(path.join(root, 'proc', '1', 'cgroup'), 'utf8'))
  } catch (error) {
    return false
  }
}

/** Split `--container`, `--build` and `--npmrc FILE` from the positional arguments. */
function parseFlags(argv) {
  const out = { container: false, build: false, npmrc: undefined, positional: [] }
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--container') out.container = true
    else if (argv[i] === '--build') out.build = true
    else if (argv[i] === '--npmrc') out.npmrc = argv[++i]
    else out.positional.push(argv[i])
  }
  return out
}
```

Replace:

```js
function denyDirs(envDir, ghDir, home) {
  const dirs = [envDir, ghDir, '.ssh', '.aws', '.npmrc', '.claude', '.codex', '.gnupg'].map((d, i) =>
    resolveDir(i < 2 ? d : path.join(home, d)),
  )
  return [...new Set(dirs)]
}
```

with:

```js
function denyDirs(envDir, ghDir, home, extra = []) {
  const dirs = [envDir, ghDir, '.ssh', '.aws', '.npmrc', '.claude', '.codex', '.gnupg'].map((d, i) =>
    resolveDir(i < 2 ? d : path.join(home, d)),
  )
  return [...new Set([...dirs, ...extra.map(resolveDir)])]
}
```

Replace:

```js
function expectedSettings({ profileDir, workspaceRoot, worktreeRoot, envDir, ghDir, home }) {
  const profile = resolveDir(profileDir)
  const deny = denyDirs(envDir, ghDir, home)
```

with:

```js
function expectedSettings({ profileDir, workspaceRoot, worktreeRoot, envDir, ghDir, home, mode = 'host', npmrc }) {
  if (!TEMPLATES[mode]) throw new Error(`unknown profile mode ${mode}`)
  const profile = resolveDir(profileDir)
  // The worker's npmrc names its registry token by reference only, but it is denied all the same.
  const deny = denyDirs(envDir, ghDir, home, npmrc ? [npmrc] : [])
```

Replace:

```js
  return walk(JSON.parse(fs.readFileSync(TEMPLATE, 'utf8')))
}

module.exports = { expectedSettings, resolveDir }

if (require.main === module) {
  const [cmd, profileDir, workspaceRoot, worktreeRoot, envDir, ghDir, home] = process.argv.slice(2)
  if (cmd !== 'render' || !home) {
    console.error('usage: claude-profile-lib.js render <profile dir> <workspace root> <worktree root> <env dir> <gh dir> <home>')
    process.exit(2)
  }
  try {
    process.stdout.write(JSON.stringify(expectedSettings({ profileDir, workspaceRoot, worktreeRoot, envDir, ghDir, home }), null, 2) + '\n')
```

with:

```js
  return walk(JSON.parse(fs.readFileSync(TEMPLATES[mode], 'utf8')))
}

module.exports = { expectedSettings, resolveDir, inContainer, parseFlags }

if (require.main === module) {
  const flags = parseFlags(process.argv.slice(2))
  const [cmd, profileDir, workspaceRoot, worktreeRoot, envDir, ghDir, home] = flags.positional
  if (cmd !== 'render' || !home) {
    console.error('usage: claude-profile-lib.js render [--container] [--npmrc FILE] <profile dir> <workspace root> <worktree root> <env dir> <gh dir> <home>')
    process.exit(2)
  }
  const mode = flags.container ? 'container' : 'host'
  try {
    const settings = expectedSettings({ profileDir, workspaceRoot, worktreeRoot, envDir, ghDir, home, mode, npmrc: flags.npmrc })
    process.stdout.write(JSON.stringify(settings, null, 2) + '\n')
```

- [ ] **Step 5: Teach the checker the container mode**

In `scripts/check-claude-profile.js`, replace:

```js
// Usage: node scripts/check-claude-profile.js <profile dir> <workspace root> <worktree root> <daemon env dir> <gh config dir> <home>
'use strict'
const fs = require('fs')
const path = require('path')
const { isDeepStrictEqual } = require('util')
const { expectedSettings } = require('./claude-profile-lib')

const [dir, workspaceRoot, worktreeRoot, envDir, ghDir, home] = process.argv.slice(2)
```

with:

```js
// Usage: node scripts/check-claude-profile.js [--container [--build]] [--npmrc FILE] <profile dir> <workspace root> <worktree root> <daemon env dir> <gh config dir> <home>
'use strict'
const fs = require('fs')
const path = require('path')
const { isDeepStrictEqual } = require('util')
const { expectedSettings, inContainer, parseFlags } = require('./claude-profile-lib')

const flags = parseFlags(process.argv.slice(2))
const mode = flags.container ? 'container' : 'host'
const [dir, workspaceRoot, worktreeRoot, envDir, ghDir, home] = flags.positional
```

Replace:

```js
  expected = expectedSettings({ profileDir: dir, workspaceRoot, worktreeRoot, envDir, ghDir, home })
```

with:

```js
  expected = expectedSettings({ profileDir: dir, workspaceRoot, worktreeRoot, envDir, ghDir, home, mode, npmrc: flags.npmrc })
```

Replace:

```js
if (sb.enabled !== true) problems.push('sandbox.enabled is not true')
if (sb.autoAllowBashIfSandboxed !== true) problems.push('sandbox.autoAllowBashIfSandboxed is not true')
if (sb.allowUnsandboxedCommands !== false) problems.push('sandbox.allowUnsandboxedCommands is not false')
if (sb.excludedCommands !== undefined) problems.push('sandbox.excludedCommands is set; excluded commands run outside the sandbox')
if (sbfs.allowRead !== undefined) problems.push('sandbox.filesystem.allowRead is set')
```

with:

```js
if (mode === 'container') {
  // The container is the boundary (spec D4). A sandbox-off profile is only ever valid inside one;
  // `--build` skips the probe because `docker build` steps have no /.dockerenv (ruling 14).
  if (!isDeepStrictEqual(s.sandbox, { enabled: false })) problems.push('sandbox must be exactly {"enabled": false} in the container profile')
  if (!flags.build && !inContainer()) problems.push('the container profile turns the sandbox off, so it may only be installed inside a container')
} else {
  if (sb.enabled !== true) problems.push('sandbox.enabled is not true')
  if (sb.autoAllowBashIfSandboxed !== true) problems.push('sandbox.autoAllowBashIfSandboxed is not true')
  if (sb.allowUnsandboxedCommands !== false) problems.push('sandbox.allowUnsandboxedCommands is not false')
  if (sb.excludedCommands !== undefined) problems.push('sandbox.excludedCommands is set; excluded commands run outside the sandbox')
  if (sbfs.allowRead !== undefined) problems.push('sandbox.filesystem.allowRead is set')
  if (!sameSet(sbfs.denyRead, expected.sandbox.filesystem.denyRead)) {
    problems.push(`sandbox.filesystem.denyRead is not exactly ${JSON.stringify(expected.sandbox.filesystem.denyRead)}`)
  }
  if (!sameSet(sbfs.allowWrite, expected.sandbox.filesystem.allowWrite)) {
    problems.push(`sandbox.filesystem.allowWrite is not exactly ${JSON.stringify(expected.sandbox.filesystem.allowWrite)}`)
  }
}
```

Replace:

```js
if (perms.defaultMode !== 'dontAsk') problems.push('permissions.defaultMode is not dontAsk')
if (!sameSet(sbfs.denyRead, expected.sandbox.filesystem.denyRead)) {
  problems.push(`sandbox.filesystem.denyRead is not exactly ${JSON.stringify(expected.sandbox.filesystem.denyRead)}`)
}
if (!sameSet(sbfs.allowWrite, expected.sandbox.filesystem.allowWrite)) {
  problems.push(`sandbox.filesystem.allowWrite is not exactly ${JSON.stringify(expected.sandbox.filesystem.allowWrite)}`)
}
```

with:

```js
if (perms.defaultMode !== 'dontAsk') problems.push('permissions.defaultMode is not dontAsk')
```

Replace:

```js
console.log(`profile ${dir} looks correct (sandbox on, secret dirs read-denied in both layers, writes pinned, hook and skill present)`)
```

with:

```js
console.log(
  mode === 'container'
    ? `profile ${dir} looks correct (container: sandbox off inside the container boundary, secret paths read-denied, hook and skill present)`
    : `profile ${dir} looks correct (sandbox on, secret dirs read-denied in both layers, writes pinned, hook and skill present)`,
)
```

- [ ] **Step 6: Teach the Claude installer the container flags**

In `scripts/install-claude-profile.sh`, replace:

```bash
#          [--skill-src DIR] [--hook-src FILE] [--env-file FILE] [--gh-config-dir DIR] [--check]
```

with:

```bash
#          [--skill-src DIR] [--hook-src FILE] [--env-file FILE] [--gh-config-dir DIR] [--check]
#          [--container [--npmrc FILE] [--build]]
#
# --container renders the worker-container profile (sandbox off, every deny rule kept) and refuses
# to verify outside a container; --build skips only that probe, for `docker build` steps.
```

Replace:

```bash
GH_DIR="${GH_CONFIG_DIR:-${HOME}/.config/gh}"
CHECK_ONLY=0
```

with:

```bash
GH_DIR="${GH_CONFIG_DIR:-${HOME}/.config/gh}"
CHECK_ONLY=0
CONTAINER=0
BUILD=0
NPMRC_FILE="${HOME}/.npmrc-worker"
```

Replace:

```bash
        --check)
            CHECK_ONLY=1
            shift
            ;;
        -h | --help)
            sed -n '2,12p' "$0"
```

with:

```bash
        --check)
            CHECK_ONLY=1
            shift
            ;;
        --container)
            CONTAINER=1
            shift
            ;;
        --build)
            BUILD=1
            shift
            ;;
        --npmrc)
            NPMRC_FILE="$2"
            shift 2
            ;;
        -h | --help)
            sed -n '2,16p' "$0"
```

Replace:

```bash
ENV_DIR="$(require_abs_dir "--env-file's directory" "$(dirname "${DAEMON_ENV_FILE}")")"
```

with:

```bash
ENV_DIR="$(require_abs_dir "--env-file's directory" "$(dirname "${DAEMON_ENV_FILE}")")"
# Mode flags for the renderer and the checker. The `${A[@]+...}` form keeps an empty array safe
# under `set -u` on macOS's bash 3.2.
MODE_ARGS=()
if [ "${CONTAINER}" -eq 1 ]; then
    NPMRC_FILE="$(require_abs_dir --npmrc "${NPMRC_FILE}")"
    MODE_ARGS+=(--container --npmrc "${NPMRC_FILE}")
fi
CHECK_ARGS=(${MODE_ARGS[@]+"${MODE_ARGS[@]}"})
if [ "${BUILD}" -eq 1 ]; then
    CHECK_ARGS+=(--build)
fi
```

Replace:

```bash
    SETTINGS_JSON="$(node "${REPO}/scripts/claude-profile-lib.js" render "${PROFILE_DIR}" "${WORKSPACE_ROOT_ARG}" \
        "${WORKTREE_ROOT_ARG}" "${ENV_DIR}" "${GH_DIR}" "${HOME}")"
```

with:

```bash
    SETTINGS_JSON="$(node "${REPO}/scripts/claude-profile-lib.js" render ${MODE_ARGS[@]+"${MODE_ARGS[@]}"} "${PROFILE_DIR}" \
        "${WORKSPACE_ROOT_ARG}" "${WORKTREE_ROOT_ARG}" "${ENV_DIR}" "${GH_DIR}" "${HOME}")"
```

Replace:

```bash
node "${REPO}/scripts/check-claude-profile.js" "${PROFILE_DIR}" "${WORKSPACE_ROOT_ARG}" "${WORKTREE_ROOT_ARG}" \
    "${ENV_DIR}" "${GH_DIR}" "${HOME}"
```

with:

```bash
node "${REPO}/scripts/check-claude-profile.js" ${CHECK_ARGS[@]+"${CHECK_ARGS[@]}"} "${PROFILE_DIR}" "${WORKSPACE_ROOT_ARG}" \
    "${WORKTREE_ROOT_ARG}" "${ENV_DIR}" "${GH_DIR}" "${HOME}"
```

- [ ] **Step 7: Teach the Codex installer the container flags**

In `scripts/install-codex-profile.sh`, replace:

```bash
# Usage: scripts/install-codex-profile.sh [--name review-bot] [--check]
```

with:

```bash
# Usage: scripts/install-codex-profile.sh [--name review-bot] [--check] [--container [--build]]
#
# --container installs the worker-container profile (danger-full-access, AWS_* excluded from model
# shell commands) and refuses to verify outside a container; --build skips only that probe.
```

Replace:

```bash
NAME="review-bot"
CHECK_ONLY=0
```

with:

```bash
NAME="review-bot"
CHECK_ONLY=0
CONTAINER=0
BUILD=0
```

Replace:

```bash
        --check)
            CHECK_ONLY=1
            shift
            ;;
        -h | --help)
            sed -n '2,9p' "$0"
```

with:

```bash
        --check)
            CHECK_ONLY=1
            shift
            ;;
        --container)
            CONTAINER=1
            shift
            ;;
        --build)
            BUILD=1
            shift
            ;;
        -h | --help)
            sed -n '2,12p' "$0"
```

Replace:

```bash
TEMPLATE="${DIR}/codex/review-bot.config.toml.template"
TARGET="${CODEX_HOME}/${NAME}.config.toml"
```

with:

```bash
TEMPLATE="${DIR}/codex/review-bot.config.toml.template"
if [ "${CONTAINER}" -eq 1 ]; then
    TEMPLATE="${DIR}/codex/review-bot.config.container.toml"
fi
TARGET="${CODEX_HOME}/${NAME}.config.toml"

# Same probe as scripts/claude-profile-lib.js; CONTAINER_PROBE_ROOT is a test seam.
in_container() {
    local root="${CONTAINER_PROBE_ROOT:-/}"
    [ -e "${root%/}/.dockerenv" ] || [ -e "${root%/}/run/.containerenv" ] ||
        grep -qE 'docker|containerd|kubepods|libpod' "${root%/}/proc/1/cgroup" 2> /dev/null
}
```

Replace:

```bash
if ! grep -qE '^\s*network_access\s*=\s*true' "${TARGET}"; then
    echo "ERROR: ${TARGET} does not set network_access = true" >&2
    fail=1
fi
```

with:

```bash
if [ "${CONTAINER}" -eq 1 ]; then
    if ! grep -qE '^\s*sandbox_mode\s*=\s*"danger-full-access"' "${TARGET}"; then
        echo "ERROR: ${TARGET} does not set sandbox_mode = \"danger-full-access\" (the container is the boundary)" >&2
        fail=1
    fi
    if ! grep -qE '^\s*inherit\s*=\s*"all"' "${TARGET}"; then
        echo "ERROR: ${TARGET} does not set shell_environment_policy.inherit = \"all\"" >&2
        fail=1
    fi
    if ! grep -qE '^\s*exclude\s*=\s*\[\s*"AWS_\*"\s*\]' "${TARGET}"; then
        echo "ERROR: ${TARGET} does not exclude AWS_* from model shell commands" >&2
        fail=1
    fi
    if grep -qE '^\s*writable_roots' "${TARGET}"; then
        echo "ERROR: ${TARGET} sets writable_roots, which has no meaning under full access" >&2
        fail=1
    fi
    if [ "${BUILD}" -eq 0 ] && ! in_container; then
        echo "ERROR: the container profile is full access, so it may only be installed inside a container" >&2
        fail=1
    fi
else
    if ! grep -qE '^\s*network_access\s*=\s*true' "${TARGET}"; then
        echo "ERROR: ${TARGET} does not set network_access = true" >&2
        fail=1
    fi
    if grep -qE 'danger-full-access' "${TARGET}"; then
        echo "ERROR: ${TARGET} sets danger-full-access; the laptop profile must stay sandboxed" >&2
        fail=1
    fi
fi
```

Replace:

```bash
echo "profile '${NAME}' looks correct (approvals off, sandbox network on)"
```

with:

```bash
if [ "${CONTAINER}" -eq 1 ]; then
    echo "profile '${NAME}' looks correct (container: approvals off, full access inside the container, AWS_* excluded)"
else
    echo "profile '${NAME}' looks correct (approvals off, sandbox network on)"
fi
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `npx ts-node --compiler-options '{"module":"commonjs"}' --transpile-only src/codex-profile.test.ts && npx ts-node --compiler-options '{"module":"commonjs"}' --transpile-only src/claude-profile.test.ts`
Expected: PASS for both files, every existing host-profile test included.

Run: `scripts/install-codex-profile.sh --check`
Expected: exit 0 on the operator's laptop if the host profile was installed before; the host check is otherwise unchanged apart from rejecting full access.

- [ ] **Step 9: Commit**

Write `/tmp/srb-commit-msg.txt`:

```text
feat(profiles): add container engine profiles with the container as the boundary (refs andrew-barnett/slack-review-bot#70)

Inside the worker the sandbox cannot create namespaces, so Claude runs
with its sandbox off and Codex with full access, keeping every deny rule,
the hook, and an AWS_* exclusion for model shell commands. Both checks
refuse the container profile outside a container.

[cc](https://claude.com/claude-code)
```

Run: `git add claude/review-bot.settings.container.json.template codex/review-bot.config.container.toml scripts/claude-profile-lib.js scripts/check-claude-profile.js scripts/install-claude-profile.sh scripts/install-codex-profile.sh src/claude-profile.test.ts src/codex-profile.test.ts && git commit -F /tmp/srb-commit-msg.txt`

---

### Task 11: Container doctor (`--role orchestrator|worker`)

**Files:**
- Create: `src/container.ts`, `src/doctor-container.ts`
- Modify: `src/doctor.ts`, `package.json`
- Test: `src/doctor-container.test.ts`

**Interfaces:**
- Consumes: `CheckResult`, `CommandRunner`, `run`, `summarise`, `checkClaudeProfile`, `checkCodexProfile` (doctor.ts); `ghEnvAs`, `lookupLogin`, `LoginLookup` (doctor-dual.ts); Task 5 bundles; Task 7 `assertWorkerConfig`; Task 9 `orchestratorConfig`.
- Produces:
  - `inContainer(root?: string): boolean` (src/container.ts).
  - `interface ContainerProbe { env: NodeJS.ProcessEnv; exists(p: string): boolean; readFile(p: string): string | undefined; runCommand: CommandRunner; lookupLogin(token: string): Promise<LoginLookup> }`
  - `checkDaemonSecretsAbsent(probe)`, `checkGhLoggedOut(probe)`, `checkEngineRole(probe, awsEnv)`, `checkSecretsDenied(probe, awsEnv, region)`, `checkPidNamespace(probe)`, `checkNoDockerSocket(probe)`, `checkTokenIdentity(probe, label, token)`, `engineAwsEnv(base, creds, region)`, `parseDoctorRole(argv): 'orchestrator' | 'worker' | undefined`.
  - `doctor.ts`: `checkClaudeProfile(config, runCommand?, extraArgs?)`, `checkCodexProfile(config, runCommand?, extraArgs?)`; `npm run build` emits `dist/doctor.js`.

- [ ] **Step 1: Write the failing tests**

Create `src/doctor-container.test.ts`:

```ts
import test from 'tape'
import {
  checkDaemonSecretsAbsent,
  checkEngineRole,
  checkGhLoggedOut,
  checkNoDockerSocket,
  checkPidNamespace,
  checkSecretsDenied,
  checkTokenIdentity,
  engineAwsEnv,
  parseDoctorRole,
  type ContainerProbe,
} from './doctor-container'

type Reply = { code: number; output: string }

/** A clean worker: every probe answers as the spec's acceptance criteria want. */
function probe(over: Partial<ContainerProbe> = {}, replies: Record<string, Reply> = {}): ContainerProbe & { calls: string[] } {
  const calls: string[] = []
  const defaults: Record<string, Reply> = {
    grep: { code: 1, output: '' },
    'gh auth': { code: 1, output: 'You are not logged into any GitHub hosts.' },
    'aws sts': { code: 0, output: '{"Arn":"arn:aws:sts::153538148884:assumed-role/SlackReviewBotEngineRole/slack-review-bot-worker"}' },
    'aws secretsmanager': { code: 254, output: 'An error occurred (AccessDeniedException) when calling the DescribeSecret operation' },
  }
  return {
    calls,
    env: { HOME: '/home/bot', ROLE_GH_LOGIN: 'role-bot', OPERATOR_GH_LOGIN: 'operator' },
    exists: () => false,
    readFile: p => (p === '/proc/1/cmdline' ? '/usr/bin/tini\0--\0srb-entrypoint' : undefined),
    runCommand: async (command, args) => {
      const key = `${command} ${args[0]}`
      calls.push(`${key} ${args.slice(1).join(' ')}`)
      return replies[key] ?? replies[command] ?? defaults[key] ?? defaults[command] ?? { code: 0, output: '' }
    },
    lookupLogin: async () => ({ login: 'role-bot' }),
    ...over,
  }
}

const status = (r: { status: string }) => r.status

// Spec 3.7, first criterion: no daemon secret in the worker's env or files, and no /run/secrets.
// Each injected condition must fail the check. Regression caught: an approver or Slack token
// reaching the container that runs PR code.
test('checkDaemonSecretsAbsent fails on an env name, a file hit, or /run/secrets', async t => {
  t.equal(status(await checkDaemonSecretsAbsent(probe())), 'ok')
  t.equal(status(await checkDaemonSecretsAbsent(probe({ env: { SLACK_BOT_TOKEN: 'x' } }))), 'fail')
  t.equal(status(await checkDaemonSecretsAbsent(probe({ env: { LAUNCH_KEY: 'x' } }))), 'fail')
  t.equal(status(await checkDaemonSecretsAbsent(probe({ exists: p => p === '/run/secrets' }))), 'fail')
  const hit = await checkDaemonSecretsAbsent(probe({}, { grep: { code: 0, output: '/tmp/leak.txt\n' } }))
  t.equal(hit.status, 'fail')
  t.match(hit.detail, /\/tmp\/leak\.txt/)
  // A scan that could not run is unknown, never "clean".
  t.equal(status(await checkDaemonSecretsAbsent(probe({}, { grep: { code: 2, output: 'grep: error' } }))), 'fail')
  t.end()
})

// Spec 3.7: `gh auth status` with GH_TOKEN unset must report not logged in.
test('checkGhLoggedOut fails when gh has a stored login', async t => {
  const p = probe({ env: { GH_TOKEN: 'should-be-stripped' } })
  t.equal(status(await checkGhLoggedOut(p)), 'ok')
  t.equal(status(await checkGhLoggedOut(probe({}, { 'gh auth': { code: 0, output: 'Logged in to github.com' } }))), 'fail')
  t.end()
})

// Spec 3.7: the worker's AWS identity is the engine role and nothing else, and that role cannot
// read the bot's secrets.
test('checkEngineRole and checkSecretsDenied fail on the wrong identity or a readable secret', async t => {
  const env = engineAwsEnv({ PATH: '/usr/bin' }, { accessKeyId: 'a', secretAccessKey: 's', sessionToken: 't' }, 'us-east-2')
  t.equal(env.AWS_CONFIG_FILE, '/dev/null', 'no profile can override the engine session')
  t.equal(status(await checkEngineRole(probe(), env)), 'ok')
  const operator = probe({}, { 'aws sts': { code: 0, output: '{"Arn":"arn:aws:iam::153538148884:user/operator"}' } })
  t.equal(status(await checkEngineRole(operator, env)), 'fail')
  t.equal(status(await checkSecretsDenied(probe(), env, 'us-east-2')), 'ok')
  t.equal(status(await checkSecretsDenied(probe({}, { 'aws secretsmanager': { code: 0, output: '{"Name":"x"}' } }), env, 'us-east-2')), 'fail')
  const network = probe({}, { 'aws secretsmanager': { code: 255, output: 'Could not connect to the endpoint URL' } })
  t.equal(status(await checkSecretsDenied(network, env, 'us-east-2')), 'fail', 'a network error is not a denial')
  t.end()
})

// Spec 3.7: the worker sees only its own PID namespace (PID 1 is its init), and no Docker socket.
test('checkPidNamespace and checkNoDockerSocket fail on the host view', async t => {
  t.equal(status(checkPidNamespace(probe())), 'ok')
  t.equal(status(checkPidNamespace(probe({ readFile: () => '/sbin/launchd' }))), 'fail')
  t.equal(status(checkPidNamespace(probe({ readFile: () => undefined }))), 'fail')
  t.equal(status(checkNoDockerSocket(probe())), 'ok')
  t.equal(status(checkNoDockerSocket(probe({ exists: p => p === '/var/run/docker.sock' }))), 'fail')
  t.end()
})

// Ruling 8: each container checks its own token is the role account and not the operator.
test('checkTokenIdentity requires the role login and rejects the operator', async t => {
  t.equal(status(await checkTokenIdentity(probe(), 'engine token', 'tok')), 'ok')
  t.equal(status(await checkTokenIdentity(probe({ lookupLogin: async () => ({ login: 'operator' }) }), 'engine token', 'tok')), 'fail')
  t.equal(status(await checkTokenIdentity(probe({ lookupLogin: async () => ({ login: 'someone' }) }), 'engine token', 'tok')), 'fail')
  t.equal(status(await checkTokenIdentity(probe({ lookupLogin: async () => ({ error: 'HTTP 401' }) }), 'engine token', 'tok')), 'fail')
  t.equal(status(await checkTokenIdentity(probe({ env: {} }), 'engine token', 'tok')), 'fail', 'ROLE_GH_LOGIN unset')
  t.equal(status(await checkTokenIdentity(probe({ env: { ROLE_GH_LOGIN: 'operator', OPERATOR_GH_LOGIN: 'operator' } }), 'engine token', 'tok')), 'fail')
  t.end()
})

// --role is strict: an unknown role is an error, not a silent host doctor.
test('parseDoctorRole accepts only the two roles', t => {
  t.equal(parseDoctorRole([]), undefined)
  t.equal(parseDoctorRole(['--role', 'worker']), 'worker')
  t.equal(parseDoctorRole(['--role=orchestrator']), 'orchestrator')
  t.throws(() => parseDoctorRole(['--role', 'launcher']), /--role/)
  t.throws(() => parseDoctorRole(['--role']), /--role/)
  t.end()
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx ts-node --compiler-options '{"module":"commonjs"}' --transpile-only src/doctor-container.test.ts`
Expected: FAIL with `Cannot find module './doctor-container'`.

- [ ] **Step 3: Write the container probe**

Create `src/container.ts`:

```ts
// Container detection, the TypeScript twin of inContainer in scripts/claude-profile-lib.js.

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
```

- [ ] **Step 4: Write the container checks**

Create `src/doctor-container.ts`:

```ts
// The container doctor checks (spec 3.7). Pure over an injected probe, so each has a
// deliberate-failure test without a live container. The worker checks are the acceptance criteria
// of https://github.com/andrew-barnett/slack-review-bot/issues/64.

import type { AwsCredentials } from './bedrock-auth'
import { ghEnvAs, type LoginLookup } from './doctor-dual'
import type { CheckResult, CommandRunner } from './doctor'
import { redactSecrets } from './redact'

export interface ContainerProbe {
  env: NodeJS.ProcessEnv
  exists(p: string): boolean
  readFile(p: string): string | undefined
  runCommand: CommandRunner
  lookupLogin(token: string): Promise<LoginLookup>
}

/** Names that must never be visible in a worker: the daemon's tokens and the ticket key. */
export const DAEMON_ONLY_NAMES = ['APPROVER_GH_TOKEN', 'SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN', 'LAUNCH_KEY'] as const
/** The variable names, or a Slack token's shape, in any file under the scanned dirs. */
const LEAK_PATTERN = 'APPROVER_GH_TOKEN|SLACK_BOT_TOKEN|SLACK_APP_TOKEN|LAUNCH_KEY|xox[abpr]-[A-Za-z0-9-]{10,}|xapp-[0-9]-[A-Za-z0-9-]{10,}'
const SCAN_DIRS = ['/home/bot', '/tmp']
export const ENGINE_ROLE_NAME = 'SlackReviewBotEngineRole'
export const PROBE_SECRET_ID = '/slack-review-bot/SLACK_BOT_TOKEN'

const firstLine = (text: string) => redactSecrets(text.trim().split('\n')[0] ?? '').slice(0, 200)

/** --role orchestrator|worker; undefined when absent. */
export function parseDoctorRole(argv: string[]): 'orchestrator' | 'worker' | undefined {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const value = arg === '--role' ? argv[i + 1] : arg.startsWith('--role=') ? arg.slice('--role='.length) : undefined
    if (arg !== '--role' && value === undefined) continue
    if (value === 'orchestrator' || value === 'worker') return value
    throw new Error('--role must be "orchestrator" or "worker"')
  }
  return undefined
}

/**
 * The environment every worker `aws` probe runs with: the engine session only. No profile, config
 * or credentials file can substitute another identity.
 */
export function engineAwsEnv(base: NodeJS.ProcessEnv, creds: AwsCredentials, region: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { PATH: base.PATH, HOME: base.HOME }
  env.AWS_CONFIG_FILE = '/dev/null'
  env.AWS_SHARED_CREDENTIALS_FILE = '/dev/null'
  env.AWS_REGION = region
  env.AWS_ACCESS_KEY_ID = creds.accessKeyId
  env.AWS_SECRET_ACCESS_KEY = creds.secretAccessKey
  if (creds.sessionToken) env.AWS_SESSION_TOKEN = creds.sessionToken
  return env
}

export async function checkDaemonSecretsAbsent(probe: ContainerProbe): Promise<CheckResult> {
  const name = 'daemon secrets absent'
  const present = DAEMON_ONLY_NAMES.filter(n => probe.env[n] !== undefined)
  if (present.length) return { name, status: 'fail', detail: `set in the environment: ${present.join(', ')}` }
  if (probe.exists('/run/secrets')) return { name, status: 'fail', detail: '/run/secrets exists (Compose secrets are not used)' }
  // -r does not follow symlinks, so the linked skill and hook sources are not scanned; -l prints
  // file names only, never the matching text.
  const { code, output } = await probe.runCommand('grep', ['-rlE', LEAK_PATTERN, ...SCAN_DIRS])
  if (code === 1) return { name, status: 'ok', detail: `none in the environment, ${SCAN_DIRS.join(' or ')}; no /run/secrets` }
  if (code === 0) return { name, status: 'fail', detail: `found in: ${output.trim().split('\n').slice(0, 5).join(', ')}` }
  // A scan that could not run is unknown, never clean.
  return { name, status: 'fail', detail: `the file scan did not complete (exit ${code}): ${firstLine(output)}` }
}

export async function checkGhLoggedOut(probe: ContainerProbe): Promise<CheckResult> {
  const name = 'gh logged out'
  const { code, output } = await probe.runCommand('gh', ['auth', 'status'], ghEnvAs(probe.env))
  return code !== 0
    ? { name, status: 'ok', detail: 'gh has no stored login (tokens reach gh per call only)' }
    : { name, status: 'fail', detail: `gh has a stored login: ${firstLine(output)}` }
}

export async function checkEngineRole(probe: ContainerProbe, awsEnv: NodeJS.ProcessEnv): Promise<CheckResult> {
  const name = 'aws identity'
  const { code, output } = await probe.runCommand('aws', ['sts', 'get-caller-identity', '--output', 'json'], awsEnv)
  if (code !== 0) return { name, status: 'fail', detail: `sts get-caller-identity failed: ${firstLine(output)}` }
  let arn = ''
  try {
    arn = String((JSON.parse(output) as { Arn?: unknown }).Arn ?? '')
  } catch {
    return { name, status: 'fail', detail: 'sts get-caller-identity returned something that is not JSON' }
  }
  return arn.includes(`:assumed-role/${ENGINE_ROLE_NAME}/`)
    ? { name, status: 'ok', detail: arn }
    : { name, status: 'fail', detail: `expected assumed-role/${ENGINE_ROLE_NAME}/…, got ${arn || 'no ARN'}` }
}

export async function checkSecretsDenied(probe: ContainerProbe, awsEnv: NodeJS.ProcessEnv, region: string): Promise<CheckResult> {
  const name = 'secrets denied'
  // describe-secret returns metadata only, never a value; the engine role must not even get that.
  const { code, output } = await probe.runCommand('aws', ['secretsmanager', 'describe-secret', '--secret-id', PROBE_SECRET_ID, '--region', region], awsEnv)
  if (code === 0) return { name, status: 'fail', detail: `the engine role can describe ${PROBE_SECRET_ID}` }
  return /AccessDenied/.test(output)
    ? { name, status: 'ok', detail: `describe-secret ${PROBE_SECRET_ID} is denied` }
    : { name, status: 'fail', detail: `could not confirm a denial: ${firstLine(output)}` }
}

export function checkPidNamespace(probe: ContainerProbe): CheckResult {
  const name = 'pid namespace'
  const cmdline = probe.readFile('/proc/1/cmdline')
  if (cmdline === undefined) return { name, status: 'fail', detail: '/proc/1/cmdline is unreadable' }
  const init = cmdline.split('\0')[0]
  return /(^|\/)(tini|docker-init)$/.test(init)
    ? { name, status: 'ok', detail: `PID 1 is ${init}: only this container's processes are visible` }
    : { name, status: 'fail', detail: `PID 1 is ${init || 'unknown'}, not the container's init` }
}

export function checkNoDockerSocket(probe: ContainerProbe): CheckResult {
  const name = 'docker socket'
  return probe.exists('/var/run/docker.sock') || probe.exists('/run/docker.sock')
    ? { name, status: 'fail', detail: 'a Docker socket is mounted; it would hand out the host' }
    : { name, status: 'ok', detail: 'no Docker socket' }
}

/** Ruling 8: this container's token is the role account (ROLE_GH_LOGIN) and not the operator. */
export async function checkTokenIdentity(probe: ContainerProbe, label: string, token: string): Promise<CheckResult> {
  const name = `${label} identity`
  const role = probe.env.ROLE_GH_LOGIN ?? ''
  const operator = probe.env.OPERATOR_GH_LOGIN ?? ''
  if (!role) return { name, status: 'fail', detail: 'ROLE_GH_LOGIN is not set (a launcher setting)' }
  if (operator && role.toLowerCase() === operator.toLowerCase()) {
    return { name, status: 'fail', detail: 'ROLE_GH_LOGIN equals OPERATOR_GH_LOGIN; the role account must not be the operator' }
  }
  const who = await probe.lookupLogin(token)
  if ('error' in who) return { name, status: 'fail', detail: `GET /user failed: ${firstLine(who.error)}` }
  if (operator && who.login.toLowerCase() === operator.toLowerCase()) {
    return { name, status: 'fail', detail: `the token is the operator (${who.login})` }
  }
  return who.login.toLowerCase() === role.toLowerCase()
    ? { name, status: 'ok', detail: `the token is ${who.login}` }
    : { name, status: 'fail', detail: `the token is ${who.login}, expected ${role}` }
}
```

- [ ] **Step 5: Wire `--role` into the doctor**

In `src/doctor.ts`, replace:

```ts
export async function checkClaudeProfile(config: Config, runCommand: CommandRunner = run): Promise<CheckResult> {
```

with:

```ts
export async function checkClaudeProfile(config: Config, runCommand: CommandRunner = run, extraArgs: string[] = []): Promise<CheckResult> {
```

Replace:

```ts
    '--worktree-root',
    config.worktreeRoot,
  ])
  return code === 0
    ? { name, status: 'ok', detail: output.trim().split('\n').pop() || 'valid' }
```

with:

```ts
    '--worktree-root',
    config.worktreeRoot,
    ...extraArgs,
  ])
  return code === 0
    ? { name, status: 'ok', detail: output.trim().split('\n').pop() || 'valid' }
```

Replace:

```ts
async function checkCodexProfile(config: Config): Promise<CheckResult> {
  const name = 'codex profile'
  const script = path.join(__dirname, '..', 'scripts', 'install-codex-profile.sh')
  if (!fs.existsSync(script)) {
    return { name, status: 'warn', detail: `installer not found at ${script}` }
  }
  const { code, output } = await run(script, ['--check', '--name', config.codexProfile])
```

with:

```ts
export async function checkCodexProfile(config: ReviewConfig, runCommand: CommandRunner = run, extraArgs: string[] = []): Promise<CheckResult> {
  const name = 'codex profile'
  const script = path.join(__dirname, '..', 'scripts', 'install-codex-profile.sh')
  if (!fs.existsSync(script)) {
    return { name, status: 'warn', detail: `installer not found at ${script}` }
  }
  const { code, output } = await runCommand(script, ['--check', '--name', config.codexProfile, ...extraArgs])
```

Replace:

```ts
async function main(): Promise<void> {
  let config: Config
  try {
    config = loadConfig()
```

with:

```ts
/** The live probe for the container checks. */
function liveProbe(base: NodeJS.ProcessEnv): ContainerProbe {
  const gh = defaultRunner('gh')
  return {
    env: base,
    exists: p => fs.existsSync(p),
    readFile: p => {
      try {
        return fs.readFileSync(p, 'utf8')
      } catch {
        return undefined
      }
    },
    runCommand: run,
    lookupLogin: token => lookupLogin(gh, ghEnvAs(base, token)),
  }
}

/** `doctor --role worker` (spec 3.7): the bundle arrives on stdin exactly as for a real worker. */
async function workerDoctor(): Promise<CheckResult[]> {
  const { WORKER_TICKET: _ticket, ...exported } = await readSecretBundle(process.stdin, WORKER_DOCTOR_BUNDLE)
  Object.assign(process.env, exported)
  const config = loadReviewConfig(process.env)
  assertWorkerConfig(config)
  scrubDaemonSecrets(process.env, config)
  const probe = liveProbe(process.env)
  const awsEnv = engineAwsEnv(process.env, config.engineAwsStatic!, config.bedrockRegion)
  // The worker's profile files live under the image's HOME; these flags select the container checks.
  const claudeArgs = ['--container', '--npmrc', process.env.npm_config_userconfig || '/home/bot/.npmrc-worker']
  return [
    await checkDaemonSecretsAbsent(probe),
    await checkGhLoggedOut(probe),
    await checkEngineRole(probe, awsEnv),
    await checkSecretsDenied(probe, awsEnv, config.bedrockRegion),
    checkPidNamespace(probe),
    checkNoDockerSocket(probe),
    await checkTokenIdentity(probe, 'engine token', config.engineGhToken),
    await checkClaudeProfile(config as Config, run, claudeArgs),
    await checkCodexProfile(config, run, ['--container']),
    // The worker logs runs to its own temp dir and ships them to the orchestrator; RUN_LOG_DIR is unused.
    ...checkRoots(config as Config).filter(r => r.name !== 'run log dir'),
  ]
}

/** `doctor --role orchestrator`: Slack, the approver identity, and the container's own isolation. */
async function orchestratorDoctor(): Promise<CheckResult[]> {
  const bundle = await readSecretBundle(process.stdin, ORCHESTRATOR_BUNDLE)
  const { config } = orchestratorConfig(bundle, process.env)
  const probe = liveProbe(process.env)
  const client = new WebClient(config.botToken)
  return [
    await checkBotToken(client),
    await checkAppToken(config.appToken),
    ...(await checkChannels(client, config.channelIds)),
    checkIgnoreList(config.ignoreUserIds),
    await checkEmoji(client, config),
    await checkGhLoggedOut(probe),
    checkNoDockerSocket(probe),
    checkPidNamespace(probe),
    await checkTokenIdentity(probe, 'approver token', config.approverGhToken),
    ...checkCursor(config),
    ...(await checkHistoryAccess(client, config)),
  ]
}

async function containerDoctor(role: 'orchestrator' | 'worker' | undefined): Promise<CheckResult[]> {
  if (!role) {
    return [{ name: 'role', status: 'fail', detail: 'in a container, run doctor --role orchestrator or --role worker' }]
  }
  try {
    return role === 'worker' ? await workerDoctor() : await orchestratorDoctor()
  } catch (error) {
    return [{ name: `${role} setup`, status: 'fail', detail: redactSecrets(String(error)) }]
  }
}

async function main(): Promise<void> {
  const role = parseDoctorRole(process.argv.slice(2))
  // Spec 3.7: in a container the launchd PATH and env-file checks do not apply.
  if (role || inContainer()) {
    const { lines, exitCode } = summarise(await containerDoctor(role))
    process.stdout.write(`${lines.join('\n')}\n`)
    process.exitCode = exitCode
    return
  }
  let config: Config
  try {
    config = loadConfig()
```

Replace:

```ts
import { isDualMode, loadConfig, looksLikeUserId, scrubDaemonSecrets, type Config, type ReviewConfig } from './config'
```

with:

```ts
import { isDualMode, loadConfig, loadReviewConfig, looksLikeUserId, scrubDaemonSecrets, type Config, type ReviewConfig } from './config'
import { inContainer } from './container'
import {
  checkDaemonSecretsAbsent,
  checkEngineRole,
  checkGhLoggedOut,
  checkNoDockerSocket,
  checkPidNamespace,
  checkSecretsDenied,
  checkTokenIdentity,
  engineAwsEnv,
  parseDoctorRole,
  type ContainerProbe,
} from './doctor-container'
import { orchestratorConfig } from './orchestrator'
import { ORCHESTRATOR_BUNDLE, readSecretBundle, WORKER_DOCTOR_BUNDLE } from './secret-bundle'
import { assertWorkerConfig } from './worker'
```

The circular import (`doctor-container.ts` imports types from `doctor.ts`, which imports `doctor-container.ts`) is type-only on the `doctor-container.ts` side (`import type`), so it has no runtime effect.

In `package.json`, replace:

```json
    "build": "esbuild app=src/app.ts worker=src/worker-main.ts orchestrator=src/orchestrator-main.ts --bundle --platform=node --target=node22 --format=cjs --outdir=dist --sourcemap",
```

with:

```json
    "build": "esbuild app=src/app.ts worker=src/worker-main.ts orchestrator=src/orchestrator-main.ts doctor=src/doctor.ts --bundle --platform=node --target=node22 --format=cjs --outdir=dist --sourcemap",
```

- [ ] **Step 6: Run the tests and the build**

Run: `npx ts-node --compiler-options '{"module":"commonjs"}' --transpile-only src/doctor-container.test.ts && npx ts-node --compiler-options '{"module":"commonjs"}' --transpile-only src/doctor.test.ts`
Expected: PASS for both.

Run: `npm run typecheck && npm run build && ls dist/doctor.js`
Expected: exit 0; `dist/doctor.js` listed.

Run: `node dist/doctor.js --role launcher; echo "exit $?"`
Expected: an error naming `--role must be "orchestrator" or "worker"` and a non-zero exit.

- [ ] **Step 7: Commit**

Write `/tmp/srb-commit-msg.txt`:

```text
feat(doctor): add orchestrator and worker container checks (refs andrew-barnett/slack-review-bot#70)

The worker checks are the acceptance criteria of the gate: no daemon
secret in its env or files, no gh login, only the engine role on AWS and
that role denied the bot's secrets, its own PID namespace, no Docker
socket. Each container also confirms its token is the role account.

[cc](https://claude.com/claude-code)
```

Run: `git add package.json src/container.ts src/doctor-container.ts src/doctor-container.test.ts src/doctor.ts && git commit -F /tmp/srb-commit-msg.txt`

---

### Task 12: Image and Compose stack

**Files:**
- Create: `Dockerfile`, `.dockerignore`, `docker/entrypoint.sh`, `docker/aqua-skills.ref`, `scripts/build-image.sh`, `compose.yaml`
- Test: `src/container-files.test.ts`

**Interfaces:**
- Consumes: Task 7/9/11 bundles (`dist/worker.js`, `dist/orchestrator.js`, `dist/doctor.js`); Task 10 `--container --build` installers.
- Produces:
  - Image `slack-review-bot:local` (override with `SRB_IMAGE`), entrypoint `srb-entrypoint orchestrator|worker|doctor [args]`.
  - Compose project `slack-review-bot` with services `orchestrator` and `worker`, networks `jobs` (internal) and `egress`, volumes `orchestrator-state` and `runs`.
  - `scripts/build-image.sh` (no GitHub token; ruling 12).

- [ ] **Step 1: Write the failing static test**

Create `src/container-files.test.ts`:

```ts
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
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx ts-node --compiler-options '{"module":"commonjs"}' --transpile-only src/container-files.test.ts`
Expected: FAIL with `ENOENT: no such file or directory, open '.../compose.yaml'`.

- [ ] **Step 3: Write the image files**

Create `Dockerfile`:

```dockerfile
# syntax=docker/dockerfile:1.7
#
# One image, two roles (spec 3.1): `srb-entrypoint orchestrator` and `srb-entrypoint worker`.
# Build with scripts/build-image.sh, which supplies the `aqua` build context (ruling 12).

FROM node:22-bookworm-slim AS build
WORKDIR /src
COPY package.json package-lock.json ./
# Public dependencies only (@slack/*), so no registry credential is needed at build time.
RUN npm ci --ignore-scripts --registry=https://registry.npmjs.org/
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-bookworm-slim
ARG TARGETARCH
ARG GH_VERSION=2.103.3
ARG AWSCLI_VERSION=2.40.4
ARG CODEX_VERSION=0.169.0
ARG CLAUDE_CODE_VERSION=2.1.284

RUN apt-get update \
 && apt-get install -y --no-install-recommends git python3 jq tini ca-certificates curl unzip \
 && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_${TARGETARCH}.tar.gz" -o /tmp/gh.tgz \
 && tar -xzf /tmp/gh.tgz -C /tmp \
 && install -m 0755 "/tmp/gh_${GH_VERSION}_linux_${TARGETARCH}/bin/gh" /usr/local/bin/gh \
 && rm -rf /tmp/gh.tgz "/tmp/gh_${GH_VERSION}_linux_${TARGETARCH}"

RUN case "${TARGETARCH}" in arm64) arch=aarch64 ;; amd64) arch=x86_64 ;; *) echo "unsupported ${TARGETARCH}" >&2; exit 1 ;; esac \
 && curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-${arch}-${AWSCLI_VERSION}.zip" -o /tmp/awscli.zip \
 && unzip -q /tmp/awscli.zip -d /tmp \
 && /tmp/aws/install \
 && rm -rf /tmp/aws /tmp/awscli.zip

RUN npm install -g "@openai/codex@${CODEX_VERSION}" "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
 && npm cache clean --force

RUN useradd --create-home --uid 10001 --shell /bin/bash bot \
 && mkdir -p /work/src /work/wt /var/lib/slack-review-bot/state /var/lib/slack-review-bot/runs \
 && chown -R bot:bot /work /var/lib/slack-review-bot

# The review-pr skill and the secret-blocking hook, from a pinned aqua-skills commit.
COPY --from=aqua skills/review-pr /opt/aqua-skills/skills/review-pr
COPY --from=aqua security/block-secret-reads.py /opt/aqua-skills/security/block-secret-reads.py

WORKDIR /app
COPY --from=build /src/dist ./dist
COPY package.json ./
COPY scripts ./scripts
COPY claude ./claude
COPY codex ./codex
COPY docker/entrypoint.sh /usr/local/bin/srb-entrypoint

ENV HOME=/home/bot \
    CODEX_HOME=/home/bot/.codex \
    CLAUDE_CONFIG_DIR_REVIEW=/home/bot/.claude-review-bot \
    GH_CONFIG_DIR=/home/bot/.config/gh \
    WORKSPACE_ROOT=/work/src \
    WORKTREE_ROOT=/work/wt \
    RUN_LOG_DIR=/var/lib/slack-review-bot/runs \
    CURSOR_FILE=/var/lib/slack-review-bot/state/cursors.json \
    CODEARTIFACT_REFRESH=false \
    RUNTIME=container

USER bot
# --build: docker build steps have no /.dockerenv; the worker doctor runs the full check (ruling 14).
RUN scripts/install-claude-profile.sh --container --build \
        --skill-src /opt/aqua-skills/skills/review-pr \
        --hook-src /opt/aqua-skills/security/block-secret-reads.py \
 && scripts/install-codex-profile.sh --container --build \
 && mkdir -p /home/bot/.codex/skills /home/bot/.config/gh \
 && chmod 700 /home/bot/.config/gh \
 && ln -s /opt/aqua-skills/skills/review-pr /home/bot/.codex/skills/review-pr

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/srb-entrypoint"]
CMD ["worker"]
```

Create `docker/entrypoint.sh`:

```sh
#!/bin/sh
# Container entrypoint: the role is the first argument (spec 3.1).
set -eu

role="${1:-worker}"
if [ "$#" -gt 0 ]; then
    shift
fi

case "${role}" in
    orchestrator) exec node /app/dist/orchestrator.js "$@" ;;
    worker) exec node /app/dist/worker.js "$@" ;;
    doctor) exec node /app/dist/doctor.js "$@" ;;
    *)
        echo "usage: srb-entrypoint orchestrator|worker|doctor [args]" >&2
        exit 2
        ;;
esac
```

Create `.dockerignore`:

```text
.git
node_modules
dist
runs
docs
*.log
.env
.env.*
.envrc
```

Create `scripts/build-image.sh`:

```bash
#!/usr/bin/env bash
#
# Build the slack-review-bot image from the committed tree (git archive HEAD), with the review-pr
# skill and the secret-blocking hook taken from the aqua-skills commit pinned in
# docker/aqua-skills.ref (ruling 12). No GitHub token is used: the pinned commit must already be in
# the local aqua-skills clone.
#
# Usage: scripts/build-image.sh
#   AQUA_SKILLS_DIR  local aqua-skills clone (default ~/src/aqua-skills)
#   SRB_IMAGE        image tag (default slack-review-bot:local)
#   PLATFORM         buildx platform (default linux/arm64)

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." > /dev/null 2>&1 && pwd)"
AQUA_DIR="${AQUA_SKILLS_DIR:-${HOME}/src/aqua-skills}"
IMAGE="${SRB_IMAGE:-slack-review-bot:local}"
PLATFORM="${PLATFORM:-linux/arm64}"

REF="$(tr -d '[:space:]' < "${REPO}/docker/aqua-skills.ref")"
if ! printf '%s' "${REF}" | grep -qE '^[0-9a-f]{40}$'; then
    echo "ERROR: docker/aqua-skills.ref must hold one 40-character commit SHA" >&2
    exit 1
fi
if ! git -C "${AQUA_DIR}" cat-file -e "${REF}^{commit}" 2> /dev/null; then
    echo "ERROR: ${REF} is not in ${AQUA_DIR}; run: git -C ${AQUA_DIR} fetch origin" >&2
    exit 1
fi

CTX="$(mktemp -d)"
trap 'rm -rf "${CTX}"' EXIT
mkdir -p "${CTX}/app" "${CTX}/aqua"
git -C "${REPO}" archive HEAD | tar -x -C "${CTX}/app"
git -C "${AQUA_DIR}" archive "${REF}" skills/review-pr security/block-secret-reads.py | tar -x -C "${CTX}/aqua"

docker buildx build \
    --platform "${PLATFORM}" \
    --load \
    --tag "${IMAGE}" \
    --build-context "aqua=${CTX}/aqua" \
    "${CTX}/app"
echo "built ${IMAGE} from $(git -C "${REPO}" rev-parse --short HEAD) with aqua-skills ${REF:0:12}"
```

Pin the aqua-skills commit (the hash is whatever `origin/main` is when you run this; record it, do not invent one):

Run: `git -C "${AQUA_SKILLS_DIR:-$HOME/src/aqua-skills}" fetch -q origin && git -C "${AQUA_SKILLS_DIR:-$HOME/src/aqua-skills}" rev-parse origin/main > docker/aqua-skills.ref && cat docker/aqua-skills.ref`
Expected: one 40-character hexadecimal line.

- [ ] **Step 4: Write the Compose file**

Create `compose.yaml`:

```yaml
# The laptop stack (spec 3.8). The launcher starts each container with
# `docker compose run --rm -T --name <name> <service>` and writes its secrets to stdin; nothing here
# carries a secret. Pass-through variables use the list form (`- NAME`): set in the launcher's
# environment, they are passed; unset, they are absent.
name: slack-review-bot

services:
  orchestrator:
    image: ${SRB_IMAGE:-slack-review-bot:local}
    command: ["orchestrator"]
    networks: [jobs, egress]
    volumes:
      - orchestrator-state:/var/lib/slack-review-bot/state
      - runs:/var/lib/slack-review-bot/runs
    cap_drop: [ALL]
    security_opt: [no-new-privileges:true]
    stdin_open: true
    mem_limit: 512m
    environment:
      - SLACK_CHANNEL_IDS
      - SLACK_IGNORE_USER_IDS
      - REVIEW_ENGINES
      - ENGINE_ORDER
      - ENGINE_SCHEDULE
      - CONCURRENCY
      - RUN_TIMEOUT_MS
      - STALL_MAX_MS
      - STALL_BACKOFF_MS
      - SHUTDOWN_DRAIN_MS
      - WORKER_IDLE_EXIT_MS
      - REPLAY_ENABLED
      - REPLAY_MAX_AGE_MS
      - ACK_EMOJI
      - PASS_EMOJI
      - FINDINGS_EMOJI
      - ERROR_EMOJI
      - APPROVAL_NOT_COUNTED_EMOJI
      - ROLE_GH_LOGIN
      - OPERATOR_GH_LOGIN

  worker:
    image: ${SRB_IMAGE:-slack-review-bot:local}
    command: ["worker"]
    networks: [jobs, egress]
    read_only: false
    tmpfs: [/tmp]
    cap_drop: [ALL]
    security_opt: [no-new-privileges:true]
    stdin_open: true
    mem_limit: ${WORKER_MEMORY:-6g}
    environment:
      - ENGINE_AUTH=bedrock
      - ORCHESTRATOR_URL=http://slack-review-bot-orchestrator:8080
      - npm_config_userconfig=/home/bot/.npmrc-worker
      - BEDROCK_REGION
      - CODEX_BEDROCK_MODEL
      - CLAUDE_BEDROCK_MODEL
      - CODEX_BEDROCK_CONTEXT_WINDOW
      - RUN_TIMEOUT_MS
      - WORKER_IDLE_EXIT_MS
      - CODEX_ENV_PASSTHROUGH
      - ROLE_GH_LOGIN
      - OPERATOR_GH_LOGIN

networks:
  jobs:
    internal: true
  egress: {}

volumes:
  orchestrator-state: {}
  runs: {}
```

- [ ] **Step 5: Run the static test and validate the Compose file**

Run: `chmod +x docker/entrypoint.sh scripts/build-image.sh && npx ts-node --compiler-options '{"module":"commonjs"}' --transpile-only src/container-files.test.ts`
Expected: PASS (all four tests).

Run: `docker compose -f compose.yaml config --quiet && echo compose-ok`
Expected: `compose-ok`.

- [ ] **Step 6: Commit**

Commit now, before building. `scripts/build-image.sh` builds from `git archive HEAD`, so an uncommitted Dockerfile, `.dockerignore` or entrypoint would be missing from the build context, and the build would fail or use stale files.

Write `/tmp/srb-commit-msg.txt`:

```text
build: add the container image and the Compose stack (refs andrew-barnett/slack-review-bot#70)

One non-root image runs under tini as the orchestrator or a worker. The
skill and hook come from a pinned aqua-skills commit without a token, and
the Compose file carries no secret, socket, port or restart policy.

[cc](https://claude.com/claude-code)
```

Run: `git add Dockerfile .dockerignore docker/entrypoint.sh docker/aqua-skills.ref scripts/build-image.sh compose.yaml src/container-files.test.ts && git commit -F /tmp/srb-commit-msg.txt`

Run: `git status --short -- Dockerfile .dockerignore docker scripts/build-image.sh compose.yaml`
Expected: no output (everything the build needs is committed).

- [ ] **Step 7: Build the image from the commit and check it**

If this step shows a defect, fix it, commit the fix as a new commit (never amend), and re-run this step. The build always reads the committed tree.

Run: `scripts/build-image.sh`
Expected: ends with `built slack-review-bot:local from <sha> with aqua-skills <12 hex>`. The two installer `RUN` steps print `looks correct (container: ...)` lines.

Run: `docker run --rm --entrypoint id slack-review-bot:local`
Expected: `uid=10001(bot) gid=10001(bot) groups=10001(bot)`.

Run: `docker run --rm slack-review-bot:local nonsense; echo "exit $?"`
Expected: `usage: srb-entrypoint orchestrator|worker|doctor [args]` and `exit 2`.

---

### Task 13: The launcher (`src/launcher.ts`, `scripts/launcher`, LaunchAgent)

**Files:**
- Create: `src/launcher.ts` (library), `src/launcher-main.ts` (entrypoint), `scripts/launcher`, `scripts/install-launcher.sh`, `launchd/com.abarnett.slack-review-bot-launcher.plist.template`
- Modify: `package.json`
- Test: `src/launcher.test.ts`

**Interfaces:**
- Consumes: Phase 2a `assumeEngineRole`, `engineSessionSeconds`, `engineSessionName`, `AwsCredentials`; Task 2 `mintTicket`, `LAUNCH_KEY_BYTES`; Task 5 `encodeSecretBundle`.
- Produces:
  - `ORCHESTRATOR_NAME = 'slack-review-bot-orchestrator'`, `WORKER_PREFIX = 'slack-review-bot-worker-'`, `SECRET_IDS` (the four `/slack-review-bot/<NAME>` ids).
  - `interface LauncherSettings { awsProfile; region; readerRoleArn; engineRoleArn; workerSlots; runTimeoutMs; shutdownDrainMs; shutdownGraceMs; hardBoundSlackMs; workerStopGraceMs; workerRestartMs; backoffBaseMs; backoffMaxMs; composeFile; project }`, `loadLauncherSettings(env)`.
  - `type LauncherExec = (file: string, args: string[], env?: NodeJS.ProcessEnv) => Promise<{ stdout: string; stderr: string }>`
  - `interface AwsOps { assumeRole(roleArn: string, sessionName: string, durationSeconds: number): Promise<AwsCredentials>; getSecret(creds: AwsCredentials, id: string): Promise<string>; codeartifactToken(durationSeconds: number): Promise<string> }`, `makeAwsOps(settings, exec?)`.
  - `interface RunningContainer { name: string; exited: Promise<number> }`, `interface DockerOps { run(service: 'orchestrator' | 'worker', name: string, bundle: string, args?: string[]): RunningContainer; signal(name: string, signal: 'SIGTERM' | 'SIGKILL'): Promise<void>; removeForce(name: string): Promise<void>; listByPrefix(prefix: string): Promise<string[]> }`, `makeDockerOps(settings, env, spawnImpl?, exec?)`, `dockerEnv(env)`, `composeRunArgs(settings, service, name, args)`.
  - `backoffMs(failures, base, max)`; `createLauncher(deps: LauncherDeps): { start(): Promise<number>; requestStop(): void }`; `runDoctor(deps, role): Promise<number>`.

- [ ] **Step 1: Write the failing tests**

Create `src/launcher.test.ts`:

```ts
import test from 'tape'
import { verifyTicket } from './jobs/ticket'
import {
  backoffMs,
  composeRunArgs,
  createLauncher,
  dockerEnv,
  loadLauncherSettings,
  makeAwsOps,
  ORCHESTRATOR_NAME,
  type AwsOps,
  type DockerOps,
  type LauncherDeps,
  type LauncherSettings,
} from './launcher'

const fast: LauncherSettings = {
  ...loadLauncherSettings({ HOME: '/Users/op' }),
  workerSlots: 2,
  shutdownDrainMs: 40,
  shutdownGraceMs: 0,
  hardBoundSlackMs: 0,
  workerStopGraceMs: 30,
  workerRestartMs: 1,
  backoffBaseMs: 1,
  backoffMaxMs: 4,
}
const until = async (cond: () => boolean, ms = 2000) => {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting')
    await new Promise(resolve => setTimeout(resolve, 2))
  }
}
const secrets: Record<string, string> = {
  '/slack-review-bot/SLACK_BOT_TOKEN': 'bot-placeholder',
  '/slack-review-bot/SLACK_APP_TOKEN': 'app-placeholder',
  '/slack-review-bot/APPROVER_GH_TOKEN': 'approver-placeholder',
  '/slack-review-bot/ENGINE_GH_TOKEN': 'engine-placeholder',
}

function fakeAws(over: Partial<AwsOps> = {}): AwsOps {
  let n = 0
  return {
    assumeRole: async () => ({ accessKeyId: `id-${++n}`, secretAccessKey: `key-${n}`, sessionToken: `session-${n}` }),
    getSecret: async (_c, id) => secrets[id],
    codeartifactToken: async () => 'npm-placeholder',
    ...over,
  }
}

/**
 * Containers that live until signalled. The orchestrator exits `orchTermMs` after SIGTERM (null:
 * it ignores SIGTERM); workers exit on SIGTERM when `workersObeyTerm`. SIGKILL always works.
 */
function fakeDocker(opts: { orchTermMs?: number | null; workersObeyTerm?: boolean } = {}) {
  const events: string[] = []
  const bundles = new Map<string, string>()
  const live = new Map<string, (code: number) => void>()
  const docker: DockerOps = {
    run(_service, name, bundle) {
      events.push(`run ${name}`)
      bundles.set(name, bundle)
      let done = false
      const exited = new Promise<number>(resolve => {
        live.set(name, code => {
          if (done) return
          done = true
          live.delete(name)
          events.push(`exit ${name}`)
          resolve(code)
        })
      })
      return { name, exited }
    },
    async signal(name, signal) {
      events.push(`${signal} ${name}`)
      const exit = live.get(name)
      if (!exit) return
      if (signal === 'SIGKILL') return exit(137)
      if (name === ORCHESTRATOR_NAME) {
        const ms = opts.orchTermMs === undefined ? 10 : opts.orchTermMs
        if (ms !== null) setTimeout(() => exit(0), ms)
      } else if (opts.workersObeyTerm !== false) {
        exit(143)
      }
    },
    async removeForce(name) {
      events.push(`rm ${name}`)
    },
    async listByPrefix() {
      events.push('ps workers')
      return ['slack-review-bot-worker-7']
    },
  }
  return { docker, events, bundles, exit: (name: string, code: number) => live.get(name)?.(code) }
}

function deps(d: DockerOps, over: Partial<LauncherDeps> = {}): LauncherDeps & { logs: [string, Record<string, unknown>][] } {
  const logs: [string, Record<string, unknown>][] = []
  return {
    logs,
    settings: fast,
    aws: fakeAws(),
    docker: d,
    log: (event, fields = {}) => void logs.push([event, fields]),
    now: Date.now,
    randomKey: () => Buffer.alloc(32, 5),
    ...over,
  }
}

// Review Focus 5 / ruling 10: a launcher restarted after a crash must remove a leftover
// orchestrator first (it could still be double-reviewing), then leftover workers, and only then
// start anything. Regression caught: `run --name` failing on the stale name, or two orchestrators.
test('launcher removes the stale orchestrator before stale workers and before starting anything', async t => {
  const f = fakeDocker()
  const launcher = createLauncher(deps(f.docker))
  const done = launcher.start()
  await until(() => f.events.includes('run slack-review-bot-worker-1'))
  t.deepEqual(f.events.slice(0, 4), [`rm ${ORCHESTRATOR_NAME}`, 'ps workers', 'rm slack-review-bot-worker-7', `run ${ORCHESTRATOR_NAME}`])
  launcher.requestStop()
  t.equal(await done, 0)
  t.end()
})

// Spec 3.6 step 1: the two role tokens must differ, or the engine could write as the approver.
test('launcher refuses identical approver and engine tokens and starts nothing', async t => {
  const f = fakeDocker()
  const same = fakeAws({ getSecret: async (_c, id) => (id.endsWith('_GH_TOKEN') ? 'same-placeholder' : secrets[id]) })
  const d = deps(f.docker, { aws: same })
  t.equal(await createLauncher(d).start(), 1)
  t.notOk(f.events.some(e => e.startsWith('run ')))
  t.ok(d.logs.some(([event]) => event === 'launcher.tokens_identical'))
  t.end()
})

// Spec 3.4 / 3.6.1: LAUNCH_KEY goes to the orchestrator only; a worker gets the engine credentials
// and a ticket that verifies under that key, and never a daemon token.
test('launcher sends each container exactly its own bundle', async t => {
  const f = fakeDocker()
  const launcher = createLauncher(deps(f.docker))
  const done = launcher.start()
  await until(() => f.bundles.has('slack-review-bot-worker-0'))
  const orch = JSON.parse(f.bundles.get(ORCHESTRATOR_NAME)!)
  t.deepEqual(Object.keys(orch).sort(), ['APPROVER_GH_TOKEN', 'LAUNCH_KEY', 'SLACK_APP_TOKEN', 'SLACK_BOT_TOKEN'])
  const key = Buffer.from(orch.LAUNCH_KEY, 'base64url')
  t.equal(key.length, 32)
  const worker = JSON.parse(f.bundles.get('slack-review-bot-worker-0')!)
  t.deepEqual(Object.keys(worker).sort(), ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'ENGINE_GH_TOKEN', 'NPM_TOKEN', 'WORKER_TICKET'])
  t.equal(worker.ENGINE_GH_TOKEN, 'engine-placeholder')
  t.ok(verifyTicket(key, worker.WORKER_TICKET, Date.now(), 60_000).ok, 'the ticket verifies under the orchestrator key')
  launcher.requestStop()
  await done
  t.end()
})

// The spec's central shutdown rule: SIGTERM goes to the orchestrator only, and no worker is
// signalled until the orchestrator has exited. Regression caught: an in-flight review turned into
// "worker lost" and settled as an error, so it never replays.
test('launcher never stops a worker while the orchestrator is alive', async t => {
  const f = fakeDocker({ orchTermMs: 25 })
  const launcher = createLauncher(deps(f.docker))
  const done = launcher.start()
  await until(() => f.events.includes('run slack-review-bot-worker-1'))
  launcher.requestStop()
  t.equal(await done, 0)
  const orchExit = f.events.indexOf(`exit ${ORCHESTRATOR_NAME}`)
  const firstWorkerSignal = f.events.findIndex(e => /^SIG(TERM|KILL) slack-review-bot-worker-/.test(e))
  t.ok(f.events.indexOf(`SIGTERM ${ORCHESTRATOR_NAME}`) < orchExit)
  t.ok(orchExit >= 0 && firstWorkerSignal > orchExit, 'workers are signalled only after the orchestrator exited')
  t.notOk(f.events.includes(`SIGKILL ${ORCHESTRATOR_NAME}`), 'no escalation within the hard bound')
  t.end()
})

// A repeated SIGTERM to the launcher is ignored: it must not escalate or signal anything new.
test('launcher ignores a repeated stop request', async t => {
  const f = fakeDocker({ orchTermMs: 20 })
  const d = deps(f.docker)
  const launcher = createLauncher(d)
  const done = launcher.start()
  await until(() => f.events.includes('run slack-review-bot-worker-1'))
  launcher.requestStop()
  launcher.requestStop()
  await done
  t.equal(f.events.filter(e => e === `SIGTERM ${ORCHESTRATOR_NAME}`).length, 1)
  t.ok(d.logs.some(([event]) => event === 'launcher.signal_ignored'))
  t.end()
})

// The only escalation is the hard bound: an orchestrator that ignores SIGTERM is killed first and
// waited for; then workers get SIGTERM, and SIGKILL after their grace.
test('launcher escalates only after the hard bound, orchestrator first', async t => {
  const f = fakeDocker({ orchTermMs: null, workersObeyTerm: false })
  const launcher = createLauncher(deps(f.docker))
  const done = launcher.start()
  await until(() => f.events.includes('run slack-review-bot-worker-1'))
  const stopAt = Date.now()
  launcher.requestStop()
  await done
  const kill = f.events.indexOf(`SIGKILL ${ORCHESTRATOR_NAME}`)
  t.ok(kill >= 0, 'orchestrator killed')
  t.ok(Date.now() - stopAt >= fast.shutdownDrainMs, 'not before the hard bound')
  t.ok(f.events.indexOf(`exit ${ORCHESTRATOR_NAME}`) < f.events.indexOf('SIGTERM slack-review-bot-worker-0'))
  t.ok(f.events.indexOf('SIGTERM slack-review-bot-worker-0') < f.events.indexOf('SIGKILL slack-review-bot-worker-0'))
  t.end()
})

// Ruling 11: an orchestrator that exits on its own leaves nothing to drain for, so the launcher
// stops its workers and exits 1 for launchd to restart the stack with fresh secrets.
test('launcher stops workers and exits 1 when the orchestrator exits on its own', async t => {
  const f = fakeDocker()
  const launcher = createLauncher(deps(f.docker))
  const done = launcher.start()
  await until(() => f.events.includes('run slack-review-bot-worker-1'))
  f.exit(ORCHESTRATOR_NAME, 1)
  t.equal(await done, 1)
  t.ok(f.events.includes('SIGTERM slack-review-bot-worker-0'))
  t.end()
})

// Spec 3.6 step 2: a failed mint backs off exponentially to the cap and logs the STS error line,
// never a credential, and never starts a worker without credentials.
test('launcher backs off on a failed mint and logs only the error line', async t => {
  t.deepEqual([1, 2, 3, 10].map(n => backoffMs(n, 1000, 300_000)), [1000, 2000, 4000, 300_000])
  const f = fakeDocker()
  let calls = 0
  const failing = fakeAws({
    assumeRole: async roleArn => {
      if (roleArn.endsWith('SlackReviewBotSecretsReaderRole')) return { accessKeyId: 'r', secretAccessKey: 'r', sessionToken: 'r' }
      calls += 1
      throw new Error('could not assume the engine role: An error occurred (AccessDenied) when calling the AssumeRole operation')
    },
  })
  const d = deps(f.docker, { aws: failing })
  const launcher = createLauncher(d)
  const done = launcher.start()
  await until(() => calls >= 4)
  launcher.requestStop()
  await done
  t.notOk(f.events.some(e => e.startsWith('run slack-review-bot-worker-')), 'no worker without credentials')
  const failure = d.logs.find(([event]) => event === 'launcher.mint_failed')!
  t.match(String(failure[1].error), /AccessDenied/)
  t.ok(Number(failure[1].waitMs) <= fast.backoffMaxMs)
  t.end()
})

// Secrets never ride the docker command line or its environment; the bundle goes to stdin.
test('dockerEnv strips credentials and composeRunArgs carries no value', t => {
  const env = dockerEnv({ PATH: '/usr/bin', HOME: '/Users/op', AWS_PROFILE: 'staging', NPM_TOKEN: 'x', GH_TOKEN: 'x', LAUNCH_KEY: 'x', SOME_SECRET: 'x', REVIEW_ENGINES: 'codex' })
  t.deepEqual(Object.keys(env).sort(), ['HOME', 'PATH', 'REVIEW_ENGINES'])
  t.deepEqual(composeRunArgs(fast, 'worker', 'slack-review-bot-worker-0', []), [
    'compose', '-f', fast.composeFile, '-p', 'slack-review-bot', 'run', '--rm', '-T', '--name', 'slack-review-bot-worker-0', 'worker',
  ])
  t.end()
})

// The reader credentials reach `aws` through its environment only, with every profile file
// disabled; the CodeArtifact token is minted with the operator profile for the pinned domain.
test('makeAwsOps passes reader credentials by environment and pins CodeArtifact', async t => {
  const calls: { args: string[]; env?: NodeJS.ProcessEnv }[] = []
  const aws = makeAwsOps(fast, async (_file, args, env) => {
    calls.push({ args, env })
    return { stdout: 'value-placeholder\n', stderr: '' }
  })
  t.equal(await aws.getSecret({ accessKeyId: 'r1', secretAccessKey: 'r2', sessionToken: 'r3' }, '/slack-review-bot/SLACK_BOT_TOKEN'), 'value-placeholder')
  t.notOk(calls[0].args.some(a => a.startsWith('r')), 'no credential in the arguments')
  t.equal(calls[0].env?.AWS_ACCESS_KEY_ID, 'r1')
  t.equal(calls[0].env?.AWS_CONFIG_FILE, '/dev/null')
  t.equal(calls[0].env?.AWS_PROFILE, undefined)
  await aws.codeartifactToken(3600)
  t.deepEqual(calls[1].args, [
    'codeartifact', 'get-authorization-token', '--domain', 'trade-platform', '--domain-owner', '153538148884',
    '--region', 'us-east-2', '--duration-seconds', '3600', '--query', 'authorizationToken', '--output', 'text', '--profile', 'staging',
  ])
  t.end()
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx ts-node --compiler-options '{"module":"commonjs"}' --transpile-only src/launcher.test.ts`
Expected: FAIL with `Cannot find module './launcher'`.

- [ ] **Step 3: Write the launcher library**

Create `src/launcher.ts`:

```ts
// The host launcher (spec 3.6). The only process holding the operator's AWS login: it fetches the
// bot's secrets, mints per-worker engine credentials and claim tickets, starts the orchestrator and
// the workers with `docker compose run`, writes each one's secrets to its stdin, and owns the
// shutdown order. It never stops a worker while the orchestrator is alive.

import { execFile, spawn, type ChildProcess } from 'child_process'
import { randomBytes } from 'crypto'
import * as path from 'path'
import { promisify } from 'util'
import { assumeEngineRole, engineSessionName, engineSessionSeconds, type AwsCredentials } from './bedrock-auth'
import { LAUNCH_KEY_BYTES, mintTicket } from './jobs/ticket'
import { redactSecrets } from './redact'
import { encodeSecretBundle } from './secret-bundle'

export const ORCHESTRATOR_NAME = 'slack-review-bot-orchestrator'
export const WORKER_PREFIX = 'slack-review-bot-worker-'
const SECRET_NAMES = ['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN', 'APPROVER_GH_TOKEN', 'ENGINE_GH_TOKEN'] as const
export const SECRET_IDS: Record<(typeof SECRET_NAMES)[number], string> = {
  SLACK_BOT_TOKEN: '/slack-review-bot/SLACK_BOT_TOKEN',
  SLACK_APP_TOKEN: '/slack-review-bot/SLACK_APP_TOKEN',
  APPROVER_GH_TOKEN: '/slack-review-bot/APPROVER_GH_TOKEN',
  ENGINE_GH_TOKEN: '/slack-review-bot/ENGINE_GH_TOKEN',
}
const CODEARTIFACT = { domain: 'trade-platform', owner: '153538148884', region: 'us-east-2' }
/** The reader session only lives long enough to fetch four secrets. */
const READER_SESSION_SECONDS = 900

export interface LauncherSettings {
  awsProfile: string
  region: string
  readerRoleArn: string
  engineRoleArn: string
  workerSlots: number
  runTimeoutMs: number
  shutdownDrainMs: number
  shutdownGraceMs: number
  /** The 30 s on top of drain + grace before the orchestrator is killed (spec 3.6 step 3). */
  hardBoundSlackMs: number
  /** How long workers get after SIGTERM, once the orchestrator is gone. */
  workerStopGraceMs: number
  workerRestartMs: number
  backoffBaseMs: number
  backoffMaxMs: number
  composeFile: string
  project: string
}

const positiveInt = (raw: string | undefined, fallback: number) => {
  const n = Number(raw)
  return raw && Number.isInteger(n) && n > 0 ? n : fallback
}

export function loadLauncherSettings(env: NodeJS.ProcessEnv): LauncherSettings {
  const concurrency = positiveInt(env.CONCURRENCY, 1)
  return {
    awsProfile: env.LAUNCHER_AWS_PROFILE || 'staging',
    region: env.LAUNCHER_REGION || 'us-east-2',
    readerRoleArn: env.LAUNCHER_READER_ROLE_ARN || 'arn:aws:iam::153538148884:role/SlackReviewBotSecretsReaderRole',
    engineRoleArn: env.LAUNCHER_ENGINE_ROLE_ARN || 'arn:aws:iam::153538148884:role/SlackReviewBotEngineRole',
    workerSlots: positiveInt(env.WORKER_SLOTS, 2 * concurrency),
    runTimeoutMs: positiveInt(env.RUN_TIMEOUT_MS, 3 * 60 * 60 * 1000),
    shutdownDrainMs: positiveInt(env.SHUTDOWN_DRAIN_MS, 5_000),
    shutdownGraceMs: positiveInt(env.SHUTDOWN_GRACE_MS, 10_000),
    hardBoundSlackMs: 30_000,
    workerStopGraceMs: 30_000,
    workerRestartMs: 1_000,
    backoffBaseMs: 1_000,
    backoffMaxMs: 5 * 60_000,
    composeFile: env.LAUNCHER_COMPOSE_FILE || path.join(__dirname, '..', 'compose.yaml'),
    project: 'slack-review-bot',
  }
}

export type LauncherExec = (file: string, args: string[], env?: NodeJS.ProcessEnv) => Promise<{ stdout: string; stderr: string }>

const execFileAsync = promisify(execFile)
const defaultExec: LauncherExec = (file, args, env) => execFileAsync(file, args, { timeout: 60_000, env: env ?? process.env })

/** The first stderr line of a failed command, redacted; never its stdout (it may hold a value). */
function reason(error: unknown, what: string): string {
  const stderr = (error as { stderr?: unknown }).stderr
  const line = typeof stderr === 'string' ? stderr.split(/\r?\n/).find(l => l.trim()) ?? '' : ''
  return line ? redactSecrets(line.trim()).slice(0, 300) : `${what} failed`
}

export interface AwsOps {
  assumeRole(roleArn: string, sessionName: string, durationSeconds: number): Promise<AwsCredentials>
  getSecret(creds: AwsCredentials, id: string): Promise<string>
  codeartifactToken(durationSeconds: number): Promise<string>
}

export function makeAwsOps(settings: LauncherSettings, exec: LauncherExec = defaultExec): AwsOps {
  return {
    // Each role is assumed directly from the operator's profile, never chained (spec 3.6).
    assumeRole: (roleArn, sessionName, durationSeconds) =>
      assumeEngineRole({ roleArn, profile: settings.awsProfile, region: settings.region, durationSeconds, sessionName, exec }),
    async getSecret(creds, id) {
      // The reader session reaches `aws` through its environment only, with every profile file off.
      const env: NodeJS.ProcessEnv = {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        AWS_CONFIG_FILE: '/dev/null',
        AWS_SHARED_CREDENTIALS_FILE: '/dev/null',
        AWS_REGION: settings.region,
        AWS_ACCESS_KEY_ID: creds.accessKeyId,
        AWS_SECRET_ACCESS_KEY: creds.secretAccessKey,
        ...(creds.sessionToken ? { AWS_SESSION_TOKEN: creds.sessionToken } : {}),
      }
      try {
        const { stdout } = await exec('aws', ['secretsmanager', 'get-secret-value', '--secret-id', id, '--query', 'SecretString', '--output', 'text'], env)
        const value = stdout.replace(/\r?\n$/, '')
        if (!value) throw Object.assign(new Error('empty'), { stderr: `${id} is empty` })
        return value
      } catch (error) {
        throw new Error(`could not read ${id}: ${reason(error, 'get-secret-value')}`)
      }
    },
    async codeartifactToken(durationSeconds) {
      try {
        const { stdout } = await exec('aws', [
          'codeartifact', 'get-authorization-token',
          '--domain', CODEARTIFACT.domain,
          '--domain-owner', CODEARTIFACT.owner,
          '--region', CODEARTIFACT.region,
          '--duration-seconds', String(durationSeconds),
          '--query', 'authorizationToken',
          '--output', 'text',
          '--profile', settings.awsProfile,
        ])
        return stdout.trim()
      } catch (error) {
        throw new Error(`could not mint a CodeArtifact token: ${reason(error, 'get-authorization-token')}`)
      }
    },
  }
}

export interface RunningContainer {
  name: string
  exited: Promise<number>
}

export interface DockerOps {
  run(service: 'orchestrator' | 'worker', name: string, bundle: string, args?: string[]): RunningContainer
  signal(name: string, signal: 'SIGTERM' | 'SIGKILL'): Promise<void>
  removeForce(name: string): Promise<void>
  listByPrefix(prefix: string): Promise<string[]>
}

/** The docker CLI's environment: the launcher's, minus every credential and every AWS variable. */
export function dockerEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {}
  for (const [name, value] of Object.entries(env)) {
    if (/^AWS_/.test(name) || /_TOKEN$/.test(name) || /SECRET/.test(name) || name === 'LAUNCH_KEY' || name === 'WORKER_TICKET') continue
    out[name] = value
  }
  return out
}

export function composeRunArgs(settings: LauncherSettings, service: 'orchestrator' | 'worker', name: string, args: string[]): string[] {
  return ['compose', '-f', settings.composeFile, '-p', settings.project, 'run', '--rm', '-T', '--name', name, service, ...args]
}

export function makeDockerOps(
  settings: LauncherSettings,
  env: NodeJS.ProcessEnv,
  spawnImpl: typeof spawn = spawn,
  exec: LauncherExec = defaultExec
): DockerOps {
  const cliEnv = dockerEnv(env)
  return {
    run(service, name, bundle, args = []) {
      const child: ChildProcess = spawnImpl('docker', composeRunArgs(settings, service, name, args), {
        stdio: ['pipe', 'inherit', 'inherit'],
        env: cliEnv,
      })
      // The bundle goes to stdin and nowhere else (spec 3.6.1); the entrypoint closes stdin after it.
      child.stdin?.on('error', () => {})
      child.stdin?.end(bundle)
      const exited = new Promise<number>(resolve => {
        child.on('error', () => resolve(127))
        child.on('exit', code => resolve(code ?? 1))
      })
      return { name, exited }
    },
    async signal(name, signal) {
      await exec('docker', ['kill', '--signal', signal, name], cliEnv).catch(() => undefined)
    },
    async removeForce(name) {
      // "No such container" is the normal case; anything else surfaces when `run --name` fails.
      await exec('docker', ['rm', '-f', name], cliEnv).catch(() => undefined)
    },
    async listByPrefix(prefix) {
      const { stdout } = await exec('docker', ['ps', '-a', '--format', '{{.Names}}', '--filter', `name=^${prefix}`], cliEnv)
      return stdout.split('\n').map(s => s.trim()).filter(Boolean)
    },
  }
}

export function backoffMs(failures: number, base: number, max: number): number {
  return Math.min(base * 2 ** Math.max(0, failures - 1), max)
}

export interface LauncherDeps {
  settings: LauncherSettings
  aws: AwsOps
  docker: DockerOps
  log(event: string, fields?: Record<string, unknown>): void
  now(): number
  randomKey(): Buffer
}

const errorLine = (error: unknown) => redactSecrets((error instanceof Error ? error.message : String(error)).split('\n')[0]).slice(0, 300)
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

async function fetchSecrets(deps: LauncherDeps): Promise<Record<(typeof SECRET_NAMES)[number], string>> {
  const reader = await deps.aws.assumeRole(deps.settings.readerRoleArn, 'slack-review-bot-launcher', READER_SESSION_SECONDS)
  const out = {} as Record<(typeof SECRET_NAMES)[number], string>
  for (const name of SECRET_NAMES) out[name] = await deps.aws.getSecret(reader, SECRET_IDS[name])
  return out
}

async function workerBundle(deps: LauncherDeps, engineToken: string, slot: number, ticket?: string): Promise<string> {
  const seconds = engineSessionSeconds(deps.settings.runTimeoutMs)
  const creds = await deps.aws.assumeRole(deps.settings.engineRoleArn, engineSessionName(`worker-${slot}-${deps.now()}`), seconds)
  if (!creds.sessionToken) throw new Error('the engine role returned no session token')
  const npmToken = await deps.aws.codeartifactToken(seconds)
  return encodeSecretBundle({
    ENGINE_GH_TOKEN: engineToken,
    AWS_ACCESS_KEY_ID: creds.accessKeyId,
    AWS_SECRET_ACCESS_KEY: creds.secretAccessKey,
    AWS_SESSION_TOKEN: creds.sessionToken,
    NPM_TOKEN: npmToken,
    ...(ticket ? { WORKER_TICKET: ticket } : {}),
  })
}

export function createLauncher(deps: LauncherDeps): { start(): Promise<number>; requestStop(): void } {
  const { settings, docker, log } = deps
  let stopping = false
  let stopRequested = false
  let signalStop!: () => void
  const stopSignal = new Promise<void>(resolve => (signalStop = resolve))
  const running = new Map<number, RunningContainer>()
  const pause = (ms: number) => Promise.race([sleep(ms), stopSignal])

  async function workerLoop(slot: number, key: Buffer, engineToken: string): Promise<void> {
    let failures = 0
    while (!stopping) {
      let bundle: string
      try {
        bundle = await workerBundle(deps, engineToken, slot, mintTicket(key, deps.now()))
        failures = 0
      } catch (error) {
        failures += 1
        const waitMs = backoffMs(failures, settings.backoffBaseMs, settings.backoffMaxMs)
        log('launcher.mint_failed', { slot, failures, waitMs, error: errorLine(error) })
        await pause(waitMs)
        continue
      }
      if (stopping) break
      const worker = docker.run('worker', `${WORKER_PREFIX}${slot}`, bundle)
      running.set(slot, worker)
      const code = await worker.exited
      running.delete(slot)
      log('launcher.worker_exited', { slot, code })
      await pause(settings.workerRestartMs)
    }
  }

  /** Only ever called once the orchestrator has exited. */
  async function stopWorkers(): Promise<void> {
    const workers = [...running.values()]
    await Promise.all(workers.map(w => docker.signal(w.name, 'SIGTERM')))
    const allExited = Promise.all(workers.map(w => w.exited))
    await Promise.race([allExited, sleep(settings.workerStopGraceMs)])
    for (const w of [...running.values()]) await docker.signal(w.name, 'SIGKILL')
    await allExited
  }

  return {
    requestStop() {
      if (stopRequested) {
        log('launcher.signal_ignored', { hint: 'already draining; the orchestrator decides when to force' })
        return
      }
      stopRequested = true
      log('launcher.stopping', {})
      signalStop()
    },

    async start() {
      let secrets: Record<(typeof SECRET_NAMES)[number], string>
      try {
        secrets = await fetchSecrets(deps)
      } catch (error) {
        log('launcher.secrets_failed', { error: errorLine(error) })
        return 1
      }
      if (secrets.APPROVER_GH_TOKEN === secrets.ENGINE_GH_TOKEN) {
        log('launcher.tokens_identical', { hint: 'APPROVER_GH_TOKEN and ENGINE_GH_TOKEN must be different tokens' })
        return 1
      }
      const key = deps.randomKey()
      if (key.length !== LAUNCH_KEY_BYTES) throw new Error('LAUNCH_KEY must be 32 bytes')

      // Ruling 10: the old orchestrator first (it may still be reviewing), then old workers.
      await docker.removeForce(ORCHESTRATOR_NAME)
      for (const name of await docker.listByPrefix(WORKER_PREFIX)) await docker.removeForce(name)

      const orchestrator = docker.run(
        'orchestrator',
        ORCHESTRATOR_NAME,
        encodeSecretBundle({
          SLACK_BOT_TOKEN: secrets.SLACK_BOT_TOKEN,
          SLACK_APP_TOKEN: secrets.SLACK_APP_TOKEN,
          APPROVER_GH_TOKEN: secrets.APPROVER_GH_TOKEN,
          LAUNCH_KEY: key.toString('base64url'),
        })
      )
      log('launcher.started', { slots: settings.workerSlots })
      const loops = Array.from({ length: settings.workerSlots }, (_, slot) => workerLoop(slot, key, secrets.ENGINE_GH_TOKEN))

      const first = await Promise.race([orchestrator.exited.then(code => ({ kind: 'exited' as const, code })), stopSignal.then(() => ({ kind: 'stop' as const }))])
      stopping = true
      if (first.kind === 'exited') {
        // Ruling 11: nothing is left to drain for; stop the workers and let launchd restart us.
        log('launcher.orchestrator_exited', { code: first.code })
        await stopWorkers()
        await Promise.all(loops)
        return 1
      }
      // Spec 3.6 step 3: drain first. Only the orchestrator is signalled, once.
      await docker.signal(ORCHESTRATOR_NAME, 'SIGTERM')
      const bound = settings.shutdownDrainMs + settings.shutdownGraceMs + settings.hardBoundSlackMs
      const exitedInTime = await Promise.race([orchestrator.exited.then(() => true), sleep(bound).then(() => false)])
      if (!exitedInTime) {
        log('launcher.orchestrator_kill', { boundMs: bound })
        await docker.signal(ORCHESTRATOR_NAME, 'SIGKILL')
      }
      const code = await orchestrator.exited
      log('launcher.orchestrator_stopped', { code })
      await stopWorkers()
      await Promise.all(loops)
      return 0
    },
  }
}

/** `launcher doctor orchestrator|worker`: run the container doctor with a real bundle (spec 3.7). */
export async function runDoctor(deps: LauncherDeps, role: 'orchestrator' | 'worker'): Promise<number> {
  const secrets = await fetchSecrets(deps)
  if (role === 'worker') {
    const bundle = await workerBundle(deps, secrets.ENGINE_GH_TOKEN, 0)
    return deps.docker.run('worker', 'slack-review-bot-doctor-worker', bundle, ['doctor', '--role', 'worker']).exited
  }
  const bundle = encodeSecretBundle({
    SLACK_BOT_TOKEN: secrets.SLACK_BOT_TOKEN,
    SLACK_APP_TOKEN: secrets.SLACK_APP_TOKEN,
    APPROVER_GH_TOKEN: secrets.APPROVER_GH_TOKEN,
    // A throwaway key: the doctor verifies no ticket.
    LAUNCH_KEY: deps.randomKey().toString('base64url'),
  })
  return deps.docker.run('orchestrator', 'slack-review-bot-doctor-orchestrator', bundle, ['doctor', '--role', 'orchestrator']).exited
}

export const defaultRandomKey = () => randomBytes(LAUNCH_KEY_BYTES)
```

- [ ] **Step 4: Write the launcher entrypoint and wrapper**

Create `src/launcher-main.ts`:

```ts
// Host launcher entrypoint (dist/launcher.js), run by scripts/launcher under launchd.

import { createLauncher, defaultRandomKey, loadLauncherSettings, makeAwsOps, makeDockerOps, runDoctor, type LauncherDeps } from './launcher'

function log(event: string, fields: Record<string, unknown> = {}): void {
  process.stdout.write(`${JSON.stringify({ time: new Date().toISOString(), event, ...fields })}\n`)
}

async function main(): Promise<number> {
  const settings = loadLauncherSettings(process.env)
  const deps: LauncherDeps = {
    settings,
    aws: makeAwsOps(settings),
    docker: makeDockerOps(settings, process.env),
    log,
    now: Date.now,
    randomKey: defaultRandomKey,
  }
  const [command, role] = process.argv.slice(2)
  if (command === 'doctor') {
    if (role !== 'orchestrator' && role !== 'worker') {
      process.stderr.write('usage: launcher doctor orchestrator|worker\n')
      return 2
    }
    return runDoctor(deps, role)
  }
  if (command !== undefined) {
    process.stderr.write('usage: launcher [doctor orchestrator|worker]\n')
    return 2
  }
  const launcher = createLauncher(deps)
  for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => launcher.requestStop())
  return launcher.start()
}

main().then(
  code => process.exit(code),
  error => {
    log('launcher.fatal', { error: String(error instanceof Error ? error.message : error).split('\n')[0] })
    process.exit(1)
  }
)
```

Create `scripts/launcher`:

```bash
#!/usr/bin/env bash
# Thin wrapper around the TypeScript launcher (ruling 9). Usage: scripts/launcher [doctor orchestrator|worker]
#
# Loads the non-secret settings file here, not in the LaunchAgent, so every entry path (launchd,
# and a terminal `scripts/launcher doctor worker`) sees the same settings, including the required
# ROLE_GH_LOGIN and OPERATOR_GH_LOGIN. A file naming a secret variable is refused, as in
# scripts/install-launcher.sh: secrets come from Secrets Manager only.
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." > /dev/null 2>&1 && pwd)"
CONF="${SLACK_REVIEW_BOT_LAUNCHER_CONF:-${HOME}/.config/slack-review-bot/launcher.conf}"
if [ ! -f "${REPO}/dist/launcher.js" ]; then
    echo "ERROR: ${REPO}/dist/launcher.js not found. Run 'npm ci && npm run build' first." >&2
    exit 1
fi
if [ -f "${CONF}" ]; then
    if grep -qE '^[[:space:]]*(export[[:space:]]+)?[A-Za-z_]*(TOKEN|SECRET|LAUNCH_KEY|WORKER_TICKET|AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY)[A-Za-z_]*=' "${CONF}"; then
        echo "ERROR: ${CONF} sets a secret variable; secrets come from Secrets Manager only." >&2
        exit 1
    fi
    set -a
    # shellcheck source=/dev/null
    . "${CONF}"
    set +a
fi
exec node "${REPO}/dist/launcher.js" "$@"
```

In `package.json`, replace:

```json
    "build": "esbuild app=src/app.ts worker=src/worker-main.ts orchestrator=src/orchestrator-main.ts doctor=src/doctor.ts --bundle --platform=node --target=node22 --format=cjs --outdir=dist --sourcemap",
```

with:

```json
    "build": "esbuild app=src/app.ts worker=src/worker-main.ts orchestrator=src/orchestrator-main.ts doctor=src/doctor.ts launcher=src/launcher-main.ts --bundle --platform=node --target=node22 --format=cjs --outdir=dist --sourcemap",
```

- [ ] **Step 5: Write the LaunchAgent and its installer**

Create `launchd/com.abarnett.slack-review-bot-launcher.plist.template`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!--
  TEMPLATE: scripts/install-launcher.sh substitutes __LABEL__, __LAUNCHER__, __DIR__, __LOG_DIR__,
  __CONF__ and __PATH_PREFIX__. The conf file holds NON-SECRET settings only (the installer refuses
  one naming a secret variable); every secret comes from Secrets Manager at start.
-->
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>__LABEL__</string>

    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>-c</string>
        <string>export PATH="__PATH_PREFIX__:$PATH"; export SLACK_REVIEW_BOT_LAUNCHER_CONF="__CONF__"; exec "__LAUNCHER__"</string>
    </array>

    <key>WorkingDirectory</key>
    <string>__DIR__</string>

    <key>RunAtLoad</key>
    <true/>

    <!-- The launcher exits 1 when the orchestrator dies; restart the whole stack with fresh secrets. -->
    <key>KeepAlive</key>
    <true/>

    <key>ThrottleInterval</key>
    <integer>30</integer>

    <!-- Drain (SHUTDOWN_DRAIN_MS) + grace + 30 s hard bound + 30 s for workers, with margin. -->
    <key>ExitTimeOut</key>
    <integer>150</integer>

    <key>StandardOutPath</key>
    <string>__LOG_DIR__/slack-review-bot-launcher.out.log</string>

    <key>StandardErrorPath</key>
    <string>__LOG_DIR__/slack-review-bot-launcher.err.log</string>

    <key>ProcessType</key>
    <string>Background</string>
</dict>
</plist>
```

Create `scripts/install-launcher.sh`:

```bash
#!/usr/bin/env bash
#
# Install and load the container-runtime launcher LaunchAgent (spec 3.6).
#
# Usage:
#   scripts/install-launcher.sh             # render, load and start
#   scripts/install-launcher.sh --check     # verify prerequisites only
#   scripts/install-launcher.sh --uninstall
#
# Settings come from ~/.config/slack-review-bot/launcher.conf (override with
# SLACK_REVIEW_BOT_LAUNCHER_CONF): non-secret KEY=value lines such as REVIEW_ENGINES, CONCURRENCY,
# SLACK_CHANNEL_IDS, ROLE_GH_LOGIN and OPERATOR_GH_LOGIN. A line naming a secret variable is refused.

set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." > /dev/null 2>&1 && pwd)"
LABEL="com.abarnett.slack-review-bot-launcher"
PLIST="${HOME}/Library/LaunchAgents/${LABEL}.plist"
CONF="${SLACK_REVIEW_BOT_LAUNCHER_CONF:-${HOME}/.config/slack-review-bot/launcher.conf}"
LOG_DIR="${HOME}/Library/Logs"
LAUNCHER="${DIR}/scripts/launcher"
MODE="install"

case "${1:-}" in
    --uninstall) MODE="uninstall" ;;
    --check) MODE="check" ;;
    "") ;;
    *)
        echo "unknown argument: $1" >&2
        exit 2
        ;;
esac

if [ "${MODE}" = "uninstall" ]; then
    launchctl bootout "gui/$(id -u)/${LABEL}" 2> /dev/null || true
    rm -f "${PLIST}"
    echo "uninstalled ${LABEL}"
    exit 0
fi

fail=0
if [ ! -f "${DIR}/dist/launcher.js" ]; then
    echo "ERROR: ${DIR}/dist/launcher.js not found. Run 'npm ci && npm run build' first." >&2
    fail=1
fi
if [ -f "${CONF}" ] && grep -qE '^[[:space:]]*(export[[:space:]]+)?[A-Za-z_]*(TOKEN|SECRET|LAUNCH_KEY|WORKER_TICKET|AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY)[A-Za-z_]*=' "${CONF}"; then
    echo "ERROR: ${CONF} sets a secret variable; secrets come from Secrets Manager only." >&2
    fail=1
fi
if [ -f "${HOME}/Library/LaunchAgents/com.abarnett.slack-review-bot.plist" ]; then
    echo "ERROR: the launchd daemon is still installed; run scripts/install-service.sh --uninstall first." >&2
    fail=1
fi
for tool in docker node aws; do
    if ! command -v "${tool}" > /dev/null 2>&1; then
        echo "ERROR: ${tool} is not on PATH" >&2
        fail=1
    fi
done
if [ "${fail}" -ne 0 ]; then
    exit 1
fi

# The PATH launchd will use: the directories holding docker, node and aws, verified below.
PATH_PREFIX="$(dirname "$(command -v docker)"):$(dirname "$(command -v node)"):$(dirname "$(command -v aws)")"
if ! env -i HOME="${HOME}" PATH="${PATH_PREFIX}:/usr/bin:/bin:/usr/sbin:/sbin" /bin/bash -c 'command -v docker && command -v node && command -v aws' > /dev/null; then
    echo "ERROR: docker, node or aws does not resolve under the launchd PATH ${PATH_PREFIX}" >&2
    exit 1
fi

if [ "${MODE}" = "check" ]; then
    echo "launcher prerequisites look correct (conf ${CONF}, PATH ${PATH_PREFIX})"
    exit 0
fi

mkdir -p "$(dirname "${PLIST}")" "${LOG_DIR}"
sed -e "s|__LABEL__|${LABEL}|g" \
    -e "s|__LAUNCHER__|${LAUNCHER}|g" \
    -e "s|__DIR__|${DIR}|g" \
    -e "s|__LOG_DIR__|${LOG_DIR}|g" \
    -e "s|__CONF__|${CONF}|g" \
    -e "s|__PATH_PREFIX__|${PATH_PREFIX}|g" \
    "${DIR}/launchd/${LABEL}.plist.template" > "${PLIST}"
launchctl bootout "gui/$(id -u)/${LABEL}" 2> /dev/null || true
launchctl bootstrap "gui/$(id -u)" "${PLIST}"
echo "installed and started ${LABEL}; logs in ${LOG_DIR}/slack-review-bot-launcher.*.log"
```

- [ ] **Step 6: Run the tests and the build**

Run: `chmod +x scripts/launcher scripts/install-launcher.sh && npx ts-node --compiler-options '{"module":"commonjs"}' --transpile-only src/launcher.test.ts`
Expected: PASS (all ten tests).

Run: `npm test && npm run typecheck && npm run build && ls dist/launcher.js`
Expected: every suite passes; typecheck exit 0; `dist/launcher.js` listed.

Run: `scripts/launcher bogus; echo "exit $?"`
Expected: `usage: launcher [doctor orchestrator|worker]` and `exit 2`.

The next two checks pin that the wrapper itself loads the settings file, so a terminal `scripts/launcher doctor worker` sees the same settings as launchd, and that it refuses a secret. A stand-in `node` first on `PATH` prints what the wrapper exported, without running the real launcher:

Run: `mkdir -p /tmp/srb-fake-node && printf '#!/bin/sh\necho "ROLE_GH_LOGIN=${ROLE_GH_LOGIN:-unset}"\n' > /tmp/srb-fake-node/node && chmod +x /tmp/srb-fake-node/node && printf 'ROLE_GH_LOGIN=probe-login\n' > /tmp/srb-conf-ok && SLACK_REVIEW_BOT_LAUNCHER_CONF=/tmp/srb-conf-ok PATH="/tmp/srb-fake-node:$PATH" scripts/launcher doctor worker`
Expected: `ROLE_GH_LOGIN=probe-login`.

Run: `printf 'GH_TOKEN=placeholder\n' > /tmp/srb-conf-secret && SLACK_REVIEW_BOT_LAUNCHER_CONF=/tmp/srb-conf-secret PATH="/tmp/srb-fake-node:$PATH" scripts/launcher doctor worker; echo "exit $?"`
Expected: `ERROR: /tmp/srb-conf-secret sets a secret variable; secrets come from Secrets Manager only.` and `exit 1`. The stand-in `node` never runs.

Run: `scripts/install-launcher.sh --check`
Expected on a laptop that still runs the launchd daemon: `ERROR: the launchd daemon is still installed ...` and exit 1 (the cutover in Task 15 uninstalls it first). Otherwise `launcher prerequisites look correct ...`.

- [ ] **Step 7: Commit**

Write `/tmp/srb-commit-msg.txt`:

```text
feat(launcher): add the host launcher that supervises the containers (refs andrew-barnett/slack-review-bot#70)

The launcher alone holds the operator's AWS login. It fetches the bot's
secrets, mints per-worker engine credentials and tickets, writes each
container's secrets to its stdin, and on shutdown drains the orchestrator
before it ever signals a worker.

[cc](https://claude.com/claude-code)
```

Run: `git add package.json src/launcher.ts src/launcher-main.ts src/launcher.test.ts scripts/launcher scripts/install-launcher.sh launchd/com.abarnett.slack-review-bot-launcher.plist.template && git commit -F /tmp/srb-commit-msg.txt`

---

### Task 14: Compose smoke test

**Files:**
- Create: `scripts/smoke/stub-codex.js`, `src/smoke.ts`, `scripts/compose-smoke.sh`
- Modify: `src/orchestrator.ts`, `src/orchestrator-main.ts`
- Test: `src/orchestrator.test.ts` (append); the smoke itself is the integration test (spec section 6)

**Interfaces:**
- Consumes: Task 4 `RemoteRunners`, `CLAIMED_LINE`; Task 9 `startContainerRuntime({ smoke })`, `orchestratorConfig`; Task 2 `mintTicket`; Task 5 `encodeSecretBundle`.
- Produces:
  - `interface SmokeReply { runId: string; results: unknown[]; lines: string[] }`
  - `smokeJob(config: ReviewConfig): (runners: RemoteRunners) => () => Promise<SmokeReply>` (src/orchestrator.ts)
  - `SMOKE=1` on the orchestrator: job server and `/v1/smoke/submit` only, no Slack.
  - `scripts/compose-smoke.sh` (host): exits 0 on success.

- [ ] **Step 1: Write the failing test**

Append to `src/orchestrator.test.ts`:

```ts
// The smoke job is one canned Codex attempt through the remote runner, under the worker's worktree
// root, and it reports every status line it saw so the smoke can check the progress stream.
test('smokeJob submits one codex job and reports results and status lines', async t => {
  const { config } = orchestratorConfig(bundle, { HOME: '/home/bot', WORKTREE_ROOT: '/work/wt' })
  const seen: Record<string, unknown>[] = []
  const runners = {
    runCodex: async (options: { worktreeRoot: string; runId: string; onProgress?: (line: string, activeMs: number) => void }) => {
      seen.push(options)
      options.onProgress?.('a worker claimed the job', 0)
      options.onProgress?.('stub-codex: reviewing\n', 5)
      return { result: { results: [] }, rawFinalMessage: '', activeMs: 5 }
    },
    runClaude: async () => {
      throw new Error('not used')
    },
  }
  const reply = await smokeJob(config)(runners as never)()
  t.equal(seen[0].worktreeRoot, '/work/wt/codex')
  t.match(String(seen[0].runId), /^smoke-\d+$/)
  t.deepEqual(reply.results, [])
  t.deepEqual(reply.lines, ['a worker claimed the job', 'stub-codex: reviewing\n'])
  t.end()
})
```

In the same file, replace:

```ts
import { orchestratorConfig } from './orchestrator'
```

with:

```ts
import { orchestratorConfig, smokeJob } from './orchestrator'
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx ts-node --compiler-options '{"module":"commonjs"}' --transpile-only src/orchestrator.test.ts`
Expected: FAIL with `smokeJob is not a function`.

- [ ] **Step 3: Add the smoke job and the SMOKE=1 mode**

In `src/orchestrator.ts`, replace:

```ts
import { loadConfig, type Config } from './config'
import { LAUNCH_KEY_BYTES } from './jobs/ticket'
```

with:

```ts
import * as path from 'path'
import { loadConfig, type Config, type ReviewConfig } from './config'
import type { RemoteRunners } from './jobs/remote'
import { LAUNCH_KEY_BYTES } from './jobs/ticket'

export interface SmokeReply {
  runId: string
  results: unknown[]
  lines: string[]
}

/**
 * SMOKE=1 only (spec section 6): one canned Codex attempt through the job broker. The worker runs
 * it with a stub engine binary; the reply carries the results and every status line seen.
 */
export function smokeJob(config: ReviewConfig): (runners: RemoteRunners) => () => Promise<SmokeReply> {
  return runners => async () => {
    const runId = `smoke-${Date.now()}`
    const lines: string[] = []
    const outcome = await runners.runCodex({
      prompt: 'smoke test: report no results',
      codexBin: 'codex',
      profile: config.codexProfile,
      workspaceRoot: config.workspaceRoot,
      worktreeRoot: path.join(config.worktreeRoot, 'codex'),
      timeoutMs: 120_000,
      disableGitSigning: true,
      runId,
      onProgress: line => void lines.push(line),
    })
    return { runId, results: outcome.result.results, lines }
  }
}
```

In `src/orchestrator-main.ts`, replace:

```ts
import { orchestratorConfig } from './orchestrator'
```

with:

```ts
import { orchestratorConfig, smokeJob } from './orchestrator'
```

Replace:

```ts
  const { config, launchKey } = orchestratorConfig(bundle, process.env)
  const container = await startContainerRuntime(config, launchKey, log)
  await runDaemon({ config, container })
}
```

with:

```ts
  const { config, launchKey } = orchestratorConfig(bundle, process.env)
  if (process.env.SMOKE === '1') {
    // The job server and the smoke route only; no Slack connection (spec section 6).
    const smoke = await startContainerRuntime(config, launchKey, log, { smoke: smokeJob(config) })
    log('smoke.ready', { port: smoke.port() })
    await new Promise<void>(resolve => process.once('SIGTERM', () => resolve()))
    await smoke.close()
    process.exit(0)
  }
  const container = await startContainerRuntime(config, launchKey, log)
  await runDaemon({ config, container })
}
```

- [ ] **Step 4: Write the stub engine and the smoke driver**

Create `scripts/smoke/stub-codex.js`:

```js
#!/usr/bin/env node
// Stub engine for scripts/compose-smoke.sh: prints one progress line and writes an empty, valid
// report-only result to the path after --output-last-message. It reads nothing and calls nothing.
'use strict'
const fs = require('fs')

const args = process.argv.slice(2)
const at = args.indexOf('--output-last-message')
if (at < 0 || !args[at + 1]) {
  console.error('stub-codex: no --output-last-message')
  process.exit(2)
}
console.log('stub-codex: reviewing')
fs.writeFileSync(args[at + 1], JSON.stringify({ results: [] }))
```

Create `src/smoke.ts`:

```ts
// Host-side compose smoke (spec section 6), run by scripts/compose-smoke.sh with ts-node. Starts an
// orchestrator in SMOKE=1 mode and one worker with a stub engine, both with dummy bundles (no real
// credential is involved), submits one job, and checks the result, the status lines and the run
// log. Uses its own Compose project and container names, so it never touches the real stack.

import { execFileSync, spawn, type ChildProcess } from 'child_process'
import { randomBytes } from 'crypto'
import * as path from 'path'
import { mintTicket } from './jobs/ticket'
import { encodeSecretBundle } from './secret-bundle'

const ROOT = path.join(__dirname, '..')
const PROJECT = 'slack-review-bot-smoke'
const ORCH = 'srb-smoke-orchestrator'
const WORKER = 'srb-smoke-worker'
const compose = (args: string[]) => ['compose', '-f', path.join(ROOT, 'compose.yaml'), '-p', PROJECT, ...args]
const dummy = (name: string) => `smoke-${name}-not-a-credential`

function docker(args: string[]): string {
  return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] })
}

function start(args: string[], bundle: string): { child: ChildProcess; exited: Promise<number> } {
  const child = spawn('docker', args, { stdio: ['pipe', 'inherit', 'inherit'] })
  child.stdin?.end(bundle)
  return { child, exited: new Promise(resolve => child.on('exit', code => resolve(code ?? 1))) }
}

/** `node -e` inside the orchestrator container, against its own job server. */
function inOrchestrator(script: string): string {
  return docker(['exec', ORCH, 'node', '-e', script])
}

async function waitForHealth(): Promise<void> {
  for (let i = 0; i < 60; i += 1) {
    try {
      inOrchestrator("fetch('http://127.0.0.1:8080/healthz').then(r => process.exit(r.status === 200 ? 0 : 1), () => process.exit(1))")
      return
    } catch {
      await new Promise(resolve => setTimeout(resolve, 1000))
    }
  }
  throw new Error('the orchestrator did not answer /healthz within 60 s')
}

function teardown(): void {
  for (const name of [ORCH, WORKER]) {
    try {
      docker(['rm', '-f', name])
    } catch {
      // Not running.
    }
  }
  try {
    docker(compose(['down', '-v']))
  } catch {
    // Nothing to remove.
  }
}

async function main(): Promise<void> {
  teardown()
  const key = randomBytes(32)
  const orch = start(
    compose(['run', '--rm', '-T', '--name', ORCH, '-e', 'SMOKE=1', 'orchestrator']),
    encodeSecretBundle({ SLACK_BOT_TOKEN: dummy('bot'), SLACK_APP_TOKEN: dummy('app'), APPROVER_GH_TOKEN: dummy('approver'), LAUNCH_KEY: key.toString('base64url') })
  )
  try {
    await waitForHealth()
    const worker = start(
      compose([
        'run', '--rm', '-T', '--name', WORKER,
        '-e', `ORCHESTRATOR_URL=http://${ORCH}:8080`,
        '-e', 'CODEX_BIN=/app/scripts/smoke/stub-codex.js',
        '-e', 'WORKER_IDLE_EXIT_MS=60000',
        'worker',
      ]),
      encodeSecretBundle({
        ENGINE_GH_TOKEN: dummy('engine'),
        AWS_ACCESS_KEY_ID: dummy('id'),
        AWS_SECRET_ACCESS_KEY: dummy('key'),
        AWS_SESSION_TOKEN: dummy('session'),
        NPM_TOKEN: dummy('npm'),
        WORKER_TICKET: mintTicket(key, Date.now()),
      })
    )
    const reply = JSON.parse(
      inOrchestrator("fetch('http://127.0.0.1:8080/v1/smoke/submit', { method: 'POST' }).then(r => r.text()).then(t => process.stdout.write(t))")
    ) as { runId?: string; results?: unknown[]; lines?: string[]; error?: unknown }
    if (!Array.isArray(reply.results) || reply.results.length !== 0) throw new Error(`unexpected smoke reply: ${JSON.stringify(reply)}`)
    if (!reply.lines?.includes('a worker claimed the job')) throw new Error('the claimed status line never arrived')
    if (!reply.lines.some(line => line.includes('stub-codex: reviewing'))) throw new Error("the stub's progress line never arrived")
    const log = inOrchestrator(`process.stdout.write(require('fs').readFileSync('/var/lib/slack-review-bot/runs/${reply.runId}.log', 'utf8'))`)
    if (!log.includes('stub-codex: reviewing')) throw new Error('the run log was not shipped to the orchestrator')
    const workerCode = await worker.exited
    if (workerCode !== 0) throw new Error(`the worker exited ${workerCode}`)
    process.stdout.write('compose smoke passed: result, status lines and run log all arrived\n')
  } finally {
    try {
      docker(['kill', '--signal', 'SIGTERM', ORCH])
    } catch {
      // Already gone.
    }
    await orch.exited
    teardown()
  }
}

main().catch(error => {
  process.stderr.write(`compose smoke FAILED: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
})
```

Create `scripts/compose-smoke.sh`:

```bash
#!/usr/bin/env bash
#
# Local integration smoke for the container runtime (spec section 6). Builds the image, then runs
# src/smoke.ts: an orchestrator in SMOKE=1 mode and one worker with a stub engine, dummy secrets
# only, in their own Compose project. Not run in CI (it needs Docker).
#
# Usage: scripts/compose-smoke.sh [--no-build]

set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." > /dev/null 2>&1 && pwd)"
if [ "${1:-}" != "--no-build" ]; then
    "${REPO}/scripts/build-image.sh"
fi
cd "${REPO}"
exec npx ts-node --compiler-options '{"module":"commonjs"}' --transpile-only src/smoke.ts
```

- [ ] **Step 5: Run the unit test, then the smoke**

Run: `chmod +x scripts/smoke/stub-codex.js scripts/compose-smoke.sh && npx ts-node --compiler-options '{"module":"commonjs"}' --transpile-only src/orchestrator.test.ts`
Expected: PASS (four tests).

Run: `npm run typecheck && npm run build`
Expected: exit 0.

Commit first (the image is built from `git archive HEAD`, so the stub must be committed), then run the smoke:

Write `/tmp/srb-commit-msg.txt`:

```text
feat(orchestrator): add a SMOKE=1 mode and the compose smoke (refs andrew-barnett/slack-review-bot#70)

An orchestrator in SMOKE=1 mode and one worker with a stub engine run one
job end to end with dummy secrets, in their own Compose project, and the
smoke checks the result, the status lines and the shipped run log.

[cc](https://claude.com/claude-code)
```

Run: `git add scripts/smoke/stub-codex.js scripts/compose-smoke.sh src/smoke.ts src/orchestrator.ts src/orchestrator-main.ts src/orchestrator.test.ts && git commit -F /tmp/srb-commit-msg.txt`

Run: `scripts/compose-smoke.sh`
Expected: the image builds, then `compose smoke passed: result, status lines and run log all arrived`, exit 0. If it fails, fix the cause in a new commit (never amend) and rerun.

---

### Task 15: README, settings and cutover

**Files:**
- Modify: `README.md`

**Interfaces:**
- Consumes: every setting and script name from Tasks 6, 9 to 14.
- Produces: the operator documentation for the container runtime.

- [ ] **Step 1: Add the container runtime section**

In `README.md`, replace:

```markdown
## Swapping the review model
```

with:

````markdown
## Container runtime (`RUNTIME=container`)

The container runtime splits the bot in two (https://github.com/andrew-barnett/slack-review-bot/issues/70):

- **Orchestrator** (one long-lived container): the Slack daemon. It holds the Slack tokens and the approver token, never runs PR code, and serves jobs to workers on an internal network.
- **Workers** (one-shot containers): each claims one engine attempt, runs it with a read-only GitHub token, a short-lived Bedrock-only AWS session and an npm read token, reports the result and exits.

A **launcher** on the laptop (`scripts/launcher`, run by launchd) is the only process holding the operator's AWS login. It reads the bot's secrets from Secrets Manager (`/slack-review-bot/SLACK_BOT_TOKEN`, `/slack-review-bot/SLACK_APP_TOKEN`, `/slack-review-bot/APPROVER_GH_TOKEN`, `/slack-review-bot/ENGINE_GH_TOKEN`) through `SlackReviewBotSecretsReaderRole`, mints a fresh `SlackReviewBotEngineRole` session and CodeArtifact token per worker, and writes each container's secrets to its stdin. No secret is in the image, `compose.yaml`, `docker inspect`, or any file.

**Behaviour change (spec D8).** In the container runtime every review is report-only, single mode included: the orchestrator posts one COMMENT review per PR as the role account. A clean result reacts with `APPROVAL_NOT_COUNTED_EMOJI` (never the approval stamp) and counts as a pass in `status`. Regression tests are not pushed to the PR branch; they come back as suggested tests in the findings. The launchd runtime is unchanged.

### Settings

Non-secret settings live in `~/.config/slack-review-bot/launcher.conf` (override the path with `SLACK_REVIEW_BOT_LAUNCHER_CONF`). `scripts/install-launcher.sh` refuses a file that sets any variable whose name contains `TOKEN` or `SECRET`, or `LAUNCH_KEY`, `WORKER_TICKET`, `AWS_ACCESS_KEY_ID` or `AWS_SECRET_ACCESS_KEY`.

| Variable | Default | Meaning |
|---|---|---|
| `REVIEW_ENGINES` | `codex` | `codex`, `claude` (container runtime only) or `codex,claude` (still behind `DUAL_MODE_AVAILABLE`). |
| `SLACK_CHANNEL_IDS` | (required) | As for the launchd runtime. |
| `CONCURRENCY` | `1` | Reviews at once. |
| `WORKER_SLOTS` | `2 × CONCURRENCY` | Workers kept warm, so a parallel dual run gets one per engine. |
| `WORKER_IDLE_EXIT_MS` | `600000` | A worker with no job after this long exits, and the launcher starts a fresh one with fresh credentials. |
| `WORKER_MEMORY` | `6g` | Worker memory limit. An out-of-memory kill shows up as "worker lost". |
| `ROLE_GH_LOGIN` | (required for doctor) | The role account's GitHub login; each container's doctor checks its token is this account. |
| `OPERATOR_GH_LOGIN` | (required for doctor) | Your own GitHub login; each doctor checks its token is not this account. |
| `LAUNCHER_AWS_PROFILE` | `staging` | The operator profile the launcher assumes both roles from (an IAM user, never a role, so nothing is chained). |
| `LAUNCHER_REGION` | `us-east-2` | Region for STS and Secrets Manager. |
| `LAUNCHER_READER_ROLE_ARN` | `arn:aws:iam::153538148884:role/SlackReviewBotSecretsReaderRole` | Reads `/slack-review-bot/*`. |
| `LAUNCHER_ENGINE_ROLE_ARN` | `arn:aws:iam::153538148884:role/SlackReviewBotEngineRole` | Invokes Bedrock models only. |
| `SHUTDOWN_DRAIN_MS` | `5000` | The orchestrator's drain deadline; the launcher's hard bound is this plus `SHUTDOWN_GRACE_MS` (10 s) plus 30 s. |
| `SRB_IMAGE` | `slack-review-bot:local` | Image tag for build and run. |

Example `launcher.conf`:

```sh
REVIEW_ENGINES=codex
SLACK_CHANNEL_IDS=C0123456789
CONCURRENCY=1
ROLE_GH_LOGIN=example-role-bot
OPERATOR_GH_LOGIN=example-operator
```

### Build, doctor and smoke

1. Pin the skill and hook: `git -C ~/src/aqua-skills fetch origin && git -C ~/src/aqua-skills rev-parse origin/main > docker/aqua-skills.ref`, then commit `docker/aqua-skills.ref`.
2. Build: `npm ci && npm run build && scripts/build-image.sh`. The image is built from the committed tree (`git archive HEAD`); uncommitted edits are not in it.
3. Doctor, with real credentials from the launcher: `scripts/launcher doctor worker` and `scripts/launcher doctor orchestrator`. Both must end with `All checks passed.` The worker checks are the acceptance criteria of https://github.com/andrew-barnett/slack-review-bot/issues/64.
4. Smoke, with dummy secrets and a stub engine: `scripts/compose-smoke.sh` must end with `compose smoke passed`.

### Shutdown

On SIGTERM the launcher stops starting workers and signals the orchestrator only. The orchestrator drains as in "Shutting down" above; a forced drain cancels its jobs, so their workers exit on their own. Only after the orchestrator has exited does the launcher SIGTERM the remaining workers (SIGKILL after 30 s). A second SIGTERM is ignored. The launcher's only escalation is to `docker kill` the orchestrator after the hard bound. If the orchestrator exits on its own, the launcher stops the workers and exits 1, and launchd restarts the whole stack.

### Cutover from the launchd daemon

1. Build the image, then run the worker doctor and the smoke (above).
2. Wait until `@bot status` in Slack shows no active review.
3. Copy the cursor file into the orchestrator's volume:
   `docker compose -f compose.yaml -p slack-review-bot run --rm -T --entrypoint sh orchestrator -c 'cat > /var/lib/slack-review-bot/state/cursors.json' < ~/.local/state/slack-review-bot/cursors.json`
4. Stop the daemon: `scripts/install-service.sh --uninstall`.
5. Write `~/.config/slack-review-bot/launcher.conf` with `REVIEW_ENGINES=codex` for the first reviews, then `scripts/install-launcher.sh --check` and `scripts/install-launcher.sh`.
6. Run `scripts/launcher doctor orchestrator`.
7. First reviews: request reviews of low-risk PRs. Each must get exactly one COMMENT review from the role account and no APPROVE.

**Rollback:** `scripts/install-launcher.sh --uninstall`, then `docker compose -f compose.yaml -p slack-review-bot down` (keep the volumes). If reviews ran in the container runtime, copy the cursor back first:
`docker compose -f compose.yaml -p slack-review-bot run --rm -T --entrypoint cat orchestrator /var/lib/slack-review-bot/state/cursors.json > ~/.local/state/slack-review-bot/cursors.json`.
Then `scripts/install-service.sh`.

## Swapping the review model
````

- [ ] **Step 2: Check the document**

Run: `grep -n "## Container runtime" README.md && grep -c "slack-review-bot-orchestrator\|compose-smoke" README.md`
Expected: the heading line, then a number greater than 0.

Run: `grep -nE '#[0-9]+' README.md | grep -v 'https://github.com' | grep -iv 'issues/' | head -5`
Expected: no line added by this task (every issue reference added here is an absolute URL).

- [ ] **Step 3: Commit**

Write `/tmp/srb-commit-msg.txt`:

```text
docs: document the container runtime, its settings and the cutover (refs andrew-barnett/slack-review-bot#70)

Operators need the launcher settings, the build, doctor and smoke steps,
the shutdown order, and a cutover and rollback that carry the cursor file
across, plus the report-only behaviour change in the container runtime.

[cc](https://claude.com/claude-code)
```

Run: `git add README.md && git commit -F /tmp/srb-commit-msg.txt`

