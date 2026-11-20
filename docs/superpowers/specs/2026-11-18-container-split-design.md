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
| D1 | **The seam is the two report-only engine run functions, one worker job per attempt.** `runCodexReportOnly` and `runClaudeReview` get remote implementations with the same signatures. | The dual runner already takes these as injection seams (`EngineDeps.runCodex`/`runClaude`). Retries, serial scheduling, the gate, idempotency, Slack rendering and usage all stay in the orchestrator unchanged. A stall retry gets a fresh container and fresh credentials. |
| D8 | **In the container runtime, every review is posted by the orchestrator as the role account, through the gate, including single mode.** Single mode becomes the dual runner with one engine (`REVIEW_ENGINES=codex` or `claude`), with approvals on: a clean result is an APPROVE from the role account, subject to the same pre-flight, head-moved and countable-approval checks as dual mode. | Today's single-mode prompt has the engine post its own review and push regression-test commits with the operator's `gh` login. A worker holds only a read-only token, so it can't, and it must not: write access in the container that runs PR code is exactly what https://github.com/andrew-barnett/slack-review-bot/issues/64 removes. The orchestrator holds the approver token and already posts the review, so the approval moves there rather than being dropped: running single mode means the operator wants PRs approved, as the launchd runtime does. (Revised 2026-11-20. The first version of this decision made single mode report-only, which conflated "the worker cannot post" with "single mode cannot approve".) **Behaviour change in the container runtime:** approvals come from the role account instead of the operator's login, so whether one counts depends on the role account's rights (the gate reports partial or not-counted approvals), and regression tests are no longer pushed to the PR branch; they are reported as suggested tests in the findings. The launchd runtime keeps today's single mode until it is retired. |
| D2 | **Workers pull jobs over HTTP from the orchestrator.** On the laptop, the orchestrator never starts containers. | There is no Docker socket in any container. On ECS, the orchestrator starts each worker task with a scoped `ecs:RunTask` call (section 4); the pull protocol is the same in both places. |
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
- **Holds:** `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, `APPROVER_GH_TOKEN` (in both modes, because single mode now posts its review, and its approval, as the role account; see D8), `LAUNCH_KEY` (3.3), and a `RUN_LOG_DIR` volume.
- **Code change for D8:**
  - `selectReviewRunner` uses the dual runner for single mode when `RUNTIME=container`, with approvals on.
  - `makeDualReviewRunner` keeps an `approvals: boolean` option (false posts every outcome as a COMMENT, never APPROVE); no runtime sets it false.
  - The single-engine gate requires exactly one pass, from the configured engine.
- **Does not hold:** engine credentials of any kind, or AWS credentials.
  - `ENGINE_GH_TOKEN` is not known to the orchestrator. The dual-mode startup check that the engine token differs from the approver token moves to the launcher, which has both.
  - `CODEARTIFACT_REFRESH=false`: the registry token is the worker's.
- **Job server:** listens on an internal-only Compose network (`jobs`, `internal: true`) and publishes no ports. It also joins a second network with egress, for Slack and GitHub. The launcher starts it with the fixed container name `slack-review-bot-orchestrator`, so workers reach it at `http://slack-review-bot-orchestrator:8080` (`ORCHESTRATOR_URL`) without depending on whether `compose run` registers a service-name alias.
- **Cursor:** `CURSOR_FILE` lives on a named volume `orchestrator-state`, mounted only into the orchestrator.

### 3.3 Job protocol (`src/jobs/`)

The protocol is HTTP/1.1 with JSON bodies on the `jobs` network.

**Threat this must stop.** Workers run untrusted PR code as the same UID as the worker process, so PR code can read anything that process holds. In dual mode the gate approves only when *both* engines report clean. If PR code running in the Codex worker could claim the Claude job, or post a result for it, it could forge the second clean pass and get the role account to approve. A credential shared by all workers allows exactly that, so there is no shared worker credential.

**Credentials (one-use, bound to one attempt):**
- **`LAUNCH_KEY`:** a random 32-byte key the launcher generates per boot and gives **only** to the orchestrator.
- **Claim ticket:** for each worker it starts, the launcher creates `ticket = nonce + "." + base64url(HMAC-SHA256(LAUNCH_KEY, nonce))`, with a fresh random 16-byte nonce. That one ticket is the worker's only credential to the orchestrator.
- **Ticket rules (enforced by the orchestrator):**
  - it verifies the HMAC in constant time;
  - it records each nonce as spent on its first successful claim (a spent nonce gets `403`);
  - it rejects tickets older than `WORKER_IDLE_EXIT_MS` + 1 minute (the nonce carries a timestamp prefix).

  So a worker can claim **at most one job, ever**.
- **Job token:** a successful claim returns a fresh random `jobToken` bound to that job. Every later call for the job must carry it. A token for job A is rejected on job B (`403`).
- **Why this holds:** the worker claims immediately at start-up, before any PR code exists in its container. By the time PR code can read the ticket and token, the ticket is spent and the token only reaches the worker's own job. The worst a compromised worker can do is lie about its **own** engine's result. That is the same power as PR content prompt-injecting that engine, which the two-engine design already assumes one engine may suffer.
- **Same container:** the two engines of one request always run in different worker containers (each job is one engine attempt, and each worker claims one job).

| Call | Who | Body / reply |
|---|---|---|
| `POST /v1/claim` | worker, `Authorization: Ticket <ticket>` | Long-polls up to 25 s. Replies `204` (no job yet; the ticket is **not** spent), `403` (bad, spent or expired ticket), or `200 {jobId, jobToken, kind, options}`. `kind` is `codex-report-only` or `claude-review`. `options` is the run-options object with its function fields removed (`registry`, `log`, `onProgress`). |
| `POST /v1/jobs/:id/progress` | worker, `Authorization: Job <jobToken>` | `{line, activeMs}`, forwarded to the job's `onProgress`. Replies `200`, or `409 {cancel: true}` once the orchestrator wants the job stopped. |
| `POST /v1/jobs/:id/heartbeat` | worker, `Authorization: Job <jobToken>` | Every 10 s. Same `409` cancel signal. |
| `POST /v1/jobs/:id/result` | worker, `Authorization: Job <jobToken>` | `{ok: true, outcome}` or `{ok: false, error: SerializedRunError}`. Accepted once; after that, the token is dead. |
| `POST /v1/jobs/:id/log` | worker, `Authorization: Job <jobToken>` | Raw run-log chunks (UTF-8, at most 1 MiB per request, 50 MiB per job), appended to `<RUN_LOG_DIR>/<runId>.log` on the orchestrator. |

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
  - its one-use claim ticket (3.3) as `WORKER_TICKET`. It never receives `LAUNCH_KEY`.
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
   - generate `LAUNCH_KEY`, which goes to the orchestrator only;
   - start the orchestrator in the foreground as a supervised child process, `docker compose run --rm -T --name slack-review-bot-orchestrator orchestrator`, and write its secret bundle to the container's **stdin** (3.6.1).

   The values exist only in the launcher's memory and in the container processes' memory. Nothing is written to the host disk, the Docker VM's disk, or a container's filesystem.
2. **Worker loop**, with `WORKER_SLOTS` loops in parallel (default `2 × CONCURRENCY`, so a parallel dual run gets one worker per engine). Each iteration:
   - assume `SlackReviewBotEngineRole` (`--duration-seconds` per Phase 2a's `engineSessionSeconds`);
   - mint a CodeArtifact token (domain `trade-platform`, owner `153538148884`, `us-east-2`);
   - create a one-use claim ticket from `LAUNCH_KEY` (3.3);
   - run `docker compose run --rm -T worker` and write the worker's bundle (engine token, AWS session, npm token, claim ticket) to its stdin;
   - after the worker exits, back off 1 s, then repeat.

   Failing to mint credentials backs off exponentially (up to 5 minutes) and logs the STS error line, never a credential.
3. **SIGTERM: drain first, then stop workers.**
   1. Stop the worker loops from starting new workers, but leave running workers alone.
   2. Send SIGTERM to the orchestrator only, and wait for it to exit. While it drains under the contract in https://github.com/andrew-barnett/slack-review-bot/issues/32, in-flight jobs must keep their workers. Killing a worker mid-drain would turn an unfinished review into "worker lost" and settle its cursor entry as an error, so the request would never be replayed.
   3. The orchestrator moves from draining to forced on its own: when its `SHUTDOWN_DRAIN_MS` deadline passes, it sets `shutdown.forced`. A repeated signal is a no-op in `app.ts` and is **not** a forced-shutdown trigger. Forced shutdown cancels its jobs (the `409` path in 3.3), so workers exit on their own, and leaves the killed reviews' cursors unsettled so they replay.
   4. Only after the orchestrator process has exited, SIGTERM any worker that is still running, wait up to 30 s, then SIGKILL it and exit. Once the orchestrator is gone, nothing is left to turn a missing worker into a settled "worker lost" error.

   **The launcher never stops a worker while the orchestrator is alive**, whatever signals it receives. A repeated SIGTERM to the launcher is ignored. Its only escalation is a hard bound: if the orchestrator hasn't exited after `SHUTDOWN_DRAIN_MS` + `SHUTDOWN_GRACE_MS` + 30 s, the launcher runs `docker kill` on the orchestrator first, waits for it to exit, and only then does step 4.

#### 3.6.1 Secret delivery over stdin

Two delivery routes were considered and rejected:
- `-e` / `environment:` puts values in the container's config, which `docker inspect` can read, on the Docker VM's disk.
- Compose's file- and environment-sourced `secrets:` copy the value into the container's filesystem before it starts (`pkg/compose/secrets.go`). For the long-lived orchestrator, that would leave the approver and Slack tokens on disk for its whole life.

Instead, both entrypoints:
1. read **one** JSON line from stdin (`{"SLACK_BOT_TOKEN": …}`), at most 64 KiB and within 10 s, or exit non-zero;
2. close stdin;
3. hold the values in memory.

- **Worker:** exports its values into its own process environment for the engine children, as Phase 2a expects.
- **Orchestrator:** puts its values only into its config object, never into its own environment, matching today's daemon-secret scrubbing.
- **No secret-bearing variables in the image or Compose file.** `compose.yaml` sets `stdin_open: true` for both services.
- **Doctor:** the worker doctor checks (3.7) also assert that `/run/secrets` doesn't exist.

### 3.7 Doctor

- **New `--role orchestrator|worker` flag.** In a container (detected), the launchd PATH check and the env-file mode check are skipped.
- **`checkRoleIdentity`:** uses `OPERATOR_GH_LOGIN` (a launcher setting) instead of reading the operator's `gh` login, which doesn't exist in a container.
- **Worker checks**, run with `docker compose run --rm worker doctor --role worker`. These are the acceptance criteria of https://github.com/andrew-barnett/slack-review-bot/issues/64:
  - `APPROVER_GH_TOKEN`, `SLACK_BOT_TOKEN` and `SLACK_APP_TOKEN` are absent from the environment and from a filesystem grep of `/home/bot` and `/tmp`, and `/run/secrets` doesn't exist;
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
| launcher's worker loop | The orchestrator calls `ecs:RunTask` once per queued job, passing a fresh claim ticket in the container overrides. Its task role may run only the worker task definition, with `iam:PassRole` for the worker task role only. A long-running ECS *service* can't hand each task a unique ticket, so it isn't used. This is a scoped AWS API permission, not a Docker socket. |
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
5. **First reviews:** run in single mode (`REVIEW_ENGINES=codex`, `ENGINE_AUTH=bedrock`) on low-risk PRs. Confirm that one role-account review is posted per PR: an APPROVE when clean, a COMMENT with findings otherwise.
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
