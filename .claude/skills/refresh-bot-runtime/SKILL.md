---
name: refresh-bot-runtime
description: Use when updating what the slack-review-bot image runs - bumping the pinned aqua-skills commit (review-pr skill and secret hook), choosing newer Bedrock models for Codex or Claude, or bumping the pinned CLI versions (codex, claude, gh, aws) - and shipping the result.
---

# Refresh the bot's runtime

The container image is fixed at build time. Five things in it go stale and are refreshed here:

| What | Pinned in | Consumed by |
|---|---|---|
| `review-pr` skill + `block-secret-reads.py` hook | `docker/aqua-skills.ref` (one 40-char aqua-skills SHA) | `scripts/build-image.sh` → Dockerfile `COPY --from=aqua` → `/opt/aqua-skills/` |
| Bedrock model IDs | defaults in `src/config.ts` (`codexBedrockModel`, `claudeBedrockModel`); overridable per install via `CODEX_BEDROCK_MODEL` / `CODEX_BEDROCK_PROJECT` / `CLAUDE_BEDROCK_MODEL` / `CODEX_BEDROCK_CONTEXT_WINDOW` in `launcher.conf` | `src/bedrock-auth.ts` (`ANTHROPIC_MODEL` for Claude; `-c model=...` for Codex) |
| CLI versions | `Dockerfile` `ARG GH_VERSION`, `AWSCLI_VERSION`, `CODEX_VERSION`, `CLAUDE_CODE_VERSION` | the image |
| Base image | `Dockerfile` `FROM node:22-bookworm-slim` (both stages) | the image |
| Bedrock prices | `pricing/bedrock-prices.json` (USD per million tokens, keyed by model ID, with the source URL and date checked) | `src/pricing.ts` → the monthly spend cap (`src/spend-cap.ts`) |

Do only the sections the request needs, but always finish with **Verify** and **Ship**.

## Ground rules

- Work in a git worktree under `/tmp` (`git -C <checkout> worktree add "$(mktemp -d)/srb" -b <branch> origin/main`), never in the normal checkout. Fetch first; run `npm ci` once in the new worktree.
- AWS calls here are read-only metadata (`bedrock list-*`, `sts get-caller-identity`) or model invocations through a role profile. Never run `secretsmanager get-secret-value`, never print `~/.npmrc` or credentials, never `export` keys into a command line.
- If a step fails in a way this file doesn't cover, stop and report it; don't guess a value.

## 1. aqua-skills pin

1. `git -C ~/src/aqua-skills fetch origin`
2. `OLD=$(tr -d '[:space:]' < docker/aqua-skills.ref); NEW=$(git -C ~/src/aqua-skills rev-parse origin/main)`. If equal, this section is done.
3. Read what changed in the two things the image takes:
   `git -C ~/src/aqua-skills log --oneline "${OLD}..${NEW}" -- skills/review-pr security/block-secret-reads.py`
   and `git -C ~/src/aqua-skills diff "${OLD}..${NEW}" -- skills/review-pr security/block-secret-reads.py`.
   Nothing listed → the bump is cosmetic; still fine to take.
4. Check the skill is still self-contained: `git -C ~/src/aqua-skills grep -nE '\.\./[a-z-]+/|skills/[a-z-]+' "${NEW}" -- skills/review-pr | grep -v 'skills/review-pr'` must print nothing. If it names another skill, the build script's `git archive` paths and the Dockerfile `COPY` lines must add that skill too — that is a code change, not just a pin bump.
5. If the hook diff changes its CLI or the way it is registered, read `scripts/install-claude-profile.sh` (`--hook-src`) and the Dockerfile lines that call it, and adjust.
6. Write `NEW` into `docker/aqua-skills.ref` (the SHA and a newline, nothing else).

## 2. Bedrock models

The engine role (`SlackReviewBotEngineRole`, policy `iam/policies/SlackReviewBotBedrockInvoke.ts` in trade-platform/pulumi) may invoke only `anthropic.*` foundation models and `us.anthropic.*` inference profiles in us-east-1/us-east-2/us-west-2 on bedrock-runtime (Claude). Codex needs `bedrock-mantle:CreateInference` on the bot's Mantle project (`CODEX_BEDROCK_PROJECT`), conditioned on `bedrock-mantle:Model` = `openai.gpt-*`. A model outside those patterns needs a pulumi PR first (another person approves the deploy); say so and stop.

1. List what is available (operator profile, metadata only):
   ```sh
   aws bedrock list-inference-profiles --region us-east-2 --profile staging --type-equals SYSTEM_DEFINED \
     --query "inferenceProfileSummaries[?starts_with(inferenceProfileId,'us.anthropic.')].[inferenceProfileId,status]" --output table
   aws bedrock list-foundation-models --region us-east-2 --profile staging \
     --query "modelSummaries[?providerName=='Anthropic' && modelLifecycle.status=='ACTIVE'].[modelId,modelName]" --output table
   ```
   Those are the Claude candidates. Codex candidates are Bedrock Mantle model IDs (`openai.*`, no `us.` prefix), listed by the Mantle `GET /v1/models` API on `https://bedrock-mantle.<region>.api.aws`. A plain `aws` CLI call cannot do that: the operator lists them with a SigV4-signed request or in the Bedrock console and gives you the IDs.
2. "Best" means **the cheapest model that is private and good enough at code review**. Apply the gates in this order; a candidate that fails a gate is out, however cheap or smart it is.
   - **Gate A, available:** for Claude, a `us.` inference profile exists with status `ACTIVE`, the foundation model's lifecycle is `ACTIVE` (never `LEGACY`); for Codex, the `openai.*` ID appears in the operator's Mantle model list. Either must be in the engine role's IAM scope (above). Never pick a model from memory or a blog post: it must appear in step 1's output.
   - **Gate B, private (prompts and code are not logged by or sent to an outside company):**
     - The model must be served by Bedrock itself (first-party serverless inference in AWS), not a Marketplace or partner endpoint run by the vendor. Confirm on the model's AWS model card / Bedrock data-protection documentation, and quote the line you relied on in the PR. If the documentation is ambiguous for a model, it fails the gate; ask the user.
     - Use only `us.` cross-region profiles, so inference stays in US regions.
     - Codex must not ask Bedrock to store responses server-side: the Responses call must go out with `store: false`. If the step 3 test fails with a data-retention or `store` error, the model fails the gate. Do not work around it by enabling storage.
     - Check the account's invocation logging: `aws bedrock get-model-invocation-logging-configuration --region us-east-2 --profile staging`. Logging to our own CloudWatch/S3 stays inside the company and is acceptable; report what it says in the PR either way.
   - **Gate C, good enough at review:** run each surviving candidate, and the current model, on the same fixed set of 3-5 past PRs of this repo whose real problems are known (pick merged PRs whose review rounds found BLOCKING issues; list them and their known issues in the PR). Run each one with `npm run review -- --report-only --engine <codex|claude> <PR URL>`, with `ENGINE_AUTH=bedrock` and the candidate in `CODEX_BEDROCK_MODEL` / `CLAUDE_BEDROCK_MODEL`. Report-only mode posts nothing, so it is safe on real, merged PRs. Never drop the flag here: without it `npm run review` posts a real review and can APPROVE. A merged PR cannot be reviewed in place: report-only mode still checks the base and returns `blocked` (`stale base`) once the base has moved on. So, once per eval PR, recreate it in a private scratch repository (e.g. `andrew-barnett/srb-model-eval`, created by the user): push the PR's merge-base commit as a base branch and its head commit as a head branch, and open a PR there. Reuse those scratch PRs for every candidate and every future refresh; nothing moves them, so every candidate reviews the same commit. A candidate passes if it finds at least the known BLOCKING issues the current model finds, and its findings are not mostly noise. Record the results per PR.
   - **Then cheapest wins:** among candidates that pass all three gates, pick the lowest cost per review. Cost per review = the run logs' token usage × the candidate's on-demand input/output (and cached-input) prices from the AWS Bedrock pricing page. Fall back to list prices with a typical review's token counts if the logs lack a breakdown, and say so. Lower `model_reasoning_effort` is a cost lever too; test it the same way.
   - Codex-specific: the model must be one the pinned `CODEX_VERSION` knows. Codex prints `Model metadata for <id> not found. Defaulting to fallback metadata` for IDs it doesn't know; that is acceptable because `CODEX_BEDROCK_CONTEXT_WINDOW` (default `272000`, the OpenAI short-context threshold the spend price table assumes) overrides the fallback. Check the candidate's AWS model card still uses that threshold; if it differs, the default and the price table must change together. Prefer bumping `CODEX_VERSION` (section 3).
   - The pick goes to the user with the table (model, gates A-C, cost per review) before any default changes. Moving to a pricier model is always the user's call.
3. Smoke-test each candidate as the engine role before changing anything. This needs an AWS profile that assumes `arn:aws:iam::153538148884:role/SlackReviewBotEngineRole` from `staging`; the user creates it (don't read or edit `~/.aws/config` yourself). Below it is called `srb-engine`; ask the user for its real name.
   ```sh
   SCRATCH="$(mktemp -d)"
   # Claude: expect one line containing "ok"
   CLAUDE_CONFIG_DIR="$SCRATCH/claude" CLAUDE_CODE_USE_BEDROCK=1 AWS_PROFILE=srb-engine AWS_REGION=us-east-2 \
     ANTHROPIC_MODEL=<claude-candidate> claude -p "say ok" < /dev/null
   # Codex: expect a final message containing "ok"
   CODEX_HOME="$SCRATCH/codex" AWS_PROFILE=srb-engine codex exec --skip-git-repo-check \
     -c 'model_provider="amazon-bedrock"' -c 'model="<codex-candidate>"' \
     -c 'model_providers.amazon-bedrock.aws.region="us-east-2"' \
     -c 'model_providers.amazon-bedrock.http_headers={"OpenAI-Project"="<CODEX_BEDROCK_PROJECT>"}' "say ok" < /dev/null
   ```
   Known failures: `AccessDeniedException` naming `aws-marketplace:Subscribe` or a model subscription → the model needs a Marketplace subscription by an account admin; stop and tell the user. `AccessDenied` on `bedrock:InvokeModel` → outside the IAM scope above (pulumi PR). A data-retention/`store` error from Codex → stop and report; don't work around it.
4. Apply the choice. Either:
   - **Per install, no code change:** set `CODEX_BEDROCK_MODEL` / `CLAUDE_BEDROCK_MODEL` (and `CODEX_BEDROCK_CONTEXT_WINDOW`) in `~/.config/slack-review-bot/launcher.conf` and restart the launcher; or
   - **New default (preferred when it should apply everywhere):** change the defaults in `src/config.ts` `loadBedrockConfig`, then `grep -rn '<old-id>' --exclude-dir=node_modules --exclude-dir=dist .` and update every hit: tests (`src/config.test.ts`, `src/bedrock-auth.test.ts`, `src/codex.test.ts`, `src/claude.test.ts`, `src/worker.test.ts` at the time of writing), `README.md`, and both Codex profiles (`codex/review-bot.config.toml.template`, `codex/review-bot.config.container.toml`, whose `model =` is the subscription-path model name and changes only if the OpenAI model family changed). Leave dated specs/plans under `docs/superpowers/` alone — they are history.

5. **Update the price table** whenever a model ID changes (a new default or a per-install override), and at least whenever this section runs. The daemon refuses to start in Bedrock mode if a configured model has no price.
   1. Open https://aws.amazon.com/bedrock/pricing/, on-demand, region US East (Ohio) (`us-east-2`). Prices come from that page only; if you cannot open it, stop and ask the user.
   2. In `pricing/bedrock-prices.json`, add or update the entry keyed by the exact model ID: `input`, `cachedInput` (cache read; the `input` price if none is listed), `cacheWrite` (the 5-minute write price; `0` if none is listed), `output`, all in USD per **million** tokens. Keep entries for models that are not configured: they are the reference prices for the next candidate comparison. Mantle model IDs (`openai.*`, Codex) and bedrock-runtime profile IDs (`us.*`) are separate keys.
   3. Set `source` to `https://aws.amazon.com/bedrock/pricing/ (on-demand, us-east-2), checked YYYY-MM-DD` with today's date.
   4. Keep both `codexTokenSemantics` flags `true`. Codex copies the Responses API usage object (`codex-rs/codex-api/src/sse/responses.rs` in openai/codex), and OpenAI's spec defines `input_tokens_details` (`cached_tokens`, `cache_write_tokens`) and `output_tokens_details` (`reasoning_tokens`) as breakdowns of `input_tokens` and `output_tokens` (`src/openai/types/responses/response_usage.py` in openai/openai-python). Change a flag only if one of those sources changes; quote the new text and its URL in the PR.
   5. Check: `node -e "const t=require('./pricing/bedrock-prices.json');console.log(t.source);console.table(t.models)"` matches the page value for value, and `npx ts-node --compiler-options '{"module":"commonjs"}' --transpile-only src/pricing-file.test.ts` passes.
   6. A per-install override (`CODEX_BEDROCK_MODEL` / `CLAUDE_BEDROCK_MODEL` in `launcher.conf`) needs its entry in this table too, and the container runtime needs an image rebuild (section 4) before the override takes effect.
6. **Keep the AWS Budget in step with the cap.** Once the Budget backstop from the spend-cap spec (section 10) exists, its limit is 1.10 × `BEDROCK_MONTHLY_CAP_USD`. Whenever the cap changes, change the Budget limit in the same change set. Until section 10 ships there is no Budget to update; say so in the PR.

## 3. CLI versions and base image

1. Latest versions:
   ```sh
   npm view @openai/codex version
   npm view @anthropic-ai/claude-code version
   gh release view --repo cli/cli --json tagName --jq .tagName
   gh api repos/aws/aws-cli/tags --jq '.[0].name'    # AWS CLI v2 tags are 2.x.y
   ```
2. Read the release notes between the pinned and the new version of each CLI the bot drives, looking for changes to what the bot depends on:
   - **codex:** `exec`, `--output-last-message`, `-c` overrides, the `amazon-bedrock` (Mantle) provider, its `aws.region` key and its `http_headers` table, `shell_environment_policy`, `sandbox_mode`, skills under `~/.codex/skills`.
   - **claude:** `-p`, `--output-format stream-json`, `CLAUDE_CODE_USE_BEDROCK` / `ANTHROPIC_MODEL`, settings `permissions`/`sandbox`, hooks registration (checked by `scripts/check-claude-profile.js`).
   - **gh / aws:** only the commands the bot runs (`gh auth status`, `gh api`, `aws sts`, `aws codeartifact get-authorization-token`).
   If any of those changed, update the code that builds those arguments (`src/bedrock-auth.ts`, `src/codex.ts`, `src/claude.ts`, `scripts/claude-profile-lib.js`) with tests, in the same PR.
3. Edit the `ARG ..._VERSION=` lines in the Dockerfile. Base image: keep `node:22-bookworm-slim` unless the Node major is being changed on purpose (then also the esbuild `--target=node22` in `package.json`'s `build` script).

## 4. Verify (all of it, every time)

Run in the worktree, in order; each must pass before the next:

1. `npm test && npm run typecheck && npm run build`
2. Commit (the image is built from `git archive HEAD`, so uncommitted edits are not in it).
3. `scripts/build-image.sh` — ends with `built slack-review-bot:local from <sha> with aqua-skills <ref>`.
4. Versions inside the image: `docker run --rm --entrypoint sh slack-review-bot:local -c 'codex --version; claude --version; gh --version | head -1; aws --version; ls /opt/aqua-skills/skills/review-pr'`.
5. `scripts/compose-smoke.sh --no-build` — ends with `compose smoke passed`.
6. With real credentials (needs the launcher settings file): `scripts/launcher doctor worker` and `scripts/launcher doctor orchestrator` — both end with `All checks passed.`
7. After merge and restart: one review of a low-risk PR completes on each engine that changed, and the run log shows the new model ID.

## 5. Ship

- One branch and PR per refresh. Commit types: `build(deps): ...` for pin/version bumps, `feat(bedrock): ...` for a new default model, `fix(...)` only for a code change that fixes breakage. Reference the tracking issue as `refs andrew-barnett/slack-review-bot#<n>` if there is one.
- PR body: old → new for every pin and model, the aqua-skills changes from 1.3, the prices from 2.2, and the outputs of Verify steps 3–6.
- Open as draft, run the `review-loop` skill, `gh pr ready`, then merge with a merge commit (`gh pr merge --merge`; this repo has no required-review gate).
- After merge: rebuild the image from `main` and restart the launcher (`scripts/install-launcher.sh`), then Verify step 7.
- Rollback: revert the merge commit, rebuild, restart. A model override in `launcher.conf` can be removed without a rebuild.
