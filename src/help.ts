// The help reply: what the bot is, how to talk to it, and why it might be quiet.
//
// Shown when someone @-mentions the bot and asks for `help`, uses a command it does not
// recognise, or mentions it with nothing actionable at all — so this doubles as the answer
// to "what is this thing and why isn't it doing anything?". Kept pure and free of live state
// so it renders identically whether the bot is busy, idle, or wedged.

/** Reaction names the bot uses, so the legend matches what people actually see. */
export interface HelpEmoji {
  ack: string
  queued: string
  pass: string
  findings: string
  error: string
  humanReview: string
}

export function renderHelp(emoji: HelpEmoji): string {
  return [
    '*Slack Review Bot* — automated pull-request code review.',
    '',
    '*What I do*',
    "Post a GitHub pull-request link in a channel I watch and I'll review it: I read the whole " +
      'PR first — the description, the commit messages, and the full discussion (issue ' +
      'comments, review comments, and resolved threads) — then check out the branch, review the ' +
      'diff and the code around it, run its tests, post review comments on GitHub, and report ' +
      'back here with a reaction and a thread summary.',
    '',
    '*Steering what I review*',
    'Because I read the PR discussion as part of the review, you can shape what I flag without ' +
      'leaving Slack:',
    '• Add plain-text instructions next to the link when you post it — a quick note to focus on ' +
      'or skip something.',
    "• Comment on the PR itself to tell me a finding is intentional, out of scope, already " +
      "handled, or should be narrowed or deferred, and I'll honor it after checking it against " +
      'the code. Notes in the PR description work the same way — mark something "out of scope" ' +
      'or "follow-up" and I won\'t treat it as a defect.',
    '• Later comments win, so you can correct course mid-review. I take this guidance from the ' +
      'PR author, the requester, and repo collaborators — not from other bots or drive-by ' +
      'comments unless a maintainer endorses them.',
    "• A genuine correctness or security defect still gets flagged — a scope note won't silence " +
      'a real bug.',
    '',
    '*Reactions I use*',
    `:${emoji.ack}: reviewing · :${emoji.queued}: queued, waiting for a slot · ` +
      `:${emoji.pass}: all passed · :${emoji.findings}: findings posted · ` +
      `:${emoji.error}: the run failed · :${emoji.humanReview}: handed to a human`,
    '',
    '*Commands* — @-mention me, then:',
    '• `help` — show this message',
    "• `status` (or `health`, `ping`) — uptime, what I'm reviewing now, the queue, connection, and config",
    '• a *pull-request link* — start a review',
    "Close spellings work too, so `staus` or `helth` still get through.",
    "Mention me with anything I don't recognise and I'll show this help.",
    '',
    '*How I run & common shortfalls*',
    '• I currently run on a laptop as a background service (not yet cloud-hosted). *If the ' +
      "laptop is asleep or offline I pause* — reviews resume on wake (I don't count sleep " +
      "against their time) and I can't answer until then. If I seem silent, that is usually why.",
    '• I review *one PR at a time*; each takes roughly 10–30 minutes, so several requests ' +
      'queue behind each other.',
    '• I skip a request whose Slack message was deleted before I got to it.',
    "• I won't review a PR that is out of date with its base branch.",
    "• I won't review a `deployments` PR that changes `values.yaml` — those need a human. I'll " +
      'comment on the PR to say so.',
    '• A review that goes silent is retried a few times with growing patience, then given up ' +
      'and reported as an error.',
  ].join('\n')
}
