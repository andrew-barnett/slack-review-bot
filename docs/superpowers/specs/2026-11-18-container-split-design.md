# Design: orchestrator + one-shot worker containers

Status: draft for operator review (2026-11-18). Tracking: https://github.com/andrew-barnett/slack-review-bot/issues/70.
Resolves: https://github.com/andrew-barnett/slack-review-bot/issues/64 (the gate on enabling dual mode) and https://github.com/andrew-barnett/slack-review-bot/issues/34 (split listener and ephemeral worker).
Builds on: https://github.com/andrew-barnett/slack-review-bot/issues/68 (Secrets Manager entries and IAM roles) and https://github.com/andrew-barnett/slack-review-bot/issues/69 (engines on Bedrock).

## 1. Goal

Today one process holds everything: the Slack tokens, the approver token (in dual mode), and the operator's own `gh` and AWS logins. That same process spawns review engines that run untrusted PR code as the same OS user.

This design splits the bot so that **review code never runs where those credentials live**:

- An always-on **orchestrator** holds the Slack tokens, the approver token and the cursor. It never runs PR code.
- A **one-shot worker** runs exactly one engine attempt in a fresh container and then exits. It holds only engine-level credentials, all of which are low-value and short-lived:
  - a read-only GitHub token;
  - a CodeArtifact read token;
  - STS credentials for a role that can only invoke Bedrock models.

The same image runs under Docker Compose on the operator's laptop now, and on ECS Fargate later.

## 2. Decisions

| # | Decision | Why |
|---|---|---|
| D1 | **The seam is the three engine run functions, one worker job per attempt.** `runCodexReview` (single mode), `runCodexReportOnly` and `runClaudeReview` (dual mode) get remote implementations with the same signatures. | Both runners already take these as injection seams (`makeReviewRunner`'s `runCodex`; `EngineDeps.runCodex`/`runClaude`). Retries, serial scheduling, the gate, idempotency, Slack rendering and usage all stay in the orchestrator unchanged. A stall retry gets a fresh container and fresh credentials. |
| D2 | **Workers pull jobs over HTTP from the orchestrator.** The orchestrator never starts containers. | No Docker socket in any container. The same model works on ECS: a worker service whose tasks exit after one job, which ECS replaces with fresh tasks. |
| D3 | **On the laptop, a host supervisor (the launcher) starts each worker with `docker compose run --rm`.** Compose's `restart: always` is not used for workers. | `restart` reuses the same container, keeping its writable layer and the environment it was created with, so expired STS credentials would carry over. `run --rm` gives a fresh filesystem and lets the launcher mint fresh credentials for each worker. |
| D4 | **The container is the sandbox boundary.** Claude Code's sandbox is off in the container profile, and Codex uses `danger-full-access`. The permission deny rules stay. | Spike (2026-11-18, Docker Desktop, `node:22-bookworm-slim`): `bwrap --unshare-all` fails with "No permissions to create new namespace". With `--security-opt seccomp=unconfined` it still fails ("Can't mount proc … Operation not permitted"). Making it work would need a privileged container, which weakens the boundary we rely on, and Fargate does not allow it. This matches the locked decision in https://github.com/andrew-barnett/slack-review-bot/issues/1. |
| D5 | **Secrets come from Secrets Manager through the launcher.** The launcher assumes `SlackReviewBotSecretsReaderRole` for the orchestrator's secrets and `SlackReviewBotEngineRole` once per worker. Each role is assumed directly from the operator's IAM user, never chained. | Only the launcher holds the operator's AWS credentials, and it runs no PR code. Assuming each role directly avoids role chaining's one-hour session cap. |
| D6 | **Codex in the worker hides `AWS_*` from model shells** with `shell_environment_policy.exclude = ["AWS_*"]`. Claude Code's Bash tool cannot do the same. | Verified in the Phase 2a spike. The residual exposure on the Claude side is invoke-only credentials that expire within 4 hours, inside a container holding nothing else of value. |
| D7 | **The worker's workspace starts empty.** The engine clones the PR into the worktree root using the read-only engine token. | `prompt.ts` already tells the engine to `gh repo clone` into `<worktreeRoot>/<repo>-<number>` when no writable checkout exists. No host source tree is mounted into the worker. |

## 3. Components

### 3.1 Image (`Dockerfile`)

- **Base:** `node:22-bookworm-slim`, with a multi-arch build (`linux/arm64` for the laptop, `linux/amd64` for Fargate unless Graviton is chosen).
- **Installed:** `git`, `gh`, `python3` (for the secret-blocking hook), `jq`, `tini` (as PID 1, so detached engine process groups are reaped), the AWS CLI v2 (doctor only; see 3.6), and pinned `@openai/codex` and `@anthropic-ai/claude-code` versions. Pins are bumped by PR, never `latest`.
- **Built into the image:**
  - the bot's own `dist/`;
  - the `review-pr` skill, copied from a pinned `aqua-skills` ref (a build arg) into the Claude profile dir and `$CODEX_HOME/skills`. CI rebuilds when the pin changes;
  - the Claude profile with the container variant of `settings.json` (3.5);
  - the Codex profile with the container variant of the template (3.5).
- **Runs as** a non-root `bot` user (UID 10001). There is no Docker socket and no host home mount.
- **Two entrypoints:** `node dist/orchestrator.js` and `node dist/worker.js`.

### 3.2 Orchestrator

- **Runs:** today's `app.ts` (Socket Mode, the cursor, catch-up, the job queue, the gate, Slack rendering), wired with the remote run functions from 3.3 instead of local spawns.
- **Holds:** `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, `APPROVER_GH_TOKEN` (dual mode), `JOB_SECRET` (3.3), and a `RUN_LOG_DIR` volume.
- **Does not hold:** engine credentials of any kind, or AWS credentials.
  - `ENGINE_GH_TOKEN` is not known to the orchestrator. The dual-mode startup check that the engine token differs from the approver token moves to the launcher, which has both.
  - `CODEARTIFACT_REFRESH=false`: the registry token is the worker's.
- **Job server:** listens on an internal-only Compose network (`jobs`, `internal: true`) and publishes no ports. It also joins a second network with egress, for Slack and GitHub.
- **Cursor:** `CURSOR_FILE` lives on a named volume `orchestrator-state`, mounted only into the orchestrator.

### 3.3 Job protocol (`src/jobs/`)

The protocol is HTTP/1.1 with JSON bodies on the `jobs` network. Every request carries `Authorization: Bearer <JOB_SECRET>`, a random value the launcher generates per boot and gives to both services. It is low value (the network is internal) but stops a stray container from claiming jobs.

| Call | Who | Body / reply |
|---|---|---|
| `POST /v1/claim` | worker | Long-polls up to 25 s. Replies `204` (retry) or `200 {jobId, kind, options}`. `kind` is `codex-review`, `codex-report-only` or `claude-review`. `options` is the run-options object with its function fields removed (`registry`, `log`, `onProgress`). |
| `POST /v1/jobs/:id/progress` | worker | `{line, activeMs}`, forwarded to the job's `onProgress`. Replies `200`, or `409 {cancel: true}` once the orchestrator wants the job stopped. |
| `POST /v1/jobs/:id/heartbeat` | worker | Every 10 s. Same `409` cancel signal. |
| `POST /v1/jobs/:id/result` | worker | `{ok: true, outcome}` or `{ok: false, error: SerializedRunError}`. |
| `POST /v1/jobs/:id/log` | worker | Raw run-log chunks (UTF-8, at most 1 MiB per request, 50 MiB per job), appended to `<RUN_LOG_DIR>/<runId>.log` on the orchestrator. |

**Error round-trip.** `SerializedRunError` is `{class, message, ...fields}` for `CodexStalledError` (snapshot), `CodexTimeoutError` (snapshot), `CodexOutputError` (`activeMs`, `tokensUsed`) and `ClaudeRunError` (`kind`, `activeMs`, `usage`). The remote run function rebuilds the same class, so the existing `instanceof` retry logic needs no change. Any other class comes back as a plain `Error` with a redacted message.

**Worker loss.** If no heartbeat arrives for 45 s, the orchestrator fails the job with `CodexOutputError` / `ClaudeRunError('output')`, using the message "worker lost". That is not a stall, so it isn't retried, matching a local crash.

**Cancellation.** When the orchestrator's shutdown contract (https://github.com/andrew-barnett/slack-review-bot/issues/32) asks running children to die:
- every in-flight job is marked cancelled;
- the worker's next progress or heartbeat call receives `409`, and the worker SIGTERMs, then SIGKILLs, its child registry and exits;
- the remote run function rejects exactly as a locally killed child would.

**Queueing.** A job waits in the orchestrator until a worker claims it. A waiting job is not charged active time. Slack status shows it as waiting for a worker, which reuses the "waiting for a slot" state.

### 3.4 Worker (`src/worker.ts`)

1. Claims one job and starts heartbeats.
2. Calls the local run function with `onProgress` posting progress, a local `ChildRegistry`, and `logDir` set to a temp dir whose log file is streamed to `/log`.
3. Posts the result and exits 0, whatever the result. A claim that never arrives within `WORKER_IDLE_EXIT_MS` (default 10 minutes) exits 0, so the launcher replaces it with fresh credentials.

- **Holds** (as environment, from the launcher):
  - `ENGINE_GH_TOKEN`;
  - `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN` for the engine role;
  - `NPM_TOKEN`, written at startup into a worker-only npmrc (`npm_config_userconfig=/home/bot/.npmrc-worker`) for the `@trade-platform` CodeArtifact scope;
  - `JOB_SECRET`.
- **Config:** `ENGINE_AUTH=bedrock` with no `ENGINE_ROLE_ARN`, which is the "static credentials" mode from Phase 2a.

### 3.5 Profiles in container mode

- **Claude** (`scripts/claude-profile-lib.js`):
  - a `container` render mode with `sandbox.enabled: false`;
  - the same `permissions.deny` Read/Edit rules (for the profile dir and the npmrc path), `dontAsk`, and the secret-blocking hook;
  - `check-claude-profile.js --container` validates that variant by value. It requires the sandbox to be off *and* the bot to be running in a container, detected via `/.dockerenv` or the cgroup.
- **Codex:** a container variant of the template with `sandbox_mode = "danger-full-access"`, no `writable_roots`, `shell_environment_policy.inherit = "all"`, and `exclude = ["AWS_*"]`.

### 3.6 Launcher (`scripts/launcher`, run by launchd on the laptop)

Replaces today's daemon LaunchAgent. It runs under the operator's account and is the only thing holding the operator's AWS credentials.

1. **Start-up:**
   - assume `SlackReviewBotSecretsReaderRole` (from `LAUNCHER_AWS_PROFILE`, default `staging`) and fetch `/slack-review-bot/*`;
   - check `APPROVER_GH_TOKEN` ≠ `ENGINE_GH_TOKEN`;
   - generate `JOB_SECRET`;
   - run `docker compose up -d orchestrator`, passing the orchestrator's secrets as environment-sourced Compose `secrets:`.

   The values exist only in the launcher's memory and in the containers' `/run/secrets` tmpfs. Nothing is written to the host disk.
2. **Worker loop**, with `WORKER_SLOTS` loops in parallel (default `2 × CONCURRENCY`, so a parallel dual run gets one worker per engine). Each iteration:
   - assume `SlackReviewBotEngineRole` (`--duration-seconds` per Phase 2a's `engineSessionSeconds`);
   - mint a CodeArtifact token (domain `trade-platform`, owner `153538148884`, `us-east-2`);
   - run `docker compose run --rm worker` with those values;
   - after the worker exits, back off 1 s, then repeat.

   Failing to mint credentials backs off exponentially (up to 5 minutes) and logs the STS error line, never a credential.
3. **SIGTERM:** forwards a stop to the orchestrator (which runs its shutdown contract) and to the running workers, then exits.

**Credential exposure on the host.** `docker compose run -e` puts values in the container's config, which `docker inspect` can read. On a single-user laptop this is the same trust level as the operator's own shell. Workers instead receive their values as Compose `secrets:` from the launcher's environment, and `worker.ts` reads `/run/secrets/*` and exports them into its own environment before spawning engines.

### 3.7 Doctor

- **New `--role orchestrator|worker` flag.** In a container (detected), the launchd PATH check and the env-file mode check are skipped.
- **`checkRoleIdentity`:** uses `OPERATOR_GH_LOGIN` (a launcher setting) instead of reading the operator's `gh` login, which doesn't exist in a container.
- **Worker checks**, run with `docker compose run --rm worker doctor --role worker`. These are the acceptance criteria of https://github.com/andrew-barnett/slack-review-bot/issues/64:
  - `APPROVER_GH_TOKEN`, `SLACK_BOT_TOKEN` and `SLACK_APP_TOKEN` are absent from the environment, from `/run/secrets`, and from a filesystem grep of `/home/bot` and `/tmp`;
  - `gh auth status` with `GH_TOKEN` unset reports not logged in;
  - `aws sts get-caller-identity` returns `assumed-role/SlackReviewBotEngineRole/…`, and `secretsmanager describe-secret --secret-id /slack-review-bot/SLACK_BOT_TOKEN` is denied;
  - `/proc` lists no process outside the worker's own PID namespace;
  - `/var/run/docker.sock` does not exist.
- **Deliberate-failure tests:** each check has one, run by injecting the condition into a test double, not a live container.

### 3.8 Compose file (`compose.yaml`)

- **Services:** `orchestrator` (networks `jobs` + `egress`, volumes `orchestrator-state` and `runs`) and `worker` (networks `jobs` + `egress`, no volumes, `read_only: false`, `tmpfs: /tmp`).
- **Hardening:** both run with `cap_drop: [ALL]`, `security_opt: [no-new-privileges:true]`, and memory limits (orchestrator 512 MiB; worker `WORKER_MEMORY`, default 6 GiB, because `npm ci` plus tests is heavy).
- **Networks:** `jobs` is `internal: true`.

## 4. ECS mapping (Phase 4, not built here)

| Laptop | ECS |
|---|---|
| launcher fetches orchestrator secrets | Orchestrator task-definition `secrets` (valueFrom Secrets Manager) through the task execution role |
| launcher's worker loop | Worker ECS service, desired count `WORKER_SLOTS`, task exits after one job, and the service replaces it |
| engine role assumed by the launcher | Worker task role = `SlackReviewBotBedrockInvoke` policy (plus CodeArtifact read); credentials via the task metadata endpoint |
| `jobs` internal network | Service Connect / Cloud Map name, with a security group allowing worker → orchestrator on the job port only |
| `orchestrator-state` volume | EFS access point mounted only by the orchestrator |

The worker-side doctor check "no AWS credentials except the engine role" holds on ECS too, because the task role is the engine policy.

## 5. Error handling

| Failure | Behaviour |
|---|---|
| Launcher can't assume the reader role or fetch a secret | Doesn't start the orchestrator. Exits non-zero; launchd's throttle retries. |
| Launcher can't mint engine credentials | That worker slot backs off; queued jobs wait (shown as waiting). The orchestrator is unaffected. |
| Worker crashes or OOMs mid-job | Heartbeat timeout → "worker lost" error → not retried, reported as an engine error. |
| Orchestrator restarts mid-job | The job is lost with the orchestrator's memory (as today). The worker's next call gets `404`, it kills its children and exits. Replay recovers the request from the cursor, per https://github.com/andrew-barnett/slack-review-bot/issues/32. |
| STS session expires mid-run | The engine's model calls fail → output error → not retried. Sessions are sized to `runTimeoutMs` + 15 minutes, so this needs a run that spends longer than that in wall-clock time. That can happen only if the laptop sleeps, and the lid-close behaviour is unchanged from today. |

## 6. Testing

- **Unit:**
  - the job server and client with an in-process HTTP pair: claim, progress, heartbeat, result, log, cancel, worker loss, and auth rejection;
  - error serialization round-trips for all four classes, with `instanceof` preserved;
  - the remote run functions against a fake server;
  - the profile renderer and checker container modes;
  - the doctor worker checks with test doubles;
  - the launcher's credential-minting arguments and its backoff, using an injected exec.
- **Integration (local, not CI):** `scripts/compose-smoke.sh` builds the image, starts the stack with dummy secrets and a stub engine binary that prints a canned result, submits a job through a test endpoint on the orchestrator (enabled only by `SMOKE=1`), and checks the result and the progress stream.
- **Live:** the cutover checklist (section 7).

## 7. Rollout and cutover

1. Merge the image, protocol and launcher behind `RUNTIME=container`. The launchd daemon remains the default, with no behaviour change.
2. Build the image locally (`docker buildx build --platform linux/arm64 --load`).
3. Run the worker-side doctor, then the compose smoke test.
4. **Cutover:**
   - wait until `status` shows no active review;
   - copy `~/.local/state/slack-review-bot/cursors.json` into the `orchestrator-state` volume;
   - run `scripts/install-service.sh --uninstall`;
   - install the launcher LaunchAgent.
5. **First reviews:** run in single mode (`REVIEW_ENGINES=codex`, `ENGINE_AUTH=bedrock`) on low-risk PRs.
6. **Rollback:** unload the launcher, `docker compose down`, then `scripts/install-service.sh`. The cursor file on the host is still the old one; copy it back from the volume first if reviews ran in between.

Dual mode is flipped afterwards, under https://github.com/andrew-barnett/slack-review-bot/issues/71.

## 8. Risks and open items

- **Docker Desktop licensing** for the organisation is unverified. Colima is a drop-in fallback that runs the same Compose file.
- **Review quality on Bedrock `gpt-5.5`** with fallback model metadata. This is measured in Phase 2a before cutover, not here.
- **Worker memory:** reviewing large monorepos may need more than 6 GiB. `WORKER_MEMORY` is configurable, and an OOM shows up as "worker lost".
- **Clone cost:** each attempt clones the PR's repository from scratch (there is no shared checkout). This is acceptable for correctness. A read-only, pre-fetched mirror volume is a later optimisation and must never be writable by workers.

## 9. Out of scope

- The ECS stack itself (Phase 4, after https://github.com/andrew-barnett/slack-review-bot/issues/36 picks the account).
- A GitHub App replacing the role-account PATs (https://github.com/andrew-barnett/slack-review-bot/issues/33).
- Flipping `DUAL_MODE_AVAILABLE` (https://github.com/andrew-barnett/slack-review-bot/issues/71).
