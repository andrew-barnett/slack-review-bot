# Bedrock monthly spend cap: design

Tracking: https://github.com/andrew-barnett/slack-review-bot/issues/76 (parent https://github.com/andrew-barnett/slack-review-bot/issues/52)

## 1. Goal

Put a hard monthly cap on this bot's AWS Bedrock spend. The cap applies to this bot only, not to Bedrock in the account. On top of the cap:

- Slack alerts at configurable percentages of the cap.
- The percent of the cap used, shown in `status`.
- Once the cap is reached, new review requests are refused with a message saying so.
- The cap is one setting (`BEDROCK_MONTHLY_CAP_USD`, default `1000`). Alerts are percentages of it.

**User-facing text never shows a dollar amount** — not the cap, and not the spend. It shows only percentages, or the fact that the cap has been reached.

**Out of scope:** hostile PR code. The threat model is ordinary bugs and misconfiguration: a wrong price, a missing price, a lost usage figure.

## 2. Decisions

| | Decision |
|---|---|
| D1 | **The bot is the primary cap, with an AWS Budget backstop.** The bot keeps a month-to-date ledger and enforces everything users see. An AWS Budget, filtered to this bot by a cost-allocation tag, denies Bedrock invocation to the engine role at 110% of the bot's cap. The Budget lags 8-24 h. |
| D2 | **Spend = tokens × a price table in the repo.** Claude's `ClaudeUsageDetail` already has a breakdown. Codex gets one from `codex exec --json`: the spike on andrew-barnett/slack-review-bot#76 confirmed that `turn.completed.usage` has `input_tokens`, `cached_input_tokens`, `cache_write_input_tokens`, `output_tokens` and `reasoning_output_tokens` in codex-cli 0.169.0. Claude's `costUsd` is not used: it is a notional figure, not a Bedrock charge. |
| D3 | **Attribution in AWS: tagged application inference profiles.** The bot invokes profile ARNs, and the Budget filters on the tag. The staging account is its own payer (it is not in an Organization), so we can activate the tag ourselves. |
| D4 | **Reviews already running when the cap is reached finish.** New requests are refused at admission, and queued ones are refused when they reach a slot. Refused requests are settled and never replayed. |
| D5 | **Months are UTC calendar months,** matching AWS billing. Messages give reset times in America/New_York. |
| D6 | **Alerts** go to one channel, once per threshold per month, with `@here` on the configured thresholds. **Percent only.** |
| D7 | **Config** is set in `launcher.conf`, and a restart applies a change. The **ledger** is `spend.json` on the orchestrator state volume. The **price table** is a repo file maintained by the `refresh-bot-runtime` skill. **Status** shows percent only. |

## 3. When the cap is active

The cap is active only when `ENGINE_AUTH=bedrock`, in either runtime: the container runtime always uses it, and launchd does with Phase 2a's setting. Under `ENGINE_AUTH=subscription` there is no Bedrock spend. In that case `status` shows `Bedrock spend cap: not active (subscription auth)`, and nothing is refused.

## 4. Settings

These are read in `loadConfig` (src/config.ts, orchestrator/daemon only). Each one is added to the orchestrator's `environment:` list in `compose.yaml`; `src/container-files.test.ts` enforces that. They are documented in the README settings table.

| Variable | Default | Validation |
|---|---|---|
| `BEDROCK_MONTHLY_CAP_USD` | `1000` | Positive finite number, otherwise startup fails. |
| `SPEND_ALERT_PERCENTS` | `25,50,75,90` | Integers 1-99, strictly ascending, no duplicates. |
| `SPEND_ALERT_HERE_PERCENTS` | `75,90` | Each must appear in `SPEND_ALERT_PERCENTS`. |
| `SPEND_ALERT_CHANNEL` | the first `SLACK_CHANNEL_IDS` entry | A Slack channel ID. |
| `BEDROCK_PRICES_FILE` | `<repo>/pricing/bedrock-prices.json` (in the image: `/app/pricing/bedrock-prices.json`) | Must parse. Must hold a complete entry for the configured `CODEX_BEDROCK_MODEL` and `CLAUDE_BEDROCK_MODEL`. |

- **Model IDs in the orchestrator:** `CODEX_BEDROCK_MODEL` and `CLAUDE_BEDROCK_MODEL` are added to the orchestrator's compose environment as well. Today only the worker gets them, so the orchestrator would price at the defaults.
- **Startup failure is deliberate.** A configured model with no price stops the daemon before it connects to Slack, with a message naming the model and the file. That way spend is never priced at an unknown rate.

## 5. Price table

`pricing/bedrock-prices.json`, keyed by the exact configured model value: a `us.` profile ID today, an application inference profile ARN after section 10.

```json
{
  "source": "https://aws.amazon.com/bedrock/pricing/ (on-demand, us-east-2), checked 2026-11-XX",
  "models": {
    "us.anthropic.claude-opus-5-5": { "input": 0, "cachedInput": 0, "cacheWrite": 0, "output": 0 }
  }
}
```

- **Units:** USD per million tokens. The real values are filled in at implementation from the AWS Bedrock pricing page; `source` records the URL and the date checked. The zeros above are placeholders for the example only. The loader rejects a zero `input` or `output` price, so a placeholder can never ship.
- **Codex token semantics:** whether `cached_input_tokens` is a subset of `input_tokens`, and whether reasoning tokens are already inside `output_tokens`, is settled at implementation against Bedrock's documentation, and recorded in the file as two flags (`cachedIsSubsetOfInput`, `reasoningInOutput`).
- **Until confirmed, the conservative reading applies:** cached tokens are not subtracted from input, and reasoning tokens are added to output. Both overcount, and overcounting is the safe direction for a cap.

## 6. Usage capture

- **Codex** (`src/codex.ts`):
  - **Flag and source of truth:** `buildCodexArgs` adds `--json`. `turn.completed.usage` events become the usage source; their per-field values are summed across turns into a new `CodexUsageDetail { inputTokens, cachedInputTokens, cacheWriteTokens, outputTokens, reasoningTokens }`. `tokensUsed` becomes the sum of those fields, replacing `parseTokensUsed` for Codex.
  - **Progress lines:** these are now JSON events. A small extractor turns `item.completed` / `item.started` events into the same human status lines `src/progress.ts` shows today: an agent message's text, or a command line. Unknown events are dropped from progress but stay in the transcript.
  - **Unaffected:** stall detection resets on any output chunk, and the final message comes from `--output-last-message`.
  - **Usage on failure:** `CodexOutputError`, `CodexStalledError` and `CodexTimeoutError` carry the usage summed from the turns that completed before the failure. Today stall and timeout carry no tokens. A turn cut off mid-way is not counted, which is the one known undercount. The 110% AWS backstop covers it.
  - **Test stubs:** the smoke stub (`scripts/smoke/stub-codex.js`) and the Codex unit tests emit `--json` events.
- **Wire:** the worker sends `codexUsage` beside `tokensUsed` (src/worker.ts outcome; src/jobs/errors.ts for failures). `src/jobs/remote.ts` validates it the same way it validates `ClaudeUsageDetail` (non-negative numbers, defaulting to zero), and `RunUsage` gains `codex?: CodexUsageDetail`.
- **Claude:** already captured. `ClaudeUsageDetail` crosses the wire on success and on `ClaudeRunError`.

## 7. Ledger

- **File:** `spend.json` beside `CURSOR_FILE`. In the container that is `/var/lib/slack-review-bot/state/spend.json` on the `orchestrator-state` volume. Under launchd it is `~/.local/state/slack-review-bot/spend.json`.
- **Writes** use a shared `writeJsonAtomic(file, value)`: write `file.tmp`, then rename. It is extracted from `openCursorStore`'s `persist`, and the cursor store uses it too.

```json
{
  "version": 1,
  "month": "2026-11",
  "spentUsd": 412.3,
  "alerted": [25],
  "capAnnounced": false,
  "entries": [
    { "at": "2026-11-20T14:03:11Z", "runId": "…", "engine": "codex", "model": "us.openai.gpt-5.5",
      "tokens": { "input": 0, "cachedInput": 0, "cacheWrite": 0, "output": 0, "reasoning": 0 }, "costUsd": 0.0 }
  ]
}
```

- **Recording:** each engine run in `usage.engines` is priced and appended through the daemon's existing `recordUsage` hook (src/daemon.ts), which fires once per request, failures included. An engine run with no usage at all (e.g. the worker was lost) is recorded with zero tokens and a `noUsage: true` flag, so the gap shows up in the audit.
- **Rollover:** on the first record or read in a new UTC month, the old file is renamed to `spend-YYYY-MM.json` and a fresh ledger starts. Old months are kept for auditing and are never read again.
- **Unreadable file:** the bot logs `spend.unreadable`, keeps the bad file as `spend.json.corrupt-<ts>`, and starts the month at **100% (capped)** rather than 0. A lost ledger must never reopen spending silently. An operator clears the cap by fixing or deleting the file and restarting; the README covers this.
- **`spentUsd`** is held internally only. No user-facing text shows it.

## 8. Enforcement and messages

Percent is `floor(spentUsd / cap × 100)`.

- **Admission** (src/daemon.ts `dispatch`, after `markHandled` and before `cursors.begin`): if the cap is active and the percent is 100 or more, the bot does the following, and `status` and `help` commands still work.
  1. React with `ERROR_EMOJI`.
  2. Reply in the thread: `This bot's monthly Bedrock spend cap has been reached, so it isn't starting new reviews. Reviews resume on <Mon D> at <h:mm a> ET (the start of the next UTC month), or sooner if the cap is raised.`
  3. Record the cursor (`cursors.record`), so the request is never replayed.
  4. Return `false`.
- **Queued requests are re-checked when they get a slot.** A request admitted below the cap can wait in the queue while other reviews push spend past 100%. So the cap is checked again at the start of the `queue.run` callback (src/daemon.ts), before `runJob`. If the request is now capped, it gets the same refusal: the hourglass/ack reaction is replaced by `ERROR_EMOJI`, the same thread reply is posted, the cursor is settled, and the slot is released without running an engine.
- **Reviews already running** finish (D4). Because of the re-check, overshoot is bounded by `CONCURRENCY` × the cost of one review, not by the length of the backlog.
- **Alerts** are checked after each ledger record:
  - Thresholds in `SPEND_ALERT_PERCENTS` that are now reached and not yet in `alerted` produce **one** channel message, for the highest of them. All of them are then added to `alerted` and persisted before posting, so a crash never re-sends.
  - Message: `<!here> This bot has used 76% of its monthly Bedrock spend cap. New reviews stop at 100%.` The `<!here>` appears only if the highest crossed threshold is in `SPEND_ALERT_HERE_PERCENTS`.
  - When the percent first reaches 100, an `<!here>` message is always sent: `<!here> This bot has reached its monthly Bedrock spend cap. New review requests will be declined until <Mon D> at <h:mm a> ET.` This sets `capAnnounced`.
  - **Raising the cap mid-month:** thresholds already alerted stay alerted. `capAnnounced` resets if the percent drops below 100.
- **Channel post:** `makeSlackEffects` gains `postChannelMessage(channel, text)`, a `chat.postMessage` with no `thread_ts`. Alert failures are logged (`spend.alert_failed`) and never retried in a loop. The threshold stays marked, because a missed alert is better than a repeated one.
- **Status** (src/status.ts `renderStatus` input gains a `spend` summary): `Bedrock spend this month: 41% of cap · resets Nov 30, 7:00 PM ET` (00:00 UTC on Dec 1). When capped: `Bedrock spend this month: cap reached · resets …`. When not active: see section 3.

## 9. Testing

Unit tests, each pinning a failure mode:

- Price loading rejects a missing model, a zero price and bad JSON.
- The conservative Codex reading overcounts and the confirmed reading does not.
- Ledger rollover at a UTC boundary that is still the previous month in ET.
- The unreadable ledger starts capped.
- The atomic write leaves the old file intact if the write fails.
- Threshold crossing: one message for the highest threshold, `@here` only on the configured percents, no repeat after a restart, cap raised mid-month.
- Admission refusal records the cursor and returns false, and `status` still answers while capped.
- A request queued below the cap, which gets its slot after spend has reached 100%, is refused at slot time: no engine runs, the cursor is settled, and the slot is released.
- No user-facing string contains a `$` amount. A test renders every spend message and status line and asserts there is no `$` followed by a digit.
- Codex `--json` parsing: summing across turns, usage on stall, timeout and output errors, and progress lines extracted from events.
- The wire round-trip of `codexUsage`.

The compose smoke stub emits `--json` events, and the smoke checks that the orchestrator's ledger recorded a Codex entry.

## 10. AWS backstop (trade-platform/pulumi)

This is a separate PR, after the bot-side cap ships. It needs another person to approve the deploy.

1. **Application inference profiles**, one per configured model, each copied from its `us.` system profile and tagged `app=slack-review-bot`.
2. **Engine role policy** (`iam/policies/SlackReviewBotBedrockInvoke.ts`): add `bedrock:InvokeModel*` on `arn:aws:bedrock:us-east-2:153538148884:application-inference-profile/*`, conditioned on the tag.
3. **Cost-allocation tag:** activate `app` (Pulumi `aws.costexplorer.CostAllocationTag`).
4. **Budget** (`aws.budgets.Budget`): monthly, cost, filtered to `app$slack-review-bot`, limit = 1.10 × the bot's cap. The limit is a separate Pulumi config value; the `refresh-bot-runtime` skill and the README say to change both together.
5. **Budget action** (`aws.budgets.BudgetAction`): at 100% of the Budget, apply an IAM policy denying `bedrock:InvokeModel*` to `SlackReviewBotEngineRole`, with automatic approval, plus the execution role Budgets needs.
   - **Unverified:** whether the deny is reversed automatically at the next budget period or needs a manual reversal. Settle this in the PR, and if it needs a manual reversal, write a runbook step for it.
6. **Then switch the bot's model settings to the profile ARNs:**
   - Verify Claude Code and Codex both work against the ARNs, as the engine role.
   - Widen `TOML_SAFE_ID` (src/config.ts) to accept ARNs (`:` and `/`), keeping the TOML-injection guard for the Codex `-c` override.
   - Re-key the price table to the ARNs.
   - If Codex's `amazon-bedrock-runtime` path cannot be attributed through a profile (it signs against `project/default`), the backstop covers Claude only, and the issue records that.

## 11. Rollout

1. Implement the bot-side cap (sections 3-9) and merge it **before the container cutover**, which is when Bedrock billing starts.
2. Fill in the price table from the AWS pricing page; the PR quotes the source line.
3. Ship the pulumi backstop (section 10), then switch the model ARNs.
4. Add a price-table step to the `refresh-bot-runtime` skill: whenever a model changes, update the price for the new model, and change the Budget limit whenever the cap changes.
