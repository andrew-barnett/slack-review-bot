# Bedrock Monthly Spend Cap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the bot a hard monthly cap on its own AWS Bedrock spend, priced from token usage and a repo price table, with percentage-only Slack alerts, a percent-of-cap status line, and refusal of new review requests once the cap is reached.

**Architecture:** Codex runs with `--json`, and its `turn.completed.usage` events become a `CodexUsageDetail` that travels beside Claude's existing `ClaudeUsageDetail` through the engines, the launchd runner and the worker wire. The daemon's existing `recordUsage` hook hands each settled request's usage to a spend cap, which prices every engine run from `pricing/bedrock-prices.json` into a month-to-date ledger (an append-only `spend-YYYY-MM.jsonl` journal per UTC month, beside the cursor file) and posts the threshold alerts. Admission and the queue slot ask the cap whether new reviews are refused. Every user-facing string comes from one module and shows percentages only.

**Tech Stack:** TypeScript 5.9 (CommonJS via ts-node for tests, esbuild bundles for `dist/`), Node 22 (`fs`, `Intl`), `tape` tests, `@slack/web-api` 7.19, codex-cli 0.169.0 (`exec --json`), Docker Compose for the local smoke.

**Spec:** `docs/superpowers/specs/2026-11-19-bedrock-spend-cap-design.md` (the binding authority). In scope: sections 3-9, and section 11 step 4 (the price-table step in `.claude/skills/refresh-bot-runtime/SKILL.md`). Section 10 (the pulumi backstop and the switch to application inference profile ARNs) is **out of scope**; it gets its own plan. Tracking: https://github.com/andrew-barnett/slack-review-bot/issues/76 (parent https://github.com/andrew-barnett/slack-review-bot/issues/52).

**Binding rulings on spec ambiguities (the spec wins on any conflict):**

1. **When the cap is active.** The orchestrator never sees `ENGINE_AUTH` (`orchestratorConfig` deletes it, so its `engineAuth` is always `subscription`). The cap is therefore active when `config.runtime === 'container'` **or** `config.engineAuth === 'bedrock'`. This is spec section 3's "the container runtime always uses it".
2. **Usage with no `engines` list.** The launchd single-mode runner (`makeReviewRunner`) returns a `RunUsage` without `engines`. The ledger reads such a usage as one Codex engine run, so a bedrock launchd install is capped too.
3. **Where the price table is read.** `loadConfig` parses the five settings (spec section 4). The price file is read and validated, and the ledger opened, by `openSpendCap` in `runDaemon`, before the first Slack call, and only when the cap is active. A subscription launchd install never reads the file.
4. **Which prices are required.** When the cap is active, both `CODEX_BEDROCK_MODEL` and `CLAUDE_BEDROCK_MODEL` must have a complete entry, whatever `REVIEW_ENGINES` says.
5. **One message at the cap.** When a record takes the percent to 100 or more and the cap is not yet announced for the configured cap (no `cap` line with `capUsd` at or above it), only the cap-reached message is sent; every crossed threshold is marked alerted without its own message. A `cap` line records the cap it was sent for, so raising the cap re-arms the message with no other state.
6. **`SPEND_ALERT_HERE_PERCENTS` default.** Unset means whichever of `75` and `90` appear in `SPEND_ALERT_PERCENTS` (so a custom alert list without 75 does not fail startup). Set to the empty string, it means no threshold alert carries `@here`. The cap-reached message always does.
7. **No alert channel.** With `SPEND_ALERT_CHANNEL` unset and `SLACK_CHANNEL_IDS` empty, alerts are logged as `spend.alert_skipped` and not posted. The cap is still enforced.
8. **Unreadable or unwritable ledger.** A journal line that does not parse, has an unknown `type` or has invalid fields, and a partial last line (no trailing newline, as a crash mid-append leaves), makes the month `locked`: `spend.unreadable` is logged with the file and line number, and the percent reads as at least 100. It stays locked while that line exists; raising the cap does not clear it. Fixing or removing the line and restarting does, and so does the next UTC month (a new file). The first append after a partial line starts with a newline, so the partial line stays on its own and removing it loses nothing else. Storage that cannot be written (the probe on open, or any append, throws) also locks the month, logged as `spend.write_failed`; every `state()` retries the probe, so that lock clears on its own once a probe or append succeeds (`spend.write_recovered`).
9. **Ledger path.** The `spend-YYYY-MM.jsonl` journals sit in the directory of `CURSOR_FILE` (`Config.spendDir`). An empty `CURSOR_FILE` (cursor disabled) falls back to `~/.local/state/slack-review-bot/`, so the cap never switches off with the cursor.
10. **Codex progress lines.** `item.started` and `item.completed` events show an `agent_message`'s `text` or a `command_execution`'s `command`. Every other event is dropped from progress. A line that is not JSON (a stderr diagnostic) is shown as before. A line that starts with `{` but does not parse is never shown.
11. **Codex `tokensUsed`.** The sum of the five `CodexUsageDetail` fields, as the spec says, so the displayed token count includes cached and reasoning tokens. The `tokens used` transcript footer is no longer read for Codex.
12. **Slot refusal outcome.** A request refused at its slot settles as `skipped` in the `status` counts.
13. **Notional Claude figures are unchanged.** The `$… notional` Claude figures in the `*Tokens*` status line and the per-review usage reply are neither the cap nor the spend (spec D2: `costUsd` is not used), so they stay. The `$`-amount test covers every spend message and the spend status line, and a full status reply with no Claude usage.
14. **The CLI is not capped.** `npm run review` runs outside the daemon and its `recordUsage` hook, so its runs are not recorded in the ledger.
15. **Price-table flags live under `codexTokenSemantics`.** The two spec flags are `codexTokenSemantics.cachedIsSubsetOfInput` and `codexTokenSemantics.reasoningInOutput`. Both `false` is the conservative reading.
16. **Status line placement and text.** The spend line is the spec's text verbatim, with no `*bold*` label, placed right after the `*Tokens*` line.
17. **A failed run append loses at most that run, after a restart.** When appending a `run` line throws, the run's cost is still added to the in-memory total (this process stays capped and counts it) and the process reads as locked. If storage is still unwritable at the next start, the probe locks the month. If storage has recovered by then, that one run's cost is lost. That is the accepted residual: at most the reviews running at that moment, and the AWS Budget backstop (spec section 10) covers it.
18. **No shared atomic-write helper.** The ledger only appends, so it needs no write-then-rename. The `writeJsonAtomic` extraction from the cursor store existed only to share it with the ledger, so it is dropped: `src/cursor.ts` is not touched by this plan.

## Global Constraints

- The cap applies to this bot only. It is active only per ruling 1. Under `ENGINE_AUTH=subscription` in the launchd runtime, `status` shows `Bedrock spend cap: not active (subscription auth)` and nothing is refused.
- **User-facing text never shows a dollar amount — not the cap, and not the spend.** It shows only percentages, or the fact that the cap has been reached.
- `BEDROCK_MONTHLY_CAP_USD` default `1000`, a positive finite number, otherwise startup fails.
- `SPEND_ALERT_PERCENTS` default `25,50,75,90`: integers 1-99, strictly ascending, no duplicates.
- `SPEND_ALERT_HERE_PERCENTS` default `75,90` (ruling 6): each must appear in `SPEND_ALERT_PERCENTS`.
- `SPEND_ALERT_CHANNEL` default: the first `SLACK_CHANNEL_IDS` entry. A Slack channel ID.
- `BEDROCK_PRICES_FILE` default `<repo>/pricing/bedrock-prices.json` (in the image: `/app/pricing/bedrock-prices.json`). Must parse. Must hold a complete entry for the configured `CODEX_BEDROCK_MODEL` and `CLAUDE_BEDROCK_MODEL`.
- Each of the five settings, plus `CODEX_BEDROCK_MODEL` and `CLAUDE_BEDROCK_MODEL`, is in the orchestrator's `environment:` list in `compose.yaml`. They are documented in the README settings table.
- A configured model with no price stops the daemon before it connects to Slack, with a message naming the model and the file.
- Price table units: USD per million tokens, keyed by the exact configured model value. The loader rejects a zero `input` or `output` price. `source` records the URL and the date checked. **No price number is invented anywhere in this plan; test fixtures are synthetic and say so.**
- Until confirmed, the conservative Codex reading applies: cached tokens are not subtracted from input, and reasoning tokens are added to output.
- Claude's `costUsd` is never used for spend.
- Ledger: one append-only JSON Lines journal per UTC month, `spend-YYYY-MM.jsonl` beside `CURSOR_FILE` (container: `/var/lib/slack-review-bot/state/spend-2026-11.jsonl` on the `orchestrator-state` volume; launchd: `~/.local/state/slack-review-bot/spend-2026-11.jsonl`). Each line is a `run`, `alert` or `cap` record, written with one `fs.appendFileSync` per call. The bot never rewrites, renames or deletes a journal; a new month is a new file.
- Months are UTC calendar months. Messages give reset times in America/New_York.
- Percent is `floor(spentUsd / cap × 100)`.
- Refusal reply, verbatim: `This bot's monthly Bedrock spend cap has been reached, so it isn't starting new reviews. Reviews resume on <Mon D> at <h:mm a> ET (the start of the next UTC month), or sooner if the cap is raised.`
- Threshold alert, verbatim: `<!here> This bot has used 76% of its monthly Bedrock spend cap. New reviews stop at 100%.` (`<!here> ` only when the highest crossed threshold is in `SPEND_ALERT_HERE_PERCENTS`).
- Cap alert, verbatim: `<!here> This bot has reached its monthly Bedrock spend cap. New review requests will be declined until <Mon D> at <h:mm a> ET.`
- Status, verbatim: `Bedrock spend this month: 41% of cap · resets Nov 30, 7:00 PM ET`, or `Bedrock spend this month: cap reached · resets …`.
- Alerts go to one channel, once per threshold per month. Thresholds are persisted before posting. A failed post is logged as `spend.alert_failed` and never retried; the threshold stays marked.
- Reviews already running when the cap is reached finish. New requests are refused at admission; queued ones are refused when they reach a slot. Refused requests are settled and never replayed.
- `TOML_SAFE_ID` and every section 10 item are untouched.
- Log lines use constant event names with variable data in the fields object (the existing `log(event, fields)` style). Never log a token, a credential, or a dollar figure in a user-facing surface.
- Every test carries a comment stating its purpose and the failure mode it catches. Tests use synthetic values only.
- `Replace` blocks give the exact existing text and its replacement; apply them with the editor tool. `Create` blocks are the whole file. Make every file edit with the editor tools, not shell heredocs: the operator's secret-blocking hook rejects shell commands whose text mentions credentials or env files.
- Commits: Conventional Commits, ending `(refs andrew-barnett/slack-review-bot#76)`, with `[cc](https://claude.com/claude-code)` as the last line. Write the message to `/tmp/srb-commit-msg.txt` with the editor tool and commit with `git commit -F /tmp/srb-commit-msg.txt`.
- Run one test file with `npx ts-node --compiler-options '{"module":"commonjs"}' --transpile-only src/<x>.test.ts`; the suite with `npm test`; typecheck with `npm run typecheck`; bundle with `npm run build`.

## Review Focus

1. **The orchestrator's `engineAuth` is always `subscription`.** `orchestratorConfig` deletes `ENGINE_AUTH`, so a cap keyed on `engineAuth` alone would be silently off in the container runtime, the one runtime that spends on Bedrock. A person expects the container bot to be capped. Pinned in Task 6 (`spendCapActive: container always, launchd only under bedrock auth`).
2. **A launchd bedrock install in single mode.** Its usage has no `engines` list. If the ledger only walked `usage.engines`, it would record nothing and the cap would never trip. Pinned in Task 6 (`record reads a usage with no engines list as one Codex run`) and Task 2 (`makeReviewRunner carries Codex usage summed across a stall and the success`).
3. **A `turn.completed` line split across two stdout reads, or pushed out of the 64 KiB transcript tail by a long run.** Reading usage from the bounded transcript, or per chunk, would drop turns and under-count spend. The usage reader reads raw stdout line by line. Pinned in Task 1 (`the usage reader joins an event split across chunks`).
4. **One very expensive review that takes spend from under 25% to over 100%.** A person expects one cap-reached message, not a threshold alert and then a cap alert. Pinned in Task 6 (`a jump past the cap sends only the cap message and caps`).
5. **A custom `SPEND_ALERT_PERCENTS` without 75.** With the literal `75,90` default for `@here`, startup would fail on a setting the operator never touched. Pinned in Task 5 (`parseHerePercents must be a subset of the alert percents, and its default follows them`).
6. **A cap raise after the cap was announced, then one record that crosses the new cap.** A person expects the cap-reached message again. A boolean "announced" flag reset only by a record below 100% stays set when no such record comes, and the message is silently skipped. Pinned in Task 6 (`after a cap raise, the first record that crosses the new cap announces it`).

---

## File Structure

| File | Responsibility |
|---|---|
| `src/codex-events.ts` (create) | Read `codex exec --json`: the usage reader over raw stdout, the event-to-progress-line filter |
| `src/usage.ts` (modify) | `CodexUsageDetail`, `codexTotalTokens`, `addCodexUsage`; `RunUsage.codex` |
| `src/codex.ts` (modify) | `--json`; usage from events; usage on every Codex error |
| `src/engine.ts`, `src/review.ts` (modify) | Carry Codex usage across attempts in the engines and the launchd runner |
| `src/worker.ts`, `src/jobs/remote.ts`, `src/jobs/errors.ts` (modify) | `codexUsage` on the worker wire, validated like Claude's usage |
| `src/pricing.ts` (create) | Price table types, loader, validation, and the token-to-dollars arithmetic |
| `src/spend-ledger.ts` (create) | The monthly `spend-YYYY-MM.jsonl` journals: read, month switch, bad-line and unwritable locking, append runs, alerts and cap announcements |
| `src/config.ts` (modify) | The five settings and the ledger path |
| `compose.yaml` (modify) | Orchestrator gets the settings and the model IDs |
| `src/spend-messages.ts` (create) | Every user-facing spend string, and the ET reset time |
| `src/spend-cap.ts` (create) | Is the cap active, price and record a request, alerts, status summary, `openSpendCap` |
| `src/status.ts` (modify) | The spend status line |
| `src/slack.ts` (modify) | `postChannelMessage` |
| `src/spend-gate.ts` (create) | Refusal at admission and at the queue slot |
| `src/daemon.ts` (modify) | Wiring: open the cap, admission, slot, record, status |
| `pricing/bedrock-prices.json` (create) | The real price table, filled from the AWS pricing page |
| `Dockerfile` (modify) | Ship `pricing/` in the image |
| `scripts/smoke/stub-codex.js` (modify) | Emit `--json` events with usage |
| `src/orchestrator.ts`, `src/orchestrator-main.ts`, `src/smoke.ts` (modify) | The smoke records to the ledger and checks it |
| `README.md`, `.claude/skills/refresh-bot-runtime/SKILL.md` (modify) | Settings, operation, recovery; the price-table step |
| `src/**/*.test.ts` | One test file per new unit; appended tests for modified units |

---

### Task 1: Codex `--json` usage capture (`src/codex-events.ts`, `src/codex.ts`)

**Files:**
- Create: `src/codex-events.ts`
- Test: `src/codex-events.test.ts`
- Modify: `src/usage.ts`, `src/codex.ts`, `src/codex.test.ts`, `scripts/smoke/stub-codex.js`

**Interfaces:**
- Consumes: `superviseChild`'s existing `onStdout` (raw stdout) and `onProgress` (redacted spans) options in `src/supervise.ts`.
- Produces:
  - `src/usage.ts`: `interface CodexUsageDetail { inputTokens: number; cachedInputTokens: number; cacheWriteTokens: number; outputTokens: number; reasoningTokens: number }`, `codexTotalTokens(u: CodexUsageDetail): number`, `addCodexUsage(a: CodexUsageDetail | undefined, b: CodexUsageDetail | undefined): CodexUsageDetail | undefined`
  - `src/codex-events.ts`: `CODEX_EVENT_LINE_LIMIT = 8 * 1024 * 1024`, `turnUsage(value: unknown): CodexUsageDetail`, `createCodexUsageReader(lineLimit?: number): { push(text: string): void; flush(): void; usage(): CodexUsageDetail | undefined }`, `codexProgressLine(event: Record<string, unknown>): string | undefined`, `codexProgressFilter(sink: (line: string, activeMs: number) => void, lineLimit?: number): (span: string, activeMs: number) => void`
  - `src/codex.ts`: `CodexRunOutcome.codexUsage?: CodexUsageDetail`; `CodexStalledError(message, stallMs, snapshot, codexUsage?)`, `CodexTimeoutError(message, snapshot, codexUsage?)`, `CodexOutputError(message, tokensUsed, activeMs, codexUsage?)`, each with `readonly codexUsage?: CodexUsageDetail`; `buildCodexArgs` output includes `--json`.

- [ ] **Step 1: Write the failing tests**

Create `src/codex-events.test.ts`:

```ts
import { spawnSync } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import test from 'tape'
import { codexProgressFilter, codexProgressLine, createCodexUsageReader, turnUsage } from './codex-events'
import { addCodexUsage, codexTotalTokens } from './usage'

const zero = { inputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 0, reasoningTokens: 0 }
const turn = (usage: Record<string, number>) => JSON.stringify({ type: 'turn.completed', usage })

// Spec 6: usage is summed across every turn.completed event. Regression caught: keeping only the last
// turn's usage, which under-reports a multi-turn run and lets spend slip past the cap.
test('the usage reader sums every turn.completed across turns', t => {
  const reader = createCodexUsageReader()
  reader.push(`${JSON.stringify({ type: 'thread.started', thread_id: 't' })}\n${turn({ input_tokens: 100, cached_input_tokens: 40, cache_write_input_tokens: 5, output_tokens: 20, reasoning_output_tokens: 7 })}\n`)
  reader.push(`${turn({ input_tokens: 50, cached_input_tokens: 10, cache_write_input_tokens: 0, output_tokens: 30, reasoning_output_tokens: 3 })}\n`)
  reader.flush()
  t.deepEqual(reader.usage(), { inputTokens: 150, cachedInputTokens: 50, cacheWriteTokens: 5, outputTokens: 50, reasoningTokens: 10 })
  t.end()
})

// A pipe read can end mid-line. Regression caught: parsing each chunk on its own, which drops a turn
// whose line straddles two reads (Review Focus 3).
test('the usage reader joins an event split across chunks', t => {
  const reader = createCodexUsageReader()
  const line = turn({ input_tokens: 9, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 })
  reader.push(line.slice(0, 10))
  t.equal(reader.usage(), undefined, 'nothing is counted from half a line')
  reader.push(`${line.slice(10)}\n`)
  t.deepEqual(reader.usage(), { ...zero, inputTokens: 9, outputTokens: 1 })
  t.end()
})

// The last line may arrive without a newline when the child exits; flush must still count it.
test('the usage reader counts a final line without a newline on flush', t => {
  const reader = createCodexUsageReader()
  reader.push(turn({ input_tokens: 3, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0 }))
  reader.flush()
  t.deepEqual(reader.usage(), { ...zero, inputTokens: 3 })
  t.end()
})

// A run with no completed turn has unknown usage, not zero usage, so the ledger records the gap
// (noUsage) instead of a free run.
test('the usage reader reports undefined when no turn completed', t => {
  const reader = createCodexUsageReader()
  reader.push('{"type":"turn.started"}\nnot json at all\n{"type":"turn.completed"\n')
  reader.flush()
  t.equal(reader.usage(), undefined)
  t.end()
})

// Malformed numbers must never corrupt the totals: a negative count would lower recorded spend, and
// NaN would poison every later sum.
test('turnUsage clamps missing, negative and non-numeric fields to zero', t => {
  t.deepEqual(turnUsage({ input_tokens: -5, cached_input_tokens: 'x', output_tokens: Number.NaN, reasoning_output_tokens: 2 }), { ...zero, reasoningTokens: 2 })
  t.deepEqual(turnUsage(null), zero)
  t.deepEqual(turnUsage([1, 2]), zero)
  t.end()
})

// Spec 6: tokensUsed is the sum of the five fields; and summing keeps "unknown" distinct from zero.
test('codexTotalTokens sums all five fields and addCodexUsage keeps unknown only when both are', t => {
  const u = { inputTokens: 1, cachedInputTokens: 2, cacheWriteTokens: 3, outputTokens: 4, reasoningTokens: 5 }
  t.equal(codexTotalTokens(u), 15)
  t.equal(addCodexUsage(undefined, undefined), undefined)
  t.deepEqual(addCodexUsage(u, undefined), u)
  t.deepEqual(addCodexUsage(undefined, u), u)
  t.deepEqual(addCodexUsage(u, u), { inputTokens: 2, cachedInputTokens: 4, cacheWriteTokens: 6, outputTokens: 8, reasoningTokens: 10 })
  t.end()
})

// Ruling 10: the status reply shows an agent message or the command being run; turn and thread events,
// and reasoning items, carry nothing a reader wants.
test('codexProgressLine shows agent messages and commands and drops other events', t => {
  t.equal(codexProgressLine({ type: 'item.completed', item: { id: 'i', type: 'agent_message', text: 'reading the diff' } }), 'reading the diff')
  t.equal(codexProgressLine({ type: 'item.started', item: { id: 'i', type: 'command_execution', command: 'npm test' } }), 'npm test')
  t.equal(codexProgressLine({ type: 'turn.completed', usage: {} }), undefined)
  t.equal(codexProgressLine({ type: 'item.completed', item: { id: 'i', type: 'reasoning', text: 'x' } }), undefined)
  t.equal(codexProgressLine({ type: 'item.completed' }), undefined, 'an item event with no item is dropped, not a crash')
  t.end()
})

// Raw JSON must never reach the status line, but plain lines (stderr diagnostics) still do, as before
// --json. Regression caught: the status reply showing `{"type":"turn.started"}` as the run's activity.
test('codexProgressFilter turns events into lines, drops unknown events and keeps plain text', t => {
  const seen: Array<{ line: string; activeMs: number }> = []
  const filter = codexProgressFilter((line, activeMs) => seen.push({ line, activeMs }))
  filter(`{"type":"turn.started"}\n${JSON.stringify({ type: 'item.completed', item: { id: 'a', type: 'agent_message', text: 'checking tests' } })}\n`, 5)
  filter('{"type":"thread.started","thread_id":"t"}\n', 6)
  filter('warning: something on stderr\n', 7)
  filter('{"type": broken json\n', 8)
  t.deepEqual(seen, [
    { line: 'checking tests', activeMs: 5 },
    { line: 'warning: something on stderr', activeMs: 7 },
  ])
  t.end()
})

// A JSON event split across two spans is held until complete, so half an event is never shown raw.
test('codexProgressFilter holds an unfinished event until its newline', t => {
  const seen: string[] = []
  const filter = codexProgressFilter(line => seen.push(line))
  const event = JSON.stringify({ type: 'item.completed', item: { id: 'a', type: 'agent_message', text: 'half and half' } })
  filter(event.slice(0, 20), 1)
  t.deepEqual(seen, [], 'nothing shown for half an event')
  filter(`${event.slice(20)}\n`, 2)
  t.deepEqual(seen, ['half and half'])
  t.end()
})

// The compose smoke drives this stub. It must emit the codex-cli 0.169.0 --json shapes the reader and
// the filter parse. Regression caught: a stub left printing plain text, so the smoke's ledger check
// could never see Codex usage.
test('the smoke stub emits --json events with usage and one progress line', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stub-codex-'))
  const out = path.join(dir, 'final.json')
  const stub = path.join(__dirname, '..', 'scripts', 'smoke', 'stub-codex.js')
  const run = spawnSync(process.execPath, [stub, 'exec', '--json', '--output-last-message', out, 'prompt'], { encoding: 'utf8' })
  t.equal(run.status, 0, run.stderr)
  const reader = createCodexUsageReader()
  reader.push(run.stdout)
  reader.flush()
  t.deepEqual(reader.usage(), { inputTokens: 1200, cachedInputTokens: 200, cacheWriteTokens: 0, outputTokens: 300, reasoningTokens: 40 })
  const lines: string[] = []
  codexProgressFilter(line => lines.push(line))(run.stdout, 0)
  t.deepEqual(lines, ['stub-codex: reviewing'])
  t.deepEqual(JSON.parse(fs.readFileSync(out, 'utf8')), { results: [] })
  const plain = spawnSync(process.execPath, [stub, 'exec', '--output-last-message', out, 'prompt'], { encoding: 'utf8' })
  t.equal(plain.status, 2, 'the stub refuses to run without --json, so a dropped flag fails the smoke')
  fs.rmSync(dir, { recursive: true, force: true })
  t.end()
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx ts-node --compiler-options '{"module":"commonjs"}' --transpile-only src/codex-events.test.ts`
Expected: FAIL with `Cannot find module './codex-events'`.

- [ ] **Step 3: Add the usage type and helpers**

In `src/usage.ts`, replace:

```ts
  costUsd: number
  numTurns: number
  durationMs: number
}

/**
 * The cost of a single review request, gathered whether it passed, found things, or failed.
```

with:

```ts
  costUsd: number
  numTurns: number
  durationMs: number
}

/**
 * What `codex exec --json` reports a run cost: each `turn.completed.usage`, summed over the run's
 * turns (spec 6; field names from codex-cli 0.169.0). Whether `cachedInputTokens` is inside
 * `inputTokens`, and `reasoningTokens` inside `outputTokens`, is the price table's to say.
 */
export interface CodexUsageDetail {
  inputTokens: number
  cachedInputTokens: number
  cacheWriteTokens: number
  outputTokens: number
  reasoningTokens: number
}

/** A Codex run's token total for the usage line and the status: the sum of every field (spec 6). */
export function codexTotalTokens(u: CodexUsageDetail): number {
  return u.inputTokens + u.cachedInputTokens + u.cacheWriteTokens + u.outputTokens + u.reasoningTokens
}

/** Sum two optional Codex usage breakdowns field by field; unknown only when both are unknown. */
export function addCodexUsage(
  a: CodexUsageDetail | undefined,
  b: CodexUsageDetail | undefined
): CodexUsageDetail | undefined {
  if (!a) return b
  if (!b) return a
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    cachedInputTokens: a.cachedInputTokens + b.cachedInputTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    reasoningTokens: a.reasoningTokens + b.reasoningTokens,
  }
}

/**
 * The cost of a single review request, gathered whether it passed, found things, or failed.
```

- [ ] **Step 4: Write the event reader**

Create `src/codex-events.ts`:

```ts
// Reading `codex exec --json` (codex-cli 0.169.0). Stdout is one JSON event per line: thread.started,
// turn.started, item.started / item.completed (agent messages, commands and other items) and
// turn.completed, whose `usage` is the source of truth for what a run cost (spec 6). Two readers share
// the line format: the usage reader sums every turn.completed on the raw stdout, and the progress
// filter turns events into the human status lines the status reply shows (ruling 10).

import { addCodexUsage, type CodexUsageDetail } from './usage'

/** Longest line held while waiting for its newline; Codex events are far smaller. */
export const CODEX_EVENT_LINE_LIMIT = 8 * 1024 * 1024

/** A finite, non-negative count, or 0. */
const count = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0)

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}

/** One turn.completed `usage` object as a CodexUsageDetail; absent or malformed fields read as 0. */
export function turnUsage(value: unknown): CodexUsageDetail {
  const u = asRecord(value)
  return {
    inputTokens: count(u.input_tokens),
    cachedInputTokens: count(u.cached_input_tokens),
    cacheWriteTokens: count(u.cache_write_input_tokens),
    outputTokens: count(u.output_tokens),
    reasoningTokens: count(u.reasoning_output_tokens),
  }
}

/** Parse one line as a JSON event object, or undefined. */
function parseEvent(line: string): Record<string, unknown> | undefined {
  const trimmed = line.trim()
  if (!trimmed.startsWith('{')) return undefined
  try {
    const value = JSON.parse(trimmed) as unknown
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

/**
 * Sums the usage of every turn.completed event on Codex's raw stdout. Lines are split on newlines across
 * chunks, so an event that straddles two pipe reads still counts. Only the numbers are kept.
 */
export function createCodexUsageReader(lineLimit: number = CODEX_EVENT_LINE_LIMIT): {
  push(text: string): void
  flush(): void
  usage(): CodexUsageDetail | undefined
} {
  let partial = ''
  let overflowed = false
  let total: CodexUsageDetail | undefined
  const take = (line: string) => {
    if (!line.includes('turn.completed')) return
    const event = parseEvent(line)
    if (event?.type === 'turn.completed') total = addCodexUsage(total, turnUsage(event.usage))
  }
  return {
    push(text) {
      const pieces = (partial + text).split('\n')
      partial = pieces.pop() ?? ''
      for (const piece of pieces) {
        if (overflowed) {
          // The rest of an over-long line; drop it and resume at the next line.
          overflowed = false
          continue
        }
        take(piece)
      }
      if (partial.length > lineLimit) {
        partial = ''
        overflowed = true
      }
    },
    flush() {
      if (!overflowed && partial) take(partial)
      partial = ''
      overflowed = false
    },
    usage: () => total,
  }
}

/** The human status line for one event: an agent message's text or a command; undefined for anything else. */
export function codexProgressLine(event: Record<string, unknown>): string | undefined {
  if (event.type !== 'item.started' && event.type !== 'item.completed') return undefined
  const item = asRecord(event.item)
  if (item.type === 'agent_message' && typeof item.text === 'string') return item.text
  if (item.type === 'command_execution' && typeof item.command === 'string') return item.command
  return undefined
}

/**
 * Wrap a progress sink so it receives human lines instead of raw JSON events. `span` is output the
 * supervisor has already redacted (stdout and stderr interleaved). A JSON line becomes the line
 * codexProgressLine gives, or nothing; a line that is not JSON passes through as before --json; a line
 * that starts with `{` but does not parse is never shown. An unfinished JSON line is held until its
 * newline arrives. Called once per span with every shown line, or not at all.
 */
export function codexProgressFilter(
  sink: (line: string, activeMs: number) => void,
  lineLimit: number = CODEX_EVENT_LINE_LIMIT
): (span: string, activeMs: number) => void {
  let partial = ''
  return (span, activeMs) => {
    const pieces = (partial + span).split('\n')
    const last = pieces.pop() ?? ''
    partial = ''
    if (last.trimStart().startsWith('{') && last.length <= lineLimit) {
      // A JSON event in flight: wait for the rest of it.
      partial = last
    } else if (last) {
      pieces.push(last)
    }
    const shown: string[] = []
    for (const piece of pieces) {
      if (!piece.trim()) continue
      const event = parseEvent(piece)
      if (event) {
        const line = codexProgressLine(event)
        if (line) shown.push(line)
        continue
      }
      if (piece.trimStart().startsWith('{')) continue
      shown.push(piece)
    }
    if (shown.length) sink(shown.join('\n'), activeMs)
  }
}
```

- [ ] **Step 5: Make the smoke stub emit `--json` events**

Replace the whole of `scripts/smoke/stub-codex.js` with:

```js
#!/usr/bin/env node
// Stub engine for scripts/compose-smoke.sh: prints the `codex exec --json` events a one-turn run emits
// (codex-cli 0.169.0 shapes) with a fixed, synthetic usage, and writes an empty, valid report-only
// result to the path after --output-last-message. It reads nothing and calls nothing.
'use strict'
const fs = require('fs')

const args = process.argv.slice(2)
const at = args.indexOf('--output-last-message')
if (at < 0 || !args[at + 1]) {
  console.error('stub-codex: no --output-last-message')
  process.exit(2)
}
if (!args.includes('--json')) {
  console.error('stub-codex: expected --json (the bot reads usage from turn.completed events)')
  process.exit(2)
}
const emit = event => console.log(JSON.stringify(event))
emit({ type: 'thread.started', thread_id: 'smoke-thread' })
emit({ type: 'turn.started' })
emit({ type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: 'stub-codex: reviewing' } })
fs.writeFileSync(args[at + 1], JSON.stringify({ results: [] }))
emit({
  type: 'turn.completed',
  usage: { input_tokens: 1200, cached_input_tokens: 200, cache_write_input_tokens: 0, output_tokens: 300, reasoning_output_tokens: 40 },
})
```

Run: `test -x scripts/smoke/stub-codex.js && echo executable`
Expected: `executable` (the file was already executable; a whole-file write through the editor keeps the mode. If it prints nothing, run `chmod +x scripts/smoke/stub-codex.js`).

- [ ] **Step 6: Run the new tests to verify they pass**

Run: `npx ts-node --compiler-options '{"module":"commonjs"}' --transpile-only src/codex-events.test.ts`
Expected: PASS (all ten tests).

- [ ] **Step 7: Update the Codex runner tests for `--json`**

In `src/codex.test.ts`, replace:

```ts
import { parseTokensUsed } from './usage'
```

with:

```ts
import { parseTokensUsed } from './usage'

/** One `codex exec --json` turn.completed line (codex-cli 0.169.0 field names). */
function turnCompleted(input: number, output = 0, cached = 0, reasoning = 0): string {
  const usage = { input_tokens: input, cached_input_tokens: cached, cache_write_input_tokens: 0, output_tokens: output, reasoning_output_tokens: reasoning }
  return `${JSON.stringify({ type: 'turn.completed', usage })}\n`
}
```

In the same file, replace:

```ts
// The run has to surface what it cost: Codex's "tokens used" total, parsed out of the
// transcript, and the active time the deadline charged. This is what the status totals and the
// per-review thread line are built from.
test('runCodexReview reports the token total and active time on a completed run', async t => {
```

with:

```ts
// The run has to surface what it cost. Under --json that is the summed turn.completed usage (spec 6),
// its token total, and the active time the deadline charged. This is what the spend ledger, the status
// totals and the per-review thread line are built from.
test('runCodexReview reports the Codex usage, its token total and active time on a completed run', async t => {
```

In the same file, replace:

```ts
  // Codex prints its running total to the transcript; the two-line form is what `codex exec` emits.
  child.stdout.write('reviewing...\ntokens used\n300,448\n')
```

with:

```ts
  // Under --json, Codex reports each turn's usage as a turn.completed event on stdout.
  child.stdout.write(`{"type":"turn.started"}\n${turnCompleted(300_000, 48, 400)}`)
```

In the same file, replace:

```ts
  t.equal(outcome.tokensUsed, 300_448, 'the token total is parsed from the transcript')
```

with:

```ts
  t.deepEqual(outcome.codexUsage, { inputTokens: 300_000, cachedInputTokens: 400, cacheWriteTokens: 0, outputTokens: 48, reasoningTokens: 0 })
  t.equal(outcome.tokensUsed, 300_448, 'the token total is the sum of the usage fields')
```

In the same file, replace:

```ts
  child.stdout.write('tokens used\n250,000\n')
```

with:

```ts
  child.stdout.write(turnCompleted(250_000))
```

In the same file, replace:

```ts
    t.equal(error.tokensUsed, 250_000, 'the token total the run printed is carried')
```

with:

```ts
    t.equal(error.tokensUsed, 250_000, 'the token total the run reported is carried')
    t.deepEqual(error.codexUsage, { inputTokens: 250_000, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 0, reasoningTokens: 0 })
```

In the same file, replace:

```ts
  child.stdout.write('tokens used\n80,000\n')
```

with:

```ts
  child.stdout.write(turnCompleted(80_000))
```

In the same file, replace:

```ts
    t.equal(error.tokensUsed, 80_000, 'usage rides on the error even with no output file')
```

with:

```ts
    t.equal(error.tokensUsed, 80_000, 'usage rides on the error even with no output file')
    t.deepEqual(error.codexUsage, { inputTokens: 80_000, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 0, reasoningTokens: 0 })
```

Append to `src/codex.test.ts`:

```ts
// Spec 6: usage comes from --json events. Without the flag Codex prints no events and every run would
// be recorded with no usage. Regression caught: --json dropped from the argument list.
test('buildCodexArgs asks codex exec for --json events', t => {
  const args = buildCodexArgs({ profile: 'p', workspaceRoot: '/w', worktreeRoot: '/t', schemaPath: '/s', outputPath: '/o', prompt: 'x' })
  t.ok(args.includes('--json'))
  t.equal(args[args.length - 1], 'x', 'the prompt stays the trailing positional')
  t.end()
})

// Ruling 11: the transcript footer is no longer read for Codex, so text in a reviewed diff that looks
// like "tokens used N" can never stand in for (or fake) the run's real usage.
test('runCodexReview no longer reads a "tokens used" footer as usage', async t => {
  const child = new FakeChild()
  let outputPath = ''
  const spawner = ((_bin: string, args: string[]) => {
    outputPath = args[args.indexOf('--output-last-message') + 1]
    return child
  }) as unknown as Spawner
  const run = runCodexReview(runOptions(), spawner, fakeClock().deps)
  await settle()
  child.stdout.write('tokens used\n300,448\n')
  await settle()
  fs.writeFileSync(
    outputPath,
    JSON.stringify({ results: [{ url: 'https://github.com/o/r/pull/1', status: 'passed', summary: '', pushedTestCommits: false, reviewUrl: '' }] })
  )
  child.emit('close', 0)
  const outcome = await run
  t.equal(outcome.tokensUsed, undefined)
  t.equal(outcome.codexUsage, undefined)
  t.end()
})

// Spec 6: a stall carries the usage of the turns that completed before it. Today it carried none, so a
// stalled run's spend was invisible to the cap.
test('runCodexReview carries the completed turns\' usage on a stall', async t => {
  const child = new FakeChild()
  const clock = fakeClock()
  const run = runCodexReview({ ...runOptions(), stallTimeoutMs: 40_000 }, (() => child) as unknown as Spawner, clock.deps).then(
    () => undefined,
    (error: unknown) => error
  )
  await settle()
  child.stdout.write(turnCompleted(1000, 100))
  await settle()
  for (let i = 0; i < 4; i += 1) clock.tick(10_000)
  await settle()
  const error = await run
  t.ok(error instanceof CodexStalledError, 'still the retryable stall')
  if (error instanceof CodexStalledError) {
    t.deepEqual(error.codexUsage, { inputTokens: 1000, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 100, reasoningTokens: 0 })
  }
  t.end()
})

// Spec 6: a timeout carries the usage of the turns that completed before the kill.
test('runCodexReview carries the completed turns\' usage on a timeout', async t => {
  const child = new FakeChild()
  const clock = fakeClock()
  const run = runCodexReview(runOptions(), (() => child) as unknown as Spawner, clock.deps).then(
    () => undefined,
    (error: unknown) => error
  )
  await settle()
  child.stdout.write(turnCompleted(500, 50, 0, 5))
  await settle()
  for (let i = 0; i < 6; i += 1) clock.tick(10_000)
  await settle()
  const error = await run
  t.ok(error instanceof CodexTimeoutError, 'still the terminal timeout')
  if (error instanceof CodexTimeoutError) {
    t.deepEqual(error.codexUsage, { inputTokens: 500, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 50, reasoningTokens: 5 })
  }
  t.end()
})

// Ruling 10: the status reply's live line shows what the run is doing, not raw JSON events.
test('runCodexReview shows --json events as human progress lines, never raw JSON', async t => {
  const child = new FakeChild()
  let outputPath = ''
  const spawner = ((_bin: string, args: string[]) => {
    outputPath = args[args.indexOf('--output-last-message') + 1]
    return child
  }) as unknown as Spawner
  const progress: string[] = []
  const run = runCodexReview({ ...runOptions(), timeoutMs: 10 * 60_000, onProgress: line => progress.push(line) }, spawner, fakeClock().deps)
  await settle()
  child.stdout.write(`${JSON.stringify({ type: 'item.completed', item: { id: 'i1', type: 'agent_message', text: 'reading the diff' } })}\n`)
  child.stdout.write(turnCompleted(10, 1))
  await settle()
  t.deepEqual(progress, ['reading the diff'])
  fs.writeFileSync(
    outputPath,
    JSON.stringify({ results: [{ url: 'https://github.com/o/r/pull/1', status: 'passed', summary: '', pushedTestCommits: false, reviewUrl: '' }] })
  )
  child.emit('close', 0)
  await run
  t.end()
})
```

- [ ] **Step 8: Run the Codex tests to verify they fail**

Run: `npx ts-node --compiler-options '{"module":"commonjs"}' --transpile-only src/codex.test.ts`
Expected: FAIL. `buildCodexArgs asks codex exec for --json events` fails, and the usage assertions fail (`codexUsage` is `undefined`; `tokensUsed` is `undefined` where `300448` is expected).

- [ ] **Step 9: Implement `--json` usage in the runner**

In `src/codex.ts`, replace:

```ts
import { parseTokensUsed } from './usage'
import { redactSecrets } from './redact'
```

with:

```ts
import { codexProgressFilter, createCodexUsageReader } from './codex-events'
import { codexTotalTokens, type CodexUsageDetail } from './usage'
import { redactSecrets } from './redact'
```

In the same file, replace:

```ts
  /** Codex's reported "tokens used" total, or undefined when it printed none. */
  tokensUsed?: number
  /** Active time charged to the run, in ms (suspension discounted); 0 for a run too short to tick. */
  activeMs: number
}
```

with:

```ts
  /** The sum of `codexUsage`'s fields, or undefined when no turn completed. */
  tokensUsed?: number
  /** Active time charged to the run, in ms (suspension discounted); 0 for a run too short to tick. */
  activeMs: number
  /** `--json` usage summed over every completed turn (spec 6); absent when no turn completed. */
  codexUsage?: CodexUsageDetail
}
```

In the same file, replace:

```ts
    '--skip-git-repo-check',
    '--output-schema', options.schemaPath,
```

with:

```ts
    '--skip-git-repo-check',
    // JSONL events on stdout: turn.completed.usage is what the spend ledger prices (spec 6).
    '--json',
    '--output-schema', options.schemaPath,
```

In the same file, replace:

```ts
  fs.mkdirSync(options.worktreeRoot, { recursive: true })

  try {
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

    if (exit.timedOut) {
      // Carry the snapshot, not just a message: the run spent this much active time before it
      // was killed, and the caller accounts for it in the usage it reports.
      throw new CodexTimeoutError(describeTimeout(options.timeoutMs, exit.timedOut), exit.timedOut)
    }
    if (exit.stalled) {
      throw new CodexStalledError(
        describeStall(options.stallTimeoutMs ?? 0, exit.stalled),
        options.stallTimeoutMs ?? 0,
        exit.stalled
      )
    }

    // Measure usage before anything that can throw on the final message: a run that printed a
    // token total and spent active time still cost that much even if its output is unusable, so
    // the bad-output failures below carry the usage rather than dropping it.
    const tokensUsed = parseTokensUsed(transcript)
    const activeMs = exit.activeMs
```

with:

```ts
  fs.mkdirSync(options.worktreeRoot, { recursive: true })
  // Raw stdout, before redaction and the bounded transcript tail: every turn.completed counts however
  // long the run's output (Review Focus 3). Only the numbers are kept.
  const usageReader = createCodexUsageReader()

  try {
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
        // Events become human status lines; raw JSON never reaches the status reply (ruling 10).
        onProgress: options.onProgress ? codexProgressFilter(options.onProgress) : undefined,
        onStdout: text => usageReader.push(text),
      },
      spawner,
      clock
    )
    const transcript = exit.transcript
    // Measured before anything can throw: a killed or failed run still cost the turns it completed,
    // and every error below carries them. A turn cut off mid-way is the one known undercount.
    usageReader.flush()
    const codexUsage = usageReader.usage()
    const tokensUsed = codexUsage ? codexTotalTokens(codexUsage) : undefined

    if (exit.timedOut) {
      // Carry the snapshot, not just a message: the run spent this much active time before it
      // was killed, and the caller accounts for it in the usage it reports.
      throw new CodexTimeoutError(describeTimeout(options.timeoutMs, exit.timedOut), exit.timedOut, codexUsage)
    }
    if (exit.stalled) {
      throw new CodexStalledError(
        describeStall(options.stallTimeoutMs ?? 0, exit.stalled),
        options.stallTimeoutMs ?? 0,
        exit.stalled,
        codexUsage
      )
    }

    const activeMs = exit.activeMs
```

In the same file, replace:

```ts
        `Codex exited with code ${exit.code} and produced no final message` + (tail ? `:\n${tail}` : ''),
        tokensUsed,
        activeMs
      )
```

with:

```ts
        `Codex exited with code ${exit.code} and produced no final message` + (tail ? `:\n${tail}` : ''),
        tokensUsed,
        activeMs,
        codexUsage
      )
```

In the same file, replace:

```ts
        redactSecrets(error instanceof Error ? error.message : String(error)),
        tokensUsed,
        activeMs
      )
    }

    return { result, rawFinalMessage, tokensUsed, activeMs }
```

with:

```ts
        redactSecrets(error instanceof Error ? error.message : String(error)),
        tokensUsed,
        activeMs,
        codexUsage
      )
    }

    return { result, rawFinalMessage, tokensUsed, activeMs, ...(codexUsage ? { codexUsage } : {}) }
```

In the same file, replace:

```ts
export class CodexStalledError extends Error {
  constructor(
    message: string,
    readonly stallMs: number,
    readonly snapshot: DeadlineSnapshot
  ) {
```

with:

```ts
export class CodexStalledError extends Error {
  constructor(
    message: string,
    readonly stallMs: number,
    readonly snapshot: DeadlineSnapshot,
    /** Usage of the turns that completed before the kill (spec 6); undefined when none did. */
    readonly codexUsage?: CodexUsageDetail
  ) {
```

In the same file, replace:

```ts
export class CodexTimeoutError extends Error {
  constructor(
    message: string,
    readonly snapshot: DeadlineSnapshot
  ) {
```

with:

```ts
export class CodexTimeoutError extends Error {
  constructor(
    message: string,
    readonly snapshot: DeadlineSnapshot,
    /** Usage of the turns that completed before the kill (spec 6); undefined when none did. */
    readonly codexUsage?: CodexUsageDetail
  ) {
```

In the same file, replace:

```ts
    readonly tokensUsed: number | undefined,
    readonly activeMs: number
  ) {
    super(message)
    this.name = 'CodexOutputError'
```

with:

```ts
    readonly tokensUsed: number | undefined,
    readonly activeMs: number,
    /** Usage of the turns the run completed (spec 6); undefined when none did. */
    readonly codexUsage?: CodexUsageDetail
  ) {
    super(message)
    this.name = 'CodexOutputError'
```

`parseTokensUsed` stays exported from `src/usage.ts` (its tests still use it); `src/codex.ts` no longer calls it.

- [ ] **Step 10: Run the tests to verify they pass**

Run: `npx ts-node --compiler-options '{"module":"commonjs"}' --transpile-only src/codex.test.ts`
Expected: PASS.

Run: `npm test 2>&1 | tail -4`
Expected: the summary ends with `# ok`.

Run: `npm run typecheck`
Expected: exits 0 with no output from `tsc`.

- [ ] **Step 11: Commit**

Write `/tmp/srb-commit-msg.txt` with the editor tool:

```text
feat(codex): read usage from codex exec --json events (refs andrew-barnett/slack-review-bot#76)

The spend cap prices tokens, and the transcript footer gives only one
total and nothing for a killed run. Codex now runs with --json; the
turn.completed usage is summed over raw stdout into a CodexUsageDetail
that every Codex error carries too, and events become human progress
lines. The smoke stub emits the same events.

[cc](https://claude.com/claude-code)
```

Run: `git add src/codex-events.ts src/codex-events.test.ts src/usage.ts src/codex.ts src/codex.test.ts scripts/smoke/stub-codex.js && git commit -F /tmp/srb-commit-msg.txt`

---

### Task 2: Carry Codex usage through the engines, the launchd runner and the worker wire

**Files:**
- Modify: `src/usage.ts`, `src/engine.ts`, `src/review.ts`, `src/worker.ts`, `src/jobs/remote.ts`, `src/jobs/errors.ts`
- Test: `src/engine.test.ts`, `src/review.test.ts`, `src/worker.test.ts`, `src/jobs/remote.test.ts`, `src/jobs/errors.test.ts` (all appended)

**Interfaces:**
- Consumes: Task 1 `CodexUsageDetail`, `codexTotalTokens`, `addCodexUsage`, `CodexRunOutcome.codexUsage`, and `codexUsage` on `CodexStalledError` / `CodexTimeoutError` / `CodexOutputError`.
- Produces:
  - `RunUsage.codex?: CodexUsageDetail` (src/usage.ts), summed across attempts.
  - `AttemptSuccess.codex?: CodexUsageDetail`; `AttemptFailure(message, stalled, activeMs, tokensUsed?, claude?, codex?)` with `readonly codex?: CodexUsageDetail` (src/engine.ts).
  - `makeReviewRunner`'s `ReviewOutcome.usage.codex` and `ReviewFailedError.usage.codex` (src/review.ts).
  - Worker codex outcome body: `{ result, tokensUsed, activeMs, codexUsage? }` (src/worker.ts).
  - `SerializedRunError` Codex classes gain `codexUsage?: CodexUsageDetail`; `codexUsageOf(value: unknown): CodexUsageDetail | undefined` (src/jobs/errors.ts).
  - `normalizeCodexOutcome` returns `codexUsage` when the worker sent one (src/jobs/remote.ts).

- [ ] **Step 1: Write the failing tests**

Append to `src/jobs/errors.test.ts`:

```ts
const codexUsage = { inputTokens: 10, cachedInputTokens: 4, cacheWriteTokens: 1, outputTokens: 3, reasoningTokens: 2 }

// Spec 6: every Codex failure carries the turns it completed, across the worker wire too. Regression
// caught: a stall or timeout in a worker arriving at the orchestrator with no usage, so the ledger
// records a costly run as free.
test('Codex errors carry their Codex usage across the wire', t => {
  t.deepEqual((wire(new CodexStalledError('s', 1, snapshot, codexUsage)) as CodexStalledError).codexUsage, codexUsage)
  t.deepEqual((wire(new CodexTimeoutError('t', snapshot, codexUsage)) as CodexTimeoutError).codexUsage, codexUsage)
  t.deepEqual((wire(new CodexOutputError('o', 20, 5, codexUsage)) as CodexOutputError).codexUsage, codexUsage)
  t.equal((wire(new CodexStalledError('s', 1, snapshot)) as CodexStalledError).codexUsage, undefined, 'no usage stays unknown, not zero')
  t.end()
})

// A compromised worker controls these numbers: negative or non-numeric fields become 0, never NaN or a
// negative that would lower recorded spend.
test('deserializeRunError clamps hostile Codex usage', t => {
  const back = deserializeRunError({
    class: 'CodexOutputError',
    message: 'm',
    activeMs: 1,
    codexUsage: { inputTokens: -1, cachedInputTokens: 'x', outputTokens: 5 },
  }) as CodexOutputError
  t.deepEqual(back.codexUsage, { inputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 5, reasoningTokens: 0 })
  t.end()
})
```

Append to `src/jobs/remote.test.ts`:

```ts
// Spec 6 wire: the worker's codexUsage reaches the engine, clamped like Claude's usage. Regression
// caught: the orchestrator dropping codexUsage, so the ledger could only ever record noUsage for Codex.
test('remote runCodex returns the worker\'s Codex usage, clamped', async t => {
  const broker = fakeBroker([
    { result: clean, tokensUsed: 10, activeMs: 20, codexUsage: { inputTokens: 7, cachedInputTokens: -3, cacheWriteTokens: 0, outputTokens: 3, reasoningTokens: 'x' } },
  ])
  const out = await makeRemoteRunners(broker).runCodex(codexOptions)
  t.deepEqual(out.codexUsage, { inputTokens: 7, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 3, reasoningTokens: 0 })
  const none = await makeRemoteRunners(fakeBroker([{ result: clean, activeMs: 1 }])).runCodex(codexOptions)
  t.equal(none.codexUsage, undefined, 'a worker that sent none reports none, not zeros')
  t.end()
})

// An unusable result is an output error that still carries what the run claimed to cost.
test('remote runCodex keeps Codex usage on an unusable result', async t => {
  const usage = { inputTokens: 5, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 1, reasoningTokens: 0 }
  const broker = fakeBroker([{ result: 'not a result', activeMs: 1, codexUsage: usage }])
  try {
    await makeRemoteRunners(broker).runCodex(codexOptions)
    t.fail('an unusable result must throw')
  } catch (error) {
    t.ok(error instanceof CodexOutputError)
    if (error instanceof CodexOutputError) t.deepEqual(error.codexUsage, usage)
  }
  t.end()
})
```

Append to `src/worker.test.ts`:

```ts
// Spec 6 wire: the worker sends codexUsage beside tokensUsed. Regression caught: the usage summed from
// --json staying inside the worker container, invisible to the orchestrator's ledger.
test('worker sends the Codex usage with the codex outcome', async t => {
  const h = harness()
  const codexUsage = { inputTokens: 9, cachedInputTokens: 2, cacheWriteTokens: 0, outputTokens: 4, reasoningTokens: 1 }
  h.deps.runCodex = async () => ({ result: clean, rawFinalMessage: 'raw', tokensUsed: 16, activeMs: 4, codexUsage })
  t.equal(await runWorker(h.deps), 'done')
  t.deepEqual(h.calls.results, [{ ok: true, outcome: { result: clean, tokensUsed: 16, activeMs: 4, codexUsage } }])
  t.end()
})
```

Append to `src/engine.test.ts`:

```ts
// Spec 6: a stalled attempt's completed turns are charged along with the retry's. Regression caught:
// the stall error's codexUsage dropped in AttemptFailure, so the ledger missed the first attempt.
test('the Codex engine sums Codex usage across a stalled attempt and the retry', async t => {
  const first = { inputTokens: 100, cachedInputTokens: 10, cacheWriteTokens: 0, outputTokens: 20, reasoningTokens: 5 }
  const second = { inputTokens: 50, cachedInputTokens: 0, cacheWriteTokens: 2, outputTokens: 10, reasoningTokens: 1 }
  let calls = 0
  const runCodex = (async () => {
    calls += 1
    if (calls === 1) throw new CodexStalledError('stalled', 60_000, snapshot(100), first)
    return { result: { results: [clean(URL1), clean(URL2)] }, rawFinalMessage: '', tokensUsed: 63, activeMs: 1000, codexUsage: second }
  }) as unknown as typeof runCodexReportOnly
  const out = await makeCodexEngine(config, { runCodex }).run(input)
  t.equal(out.error, undefined)
  t.deepEqual(out.usage.codex, { inputTokens: 150, cachedInputTokens: 10, cacheWriteTokens: 2, outputTokens: 30, reasoningTokens: 6 })
  t.equal(out.usage.tokensUsed, 135 + 63, 'the stalled attempt\'s tokens are charged as well as the retry\'s')
  t.end()
})

// Spec 6: a timeout is terminal, but its completed turns still cost money.
test('the Codex engine keeps Codex usage from a timeout', async t => {
  const usage = { inputTokens: 40, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 4, reasoningTokens: 0 }
  const runCodex = (async () => {
    throw new CodexTimeoutError('timed out', snapshot(500), usage)
  }) as unknown as typeof runCodexReportOnly
  const out = await makeCodexEngine(config, { runCodex }).run(input)
  t.ok(out.error, 'the timeout is reported as the engine error')
  t.deepEqual(out.usage.codex, usage)
  t.equal(out.usage.tokensUsed, 44)
  t.end()
})
```

Append to `src/review.test.ts`:

```ts
// Ruling 2: the launchd runner (single mode, no engines list) must carry Codex usage, summed over a
// stalled attempt and the success, or a bedrock launchd install's ledger records only noUsage.
test('makeReviewRunner carries Codex usage summed across a stall and the success', async t => {
  const first = { inputTokens: 100, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 10, reasoningTokens: 0 }
  const second = { inputTokens: 30, cachedInputTokens: 5, cacheWriteTokens: 0, outputTokens: 3, reasoningTokens: 1 }
  let calls = 0
  const fakeRun: typeof runCodexReview = async opts => {
    calls += 1
    if (calls === 1) throw new CodexStalledError('stalled', opts.stallTimeoutMs ?? 0, { activeMs: 5000, wallMs: 5000, frozenMs: 0 }, first)
    return { ...passed(), codexUsage: second }
  }
  const outcome = await makeReviewRunner(config([1000, 2000]), undefined, fakeRun)(request)
  t.deepEqual(outcome.usage.codex, { inputTokens: 130, cachedInputTokens: 5, cacheWriteTokens: 0, outputTokens: 13, reasoningTokens: 1 })
  t.end()
})

// The give-up path must carry every attempt's Codex usage too: a review that stalled twice still spent.
test('makeReviewRunner keeps Codex usage on a give-up', async t => {
  const each = { inputTokens: 20, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 2, reasoningTokens: 0 }
  const fakeRun: typeof runCodexReview = async opts => {
    throw new CodexStalledError('stalled', opts.stallTimeoutMs ?? 0, { activeMs: 5000, wallMs: 5000, frozenMs: 0 }, each)
  }
  try {
    await makeReviewRunner(config([1000, 2000]), undefined, fakeRun)(request)
    t.fail('a run that stalls on every attempt must reject')
  } catch (error) {
    t.ok(error instanceof ReviewFailedError)
    if (error instanceof ReviewFailedError) {
      t.deepEqual(error.usage.codex, { inputTokens: 40, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 4, reasoningTokens: 0 })
    }
  }
  t.end()
})
```

The appended tests use only names each file already imports or defines: `wire`, `snapshot` and the three Codex error classes in `src/jobs/errors.test.ts`; `fakeBroker`, `codexOptions`, `clean` and `CodexOutputError` in `src/jobs/remote.test.ts`; `harness`, `clean` and `runWorker` in `src/worker.test.ts`; `config`, `input`, `clean`, `snapshot`, `URL1`, `URL2`, `CodexStalledError` and `CodexTimeoutError` in `src/engine.test.ts`; `request`, `passed`, `config`, `CodexStalledError` and `ReviewFailedError` in `src/review.test.ts`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `for f in src/jobs/errors.test.ts src/jobs/remote.test.ts src/worker.test.ts src/engine.test.ts src/review.test.ts; do npx ts-node --compiler-options '{"module":"commonjs"}' --transpile-only "$f" 2>&1 | tail -3; done`
Expected: each file ends with `# fail` and a count of at least 1; the failures are the new tests (`codexUsage` / `usage.codex` is `undefined`).

- [ ] **Step 3: Add `codex` to `RunUsage`**

In `src/usage.ts`, replace:

```ts
  /** Claude's own figures, when this usage is a Claude engine's. */
  claude?: ClaudeUsageDetail
```

with:

```ts
  /** Claude's own figures, when this usage is a Claude engine's. */
  claude?: ClaudeUsageDetail
  /** Codex's --json figures summed over every attempt, when this usage is a Codex run's (spec 6). */
  codex?: CodexUsageDetail
```

- [ ] **Step 4: Carry Codex usage through the engines**

In `src/engine.ts`, replace:

```ts
import type { ClaudeUsageDetail, RunUsage } from './usage'
```

with:

```ts
import { addCodexUsage, codexTotalTokens, type ClaudeUsageDetail, type CodexUsageDetail, type RunUsage } from './usage'
```

In the same file, replace:

```ts
export interface AttemptSuccess {
  result: EngineRunResult
  activeMs: number
  tokensUsed?: number
  claude?: ClaudeUsageDetail
}
```

with:

```ts
export interface AttemptSuccess {
  result: EngineRunResult
  activeMs: number
  tokensUsed?: number
  claude?: ClaudeUsageDetail
  codex?: CodexUsageDetail
}
```

In the same file, replace:

```ts
    readonly tokensUsed?: number,
    /** Claude's usage breakdown as far as the failed attempt got. */
    readonly claude?: ClaudeUsageDetail
  ) {
```

with:

```ts
    readonly tokensUsed?: number,
    /** Claude's usage breakdown as far as the failed attempt got. */
    readonly claude?: ClaudeUsageDetail,
    /** Codex's usage breakdown as far as the failed attempt got (spec 6). */
    readonly codex?: CodexUsageDetail
  ) {
```

In the same file, replace:

```ts
  let claude: ClaudeUsageDetail | undefined
  for (let attempt = 0; attempt < attempts; attempt += 1) {
```

with:

```ts
  let claude: ClaudeUsageDetail | undefined
  let codex: CodexUsageDetail | undefined
  for (let attempt = 0; attempt < attempts; attempt += 1) {
```

In the same file, replace:

```ts
      charged += ok.activeMs
      tokens = addTokens(tokens, ok.tokensUsed)
      claude = addClaudeUsage(claude, ok.claude)
      return {
        engine,
        results: reconcileResultsV2(urls, ok.result).results,
        usage: { tokensUsed: tokens, activeMs: charged, attempts: attempt + 1, ...(claude ? { claude } : {}) },
      }
```

with:

```ts
      charged += ok.activeMs
      tokens = addTokens(tokens, ok.tokensUsed)
      claude = addClaudeUsage(claude, ok.claude)
      codex = addCodexUsage(codex, ok.codex)
      return {
        engine,
        results: reconcileResultsV2(urls, ok.result).results,
        usage: { tokensUsed: tokens, activeMs: charged, attempts: attempt + 1, ...(claude ? { claude } : {}), ...(codex ? { codex } : {}) },
      }
```

In the same file, replace:

```ts
      charged += failure.activeMs
      tokens = addTokens(tokens, failure.tokensUsed)
      claude = addClaudeUsage(claude, failure.claude)
```

with:

```ts
      charged += failure.activeMs
      tokens = addTokens(tokens, failure.tokensUsed)
      claude = addClaudeUsage(claude, failure.claude)
      codex = addCodexUsage(codex, failure.codex)
```

In the same file, replace:

```ts
        usage: { tokensUsed: tokens, activeMs: charged > 0 ? charged : undefined, attempts: attempt + 1, ...(claude ? { claude } : {}) },
```

with:

```ts
        usage: {
          tokensUsed: tokens,
          activeMs: charged > 0 ? charged : undefined,
          attempts: attempt + 1,
          ...(claude ? { claude } : {}),
          ...(codex ? { codex } : {}),
        },
```

In the same file, replace:

```ts
            return { result: o.result, activeMs: o.activeMs, tokensUsed: o.tokensUsed }
          } catch (error) {
            if (error instanceof CodexStalledError) throw new AttemptFailure(error.message, true, error.snapshot.activeMs)
            if (error instanceof CodexTimeoutError) throw new AttemptFailure(error.message, false, error.snapshot.activeMs)
            if (error instanceof CodexOutputError) throw new AttemptFailure(error.message, false, error.activeMs, error.tokensUsed)
            throw error
```

with:

```ts
            return { result: o.result, activeMs: o.activeMs, tokensUsed: o.tokensUsed, ...(o.codexUsage ? { codex: o.codexUsage } : {}) }
          } catch (error) {
            // Every Codex failure carries the turns it completed, so a killed attempt is still charged.
            const spent = (u: CodexUsageDetail | undefined) => (u ? codexTotalTokens(u) : undefined)
            if (error instanceof CodexStalledError) {
              throw new AttemptFailure(error.message, true, error.snapshot.activeMs, spent(error.codexUsage), undefined, error.codexUsage)
            }
            if (error instanceof CodexTimeoutError) {
              throw new AttemptFailure(error.message, false, error.snapshot.activeMs, spent(error.codexUsage), undefined, error.codexUsage)
            }
            if (error instanceof CodexOutputError) {
              throw new AttemptFailure(error.message, false, error.activeMs, error.tokensUsed, undefined, error.codexUsage)
            }
            throw error
```

- [ ] **Step 5: Carry Codex usage through the launchd single-mode runner**

In `src/review.ts`, replace:

```ts
import { ReviewFailedError, type ReviewOutcome } from './usage'
```

with:

```ts
import { addCodexUsage, ReviewFailedError, type CodexUsageDetail, type ReviewOutcome } from './usage'
```

In the same file, replace:

```ts
    let chargedActiveMs = 0

    for (let attempt = 0; attempt < attempts; attempt += 1) {
```

with:

```ts
    let chargedActiveMs = 0
    // Codex usage summed over every attempt, like active time: the spend ledger prices it (ruling 2).
    let codex: CodexUsageDetail | undefined
    const withCodex = () => (codex ? { codex } : {})

    for (let attempt = 0; attempt < attempts; attempt += 1) {
```

In the same file, replace:

```ts
        throw new ReviewFailedError(
          { activeMs: chargedActiveMs > 0 ? chargedActiveMs : undefined, attempts: attempt + 1 },
          new Error(redactSecrets(error instanceof Error ? error.message : String(error)))
        )
```

with:

```ts
        throw new ReviewFailedError(
          { activeMs: chargedActiveMs > 0 ? chargedActiveMs : undefined, attempts: attempt + 1, ...withCodex() },
          new Error(redactSecrets(error instanceof Error ? error.message : String(error)))
        )
```

In the same file, replace:

```ts
        chargedActiveMs += outcome.activeMs
        return {
          result: reconcileResults(urls, outcome.result),
          usage: {
            tokensUsed: outcome.tokensUsed,
            activeMs: chargedActiveMs,
            attempts: attempt + 1,
          },
        }
```

with:

```ts
        chargedActiveMs += outcome.activeMs
        codex = addCodexUsage(codex, outcome.codexUsage)
        return {
          result: reconcileResults(urls, outcome.result),
          usage: {
            tokensUsed: outcome.tokensUsed,
            activeMs: chargedActiveMs,
            attempts: attempt + 1,
            ...withCodex(),
          },
        }
```

In the same file, replace:

```ts
          // then retried still cost the time it ran before the kill.
          chargedActiveMs += error.snapshot.activeMs
```

with:

```ts
          // then retried still cost the time it ran before the kill.
          chargedActiveMs += error.snapshot.activeMs
          codex = addCodexUsage(codex, error.codexUsage)
```

In the same file, replace:

```ts
          throw new ReviewFailedError(
            { activeMs: chargedActiveMs, attempts },
```

with:

```ts
          throw new ReviewFailedError(
            { activeMs: chargedActiveMs, attempts, ...withCodex() },
```

In the same file, replace:

```ts
        if (error instanceof CodexTimeoutError) {
          chargedActiveMs += error.snapshot.activeMs
          throw new ReviewFailedError({ activeMs: chargedActiveMs, attempts: attempt + 1 }, error)
        }
```

with:

```ts
        if (error instanceof CodexTimeoutError) {
          chargedActiveMs += error.snapshot.activeMs
          codex = addCodexUsage(codex, error.codexUsage)
          throw new ReviewFailedError({ activeMs: chargedActiveMs, attempts: attempt + 1, ...withCodex() }, error)
        }
```

In the same file, replace:

```ts
          chargedActiveMs += error.activeMs
          throw new ReviewFailedError(
            { tokensUsed: error.tokensUsed, activeMs: chargedActiveMs, attempts: attempt + 1 },
            error
          )
```

with:

```ts
          chargedActiveMs += error.activeMs
          codex = addCodexUsage(codex, error.codexUsage)
          throw new ReviewFailedError(
            { tokensUsed: error.tokensUsed, activeMs: chargedActiveMs, attempts: attempt + 1, ...withCodex() },
            error
          )
```

In the same file, replace:

```ts
        throw new ReviewFailedError(
          { activeMs: chargedActiveMs > 0 ? chargedActiveMs : undefined, attempts: attempt + 1 },
          error
        )
```

with:

```ts
        throw new ReviewFailedError(
          { activeMs: chargedActiveMs > 0 ? chargedActiveMs : undefined, attempts: attempt + 1, ...withCodex() },
          error
        )
```

- [ ] **Step 6: Put `codexUsage` on the worker wire**

In `src/worker.ts`, replace:

```ts
      body = { ok: true, outcome: { result: o.result, tokensUsed: o.tokensUsed, activeMs: o.activeMs } }
```

with:

```ts
      body = {
        ok: true,
        outcome: { result: o.result, tokensUsed: o.tokensUsed, activeMs: o.activeMs, ...(o.codexUsage ? { codexUsage: o.codexUsage } : {}) },
      }
```

In `src/jobs/errors.ts`, replace:

```ts
import type { ClaudeUsageDetail } from '../usage'

export type SerializedRunError =
  | { class: 'CodexStalledError'; message: string; stallMs: number; snapshot: DeadlineSnapshot }
  | { class: 'CodexTimeoutError'; message: string; snapshot: DeadlineSnapshot }
  | { class: 'CodexOutputError'; message: string; tokensUsed?: number; activeMs: number }
```

with:

```ts
import type { ClaudeUsageDetail, CodexUsageDetail } from '../usage'

export type SerializedRunError =
  | { class: 'CodexStalledError'; message: string; stallMs: number; snapshot: DeadlineSnapshot; codexUsage?: CodexUsageDetail }
  | { class: 'CodexTimeoutError'; message: string; snapshot: DeadlineSnapshot; codexUsage?: CodexUsageDetail }
  | { class: 'CodexOutputError'; message: string; tokensUsed?: number; activeMs: number; codexUsage?: CodexUsageDetail }
```

In the same file, replace:

```ts
    durationMs: nonNegative(u.durationMs),
  }
}
```

with:

```ts
    durationMs: nonNegative(u.durationMs),
  }
}

/** Codex's usage breakdown with every field forced to a finite, non-negative number (spec 6 wire). */
export function codexUsageOf(value: unknown): CodexUsageDetail | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const u = value as Record<string, unknown>
  return {
    inputTokens: nonNegative(u.inputTokens),
    cachedInputTokens: nonNegative(u.cachedInputTokens),
    cacheWriteTokens: nonNegative(u.cacheWriteTokens),
    outputTokens: nonNegative(u.outputTokens),
    reasoningTokens: nonNegative(u.reasoningTokens),
  }
}
```

In the same file, replace:

```ts
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
```

with:

```ts
  // Each Codex failure keeps the turns it completed (spec 6); absent stays absent.
  const codex = (u: CodexUsageDetail | undefined) => (u ? { codexUsage: { ...u } } : {})
  if (error instanceof CodexStalledError) {
    return {
      class: 'CodexStalledError',
      message: text(error.message),
      stallMs: error.stallMs,
      snapshot: { ...error.snapshot },
      ...codex(error.codexUsage),
    }
  }
  if (error instanceof CodexTimeoutError) {
    return { class: 'CodexTimeoutError', message: text(error.message), snapshot: { ...error.snapshot }, ...codex(error.codexUsage) }
  }
  if (error instanceof CodexOutputError) {
    return {
      class: 'CodexOutputError',
      message: text(error.message),
      activeMs: error.activeMs,
      ...(error.tokensUsed !== undefined ? { tokensUsed: error.tokensUsed } : {}),
      ...codex(error.codexUsage),
    }
  }
```

In the same file, replace:

```ts
    case 'CodexStalledError':
      return new CodexStalledError(message, nonNegative(e.stallMs), snapshotOf(e.snapshot))
    case 'CodexTimeoutError':
      return new CodexTimeoutError(message, snapshotOf(e.snapshot))
    case 'CodexOutputError':
      return new CodexOutputError(message, optionalNonNegative(e.tokensUsed), nonNegative(e.activeMs))
```

with:

```ts
    case 'CodexStalledError':
      return new CodexStalledError(message, nonNegative(e.stallMs), snapshotOf(e.snapshot), codexUsageOf(e.codexUsage))
    case 'CodexTimeoutError':
      return new CodexTimeoutError(message, snapshotOf(e.snapshot), codexUsageOf(e.codexUsage))
    case 'CodexOutputError':
      return new CodexOutputError(message, optionalNonNegative(e.tokensUsed), nonNegative(e.activeMs), codexUsageOf(e.codexUsage))
```

In `src/jobs/remote.ts`, replace:

```ts
import { nonNegative, optionalNonNegative, record, usageOf } from './errors'
```

with:

```ts
import { codexUsageOf, nonNegative, optionalNonNegative, record, usageOf } from './errors'
```

In the same file, replace:

```ts
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
```

with:

```ts
export function normalizeCodexOutcome(raw: unknown): CodexRunOutcome<EngineRunResult> {
  const o = record(raw)
  const activeMs = nonNegative(o.activeMs)
  const tokensUsed = optionalNonNegative(o.tokensUsed)
  // Validated like Claude's usage: non-negative numbers, defaulting to zero (spec 6 wire).
  const codexUsage = codexUsageOf(o.codexUsage)
  let result: EngineRunResult
  try {
    result = parseReviewResultV2(JSON.stringify(o.result ?? null))
  } catch (error) {
    throw new CodexOutputError(`the worker returned an unusable result: ${message(error)}`, tokensUsed, activeMs, codexUsage)
  }
  return { result, rawFinalMessage: '', tokensUsed, activeMs, ...(codexUsage ? { codexUsage } : {}) }
}
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `for f in src/jobs/errors.test.ts src/jobs/remote.test.ts src/worker.test.ts src/engine.test.ts src/review.test.ts; do npx ts-node --compiler-options '{"module":"commonjs"}' --transpile-only "$f" 2>&1 | tail -2; done`
Expected: each file ends with `# ok`.

Run: `npm test 2>&1 | tail -4 && npm run typecheck`
Expected: `# ok`, then `tsc` exits 0.

- [ ] **Step 8: Commit**

Write `/tmp/srb-commit-msg.txt` with the editor tool:

```text
feat(usage): carry Codex usage through engines and the worker wire (refs andrew-barnett/slack-review-bot#76)

The ledger prices each engine run from its token breakdown, so the Codex
breakdown must survive stall retries, the launchd single-mode runner and
the job protocol, where the orchestrator validates it like Claude's.

[cc](https://claude.com/claude-code)
```

Run: `git add src/usage.ts src/engine.ts src/review.ts src/worker.ts src/jobs/remote.ts src/jobs/errors.ts src/engine.test.ts src/review.test.ts src/worker.test.ts src/jobs/remote.test.ts src/jobs/errors.test.ts && git commit -F /tmp/srb-commit-msg.txt`

---

### Task 3: The price table loader (`src/pricing.ts`)

**Files:**
- Create: `src/pricing.ts`
- Test: `src/pricing.test.ts`

**Interfaces:**
- Consumes: Task 1 `CodexUsageDetail`; `ClaudeUsageDetail` (src/usage.ts).
- Produces:
  - src/pricing.ts:
    - `interface ModelPrice { input: number; cachedInput: number; cacheWrite: number; output: number }` (USD per million tokens)
    - `interface CodexTokenSemantics { cachedIsSubsetOfInput: boolean; reasoningInOutput: boolean }`
    - `interface PriceTable { source: string; codexTokenSemantics: CodexTokenSemantics; models: Record<string, ModelPrice> }`
    - `interface LedgerTokens { input: number; cachedInput: number; cacheWrite: number; output: number; reasoning: number }`
    - `interface PricedRun { tokens: LedgerTokens; costUsd: number }`
    - `defaultPricesFile(): string` (`<repo>/pricing/bedrock-prices.json`; `/app/pricing/bedrock-prices.json` in the image)
    - `parsePriceTable(text: string, file: string, requiredModels: readonly string[]): PriceTable` (throws, naming the file and, for a missing model, the model)
    - `loadPriceTable(file: string, requiredModels: readonly string[]): PriceTable`
    - `priceCodex(usage: CodexUsageDetail, price: ModelPrice, semantics: CodexTokenSemantics): PricedRun`
    - `priceClaude(usage: ClaudeUsageDetail, price: ModelPrice): PricedRun`

- [ ] **Step 1: Write the failing tests**

Create `src/pricing.test.ts`:

```ts
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import test from 'tape'
import { loadPriceTable, parsePriceTable, priceClaude, priceCodex, type ModelPrice } from './pricing'

const CODEX = 'us.openai.gpt-5.5'
const CLAUDE = 'us.anthropic.claude-opus-5-5'
// SYNTHETIC prices chosen for easy arithmetic. They are not AWS prices and must never be copied into
// pricing/bedrock-prices.json.
const codexPrice: ModelPrice = { input: 1, cachedInput: 0.25, cacheWrite: 0, output: 8 }
const claudePrice: ModelPrice = { input: 3, cachedInput: 0.5, cacheWrite: 4, output: 20 }
const SOURCE = 'https://aws.amazon.com/bedrock/pricing/ (on-demand, us-east-2), checked 2026-11-19'

/** A complete fixture table; a test overrides one field at a time. */
function table(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    source: SOURCE,
    codexTokenSemantics: { cachedIsSubsetOfInput: false, reasoningInOutput: false },
    models: { [CODEX]: codexPrice, [CLAUDE]: claudePrice },
    ...over,
  })
}

// A well-formed table loads, with both configured models priced.
test('parsePriceTable accepts a complete table', t => {
  const parsed = parsePriceTable(table(), 'prices.json', [CODEX, CLAUDE])
  t.deepEqual(parsed.models[CODEX], codexPrice)
  t.deepEqual(parsed.models[CLAUDE], claudePrice)
  t.equal(parsed.source, SOURCE)
  t.deepEqual(parsed.codexTokenSemantics, { cachedIsSubsetOfInput: false, reasoningInOutput: false })
  t.end()
})

// Spec 4: a configured model with no price stops startup with a message naming the model and the file,
// so spend is never priced at an unknown rate. Regression caught: a model bump without its price.
test('parsePriceTable rejects a missing model, naming the model and the file', t => {
  t.throws(
    () => parsePriceTable(table({ models: { [CODEX]: codexPrice } }), '/app/pricing/bedrock-prices.json', [CODEX, CLAUDE]),
    /\/app\/pricing\/bedrock-prices\.json has no price for model "us\.anthropic\.claude-opus-5-5"/
  )
  // A prototype key must not count as a priced model.
  t.throws(() => parsePriceTable(table(), 'prices.json', ['constructor']), /no price for model "constructor"/)
  t.end()
})

// Spec 5: the placeholder zeros can never ship. Zero input or output is rejected; a zero cache price is a
// real possibility (a model with no cache-write charge) and is allowed.
test('parsePriceTable rejects a zero input or output price and allows a zero cache price', t => {
  for (const bad of [{ ...codexPrice, input: 0 }, { ...codexPrice, output: 0 }]) {
    t.throws(() => parsePriceTable(table({ models: { [CODEX]: bad, [CLAUDE]: claudePrice } }), 'p.json', [CODEX, CLAUDE]), /model "us\.openai\.gpt-5\.5" needs "input" and "output" above zero/)
  }
  const free = parsePriceTable(table({ models: { [CODEX]: { ...codexPrice, cachedInput: 0, cacheWrite: 0 }, [CLAUDE]: claudePrice } }), 'p.json', [CODEX, CLAUDE])
  t.equal(free.models[CODEX].cacheWrite, 0)
  t.end()
})

// Negative, missing or non-numeric prices are as wrong as zero, and must not reach the arithmetic.
test('parsePriceTable rejects negative, missing and non-numeric prices', t => {
  const cases = [{ ...codexPrice, cachedInput: -1 }, { input: 1, output: 8 }, { ...codexPrice, output: '8' }]
  for (const bad of cases) {
    t.throws(() => parsePriceTable(table({ models: { [CODEX]: bad, [CLAUDE]: claudePrice } }), 'p.json', [CODEX, CLAUDE]), /needs "input" and "output"/)
  }
  t.end()
})

// Spec 4 "must parse": bad JSON fails with the file named, not a bare SyntaxError.
test('parsePriceTable rejects bad JSON naming the file', t => {
  t.throws(() => parsePriceTable('{ "models": ', 'p.json', [CODEX]), /BEDROCK_PRICES_FILE p\.json is not valid JSON/)
  t.throws(() => parsePriceTable('[]', 'p.json', [CODEX]), /must hold a JSON object/)
  t.end()
})

// Spec 5: `source` records the URL and the date checked. The spec's own example date "2026-11-XX" is a
// placeholder and must not load.
test('parsePriceTable requires a dated source', t => {
  t.throws(() => parsePriceTable(table({ source: 'https://aws.amazon.com/bedrock/pricing/ checked 2026-11-XX' }), 'p.json', [CODEX]), /"source" must name the pricing page and the date/)
  t.throws(() => parsePriceTable(table({ source: undefined }), 'p.json', [CODEX]), /"source"/)
  t.end()
})

// Ruling 15: the two Codex flags are required booleans, so the reading in use is always a decision.
test('parsePriceTable requires both codexTokenSemantics flags', t => {
  t.throws(() => parsePriceTable(table({ codexTokenSemantics: { cachedIsSubsetOfInput: false } }), 'p.json', [CODEX]), /codexTokenSemantics/)
  t.throws(() => parsePriceTable(table({ codexTokenSemantics: { cachedIsSubsetOfInput: 'no', reasoningInOutput: false } }), 'p.json', [CODEX]), /codexTokenSemantics/)
  t.end()
})

// A missing or unreadable file fails with the path, so the operator knows which setting to fix.
test('loadPriceTable reads a file and names it when it cannot', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prices-'))
  const file = path.join(dir, 'bedrock-prices.json')
  t.throws(() => loadPriceTable(file, [CODEX]), /cannot read BEDROCK_PRICES_FILE \S*prices-\S*bedrock-prices\.json/)
  fs.writeFileSync(file, table())
  t.deepEqual(loadPriceTable(file, [CODEX, CLAUDE]).models[CODEX], codexPrice)
  fs.rmSync(dir, { recursive: true, force: true })
  t.end()
})

// Spec 5 / 9: until the semantics are confirmed, cached tokens are not subtracted from input and reasoning
// tokens are added to output, which overcounts (the safe direction for a cap). The confirmed reading
// does neither, and costs less. Regression caught: the flags read backwards.
test('the conservative Codex reading overcounts and the confirmed reading does not', t => {
  const usage = { inputTokens: 1000, cachedInputTokens: 400, cacheWriteTokens: 0, outputTokens: 200, reasoningTokens: 50 }
  const conservative = priceCodex(usage, codexPrice, { cachedIsSubsetOfInput: false, reasoningInOutput: false })
  const confirmed = priceCodex(usage, codexPrice, { cachedIsSubsetOfInput: true, reasoningInOutput: true })
  // (1000 × 1 + 400 × 0.25 + 250 × 8) / 1e6 = 0.0031; (600 × 1 + 400 × 0.25 + 200 × 8) / 1e6 = 0.0023
  t.ok(Math.abs(conservative.costUsd - 0.0031) < 1e-12, String(conservative.costUsd))
  t.ok(Math.abs(confirmed.costUsd - 0.0023) < 1e-12, String(confirmed.costUsd))
  t.ok(conservative.costUsd > confirmed.costUsd)
  t.deepEqual(conservative.tokens, { input: 1000, cachedInput: 400, cacheWrite: 0, output: 200, reasoning: 50 }, 'the ledger keeps the raw counts')
  t.end()
})

// Claude's cache reads and writes are separate from its input (spec D2), and its notional costUsd is
// never used. Regression caught: pricing Claude from costUsd.
test('priceClaude prices each field and ignores the notional costUsd', t => {
  const usage = { inputTokens: 100, outputTokens: 10, cacheReadTokens: 1000, cacheWriteTokens: 50, costUsd: 999, numTurns: 3, durationMs: 1 }
  const priced = priceClaude(usage, claudePrice)
  // (100 × 3 + 1000 × 0.5 + 50 × 4 + 10 × 20) / 1e6 = 0.0012
  t.ok(Math.abs(priced.costUsd - 0.0012) < 1e-12, String(priced.costUsd))
  t.deepEqual(priced.tokens, { input: 100, cachedInput: 1000, cacheWrite: 50, output: 10, reasoning: 0 })
  t.end()
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx ts-node --compiler-options '{"module":"commonjs"}' --transpile-only src/pricing.test.ts`
Expected: FAIL with `Cannot find module './pricing'`.

- [ ] **Step 3: Write the price table loader and arithmetic**

Create `src/pricing.ts`:

```ts
// The Bedrock price table (spec section 5): USD per million tokens for each configured model ID, kept in
// the repo at pricing/bedrock-prices.json and maintained by the refresh-bot-runtime skill. Spend is
// tokens × these prices. Nothing here is ever shown to a user (spec section 1).

import * as fs from 'fs'
import * as path from 'path'
import type { ClaudeUsageDetail, CodexUsageDetail } from './usage'

/** One model's on-demand prices, in USD per million tokens. */
export interface ModelPrice {
  input: number
  cachedInput: number
  cacheWrite: number
  output: number
}

/**
 * How Codex's usage fields relate (spec section 5, ruling 15). Both false is the conservative reading:
 * cached tokens are not subtracted from input, and reasoning tokens are added to output.
 */
export interface CodexTokenSemantics {
  /** True when `cached_input_tokens` is already counted inside `input_tokens`. */
  cachedIsSubsetOfInput: boolean
  /** True when `reasoning_output_tokens` is already counted inside `output_tokens`. */
  reasoningInOutput: boolean
}

export interface PriceTable {
  /** The pricing page and the date it was checked. */
  source: string
  codexTokenSemantics: CodexTokenSemantics
  /** Keyed by the exact configured model value (a `us.` profile ID today). */
  models: Record<string, ModelPrice>
}

/** The raw token counts a ledger entry keeps, whichever engine ran. */
export interface LedgerTokens {
  input: number
  cachedInput: number
  cacheWrite: number
  output: number
  reasoning: number
}

export interface PricedRun {
  tokens: LedgerTokens
  costUsd: number
}

/**
 * `<repo>/pricing/bedrock-prices.json`. Bundled, this module lives in `dist/`, so one level up is the
 * repo (or `/app` in the image); under ts-node it lives in `src/`, with the same result.
 */
export function defaultPricesFile(): string {
  return path.resolve(__dirname, '..', 'pricing', 'bedrock-prices.json')
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

/** Parse and validate a price table. Every error names the file; a missing model is named too. */
export function parsePriceTable(text: string, file: string, requiredModels: readonly string[]): PriceTable {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (error) {
    throw new Error(`BEDROCK_PRICES_FILE ${file} is not valid JSON: ${String(error)}`)
  }
  if (!isObject(value)) throw new Error(`BEDROCK_PRICES_FILE ${file} must hold a JSON object`)
  const source = value.source
  if (typeof source !== 'string' || !/\d{4}-\d{2}-\d{2}/.test(source)) {
    throw new Error(`BEDROCK_PRICES_FILE ${file}: "source" must name the pricing page and the date it was checked (YYYY-MM-DD)`)
  }
  const semantics = value.codexTokenSemantics
  if (!isObject(semantics) || typeof semantics.cachedIsSubsetOfInput !== 'boolean' || typeof semantics.reasoningInOutput !== 'boolean') {
    throw new Error(`BEDROCK_PRICES_FILE ${file}: "codexTokenSemantics" needs boolean "cachedIsSubsetOfInput" and "reasoningInOutput"`)
  }
  if (!isObject(value.models)) throw new Error(`BEDROCK_PRICES_FILE ${file}: "models" must be an object keyed by model ID`)
  const models: Record<string, ModelPrice> = {}
  for (const [model, entry] of Object.entries(value.models)) {
    const p = isObject(entry) ? entry : {}
    const valid =
      finite(p.input) && p.input > 0 &&
      finite(p.output) && p.output > 0 &&
      finite(p.cachedInput) && p.cachedInput >= 0 &&
      finite(p.cacheWrite) && p.cacheWrite >= 0
    if (!valid) {
      throw new Error(
        `BEDROCK_PRICES_FILE ${file}: model "${model}" needs "input" and "output" above zero and "cachedInput" and "cacheWrite" at zero or above (USD per million tokens)`
      )
    }
    models[model] = { input: p.input as number, cachedInput: p.cachedInput as number, cacheWrite: p.cacheWrite as number, output: p.output as number }
  }
  for (const model of requiredModels) {
    if (!Object.hasOwn(models, model)) {
      throw new Error(`BEDROCK_PRICES_FILE ${file} has no price for model "${model}"; add it from https://aws.amazon.com/bedrock/pricing/`)
    }
  }
  return {
    source,
    codexTokenSemantics: {
      cachedIsSubsetOfInput: semantics.cachedIsSubsetOfInput as boolean,
      reasoningInOutput: semantics.reasoningInOutput as boolean,
    },
    models,
  }
}

/** Read and validate the price table file. */
export function loadPriceTable(file: string, requiredModels: readonly string[]): PriceTable {
  let text: string
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (error) {
    throw new Error(`cannot read BEDROCK_PRICES_FILE ${file}: ${String(error)}`)
  }
  return parsePriceTable(text, file, requiredModels)
}

const dollars = (input: number, cachedInput: number, cacheWrite: number, output: number, p: ModelPrice): number =>
  (input * p.input + cachedInput * p.cachedInput + cacheWrite * p.cacheWrite + output * p.output) / 1_000_000

/** Price one Codex engine run. The ledger keeps the raw counts; the flags decide what is billed. */
export function priceCodex(usage: CodexUsageDetail, price: ModelPrice, semantics: CodexTokenSemantics): PricedRun {
  const billedInput = semantics.cachedIsSubsetOfInput ? Math.max(0, usage.inputTokens - usage.cachedInputTokens) : usage.inputTokens
  const billedOutput = semantics.reasoningInOutput ? usage.outputTokens : usage.outputTokens + usage.reasoningTokens
  return {
    tokens: {
      input: usage.inputTokens,
      cachedInput: usage.cachedInputTokens,
      cacheWrite: usage.cacheWriteTokens,
      output: usage.outputTokens,
      reasoning: usage.reasoningTokens,
    },
    costUsd: dollars(billedInput, usage.cachedInputTokens, usage.cacheWriteTokens, billedOutput, price),
  }
}

/** Price one Claude engine run from its token breakdown; `costUsd` (notional) is never used (spec D2). */
export function priceClaude(usage: ClaudeUsageDetail, price: ModelPrice): PricedRun {
  return {
    tokens: {
      input: usage.inputTokens,
      cachedInput: usage.cacheReadTokens,
      cacheWrite: usage.cacheWriteTokens,
      output: usage.outputTokens,
      reasoning: 0,
    },
    costUsd: dollars(usage.inputTokens, usage.cacheReadTokens, usage.cacheWriteTokens, usage.outputTokens, price),
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx ts-node --compiler-options '{"module":"commonjs"}' --transpile-only src/pricing.test.ts`
Expected: PASS (all ten tests).

Run: `npm test 2>&1 | tail -4 && npm run typecheck`
Expected: `# ok`, then `tsc` exits 0.

- [ ] **Step 5: Commit**

Write `/tmp/srb-commit-msg.txt` with the editor tool:

```text
feat(spend): add the Bedrock price table loader (refs andrew-barnett/slack-review-bot#76)

The price table loader refuses a missing model, a zero input or output
price, bad JSON and an undated source, so spend is never priced at an
unknown rate; the arithmetic applies the conservative Codex reading until
the flags say otherwise.

[cc](https://claude.com/claude-code)
```

Run: `git add src/pricing.ts src/pricing.test.ts && git commit -F /tmp/srb-commit-msg.txt`

---

### Task 4: The month-to-date spend ledger, an append-only monthly journal (`src/spend-ledger.ts`)

**Files:**
- Create: `src/spend-ledger.ts`
- Test: `src/spend-ledger.test.ts`

**Interfaces:**
- Consumes: Task 3 `LedgerTokens`; `EngineName` (src/config.ts).
- Produces:
  - `interface SpendRun { at: string; runId: string; engine: EngineName; model: string; tokens: LedgerTokens; costUsd: number; noUsage?: true }`
  - `interface SpendState { month: string; spentUsd: number; alerted: number[]; capAnnouncedFor?: number; locked: boolean; entries: SpendRun[] }`
  - `interface SpendLedger { state(nowMs: number): Readonly<SpendState>; recordRuns(runs: SpendRun[], nowMs: number): void; recordAlert(percent: number, nowMs: number): void; recordCapAnnounced(capUsd: number, nowMs: number): void }`
  - `utcMonth(ms: number): string` (`YYYY-MM`), `nextMonthStart(ms: number): number` (00:00 UTC on the 1st of the next month)
  - `spendFileFor(dir: string, month: string): string` (`<dir>/spend-YYYY-MM.jsonl`)
  - `openSpendLedger(dir: string, log: (event: string, fields: Record<string, unknown>) => void, nowMs?: number): SpendLedger` (`dir` is Task 5's `spendDir`)
  - Log events: `spend.unreadable`, `spend.write_failed`, `spend.write_recovered`, `spend.month_started`.
- Journal format (one JSON object per line, one file per UTC month, never rewritten, renamed or deleted by the bot):
  - `{"type":"run","at":ISO,"runId":…,"engine":"codex"|"claude","model":…,"tokens":{…},"costUsd":…,"noUsage"?:true}`: one priced engine run.
  - `{"type":"alert","at":ISO,"percent":N}`: the threshold alert for `N` was decided (written before posting).
  - `{"type":"cap","at":ISO,"capUsd":N}`: the cap-reached message was decided for a cap of `N` dollars (written before posting).

- [ ] **Step 1: Write the failing tests**

Create `src/spend-ledger.test.ts`:

```ts
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import test from 'tape'
import { nextMonthStart, openSpendLedger, spendFileFor, utcMonth, type SpendRun } from './spend-ledger'

const NOV_20 = Date.UTC(2026, 10, 20, 14, 3, 11)
/** 02:00 UTC on Dec 1 is 21:00 on Nov 30 in New York: a new month by UTC, still November in ET. */
const DEC_1_0200Z = Date.UTC(2026, 11, 1, 2, 0)
/** Permission tests mean nothing as root, which ignores file modes. */
const ROOT = process.getuid?.() === 0

/** A fresh state directory that does not exist yet, as on a new volume. */
function scratch(): { base: string; dir: string; nov: string; dec: string } {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'spend-ledger-'))
  const dir = path.join(base, 'state')
  return { base, dir, nov: spendFileFor(dir, '2026-11'), dec: spendFileFor(dir, '2026-12') }
}

function logger() {
  const events: Array<{ event: string; fields: Record<string, unknown> }> = []
  return { events, log: (event: string, fields: Record<string, unknown>) => void events.push({ event, fields }) }
}

/** A synthetic engine run costing `costUsd`. */
const run = (costUsd: number, runId = 'C1-11'): SpendRun => ({
  at: new Date(NOV_20).toISOString(),
  runId,
  engine: 'codex',
  model: 'us.openai.gpt-5.5',
  tokens: { input: 1, cachedInput: 0, cacheWrite: 0, output: 1, reasoning: 0 },
  costUsd,
})

/** A well-formed `run` journal line. */
const runLine = (costUsd: number): string => JSON.stringify({ type: 'run', ...run(costUsd) })

// D5: months are UTC calendar months. The reset is 00:00 UTC on the 1st, including across a year end.
test('utcMonth and nextMonthStart follow the UTC calendar', t => {
  t.equal(utcMonth(Date.UTC(2026, 10, 30, 23, 59)), '2026-11')
  t.equal(utcMonth(DEC_1_0200Z), '2026-12')
  t.equal(nextMonthStart(NOV_20), Date.UTC(2026, 11, 1))
  t.equal(nextMonthStart(Date.UTC(2026, 11, 15)), Date.UTC(2027, 0, 1), 'December rolls into January of the next year')
  t.end()
})

// A first start has no journal: the month opens at zero, and what is recorded survives a restart. Each
// record is one JSON line with its type first. Regression caught: a run counted only in memory, so a
// restart reopened a reached cap at zero.
test('a new month starts at zero and its runs round-trip through a restart', t => {
  const { base, dir, nov } = scratch()
  const first = openSpendLedger(dir, logger().log, NOV_20)
  t.equal(first.state(NOV_20).month, '2026-11')
  t.equal(first.state(NOV_20).spentUsd, 0)
  t.equal(first.state(NOV_20).locked, false)
  first.recordRuns([run(2.5, 'C1-1'), run(1, 'C1-2')], NOV_20)
  const lines = fs.readFileSync(nov, 'utf8').split('\n')
  t.equal(lines.length, 3, 'two lines, each ending in a newline')
  t.ok(lines[0].startsWith('{"type":"run","at":'), lines[0])
  const second = openSpendLedger(dir, logger().log, NOV_20)
  t.equal(second.state(NOV_20).spentUsd, 3.5)
  t.deepEqual(second.state(NOV_20).entries.map(e => e.runId), ['C1-1', 'C1-2'])
  t.equal(second.state(NOV_20).locked, false)
  fs.rmSync(base, { recursive: true, force: true })
  t.end()
})

// Spec 7 / D5: a run at 02:00 UTC on Dec 1 (still Nov 30 in New York) is December's. Regression caught:
// switching months on the ET calendar, which would charge five hours of December spend to November's cap,
// or touching November's journal when December starts.
test('a run just after 00:00 UTC lands in the new month and leaves the old journal untouched', t => {
  const { base, dir, nov, dec } = scratch()
  openSpendLedger(dir, logger().log, NOV_20).recordRuns([run(7)], NOV_20)
  const november = fs.readFileSync(nov, 'utf8')
  const ledger = openSpendLedger(dir, logger().log, DEC_1_0200Z)
  ledger.recordRuns([{ ...run(3), at: new Date(DEC_1_0200Z).toISOString() }], DEC_1_0200Z)
  t.equal(ledger.state(DEC_1_0200Z).month, '2026-12')
  t.equal(ledger.state(DEC_1_0200Z).spentUsd, 3, 'November is not counted')
  t.equal(fs.readFileSync(dec, 'utf8').split('\n').length, 2, 'one line in spend-2026-12.jsonl')
  t.equal(fs.readFileSync(nov, 'utf8'), november, 'spend-2026-11.jsonl is byte for byte unchanged')
  fs.rmSync(base, { recursive: true, force: true })
  t.end()
})

// Spec 7 / ruling 8: a line that does not parse makes the month untrustworthy, so it reads as capped, and
// the log names the line. Removing the line and restarting unlocks it with the good lines still counted.
// Regression caught: skipping a bad line, which silently drops a charge and reopens spending.
test('a bad line locks the month until it is removed', t => {
  const { base, dir, nov } = scratch()
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(nov, `${runLine(4)}\n{"type":"run","costUsd":\n${runLine(6)}\n`)
  const { events, log } = logger()
  const ledger = openSpendLedger(dir, log, NOV_20)
  t.equal(ledger.state(NOV_20).locked, true)
  t.equal(ledger.state(NOV_20).spentUsd, 10, 'the good lines still count')
  const unreadable = events.filter(e => e.event === 'spend.unreadable')
  t.equal(unreadable.length, 1)
  t.equal(unreadable[0].fields.line, 2, 'the log names the bad line')
  t.equal(unreadable[0].fields.file, nov)
  fs.writeFileSync(nov, `${runLine(4)}\n${runLine(6)}\n`)
  const repaired = openSpendLedger(dir, logger().log, NOV_20)
  t.equal(repaired.state(NOV_20).locked, false, 'removing the line and restarting unlocks the month')
  t.equal(repaired.state(NOV_20).spentUsd, 10)
  fs.rmSync(base, { recursive: true, force: true })
  t.end()
})

// A crash mid-append leaves a last line with no newline. It is treated as unreadable (the conservative
// choice), and the next append starts on a fresh line, so removing the partial line loses nothing else.
// Regression caught: the next record glued onto the partial line, making both unrecoverable.
test('a partial last line locks the month, and later records start on their own line', t => {
  const { base, dir, nov } = scratch()
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(nov, `${runLine(4)}\n{"type":"ru`)
  const { events, log } = logger()
  const ledger = openSpendLedger(dir, log, NOV_20)
  t.equal(ledger.state(NOV_20).locked, true)
  t.equal(events.find(e => e.event === 'spend.unreadable')?.fields.line, 2)
  ledger.recordRuns([run(5)], NOV_20)
  t.equal(fs.readFileSync(nov, 'utf8'), `${runLine(4)}\n{"type":"ru\n${runLine(5)}\n`, 'the new record is on its own line')
  fs.writeFileSync(nov, `${runLine(4)}\n${runLine(5)}\n`)
  t.equal(openSpendLedger(dir, logger().log, NOV_20).state(NOV_20).spentUsd, 9, 'removing the partial line keeps the later record')
  fs.rmSync(base, { recursive: true, force: true })
  t.end()
})

// A line in a shape this code does not know (another type, a hand edit, a negative cost) is as
// untrustworthy as bad JSON, and gets the same treatment.
test('a line with an unknown type or invalid fields locks the month', t => {
  const at = new Date(NOV_20).toISOString()
  for (const bad of [
    { type: 'refund', at, costUsd: 1 },
    { ...JSON.parse(runLine(1)), costUsd: -1 },
    { ...JSON.parse(runLine(1)), engine: 'gemini' },
    { ...JSON.parse(runLine(1)), tokens: { input: 1 } },
    { type: 'alert', at, percent: 25.5 },
    { type: 'cap', at, capUsd: 0 },
    { type: 'cap', capUsd: 100 },
    [1, 2],
  ]) {
    const { base, dir, nov } = scratch()
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(nov, `${JSON.stringify(bad)}\n`)
    t.equal(openSpendLedger(dir, logger().log, NOV_20).state(NOV_20).locked, true, JSON.stringify(bad))
    fs.rmSync(base, { recursive: true, force: true })
  }
  t.end()
})

// When the state directory cannot be written, opening the ledger already reads as capped: the probe on
// open fails. Every state() retries the probe, so the month reopens on its own once storage recovers.
// Regression caught: a restart onto read-only storage admitting reviews whose spend can never be
// recorded, or a lock that only a restart clears.
test('unwritable storage on open starts locked and unlocks once it is writable again', { skip: ROOT }, t => {
  const { base, dir } = scratch()
  openSpendLedger(dir, logger().log, NOV_20).recordRuns([run(5)], NOV_20)
  fs.chmodSync(dir, 0o500)
  try {
    const { events, log } = logger()
    const ledger = openSpendLedger(dir, log, NOV_20)
    t.equal(ledger.state(NOV_20).spentUsd, 5, 'the journal is still read')
    t.equal(ledger.state(NOV_20).locked, true)
    t.ok(events.some(e => e.event === 'spend.write_failed'))
    fs.chmodSync(dir, 0o700)
    t.equal(ledger.state(NOV_20).locked, false, 'the next state() probes again and unlocks')
    t.ok(events.some(e => e.event === 'spend.write_recovered'))
  } finally {
    fs.chmodSync(dir, 0o700)
  }
  fs.rmSync(base, { recursive: true, force: true })
  t.end()
})

// Ruling 17: a run whose append fails still counts in this process (so it stays capped and counting),
// and the process is locked until an append or probe succeeds. Once storage recovers the lock clears.
// Only the failed run's cost is lost to a later restart: the accepted residual, which the AWS Budget
// backstop covers. Regression caught: dropping the failed run from the in-memory total, or never clearing
// the lock after storage recovers.
test('a failed run append is counted in memory and locks until storage recovers', { skip: ROOT }, t => {
  const { base, dir, nov } = scratch()
  const { events, log } = logger()
  const ledger = openSpendLedger(dir, log, NOV_20)
  ledger.recordRuns([run(90, 'C1-1')], NOV_20)
  fs.chmodSync(nov, 0o400)
  ledger.recordRuns([run(20, 'C1-2')], NOV_20)
  t.equal(ledger.state(NOV_20).spentUsd, 110, 'the failed run still counts in this process')
  t.equal(ledger.state(NOV_20).locked, true, 'and the process reads as capped')
  t.ok(events.some(e => e.event === 'spend.write_failed'))
  t.equal(openSpendLedger(dir, logger().log, NOV_20).state(NOV_20).locked, true, 'a restart while storage still fails starts locked')
  fs.chmodSync(nov, 0o600)
  ledger.recordRuns([run(1, 'C1-3')], NOV_20)
  t.equal(ledger.state(NOV_20).locked, false, 'the next successful append clears the lock')
  t.equal(ledger.state(NOV_20).spentUsd, 111)
  t.deepEqual(
    openSpendLedger(dir, logger().log, NOV_20).state(NOV_20).entries.map(e => e.runId),
    ['C1-1', 'C1-3'],
    'after a restart only the failed run is missing (the accepted residual)'
  )
  fs.rmSync(base, { recursive: true, force: true })
  t.end()
})

// Spec 8: alert and cap decisions are journaled before posting, so a restart never re-sends them. The cap
// line records the cap it was sent for; a higher configured cap is not covered by it, which is how a cap
// raise re-arms the message with no extra state. Regression caught: a boolean "announced" flag that a cap
// raise never reset, so reaching the new cap was silent.
test('alerts and the cap announcement persist across a restart, and the highest cap wins', t => {
  const { base, dir } = scratch()
  const ledger = openSpendLedger(dir, logger().log, NOV_20)
  ledger.recordAlert(50, NOV_20)
  ledger.recordAlert(25, NOV_20)
  ledger.recordCapAnnounced(100, NOV_20)
  const restarted = openSpendLedger(dir, logger().log, NOV_20)
  t.deepEqual(restarted.state(NOV_20).alerted, [25, 50], 'ascending')
  t.equal(restarted.state(NOV_20).capAnnouncedFor, 100)
  t.ok(restarted.state(NOV_20).capAnnouncedFor! < 150, 'a cap raised to 150 is not yet announced')
  restarted.recordCapAnnounced(150, NOV_20)
  restarted.recordCapAnnounced(120, NOV_20)
  t.equal(openSpendLedger(dir, logger().log, NOV_20).state(NOV_20).capAnnouncedFor, 150, 'the highest cap announced')
  t.equal(openSpendLedger(dir, logger().log, DEC_1_0200Z).state(DEC_1_0200Z).capAnnouncedFor, undefined, 'a new month starts unannounced')
  fs.rmSync(base, { recursive: true, force: true })
  t.end()
})

// The bot runs across a month end. The first call in the new UTC month switches to the new journal and
// starts at zero, and nothing is renamed or deleted. Regression caught: last month's spend or alerts
// counting against this month, or the old journal being moved away.
test('a month change mid-process switches journals without renaming or deleting anything', t => {
  const { base, dir, nov, dec } = scratch()
  const { events, log } = logger()
  const ledger = openSpendLedger(dir, log, NOV_20)
  ledger.recordRuns([run(5)], NOV_20)
  ledger.recordAlert(25, NOV_20)
  const november = fs.readFileSync(nov, 'utf8')
  const december = ledger.state(DEC_1_0200Z)
  t.equal(december.month, '2026-12')
  t.equal(december.spentUsd, 0)
  t.deepEqual(december.alerted, [], 'alerts start over each month')
  t.ok(events.some(e => e.event === 'spend.month_started'))
  t.deepEqual(fs.readdirSync(dir).sort(), [path.basename(nov), path.basename(dec)], 'both journals, nothing else')
  t.equal(fs.readFileSync(nov, 'utf8'), november, 'November is untouched')
  fs.rmSync(base, { recursive: true, force: true })
  t.end()
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx ts-node --compiler-options '{"module":"commonjs"}' --transpile-only src/spend-ledger.test.ts`
Expected: FAIL with `Cannot find module './spend-ledger'`.

- [ ] **Step 3: Write the ledger**

Create `src/spend-ledger.ts`:

```ts
// The month-to-date Bedrock spend ledger (spec section 7): one append-only JSON Lines journal per UTC
// month, spend-YYYY-MM.jsonl in the cursor file's directory. Each line is a priced engine run, a decided
// threshold alert, or a decided cap-reached message. The bot never rewrites, renames or deletes a
// journal: a new month is a new file name, and old months stay for audit. `spentUsd` never leaves the
// process: user-facing text shows percentages only (spec section 1).

import * as fs from 'fs'
import * as path from 'path'
import type { EngineName } from './config'
import type { LedgerTokens } from './pricing'

/** One priced engine run: a `run` line without its `type`. */
export interface SpendRun {
  at: string
  runId: string
  engine: EngineName
  model: string
  tokens: LedgerTokens
  costUsd: number
  /** The engine ran but reported no usage (a lost worker, say): recorded at zero so the gap is auditable. */
  noUsage?: true
}

/** What the current month's journal adds up to. */
export interface SpendState {
  /** The UTC month, `YYYY-MM`. */
  month: string
  /** The sum of the month's run costs. */
  spentUsd: number
  /** Alert thresholds already decided this month, ascending. */
  alerted: number[]
  /** The highest cap a cap-reached message was decided for this month; absent when none was. */
  capAnnouncedFor?: number
  /** The journal has a bad line, or storage cannot be written: the month reads as capped (ruling 8). */
  locked: boolean
  /** The month's runs, in journal order. */
  entries: SpendRun[]
}

export interface SpendLedger {
  /** This month's state, switching to the new month's journal first if the UTC month has changed. */
  state(nowMs: number): Readonly<SpendState>
  /** Count the runs, then append them in one write. Never throws. */
  recordRuns(runs: SpendRun[], nowMs: number): void
  /** Mark the threshold alerted, then append it. Called before posting. Never throws. */
  recordAlert(percent: number, nowMs: number): void
  /** Mark the cap-reached message decided for `capUsd`, then append it. Called before posting. Never throws. */
  recordCapAnnounced(capUsd: number, nowMs: number): void
}

type Log = (event: string, fields: Record<string, unknown>) => void

/** `YYYY-MM` of the UTC month containing `ms`. */
export function utcMonth(ms: number): string {
  const d = new Date(ms)
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
}

/** 00:00 UTC on the first day of the month after the one containing `ms`: when the cap resets. */
export function nextMonthStart(ms: number): number {
  const d = new Date(ms)
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)
}

/** The journal for `month` (`YYYY-MM`) in the state directory `dir`. */
export function spendFileFor(dir: string, month: string): string {
  return path.join(dir, `spend-${month}.jsonl`)
}

const UNREADABLE_HINT = 'this month reads as capped; fix or remove the bad line and restart'
const WRITE_HINT = 'new reviews are refused until the spend journal can be written'

const isObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const nonNegative = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0
const TOKEN_FIELDS = ['input', 'cachedInput', 'cacheWrite', 'output', 'reasoning'] as const

type JournalLine = { type: 'run'; run: SpendRun } | { type: 'alert'; percent: number } | { type: 'cap'; capUsd: number }

/** One journal line, or the reason it cannot be trusted. */
function parseLine(text: string): JournalLine | string {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (error) {
    return `not JSON: ${String(error)}`
  }
  if (!isObject(value)) return 'not a JSON object'
  const at = value.at
  if (typeof at !== 'string' || Number.isNaN(Date.parse(at))) return 'bad "at"'
  if (value.type === 'run') {
    const { runId, engine, model, tokens, costUsd, noUsage } = value
    if (typeof runId !== 'string' || typeof model !== 'string') return 'bad run: runId and model must be strings'
    if (engine !== 'codex' && engine !== 'claude') return 'bad run: unknown engine'
    if (!isObject(tokens) || !TOKEN_FIELDS.every(field => nonNegative(tokens[field]))) return 'bad run: tokens'
    if (!nonNegative(costUsd)) return 'bad run: costUsd'
    if (noUsage !== undefined && noUsage !== true) return 'bad run: noUsage'
    const counts = tokens as Record<(typeof TOKEN_FIELDS)[number], number>
    return {
      type: 'run',
      run: {
        at,
        runId,
        engine,
        model,
        tokens: {
          input: counts.input,
          cachedInput: counts.cachedInput,
          cacheWrite: counts.cacheWrite,
          output: counts.output,
          reasoning: counts.reasoning,
        },
        costUsd,
        ...(noUsage ? { noUsage: true as const } : {}),
      },
    }
  }
  if (value.type === 'alert') {
    const percent = value.percent
    return typeof percent === 'number' && Number.isInteger(percent) && percent >= 1 && percent <= 99
      ? { type: 'alert', percent }
      : 'bad alert: percent must be an integer from 1 to 99'
  }
  if (value.type === 'cap') {
    const capUsd = value.capUsd
    return typeof capUsd === 'number' && Number.isFinite(capUsd) && capUsd > 0 ? { type: 'cap', capUsd } : 'bad cap: capUsd must be above zero'
  }
  return `unknown type ${JSON.stringify(value.type)}`
}

/** One month's journal, as read and as recorded since. */
interface Month {
  month: string
  file: string
  spentUsd: number
  alerted: Set<number>
  capAnnouncedFor?: number
  /** A line could not be trusted: the month stays locked until the line is fixed and the bot restarts. */
  unreadable: boolean
  /** The file ends without a newline (a crash mid-append): the next append starts a fresh line first. */
  partialTail: boolean
  entries: SpendRun[]
}

function applyLine(m: Month, line: JournalLine): void {
  if (line.type === 'run') {
    m.entries.push(line.run)
    m.spentUsd += line.run.costUsd
  } else if (line.type === 'alert') {
    m.alerted.add(line.percent)
  } else {
    m.capAnnouncedFor = Math.max(m.capAnnouncedFor ?? 0, line.capUsd)
  }
}

/** Read `month`'s journal. A missing file is an empty month; any line that cannot be trusted locks it. */
function readMonth(dir: string, month: string, log: Log): Month {
  const file = spendFileFor(dir, month)
  const m: Month = { month, file, spentUsd: 0, alerted: new Set(), unreadable: false, partialTail: false, entries: [] }
  let raw: string
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return m
    log('spend.unreadable', { file, reason: `cannot read: ${String(error)}`, hint: UNREADABLE_HINT })
    m.unreadable = true
    return m
  }
  const bad = (line: number, reason: string): void => {
    m.unreadable = true
    log('spend.unreadable', { file, line, reason, hint: UNREADABLE_HINT })
  }
  const lines = raw.split('\n')
  // What follows the last newline: empty for a whole journal, a partial line after a crash mid-append.
  const tail = lines.pop() ?? ''
  lines.forEach((text, index) => {
    if (text.trim() === '') return
    const parsed = parseLine(text)
    if (typeof parsed === 'string') bad(index + 1, parsed)
    else applyLine(m, parsed)
  })
  if (tail !== '') {
    // Conservative: even a tail that would parse is treated as a write that may not have finished.
    bad(lines.length + 1, 'partial last line (no trailing newline)')
    m.partialTail = true
  }
  return m
}

/**
 * Open the journal for the current UTC month in `dir` (Task 5's `spendDir`). Reading never throws: an
 * untrustworthy journal, or storage that cannot be written, makes the month read as capped instead.
 */
export function openSpendLedger(dir: string, log: Log, nowMs: number = Date.now()): SpendLedger {
  // True while the last append or probe failed. The month reads as capped until one succeeds, and every
  // state() retries the probe, so the lock clears on its own once storage recovers.
  let writeFailing = false
  const succeeded = (file: string): void => {
    if (writeFailing) log('spend.write_recovered', { file })
    writeFailing = false
  }
  const failed = (file: string, error: unknown): void => {
    writeFailing = true
    log('spend.write_failed', { file, error: String(error), hint: WRITE_HINT })
  }
  /** Can the journal be appended to? A zero-byte append creates a missing file and writes nothing. */
  const probe = (m: Month): void => {
    try {
      fs.mkdirSync(dir, { recursive: true })
      fs.accessSync(dir, fs.constants.W_OK)
      fs.appendFileSync(m.file, '')
      succeeded(m.file)
    } catch (error) {
      failed(m.file, error)
    }
  }
  /** One append per call. Never throws: a ledger that cannot be written must not take a review down. */
  const append = (m: Month, records: object[]): void => {
    const text = `${m.partialTail ? '\n' : ''}${records.map(record => `${JSON.stringify(record)}\n`).join('')}`
    try {
      fs.mkdirSync(dir, { recursive: true })
      fs.appendFileSync(m.file, text)
      m.partialTail = false
      succeeded(m.file)
    } catch (error) {
      failed(m.file, error)
    }
  }

  let current = readMonth(dir, utcMonth(nowMs), log)
  probe(current)

  /** The month for `now`: on the first call in a new UTC month, read (and probe) that month's journal. */
  const monthAt = (now: number): Month => {
    const month = utcMonth(now)
    if (month !== current.month) {
      log('spend.month_started', { from: current.month, to: month, file: spendFileFor(dir, month) })
      current = readMonth(dir, month, log)
      probe(current)
    }
    return current
  }

  return {
    state(now) {
      const m = monthAt(now)
      if (writeFailing) probe(m)
      return {
        month: m.month,
        spentUsd: m.spentUsd,
        alerted: [...m.alerted].sort((a, b) => a - b),
        ...(m.capAnnouncedFor !== undefined ? { capAnnouncedFor: m.capAnnouncedFor } : {}),
        locked: m.unreadable || writeFailing,
        entries: m.entries,
      }
    },
    recordRuns(runs, now) {
      if (runs.length === 0) return
      const m = monthAt(now)
      // Counted before the append: if it fails, this process still counts the run and stays capped
      // (ruling 17).
      for (const run of runs) applyLine(m, { type: 'run', run })
      append(m, runs.map(run => ({ type: 'run', ...run })))
    },
    recordAlert(percent, now) {
      const m = monthAt(now)
      applyLine(m, { type: 'alert', percent })
      append(m, [{ type: 'alert', at: new Date(now).toISOString(), percent }])
    },
    recordCapAnnounced(capUsd, now) {
      const m = monthAt(now)
      applyLine(m, { type: 'cap', capUsd })
      append(m, [{ type: 'cap', at: new Date(now).toISOString(), capUsd }])
    },
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx ts-node --compiler-options '{"module":"commonjs"}' --transpile-only src/spend-ledger.test.ts`
Expected: PASS (all ten tests). Run as root, the two permission tests are skipped.

Run: `npm test 2>&1 | tail -4 && npm run typecheck`
Expected: `# ok`, then `tsc` exits 0.

- [ ] **Step 5: Commit**

Write `/tmp/srb-commit-msg.txt` with the editor tool:

```text
feat(spend): add the month-to-date Bedrock spend ledger (refs andrew-barnett/slack-review-bot#76)

Each UTC month is an append-only spend-YYYY-MM.jsonl journal of priced
runs and decided alerts, so nothing is ever rewritten, renamed or
deleted. A bad or partial line, or storage that cannot be written, makes
the month read as capped, so a lost record never reopens spending.

[cc](https://claude.com/claude-code)
```

Run: `git add src/spend-ledger.ts src/spend-ledger.test.ts && git commit -F /tmp/srb-commit-msg.txt`

---

### Task 5: Spend settings (`src/config.ts`, `compose.yaml`)

**Files:**
- Modify: `src/config.ts`, `compose.yaml`
- Test: `src/config-spend.test.ts` (create), `src/container-files.test.ts` (append)

**Interfaces:**
- Consumes: Task 3 `defaultPricesFile()`.
- Produces (src/config.ts, daemon-only `Config` fields, all filled by `loadConfig`):
  - `spendCapUsd: number`, `spendAlertPercents: number[]`, `spendAlertHerePercents: number[]`, `spendAlertChannel: string` (empty when there is none, ruling 7), `bedrockPricesFile: string`, `spendDir: string` (the directory of the monthly `spend-YYYY-MM.jsonl` journals)
  - `parseCapUsd(raw: string | undefined): number`
  - `parseAlertPercents(raw: string | undefined): number[]`
  - `parseHerePercents(raw: string | undefined, alertPercents: number[]): number[]`
  - `parseAlertChannel(raw: string | undefined, channelIds: string[]): string`

- [ ] **Step 1: Write the failing tests**

Create `src/config-spend.test.ts`:

```ts
import * as path from 'path'
import test from 'tape'
import { loadConfig, parseAlertChannel, parseAlertPercents, parseCapUsd, parseHerePercents } from './config'

/** The two required keys, so a test can vary only the knob it cares about. */
const credentials = { SLACK_BOT_TOKEN: 'placeholder', SLACK_APP_TOKEN: 'placeholder' }

// Spec 4: every default as the table gives it. Regression caught: a default drifting from the spec, which
// would move the cap or the alert points without anyone deciding to.
test('the spend settings default as the spec says', t => {
  const c = loadConfig({ ...credentials, HOME: '/home/u', SLACK_CHANNEL_IDS: 'C0123456789,C0987654321' })
  t.equal(c.spendCapUsd, 1000)
  t.deepEqual(c.spendAlertPercents, [25, 50, 75, 90])
  t.deepEqual(c.spendAlertHerePercents, [75, 90])
  t.equal(c.spendAlertChannel, 'C0123456789', 'the first allowlisted channel')
  t.ok(c.bedrockPricesFile.endsWith(path.join('pricing', 'bedrock-prices.json')), c.bedrockPricesFile)
  t.equal(c.spendDir, '/home/u/.local/state/slack-review-bot')
  t.end()
})

// Spec 7 / ruling 9: the monthly journals sit beside CURSOR_FILE (the container's state volume), and an
// empty CURSOR_FILE, which disables the cursor, must not disable the ledger with it.
test('the spend journals sit beside CURSOR_FILE, and an empty CURSOR_FILE never disables them', t => {
  const container = loadConfig({ ...credentials, HOME: '/home/bot', CURSOR_FILE: '/var/lib/slack-review-bot/state/cursors.json' })
  t.equal(container.spendDir, '/var/lib/slack-review-bot/state')
  const noCursor = loadConfig({ ...credentials, HOME: '/home/u', CURSOR_FILE: '' })
  t.equal(noCursor.spendDir, '/home/u/.local/state/slack-review-bot')
  t.end()
})

// Spec 4: a positive finite number of US dollars, otherwise startup fails. A typo must not become an
// unlimited or zero cap.
test('parseCapUsd accepts a positive number and refuses anything else', t => {
  t.equal(parseCapUsd(undefined), 1000)
  t.equal(parseCapUsd(''), 1000)
  t.equal(parseCapUsd('250'), 250)
  t.equal(parseCapUsd('1500.50'), 1500.5)
  for (const bad of ['0', '-5', 'abc', '1e3', 'Infinity', '12,000']) {
    t.throws(() => parseCapUsd(bad), /BEDROCK_MONTHLY_CAP_USD must be a positive number/, bad)
  }
  t.throws(() => loadConfig({ ...credentials, HOME: '/home/u', BEDROCK_MONTHLY_CAP_USD: '0' }), /BEDROCK_MONTHLY_CAP_USD/, 'startup fails')
  t.end()
})

// Spec 4: integers 1-99, strictly ascending, no duplicates.
test('parseAlertPercents wants integers from 1 to 99 in strictly ascending order', t => {
  t.deepEqual(parseAlertPercents(undefined), [25, 50, 75, 90])
  t.deepEqual(parseAlertPercents('10, 20 80'), [10, 20, 80])
  for (const bad of ['50,25', '25,25', '0,50', '50,100', '12.5', 'x']) {
    t.throws(() => parseAlertPercents(bad), /SPEND_ALERT_PERCENTS must be integers from 1 to 99/, bad)
  }
  t.end()
})

// Ruling 6 / Review Focus 5: each @here percent must be an alert percent; unset means whichever of 75 and
// 90 are alert percents, so a custom alert list does not break startup; empty means no @here.
test('parseHerePercents must be a subset of the alert percents, and its default follows them', t => {
  t.deepEqual(parseHerePercents(undefined, [25, 50, 75, 90]), [75, 90])
  t.deepEqual(parseHerePercents(undefined, [50, 80]), [], 'a custom list without 75 or 90 still starts')
  t.deepEqual(parseHerePercents(undefined, [50, 90]), [90])
  t.deepEqual(parseHerePercents('', [25, 50, 75, 90]), [], 'explicitly empty: no @here on thresholds')
  t.deepEqual(parseHerePercents('50', [50, 80]), [50])
  t.throws(() => parseHerePercents('75', [50, 80]), /SPEND_ALERT_HERE_PERCENTS: 75 is not in SPEND_ALERT_PERCENTS/)
  t.throws(() => parseHerePercents('x', [50, 80]), /SPEND_ALERT_HERE_PERCENTS/)
  t.end()
})

// Spec 4 / ruling 7: the alert channel defaults to the first allowlisted channel, may be empty when there
// is none, and an explicit value must look like a channel ID (a #name never matches a Slack channel).
test('parseAlertChannel defaults to the first allowlisted channel and checks an explicit ID', t => {
  t.equal(parseAlertChannel(undefined, ['C0AAAA111', 'C0BBBB222']), 'C0AAAA111')
  t.equal(parseAlertChannel(undefined, []), '')
  t.equal(parseAlertChannel('G0123ABCD', []), 'G0123ABCD')
  t.throws(() => parseAlertChannel('#reviews', []), /SPEND_ALERT_CHANNEL must be a Slack channel ID/)
  t.end()
})

// The price file path is an operator override.
test('BEDROCK_PRICES_FILE overrides the default price file', t => {
  t.equal(loadConfig({ ...credentials, HOME: '/home/u', BEDROCK_PRICES_FILE: '/etc/srb/prices.json' }).bedrockPricesFile, '/etc/srb/prices.json')
  t.end()
})
```

Append to `src/container-files.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx ts-node --compiler-options '{"module":"commonjs"}' --transpile-only src/config-spend.test.ts`
Expected: FAIL; `parseCapUsd` and the other parsers are not exported (`TypeError: (0 , config_1.parseCapUsd) is not a function`).

Run: `npx ts-node --compiler-options '{"module":"commonjs"}' --transpile-only src/container-files.test.ts`
Expected: FAIL on the new test (`BEDROCK_MONTHLY_CAP_USD reaches the orchestrator`, and the others).

- [ ] **Step 3: Read the settings in `loadConfig`**

In `src/config.ts`, replace:

```ts
import { defaultLoginScriptPath } from './registry-auth'
```

with:

```ts
import { defaultPricesFile } from './pricing'
import { defaultLoginScriptPath } from './registry-auth'
```

In the same file, replace:

```ts
   * where letting a review finish is preferable to replaying it.
   */
  shutdownDrainMs: number
}
```

with:

```ts
   * where letting a review finish is preferable to replaying it.
   */
  shutdownDrainMs: number
  /** BEDROCK_MONTHLY_CAP_USD: the bot's monthly Bedrock spend cap. Never shown in Slack (spec section 1). */
  spendCapUsd: number
  /** SPEND_ALERT_PERCENTS: percentages of the cap that post a channel alert, ascending. */
  spendAlertPercents: number[]
  /** SPEND_ALERT_HERE_PERCENTS: which of those alerts carry `<!here>`. */
  spendAlertHerePercents: number[]
  /** SPEND_ALERT_CHANNEL, else the first SLACK_CHANNEL_IDS entry; empty means alerts are only logged. */
  spendAlertChannel: string
  /** BEDROCK_PRICES_FILE: the price table spend is computed from. */
  bedrockPricesFile: string
  /** Where the month-to-date ledger's spend-YYYY-MM.jsonl journals live: the cursor file's directory (spec section 7). */
  spendDir: string
}
```

In the same file, replace:

```ts
/** Parse RUNTIME: unset means the launchd daemon. */
export function parseRuntime(raw: string | undefined): Runtime {
```

with:

```ts
/** Parse BEDROCK_MONTHLY_CAP_USD: a positive number of US dollars; unset means 1000. */
export function parseCapUsd(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return 1000
  const text = raw.trim()
  const n = /^\d+(\.\d+)?$/.test(text) ? Number(text) : Number.NaN
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`BEDROCK_MONTHLY_CAP_USD must be a positive number of US dollars, like 1000 (got "${raw}")`)
  }
  return n
}

/** Parse SPEND_ALERT_PERCENTS: integers 1-99, strictly ascending; unset or empty means 25,50,75,90. */
export function parseAlertPercents(raw: string | undefined): number[] {
  if (raw === undefined || raw.trim() === '') return [25, 50, 75, 90]
  const percents = parseList(raw).map(s => (/^\d+$/.test(s) ? Number(s) : Number.NaN))
  const valid =
    percents.every(n => Number.isInteger(n) && n >= 1 && n <= 99) &&
    percents.every((n, i) => i === 0 || n > percents[i - 1])
  if (!valid) {
    throw new Error(`SPEND_ALERT_PERCENTS must be integers from 1 to 99 in strictly ascending order (got "${raw}")`)
  }
  return percents
}

/**
 * Parse SPEND_ALERT_HERE_PERCENTS against the alert percents. Unset means whichever of 75 and 90 are alert
 * percents (ruling 6); explicitly empty means no threshold alert carries `<!here>`.
 */
export function parseHerePercents(raw: string | undefined, alertPercents: number[]): number[] {
  if (raw === undefined) return [75, 90].filter(p => alertPercents.includes(p))
  const percents = parseList(raw).map(s => (/^\d+$/.test(s) ? Number(s) : Number.NaN))
  for (const p of percents) {
    if (!alertPercents.includes(p)) {
      throw new Error(`SPEND_ALERT_HERE_PERCENTS: ${Number.isNaN(p) ? 'a non-integer entry' : p} is not in SPEND_ALERT_PERCENTS (${alertPercents.join(',')})`)
    }
  }
  return percents
}

/** Parse SPEND_ALERT_CHANNEL: a Slack channel ID; unset means the first allowlisted channel, or none. */
export function parseAlertChannel(raw: string | undefined, channelIds: string[]): string {
  if (raw === undefined || raw.trim() === '') return channelIds[0] ?? ''
  const id = raw.trim()
  if (!/^[CGD][A-Z0-9]{2,}$/.test(id)) {
    throw new Error(`SPEND_ALERT_CHANNEL must be a Slack channel ID like C0123456789, not a name (got "${raw}")`)
  }
  return id
}

/** Parse RUNTIME: unset means the launchd daemon. */
export function parseRuntime(raw: string | undefined): Runtime {
```

In the same file, replace:

```ts
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const home = env.HOME || os.homedir()
  return {
    ...loadReviewConfig(env),
    botToken: required(env, 'SLACK_BOT_TOKEN'),
    appToken: required(env, 'SLACK_APP_TOKEN'),
    channelIds: parseList(env.SLACK_CHANNEL_IDS),
    ignoreUserIds: parseUserIds(env.SLACK_IGNORE_USER_IDS),
    cursorFile: env.CURSOR_FILE ?? path.join(home, '.local', 'state', 'slack-review-bot', 'cursors.json'),
```

with:

```ts
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const home = env.HOME || os.homedir()
  const stateDir = path.join(home, '.local', 'state', 'slack-review-bot')
  const cursorFile = env.CURSOR_FILE ?? path.join(stateDir, 'cursors.json')
  const channelIds = parseList(env.SLACK_CHANNEL_IDS)
  const spendAlertPercents = parseAlertPercents(env.SPEND_ALERT_PERCENTS)
  return {
    ...loadReviewConfig(env),
    botToken: required(env, 'SLACK_BOT_TOKEN'),
    appToken: required(env, 'SLACK_APP_TOKEN'),
    channelIds,
    ignoreUserIds: parseUserIds(env.SLACK_IGNORE_USER_IDS),
    cursorFile,
```

In the same file, replace:

```ts
    shutdownDrainMs: parsePositiveInt(env.SHUTDOWN_DRAIN_MS, 5_000),
  }
}
```

with:

```ts
    shutdownDrainMs: parsePositiveInt(env.SHUTDOWN_DRAIN_MS, 5_000),
    // The monthly Bedrock spend cap (spec section 4). Parsed always; the price file is read only when the
    // cap is active (ruling 3), by openSpendCap at daemon startup.
    spendCapUsd: parseCapUsd(env.BEDROCK_MONTHLY_CAP_USD),
    spendAlertPercents,
    spendAlertHerePercents: parseHerePercents(env.SPEND_ALERT_HERE_PERCENTS, spendAlertPercents),
    spendAlertChannel: parseAlertChannel(env.SPEND_ALERT_CHANNEL, channelIds),
    bedrockPricesFile: env.BEDROCK_PRICES_FILE || defaultPricesFile(),
    // Beside the cursor file (on the orchestrator state volume in the container). An empty CURSOR_FILE
    // disables the cursor, never the ledger (ruling 9).
    spendDir: cursorFile ? path.dirname(cursorFile) : stateDir,
  }
}
```

- [ ] **Step 4: Pass the settings to the orchestrator**

In `compose.yaml`, replace:

```yaml
      - ROLE_GH_LOGIN
      - OPERATOR_GH_LOGIN

  worker:
```

with:

```yaml
      - ROLE_GH_LOGIN
      - OPERATOR_GH_LOGIN
      # The monthly Bedrock spend cap (spec section 4): the orchestrator prices each engine run, so it
      # also needs the model IDs the workers use.
      - BEDROCK_MONTHLY_CAP_USD
      - SPEND_ALERT_PERCENTS
      - SPEND_ALERT_HERE_PERCENTS
      - SPEND_ALERT_CHANNEL
      - BEDROCK_PRICES_FILE
      - CODEX_BEDROCK_MODEL
      - CLAUDE_BEDROCK_MODEL

  worker:
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `for f in src/config-spend.test.ts src/container-files.test.ts src/config.test.ts; do npx ts-node --compiler-options '{"module":"commonjs"}' --transpile-only "$f" 2>&1 | tail -2; done`
Expected: each ends with `# ok`. (The existing `compose.yaml passes every config setting to a service or excludes it on purpose` test now also sees the five new names in `src/config.ts`; they pass because Step 4 put them in the orchestrator list.)

Run: `npm test 2>&1 | tail -4 && npm run typecheck`
Expected: `# ok`, then `tsc` exits 0.

- [ ] **Step 6: Commit**

Write `/tmp/srb-commit-msg.txt` with the editor tool:

```text
feat(config): read the Bedrock spend cap settings (refs andrew-barnett/slack-review-bot#76)

BEDROCK_MONTHLY_CAP_USD, the alert percents and channel, and the price
file path are parsed and validated at startup; the monthly spend
journals live beside the cursor file. The orchestrator gets the settings and the model IDs it
prices by through compose.yaml.

[cc](https://claude.com/claude-code)
```

Run: `git add src/config.ts src/config-spend.test.ts compose.yaml src/container-files.test.ts && git commit -F /tmp/srb-commit-msg.txt`

---

### Task 6: The spend cap, its messages, and the status line (`src/spend-messages.ts`, `src/spend-cap.ts`, `src/status.ts`)

**Files:**
- Create: `src/spend-messages.ts`, `src/spend-cap.ts`
- Modify: `src/status.ts`
- Test: `src/spend-messages.test.ts`, `src/spend-cap.test.ts` (create), `src/status.test.ts` (append)

**Interfaces:**
- Consumes: Task 3 `loadPriceTable`, `priceCodex`, `priceClaude`, `PriceTable`, `LedgerTokens`; Task 4 `openSpendLedger`, `nextMonthStart`, `SpendLedger`, `SpendState`, `SpendRun`; Task 5 `Config` spend fields; Task 2 `RunUsage.codex`.
- Produces:
  - src/spend-messages.ts:
    - `type SpendStatus = { active: false } | { active: true; percent: number; resetsAt: number }`
    - `formatResetEt(ms: number): { date: string; time: string }` (`{ date: 'Nov 30', time: '7:00 PM' }`)
    - `renderCapRefusal(resetAt: number): string`, `renderThresholdAlert(percent: number, here: boolean): string`, `renderCapReachedAlert(resetAt: number): string`, `renderSpendStatusLine(status: SpendStatus): string`
  - src/spend-cap.ts:
    - `interface SpendCapSettings { capUsd: number; alertPercents: number[]; herePercents: number[]; alertChannel: string }`
    - `interface SpendCap { readonly active: boolean; capped(nowMs: number): boolean; record(usage: RunUsage, runId: string, nowMs: number): Promise<void>; status(nowMs: number): SpendStatus }`
    - `spendCapActive(config: Pick<Config, 'runtime' | 'engineAuth'>): boolean`
    - `spendPercent(state: Pick<SpendState, 'spentUsd' | 'locked'>, capUsd: number): number`
    - `inactiveSpendCap(): SpendCap`
    - `createSpendCap(deps: SpendCapDeps): SpendCap`
    - `type SpendCapConfig` (the `Config` fields `openSpendCap` reads)
    - `openSpendCap(config: SpendCapConfig, log, postChannelMessage, nowMs?): SpendCap` (throws when the price file is missing, invalid, or lacks a configured model)
  - src/status.ts: `renderStatus(snapshot, catchUp?, connection?, activity?, spend?: SpendStatus)`.
  - Log events: `spend.cap_active`, `spend.cap_inactive`, `spend.price_missing`, `spend.no_usage`, `spend.alert_sent`, `spend.alert_failed`, `spend.alert_skipped`, `spend.record_failed`.

- [ ] **Step 1: Write the failing message tests**

Create `src/spend-messages.test.ts`:

```ts
import test from 'tape'
import {
  formatResetEt,
  renderCapReachedAlert,
  renderCapRefusal,
  renderSpendStatusLine,
  renderThresholdAlert,
} from './spend-messages'

const DEC_1 = Date.UTC(2026, 11, 1)
const JUL_1 = Date.UTC(2027, 6, 1)

// D5: the reset is 00:00 UTC on the 1st, shown in New York time. In winter that is 7:00 PM the day
// before, in summer 8:00 PM. Regression caught: formatting in the host's zone, or printing "Dec 1".
test('formatResetEt shows the UTC month start in New York time, across daylight saving', t => {
  t.deepEqual(formatResetEt(DEC_1), { date: 'Nov 30', time: '7:00 PM' })
  t.deepEqual(formatResetEt(JUL_1), { date: 'Jun 30', time: '8:00 PM' })
  t.end()
})

// Spec 8 and 9: the user-facing texts, verbatim. Regression caught: wording drifting from the spec,
// or ICU's U+202F narrow no-break space sneaking in before "PM" (it renders the same and matches nothing).
test('the refusal, alert and cap texts are the spec text verbatim', t => {
  t.equal(
    renderCapRefusal(DEC_1),
    "This bot's monthly Bedrock spend cap has been reached, so it isn't starting new reviews. Reviews resume on Nov 30 at 7:00 PM ET (the start of the next UTC month), or sooner if the cap is raised."
  )
  t.equal(renderThresholdAlert(76, true), '<!here> This bot has used 76% of its monthly Bedrock spend cap. New reviews stop at 100%.')
  t.equal(renderThresholdAlert(26, false), 'This bot has used 26% of its monthly Bedrock spend cap. New reviews stop at 100%.')
  t.equal(
    renderCapReachedAlert(DEC_1),
    '<!here> This bot has reached its monthly Bedrock spend cap. New review requests will be declined until Nov 30 at 7:00 PM ET.'
  )
  t.notOk(/\u202f/.test(renderCapRefusal(DEC_1) + renderCapReachedAlert(DEC_1)), 'plain spaces only')
  t.end()
})

// Spec 9 and ruling 16: the status line, verbatim, in its three states.
test('renderSpendStatusLine reads inactive, a percent, or cap reached', t => {
  t.equal(renderSpendStatusLine({ active: false }), 'Bedrock spend cap: not active (subscription auth)')
  t.equal(renderSpendStatusLine({ active: true, percent: 41, resetsAt: DEC_1 }), 'Bedrock spend this month: 41% of cap · resets Nov 30, 7:00 PM ET')
  t.equal(renderSpendStatusLine({ active: true, percent: 100, resetsAt: DEC_1 }), 'Bedrock spend this month: cap reached · resets Nov 30, 7:00 PM ET')
  t.equal(renderSpendStatusLine({ active: true, percent: 134, resetsAt: DEC_1 }), 'Bedrock spend this month: cap reached · resets Nov 30, 7:00 PM ET', 'never over 100%')
  t.end()
})
```

- [ ] **Step 2: Run the message tests to verify they fail**

Run: `npx ts-node --compiler-options '{"module":"commonjs"}' --transpile-only src/spend-messages.test.ts`
Expected: FAIL with `Cannot find module './spend-messages'`.

- [ ] **Step 3: Write the messages**

Create `src/spend-messages.ts`:

```ts
// Every user-facing string about the Bedrock spend cap. They show percentages, or the fact that the
// cap has been reached, and never a dollar amount: not the cap and not the spend (spec section 1).

export type SpendStatus = { active: false } | { active: true; percent: number; resetsAt: number }

const RESET_FORMAT = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  hour12: true,
})

/**
 * When the cap resets, in New York time. Assembled from parts so the text has plain spaces: ICU puts a
 * U+202F narrow no-break space before "PM", which reads the same and matches nothing.
 */
export function formatResetEt(ms: number): { date: string; time: string } {
  const parts = RESET_FORMAT.formatToParts(new Date(ms))
  const part = (type: Intl.DateTimeFormatPartTypes): string => parts.find(p => p.type === type)?.value ?? ''
  return {
    date: `${part('month')} ${part('day')}`,
    time: `${part('hour')}:${part('minute')} ${part('dayPeriod').toUpperCase()}`,
  }
}

/** The thread reply on a review request refused because the cap has been reached. */
export function renderCapRefusal(resetAt: number): string {
  const { date, time } = formatResetEt(resetAt)
  return (
    "This bot's monthly Bedrock spend cap has been reached, so it isn't starting new reviews. " +
    `Reviews resume on ${date} at ${time} ET (the start of the next UTC month), or sooner if the cap is raised.`
  )
}

/** The channel alert for a crossed threshold. `percent` is the current percent, not the threshold. */
export function renderThresholdAlert(percent: number, here: boolean): string {
  return `${here ? '<!here> ' : ''}This bot has used ${percent}% of its monthly Bedrock spend cap. New reviews stop at 100%.`
}

/** The channel alert when the cap is reached. Always `@here`. */
export function renderCapReachedAlert(resetAt: number): string {
  const { date, time } = formatResetEt(resetAt)
  return `<!here> This bot has reached its monthly Bedrock spend cap. New review requests will be declined until ${date} at ${time} ET.`
}

/** The `status` reply's spend line (ruling 16). */
export function renderSpendStatusLine(status: SpendStatus): string {
  if (!status.active) return 'Bedrock spend cap: not active (subscription auth)'
  const { date, time } = formatResetEt(status.resetsAt)
  const spent = status.percent >= 100 ? 'cap reached' : `${status.percent}% of cap`
  return `Bedrock spend this month: ${spent} · resets ${date}, ${time} ET`
}
```

- [ ] **Step 4: Run the message tests to verify they pass**

Run: `npx ts-node --compiler-options '{"module":"commonjs"}' --transpile-only src/spend-messages.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing cap tests**

Create `src/spend-cap.test.ts`:

```ts
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import test from 'tape'
import { loadConfig } from './config'
import { orchestratorConfig } from './orchestrator'
import type { PriceTable } from './pricing'
import { createSpendCap, inactiveSpendCap, spendCapActive, spendPercent, type SpendCapSettings } from './spend-cap'
import { openSpendLedger, spendFileFor, type SpendLedger } from './spend-ledger'
import { renderCapReachedAlert, renderCapRefusal, renderSpendStatusLine, renderThresholdAlert } from './spend-messages'
import type { ClaudeUsageDetail, CodexUsageDetail, RunUsage } from './usage'

/** Mid-November 2026, UTC. */
const NOW = Date.UTC(2026, 10, 20, 12)
const DEC_1 = Date.UTC(2026, 11, 1)
const CODEX = 'test.codex-model'
const CLAUDE = 'test.claude-model'
/**
 * SYNTHETIC prices, not Bedrock's: one US dollar per token in every column, so with a 100-dollar cap
 * one token is one percent and the arithmetic in each test reads directly.
 */
const ONE_DOLLAR_PER_TOKEN = { input: 1_000_000, cachedInput: 1_000_000, cacheWrite: 1_000_000, output: 1_000_000 }
const prices: PriceTable = {
  source: 'synthetic test table, checked 2026-11-19',
  codexTokenSemantics: { cachedIsSubsetOfInput: false, reasoningInOutput: false },
  models: { [CODEX]: ONE_DOLLAR_PER_TOKEN, [CLAUDE]: ONE_DOLLAR_PER_TOKEN },
}

const codexDetail = (input: number): CodexUsageDetail => ({
  inputTokens: input,
  cachedInputTokens: 0,
  cacheWriteTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
})
/** A usage with one Codex engine run of `tokens` tokens (= that many dollars, = that many percent). */
const codexRun = (tokens: number): RunUsage => ({ attempts: 1, engines: [{ engine: 'codex', usage: { attempts: 1, codex: codexDetail(tokens) } }] })

function harness(settings: Partial<SpendCapSettings> = {}, dir: string = fs.mkdtempSync(path.join(os.tmpdir(), 'spend-cap-'))) {
  const posts: Array<{ channel: string; text: string }> = []
  const events: Array<{ event: string; fields: Record<string, unknown> }> = []
  const log = (event: string, fields: Record<string, unknown>) => void events.push({ event, fields })
  let failPosts = false
  const ledger = openSpendLedger(dir, log, NOW)
  const cap = createSpendCap({
    ledger,
    prices,
    models: { codex: CODEX, claude: CLAUDE },
    settings: { capUsd: 100, alertPercents: [25, 50, 75, 90], herePercents: [75, 90], alertChannel: 'C0ALERTS1', ...settings },
    postChannelMessage: async (channel, text) => {
      if (failPosts) throw new Error('synthetic Slack failure')
      posts.push({ channel, text })
    },
    log,
  })
  return { cap, ledger, posts, events, dir, failPosts: () => void (failPosts = true) }
}

/** The percent from an active status, or -1. */
const percentOf = (status: ReturnType<ReturnType<typeof createSpendCap>['status']>): number => (status.active ? status.percent : -1)

// Spec 8: each threshold alerts once, to the alert channel, with the current percent; only the
// SPEND_ALERT_HERE_PERCENTS thresholds carry @here. Regression caught: an alert per record, or the
// threshold number instead of the current percent.
test('each threshold posts once, with the current percent, and @here only where configured', async t => {
  const h = harness()
  await h.cap.record(codexRun(26), 'C1-1', NOW)
  await h.cap.record(codexRun(25), 'C1-2', NOW)
  await h.cap.record(codexRun(25), 'C1-3', NOW)
  await h.cap.record(codexRun(10), 'C1-4', NOW)
  await h.cap.record(codexRun(4), 'C1-5', NOW)
  t.deepEqual(h.posts, [
    { channel: 'C0ALERTS1', text: renderThresholdAlert(26, false) },
    { channel: 'C0ALERTS1', text: renderThresholdAlert(51, false) },
    { channel: 'C0ALERTS1', text: renderThresholdAlert(76, true) },
    { channel: 'C0ALERTS1', text: renderThresholdAlert(90, true) },
  ])
  t.deepEqual(h.ledger.state(NOW).alerted, [25, 50, 75, 90])
  t.notOk(h.cap.capped(NOW))
  fs.rmSync(h.dir, { recursive: true, force: true })
  t.end()
})

// Spec 8: one record crossing several thresholds below 100 posts one message, for the highest.
test('a record crossing several thresholds posts one alert for the highest', async t => {
  const h = harness()
  await h.cap.record(codexRun(80), 'C1-1', NOW)
  t.deepEqual(h.posts.map(p => p.text), [renderThresholdAlert(80, true)])
  t.deepEqual(h.ledger.state(NOW).alerted, [25, 50, 75])
  fs.rmSync(h.dir, { recursive: true, force: true })
  t.end()
})

// Review Focus 4 / ruling 5: a single expensive run that jumps past the cap sends only the cap message,
// marks every threshold, and from then on the cap refuses. A second record sends nothing more.
test('a jump past the cap sends only the cap message and caps', async t => {
  const h = harness()
  await h.cap.record(codexRun(20), 'C1-1', NOW)
  await h.cap.record(codexRun(130), 'C1-2', NOW)
  t.deepEqual(h.posts.map(p => p.text), [renderCapReachedAlert(DEC_1)], 'nothing under 25%, then only the cap message')
  t.deepEqual(h.ledger.state(NOW).alerted, [25, 50, 75, 90])
  t.equal(h.ledger.state(NOW).capAnnouncedFor, 100, 'announced for the 100-dollar cap')
  t.ok(h.cap.capped(NOW))
  t.deepEqual(h.cap.status(NOW), { active: true, percent: 150, resetsAt: DEC_1 })
  await h.cap.record(codexRun(5), 'C1-3', NOW)
  t.equal(h.posts.length, 1, 'the cap is announced once')
  fs.rmSync(h.dir, { recursive: true, force: true })
  t.end()
})

// Spec 8: alert state is persisted, so a restart does not repeat a threshold already announced.
test('a restart does not repeat an alert', async t => {
  const first = harness()
  await first.cap.record(codexRun(30), 'C1-1', NOW)
  const second = harness({}, first.dir)
  await second.cap.record(codexRun(1), 'C1-2', NOW)
  t.equal(first.posts.length, 1)
  t.equal(second.posts.length, 0, 'the 25% alert is not sent again')
  t.equal(percentOf(second.cap.status(NOW)), 31, 'spend survives the restart')
  fs.rmSync(first.dir, { recursive: true, force: true })
  t.end()
})

// Spec 8: raising the cap mid-month (a restart with a higher BEDROCK_MONTHLY_CAP_USD) lifts the refusal,
// re-arms the cap message, and does not repeat thresholds already announced this month.
test('raising the cap mid-month lifts the refusal and re-arms the cap message', async t => {
  const first = harness()
  await first.cap.record(codexRun(100), 'C1-1', NOW)
  t.ok(first.cap.capped(NOW))
  const raised = harness({ capUsd: 200 }, first.dir)
  t.notOk(raised.cap.capped(NOW), '100 of 200 is 50%')
  await raised.cap.record(codexRun(1), 'C1-2', NOW)
  t.equal(raised.posts.length, 0, 'thresholds already announced stay quiet')
  t.equal(raised.ledger.state(NOW).capAnnouncedFor, 100, 'the announcement covers the old cap only')
  await raised.cap.record(codexRun(99), 'C1-3', NOW)
  t.deepEqual(raised.posts.map(p => p.text), [renderCapReachedAlert(DEC_1)], 'reaching the new cap announces again')
  t.equal(raised.ledger.state(NOW).capAnnouncedFor, 200)
  fs.rmSync(first.dir, { recursive: true, force: true })
  t.end()
})

// PR review finding (andrew-barnett/slack-review-bot#78), round 3: after a cap raise, the very first
// record can cross the new cap with no record below 100% in between. The cap message must still go out,
// because the announcement on file was for the lower cap. Regression caught: a boolean "announced" flag
// that only a below-cap record reset, so this record was silently not announced.
test('after a cap raise, the first record that crosses the new cap announces it', async t => {
  const first = harness()
  await first.cap.record(codexRun(100), 'C1-1', NOW)
  t.deepEqual(first.posts.map(p => p.text), [renderCapReachedAlert(DEC_1)])
  const raised = harness({ capUsd: 200 }, first.dir)
  await raised.cap.record(codexRun(150), 'C1-2', NOW)
  t.deepEqual(raised.posts.map(p => p.text), [renderCapReachedAlert(DEC_1)], 'one cap message for the new cap, no threshold alert')
  t.ok(raised.cap.capped(NOW))
  await raised.cap.record(codexRun(1), 'C1-3', NOW)
  t.equal(raised.posts.length, 1, 'and only once')
  fs.rmSync(first.dir, { recursive: true, force: true })
  t.end()
})

// Spec 8: a failed post is logged, never retried, and the threshold stays marked.
test('a failed alert is logged, not retried, and stays marked', async t => {
  const h = harness()
  h.failPosts()
  await h.cap.record(codexRun(30), 'C1-1', NOW)
  await h.cap.record(codexRun(1), 'C1-2', NOW)
  t.equal(h.events.filter(e => e.event === 'spend.alert_failed').length, 1)
  t.deepEqual(h.ledger.state(NOW).alerted, [25])
  fs.rmSync(h.dir, { recursive: true, force: true })
  t.end()
})

// Ruling 7: with no alert channel, alerts are logged and skipped, and the cap is still enforced.
test('with no alert channel the alert is skipped and the cap still applies', async t => {
  const h = harness({ alertChannel: '' })
  await h.cap.record(codexRun(100), 'C1-1', NOW)
  t.equal(h.posts.length, 0)
  t.ok(h.events.some(e => e.event === 'spend.alert_skipped'))
  t.ok(h.cap.capped(NOW))
  fs.rmSync(h.dir, { recursive: true, force: true })
  t.end()
})

// Spec 7: an engine run that reported no usage is recorded at zero and flagged, so the gap is visible
// in the ledger instead of silently missing.
test('an engine run with no usage detail is recorded as noUsage at zero', async t => {
  const h = harness()
  await h.cap.record({ attempts: 1, engines: [{ engine: 'codex', usage: { attempts: 1 } }] }, 'C1-1', NOW)
  const [entry] = h.ledger.state(NOW).entries
  t.equal(entry.noUsage, true)
  t.equal(entry.costUsd, 0)
  t.equal(entry.model, CODEX)
  t.ok(h.events.some(e => e.event === 'spend.no_usage'))
  fs.rmSync(h.dir, { recursive: true, force: true })
  t.end()
})

// Ruling 2 / Review Focus 2: the launchd single-mode runner's usage has no engines list. It is one Codex
// run; reading only `engines` would record nothing and never trip the cap.
test('record reads a usage with no engines list as one Codex run', async t => {
  const h = harness()
  await h.cap.record({ attempts: 1, codex: codexDetail(30) }, 'C1-1', NOW)
  const [entry] = h.ledger.state(NOW).entries
  t.equal(entry.engine, 'codex')
  t.equal(entry.costUsd, 30)
  t.equal(entry.runId, 'C1-1')
  fs.rmSync(h.dir, { recursive: true, force: true })
  t.end()
})

// Spec D2: Claude is priced from its token counts at the table's prices. Its own costUsd (a notional
// subscription figure) is ignored. Regression caught: adding Claude's costUsd to the ledger.
test('a Claude run is priced from its tokens and its costUsd is ignored', async t => {
  const h = harness()
  const claude: ClaudeUsageDetail = { inputTokens: 2, outputTokens: 3, cacheReadTokens: 1, cacheWriteTokens: 4, costUsd: 999, numTurns: 1, durationMs: 1 }
  await h.cap.record({ attempts: 1, engines: [{ engine: 'claude', usage: { attempts: 1, claude } }] }, 'C1-1', NOW)
  const [entry] = h.ledger.state(NOW).entries
  t.equal(entry.engine, 'claude')
  t.equal(entry.model, CLAUDE)
  t.equal(entry.costUsd, 10)
  t.deepEqual(entry.tokens, { input: 2, cachedInput: 1, cacheWrite: 4, output: 3, reasoning: 0 })
  fs.rmSync(h.dir, { recursive: true, force: true })
  t.end()
})

// Recording runs after a review has finished. A ledger failure must never turn into a crashed job.
test('record never throws; a failure is logged', async t => {
  const events: string[] = []
  const fail = (): never => {
    throw new Error('synthetic ledger failure')
  }
  const broken: SpendLedger = { state: fail, recordRuns: fail, recordAlert: fail, recordCapAnnounced: fail }
  const cap = createSpendCap({
    ledger: broken,
    prices,
    models: { codex: CODEX, claude: CLAUDE },
    settings: { capUsd: 100, alertPercents: [25], herePercents: [], alertChannel: 'C0ALERTS1' },
    postChannelMessage: async () => undefined,
    log: event => void events.push(event),
  })
  await cap.record(codexRun(1), 'C1-1', NOW)
  t.deepEqual(events, ['spend.record_failed'])
  t.end()
})

// Ruling 8: a locked month (a bad journal line) reads as at least 100%, so it refuses and says so.
test('a locked ledger refuses and reports the cap reached', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spend-cap-'))
  fs.writeFileSync(spendFileFor(dir, '2026-11'), 'not json\n')
  const h = harness({}, dir)
  t.ok(h.cap.capped(NOW))
  t.equal(spendPercent({ spentUsd: 0, locked: true }, 100), 100)
  t.equal(spendPercent({ spentUsd: 41.9, locked: false }, 100), 41, 'percent is floored')
  t.equal(renderSpendStatusLine(h.cap.status(NOW)), 'Bedrock spend this month: cap reached · resets Nov 30, 7:00 PM ET')
  fs.rmSync(dir, { recursive: true, force: true })
  t.end()
})

// Ruling 1 / Review Focus 1: the orchestrator never sees ENGINE_AUTH (its engineAuth is always
// subscription), so the cap must key on the container runtime too. A launchd bedrock install is capped;
// launchd subscription is not.
test('spendCapActive: container always, launchd only under bedrock auth', t => {
  const bundle = {
    SLACK_BOT_TOKEN: 'bot-placeholder',
    SLACK_APP_TOKEN: 'app-placeholder',
    APPROVER_GH_TOKEN: 'approver-placeholder',
    LAUNCH_KEY: Buffer.alloc(32, 9).toString('base64url'),
  }
  t.equal(spendCapActive(orchestratorConfig(bundle, { HOME: '/home/bot' }).config), true, 'the orchestrator')
  const credentials = { SLACK_BOT_TOKEN: 'placeholder', SLACK_APP_TOKEN: 'placeholder', HOME: '/home/u' }
  t.equal(spendCapActive(loadConfig(credentials)), false, 'launchd subscription')
  t.equal(
    spendCapActive(loadConfig({ ...credentials, ENGINE_AUTH: 'bedrock', ENGINE_ROLE_ARN: 'arn:aws:iam::123456789012:role/Example' })),
    true,
    'launchd bedrock'
  )
  t.equal(inactiveSpendCap().capped(NOW), false)
  t.deepEqual(inactiveSpendCap().status(NOW), { active: false })
  t.end()
})

// Spec 1: user-facing text never shows a dollar amount. Every spend message and status line, over a
// range of percents and reset times, carries no "$" followed by a digit. Regression caught: a message
// "helpfully" adding the cap or the spend.
test('no spend message or status line contains a dollar amount', t => {
  const texts: string[] = []
  for (const resetAt of [DEC_1, Date.UTC(2027, 6, 1)]) {
    texts.push(renderCapRefusal(resetAt), renderCapReachedAlert(resetAt), renderSpendStatusLine({ active: false }))
    for (const percent of [0, 1, 25, 76, 99, 100, 250]) {
      texts.push(renderThresholdAlert(percent, true), renderThresholdAlert(percent, false))
      texts.push(renderSpendStatusLine({ active: true, percent, resetsAt: resetAt }))
    }
  }
  for (const text of texts) t.notOk(/\$\s*\d/.test(text), text)
  t.end()
})
```

- [ ] **Step 6: Run the cap tests to verify they fail**

Run: `npx ts-node --compiler-options '{"module":"commonjs"}' --transpile-only src/spend-cap.test.ts`
Expected: FAIL with `Cannot find module './spend-cap'`.

- [ ] **Step 7: Write the cap**

Create `src/spend-cap.ts`:

```ts
// The monthly Bedrock spend cap (spec sections 3, 5, 8). The daemon asks it whether new reviews are
// refused, and hands it each settled request's usage: every engine run is priced into the ledger and
// any threshold now crossed is announced in the alert channel. Recording never throws.

import type { Config, EngineName } from './config'
import { loadPriceTable, priceClaude, priceCodex, type LedgerTokens, type PriceTable } from './pricing'
import { nextMonthStart, openSpendLedger, type SpendLedger, type SpendRun, type SpendState } from './spend-ledger'
import { renderCapReachedAlert, renderThresholdAlert, type SpendStatus } from './spend-messages'
import type { RunUsage } from './usage'

type Log = (event: string, fields: Record<string, unknown>) => void
type PostChannelMessage = (channel: string, text: string) => Promise<void>

export interface SpendCapSettings {
  capUsd: number
  /** Ascending. */
  alertPercents: number[]
  /** A subset of alertPercents. */
  herePercents: number[]
  /** Empty: alerts are logged, not posted (ruling 7). */
  alertChannel: string
}

export interface SpendCap {
  readonly active: boolean
  /** True when new reviews are refused: this month's percent is 100 or more. */
  capped(nowMs: number): boolean
  /** Price a settled request's engine runs into the ledger and send any alert now due. Never throws. */
  record(usage: RunUsage, runId: string, nowMs: number): Promise<void>
  status(nowMs: number): SpendStatus
}

export interface SpendCapDeps {
  ledger: SpendLedger
  prices: PriceTable
  /** The configured Bedrock model each engine runs, which keys the price table. */
  models: Record<EngineName, string>
  settings: SpendCapSettings
  postChannelMessage: PostChannelMessage
  log: Log
}

export type SpendCapConfig = Pick<
  Config,
  | 'runtime'
  | 'engineAuth'
  | 'codexBedrockModel'
  | 'claudeBedrockModel'
  | 'spendCapUsd'
  | 'spendAlertPercents'
  | 'spendAlertHerePercents'
  | 'spendAlertChannel'
  | 'bedrockPricesFile'
  | 'spendDir'
>

/** Ruling 1: the container runtime always runs on Bedrock; launchd only under ENGINE_AUTH=bedrock. */
export function spendCapActive(config: Pick<Config, 'runtime' | 'engineAuth'>): boolean {
  return config.runtime === 'container' || config.engineAuth === 'bedrock'
}

/** floor(spent / cap × 100); a locked month (ruling 8) reads as at least 100. */
export function spendPercent(state: Pick<SpendState, 'spentUsd' | 'locked'>, capUsd: number): number {
  const percent = Math.floor((state.spentUsd / capUsd) * 100)
  return state.locked ? Math.max(100, percent) : percent
}

/** Subscription auth: nothing is priced and nothing is refused. */
export function inactiveSpendCap(): SpendCap {
  return {
    active: false,
    capped: () => false,
    record: async () => undefined,
    status: () => ({ active: false }),
  }
}

const NO_TOKENS: LedgerTokens = { input: 0, cachedInput: 0, cacheWrite: 0, output: 0, reasoning: 0 }

export function createSpendCap(deps: SpendCapDeps): SpendCap {
  const { ledger, prices, models, settings, postChannelMessage, log } = deps

  const entryFor = (engine: EngineName, usage: RunUsage, runId: string, at: string): SpendRun => {
    const model = models[engine]
    const price = Object.hasOwn(prices.models, model) ? prices.models[model] : undefined
    const base = { at, runId, engine, model }
    const codex = engine === 'codex' ? usage.codex : undefined
    const claude = engine === 'claude' ? usage.claude : undefined
    if (!codex && !claude) {
      log('spend.no_usage', { runId, engine, model })
      return { ...base, tokens: { ...NO_TOKENS }, costUsd: 0, noUsage: true }
    }
    if (!price) {
      // openSpendCap refuses to start without both prices, so this is a defect, not a configuration.
      log('spend.price_missing', { runId, engine, model })
      return { ...base, tokens: { ...NO_TOKENS }, costUsd: 0, noUsage: true }
    }
    const priced = codex ? priceCodex(codex, price, prices.codexTokenSemantics) : priceClaude(claude!, price)
    return { ...base, tokens: priced.tokens, costUsd: priced.costUsd }
  }

  const send = async (text: string, fields: Record<string, unknown>): Promise<void> => {
    const channel = settings.alertChannel
    if (!channel) {
      log('spend.alert_skipped', { ...fields, reason: 'no alert channel (SPEND_ALERT_CHANNEL and SLACK_CHANNEL_IDS are empty)' })
      return
    }
    try {
      await postChannelMessage(channel, text)
      log('spend.alert_sent', { ...fields, channel })
    } catch (error) {
      // Never retried: the threshold is already persisted as alerted (spec section 8).
      log('spend.alert_failed', { ...fields, channel, error: String(error) })
    }
  }

  /** Spec section 8 and ruling 5. Every decision is journaled before anything is posted. */
  const announce = async (nowMs: number): Promise<void> => {
    const state = ledger.state(nowMs)
    const percent = spendPercent(state, settings.capUsd)
    const due = settings.alertPercents.filter(p => p <= percent && !state.alerted.includes(p))
    for (const threshold of due) ledger.recordAlert(threshold, nowMs)
    if (percent >= 100) {
      // Announced only for a cap at or above the configured one, so raising the cap re-arms the message.
      if (state.capAnnouncedFor !== undefined && state.capAnnouncedFor >= settings.capUsd) return
      ledger.recordCapAnnounced(settings.capUsd, nowMs)
      await send(renderCapReachedAlert(nextMonthStart(nowMs)), { kind: 'cap', percent })
      return
    }
    if (!due.length) return
    const highest = due[due.length - 1]
    await send(renderThresholdAlert(percent, settings.herePercents.includes(highest)), { kind: 'threshold', threshold: highest, percent })
  }

  return {
    active: true,
    capped: nowMs => spendPercent(ledger.state(nowMs), settings.capUsd) >= 100,
    async record(usage, runId, nowMs) {
      try {
        const at = new Date(nowMs).toISOString()
        // Ruling 2: a usage with no engines list is the launchd single-mode runner's: one Codex run.
        const runs = usage.engines ?? [{ engine: 'codex' as const, usage }]
        ledger.recordRuns(runs.map(run => entryFor(run.engine, run.usage, runId, at)), nowMs)
        await announce(nowMs)
      } catch (error) {
        log('spend.record_failed', { runId, error: String(error) })
      }
    },
    status: nowMs => ({
      active: true,
      percent: spendPercent(ledger.state(nowMs), settings.capUsd),
      resetsAt: nextMonthStart(nowMs),
    }),
  }
}

/**
 * The daemon's spend cap. Inactive under subscription auth. When active, the price table must parse and
 * price both configured models (ruling 4), or this throws and the daemon stops before connecting to Slack.
 */
export function openSpendCap(
  config: SpendCapConfig,
  log: Log,
  postChannelMessage: PostChannelMessage,
  nowMs: number = Date.now()
): SpendCap {
  if (!spendCapActive(config)) {
    log('spend.cap_inactive', { reason: 'subscription auth' })
    return inactiveSpendCap()
  }
  const prices = loadPriceTable(config.bedrockPricesFile, [config.codexBedrockModel, config.claudeBedrockModel])
  const ledger = openSpendLedger(config.spendDir, log, nowMs)
  const settings: SpendCapSettings = {
    capUsd: config.spendCapUsd,
    alertPercents: config.spendAlertPercents,
    herePercents: config.spendAlertHerePercents,
    alertChannel: config.spendAlertChannel,
  }
  log('spend.cap_active', {
    pricesFile: config.bedrockPricesFile,
    priceSource: prices.source,
    spendDir: config.spendDir,
    percent: spendPercent(ledger.state(nowMs), settings.capUsd),
    alertChannel: settings.alertChannel || 'none',
  })
  return createSpendCap({
    ledger,
    prices,
    models: { codex: config.codexBedrockModel, claude: config.claudeBedrockModel },
    settings,
    postChannelMessage,
    log,
  })
}
```

- [ ] **Step 8: Run the cap tests to verify they pass**

Run: `npx ts-node --compiler-options '{"module":"commonjs"}' --transpile-only src/spend-cap.test.ts`
Expected: PASS.

- [ ] **Step 9: Write the failing status tests**

Append to `src/status.test.ts`:

```ts
// Ruling 16: the spend line is the spec text verbatim, right after the *Tokens* line, and only when the
// daemon passes a spend status. Regression caught: the line missing from the reply, or drifting away
// from the token figures it relates to.
test('renderStatus shows the spend line after the token line', t => {
  const stats = createStats(0)
  stats.record('pass', 1, 5 * MINUTE, 200_000)
  const snapshot = stats.snapshot(15 * MINUTE, 0, 0, config)
  const text = renderStatus(snapshot, undefined, undefined, undefined, { active: true, percent: 41, resetsAt: Date.UTC(2026, 11, 1) })
  const lines = text.split('\n')
  const tokens = lines.findIndex(l => l.startsWith('*Tokens*'))
  t.equal(lines[tokens + 1], 'Bedrock spend this month: 41% of cap · resets Nov 30, 7:00 PM ET')
  t.notOk(renderStatus(snapshot).includes('Bedrock spend'), 'no spend status, no line (the CLI and the older tests)')
  t.ok(
    renderStatus(createStats(0).snapshot(MINUTE, 0, 0, config), undefined, undefined, undefined, { active: false }).includes(
      'Bedrock spend cap: not active (subscription auth)'
    ),
    'shown even before there is a token line'
  )
  t.end()
})

// Spec 1: a whole status reply with the spend line and no Claude usage carries no dollar amount.
// (Claude's notional figures are a separate, pre-existing display: ruling 13.)
test('a status reply with the spend line shows no dollar amount', t => {
  const stats = createStats(0)
  stats.record('pass', 1, 5 * MINUTE, 200_000)
  const text = renderStatus(stats.snapshot(15 * MINUTE, 0, 0, config), undefined, undefined, undefined, {
    active: true,
    percent: 100,
    resetsAt: Date.UTC(2026, 11, 1),
  })
  t.notOk(/\$\s*\d/.test(text), text)
  t.end()
})
```

- [ ] **Step 10: Run the status tests to verify they fail**

Run: `npx ts-node --compiler-options '{"module":"commonjs"}' --transpile-only src/status.test.ts`
Expected: FAIL on `renderStatus shows the spend line after the token line` (no spend line is rendered yet).

- [ ] **Step 11: Render the spend line**

In `src/status.ts`, replace:

```ts
import { formatTokensCompact, type RunUsage } from './usage'
```

with:

```ts
import { renderSpendStatusLine, type SpendStatus } from './spend-messages'
import { formatTokensCompact, type RunUsage } from './usage'
```

In the same file, replace:

```ts
  connection?: ConnectionState,
  activity?: ActivitySnapshot
): string {
```

with:

```ts
  connection?: ConnectionState,
  activity?: ActivitySnapshot,
  spend?: SpendStatus
): string {
```

In the same file, replace:

```ts
    lines.push(`*Tokens* ${formatTokensCompact(tokens.total)} total${last} · ${formatTokensCompact(avg)} avg${engineTotals(snapshot.engineTokens)}`)
  }
```

with:

```ts
    lines.push(`*Tokens* ${formatTokensCompact(tokens.total)} total${last} · ${formatTokensCompact(avg)} avg${engineTotals(snapshot.engineTokens)}`)
  }
  // Right after the token figures it relates to (ruling 16). Percent only, never dollars (spec section 1).
  if (spend) lines.push(renderSpendStatusLine(spend))
```

- [ ] **Step 12: Run the tests to verify they pass**

Run: `for f in src/spend-messages.test.ts src/spend-cap.test.ts src/status.test.ts; do npx ts-node --compiler-options '{"module":"commonjs"}' --transpile-only "$f" 2>&1 | tail -2; done`
Expected: each ends with `# ok`.

Run: `npm test 2>&1 | tail -4 && npm run typecheck`
Expected: `# ok`, then `tsc` exits 0.

- [ ] **Step 13: Commit**

Write `/tmp/srb-commit-msg.txt` with the editor tool:

```text
feat(spend): price engine runs against the monthly cap and alert on thresholds (refs andrew-barnett/slack-review-bot#76)

Each settled request's engine runs are priced into the ledger, and the
first crossing of each alert threshold, or of the cap itself, posts one
message to the alert channel. Status gains the spend line. Every
user-facing string shows percentages only.

[cc](https://claude.com/claude-code)
```

Run: `git add src/spend-messages.ts src/spend-messages.test.ts src/spend-cap.ts src/spend-cap.test.ts src/status.ts src/status.test.ts && git commit -F /tmp/srb-commit-msg.txt`

---

### Task 7: Refuse at admission and at the slot, record usage, and post alerts (`src/slack.ts`, `src/spend-gate.ts`, `src/daemon.ts`)

**Files:**
- Create: `src/spend-gate.ts`
- Modify: `src/slack.ts`, `src/daemon.ts`, `src/job.ts` (record usage on the shutdown returns)
- Test: `src/spend-gate.test.ts` (create), `src/slack.test.ts` (append), `src/job.test.ts` (modify one assertion, add one test)

**Interfaces:**
- Consumes: Task 6 `SpendCap`, `openSpendCap`, `renderCapRefusal`; Task 4 `nextMonthStart`; `runIdFor` (src/review.ts); `TaskQueue` (src/queue.ts).
- Produces:
  - src/slack.ts: `makeSlackEffects(client)` also returns `postChannelMessage(channel: string, text: string): Promise<void>`.
  - src/spend-gate.ts:
    - `interface RefusalEffects { addReaction; removeReaction; postThreadReply; log }`
    - `refuseAtAdmission(cap: Pick<SpendCap, 'capped'>, message: MessageRef, errorEmoji: string, effects: RefusalEffects, nowMs: number): Promise<boolean>` (true: refused and answered)
    - `refuseAtSlot(message: MessageRef, emoji: { error: string; queued: string }, effects: RefusalEffects, queued: Promise<boolean> | undefined, nowMs: number): Promise<void>`
    - `capCheckedTask<T>(opts: { cap: Pick<SpendCap, 'capped'>; now: () => number; refuse: () => Promise<T>; run: () => Promise<T> }): () => Promise<T>`
  - Log events: `review.refused.cap` (`at: 'admission' | 'slot'`), `reaction.cap.failed`, `thread.cap.failed`, `reaction.cap.queued.remove.failed`.

- [ ] **Step 1: Write the failing tests**

Create `src/spend-gate.test.ts`:

```ts
import * as fs from 'fs'
import * as path from 'path'
import test from 'tape'
import type { MessageRef } from './job'
import { TaskQueue } from './queue'
import { capCheckedTask, refuseAtAdmission, refuseAtSlot, type RefusalEffects } from './spend-gate'
import { renderCapRefusal } from './spend-messages'

const NOW = Date.UTC(2026, 10, 20, 12)
const DEC_1 = Date.UTC(2026, 11, 1)
const message: MessageRef = { channel: 'C0REVIEWS', ts: '1763640000.000100' }

/** Recording Slack effects; with `fail`, every call throws after being recorded. */
function recorder(fail = false) {
  const calls: string[] = []
  const events: string[] = []
  const call = async (name: string): Promise<void> => {
    calls.push(name)
    if (fail) throw new Error('synthetic Slack failure')
  }
  const fx: RefusalEffects = {
    addReaction: (_message, name) => call(`add:${name}`),
    removeReaction: (_message, name) => call(`remove:${name}`),
    postThreadReply: (_message, text) => call(`reply:${text}`),
    log: event => void events.push(event),
  }
  return { fx, calls, events }
}

// Spec 9: under the cap a request is admitted untouched; at the cap it gets the error reaction and the
// refusal reply, and the caller is told it was refused. Regression caught: a refused request with no
// visible answer, which reads as the bot ignoring it.
test('refuseAtAdmission answers a request only when the cap is reached', async t => {
  const open = recorder()
  t.equal(await refuseAtAdmission({ capped: () => false }, message, 'x', open.fx, NOW), false)
  t.deepEqual(open.calls, [], 'no Slack calls under the cap')
  const shut = recorder()
  t.equal(await refuseAtAdmission({ capped: () => true }, message, 'x', shut.fx, NOW), true)
  t.deepEqual(shut.calls, ['add:x', `reply:${renderCapRefusal(DEC_1)}`])
  t.end()
})

// A Slack failure while refusing is logged and swallowed: the request is still refused and settled,
// never queued because the answer could not be posted.
test('refuseAtAdmission still refuses when Slack fails', async t => {
  const broken = recorder(true)
  t.equal(await refuseAtAdmission({ capped: () => true }, message, 'x', broken.fx, NOW), true)
  t.deepEqual(broken.events, ['reaction.cap.failed', 'thread.cap.failed'])
  t.end()
})

// Spec 9: a request refused at its slot drops its queued (hourglass) reaction, if it got one, before
// the error reaction and the reply. Regression caught: a stale hourglass left on a refused request.
test('refuseAtSlot clears the queued reaction it actually added', async t => {
  const queued = recorder()
  await refuseAtSlot(message, { error: 'x', queued: 'hourglass' }, queued.fx, Promise.resolve(true), NOW)
  t.deepEqual(queued.calls, ['remove:hourglass', 'add:x', `reply:${renderCapRefusal(DEC_1)}`])
  const notAdded = recorder()
  await refuseAtSlot(message, { error: 'x', queued: 'hourglass' }, notAdded.fx, Promise.resolve(false), NOW)
  t.deepEqual(notAdded.calls, ['add:x', `reply:${renderCapRefusal(DEC_1)}`], 'nothing to remove')
  const broken = recorder(true)
  await refuseAtSlot(message, { error: 'x', queued: 'hourglass' }, broken.fx, Promise.resolve(true), NOW)
  t.deepEqual(broken.events, ['reaction.cap.queued.remove.failed', 'reaction.cap.failed', 'thread.cap.failed'])
  t.end()
})

// Spec 9: the cap is checked when a queued request takes its slot, not only when it was admitted. With a
// real one-slot queue, a request admitted under the cap and waiting while the running review pushes spend
// over it is refused instead of run. Regression caught: checking only at admission.
test('capCheckedTask refuses a queued request when the cap is reached while it waits', async t => {
  const queue = new TaskQueue(1)
  let capped = false
  const cap = { capped: () => capped }
  const gate: { release?: (outcome: string) => void } = {}
  let secondRan = false
  const first = queue.run(
    capCheckedTask<string>({
      cap,
      now: () => NOW,
      refuse: async () => 'refused',
      run: () => new Promise<string>(resolve => (gate.release = resolve)),
    })
  )
  const second = queue.run(
    capCheckedTask<string>({
      cap,
      now: () => NOW,
      refuse: async () => 'refused',
      run: async () => {
        secondRan = true
        return 'ran'
      },
    })
  )
  while (!gate.release) await new Promise(resolve => setImmediate(resolve))
  capped = true
  gate.release('ran')
  t.deepEqual(await Promise.all([first, second]), ['ran', 'refused'])
  t.notOk(secondRan, 'the second review never started')
  t.end()
})

// daemon.ts has no unit tests (it needs a live Socket Mode connection), so its wiring is pinned by
// source order. Regressions caught: the cap check placed before the status and help branches (a capped
// bot could not say why); placed after cursors.begin (a refused request would stay unsettled and replay);
// the slot check missing; usage not recorded; the cap opened after Slack connects.
test('daemon.ts wires the cap at admission, at the slot, into usage, status and startup', t => {
  const source = fs.readFileSync(path.join(__dirname, 'daemon.ts'), 'utf8')
  const admission = source.indexOf('await refuseAtAdmission(')
  t.ok(admission > 0, 'admission check present')
  t.ok(admission > source.indexOf('isStatusRequest(event'), 'status is answered first')
  t.ok(admission > source.indexOf('isHelpRequest(event'), 'help is answered first')
  t.ok(admission > source.lastIndexOf('markHandled(key)'), 'after the duplicate guard')
  t.ok(admission < source.lastIndexOf('cursors.begin('), 'before the cursor holds the message for replay')
  const slot = source.indexOf('capCheckedTask<JobOutcome>(')
  t.ok(slot > 0 && slot < source.indexOf('return runJob('), 'the slot check wraps runJob')
  t.ok(source.includes('void spend.record(u, runIdFor(request), Date.now())'), 'usage is recorded')
  t.ok(source.includes('spend.status(Date.now())'), 'status shows the spend line')
  const opened = source.indexOf('openSpendCap(')
  t.ok(opened > 0 && opened < source.indexOf('await app.start()'), 'opened before connecting to Slack')
  t.end()
})
```

Append to `src/slack.test.ts`:

```ts
// --- postChannelMessage: the spend alerts' channel post. ---

// Spec 8: alerts are top-level channel messages (not thread replies), with no link unfurls.
// Regression caught: an alert posted into a thread, or a link unfurled into a wall of preview.
test('postChannelMessage posts a top-level message to the channel', async t => {
  const calls: Array<Record<string, unknown>> = []
  const client = {
    chat: {
      async postMessage(args: Record<string, unknown>) {
        calls.push(args)
        return { ok: true }
      },
    },
  } as unknown as WebClient
  await makeSlackEffects(client).postChannelMessage('C0ALERTS1', 'synthetic alert')
  t.deepEqual(calls, [{ channel: 'C0ALERTS1', text: 'synthetic alert', unfurl_links: false, unfurl_media: false }])
  t.end()
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx ts-node --compiler-options '{"module":"commonjs"}' --transpile-only src/spend-gate.test.ts`
Expected: FAIL with `Cannot find module './spend-gate'`.

Run: `npx ts-node --compiler-options '{"module":"commonjs"}' --transpile-only src/slack.test.ts`
Expected: FAIL on the new test (`postChannelMessage is not a function`).

- [ ] **Step 3: Add the channel post**

In `src/slack.ts`, replace:

```ts
export function makeSlackEffects(
  client: WebClient
): Pick<JobDeps, 'addReaction' | 'removeReaction' | 'postThreadReply' | 'messageExists'> {
  return {
```

with:

```ts
export function makeSlackEffects(
  client: WebClient
): Pick<JobDeps, 'addReaction' | 'removeReaction' | 'postThreadReply' | 'messageExists'> & {
  /** A top-level message in a channel: the spend alerts (spec section 8). */
  postChannelMessage(channel: string, text: string): Promise<void>
} {
  return {
    async postChannelMessage(channel: string, text: string): Promise<void> {
      await client.chat.postMessage({ channel, text, unfurl_links: false, unfurl_media: false })
    },
```

- [ ] **Step 4: Write the gate**

Create `src/spend-gate.ts`:

```ts
// Where the spend cap refuses a review request (spec section 9): at admission, before the request is
// queued, and again when a queued request reaches its slot. A refused request gets the error reaction and
// a thread reply naming when reviews resume. Refusals are settled by the caller and never replayed.

import type { MessageRef } from './job'
import type { SpendCap } from './spend-cap'
import { nextMonthStart } from './spend-ledger'
import { renderCapRefusal } from './spend-messages'

export interface RefusalEffects {
  addReaction(message: MessageRef, name: string): Promise<void>
  removeReaction(message: MessageRef, name: string): Promise<void>
  postThreadReply(message: MessageRef, text: string): Promise<void>
  log: (event: string, fields: Record<string, unknown>) => void
}

/** React and reply. Each Slack failure is logged and swallowed: the request is refused either way. */
async function answer(message: MessageRef, errorEmoji: string, effects: RefusalEffects, nowMs: number): Promise<void> {
  try {
    await effects.addReaction(message, errorEmoji)
  } catch (error) {
    effects.log('reaction.cap.failed', { channel: message.channel, ts: message.ts, error: String(error) })
  }
  try {
    await effects.postThreadReply(message, renderCapRefusal(nextMonthStart(nowMs)))
  } catch (error) {
    effects.log('thread.cap.failed', { channel: message.channel, ts: message.ts, error: String(error) })
  }
}

/** At admission: when the cap is reached, answer the request and return true (the caller settles it). */
export async function refuseAtAdmission(
  cap: Pick<SpendCap, 'capped'>,
  message: MessageRef,
  errorEmoji: string,
  effects: RefusalEffects,
  nowMs: number
): Promise<boolean> {
  if (!cap.capped(nowMs)) return false
  await answer(message, errorEmoji, effects, nowMs)
  return true
}

/** At the slot: drop the queued reaction if it was added, then answer the request. */
export async function refuseAtSlot(
  message: MessageRef,
  emoji: { error: string; queued: string },
  effects: RefusalEffects,
  queued: Promise<boolean> | undefined,
  nowMs: number
): Promise<void> {
  // Awaited first, so the queued reaction's add has landed before it is removed (as runJob does).
  if (queued && (await queued)) {
    try {
      await effects.removeReaction(message, emoji.queued)
    } catch (error) {
      effects.log('reaction.cap.queued.remove.failed', { channel: message.channel, ts: message.ts, error: String(error) })
    }
  }
  await answer(message, emoji.error, effects, nowMs)
}

/** A queue task that checks the cap when it takes its slot: refused if reached, else run. */
export function capCheckedTask<T>(opts: {
  cap: Pick<SpendCap, 'capped'>
  now: () => number
  refuse: () => Promise<T>
  run: () => Promise<T>
}): () => Promise<T> {
  return () => (opts.cap.capped(opts.now()) ? opts.refuse() : opts.run())
}
```

- [ ] **Step 5: Wire the daemon**

In `src/daemon.ts`, replace:

```ts
import { runJob, type JobDeps } from './job'
```

with:

```ts
import { runJob, type JobDeps, type JobOutcome } from './job'
```

In the same file, replace:

```ts
import { selectReviewRunner } from './review'
```

with:

```ts
import { runIdFor, selectReviewRunner } from './review'
```

In the same file, replace:

```ts
import { createStats, renderStatus } from './status'
```

with:

```ts
import { openSpendCap } from './spend-cap'
import { capCheckedTask, refuseAtAdmission, refuseAtSlot } from './spend-gate'
import { createStats, renderStatus } from './status'
```

In the same file, replace:

```ts
  const slackClient = new WebClient(config.botToken, slackClientOptions(config.slackRequestTimeoutMs))
```

with:

```ts
  const slackClient = new WebClient(config.botToken, slackClientOptions(config.slackRequestTimeoutMs))

  // The monthly Bedrock spend cap (spec section 3). Opened before connecting, so a missing or incomplete
  // price table stops the daemon here with the file and the model named, before any review can start.
  const spend = openSpendCap(config, log, (channel, text) => makeSlackEffects(slackClient).postChannelMessage(channel, text))
```

In the same file, replace:

```ts
          connection,
          reviews.snapshot(Date.now())
        )
```

with:

```ts
          connection,
          reviews.snapshot(Date.now()),
          spend.status(Date.now())
        )
```

In the same file, replace:

```ts
    markHandled(key)
    // Held below this message until the job settles, so a restart mid-review replays it
```

with:

```ts
    markHandled(key)
    // The monthly spend cap has been reached: answer and settle the request now, never queue or replay
    // it (spec section 9). Status and help are answered above, so they keep working while capped.
    if (await refuseAtAdmission(spend, request.message, config.errorEmoji, { ...makeSlackEffects(client), log }, Date.now())) {
      cursors.record(request.message.channel, request.message.ts)
      log('review.refused.cap', { key, source, at: 'admission' })
      return false
    }
    // Held below this message until the job settles, so a restart mid-review replays it
```

In the same file, replace:

```ts
      recordUsage: u => {
        usage = u
      },
```

with:

```ts
      recordUsage: u => {
        usage = u
        // Priced into the month's ledger; alerts go out from there. Never throws, never awaited.
        void spend.record(u, runIdFor(request), Date.now())
      },
```

In the same file, replace:

```ts
    const settled = queue
      .run(() => {
        // The slot is taken: promote from waiting to active in the live status. Done here, not
        // inside the job, so the status shows it running the instant it starts — before the
        // deleted-message check and the first Codex output.
        reviews.start(key, reviewAttempts)
        return runJob(
          request,
          {
            ack: config.ackEmoji,
            queued: config.queuedEmoji,
            pass: config.passEmoji,
            findings: config.findingsEmoji,
            error: config.errorEmoji,
            humanReview: config.humanReviewEmoji,
            approvalPartial: config.approvalPartialEmoji,
            approvalNotCounted: config.approvalNotCountedEmoji,
            headMoved: config.headMovedEmoji,
            removeAckOnComplete: config.removeAckOnComplete,
          },
          deps,
          { queued: queuedReaction, postUsage: config.usageReplyEnabled }
        )
      })
```

with:

```ts
    const settled = queue
      .run(
        capCheckedTask<JobOutcome>({
          cap: spend,
          now: Date.now,
          // The cap was reached while this request waited: answer it and settle it as skipped (ruling 12).
          refuse: async () => {
            log('review.refused.cap', { key, source, at: 'slot' })
            await refuseAtSlot(
              request.message,
              { error: config.errorEmoji, queued: config.queuedEmoji },
              { ...makeSlackEffects(client), log },
              queuedReaction,
              Date.now()
            )
            return 'skipped'
          },
          run: () => {
            // The slot is taken: promote from waiting to active in the live status. Done here, not
            // inside the job, so the status shows it running the instant it starts — before the
            // deleted-message check and the first Codex output.
            reviews.start(key, reviewAttempts)
            return runJob(
              request,
              {
                ack: config.ackEmoji,
                queued: config.queuedEmoji,
                pass: config.passEmoji,
                findings: config.findingsEmoji,
                error: config.errorEmoji,
                humanReview: config.humanReviewEmoji,
                approvalPartial: config.approvalPartialEmoji,
                approvalNotCounted: config.approvalNotCountedEmoji,
                headMoved: config.headMovedEmoji,
                removeAckOnComplete: config.removeAckOnComplete,
              },
              deps,
              { queued: queuedReaction, postUsage: config.usageReplyEnabled }
            )
          },
        })
      )
```

- [ ] **Step 5b: Record usage on the shutdown returns too**

`runJob` (src/job.ts) returns early on both shutdown paths, before `reportUsage` calls `deps.recordUsage`. If a deploy reaches its drain deadline, usage the runner already salvaged (completed Codex turns, Claude's figures) would never reach the ledger, and the replay would spend again against an unchanged total. Record the usage on those paths, still posting nothing and leaving the cursor unsettled.

In `src/job.ts`, replace:

```ts
    if (deps.isShuttingDown?.()) {
      deps.log('review.aborted.shutdown', { prs: reviewUrls })
      return 'skipped'
    }
    deps.log('review.failed', { prs: reviewUrls, error: String(error) })
```

with:

```ts
    if (deps.isShuttingDown?.()) {
      deps.log('review.aborted.shutdown', { prs: reviewUrls })
      // Spend already happened: record it (the ledger must see it before the replay spends again),
      // but post nothing, so the replay's own thread is the only one.
      deps.recordUsage?.(usageForError(error))
      return 'skipped'
    }
    deps.log('review.failed', { prs: reviewUrls, error: String(error) })
```

In `src/job.ts`, replace:

```ts
    if (deps.isShuttingDown?.()) {
      deps.log('review.aborted.shutdown', { prs: reviewUrls })
      return 'skipped'
    }
    return finishDual(request, emoji, deps, options, outcome.dual, outcome.usage, gatedAny)
```

with:

```ts
    if (deps.isShuttingDown?.()) {
      deps.log('review.aborted.shutdown', { prs: reviewUrls })
      // As in the catch above: record the spend, post nothing.
      deps.recordUsage?.(outcome.usage)
      return 'skipped'
    }
    return finishDual(request, emoji, deps, options, outcome.dual, outcome.usage, gatedAny)
```

In `src/job.test.ts`, at the end of the test `runJob stays silent when a dual outcome arrives during a shutdown`, replace:

```ts
  t.deepEqual(rec.threads, [], 'no thread is posted')
  t.deepEqual(usages, [], 'no usage is reported')
  t.end()
})
```

with:

```ts
  t.deepEqual(rec.threads, [], 'no thread is posted')
  // The spend already happened, so the ledger records it; only the Slack effects are suppressed.
  t.equal(usages.length, 1, 'usage is recorded for the ledger')
  t.end()
})

// PR review finding (andrew-barnett/slack-review-bot#78), throw path: a run force-killed by shutdown
// still reports what it salvaged to recordUsage, so a replay is not spent against an unchanged ledger.
// Regression caught: returning before reportUsage, which dropped completed-turn usage on every deploy.
test('runJob records salvaged usage when a shutdown kills the run, and posts nothing', async t => {
  const usages: RunUsage[] = []
  const salvaged: RunUsage = { attempts: 1, tokensUsed: 1234 }
  const rec = recorder(
    async () => {
      throw new ReviewFailedError(salvaged, new Error('killed by shutdown'))
    },
    { isShuttingDown: () => true, recordUsage: u => { usages.push(u) } }
  )
  t.equal(await runJob(request, emoji, rec.deps), 'skipped')
  t.deepEqual(usages, [salvaged], 'the salvaged usage reaches the ledger')
  t.deepEqual(rec.threads, [], 'no thread is posted')
  t.deepEqual(rec.added, ['eyes'], 'no outcome reaction')
  t.end()
})
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `for f in src/spend-gate.test.ts src/slack.test.ts src/job.test.ts; do npx ts-node --compiler-options '{"module":"commonjs"}' --transpile-only "$f" 2>&1 | tail -2; done`
Expected: each ends with `# ok`.

Run: `npm test 2>&1 | tail -4 && npm run typecheck && npm run build`
Expected: `# ok`; `tsc` exits 0; the build exits 0.

- [ ] **Step 7: Commit**

Write `/tmp/srb-commit-msg.txt` with the editor tool:

```text
feat(spend): refuse new reviews once the monthly Bedrock cap is reached (refs andrew-barnett/slack-review-bot#76)

A request arriving at the cap gets the error reaction and a reply saying
when reviews resume, and is settled so it never replays. A queued request
is checked again when it reaches its slot. Every settled request's usage
is priced into the ledger, and status shows the month's percent.

[cc](https://claude.com/claude-code)
```

Run: `git add src/slack.ts src/slack.test.ts src/spend-gate.ts src/spend-gate.test.ts src/daemon.ts src/job.ts src/job.test.ts && git commit -F /tmp/srb-commit-msg.txt`

---

### Task 8: The real price table, shipped in the image (`pricing/bedrock-prices.json`, `Dockerfile`)

**This task needs a human, or a controller with web access.** Prices come from https://aws.amazon.com/bedrock/pricing/ only. If you cannot open that page, **stop and ask**. Do not fill any number from memory, from another region, or by estimate. Every other task's tests use synthetic prices and do not depend on this one.

**Files:**
- Create: `pricing/bedrock-prices.json`
- Modify: `Dockerfile`
- Test: `src/pricing-file.test.ts` (create)

**Interfaces:**
- Consumes: Task 3 `loadPriceTable`, `defaultPricesFile`; `loadReviewConfig` (src/config.ts) for the default model IDs (`us.openai.gpt-5.5`, `us.anthropic.claude-opus-5-5` at the time of writing).
- Produces: `pricing/bedrock-prices.json`, read at `/app/pricing/bedrock-prices.json` in the image.

- [ ] **Step 1: Write the failing test**

Create `src/pricing-file.test.ts`:

```ts
import * as fs from 'fs'
import * as path from 'path'
import test from 'tape'
import { loadReviewConfig } from './config'
import { defaultPricesFile, loadPriceTable } from './pricing'

// Ruling 4: the shipped table must price both default Bedrock models, or the container runtime refuses
// to start. Regression caught: a model default changed in config.ts without a price-table entry, found
// only when the orchestrator dies at startup. Also pins the source line format (URL, region, date).
test('the shipped price table prices both default Bedrock models and records its source', t => {
  const review = loadReviewConfig({ HOME: '/home/u' })
  const table = loadPriceTable(defaultPricesFile(), [review.codexBedrockModel, review.claudeBedrockModel])
  t.match(table.source, /^https:\/\/aws\.amazon\.com\/bedrock\/pricing\/ \(on-demand, us-east-2\), checked \d{4}-\d{2}-\d{2}$/)
  t.end()
})

// The orchestrator reads /app/pricing/bedrock-prices.json. Regression caught: the table in the repo but
// not in the image, so the container runtime fails at startup with "cannot read BEDROCK_PRICES_FILE".
test('the image ships the price table', t => {
  const dockerfile = fs.readFileSync(path.join(__dirname, '..', 'Dockerfile'), 'utf8')
  t.ok(/^COPY pricing \.\/pricing$/m.test(dockerfile))
  t.end()
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx ts-node --compiler-options '{"module":"commonjs"}' --transpile-only src/pricing-file.test.ts`
Expected: FAIL: `cannot read BEDROCK_PRICES_FILE …/pricing/bedrock-prices.json`, and `the image ships the price table` fails.

- [ ] **Step 3: Fill the price table from the AWS pricing page**

1. Open https://aws.amazon.com/bedrock/pricing/. Select **on-demand** pricing and the **US East (Ohio)** region (`us-east-2`). Write down today's date as `YYYY-MM-DD` (America/New_York).
2. Confirm the two model IDs the table must cover: run `grep -n "BEDROCK_MODEL ||" src/config.ts`. Expected: `us.openai.gpt-5.5` and `us.anthropic.claude-opus-5-5`. If they differ, use the IDs it prints as the keys below.
3. For the **OpenAI GPT-5.5** row (key `us.openai.gpt-5.5`), copy into USD per **million** tokens (the page may quote per 1,000 tokens; multiply by 1,000):
   - `input`: input token price.
   - `cachedInput`: cached input (cache read) price. If the page lists none, use the `input` price (the conservative choice) and say so in the PR.
   - `cacheWrite`: cache write price. If the page lists none, use `0` and say so in the PR.
   - `output`: output token price.
4. For the **Claude Opus 5.5** row (key `us.anthropic.claude-opus-5-5`), the same columns: `input`, `cachedInput` = cache read, `cacheWrite` = the **5-minute** cache write price, `output`.
5. `codexTokenSemantics`: keep both flags `false` (the conservative reading, spec section 5) unless Bedrock's or OpenAI's documentation states otherwise. If you set one to `true`, quote the documentation sentence and its URL in the PR.
6. The `us.` IDs are cross-region inference profiles. If the page prices the profile differently from the in-region model, use the profile's price and say so in the PR.

Create `pricing/bedrock-prices.json` with the editor tool, with exactly this shape and every number replaced by the page's value (the loader rejects a zero `input` or `output` and an undated `source`, so an unfilled table cannot pass Step 4):

```json
{
  "source": "https://aws.amazon.com/bedrock/pricing/ (on-demand, us-east-2), checked YYYY-MM-DD",
  "codexTokenSemantics": {
    "cachedIsSubsetOfInput": false,
    "reasoningInOutput": false
  },
  "models": {
    "us.openai.gpt-5.5": { "input": 0, "cachedInput": 0, "cacheWrite": 0, "output": 0 },
    "us.anthropic.claude-opus-5-5": { "input": 0, "cachedInput": 0, "cacheWrite": 0, "output": 0 }
  }
}
```

Verify every value against the page, one by one:

Run: `node -e "const t=require('./pricing/bedrock-prices.json');console.log(t.source);console.log(t.codexTokenSemantics);console.table(t.models)"`
Expected: the source line with today's date; both flags as decided in item 5; a two-row table whose eight numbers match the page exactly. No `0` in `input` or `output`; a `0` elsewhere only where item 3 or 4 said so.

- [ ] **Step 4: Ship the table in the image**

In `Dockerfile`, replace:

```dockerfile
COPY codex ./codex
COPY docker/entrypoint.sh /usr/local/bin/srb-entrypoint
```

with:

```dockerfile
COPY codex ./codex
COPY pricing ./pricing
COPY docker/entrypoint.sh /usr/local/bin/srb-entrypoint
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx ts-node --compiler-options '{"module":"commonjs"}' --transpile-only src/pricing-file.test.ts`
Expected: PASS.

Run: `npm test 2>&1 | tail -4 && npm run typecheck`
Expected: `# ok`, then `tsc` exits 0.

- [ ] **Step 6: Commit**

Write `/tmp/srb-commit-msg.txt` with the editor tool, replacing `<the source line>` with the `source` value from the file (the PR quotes it too, spec section 11 step 2):

```text
feat(pricing): add the Bedrock on-demand price table (refs andrew-barnett/slack-review-bot#76)

Prices for both configured models, in USD per million tokens, copied from
the AWS Bedrock pricing page. Source: <the source line>. The image ships
the table at /app/pricing/bedrock-prices.json.

[cc](https://claude.com/claude-code)
```

Run: `git add pricing/bedrock-prices.json Dockerfile src/pricing-file.test.ts && git commit -F /tmp/srb-commit-msg.txt`

---

### Task 9: Smoke check, README and the refresh skill

**Files:**
- Modify: `src/orchestrator.ts`, `src/orchestrator-main.ts`, `src/smoke.ts`, `README.md`, `.claude/skills/refresh-bot-runtime/SKILL.md`
- Test: `src/orchestrator.test.ts` (append)

**Interfaces:**
- Consumes: Task 6 `SpendCap`, `openSpendCap`; Task 2 `CodexRunOutcome.codexUsage`; Task 1 `scripts/smoke/stub-codex.js` usage events; Task 8 price table.
- Produces: `smokeJob(config: ReviewConfig, spend?: Pick<SpendCap, 'record'>)`; the compose smoke checks that a `spend-YYYY-MM.jsonl` journal gained the smoke's Codex `run` line.

- [ ] **Step 1: Write the failing test**

Append to `src/orchestrator.test.ts`:

```ts
// Spec 6/7: the smoke's one Codex run is recorded through the spend cap as one Codex engine run, under
// the smoke's runId and with the worker's usage, so the compose smoke can prove usage reaches the
// ledger. Regression caught: the smoke passing while --json usage is lost on the worker wire.
test('smokeJob records its Codex run with the spend cap', async t => {
  const { config } = orchestratorConfig(bundle, { HOME: '/home/bot' })
  const codexUsage = { inputTokens: 1200, cachedInputTokens: 200, cacheWriteTokens: 0, outputTokens: 300, reasoningTokens: 40 }
  const runners = {
    runCodex: async () => ({ result: { results: [] }, rawFinalMessage: '', activeMs: 5, tokensUsed: 1740, codexUsage }),
    runClaude: async () => {
      throw new Error('not used')
    },
  }
  const recorded: Array<{ usage: RunUsage; runId: string }> = []
  const spend = { record: async (usage: RunUsage, runId: string) => void recorded.push({ usage, runId }) }
  const reply = await smokeJob(config, spend)(runners as never)()
  t.equal(recorded.length, 1)
  t.equal(recorded[0].runId, reply.runId)
  t.deepEqual(recorded[0].usage.engines?.map(e => [e.engine, e.usage.codex]), [['codex', codexUsage]])
  t.end()
})
```

In `src/orchestrator.test.ts`, also replace:

```ts
import { orchestratorConfig, smokeJob } from './orchestrator'
```

with:

```ts
import { orchestratorConfig, smokeJob } from './orchestrator'
import type { RunUsage } from './usage'
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx ts-node --compiler-options '{"module":"commonjs"}' --transpile-only src/orchestrator.test.ts`
Expected: FAIL on the new test (`recorded.length` is 0).

- [ ] **Step 3: Record the smoke's run**

In `src/orchestrator.ts`, replace:

```ts
import type { RemoteRunners } from './jobs/remote'
import { LAUNCH_KEY_BYTES } from './jobs/ticket'
```

with:

```ts
import type { RemoteRunners } from './jobs/remote'
import { LAUNCH_KEY_BYTES } from './jobs/ticket'
import type { SpendCap } from './spend-cap'
```

In the same file, replace:

```ts
export function smokeJob(config: ReviewConfig): (runners: RemoteRunners) => () => Promise<SmokeReply> {
```

with:

```ts
export function smokeJob(config: ReviewConfig, spend?: Pick<SpendCap, 'record'>): (runners: RemoteRunners) => () => Promise<SmokeReply> {
```

In the same file, replace:

```ts
      onProgress: line => void lines.push(line),
    })
    return { runId, results: outcome.result.results, lines }
```

with:

```ts
      onProgress: line => void lines.push(line),
    })
    // Recorded like a review's engine run, so the compose smoke proves Codex usage reaches the spend journal.
    await spend?.record(
      {
        attempts: 1,
        engines: [
          {
            engine: 'codex',
            usage: {
              attempts: 1,
              activeMs: outcome.activeMs,
              ...(outcome.tokensUsed !== undefined ? { tokensUsed: outcome.tokensUsed } : {}),
              ...(outcome.codexUsage ? { codex: outcome.codexUsage } : {}),
            },
          },
        ],
      },
      runId,
      Date.now()
    )
    return { runId, results: outcome.result.results, lines }
```

In `src/orchestrator-main.ts`, replace:

```ts
import { orchestratorConfig, smokeJob } from './orchestrator'
```

with:

```ts
import { orchestratorConfig, smokeJob } from './orchestrator'
import { openSpendCap } from './spend-cap'
```

In the same file, replace:

```ts
    const smoke = await startContainerRuntime(config, launchKey, log, { smoke: smokeJob(config) })
```

with:

```ts
    // The real price table and ledger (on the smoke's own state volume); alerts are only logged, since
    // the smoke has no Slack connection.
    const spend = openSpendCap(config, log, async (channel, text) => log('smoke.alert', { channel, chars: text.length }))
    const smoke = await startContainerRuntime(config, launchKey, log, { smoke: smokeJob(config, spend) })
```

In `src/smoke.ts`, replace:

```ts
    if (!log.includes('stub-codex: reviewing')) throw new Error('the run log was not shipped to the orchestrator')
```

with:

```ts
    if (!log.includes('stub-codex: reviewing')) throw new Error('the run log was not shipped to the orchestrator')
    // Spec 6/7: the stub's --json usage crossed the worker wire and was priced into the month's journal.
    // Every spend-YYYY-MM.jsonl is read, so a smoke that straddles 00:00 UTC on the 1st still finds it.
    const journal = inOrchestrator(
      "const fs = require('fs'); const dir = '/var/lib/slack-review-bot/state'; " +
        "for (const name of fs.readdirSync(dir).filter(n => /^spend-\\d{4}-\\d{2}\\.jsonl$/.test(n))) process.stdout.write(fs.readFileSync(dir + '/' + name, 'utf8'))"
    )
    const runLine = journal
      .split('\n')
      .filter(line => line.trim() !== '')
      .map(line => JSON.parse(line) as { type?: string; runId?: string; engine?: string; noUsage?: boolean; tokens?: { input?: number } })
      .find(line => line.type === 'run' && line.runId === reply.runId)
    if (!runLine || runLine.engine !== 'codex' || runLine.noUsage || !(Number(runLine.tokens?.input) > 0)) {
      throw new Error(`the smoke's Codex usage never reached the spend journal: ${JSON.stringify(runLine)}`)
    }
```

In the same file, replace:

```ts
    process.stdout.write('compose smoke passed: result, status lines and run log all arrived\n')
```

with:

```ts
    process.stdout.write('compose smoke passed: result, status lines, run log and spend ledger entry all arrived\n')
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx ts-node --compiler-options '{"module":"commonjs"}' --transpile-only src/orchestrator.test.ts`
Expected: PASS.

Run: `npm test 2>&1 | tail -4 && npm run typecheck && npm run build`
Expected: `# ok`; `tsc` exits 0; the build exits 0.

The compose smoke itself (`scripts/compose-smoke.sh`) needs Docker. Run it if Docker is available to you: `scripts/compose-smoke.sh`. Expected: ends with `compose smoke passed: result, status lines, run log and spend ledger entry all arrived`. If Docker is not available, say so in the PR; the operator runs it before merge.

- [ ] **Step 5: Document the settings and the cap**

In `README.md`, replace:

```markdown
| `CODEX_BEDROCK_CONTEXT_WINDOW` | *(none)* | Bedrock mode, optional: a positive integer passed to Codex as `model_context_window`, overriding the fallback metadata Codex uses for Bedrock model IDs. |
```

with:

```markdown
| `CODEX_BEDROCK_CONTEXT_WINDOW` | *(none)* | Bedrock mode, optional: a positive integer passed to Codex as `model_context_window`, overriding the fallback metadata Codex uses for Bedrock model IDs. |
| `BEDROCK_MONTHLY_CAP_USD` | `1000` | The bot's monthly Bedrock spend cap in US dollars (a positive number). Applies under `ENGINE_AUTH=bedrock` and always in the container runtime. See [Bedrock spend cap](#bedrock-spend-cap). Never shown in Slack. |
| `SPEND_ALERT_PERCENTS` | `25,50,75,90` | Percentages of the cap that post a one-time alert in the alert channel each month. Integers 1-99, strictly ascending. |
| `SPEND_ALERT_HERE_PERCENTS` | `75,90` | Which of those alerts carry `@here`. Each must be in `SPEND_ALERT_PERCENTS`; unset means whichever of 75 and 90 are; empty means none. The cap-reached alert always carries `@here`. |
| `SPEND_ALERT_CHANNEL` | first `SLACK_CHANNEL_IDS` entry | The channel ID (`C…`) the spend alerts go to. With no channel at all, alerts are only logged (`spend.alert_skipped`). |
| `BEDROCK_PRICES_FILE` | `pricing/bedrock-prices.json` in the repo (`/app/pricing/bedrock-prices.json` in the image) | The on-demand price table spend is computed from. Must price `CODEX_BEDROCK_MODEL` and `CLAUDE_BEDROCK_MODEL`, or the daemon will not start. |
```

In the same file, replace:

```markdown
`:assumed-role/<role name>/`. In static mode the ARN is reported. The credentials are never
printed.

## Container runtime (`RUNTIME=container`)
```

with:

```markdown
`:assumed-role/<role name>/`. In static mode the ARN is reported. The credentials are never
printed.

### Bedrock spend cap

When the bot runs on Bedrock (`ENGINE_AUTH=bedrock`, and always in the container runtime) it
keeps a month-to-date total of what its own reviews cost and stops starting new reviews at
`BEDROCK_MONTHLY_CAP_USD`. Under subscription auth the cap is off, and `status` says
`Bedrock spend cap: not active (subscription auth)`.

- **What counts.** Every engine run of every review, failures included, priced from its token
  counts at the on-demand prices in `BEDROCK_PRICES_FILE`. Claude's own `$… notional` figure is
  not used. Months are UTC calendar months. `npm run review` (the CLI) is not counted.
- **Alerts.** The first time spend crosses each `SPEND_ALERT_PERCENTS` threshold in a month, one
  message goes to `SPEND_ALERT_CHANNEL`, for example `<!here> This bot has used 76% of its monthly
  Bedrock spend cap. New reviews stop at 100%.` Reaching the cap posts `<!here> This bot has reached
  its monthly Bedrock spend cap. New review requests will be declined until Nov 30 at 7:00 PM ET.`
  A failed post is logged (`spend.alert_failed`) and not retried. Slack text never shows a dollar
  amount.
- **At the cap.** Reviews already running finish. A new request gets the error reaction and a
  thread reply saying when reviews resume; a request already queued gets the same answer when it
  reaches its slot. Refused requests are not replayed. `status` and `help` keep working, and
  `status` shows `Bedrock spend this month: cap reached · resets …`.
- **Raising the cap.** Set a higher `BEDROCK_MONTHLY_CAP_USD` and restart. Reviews resume at once.
- **The ledger.** One append-only file per UTC month, `spend-YYYY-MM.jsonl`, beside the cursor
  file: `~/.local/state/slack-review-bot/spend-2026-11.jsonl` under launchd,
  `/var/lib/slack-review-bot/state/spend-2026-11.jsonl` (the `orchestrator-state` volume) in the
  container runtime. Each line is one JSON record: a priced engine run (`"type":"run"`), a threshold
  alert (`"type":"alert"`) or the cap-reached message (`"type":"cap"`, with the cap it was sent for).
  The bot never rewrites, renames or deletes these files; a new month is a new file, and old months
  stay for auditing.
- **Unreadable ledger.** If a line in this month's file does not parse or has an unknown shape,
  including a last line with no newline (a crash mid-write), the bot logs `spend.unreadable` with
  the file and the line number and treats the month as capped, so a lost record never reopens
  spending. Raising the cap does not clear this. To recover, stop the bot
  (`scripts/install-launcher.sh --uninstall` for the container runtime, `scripts/install-service.sh
  --uninstall` for launchd), then fix the named line, or delete it (its spend is then not counted,
  so only delete a `run` line if you accept that), then reinstall with the same script without
  `--uninstall`. The next UTC month (a new file) also clears it.
- **Unwritable ledger.** If the state directory or this month's file cannot be written, the bot logs
  `spend.write_failed` and treats the month as capped until a write succeeds again
  (`spend.write_recovered`); it retries on every `status` and every request, so no restart is
  needed once the storage is fixed.
- **Prices.** `pricing/bedrock-prices.json` is maintained by the `refresh-bot-runtime` skill. A
  model with no entry stops the daemon at startup with the model and the file named. A per-install
  model override (`CODEX_BEDROCK_MODEL`, `CLAUDE_BEDROCK_MODEL`) needs its own entry in the table
  and, in the container runtime, an image rebuild.

## Container runtime (`RUNTIME=container`)
```

In the same file, replace:

```markdown
| `SHUTDOWN_DRAIN_MS` | `5000` | The orchestrator's drain deadline; the launcher's hard bound is this plus `SHUTDOWN_GRACE_MS` (10 s) plus 30 s. |
```

with:

```markdown
| `SHUTDOWN_DRAIN_MS` | `5000` | The orchestrator's drain deadline; the launcher's hard bound is this plus `SHUTDOWN_GRACE_MS` (10 s) plus 30 s. |
| `BEDROCK_MONTHLY_CAP_USD`, `SPEND_ALERT_PERCENTS`, `SPEND_ALERT_HERE_PERCENTS`, `SPEND_ALERT_CHANNEL`, `BEDROCK_PRICES_FILE` | as in [Configuration](#configuration) | The [Bedrock spend cap](#bedrock-spend-cap). The cap is always active in the container runtime. |
```

Before committing, confirm the launcher passes `launcher.conf` settings through to `docker compose` the same way it passes `SHUTDOWN_DRAIN_MS` (read `scripts/launcher`; the plan author could not). If it uses an explicit list rather than exporting the whole file, add the five spend names and `CODEX_BEDROCK_MODEL` / `CLAUDE_BEDROCK_MODEL` to that list in the same commit, and say so in the PR.

- [ ] **Step 6: Add the price-table step to the refresh skill**

In `.claude/skills/refresh-bot-runtime/SKILL.md`, replace:

```markdown
The container image is fixed at build time. Four things in it go stale and are refreshed here:
```

with:

```markdown
The container image is fixed at build time. Five things in it go stale and are refreshed here:
```

In the same file, replace:

```markdown
| Base image | `Dockerfile` `FROM node:22-bookworm-slim` (both stages) | the image |
```

with:

```markdown
| Base image | `Dockerfile` `FROM node:22-bookworm-slim` (both stages) | the image |
| Bedrock prices | `pricing/bedrock-prices.json` (USD per million tokens, keyed by model ID, with the source URL and date checked) | `src/pricing.ts` → the monthly spend cap (`src/spend-cap.ts`) |
```

In the same file, replace:

```markdown
## 3. CLI versions and base image
```

with:

```markdown
5. **Update the price table** whenever a model ID changes (a new default or a per-install override), and at least whenever this section runs. The daemon refuses to start in Bedrock mode if a configured model has no price.
   1. Open https://aws.amazon.com/bedrock/pricing/, on-demand, region US East (Ohio) (`us-east-2`). Prices come from that page only; if you cannot open it, stop and ask the user.
   2. In `pricing/bedrock-prices.json`, add or update the entry keyed by the exact model ID: `input`, `cachedInput` (cache read; the `input` price if none is listed), `cacheWrite` (the 5-minute write price; `0` if none is listed), `output`, all in USD per **million** tokens. Remove entries for models no longer configured anywhere.
   3. Set `source` to `https://aws.amazon.com/bedrock/pricing/ (on-demand, us-east-2), checked YYYY-MM-DD` with today's date.
   4. Keep `codexTokenSemantics` as it is unless Bedrock's or OpenAI's documentation now states how `cached_input_tokens` and `reasoning_output_tokens` relate to input and output; quote the sentence and URL in the PR if you change a flag.
   5. Check: `node -e "const t=require('./pricing/bedrock-prices.json');console.log(t.source);console.table(t.models)"` matches the page value for value, and `npx ts-node --compiler-options '{"module":"commonjs"}' --transpile-only src/pricing-file.test.ts` passes.
   6. A per-install override (`CODEX_BEDROCK_MODEL` / `CLAUDE_BEDROCK_MODEL` in `launcher.conf`) needs its entry in this table too, and the container runtime needs an image rebuild (section 4) before the override takes effect.
6. **Keep the AWS Budget in step with the cap.** Once the Budget backstop from the spend-cap spec (section 10) exists, its limit is 1.10 × `BEDROCK_MONTHLY_CAP_USD`. Whenever the cap changes, change the Budget limit in the same change set. Until section 10 ships there is no Budget to update; say so in the PR.

## 3. CLI versions and base image
```

- [ ] **Step 7: Verify the whole change**

Run: `npm test 2>&1 | tail -4 && npm run typecheck && npm run build`
Expected: `# ok`; `tsc` exits 0; the build exits 0.

Run: `git grep -nE '\$[0-9]' -- src/spend-messages.ts src/spend-gate.ts src/spend-cap.ts`
Expected: no output (no dollar literal in any user-facing spend source).

- [ ] **Step 8: Commit**

Write `/tmp/srb-commit-msg.txt` with the editor tool:

```text
feat(smoke): check the compose smoke's usage reaches the spend ledger (refs andrew-barnett/slack-review-bot#76)

The smoke's Codex run is recorded through the spend cap, and the smoke
reads the month's spend journal back for its run line. The README documents the cap, its
settings and how to recover from an unreadable ledger, and the
refresh-bot-runtime skill gains the price-table step.

[cc](https://claude.com/claude-code)
```

Run: `git add src/orchestrator.ts src/orchestrator-main.ts src/orchestrator.test.ts src/smoke.ts README.md .claude/skills/refresh-bot-runtime/SKILL.md && git commit -F /tmp/srb-commit-msg.txt`

(If Step 5's launcher check changed `scripts/launcher`, add it to the `git add` too.)

---

## Self-review

- **Spec coverage.** Section 3 (scope, active rule): ruling 1, Task 6 `spendCapActive`, Task 7 `openSpendCap` at startup. Section 4 (settings): Task 5, README in Task 9. Section 5 (price table): Task 3 loader, Task 8 table. Section 6 (usage capture): Tasks 1-2. Section 7 (ledger): Task 4, recording in Tasks 6-7. Section 8 (enforcement, messages, alerts): Tasks 6-7. Section 9 (status, refusal, recovery): Tasks 6, 7 and the README in Task 9. Section 11 step 4: Task 9 Step 6. Section 10: untouched.
- **No invented prices.** Every price in a test is synthetic and labelled so. The only real prices enter in Task 8 Step 3, from the AWS page, by a human or a controller with web access.
- **Type consistency.** `CodexUsageDetail` (Task 1) → `RunUsage.codex` (Task 2) → `priceCodex` (Task 3) → `createSpendCap` (Task 6) → daemon and smoke (Tasks 7, 9). `LedgerTokens` (Task 3) is the `SpendRun.tokens` type (Task 4). `SpendState` (Task 4) is what `spendPercent` and the cap's announce logic read (Task 6). `SpendStatus` (Task 6) is the fifth `renderStatus` argument. `postChannelMessage(channel, text)` has the same signature in `slack.ts` (Task 7) and `SpendCapDeps` (Task 6).
- **Order.** Each task's tests pass with only the earlier tasks applied. Tasks 5-7 run without the real price table: the cap opens only in `runDaemon` and the SMOKE path, which no unit test runs. Task 8 must land before the image is built for the container cutover (spec section 11 step 1).
