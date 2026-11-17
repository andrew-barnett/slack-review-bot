# Design: dual-engine (Codex + Claude) review gate with approvals that count

**Status:** proposed. This is the design only; no code yet.
**Epic:** https://github.com/andrew-barnett/slack-review-bot/issues/52
**Related:** https://github.com/andrew-barnett/slack-review-bot/issues/33 (GitHub App hardening, which assumed advisory reviews), https://github.com/andrew-barnett/slack-review-bot/issues/35 (per-PR idempotency)

## 1. Goal

The bot gives a PR an approval that counts toward the repo's merge requirements, including PRs written by the person whose machine runs the bot. It approves only when **both** Codex and Claude independently run `review-pr` against the **same head commit** and both return `VERDICT: CLEAN` (zero BLOCKING findings).

This is a gate, not a loop. Each engine runs `review-pr` once per head commit. Engines never fix code: there is no `resolve-review`, no regression-test push, and no base merge. Iteration happens when the author pushes and asks for a new review.

Before it reviews, the bot knows whether its approval would satisfy the PR's rules (required approval count, CODEOWNERS, last-push approval) and says so.

## 2. Decisions (from the epic)

| Q | Decision |
|---|---|
| Q1 approver identity | An existing org role (machine-user) account's PAT. Only the daemon holds it. |
| Q2 scheduling | Configurable: `ENGINE_SCHEDULE=parallel` (default) or `serial`. |
| Q3 stale base | The daemon calls GitHub's update-branch API before pinning, except when `require_last_push_approval` is in effect. |
| Q4 approval won't count | Review anyway. Dual-CLEAN posts `APPROVE` for **counts** and **partial**, and a `COMMENT` review for **won't count**. A pre-flight that cannot finish is treated as **won't count**. |
| Q5 comment surface | The daemon posts one combined review per run, tagged by engine, without deduplicating by meaning, as `COMMENT` (never `REQUEST_CHANGES`). |
| Q6 report-only | A supported report-only mode in `review-pr` (`trade-platform/aqua-skills`), enforced a second time by a read-only engine credential. |

## 3. Today's flow (for orientation)

`app.ts` routes a Slack message to `runJob` (`job.ts`). After the deployments human gate (`gate.ts`), `runJob` calls `deps.runReview`, which `makeReviewRunner` (`review.ts`) implements. That function refreshes CodeArtifact, builds the prompt (`prompt.ts`), and runs `runCodexReview` (`codex.ts`). That call spawns `codex exec` with an allowlisted environment (`buildChildEnv`), supervises stalls and deadlines, and parses JSON against `REVIEW_OUTPUT_SCHEMA` (`schema.ts`). Codex itself pushes tests, merges the base, posts comments, and approves, all with the operator's `gh` credential. `render.ts` turns the result into Slack reactions and a thread reply.

## 4. Architecture

Dual mode keeps `runJob`, the queue, catch-up, the human gate, and the Slack rendering frame. It replaces "Codex does everything" with a daemon-side pipeline per PR:

```
Slack request
  └─ runJob ─ human gate (unchanged)
       └─ dual review runner, per PR:
            1. pre-flight        (approver token, read-only GitHub calls)
            2. update branch?    (approver token, PUT update-branch)        [Q3]
            3. pin head SHA      (re-run pre-flight first if step 2 moved the head)
            4. engines           (engine token, report-only review-pr)
                 codex ─┐  parallel or serial                               [Q2]
                 claude ┘
            5. combine verdicts
            6. head unchanged?   (re-read headRefOid)
            7. post one review   (approver token, commit_id = pinned SHA)   [Q4, Q5]
            8. read-back         (reviewDecision, mergeStateStatus)
       └─ Slack thread + reaction
```

Engines run inside a single request in the same order as today. All PRs in a request go to each engine in one run, as `prompt.ts` does now, and each PR carries its own pinned SHA. Steps 1-3 and 5-8 run per PR in the daemon. One request still uses one `CONCURRENCY` slot, even when two engines run in parallel.

### 4.1 Modes

`REVIEW_ENGINES` selects the mode:

- `codex` (default during rollout): today's single-engine behaviour, unchanged. Codex posts and approves with the credential it has today.
- `codex,claude`: dual mode, as described here. Dual mode refuses to start (fatal at startup, reported by `doctor`) unless `APPROVER_GH_TOKEN` and `ENGINE_GH_TOKEN` are both set and resolve to the same role-account login. See section 9.

Other values are a startup error. A single-engine `claude` mode is out of scope.

## 5. Components

Each unit has one job and an interface that can be tested without the others. New files are flat in `src/` to match the repo.

### 5.1 `config.ts`: new settings

| Variable | Meaning | Default |
|---|---|---|
| `REVIEW_ENGINES` | `codex` or `codex,claude` | `codex` |
| `ENGINE_SCHEDULE` | `parallel` or `serial` | `parallel` |
| `ENGINE_ORDER` | serial order, a permutation of the engines | `codex,claude` |
| `APPROVER_GH_TOKEN` | role-account PAT used **only** by the daemon's own `gh` calls | (none) |
| `ENGINE_GH_TOKEN` | read-only token handed to engines as `GH_TOKEN` | (none) |
| `CLAUDE_BIN` | Claude Code binary | `claude` |
| `CLAUDE_CONFIG_DIR_REVIEW` | dedicated Claude config dir for the engine (section 5.5) | `~/.claude-review-bot` |
| `APPROVAL_PARTIAL_EMOJI`, `APPROVAL_NOT_COUNTED_EMOJI`, `HEAD_MOVED_EMOJI` | new reactions | chosen at implementation; `doctor` validates them like the existing ones |

`ENGINE_ORDER` is validated: every engine in `REVIEW_ENGINES` appears exactly once.

**Credential separation is enforced in code, not by convention.**

- `APPROVER_GH_TOKEN` is on a hard **denylist** in `buildChildEnv`. It is dropped even if someone names it in `CODEX_ENV_PASSTHROUGH`, and a startup warning names the attempt.
- In dual mode the child's `GH_TOKEN` is set from `ENGINE_GH_TOKEN`, and `GITHUB_TOKEN` and `GH_ENTERPRISE_TOKEN` are removed. Otherwise an inherited operator token could shadow the engine token.
- Nothing ever puts the approver token into `process.env`. It lives only in `Config` and is passed to the `gh` runner (section 5.7).

### 5.2 `preflight.ts`: approval eligibility

The code is split into a pure evaluator and a fetch layer.

**Fetch layer.** All calls run with the approver token. They are read-only and bounded by `GH_COMMAND_TIMEOUT_MS`.

| Data | Call |
|---|---|
| bot login | `GET /user` (cached for the process) |
| PR author, base, head SHA, state, draft | `GET /repos/{o}/{r}/pulls/{n}` |
| changed file paths | existing `listChangedFiles` (names only) |
| bot permission | `GET /repos/{o}/{r}/collaborators/{bot}/permission` |
| ruleset rules on base | `GET /repos/{o}/{r}/rules/branches/{base}` |
| classic protection on base | `GET /repos/{o}/{r}/branches/{base}/protection`, **readability to be verified** (V1) |
| CODEOWNERS | first of `.github/CODEOWNERS`, `CODEOWNERS`, `docs/CODEOWNERS` at `ref={base}` via the contents API |
| CODEOWNERS validity | `GET /repos/{o}/{r}/codeowners/errors?ref={base}` |
| team membership | `GET /orgs/{org}/teams/{slug}/memberships/{bot}` (state `active`) for each `@org/team` owner the evaluator needs |
| current approvals | GraphQL `pullRequest.latestOpinionatedReviews` (author, state, commit oid, submittedAt) |
| other approvers' eligibility | `GET /repos/{o}/{r}/collaborators/{login}/permission` for each other approver, plus team membership as for the bot when evaluating owner coverage |
| latest pusher of the head branch | `GET /repos/{o}/{r}/activity?ref=refs/heads/{head}&activity_type=push&per_page=1` (actor, after-SHA, timestamp). Needed only when `require_last_push_approval` is set. A head branch in a fork is not readable this way, so the result is "cannot verify". Readability is checked in V1. |

**Evaluator.** `evaluateEligibility(facts) -> Eligibility`, a pure function:

```ts
type Eligibility = {
  verdict: 'counts' | 'partial' | 'wontCount'
  reasons: string[]          // why not 'counts'; rendered to Slack and to the review body
  missing: string[]          // e.g. "1 more approval", "@org/payments for src/billing/**"
  lastPushApproval: boolean  // drives Q3
  dismissStale: boolean      // informational
}
```

Rules:

The evaluator first decides whether the bot's approval would be **valid** at all. Then it simulates the PR's requirements with the eligible existing approvals plus the bot's approval.

1. **Effective rule.** Take the **strictest** across every ruleset `pull_request` rule and classic protection. That is the maximum `required_approving_review_count`, and each boolean (`require_code_owner_review`, `require_last_push_approval`, `dismiss_stale_reviews_on_push`) is true if any source sets it true.
2. **Eligible existing approvals.** These are reviews in `latestOpinionatedReviews` that meet all of the following:
   - state `APPROVED`;
   - not from the bot and not from the PR author;
   - the reviewer has `write` or higher permission (an approval from a read-only reviewer is shown but never counts);
   - when `dismiss_stale_reviews_on_push` is set, `commit oid == head SHA`;
3. **Bot validity.** The bot's approval is **invalid**, giving `wontCount` with the reason, when:
   - the bot authored the PR;
   - the bot has less than `write` permission; or
   - `require_last_push_approval` is set and the bot is the latest pusher. For example, the bot updated the branch earlier, or the role account pushed commits.
4. **Owner coverage** (only when `require_code_owner_review` is set). For each changed path, the CODEOWNERS entry that matches is the last one to match. A path with no matching entry, or with an empty owner list, needs no owner. A path that needs an owner is **satisfied** when any of its owners has approved, counting only eligible approvals plus the bot's. An owner has approved if the approver is listed directly or is an active member of a listed team.
5. **Remaining requirements** after adding the bot's approval:
   - the approval shortfall, `required - (eligible + 1)`, when positive;
   - every owner path still unsatisfied (its owners go in `missing`);
   - when `require_last_push_approval` is set, whether the latest push would then be approved. That needs at least one approval from someone other than the latest pusher, submitted after that push: an eligible existing approval, or the bot's own (valid unless rule 3 failed). This is checked **separately** from rule 2. Approvals from before the latest push still count toward the approval number and owner coverage unless `dismiss_stale_reviews_on_push` removed them; they just cannot satisfy the latest-push requirement.
6. **Verdict.**
   - No remaining requirements → `counts`.
   - Some remain, and the bot's approval reduced them (it filled an approval slot, or satisfied at least one owner path that was otherwise unsatisfied) → `partial`, with what remains in `missing`.
   - Some remain, and the bot's approval reduced nothing → `wontCount`. Its approval would not move the PR toward mergeable.
7. **Cannot verify.** If any source that rules 1-5 need could not be read, or `codeowners/errors` is non-empty → `wontCount`, naming the unreadable source (the Q4 decision). The latest pusher is needed only when `require_last_push_approval` is set; a fork head branch counts as unreadable. A source that is legitimately absent is not unreadable: no ruleset, no classic protection (404), or no CODEOWNERS file all read as "no requirement".

**CODEOWNERS matcher** (`codeowners.ts`, pure). It implements GitHub's documented syntax:

- gitignore-style patterns with last match winning;
- a leading `/` anchors to the root; a pattern without `/` matches at any depth; a trailing `/` matches a directory and everything under it;
- `*` does not cross `/`, and `**` does;
- `#` starts a comment, and `\#` escapes it;
- no `!` negation and no `[]` ranges: GitHub does not support them, so they are treated as never matching, and a pre-flight reason is recorded.

It is tested against the examples in GitHub's CODEOWNERS documentation.

### 5.3 Update branch (Q3)

Run after pre-flight, before pinning, only when the base has moved. "Moved" means `GET /repos/{o}/{r}/compare/{base}...{head}` reports `behind_by > 0`.

- If `eligibility.lastPushApproval` is true: do not update. Record the PR as `blocked` ("base moved; this repo requires approval of the latest push, so the author must update the branch"). Post nothing to GitHub.
- Otherwise: `PUT /repos/{o}/{r}/pulls/{n}/update-branch` with `expected_head_sha` set to the current head.
  - `202`: poll `GET /pulls/{n}` until `head.sha` changes, using the same timeout as `gh` calls, then **re-run the whole pre-flight against the new head** before pinning. The update can dismiss existing approvals (when `dismiss_stale_reviews_on_push` is set) and makes the bot the latest pusher, so the earlier prediction is stale. The re-evaluated eligibility is the one used for posting and rendering.
  - `422` (conflict, or the head moved): mark the PR `blocked` with the reason, and post nothing.

The update is pushed by the role account. Pre-flight already established that `require_last_push_approval` is off, so the bot's own push does not void its approval. **To verify (V3):** that the update-branch API attributes the push to the token's user.

### 5.4 Engine abstraction (`engine.ts`, `codex.ts`, `claude.ts`)

```ts
interface EngineRunInput {
  prs: { ref: PullRequestRef; pinnedSha: string }[]
  instructions: string
  requestedBy?: string
  worktreeRoot: string     // engine-specific subdirectory, see below
  runId: string
}
interface EngineRunOutcome {
  engine: 'codex' | 'claude'
  results: EnginePrResult[]   // one per PR, reconciled like reconcileResults
  usage: RunUsage           // per engine; see 5.9
  error?: string              // process-level failure: timeout, stall kill, unparseable output
}
interface Engine { name: 'codex' | 'claude'; run(input: EngineRunInput): Promise<EngineRunOutcome> }
```

- Each engine gets its own worktree root (`<WORKTREE_ROOT>/<engine>/<repo>-<number>`). Parallel runs then never share a checkout or a `node_modules`.
- **Process supervision is shared.** The stall and deadline handling, the child registry, bounded transcript tails, output redaction (`redact.ts`), and the SIGKILL escalation now in `codex.ts` move into `supervise.ts`. Both engines use it, and their spawn-argument builders and output parsers stay engine-specific. This refactor must keep every existing `codex.test.ts` behaviour, and the tests move with the code.
- Both engines share `drainChildRegistry` at shutdown, so a parallel run's two children are both drained.

### 5.5 Claude engine (`claude.ts`)

- Spawns `claude -p <prompt>` headlessly, with stream-JSON output so stall detection sees progress events, and with a structured-output contract matching section 5.6. **The exact flags are to be verified (V2):** `--output-format stream-json`, the structured-output or JSON-schema flag, the permission mode, and non-interactive auth.
- Runs with `CLAUDE_CONFIG_DIR=<CLAUDE_CONFIG_DIR_REVIEW>`, a dedicated config dir installed by a new `scripts/install-claude-profile.sh` (the counterpart of `install-codex-profile.sh`). That dir contains:
  - the `review-pr` skill (linked from aqua-skills, like the operator's);
  - the secret-blocking `PreToolUse` hook (`block-secret-reads.py`);
  - a sandbox and permission config confined to `WORKTREE_ROOT`, the workspace root (read-only), and the package caches;
  - **none** of the operator's personal hooks, memory, or MCP servers. Personal Stop hooks and reminders would otherwise block or derail an unattended run.
  - Not `--bare`: that flag skips hooks, and the secret-blocking hook must load. Isolation comes from the dedicated config dir instead.
- Auth: a non-interactive Claude credential (an API key or a long-lived token from `claude setup-token`, to be decided in V2). It is passed by exact name through the child allowlist. Like Codex's own credential today, it is visible to untrusted PR code. This is the same accepted risk, and it is recorded in section 9.
- Environment: the same `buildChildEnv` allowlist plus the Claude credential name, with `GH_TOKEN` set to the engine token (section 5.1).

### 5.6 Prompt and output contract (`prompt.ts`, `schema.ts`)

**Prompt.** In dual mode `buildPrompt` produces a report-only variant:

- It invokes `review-pr` in report-only mode (section 7).
- It lists each PR with its pinned SHA: "review exactly this commit; if the PR head is not this SHA, report the PR as blocked with reason `head moved`".
- It removes the sections that tell the engine to push tests, merge the base, sign merge commits, post comments, append the no-mention note, or approve. The daemon now owns those.
- It keeps the unattended-resolution rules (missing issue reference, AGENTS/CLAUDE constraints, the conservative-reading default), the independence rule, the worktree rules (with the engine-specific root), and the output contract.
- It is identical for both engines apart from the skill-invocation syntax (`$review-pr` for Codex, the skill name for Claude). One builder takes the engine as a parameter.

**Output schema v2** (dual mode only; single mode keeps v1):

```jsonc
{ "results": [ {
    "url": "https://github.com/o/r/pull/1",
    "reviewedSha": "<40-hex>",                 // must equal the pinned SHA
    "verdict": "clean" | "findings" | "blocked",
    "findings": [ {
      "severity": "blocking" | "non-blocking",
      "file": "src/x.ts" | "",                 // "" = PR-level
      "line": 42 | 0,                          // 0 = not line-anchored
      "body": "markdown"
    } ],
    "summary": "one sentence",
    "environmentProblems": [ "string" ]         // non-empty => this pass is invalid
} ] }
```

The schema stays strict-mode compatible, as v1 is: every property is required and no additional properties are allowed. The sentinels `""` and `0` stand in for null. `verdict: clean` with a blocking finding is a parse error. Non-blocking findings are allowed with `clean`.

### 5.7 GitHub effects (`github.ts`)

- `defaultRunner` gains an optional per-call `env`. The approver token reaches `gh` only as `GH_TOKEN` in that call's environment, never in `process.env`.
- New effects, all run with the approver token:
  - `getPullRequest`
  - `updateBranch`
  - `postReview(pr, { commitId, event: 'APPROVE' | 'COMMENT', body, comments })`, sent as `gh api --method POST repos/{o}/{r}/pulls/{n}/reviews --input -` with JSON on stdin, so bodies never pass through argv or a shell
  - `listCommentableLines(pr)`, built from the `+`/context lines of each file's `patch` in `GET /pulls/{n}/files`
  - `listBotReviews(pr)`
  - `readDecision(pr)`: GraphQL `reviewDecision` and `mergeStateStatus`
- The existing human-gate comment (`postPrComment`) also moves to the approver token in dual mode, so all bot GitHub output comes from one identity.

### 5.8 Gate and composition (`dual.ts`)

**Per-engine pass state for a PR:**

| Engine outcome | Pass state |
|---|---|
| process `error` (timeout, stall kill, unparseable output) | `invalid` |
| `environmentProblems` non-empty | `invalid` |
| `reviewedSha` ≠ pinned SHA | `invalid` |
| `verdict: blocked` | `blocked` |
| `verdict: findings` | `findings` |
| `verdict: clean` | `clean` |
| not run (serial, earlier engine not clean) | `skipped` |

Serial mode decides **per PR**. The next engine receives only the PRs for which every earlier engine was `clean`. The other PRs keep their earlier engines' states and get `skipped` for the rest, so a defect in one PR never denies another PR its second review. A `skipped` engine only ever sits beside a non-clean earlier engine, so the PR's row in the decision table comes from that earlier state (`findings`, `blocked`, or `invalid`). If no PR is left, the next engine is not spawned.

**Per-PR decision** (after step 6 confirms the head still equals the pinned SHA; otherwise the outcome is `headMoved`, nothing is posted, and Slack says "head moved during review; re-request"):

| Engine pass states | GitHub post | PR outcome |
|---|---|---|
| all `clean`, eligibility `counts` | `APPROVE` (+ non-blocking findings inline) | `approved` |
| all `clean`, eligibility `partial` | `APPROVE` + body lists `missing` | `approvedPartial` |
| all `clean`, eligibility `wontCount` | `COMMENT`: both clean at SHA, approval would not satisfy `reasons` | `cleanNotCounted` |
| any `findings`, none `invalid` | `COMMENT` with all valid engines' findings | `findings` |
| any `findings` and some `invalid` | `COMMENT` with the valid engines' findings; body names the engine that failed | `findings` |
| any `blocked` (no `findings`) | nothing | `blocked` |
| no `findings`, any `invalid` | **nothing** (a "one engine clean" comment would read as half an approval) | `error` |

A `skipped` engine is never `clean`. Every `APPROVE` requires every configured engine to be `clean`.

**Review body:** the pinned SHA, one line per engine (`Codex: clean · Claude: 2 blocking`), the pre-flight verdict with `reasons` and `missing`, any finding that cannot be anchored, and the hidden no-mention note (`withAgentNote`).

**Inline comments:** each finding with `file` and a commentable `line` becomes `{ path, line, side: "RIGHT", body: "**[Claude · BLOCKING]** …" }`. Anything else goes in the body under its engine's heading. Findings are not deduplicated by meaning.

**Idempotency (narrow form of andrew-barnett/slack-review-bot#35):** before posting, `listBotReviews` checks for a review by the bot on `commit_id == pinnedSha`. If one exists, skip posting and report "already reviewed at `<sha>`" in Slack. A replayed or re-requested review of an unchanged head then cannot double-approve or double-comment.

**Read-back:** after posting `APPROVE`, call `readDecision`. If the result contradicts the prediction (for example, `counts` but `reviewDecision != APPROVED`), add a warning line to Slack naming both. The approval is not withdrawn: the posted review is correct, and only the prediction was wrong.

### 5.9 Rendering (`render.ts`, `job.ts`, `usage.ts`)

**Usage.** `RunUsage` gains a per-engine breakdown. Codex keeps today's transcript-footer parse in `usage.ts`. Claude's comes from the final `result` event of `--output-format stream-json`: input, output, cache-read and cache-write tokens, `total_cost_usd`, `num_turns`, and `duration_ms`. The per-review usage reply and the status totals show each engine separately (`Codex 412k tok · Claude 380k tok ($2.10)`). With subscription auth (`CLAUDE_CODE_OAUTH_TOKEN`), `total_cost_usd` is a notional cost figure, not a charge, and is labelled as such. A killed run reports whatever usage was seen before the kill, as Codex does today.

`JobOutcome` gains `approved`, `approvedPartial`, `cleanNotCounted` and `headMoved`. The existing `pass` maps to `approved` in dual mode. The thread reply shows, per PR: the pre-flight verdict, each engine's state, the outcome, and the review URL. Reactions:

- `approved` → `passEmoji`
- `approvedPartial` → `APPROVAL_PARTIAL_EMOJI`
- `cleanNotCounted` → `APPROVAL_NOT_COUNTED_EMOJI`
- `findings` → `findingsEmoji`
- `blocked` and `error` → `errorEmoji`
- `headMoved` → `HEAD_MOVED_EMOJI`

A mixed request takes the worst outcome, extending today's ordering in `job.ts`.

### 5.10 `doctor.ts`

In dual mode, `doctor` also checks:

- `claude` resolves under the launchd PATH, and the dedicated config dir exists with the hook and skill;
- `APPROVER_GH_TOKEN` and `ENGINE_GH_TOKEN` both authenticate (`GET /user`) as the same role login;
- the role login differs from the operator's `gh` login;
- the engine token **cannot write**: the token type and permissions are inspected (method to be verified in V4), and doctor never performs a write to test it;
- the approver token is absent from the environment the child would receive (a dry-run `buildChildEnv`).

## 6. Error handling summary

- **Pre-flight fetch failure** → `wontCount` (Q4), and the review still runs.
- **Update-branch failure** → `blocked`, nothing posted.
- **One engine invalid** → no approval. Findings from the valid engine are still posted (table above).
- **Both engines invalid** → `error`, nothing posted, Slack shows each engine's error (redacted, as today).
- **Head moved** → nothing posted.
- **Posting fails** → `error`. Slack includes the HTTP status, and the next request's idempotency check prevents a double post.
- **Shutdown mid-run** → the existing termination contract (andrew-barnett/slack-review-bot#32) applies to both children.

## 7. `review-pr` report-only mode (aqua-skills)

Tracked as an issue on `trade-platform/aqua-skills`. Requirements for this repo:

- It is invoked by an explicit phrase in the prompt, defined by the skill, plus a pinned SHA per PR.
- In this mode the skill: makes no pushes, no base merge, no GitHub writes of any kind, and no approval; verifies `HEAD == pinned SHA` in its review checkout; may write and run regression tests locally and describes them in the finding body; ends each PR with the existing `VERDICT:` grammar, which the bot's prompt maps onto output schema v2.
- Environment problems the skill already recognises (NOT RUN caused by the environment, auth failure, metadata-only fallback) are reported, not hidden, so the bot can fill `environmentProblems`.

Until the skill ships report-only mode, dual mode stays behind `REVIEW_ENGINES`, and the read-only engine token is the only enforcement.

## 8. Verification items (spike before the dependent sub-issues)

- **V1.** With the role PAT, what is readable: `branches/{b}/protection` (classic protection normally needs admin), `rules/branches/{b}`, team memberships (`read:org`, and secret teams), `codeowners/errors`, the repository activity API for the latest pusher? If classic protection is unreadable to a write-level account, rule 7 would make every classically protected repo `wontCount`. The fallback is decided with the user before 5.2 is built. Candidates: GraphQL `baseRef.branchProtectionRule` readability, or classifying "classic protection unreadable" as `partial` with a reason instead of `wontCount`.
- **V2.** Claude Code headless: structured-output flag, stream-JSON progress events, the permission mode that never prompts, sandbox config for the worktree root, and auth (a subscription token from `claude setup-token` passed as `CLAUDE_CODE_OAUTH_TOKEN`, or an API key). Bedrock and Vertex are excluded, because their cloud keys would sit in the engine env. `--json-schema` is confirmed present in Claude Code 2.1.284.
- **V3.** Whether update-branch attributes the push to the token user, and how it interacts with `require_last_push_approval` and `dismiss_stale_reviews_on_push`.
- **V4.** How `doctor` can confirm the engine token is read-only without writing anything: fine-grained token permissions, or classic `X-OAuth-Scopes`.

## 9. Security

- **The approver token never reaches untrusted code.** The engines run PR code for 10-30 minutes. The approver token is denylisted in `buildChildEnv`, kept out of `process.env`, and passed only per `gh` call. If it leaked, a malicious PR could approve itself.
- **The engine token is read-only.** It is a fine-grained PAT on the role account (contents, pull requests and metadata: read), the preferred option, or the GitHub App installation token proposed in andrew-barnett/slack-review-bot#33, scoped to read. A leaked engine token cannot comment, push, or approve.
- **Claude engine isolation** matches the Codex child: allowlisted env, sandbox, a dedicated config dir with the secret-blocking hook, and no personal hooks, memory, or MCP servers.
- **Accepted residual risk:** each engine's own model credential (Codex auth, Claude credential) is visible to PR code, as Codex's is today. This is unchanged, and andrew-barnett/slack-review-bot#33 and andrew-barnett/slack-review-bot#34 track the hardening.
- **The bot is never added to a ruleset bypass list.** Pre-flight treats bypass as irrelevant: approval must count through the normal rules.

## 10. Testing

- `codeowners.ts`: GitHub's documented examples, last-match-wins, anchoring, `*` against `**`, trailing `/`, an empty owner list, and the unsupported `!` and `[]`.
- `preflight.ts` evaluator: table tests for every rule in section 5.2, including strictest-of-sources merging, stale-approval exclusion, a read-only reviewer's approval not counted, an approval from before the latest push still counting toward the approval number and owner coverage while not satisfying the latest-push requirement, an existing code-owner approval satisfying a path the bot does not own (bot fills the count → `counts`), the bot as latest pusher under `require_last_push_approval` (→ `wontCount`), a valid bot approval that reduces nothing (→ `wontCount`), unreadable source → `wontCount`, and an absent source treated as no requirement.
- `dual.ts`: table tests for every row of both section 5.8 tables, serial per-PR scheduling (a mixed request: engine A finds a defect in PR 1 and is clean on PR 2, and engine B reviews only PR 2), re-evaluated eligibility after update-branch dismisses an owner approval, head moved, idempotency skip, and read-back mismatch.
- `config.ts` and `codex.ts` env: the approver token is dropped even when passed through; `GH_TOKEN` is set from the engine token and the operator's tokens are stripped in dual mode.
- `schema.ts` v2: strict-mode shape, `clean` with a blocking finding rejected, `reviewedSha` format.
- `github.ts`: the argument and stdin shape of `postReview` (approver env per call, never argv bodies), and parsing commentable lines from patches.
- `supervise.ts`: the existing stall, deadline, and shutdown tests moved from `codex.test.ts`, plus a two-child drain test.
- `claude.ts`: argument building and stream parsing, with an injected spawner (as `codex.test.ts` does).

## 11. Rollout

1. Ship with `REVIEW_ENGINES=codex` (default). There is no behaviour change.
2. Provision the role account's two tokens and the Claude config dir; `doctor` passes.
3. Switch to `codex,claude` once aqua-skills report-only mode has shipped.
4. Remove the operator's own Slack ID from `SLACK_IGNORE_USER_IDS`. The bot now approves as the role account, so operator-authored PRs can be approved.

## 12. Sub-issue breakdown

1. Spike: V1-V4 verification (blocks 3, 5, 6, 9).
2. Config and credential separation (section 5.1): modes, tokens, denylist, child `GH_TOKEN` routing.
3. CODEOWNERS matcher and the pre-flight evaluator and fetchers (section 5.2).
4. Extract process supervision into `supervise.ts`, with no behaviour change (section 5.4).
5. Claude engine and the install-claude-profile script (section 5.5).
6. Report-only prompt and output schema v2 (section 5.6).
7. GitHub effects with the per-call approver env (section 5.7).
8. Dual orchestrator: update-branch, pin, gate, post, idempotency, read-back (sections 5.3 and 5.8).
9. Rendering, reactions, and doctor (sections 5.9 and 5.10).
10. `trade-platform/aqua-skills`: `review-pr` report-only mode (section 7).

## 13. Out of scope

- Iterative fixing (`resolve-review`) by the bot.
- A single-engine Claude mode.
- Changing models per engine from Slack (andrew-barnett/slack-review-bot#30).
- The SQS transport (https://github.com/trade-platform/operations/issues/6499). It is orthogonal: the dual runner sits behind `runReview`, whichever transport delivers the request.
