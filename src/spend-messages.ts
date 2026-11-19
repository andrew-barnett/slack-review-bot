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
