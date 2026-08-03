/**
 * Timezone-aware date/time primitives.
 *
 * Built entirely on `Intl.DateTimeFormat` — no date-fns, no date-fns-tz, no
 * Luxon, no Temporal polyfill. The only IANA timezone database in play is the
 * one already shipped with the JS engine.
 *
 * Core model
 * ----------
 * There are exactly two kinds of time value here, and keeping them apart is
 * what makes the calendar correct:
 *
 *   - `Instant`  — an absolute point in time (epoch milliseconds). Unambiguous.
 *   - `PlainDate` / `PlainDateTime` — a *wall-clock* reading with no offset.
 *     "December 1st, 9:00am" is not a point in time until you say *where*.
 *
 * Every conversion between the two names its timezone explicitly. There is no
 * implicit use of the host timezone anywhere in this module.
 */

export type Instant = number

export interface PlainDate {
  year: number
  /** 1-12, not 0-indexed. */
  month: number
  /** 1-31. */
  day: number
}

export interface PlainDateTime extends PlainDate {
  hour: number
  minute: number
  second: number
  millisecond: number
}

/**
 * How to resolve a wall-clock time that is either impossible or ambiguous
 * because of a DST transition.
 *
 * - `compatible` — matches `Temporal` and legacy `Date`: for a spring-forward
 *   gap pick the later instant, for a fall-back overlap pick the earlier one.
 * - `earlier` / `later` — pick a side explicitly.
 * - `reject` — throw. Use when the input came from a user and silently moving
 *   their time would be wrong.
 */
export type Disambiguation = 'compatible' | 'earlier' | 'later' | 'reject'

export const MINUTE_MS = 60_000
export const HOUR_MS = 3_600_000
export const DAY_MS = 86_400_000

/* -------------------------------------------------------------------------- */
/* Zone offset lookup                                                          */
/* -------------------------------------------------------------------------- */

const partsFormatterCache = new Map<string, Intl.DateTimeFormat>()

function getPartsFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = partsFormatterCache.get(timeZone)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      // `hourCycle: 'h23'` rather than `hour12: false`, which can yield hour 24
      // for midnight in some engines.
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
    partsFormatterCache.set(timeZone, formatter)
  }
  return formatter
}

/** Throws a clear error for an invalid IANA identifier instead of a cryptic one. */
export function assertValidTimeZone(timeZone: string): void {
  try {
    getPartsFormatter(timeZone)
  } catch {
    throw new RangeError(`Invalid IANA time zone identifier: "${timeZone}"`)
  }
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    getPartsFormatter(timeZone)
    return true
  } catch {
    return false
  }
}

/** The wall-clock reading in `timeZone` at a given instant. */
export function instantToPlainDateTime(
  instant: Instant,
  timeZone: string,
): PlainDateTime {
  const parts = getPartsFormatter(timeZone).formatToParts(new Date(instant))
  const lookup: Record<string, number> = {}
  for (const part of parts) {
    if (part.type !== 'literal') {
      lookup[part.type] = Number(part.value)
    }
  }
  return {
    year: lookup.year,
    month: lookup.month,
    day: lookup.day,
    hour: lookup.hour,
    minute: lookup.minute,
    second: lookup.second,
    // `formatToParts` has no sub-second precision; carry it from the instant.
    millisecond: ((instant % 1000) + 1000) % 1000,
  }
}

export function instantToPlainDate(instant: Instant, timeZone: string): PlainDate {
  const wall = instantToPlainDateTime(instant, timeZone)
  return { year: wall.year, month: wall.month, day: wall.day }
}

/**
 * UTC offset of `timeZone` at `instant`, in milliseconds.
 * Positive east of Greenwich. `America/Los_Angeles` in July → +(-7h).
 */
export function getOffsetMs(instant: Instant, timeZone: string): number {
  const wall = instantToPlainDateTime(instant, timeZone)
  const wallAsUtc = Date.UTC(
    wall.year,
    wall.month - 1,
    wall.day,
    wall.hour,
    wall.minute,
    wall.second,
    wall.millisecond,
  )
  return wallAsUtc - instant
}

export function getOffsetMinutes(instant: Instant, timeZone: string): number {
  return getOffsetMs(instant, timeZone) / MINUTE_MS
}

/** Formats an offset the way calendars label zones: `GMT-8`, `GMT+5:30`, `GMT`. */
export function formatOffset(instant: Instant, timeZone: string): string {
  const totalMinutes = getOffsetMinutes(instant, timeZone)
  if (totalMinutes === 0) return 'GMT'
  const sign = totalMinutes < 0 ? '-' : '+'
  const abs = Math.abs(totalMinutes)
  const hours = Math.floor(abs / 60)
  const minutes = abs % 60
  return minutes === 0
    ? `GMT${sign}${hours}`
    : `GMT${sign}${hours}:${String(minutes).padStart(2, '0')}`
}

/* -------------------------------------------------------------------------- */
/* Wall clock -> instant, with DST disambiguation                              */
/* -------------------------------------------------------------------------- */

export class AmbiguousTimeError extends RangeError {
  constructor(wall: PlainDateTime, timeZone: string) {
    super(
      `Wall-clock time ${plainDateTimeToString(wall)} is ambiguous or does not exist in ${timeZone}.`,
    )
    this.name = 'AmbiguousTimeError'
  }
}

/**
 * Resolve a wall-clock reading in `timeZone` to an absolute instant.
 *
 * The naive `epoch - offset` approach is wrong because the offset you need
 * depends on the very instant you are trying to compute. We instead probe the
 * offsets a day either side of the target, derive a candidate instant from
 * each, and keep only candidates that actually round-trip back to the
 * requested wall time.
 *
 *   - 2 surviving candidates → ambiguous (clocks went back; the time happened twice).
 *   - 1 surviving candidate  → the normal case.
 *   - 0 surviving candidates → a gap (clocks sprang forward; the time never happened).
 */
export function plainDateTimeToInstant(
  wall: PlainDateTime,
  timeZone: string,
  disambiguation: Disambiguation = 'compatible',
): Instant {
  const wallAsUtc = Date.UTC(
    wall.year,
    wall.month - 1,
    wall.day,
    wall.hour,
    wall.minute,
    wall.second,
    wall.millisecond,
  )

  const offsetBefore = getOffsetMs(wallAsUtc - DAY_MS, timeZone)
  const offsetAfter = getOffsetMs(wallAsUtc + DAY_MS, timeZone)

  const candidates: Instant[] = []
  for (const offset of offsetBefore === offsetAfter
    ? [offsetBefore]
    : [offsetBefore, offsetAfter]) {
    const candidate = wallAsUtc - offset
    if (getOffsetMs(candidate, timeZone) === offset) {
      candidates.push(candidate)
    }
  }
  candidates.sort((a, b) => a - b)

  if (candidates.length === 1) return candidates[0]

  if (candidates.length > 1) {
    // Overlap: the wall time occurred twice.
    if (disambiguation === 'reject') throw new AmbiguousTimeError(wall, timeZone)
    if (disambiguation === 'later') return candidates[candidates.length - 1]
    return candidates[0]
  }

  // Gap: the wall time never occurred.
  if (disambiguation === 'reject') throw new AmbiguousTimeError(wall, timeZone)
  if (disambiguation === 'earlier') return wallAsUtc - offsetAfter
  return wallAsUtc - offsetBefore
}

export function plainDateToInstant(
  date: PlainDate,
  timeZone: string,
  disambiguation: Disambiguation = 'compatible',
): Instant {
  return plainDateTimeToInstant(toPlainDateTime(date), timeZone, disambiguation)
}

/** Midnight at the start of `date` in `timeZone`, as an absolute instant. */
export function startOfDayInstant(date: PlainDate, timeZone: string): Instant {
  return plainDateToInstant(date, timeZone, 'compatible')
}

/**
 * Length of a calendar day in minutes, in `timeZone`.
 *
 * Usually 1440, but 1380 or 1500 on DST transition days. Time-grid views must
 * use this instead of assuming 24 hours, or events drift by an hour.
 */
export function dayLengthMinutes(date: PlainDate, timeZone: string): number {
  const start = startOfDayInstant(date, timeZone)
  const end = startOfDayInstant(addDays(date, 1), timeZone)
  return (end - start) / MINUTE_MS
}

/** True when `date` in `timeZone` is a DST transition day (not 1440 minutes). */
export function hasDstTransition(date: PlainDate, timeZone: string): boolean {
  return dayLengthMinutes(date, timeZone) !== 1440
}

/**
 * Minutes elapsed from the start of `date` (in `timeZone`) to `instant`.
 * Negative before the day starts, greater than the day length after it ends.
 */
export function minutesFromStartOfDay(
  instant: Instant,
  date: PlainDate,
  timeZone: string,
): number {
  return (instant - startOfDayInstant(date, timeZone)) / MINUTE_MS
}

/* -------------------------------------------------------------------------- */
/* Plain date arithmetic (calendar math, offset-free)                          */
/* -------------------------------------------------------------------------- */

export function toPlainDateTime(
  date: PlainDate,
  hour = 0,
  minute = 0,
  second = 0,
  millisecond = 0,
): PlainDateTime {
  return { ...date, hour, minute, second, millisecond }
}

export function makePlainDate(year: number, month: number, day: number): PlainDate {
  return { year, month, day }
}

/**
 * Calendar-day arithmetic. Runs through UTC deliberately: this is pure
 * calendar math with no timezone involved, so DST cannot distort it.
 */
export function addDays(date: PlainDate, amount: number): PlainDate {
  const utc = Date.UTC(date.year, date.month - 1, date.day) + amount * DAY_MS
  const shifted = new Date(utc)
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  }
}

export function addMonths(date: PlainDate, amount: number): PlainDate {
  const totalMonths = date.year * 12 + (date.month - 1) + amount
  const year = Math.floor(totalMonths / 12)
  const month = (totalMonths % 12 + 12) % 12 + 1
  // Clamp so Jan 31 + 1 month is Feb 28/29, not Mar 3.
  const day = Math.min(date.day, daysInMonth(year, month))
  return { year, month, day }
}

export function addYears(date: PlainDate, amount: number): PlainDate {
  return addMonths(date, amount * 12)
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

export function comparePlainDate(a: PlainDate, b: PlainDate): number {
  if (a.year !== b.year) return a.year - b.year
  if (a.month !== b.month) return a.month - b.month
  return a.day - b.day
}

export function isSamePlainDate(a: PlainDate, b: PlainDate): boolean {
  return comparePlainDate(a, b) === 0
}

export function isSameMonth(a: PlainDate, b: PlainDate): boolean {
  return a.year === b.year && a.month === b.month
}

/** Day of week, 0 = Sunday through 6 = Saturday. */
export function weekdayIndex(date: PlainDate): number {
  return new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay()
}

export function startOfWeek(date: PlainDate, weekStartsOn = 0): PlainDate {
  const diff = (weekdayIndex(date) - weekStartsOn + 7) % 7
  return addDays(date, -diff)
}

export function endOfWeek(date: PlainDate, weekStartsOn = 0): PlainDate {
  return addDays(startOfWeek(date, weekStartsOn), 6)
}

export function startOfMonth(date: PlainDate): PlainDate {
  return { year: date.year, month: date.month, day: 1 }
}

export function endOfMonth(date: PlainDate): PlainDate {
  return { year: date.year, month: date.month, day: daysInMonth(date.year, date.month) }
}

/** Whole calendar days from `a` to `b`. Positive when `b` is later. */
export function differenceInDays(a: PlainDate, b: PlainDate): number {
  const utcA = Date.UTC(a.year, a.month - 1, a.day)
  const utcB = Date.UTC(b.year, b.month - 1, b.day)
  return Math.round((utcB - utcA) / DAY_MS)
}

export function isDateInRange(
  date: PlainDate,
  min?: PlainDate,
  max?: PlainDate,
): boolean {
  if (min && comparePlainDate(date, min) < 0) return false
  if (max && comparePlainDate(date, max) > 0) return false
  return true
}

/** ISO-8601 week number (weeks start Monday; week 1 contains the first Thursday). */
export function isoWeekNumber(date: PlainDate): number {
  const utc = new Date(Date.UTC(date.year, date.month - 1, date.day))
  // Shift to the Thursday of the current ISO week.
  const dayNumber = (utc.getUTCDay() + 6) % 7
  utc.setUTCDate(utc.getUTCDate() - dayNumber + 3)
  const isoYearStart = new Date(Date.UTC(utc.getUTCFullYear(), 0, 4))
  const isoYearStartDayNumber = (isoYearStart.getUTCDay() + 6) % 7
  isoYearStart.setUTCDate(isoYearStart.getUTCDate() - isoYearStartDayNumber + 3)
  return 1 + Math.round((utc.getTime() - isoYearStart.getTime()) / (7 * DAY_MS))
}

/* -------------------------------------------------------------------------- */
/* Serialization                                                               */
/* -------------------------------------------------------------------------- */

const pad = (value: number, length = 2) => String(value).padStart(length, '0')

/** `YYYY-MM-DD`. Stable key for maps and React keys. */
export function plainDateToString(date: PlainDate): string {
  return `${pad(date.year, 4)}-${pad(date.month)}-${pad(date.day)}`
}

export function plainDateTimeToString(wall: PlainDateTime): string {
  const base = `${plainDateToString(wall)}T${pad(wall.hour)}:${pad(wall.minute)}:${pad(wall.second)}`
  return wall.millisecond ? `${base}.${pad(wall.millisecond, 3)}` : base
}

/** Parses `YYYY-MM-DD`, optionally with a `THH:MM[:SS]` wall-clock part. */
export function parsePlainDateTime(value: string): PlainDateTime {
  const match =
    /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.(\d{1,3}))?)?$/.exec(
      value.trim(),
    )
  if (!match) {
    throw new RangeError(
      `Expected "YYYY-MM-DD" or "YYYY-MM-DD HH:MM[:SS]", received "${value}"`,
    )
  }
  return {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4] ?? 0),
    minute: Number(match[5] ?? 0),
    second: Number(match[6] ?? 0),
    millisecond: Number((match[7] ?? '0').padEnd(3, '0')),
  }
}

export function parsePlainDate(value: string): PlainDate {
  const wall = parsePlainDateTime(value)
  return { year: wall.year, month: wall.month, day: wall.day }
}

/**
 * Resolve a source time to an absolute instant.
 *
 * Accepts either a real instant (ISO string with `Z`/offset, epoch ms, `Date`)
 * or a *floating* wall-clock string, which is interpreted in `timeZone`. This
 * is the seam where naive datetimes from a database get pinned to the timezone
 * the event actually happens in.
 */
export function resolveInstant(
  value: string | number | Date,
  timeZone: string,
  disambiguation: Disambiguation = 'compatible',
): Instant {
  if (typeof value === 'number') return value
  if (value instanceof Date) return value.getTime()

  const trimmed = value.trim()
  const hasExplicitOffset = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(trimmed)
  if (hasExplicitOffset) {
    const parsed = Date.parse(trimmed)
    if (Number.isNaN(parsed)) {
      throw new RangeError(`Unparseable datetime: "${value}"`)
    }
    return parsed
  }
  return plainDateTimeToInstant(parsePlainDateTime(trimmed), timeZone, disambiguation)
}

/* -------------------------------------------------------------------------- */
/* Formatting                                                                  */
/* -------------------------------------------------------------------------- */

const formatterCache = new Map<string, Intl.DateTimeFormat>()

function getFormatter(
  locale: string | undefined,
  timeZone: string,
  options: Intl.DateTimeFormatOptions,
): Intl.DateTimeFormat {
  const key = `${locale ?? 'default'}|${timeZone}|${JSON.stringify(options)}`
  let formatter = formatterCache.get(key)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(locale, { ...options, timeZone })
    formatterCache.set(key, formatter)
  }
  return formatter
}

/** Format an absolute instant as seen from `timeZone`. */
export function formatInstant(
  instant: Instant,
  timeZone: string,
  options: Intl.DateTimeFormatOptions,
  locale?: string,
): string {
  return getFormatter(locale, timeZone, options).format(new Date(instant))
}

/**
 * Format a plain date without letting a timezone shift it.
 * Rendered through UTC so "Dec 1" can never display as "Nov 30".
 */
export function formatPlainDate(
  date: PlainDate,
  options: Intl.DateTimeFormatOptions,
  locale?: string,
): string {
  return getFormatter(locale, 'UTC', options).format(
    new Date(Date.UTC(date.year, date.month - 1, date.day)),
  )
}

export function formatTimeOfDay(
  instant: Instant,
  timeZone: string,
  locale?: string,
  hour12?: boolean,
): string {
  return formatInstant(
    instant,
    timeZone,
    { hour: 'numeric', minute: '2-digit', ...(hour12 === undefined ? {} : { hour12 }) },
    locale,
  )
}

/** Long zone name for labelling, e.g. `Pacific Standard Time`. */
export function timeZoneDisplayName(
  instant: Instant,
  timeZone: string,
  locale?: string,
): string {
  const parts = getFormatter(locale, timeZone, {
    timeZoneName: 'long',
  }).formatToParts(new Date(instant))
  return parts.find((part) => part.type === 'timeZoneName')?.value ?? timeZone
}

export function shortTimeZoneName(
  instant: Instant,
  timeZone: string,
  locale?: string,
): string {
  const parts = getFormatter(locale, timeZone, {
    timeZoneName: 'short',
  }).formatToParts(new Date(instant))
  return parts.find((part) => part.type === 'timeZoneName')?.value ?? timeZone
}

/** Localized weekday names, index 0 = Sunday. */
export function weekdayNames(
  locale: string | undefined,
  format: 'narrow' | 'short' | 'long' = 'short',
): string[] {
  const formatter = new Intl.DateTimeFormat(locale, { weekday: format, timeZone: 'UTC' })
  // 2023-01-01 was a Sunday.
  return Array.from({ length: 7 }, (_, index) =>
    formatter.format(new Date(Date.UTC(2023, 0, 1 + index))),
  )
}

export function monthNames(
  locale: string | undefined,
  format: 'short' | 'long' = 'long',
): string[] {
  const formatter = new Intl.DateTimeFormat(locale, { month: format, timeZone: 'UTC' })
  return Array.from({ length: 12 }, (_, index) =>
    formatter.format(new Date(Date.UTC(2023, index, 1))),
  )
}

/* -------------------------------------------------------------------------- */
/* Host environment                                                            */
/* -------------------------------------------------------------------------- */

/**
 * The host timezone. Call this in an effect rather than during render in SSR
 * apps — server and client resolve different zones and React will complain
 * about the hydration mismatch.
 */
export function getLocalTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone
}

export function todayInTimeZone(timeZone: string): PlainDate {
  return instantToPlainDate(Date.now(), timeZone)
}
