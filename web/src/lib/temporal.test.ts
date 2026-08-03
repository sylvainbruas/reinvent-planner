import { describe, expect, it } from 'vitest'
import {
  AmbiguousTimeError,
  addDays,
  addMonths,
  comparePlainDate,
  dayLengthMinutes,
  differenceInDays,
  formatOffset,
  getOffsetMs,
  hasDstTransition,
  HOUR_MS,
  instantToPlainDateTime,
  isoWeekNumber,
  minutesFromStartOfDay,
  parsePlainDate,
  plainDateTimeToInstant,
  plainDateTimeToString,
  plainDateToString,
  resolveInstant,
  startOfDayInstant,
  startOfWeek,
  weekdayIndex,
  weekdayNames,
} from './temporal'

const LA = 'America/Los_Angeles'
const TOKYO = 'Asia/Tokyo'
const KOLKATA = 'Asia/Kolkata'
const UTC = 'UTC'

describe('getOffsetMs', () => {
  it('reports standard time in winter', () => {
    // 2025-12-01T12:00Z — Pacific Standard Time, UTC-8.
    expect(getOffsetMs(Date.UTC(2025, 11, 1, 12), LA)).toBe(-8 * HOUR_MS)
  })

  it('reports daylight time in summer', () => {
    expect(getOffsetMs(Date.UTC(2025, 6, 1, 12), LA)).toBe(-7 * HOUR_MS)
  })

  it('handles a half-hour offset zone', () => {
    expect(getOffsetMs(Date.UTC(2025, 11, 1, 12), KOLKATA)).toBe(5.5 * HOUR_MS)
  })

  it('is zero for UTC', () => {
    expect(getOffsetMs(Date.UTC(2025, 11, 1, 12), UTC)).toBe(0)
  })
})

describe('formatOffset', () => {
  it('formats whole-hour offsets', () => {
    expect(formatOffset(Date.UTC(2025, 11, 1, 12), LA)).toBe('GMT-8')
    expect(formatOffset(Date.UTC(2025, 6, 1, 12), LA)).toBe('GMT-7')
    expect(formatOffset(Date.UTC(2025, 11, 1, 12), TOKYO)).toBe('GMT+9')
  })

  it('formats fractional offsets', () => {
    expect(formatOffset(Date.UTC(2025, 11, 1, 12), KOLKATA)).toBe('GMT+5:30')
  })

  it('formats UTC without a sign', () => {
    expect(formatOffset(Date.UTC(2025, 11, 1, 12), UTC)).toBe('GMT')
  })
})

describe('instantToPlainDateTime', () => {
  it('converts an instant to the local wall clock', () => {
    const wall = instantToPlainDateTime(Date.UTC(2025, 11, 1, 17, 30), LA)
    expect(plainDateTimeToString(wall)).toBe('2025-12-01T09:30:00')
  })

  it('rolls the date backwards across the day boundary', () => {
    // 2025-12-01T02:00Z is still Nov 30 in Los Angeles.
    const wall = instantToPlainDateTime(Date.UTC(2025, 11, 1, 2), LA)
    expect(plainDateToString(wall)).toBe('2025-11-30')
    expect(wall.hour).toBe(18)
  })

  it('rolls the date forwards across the day boundary', () => {
    // A 9am Las Vegas session is the next calendar day in Tokyo.
    const wall = instantToPlainDateTime(Date.UTC(2025, 11, 1, 17), TOKYO)
    expect(plainDateToString(wall)).toBe('2025-12-02')
    expect(wall.hour).toBe(2)
  })

  it('preserves midnight as hour 0, never hour 24', () => {
    const wall = instantToPlainDateTime(Date.UTC(2025, 11, 1, 8), LA)
    expect(wall.hour).toBe(0)
    expect(plainDateToString(wall)).toBe('2025-12-01')
  })
})

describe('plainDateTimeToInstant — normal times', () => {
  it('round-trips a wall time through an instant', () => {
    const wall = { year: 2025, month: 12, day: 1, hour: 9, minute: 0, second: 0, millisecond: 0 }
    const instant = plainDateTimeToInstant(wall, LA)
    expect(instant).toBe(Date.UTC(2025, 11, 1, 17))
    expect(plainDateTimeToString(instantToPlainDateTime(instant, LA))).toBe(
      '2025-12-01T09:00:00',
    )
  })

  it('resolves the same wall time differently per zone', () => {
    const wall = { year: 2025, month: 12, day: 1, hour: 9, minute: 0, second: 0, millisecond: 0 }
    expect(plainDateTimeToInstant(wall, LA)).toBe(Date.UTC(2025, 11, 1, 17))
    expect(plainDateTimeToInstant(wall, TOKYO)).toBe(Date.UTC(2025, 11, 1, 0))
    expect(plainDateTimeToInstant(wall, UTC)).toBe(Date.UTC(2025, 11, 1, 9))
  })
})

describe('plainDateTimeToInstant — spring-forward gap', () => {
  // In Los Angeles, 2025-03-09 02:00–02:59 local never happened.
  const gap = { year: 2025, month: 3, day: 9, hour: 2, minute: 30, second: 0, millisecond: 0 }

  it('"compatible" shifts forward past the gap', () => {
    const instant = plainDateTimeToInstant(gap, LA, 'compatible')
    expect(instantToPlainDateTime(instant, LA).hour).toBe(3)
  })

  it('"later" shifts forward past the gap', () => {
    const instant = plainDateTimeToInstant(gap, LA, 'later')
    expect(instantToPlainDateTime(instant, LA).hour).toBe(3)
  })

  it('"earlier" shifts back before the gap', () => {
    const instant = plainDateTimeToInstant(gap, LA, 'earlier')
    expect(instantToPlainDateTime(instant, LA).hour).toBe(1)
  })

  it('"reject" throws', () => {
    expect(() => plainDateTimeToInstant(gap, LA, 'reject')).toThrow(AmbiguousTimeError)
  })
})

describe('plainDateTimeToInstant — fall-back overlap', () => {
  // In Los Angeles, 2025-11-02 01:30 local happened twice.
  const overlap = { year: 2025, month: 11, day: 2, hour: 1, minute: 30, second: 0, millisecond: 0 }

  it('"compatible" picks the first (daylight-time) occurrence', () => {
    expect(plainDateTimeToInstant(overlap, LA, 'compatible')).toBe(
      Date.UTC(2025, 10, 2, 8, 30),
    )
  })

  it('"later" picks the second (standard-time) occurrence', () => {
    expect(plainDateTimeToInstant(overlap, LA, 'later')).toBe(Date.UTC(2025, 10, 2, 9, 30))
  })

  it('both occurrences render as the same wall clock', () => {
    const earlier = plainDateTimeToInstant(overlap, LA, 'earlier')
    const later = plainDateTimeToInstant(overlap, LA, 'later')
    expect(later - earlier).toBe(HOUR_MS)
    expect(instantToPlainDateTime(earlier, LA).hour).toBe(1)
    expect(instantToPlainDateTime(later, LA).hour).toBe(1)
  })

  it('"reject" throws', () => {
    expect(() => plainDateTimeToInstant(overlap, LA, 'reject')).toThrow(AmbiguousTimeError)
  })
})

describe('dayLengthMinutes', () => {
  it('is 1440 on an ordinary day', () => {
    expect(dayLengthMinutes({ year: 2025, month: 12, day: 1 }, LA)).toBe(1440)
  })

  it('is 1380 on the spring-forward day', () => {
    expect(dayLengthMinutes({ year: 2025, month: 3, day: 9 }, LA)).toBe(1380)
  })

  it('is 1500 on the fall-back day', () => {
    expect(dayLengthMinutes({ year: 2025, month: 11, day: 2 }, LA)).toBe(1500)
  })

  it('flags transition days', () => {
    expect(hasDstTransition({ year: 2025, month: 3, day: 9 }, LA)).toBe(true)
    expect(hasDstTransition({ year: 2025, month: 12, day: 1 }, LA)).toBe(false)
  })
})

describe('startOfDayInstant', () => {
  it('finds midnight in the target zone', () => {
    expect(startOfDayInstant({ year: 2025, month: 12, day: 1 }, LA)).toBe(
      Date.UTC(2025, 11, 1, 8),
    )
  })

  it('handles a zone where midnight is the previous UTC day', () => {
    expect(startOfDayInstant({ year: 2025, month: 12, day: 1 }, TOKYO)).toBe(
      Date.UTC(2025, 10, 30, 15),
    )
  })
})

describe('minutesFromStartOfDay', () => {
  it('positions a morning session', () => {
    const instant = Date.UTC(2025, 11, 1, 17) // 09:00 LA
    expect(minutesFromStartOfDay(instant, { year: 2025, month: 12, day: 1 }, LA)).toBe(540)
  })

  it('accounts for the skipped hour on a spring-forward day', () => {
    // 2025-03-09 09:00 local is only 480 wall-minutes in, but 420 elapsed minutes.
    const instant = plainDateTimeToInstant(
      { year: 2025, month: 3, day: 9, hour: 9, minute: 0, second: 0, millisecond: 0 },
      LA,
    )
    expect(minutesFromStartOfDay(instant, { year: 2025, month: 3, day: 9 }, LA)).toBe(480)
  })
})

describe('resolveInstant', () => {
  it('treats a floating datetime as wall time in the event zone', () => {
    expect(resolveInstant('2025-12-01 09:00', LA)).toBe(Date.UTC(2025, 11, 1, 17))
    expect(resolveInstant('2025-12-01T09:00', TOKYO)).toBe(Date.UTC(2025, 11, 1, 0))
  })

  it('respects an explicit UTC designator', () => {
    expect(resolveInstant('2025-12-01T09:00:00Z', LA)).toBe(Date.UTC(2025, 11, 1, 9))
  })

  it('respects an explicit numeric offset', () => {
    expect(resolveInstant('2025-12-01T09:00:00-08:00', TOKYO)).toBe(Date.UTC(2025, 11, 1, 17))
  })

  it('passes through epoch milliseconds and Date objects', () => {
    expect(resolveInstant(1_764_608_400_000, LA)).toBe(1_764_608_400_000)
    expect(resolveInstant(new Date(1_764_608_400_000), LA)).toBe(1_764_608_400_000)
  })

  it('rejects unparseable input', () => {
    expect(() => resolveInstant('not a date', LA)).toThrow(RangeError)
  })
})

describe('plain date arithmetic', () => {
  it('adds days across a month boundary', () => {
    expect(plainDateToString(addDays({ year: 2025, month: 11, day: 30 }, 1))).toBe('2025-12-01')
  })

  it('adds days across a year boundary', () => {
    expect(plainDateToString(addDays({ year: 2025, month: 12, day: 31 }, 1))).toBe('2026-01-01')
  })

  it('is unaffected by DST when adding days', () => {
    expect(plainDateToString(addDays({ year: 2025, month: 3, day: 8 }, 1))).toBe('2025-03-09')
    expect(plainDateToString(addDays({ year: 2025, month: 3, day: 9 }, 1))).toBe('2025-03-10')
  })

  it('handles a leap day', () => {
    expect(plainDateToString(addDays({ year: 2024, month: 2, day: 28 }, 1))).toBe('2024-02-29')
    expect(plainDateToString(addDays({ year: 2025, month: 2, day: 28 }, 1))).toBe('2025-03-01')
  })

  it('clamps the day when adding months', () => {
    expect(plainDateToString(addMonths({ year: 2025, month: 1, day: 31 }, 1))).toBe('2025-02-28')
    expect(plainDateToString(addMonths({ year: 2024, month: 1, day: 31 }, 1))).toBe('2024-02-29')
  })

  it('subtracts months across a year boundary', () => {
    expect(plainDateToString(addMonths({ year: 2025, month: 1, day: 15 }, -1))).toBe('2024-12-15')
  })

  it('computes day differences', () => {
    expect(
      differenceInDays({ year: 2025, month: 12, day: 1 }, { year: 2025, month: 12, day: 5 }),
    ).toBe(4)
    expect(
      differenceInDays({ year: 2025, month: 12, day: 5 }, { year: 2025, month: 12, day: 1 }),
    ).toBe(-4)
  })

  it('orders dates', () => {
    expect(
      comparePlainDate({ year: 2025, month: 12, day: 1 }, { year: 2025, month: 12, day: 2 }),
    ).toBeLessThan(0)
    expect(
      comparePlainDate({ year: 2025, month: 12, day: 1 }, { year: 2025, month: 12, day: 1 }),
    ).toBe(0)
  })
})

describe('week helpers', () => {
  it('identifies weekdays', () => {
    // 2025-12-01 was a Monday.
    expect(weekdayIndex({ year: 2025, month: 12, day: 1 })).toBe(1)
    expect(weekdayIndex({ year: 2025, month: 11, day: 30 })).toBe(0)
  })

  it('starts the week on Sunday by default', () => {
    expect(plainDateToString(startOfWeek({ year: 2025, month: 12, day: 3 }))).toBe('2025-11-30')
  })

  it('honours a Monday week start', () => {
    expect(plainDateToString(startOfWeek({ year: 2025, month: 12, day: 3 }, 1))).toBe(
      '2025-12-01',
    )
  })

  it('computes ISO week numbers', () => {
    expect(isoWeekNumber({ year: 2025, month: 12, day: 1 })).toBe(49)
    expect(isoWeekNumber({ year: 2025, month: 1, day: 1 })).toBe(1)
    // 2026-01-01 falls in ISO week 1 of 2026.
    expect(isoWeekNumber({ year: 2026, month: 1, day: 1 })).toBe(1)
  })

  it('orders weekday names from Sunday', () => {
    expect(weekdayNames('en-US', 'short')).toEqual([
      'Sun',
      'Mon',
      'Tue',
      'Wed',
      'Thu',
      'Fri',
      'Sat',
    ])
  })
})

describe('parsing', () => {
  it('parses a date-only string', () => {
    expect(parsePlainDate('2025-12-01')).toEqual({ year: 2025, month: 12, day: 1 })
  })

  it('parses a space-separated datetime, matching the server format', () => {
    const wall = resolveInstant('2025-12-01 14:30', LA)
    expect(instantToPlainDateTime(wall, LA).hour).toBe(14)
    expect(instantToPlainDateTime(wall, LA).minute).toBe(30)
  })

  it('rejects malformed input', () => {
    expect(() => parsePlainDate('12/01/2025')).toThrow(RangeError)
  })
})
