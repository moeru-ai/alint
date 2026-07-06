/**
 * Parse a `--since` value into an inclusive lower-bound timestamp.
 * This is a tiny helper only to meet the needs.
 *
 * Supported forms:
 * - `Nd`/`Nh` — Now minus N days/hours.
 * - `YYYY-MM`/`YYYY-MM-DD` — Start of that UTC month/day.
 *
 * Edge cases:
 * - An empty value means "no lower bound".
 * - An unrecognized value will cause an error to be thrown.
 */
export function parseSince(value: string | undefined, now: number): number | undefined {
  if (value === undefined || value === '') {
    return undefined
  }

  const relative = /^(\d+)([dh])$/u.exec(value)

  if (relative) {
    const amount = Number(relative[1])
    const unitMs = relative[2] === 'd' ? 86_400_000 : 3_600_000

    return now - amount * unitMs
  }

  const calendar = /^(\d{4})-(\d{2})(?:-(\d{2}))?$/u.exec(value)

  if (calendar) {
    const year = Number(calendar[1])
    const month = Number(calendar[2])
    const day = calendar[3] === undefined ? 1 : Number(calendar[3])

    return Date.UTC(year, month - 1, day)
  }

  throw new Error(`Invalid --since "${value}": use e.g. 7d, 24h, 2025-01, or 2025-01-15.`)
}
