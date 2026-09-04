# `slack-review-bot` — PR review bot for Slack

Watches a Slack channel. When someone posts a message containing GitHub pull request
URLs, the bot runs the Codex `$review-pr` skill against them and reports back with
reactions and, when there is something to say, a thread.

```
message with PR URLs  ->  :hourglass_flowing_sand:  while another review holds the slot
                      ->  :eyes:                    once its own run starts
                          codex exec --profile review-bot  ($review-pr)
                            all passed  ->  :approved_stamp:
                            otherwise   ->  :comments:  + a thread listing each PR
```

The thread names which PRs had no findings and which did, with a one-sentence summary
for each PR that has findings.

A message posted while the bot was down is not lost: it records how far it has read in each
channel and catches up on the rest when it starts — see
[Catching up after downtime](#catching-up-after-downtime).

## Why it runs locally

The `/investigate` bot in `pulumi-production/lambda/slack-investigate-order` is the
house pattern for a Slack bot, and this one deliberately does not follow it. That bot's
worker is pure log analysis, so it fits in Lambda. `$review-pr` checks out git
worktrees, runs `gh`, installs dependencies, runs test suites and measures coverage — it
needs a real machine with the same `gh` and Codex credentials you use interactively.

So this is a LaunchAgent on the Mac, connected to Slack over **Socket Mode**: no public
endpoint, no API Gateway, no request-signature verification. The trade-off is that the
bot only reviews while the machine is awake and logged in — it reads a channel's history at
startup to make that a delay rather than a loss, but a closed laptop still reviews nothing.

## Architecture

| File | Role |
| --- | --- |
| `src/app.ts` | Daemon entry point. Bolt + Socket Mode, dedupe, queue. |
| `src/slack.ts` | Trigger rules (`decideTrigger`) and the Web API effects. |
| `src/parse-message.ts` | Slack markup -> PR list + leftover instructions. |
| `src/prompt.ts` | Builds the Codex prompt, including the unattended policy. |
| `src/schema.ts` | The JSON output contract and its validator. |
| `src/codex.ts` | Spawns `codex exec`, builds its env from an allowlist, enforces the timeout and the stall grace. |
| `src/deadline.ts` | The run timeout and the stall grace as budgets of *active* time — sleep is not charged. |
| `src/review.ts` | Ties a request to a Codex run and retries a stalled one with a longer grace. |
| `src/job.ts` | The react -> review -> react -> thread sequence, as a pure function. |
| `src/render.ts` | Slack mrkdwn for the thread. |
| `src/queue.ts` | FIFO with a concurrency limit (default 1). |
| `src/cursor.ts` | How far each channel has been processed, persisted across restarts. |
| `src/replay.ts` | Reads history back to the cursor and re-dispatches what was missed. |
| `src/catchup.ts` | When that happens: startup, reconnect, timer — serialised and coalesced. |
| `src/progress.ts` | Live registry of what is running and waiting, for the status reply. |
| `src/status.ts` | Per-process counters and the mrkdwn for a status reply. |
| `src/help.ts` | The mrkdwn for the help reply. |
| `src/command.ts` | Typo-tolerant matching of a mention's words to a command. |
| `src/gate.ts` | The human-review gate: which changes the bot must not review, and the notices it leaves. |
| `src/github.ts` | The `gh` calls the gate needs — list a PR's changed file names, post a PR comment. |
| `src/doctor.ts` | `npm run doctor` — the runtime preflight. |
| `src/cli.ts` | Run one review from the terminal, no Slack. |

`job.ts`, `render.ts`, `prompt.ts`, `parse-message.ts`, `schema.ts`, `queue.ts`, `cursor.ts`,
`replay.ts`, `progress.ts`, `help.ts`, `command.ts` and `gate.ts` are pure and unit-tested;
everything that touches Slack, GitHub, or spawns a process is injected.

### Trigger rules

A message starts a review when it is a top-level channel message, from a human who is not
on the ignore list, in an allowlisted channel, containing at least one
`github.com/<owner>/<repo>/pull/<n>` URL.

Two of those filters matter more than they look:

- **Bot messages are ignored.** The bot's own findings thread repeats every PR URL it
  just reviewed. Without this filter the bot reviews itself, forever.
- **Thread replies are ignored.** Discussion underneath a findings thread does not
  re-queue the same PRs.

Anything the bot cannot review to a verdict is reported, never silently dropped.

#### Ignoring your own messages

`SLACK_IGNORE_USER_IDS` lists Slack user IDs whose messages never start a review. The
case for putting your own ID there: the daemon runs on your machine with your `gh`
credentials, so a review of your own PR spends 10-30 minutes of local CPU to reach a
verdict GitHub will not let you convert into an approval. Nothing about the review is
wrong, it just cannot do the job a review exists to do.

```sh
SLACK_IGNORE_USER_IDS=U012AB3CD
```

Get the ID from Slack: **profile → ⋮ → Copy member ID**. It has to be an ID, not a handle
or display name — a `message` event identifies its sender only by ID, and resolving a name
would mean a `users.info` call per message, an extra `users:read` scope, and a filter that
breaks the day someone renames themselves. `<@U012AB3CD>`, `@U012AB3CD` and lowercase all
normalise to the same ID, so pasting a mention works. An entry that is not shaped like a
user ID gets a `config.suspect` line at startup, because it would otherwise never match
and the bot's only failure signal is silence.

Ignored messages are logged as `message.skipped` with reason `ignored-user`, so a message
that unexpectedly goes unreviewed can be told apart from one the bot never saw.

**An explicit `@mention` of the bot overrides the ignore list.** The list exists to stop the
bot auto-reviewing PR links you drop into the channel in passing; a message that names the
bot (`@Review Bot https://github.com/o/r/pull/312`) is a deliberate request, so it is
reviewed even if you are on the list. Post the same PR without mentioning the bot and the
ignore list still applies. (A bare mention with no PR URL is not a review — it gets the help
reply.)

**This filters on who posted the message, not who wrote the PR** — two cases follow from
that, and neither is worth an extra GitHub API call per message to fix:

- You post a *colleague's* PR: skipped, though a review would have been useful. Ask
  someone else to post it, or take your ID off the list.
- A colleague posts *your* PR: reviewed, and the run is the waste described above.

If the author-based filter turns out to be the one that matters, it belongs after
`parseMessage` in `decideTrigger` and needs a `gh pr view --json author` per PR.

### Catching up after downtime

Socket Mode delivers events live and never redelivers them. A message posted while the
daemon was restarting, while the Mac was asleep, or during a `ThrottleInterval` after a crash
would simply never be seen — and since silence is this bot's only failure signal, it looked
exactly like a review it had decided to skip.

So the daemon keeps a **cursor** per channel in `CURSOR_FILE`
(`~/.local/state/slack-review-bot/cursors.json` by default), and reads each channel's history
back to it with `conversations.history` — at startup, on every reconnect, and on a timer (see
[When a catch-up runs](#when-a-catch-up-runs)) — pushing what it missed through the same
`decideTrigger` rules a live event takes:

```json
{
  "version": 1,
  "channels": {
    "C0123456": { "ts": "1723489200.123456", "done": [], "updatedAt": "2026-08-19T18:03:11.201Z" }
  }
}
```

**The cursor tracks finished work, not received work.** `ts` is a watermark: every message at
or before it is done with. A message being reviewed right now holds the watermark below
itself until its job settles, so a restart in the middle of a 30-minute review replays that
message and reviews it again. The alternative — committing on receipt — leaves a message
wearing an `:eyes:` reaction that never gets a verdict, which is the worse of the two
failures. `done` holds messages *above* the watermark that are already finished, which
happens when `CONCURRENCY > 1` and reviews complete out of order; without it, a restart would
re-review a message that already has a findings thread.

**A running review is excluded from the next catch-up too.** Because the watermark sits below
a message under review on purpose, every pass re-reads it — thirty-six times over a three-hour
review at a five-minute cadence. Those re-dispatches bounced off the in-process dedupe set, but
that set is a bounded LRU: evict the key mid-review and the next pass starts a *second* Codex
run on the same PR, with its own thread and its own approval. So `planReplay` excludes
`cursors.inFlight(channel)` alongside `settled`. In-flight is memory-only and that is correct
— after a restart nothing is running, and the message should be replayed, because its review
died with the process. Note that an in-flight message is excluded rather than *ignored*:
`ignored` messages get recorded, and recording is settling, which would advance the watermark
past a review that has not produced a verdict.

Two limits keep a long outage from turning into an unusable morning, since each replayed
request costs 10-30 minutes of local machine time:

- `REPLAY_MAX_AGE_MS` (24h) — older requests are not replayed. A PR from last week has
  usually been merged or force-pushed past.
- `REPLAY_MAX_REQUESTS` (10) — at most this many requests are queued, **keeping the newest**.

Anything either limit drops is logged as `replay.skipped` with the reason, and the cursor
moves past it. `REPLAY_MAX_MESSAGES` (1000) bounds the history read per channel while looking
for those requests; hitting it logs `replay.truncated`, which is the one case where the bot
knowingly drops messages it was asked about.

Other behaviour worth knowing:

- **A channel with no cursor starts at "now".** A fresh install, or a channel added to
  `SLACK_CHANNEL_IDS` today, does not review every PR link in its readable history.
- **Which channels get read.** With an allowlist, all of them. Without one the bot listens to
  every channel it is in, and asking Slack which those are needs a scope it does not have, so
  it catches up only on channels it has processed before.
- **Live events wait for the catch-up to finish.** A message arriving in the second between
  connecting and reading history would otherwise record its own position first and carry the
  cursor straight over the backlog.
- **A channel it cannot read is stepped over,** logged as `replay.failed`, with its cursor
  left alone so the next start tries again. `conversations.history` needs `channels:history`
  (`groups:history` for private channels) and membership.
- **Nothing is replayed twice on a duplicate.** A message that arrives both live and in the
  replayed history hits the same dedupe set that already absorbs Slack's own retries.
- **Only review requests are replayed.** A day-old `@bot status` ping is recorded as
  processed, not answered late.
- **`REPLAY_ENABLED=false`** keeps the cursor but never acts on it; an empty `CURSOR_FILE`
  disables both, restoring the old live-only behaviour.

The log tells the whole story: `catchup.start` with the reason, `replay.channel` per channel
with what was read, queued, skipped and ignored, then `replay.done` and `catchup.done`.
Replayed reviews are logged as `review.queued` with `"source":"replay"`.

### When a catch-up runs

Tying the catch-up to process start was a bug, and an instructive one. Socket Mode reconnects
by itself — `autoReconnectEnabled` defaults on, with a 5s client and 30s server ping timeout —
so the daemon survives a flaky network without help. But nothing re-read the history after
those reconnects, which put the two failure modes exactly the wrong way round:

| Outage | What used to happen |
| --- | --- |
| Short — the socket reconnects | The daemon lives, and the messages posted during the gap are **never reviewed**. |
| Long — the reconnect gives up | It throws, the process dies, launchd restarts it, and startup replays the backlog. **Recovered.** |

The bot recovered from serious network failures and silently dropped messages in trivial ones.
The long-outage path is real, not hypothetical: `SocketModeClient.retrieveWSSURL` classifies a
DNS or connection failure as *unrecoverable* (`autoReconnectEnabled` is and-ed with that
verdict, so it does not help) and rethrows out of its own reconnect loop.

So a catch-up now has three triggers:

- **Startup**, as before. Live events wait for it.
- **Every reconnect** (`CATCHUP_ON_RECONNECT`, default on). The first connection is not a
  reconnect — startup already covers it — but every later one follows a gap Slack will not
  redeliver.
- **A timer** (`CATCHUP_INTERVAL_MS`, default 5m). This is the backstop, and deliberately
  independent of what the socket believes its state is: a Mac that slept wakes holding a
  websocket that *looks* connected and is not, and it can take until the next server ping
  timeout to notice. The process is frozen while asleep, so the timer is overdue on wake and
  fires immediately — which is exactly when a catch-up is wanted. It also covers causes a
  reconnect hook cannot see at all: a Slack-side outage, a bug in the socket client, an event
  dropped between the socket and the handler.

A pass is cheap when nothing was missed — one `conversations.history` per channel returning no
messages, on a tier-3 method (~50/min) — which is what makes a 5-minute timer reasonable. It
returns once the work is *queued*, not reviewed, so it never sits behind a 30-minute review.

`CatchUpRunner` (`src/catchup.ts`) runs them **one at a time, coalescing** the requests that
pile up behind a slow one:

- **Serialised** because `CursorTracker` is not safe against two concurrent passes over one
  channel: both read the same history, and `begin`/`settle` interleaved from two passes can
  walk the watermark past a review still sitting in the queue. The dedupe set would stop the
  duplicate *review*, but the cursor damage outlives the process.
- **Coalesced** because a reconnect storm — twenty in an afternoon, which the error log shows
  is ordinary on a laptop — should cost one more pass, not twenty. One waiting slot is enough:
  a pass that has not started would read the same history as the one queued ahead of it.
  Dropped requests are logged as `catchup.coalesced`.

Coalescing has one failure mode of its own, and it is *surfaced* rather than fixed. `WebClient`
defaults to `timeout: 0` — no HTTP timeout at all — so a wedged `conversations.history` would
hold the runner busy indefinitely and coalesce every later request away: the catch-up would
stop with no error logged anywhere, which is precisely the silent failure this whole mechanism
exists to end. Abandoning a pass on a timer would be worse, because the abandoned one keeps
mutating the cursor while its replacement starts — the concurrency the runner exists to
prevent. So a stall is made loud instead: every `catchup.coalesced` line carries
`runningForMs`, and a status reply appends `STUCK: a pass has been running for 12m` once one
passes a minute. A healthy pass takes milliseconds, so neither ever appears in normal
operation.

That measurement has to exclude time the whole process was suspended. A closed laptop freezes
the daemon outright, so a pass in flight when the lid shuts is still in flight on wake with a
wall clock that jumped — one weekend produced a `runningForMs` of 122336950, thirty-four
hours, for a pass that then finished two seconds later. A stall signal that cries wolf after
every sleep is one nobody reads when the genuine 30-minute retry stall appears beside it. So a
heartbeat runs every 30s and, when it fires more than 30s later than it should have, logs
`clock.jumped` and discounts that stretch from the running pass. Deliberately *not*
`performance.now()`: whether a monotonic clock advances across system sleep is platform- and
libuv-specific, while a timer that fires 34 hours late is unambiguous everywhere.

A catch-up that throws is logged as `catchup.failed` and recorded for the status reply; it
never rejects, because every caller is an event handler or a timer and an unhandled rejection
there is the crash this whole mechanism exists to stop depending on. That crash path is now
explicit rather than incidental: `unhandledRejection` and `uncaughtException` log
`bot.unhandled` / `bot.uncaught` and exit non-zero, so launchd's `KeepAlive` restart leaves a
reason behind instead of a silent gap in the log.

Setting `CATCHUP_INTERVAL_MS=0` **and** `CATCHUP_ON_RECONNECT=false` restores the old
startup-only behaviour. `npm run doctor` warns when both are off, since between them they are
two innocuous-looking knobs that turn the recovery mechanism back into a manual restart.

### How a run is judged

Codex is run with `--output-schema`, so its final message is a structured object rather
than prose the bot has to guess at:

```json
{"results": [
  {"url": "...", "status": "passed|findings|blocked",
   "summary": "one sentence", "pushedTestCommits": false, "reviewUrl": ""}
]}
```

`:approved_stamp:` requires **every** PR to be `passed`. A `blocked` PR — one that could
not be reviewed to a verdict — counts as not passing and is listed in the thread under
"Not reviewed", because stamping approval on a PR nobody reviewed is the one failure
mode worth engineering against. If the output is missing or unparseable the run is an
error: `:warning:` plus a thread saying plainly that the PRs were not reviewed.

The results are also reconciled against the PRs that were requested. A PR Codex fails to
report on becomes `blocked` rather than disappearing — otherwise a dropped PR would show
in no thread section at all, and if the entries that did come back all passed, the
message would earn `:approved_stamp:` for a review that never happened.

### Stalls and retries

The run timeout catches a run that takes *too long*; it does nothing for one that has
silently wedged with hours of budget left. So a second, shorter clock watches for
**silence**: every chunk of Codex output resets it, and a run that produces nothing for its
current grace is killed and retried as a fresh run. Like the budget, the grace is measured
in *active* time — a closed lid is discounted — so a sleeping laptop is never mistaken for a
hang.

The grace lengthens with each retry, from `STALL_BACKOFF_MS`: 2 minutes for the first
attempt, then 5, 7 and 12 for the re-runs, and a run silent through all four is killed for
good and reported as an error. No single grace ever exceeds `STALL_MAX_MS` (15m), so the bot
never waits longer than that for a sign of life. A stall logs `codex.stalled`; a retry logs
`review.retry`; giving up logs `review.gave-up`.

### Skipping a deleted request

A request can wait in the queue for hours behind other reviews. The moment a slot frees, the
job re-checks that the triggering Slack message still exists (`conversations.history` at that
exact `ts`, using the scope the catch-up already needs) — someone may have deleted it in the
meantime. A message that is gone is recorded as `skipped` (`review.aborted`) and never
reviewed: no 20-minute run, and no findings thread posted onto a message nobody can see. A
check that itself errors fails open — a transient Slack hiccup is no reason to drop a real
request — so the worst case is one review of an already-deleted message, not a dropped live
one.

### Changes a human must review

Some changes must not be reviewed by the bot at all. A pull request in the **`deployments`**
repo that touches **`values.yaml`** (or a per-environment sibling like `values-prod.yaml`) is
one: those carry the deployed image tags and sit next to encrypted secrets, so a person has to
review them. The moment such a PR reaches a slot the bot declines it — it never checks the
branch out or reads the file — leaves a comment on the PR saying a human review is required
(`gate.ts` / `github.ts`), reacts with `HUMAN_REVIEW_EMOJI`, and notes it in the thread. The
commenting is the point: silence would read as "the bot is slow", so the developer is told
plainly.

Only `deployments` PRs are inspected, and only their changed file *names* are fetched (never
the contents), so the common path adds no GitHub calls and no secret is read. The check fails
**safe**, not open: a `deployments` PR whose files cannot be listed is handed to a human rather
than reviewed on a guess — the opposite of the deleted-message check, because here the risk is
reviewing something sensitive, not dropping something routine. In a mixed request the gated PR
is set aside and commented on while the others are reviewed normally.

## Codex permissions

This is the part that needed solving. `$review-pr` cannot run unattended under the
interactive Codex config, for three separate reasons:

1. `approval_policy = "on-request"` — Codex stops and waits for a human on the first
   command needing escalation. A bot run just hangs there until the timeout.
2. The `workspace-write` sandbox **denies network by default**, so `gh pr view`,
   `git fetch`, `git push` and `npm install` all fail with DNS errors:
   ```
   $ codex sandbox -c sandbox_mode='"workspace-write"' -- curl https://api.github.com
   curl: (6) Could not resolve host: api.github.com
   ```
3. `writable_roots` does not cover the worktree root the skill is required to use, nor
   the package-manager caches the test step writes to.

The fix is a **separate config profile**, `codex/review-bot.config.toml.template`,
installed to `~/.codex/review-bot.config.toml` and selected with
`codex exec --profile review-bot`. Codex layers it over the base config, so your
interactive sessions keep `on-request` approvals and a network-less sandbox — nothing
about editing the base config would have been safe here, since that would de-restrict
every interactive Codex run too.

The profile turns approvals off and network on, but **keeps the sandbox**: it stays
`workspace-write` rather than `danger-full-access`, scoped to the checkouts, the
worktree root, and the caches. The bot reviews other people's branches, so the blast
radius of a bad command should stay bounded.

Verified working:

```
approval: never
sandbox: workspace-write [workdir, /tmp, $TMPDIR, /private/tmp/codex-pr-review,
         ~/.cache, ~/.npm, ~/Library/Caches] (network access enabled)
```

### The prompt does the rest

Sandbox permissions are only half of "unattended". The skill itself has branches that
stop and ask a human — a missing issue reference on an in-scope repo, a stale merge
base, an `AGENTS.md` change that alters the review process. `src/prompt.ts` resolves
each one up front, so Codex never blocks on a question nobody will answer. The policy is
to record those PRs as `blocked` with a reason and post nothing to GitHub for them, which
is what the skill already requires for those cases.

These resolutions are written against the skill's current rules, so they need re-checking
if `aqua-skills/skills/review-pr/SKILL.md` changes. In particular the skill *refuses* an
out-of-date PR rather than merging its base, and the prompt tells Codex explicitly not to
bring the branch up to date — the bot must never rewrite someone's branch in a case the
skill declines to review at all.

Run `npm run review -- --dry-run <pr-url>` to read the exact prompt.

### Git signing

`commit.gpgsign` is on globally, against a key whose agent caches the passphrase for ten
minutes behind `pinentry-mac`. An unattended review pushing a regression-test commit
with a cold cache would pop a GUI dialog and hang for the rest of the run. The daemon
therefore sets `commit.gpgsign=false` for Codex's children only, via `GIT_CONFIG_COUNT`
— your own git config is untouched — and the thread discloses that the test commits it
pushed are unsigned. Set `DISABLE_GIT_SIGNING=0` to turn this off, accepting that a run
can then block on a passphrase prompt.

## Setup

### 1. Slack app

Create an app at api.slack.com/apps in the workspace, then:

- **Socket Mode**: enable it, and generate an app-level token (`xapp-`) with
  `connections:write` — see [where each token comes from](#where-each-token-comes-from).
- **OAuth scopes** (bot): `channels:history`, `chat:write`, `reactions:write`. Add
  `groups:history` for private channels. `channels:history` covers both live delivery and the
  `conversations.history` read that
  [catches up after downtime](#catching-up-after-downtime). `channels:read` and `emoji:read` are optional —
  without them `npm run doctor` cannot check channel membership or emoji and says so.
- **Event Subscriptions**: subscribe to the bot event `message.channels` (and
  `message.groups` for private channels).
- Install to the workspace and copy the bot token (`xoxb-`).
- Invite the bot to the channel: `/invite @your-bot`.
- Make sure `:approved_stamp:` and `:comments:` exist in the workspace. A missing emoji
  makes `reactions.add` fail with `invalid_name`; the review still runs and the thread
  is still posted, but the channel-level signal is lost.

#### Where each token comes from

The two tokens are issued by two different pages, and mixing them up is the easiest way
to lose an afternoon — nothing validates either one beyond "non-empty" until the daemon
tries to connect.

**`xapp-` app-level token** — **Basic Information → App-Level Tokens → Generate Token and
Scopes**. Name it anything (`socket-mode` is fine), add the **`connections:write`** scope,
generate, copy. Flipping the toggle on the **Socket Mode** page also offers to create one
inline if none exists; that is the same token and appears in the same list afterwards.
Slack rearranges this UI from time to time, so trust the page labels over these
directions.

**`xoxb-` bot token** — **OAuth & Permissions**, after setting the bot scopes above and
clicking **Install to Workspace**.

| | `xapp-` app-level token | `xoxb-` bot token |
| --- | --- | --- |
| Created at | Basic Information → App-Level Tokens | OAuth & Permissions → Install to Workspace |
| Scopes set | On the token itself, at generation time | On the app, then applied by installing |
| Belongs to | The **app**, across every install | One **installation** in one workspace |
| Survives reinstall | Yes | Not necessarily — reinstalling can reissue it |
| Authorises | `apps.connections.open` — opening the websocket | Everything else: `chat.postMessage`, `reactions.add`, reading history |

Two consequences that are not obvious from the Slack docs:

- **`connections:write` is an app-level scope, not a bot scope.** Adding it to the Bot
  Token Scopes list does nothing, and it cannot be added to an `xapp-` token after
  generation — generate a replacement token instead.
- **The app-level token grants no other API access.** It opens the socket and nothing
  else, so a good `xapp-` paired with a bad `xoxb-` connects cleanly, logs nothing
  alarming at startup, and then fails on the first `reactions.add`.

Enabling Socket Mode on the app is a separate step from generating the token: a valid
`connections:write` token against an app with Socket Mode switched off still will not
connect.

The token format is `xapp-<version>-<APP_ID>-<token-id>-<secret>` — a version digit, the
**app ID**, a token id, then the secret. That embedded app ID is a quick sanity check: if
it does not match the app ID on Basic Information, the token belongs to a different app.
Both tokens are validated before the daemon accepts any traffic: Bolt authenticates the
app token by connecting, and startup calls `auth.test` for the bot token. A wrong or
swapped token therefore stops the daemon with a `bot.fatal` line in
`~/Library/Logs/slack-review-bot.err.log`, rather than leaving it running and unable to
react. `npm run doctor` checks both without starting anything — see
[Health and status](#health-and-status).

### 2. Credentials

```bash
mkdir -p ~/.config/slack-review-bot
$EDITOR ~/.config/slack-review-bot/env    # contents below
chmod 600 ~/.config/slack-review-bot/env
```

Only the two tokens are strictly required, but in practice you want four lines. Everything
else in [Configuration](#configuration) can go here too, and has a working default:

```sh
SLACK_BOT_TOKEN=xoxb-<your-bot-token>
SLACK_APP_TOKEN=xapp-<your-app-level-token>
SLACK_CHANNEL_IDS=C0123456789,C0987654321

# Your own user ID belongs here — see "Ignoring your own messages".
SLACK_IGNORE_USER_IDS=U012AB3CD
```

The file is `.`-sourced by the LaunchAgent inside `set -a` (see
`launchd/*.plist.template`), so it is shell syntax, not a dotenv dialect:

- **No `export`, no spaces around `=`.** `#` comments and blank lines are fine.
- **Values are shell-expanded.** `~` does not expand in an assignment, so give
  `WORKSPACE_ROOT`, `WORKTREE_ROOT` and `RUN_LOG_DIR` absolute paths, and quote any value
  containing spaces.
- **Mode 0600 is enforced.** `scripts/install-service.sh` refuses to install against a
  credentials file with any other mode, since it holds both tokens.

`SLACK_CHANNEL_IDS` is an allowlist of channel IDs, separated by commas or whitespace —
quote the whole value if you use whitespace. Leaving it empty means every channel the bot
is in, which is rarely what you want.

### 3. Install

```bash
npm install
npm run build
scripts/install-codex-profile.sh    # writes ~/.codex/review-bot.config.toml and verifies it
(set -a; . ~/.config/slack-review-bot/env; set +a; npm run doctor)   # verify before launching
scripts/install-service.sh          # renders the plist, loads and starts the agent
tail -f ~/Library/Logs/slack-review-bot.out.log
```

`scripts/install-service.sh --uninstall` removes the agent.

### Running a second reviewer

There is no shared server and no work queue here: this is a per-machine daemon talking to
Slack over Socket Mode. "Other developers participate" therefore means each of them runs
their own daemon from the steps above — and how their instances share the work depends on
which Slack app they connect as.

**Shared app, several machines.** Give each machine the *same* `xapp-`/`xoxb-` pair. Slack
delivers any one message event to only **one** of an app's open Socket Mode connections, so
reviews spread across whoever is online, and every reaction and thread posts as the one bot
identity. This is the closest thing to "the team shares the load" available today, but it is
Slack's load-balancer, not a scheduler you can steer: which machine takes a given PR is
Slack's choice, a machine that is asleep or wedged is simply passed over, and there is no
per-PR claiming, no hand-off, and no retry if the chosen machine drops mid-review. The
in-process dedupe (`app.ts`) is per-machine and does not span machines, so a socket flap that
lands the same event on two connections can produce two reviews.

**Separate apps, one per developer.** Each runs its own bot identity. Every instance sees
every message and will independently review the same PR — duplicate runs, duplicate
reactions, each trying to post its own GitHub review. That is only useful if each developer
wants their own bot in their own channel, not for sharing a single channel.

Either way, put **each machine's own Slack user ID** in `SLACK_IGNORE_USER_IDS` so a
developer's own PRs do not start a review — the bot cannot approve a PR authored by the
account it runs as, so reviewing it only burns machine time (see
[Ignoring your own messages](#ignoring-your-own-messages)).

**No shared work queue.** There is no mechanism that hands each PR to exactly one reviewer and
re-queues it if that machine drops — **this bot only reads Slack**, and does not consume any
queue. Coordination between machines is limited to the shared-app arrangement above (Slack
handing each event to one connection); use it for casual load-sharing and accept its limits.

## Configuration

All optional except the two tokens.

| Variable | Default | Purpose |
| --- | --- | --- |
| `SLACK_BOT_TOKEN` | — | Required. `xoxb-` token. |
| `SLACK_APP_TOKEN` | — | Required. `xapp-` token for Socket Mode. |
| `SLACK_CHANNEL_IDS` | *(any)* | Channel allowlist. |
| `SLACK_IGNORE_USER_IDS` | *(none)* | User IDs whose messages never start a review. See [Ignoring your own messages](#ignoring-your-own-messages). |
| `ACK_EMOJI` | `eyes` | Added when a message's review starts. |
| `QUEUED_EMOJI` | `hourglass_flowing_sand` | Added instead while the message waits for a slot; swapped for `ACK_EMOJI` when its run starts. |
| `PASS_EMOJI` | `approved_stamp` | Every PR passed. |
| `FINDINGS_EMOJI` | `comments` | Any PR has findings or was blocked. |
| `ERROR_EMOJI` | `warning` | The run itself failed. |
| `HUMAN_REVIEW_EMOJI` | `raising_hand` | A PR was handed to a human instead of reviewed (the deployments gate). |
| `REMOVE_ACK_ON_COMPLETE` | `false` | Remove `:eyes:` once a verdict is posted. |
| `CONCURRENCY` | `1` | Reviews running at once. |
| `RUN_TIMEOUT_MS` | `10800000` | Hard kill for one Codex run (3h of *active* time — see [Operating notes](#operating-notes)). |
| `STALL_BACKOFF_MS` | `120000,300000,420000,720000` | Per-attempt grace a run may go without output before it is killed as stalled and retried: 2m, then 5m, 7m, 12m, then given up. Empty disables stall detection and retries. |
| `STALL_MAX_MS` | `900000` | Ceiling on any single stall grace (15m). Every `STALL_BACKOFF_MS` entry is clamped to it. |
| `CODEX_PROFILE` | `review-bot` | Codex config profile name. |
| `WORKSPACE_ROOT` | `~/src` | Directory holding the local checkouts. |
| `WORKTREE_ROOT` | `/private/tmp/codex-pr-review` | Where PR worktrees go. Must match the profile. |
| `DISABLE_GIT_SIGNING` | `true` | Disable GPG signing for Codex's git commands. |
| `RUN_LOG_DIR` | `<repo>/runs` | Per-run Codex transcripts. Empty disables. |
| `CURSOR_FILE` | `~/.local/state/slack-review-bot/cursors.json` | Per-channel processing position. Empty disables it and the catch-up with it. |
| `REPLAY_ENABLED` | `true` | Master switch for the catch-up. Off still records the position. |
| `REPLAY_MAX_AGE_MS` | `86400000` | Do not replay requests older than this (24h). |
| `REPLAY_MAX_REQUESTS` | `10` | Cap on requests queued by one catch-up, newest kept. |
| `REPLAY_MAX_MESSAGES` | `1000` | Cap on history read per channel while looking for them. |
| `CATCHUP_INTERVAL_MS` | `300000` | Catch up on a timer as well (5m). `0` disables the timer. |
| `CATCHUP_ON_RECONNECT` | `true` | Catch up as soon as the socket reconnects. |
| `USAGE_REPLY_ENABLED` | `true` | Post a per-review usage line (tokens, active time, attempts) as a thread reply on every completed review. Off silences the reply; the `status` token totals are kept either way. |
| `SLACK_REQUEST_TIMEOUT_MS` | `30000` | Per-request timeout for the bot's Slack Web API calls. The WebClient defaults to no timeout, so a wedged `conversations.history` could hang the catch-up forever; this caps it, paired with a five-minute bounded retry policy. |
| `CODEX_ENV_PASSTHROUGH` | *(none)* | Extra environment variable names (comma/space separated) to pass through to the Codex child on top of the built-in allowlist. Keep minimal — anything added is visible to model-generated commands and untrusted PR code. |

Booleans accept `1`, `true`, `yes` or `on`, case-insensitively; any other non-empty value
is false, and an empty one falls back to the default rather than to false.

Changing `WORKTREE_ROOT` means editing the template's `writable_roots` and re-running
`scripts/install-codex-profile.sh` — the daemon passes the root to `--add-dir`, but a
mismatch between the two is a permissions failure mid-review.

## Swapping the review model

The review engine is Codex, run as a subprocess, and switching to Claude or another model is
an **adapter change, not a configuration flip**. The Codex-specific contract is narrow and
lives in one place, `src/codex.ts` (`buildCodexArgs`), which spawns:

```
codex exec --profile <name> --cd <workspace> --add-dir <worktree-root>
           --skip-git-repo-check --output-schema <schema.json>
           --output-last-message <out.json> <prompt>
```

Three of those are Codex features the rest of the bot leans on:

- **`--profile`** selects the unattended sandbox profile — approvals off, network on, writable
  worktree and caches (see [Codex permissions](#codex-permissions)). A different engine needs
  its own equivalent way to run non-interactively with network and a writable checkout.
- **`--output-schema`** forces the structured verdict the bot parses. The shape is
  `REVIEW_OUTPUT_SCHEMA` in `src/schema.ts`: one `{ url, status, summary, pushedTestCommits,
  reviewUrl }` per PR. Another engine must emit the same JSON, or gain a parsing shim.
- The **prompt** tells the engine to run the `review-pr` skill; the review rules themselves
  live in that skill (in `aqua-skills`), not in this repo.

`CODEX_BIN` does **not** get you there. It only changes *which binary* is executed with those
exact Codex arguments — it is for pointing at a particular `codex` build, not a different tool,
which would be handed flags it does not understand.

So adding a model means extracting the Codex-specific bits of `src/codex.ts` behind a small
interface — build the argument list, and capture the final structured message — and selecting
the engine by config. That is a contained refactor of `codex.ts` (and the seam in
`src/review.ts` that calls it), not a rewrite, but it is code to write, not a setting to
change. Claude Code can run the same `review-pr`/`resolve-review` skills, so it is a natural
second engine to wire in at that seam; its non-interactive invocation and structured-output
capture differ from Codex's flags, which is exactly what the adapter would absorb. Until that
seam exists, the bot is Codex-only.

## Health and status

Every way this daemon can be misconfigured produces the same symptom — it receives
messages and never visibly reacts — so it has three places to look instead.

### `npm run doctor`

The runtime preflight: everything `scripts/install-service.sh` cannot check because it
needs a live Slack connection or the real filesystem. Exits non-zero if anything failed,
so it can gate a launch. It reads the same environment the daemon does, which for a manual
run means sourcing the credentials file:

```bash
(set -a; . ~/.config/slack-review-bot/env; set +a; npm run doctor)
```

```
ok    credentials file  /Users/you/.config/slack-review-bot/env is 0600
ok    bot token         review-bot (U0BOT1234) in your-workspace
ok    app token         apps.connections.open accepted it
ok    channel C0123456  #pull-requests, bot is a member
ok    ignore list       1 ignored: U012AB3CD
warn  emoji             not custom emoji: eyes, warning — fine if they are built-in names
ok    codex binary      codex — codex-cli 0.147.0
ok    codex profile     profile 'review-bot' looks correct (approvals off, sandbox network on)
ok    workspace root    /Users/you/src
ok    worktree root     /private/tmp/codex-pr-review
ok    cursor file       /Users/you/.local/state/slack-review-bot/cursors.json — 1 channel recorded
ok    history C0123456  readable — replay can catch up on this channel
```

| Check | Catches |
| --- | --- |
| credentials file | Mode drifted off 0600. Permissions only — the file is never opened. |
| bot token | A wrong or revoked `xoxb-`, via `auth.test`. |
| app token | A wrong `xapp-`, or one without `connections:write`. |
| channels | A mistyped channel ID, or a channel the bot was never invited to. |
| ignore list | An entry that is not a user ID and can therefore never match. |
| emoji | A configured emoji that is not custom in this workspace. |
| codex binary | `CODEX_BIN` not on PATH. |
| codex profile | Approvals not off, network not on, unsubstituted paths. |
| roots | `WORKSPACE_ROOT` missing, or `WORKTREE_ROOT` not creatable. |
| cursor file | A position that cannot be written — every restart would silently drop the backlog. |
| history | A channel `conversations.history` cannot read. `not_in_channel` here means the bot was never invited, so it receives no live events from that channel either — this is the row that catches it when `channels:read` is absent and the membership check could only warn. |

Warnings never fail the run: they mark what this tool could not verify, which is different
from something being wrong. Channel membership needs `channels:read` and the emoji check
needs `emoji:read`; without those scopes both warn. Only custom emoji are listable at all,
so a built-in name like `eyes` always warns.

### Startup validation

The daemon calls `auth.test` before connecting and logs `auth.ok` with the bot's user ID
and workspace. If the bot token is rejected it logs `bot.fatal` and exits 1 rather than
starting: Socket Mode only proves the *app* token, so a bad `xoxb-` would otherwise let
the bot receive messages and start reviews it can never react to or report on. Exiting
means launchd retries every `ThrottleInterval` and the reason is in the log.

A malformed `SLACK_IGNORE_USER_IDS` entry logs `config.suspect` at startup but does not
stop the daemon.

After connecting, the catch-up logs `replay.channel` for each channel and one `replay.done`.
Neither a channel it cannot read nor a failure in the catch-up itself stops the daemon — a bot
that did not manage to backfill is still worth having — so those are `replay.failed` and
`replay.crashed` lines rather than an exit.

### Asking in Slack

The bot answers two mentions. `help` (or any mention it does not otherwise recognise) prints
what it does, the commands, and the common shortfalls — including that it pauses while its
laptop is asleep. `status` (or `health`, or `ping`) reports live state. Commands are
**typo-tolerant** (`command.ts`): a word within a small edit distance of a single command is
taken as that command (`staus` → status, `pign` → ping), while a word close to *two* commands
(`healp` — help or health?) is left ambiguous and falls to help rather than being guessed.
Anything else you @-mention it with — a bare mention, an unrecognised command — also gets the
help reply, so addressing the bot never falls silent; a mention carrying a PR link is reviewed
instead.

Mention the bot with `status` (or `health`, or `ping`) in an allowlisted channel and it
replies in a thread:

```
*Up* 3h 12m — queue: 1 running, 2 waiting
*Reviewing* trade-platform-monorepo#304, aix-ui#5459 — in review 6m (4m active) · attempt 1/4
_last update 12s ago:_ `running jest in libs/orders`
*Waiting* aix-ui#5460, deployments#1230
*Reviews* 4 passed, 2 with findings, 1 errored
*Tokens* 1.5M total · 210K last · 246K avg
*Link* connected for 22m, 20 reconnects
*Catch-up* 2 requeued, 1 skipped — 4m ago (reconnect) · every 5m
*Last* findings — 2 PRs, 12m ago
*Config* profile `review-bot`, concurrency 1, timeout 3h 0m, 1 channel, 1 ignored user
```

The `*Tokens*` line is Codex spend for this process's life: the running total, the last
review's count, and the mean per review. It counts only reviews that reported a total (a run
killed before it printed one is left out of both the sum and the average, so a timeout does not
drag the mean toward zero), and the line is omitted entirely until the first review reports —
a fresh daemon shows no token line rather than a misleading `0`. The figures are compact; the
exact per-review count is in each review's own usage reply, described next.

### Per-review usage reply

When `USAGE_REPLY_ENABLED` is on (the default), every completed review posts a short usage
line as a thread reply — on a pass, a findings review, and a failed run alike:

```
🧮 210,482 tokens · 4m12s active · 1 attempt
```

It reports Codex's exact token total for the run, the *active* time it took (sleep discounted,
the same clock the timeout uses), and how many attempts it ran — more than one means a stall
was retried. A run that was killed before Codex printed a total shows `tokens n/a` with the
time and attempts it still cost, so a failure is accounted for rather than silent. This is the
one message a passing review posts (it otherwise only reacts `:approved_stamp:`), so setting
`USAGE_REPLY_ENABLED=false` returns passes to being reaction-only; the `*Tokens*` totals in the
`status` reply are kept regardless of this switch.

The `*Reviewing*` and `*Waiting*` lines are the live view of what the bot is doing *right now*:
the PRs under review, how long the run has taken (and how much of that was active rather than
asleep), which stall attempt it is on, and the last line Codex printed with how long ago. This
reply is answered immediately even mid-review — the review runs in a child process, so the
bot's event loop is free, and the status is read from an in-memory registry that never waits on
the run it describes. The last-output line is raw tool output, cleaned and truncated: a hint at
what the run is doing, not trusted or complete text.

`*Link*` and `*Catch-up*` answer the pair of questions that silence in the
channel cannot: whether the socket is actually up, and whether anything posted during a gap
was picked up, dropped, or never read. A high reconnect count with a healthy catch-up line is
a flaky network being handled; a healthy link with `*Catch-up* failed` is a scope or
membership problem. Details worth knowing:

- **No extra scope or event subscription.** The mention is matched in the ordinary message
  stream against the bot's own user ID, which it learns from `auth.test`.
- **The status reply never blocks on a review.** Progress is pushed to an in-memory registry
  (`progress.ts`) as Codex prints; answering a status request only reads it.
- **Reviews take precedence.** A message carrying PR URLs is reviewed even if it also says
  "status", so the two triggers cannot collide.
- **Users on the ignore list still get an answer.** The list exists to avoid wasting half
  an hour on a review; refusing to say whether the bot is alive is a different thing.
- **Counters are per process** and reset on restart, since the question being asked is
  whether *this* process is working. The link and catch-up lines describe this process for the
  same reason.
- **"Off" and "none yet" are different answers.** `*Catch-up* off` means the mechanism is
  disabled and messages missed while disconnected are gone; `none finished yet` means the
  daemon started seconds ago. The old startup-only line rendered both as absent, which is part
  of why a miss went unnoticed.

### Still not covered

- **No alerting.** `KeepAlive` restarts a crashed daemon every 30s indefinitely; a crash
  loop is visible only in `~/Library/Logs/slack-review-bot.err.log`.
- **No heartbeat, but there is now a pulse.** Nothing pushes "I am alive" anywhere, so
  distinguishing "Mac asleep" from "process wedged" still means asking — but the timer means a
  message missed either way is picked up within `CATCHUP_INTERVAL_MS` of the machine coming
  back, and `*Link*` in a status reply says how long the socket has actually been up.
- **Nothing announces a skipped backlog in Slack.** The catch-up reports what it dropped as
  too old or over `REPLAY_MAX_REQUESTS` in the log and in a status reply, but the channel
  itself never hears that a request was passed over.
- **A verdict can still be lost.** Every Slack effect in `job.ts` is wrapped in `swallow()`
  and the cursor settles in a `finally`, so a `chat.postMessage` that fails after the
  WebClient's ~30 minutes of retries leaves the requester with `:eyes:` and nothing else,
  permanently — no catch-up re-runs a message that was already reviewed. The findings survive
  in `runs/*.log`; recovering them is manual.
- **A message below the watermark is unrecoverable.** Every non-request message advances the
  cursor, so ordinary chatter walks it past anything already stepped over. A catch-up only ever
  looks *above* the watermark, bounded further by `REPLAY_MAX_AGE_MS`. Recovering an older one
  means rewinding `ts` in the cursor file by hand, or `npm run review -- <pr-url>`.

## Development

```bash
npm test                              # 381 assertions, no Slack or Codex needed
npm run typecheck                     # src AND the tests — see below
npm run doctor                        # runtime preflight; needs the tokens in the env
npm run review -- --dry-run <pr-url>  # print the prompt that would be sent
npm run review -- <pr-url> [...]      # run a real review, print the would-be thread
```

**Use `npm run typecheck`, not `npx tsc --noEmit`.** `tsconfig.json` excludes `**/*.test.ts`
so the build never tries to emit them, and the tests run under `ts-node --transpile-only`,
which does not typecheck either — so between the two, *nothing checked a test file*. Adding a
required field to an interface a test constructs compiled clean, passed `tsc --noEmit`, and
blew up as a runtime `TypeError` from whichever test reached the line first.
`tsconfig.test.json` exists solely to close that, and `npm run typecheck` runs both.

`npm run review` is the same prompt, profile and output contract the daemon uses, so a
review that misbehaves in Slack reproduces from the terminal.

## Operating notes

- **Reviews are serialised.** Default concurrency is 1: parallel reviews thrash the
  machine and can collide in the same repository's `.git`. Messages queue in arrival
  order — the local equivalent of the `/investigate` bot's single-`MessageGroupId` FIFO.
  A message that has to wait wears `QUEUED_EMOJI` (`:hourglass_flowing_sand:`) until its own
  run starts and takes over with `:eyes:`; without that, a two-hour wait behind another
  review looked exactly like a missed message. `review.queued` logs `"waiting":true` for it.
- **The run timeout counts active time, not wall-clock time.** A plain `setTimeout` keeps
  running while a closed lid has the process suspended, and it killed a review for
  "exceeding" three hours of which it had used four minutes — then the next one in the queue
  inherited the same fate because its run began during a two-second maintenance wake. The
  deadline in `src/deadline.ts` is the catch-up's freeze heartbeat applied to the run: a 30s
  tick that fires more than 30s late is charged one interval and the excess is booked as
  frozen, logged as `codex.frozen` with the budget remaining. A run that is killed anyway says
  in its thread how much wall-clock time was discounted.
- **The bot only runs while the Mac is awake and logged in,** but it no longer forgets what
  happened while it was not. It records how far it read in each channel and backfills from
  `conversations.history` at startup, on every reconnect, and every `CATCHUP_INTERVAL_MS`,
  bounded by `REPLAY_MAX_AGE_MS` and `REPLAY_MAX_REQUESTS` — see
  [Catching up after downtime](#catching-up-after-downtime). A wake from sleep is covered by
  the timer, which is overdue the moment the process thaws.
- **A review interrupted by a restart runs again.** The cursor commits a message only once
  its job settles, so the work is repeated rather than lost. Reactions are idempotent
  (`already_reacted` is swallowed); a *second findings thread* is only possible if the
  process dies between posting the thread and writing the cursor.
- **Per-run transcripts** land in `runs/<channel>-<ts>.log` — the full Codex stdout for
  a review, which is where to look when a thread says something surprising.
- **The daemon never logs message text**, only channel, ts, and PR URLs, so a request
  quoting customer data does not end up in the log.
- **Codex's environment is built from an allowlist, not the daemon's whole environment.**
  The profile sets `shell_environment_policy.inherit = "all"`, so whatever the child is
  given is visible to model-generated shell commands and untrusted PR test code. Rather
  than inherit everything and strip known secrets out — a denylist that misses the next new
  credential — the child starts from nothing and receives only `CODEX_ENV_ALLOWLIST`: the
  shell/OS basics, the on-disk config locations (so file-based `gh`/`git`/`npm` auth in
  `$HOME` still works), and the few credentials reviews genuinely need (`GH_TOKEN` /
  `GITHUB_TOKEN`, `NPM_TOKEN`, plus `LC_*` and `npm_config_*` by prefix). Cloud keys, the
  Slack tokens, and every other secret are dropped. `CODEX_ENV_PASSTHROUGH` adds names an
  install needs (keep it minimal — anything added reaches untrusted code).
