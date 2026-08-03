import { describe, expect, it } from 'vitest'
import type { CalendarEventInput, ResolvedEvent, TimedEvent } from './events'
import {
  crossesDayBoundary,
  findConflicts,
  formatEventHomeTimeNote,
  formatEventTimeRange,
  getConflictingEventIds,
  getDaySegments,
  getEventDateKeys,
  getEventDateRange,
  getEventsForDay,
  getHourMarks,
  groupEventsByDay,
  layoutWeekSpans,
  resolveEvents,
} from './events'
import { addDays, plainDateToString } from './temporal'

const LA = 'America/Los_Angeles'
const TOKYO = 'Asia/Tokyo'
const UTC = 'UTC'

const DEC_1 = { year: 2025, month: 12, day: 1 }
const DEC_2 = { year: 2025, month: 12, day: 2 }

function resolve(inputs: CalendarEventInput[], defaultTimeZone = LA): ResolvedEvent[] {
  const { events, errors } = resolveEvents(inputs, { defaultTimeZone })
  expect(errors).toEqual([])
  return events
}

/** A 9:00–10:00am Las Vegas keynote on Dec 1 2025. */
const keynote: CalendarEventInput = {
  id: 'KEY001',
  title: 'Opening Keynote',
  start: '2025-12-01 09:00',
  end: '2025-12-01 10:00',
  timeZone: LA,
}

describe('resolveEvents', () => {
  it('pins a floating datetime to the event timezone', () => {
    const [event] = resolve([keynote]) as TimedEvent[]
    expect(event.startInstant).toBe(Date.UTC(2025, 11, 1, 17))
    expect(event.endInstant).toBe(Date.UTC(2025, 11, 1, 18))
    expect(event.timeZone).toBe(LA)
  })

  it('falls back to durationMinutes, then to one hour', () => {
    const [withDuration, withDefault] = resolve([
      { id: 'a', title: 'A', start: '2025-12-01 09:00', durationMinutes: 30 },
      { id: 'b', title: 'B', start: '2025-12-01 11:00' },
    ]) as TimedEvent[]
    expect(withDuration.endInstant - withDuration.startInstant).toBe(30 * 60_000)
    expect(withDefault.endInstant - withDefault.startInstant).toBe(60 * 60_000)
  })

  it('applies the default timezone when the event omits one', () => {
    const [event] = resolve([{ id: 'a', title: 'A', start: '2025-12-01 09:00' }], TOKYO) as TimedEvent[]
    expect(event.startInstant).toBe(Date.UTC(2025, 11, 1, 0))
  })

  it('supports per-event timezones in one collection', () => {
    const events = resolve([
      { id: 'vegas', title: 'Vegas', start: '2025-12-01 09:00', timeZone: LA },
      { id: 'tokyo', title: 'Tokyo', start: '2025-12-01 09:00', timeZone: TOKYO },
    ]) as TimedEvent[]
    const byId = new Map(events.map((event) => [event.id, event]))
    expect(byId.get('tokyo')!.startInstant).toBe(Date.UTC(2025, 11, 1, 0))
    expect(byId.get('vegas')!.startInstant).toBe(Date.UTC(2025, 11, 1, 17))
  })

  it('collects invalid events instead of throwing', () => {
    const { events, errors } = resolveEvents(
      [
        keynote,
        { id: 'bad', title: 'Backwards', start: '2025-12-01 10:00', end: '2025-12-01 09:00' },
        { id: 'worse', title: 'Garbage', start: 'not-a-date' },
      ],
      { defaultTimeZone: LA },
    )
    expect(events).toHaveLength(1)
    expect(errors).toHaveLength(2)
    expect(errors.map((entry) => entry.input.id)).toEqual(['bad', 'worse'])
  })

  it('treats all-day events as floating dates', () => {
    const events = resolve([
      { id: 'expo', title: 'Expo', start: '2025-12-01', end: '2025-12-03', allDay: true },
    ])
    const [event] = events
    expect(event.allDay).toBe(true)
    // Same dates regardless of the zone used to read them.
    expect(plainDateToString(getEventDateRange(event, TOKYO).start)).toBe('2025-12-01')
    expect(plainDateToString(getEventDateRange(event, TOKYO).end)).toBe('2025-12-03')
    expect(plainDateToString(getEventDateRange(event, LA).start)).toBe('2025-12-01')
  })

  it('sorts all-day events ahead of timed events', () => {
    const events = resolve([
      keynote,
      { id: 'expo', title: 'Expo', start: '2025-12-01', allDay: true },
    ])
    expect(events.map((event) => event.id)).toEqual(['expo', 'KEY001'])
  })
})

describe('getDaySegments — timezone awareness', () => {
  it('places a Vegas keynote at 9am when viewed from Los Angeles', () => {
    const events = resolve([keynote])
    const segments = getDaySegments(events, DEC_1, LA)
    expect(segments).toHaveLength(1)
    expect(segments[0].startMinute).toBe(540) // 09:00
    expect(segments[0].endMinute).toBe(600) // 10:00
  })

  it('moves the same keynote to the next day at 2am when viewed from Tokyo', () => {
    const events = resolve([keynote])
    // Nothing on Dec 1 in Tokyo...
    expect(getDaySegments(events, DEC_1, TOKYO)).toHaveLength(0)
    // ...it lands early on Dec 2.
    const segments = getDaySegments(events, DEC_2, TOKYO)
    expect(segments).toHaveLength(1)
    expect(segments[0].startMinute).toBe(120) // 02:00
    expect(segments[0].endMinute).toBe(180) // 03:00
  })

  it('places it at 17:00 when viewed from UTC', () => {
    const segments = getDaySegments(resolve([keynote]), DEC_1, UTC)
    expect(segments[0].startMinute).toBe(1020)
  })

  it('clamps an event that spans midnight and flags continuation', () => {
    const events = resolve([
      { id: 'party', title: 're:Play', start: '2025-12-04 21:00', end: '2025-12-05 01:00', timeZone: LA },
    ])

    const firstDay = getDaySegments(events, { year: 2025, month: 12, day: 4 }, LA)
    expect(firstDay[0].startMinute).toBe(1260) // 21:00
    expect(firstDay[0].endMinute).toBe(1440) // clamped to midnight
    expect(firstDay[0].continuesAfter).toBe(true)
    expect(firstDay[0].continuesBefore).toBe(false)

    const secondDay = getDaySegments(events, { year: 2025, month: 12, day: 5 }, LA)
    expect(secondDay[0].startMinute).toBe(0)
    expect(secondDay[0].endMinute).toBe(60) // 01:00
    expect(secondDay[0].continuesBefore).toBe(true)
    expect(secondDay[0].continuesAfter).toBe(false)
  })

  it('excludes an event that ends exactly at midnight from the next day', () => {
    const events = resolve([
      { id: 'eve', title: 'Evening', start: '2025-12-01 22:00', end: '2025-12-02 00:00', timeZone: LA },
    ])
    expect(getDaySegments(events, DEC_1, LA)).toHaveLength(1)
    expect(getDaySegments(events, DEC_2, LA)).toHaveLength(0)
  })

  it('includes a zero-length event', () => {
    const events = resolve([
      { id: 'ping', title: 'Reminder', start: '2025-12-01 09:00', end: '2025-12-01 09:00', timeZone: LA },
    ])
    const segments = getDaySegments(events, DEC_1, LA)
    expect(segments).toHaveLength(1)
    expect(segments[0].startMinute).toBe(540)
    expect(segments[0].endMinute).toBe(540)
  })

  it('ignores all-day events in the time grid', () => {
    const events = resolve([{ id: 'expo', title: 'Expo', start: '2025-12-01', allDay: true }])
    expect(getDaySegments(events, DEC_1, LA)).toHaveLength(0)
  })

  it('keeps wall-clock position on a spring-forward day', () => {
    const events = resolve([
      { id: 'dst', title: 'Morning', start: '2025-03-09 09:00', end: '2025-03-09 10:00', timeZone: LA },
    ])
    const segments = getDaySegments(events, { year: 2025, month: 3, day: 9 }, LA)
    // 480 elapsed minutes into a 1380-minute day, still 09:00 on the clock.
    expect(segments[0].startMinute).toBe(480)
  })
})

describe('packSegments — overlap columns', () => {
  it('gives non-overlapping events a single full-width column', () => {
    const events = resolve([
      { id: 'a', title: 'A', start: '2025-12-01 09:00', end: '2025-12-01 10:00' },
      { id: 'b', title: 'B', start: '2025-12-01 10:00', end: '2025-12-01 11:00' },
    ])
    const segments = getDaySegments(events, DEC_1, LA)
    expect(segments.every((segment) => segment.columnCount === 1)).toBe(true)
    expect(segments.every((segment) => segment.column === 0)).toBe(true)
  })

  it('splits two overlapping events into two columns', () => {
    const events = resolve([
      { id: 'a', title: 'A', start: '2025-12-01 09:00', end: '2025-12-01 10:30' },
      { id: 'b', title: 'B', start: '2025-12-01 10:00', end: '2025-12-01 11:00' },
    ])
    const segments = getDaySegments(events, DEC_1, LA)
    expect(segments.map((segment) => segment.columnCount)).toEqual([2, 2])
    expect(new Set(segments.map((segment) => segment.column))).toEqual(new Set([0, 1]))
  })

  it('splits three mutually overlapping events into three columns', () => {
    const events = resolve([
      { id: 'a', title: 'A', start: '2025-12-01 09:00', end: '2025-12-01 12:00' },
      { id: 'b', title: 'B', start: '2025-12-01 09:30', end: '2025-12-01 11:00' },
      { id: 'c', title: 'C', start: '2025-12-01 10:00', end: '2025-12-01 10:30' },
    ])
    const segments = getDaySegments(events, DEC_1, LA)
    expect(segments.every((segment) => segment.columnCount === 3)).toBe(true)
    expect(new Set(segments.map((segment) => segment.column))).toEqual(new Set([0, 1, 2]))
  })

  it('reuses a column once the earlier event has ended', () => {
    const events = resolve([
      { id: 'long', title: 'Long', start: '2025-12-01 09:00', end: '2025-12-01 12:00' },
      { id: 'early', title: 'Early', start: '2025-12-01 09:00', end: '2025-12-01 10:00' },
      { id: 'late', title: 'Late', start: '2025-12-01 10:30', end: '2025-12-01 11:30' },
    ])
    const segments = getDaySegments(events, DEC_1, LA)
    const byId = new Map(segments.map((segment) => [segment.event.id, segment]))
    // "Long" takes column 0; "early" and "late" share column 1 sequentially.
    expect(byId.get('long')!.column).toBe(0)
    expect(byId.get('early')!.column).toBe(1)
    expect(byId.get('late')!.column).toBe(1)
    expect(byId.get('long')!.columnCount).toBe(2)
  })

  it('separates independent clusters', () => {
    const events = resolve([
      { id: 'a', title: 'A', start: '2025-12-01 09:00', end: '2025-12-01 10:00' },
      { id: 'b', title: 'B', start: '2025-12-01 09:30', end: '2025-12-01 10:00' },
      { id: 'c', title: 'C', start: '2025-12-01 14:00', end: '2025-12-01 15:00' },
    ])
    const segments = getDaySegments(events, DEC_1, LA)
    const byId = new Map(segments.map((segment) => [segment.event.id, segment]))
    expect(byId.get('a')!.columnCount).toBe(2)
    expect(byId.get('c')!.columnCount).toBe(1)
  })

  it('gives near-simultaneous short events their own columns', () => {
    const events = resolve([
      { id: 'a', title: 'A', start: '2025-12-01 09:00', end: '2025-12-01 09:05' },
      { id: 'b', title: 'B', start: '2025-12-01 09:05', end: '2025-12-01 09:10' },
    ])
    // They do not truly overlap, but within the 15-minute collision floor they
    // would be drawn on top of each other, so they get separate columns.
    const segments = getDaySegments(events, DEC_1, LA)
    expect(segments.every((segment) => segment.columnCount === 2)).toBe(true)
  })
})

describe('layoutWeekSpans', () => {
  const week = Array.from({ length: 7 }, (_, index) =>
    addDays({ year: 2025, month: 11, day: 30 }, index),
  ) // Sun Nov 30 -> Sat Dec 6

  it('places a single-day event in one cell', () => {
    const events = resolve([keynote])
    const { spans } = layoutWeekSpans(events, week, LA)
    expect(spans).toHaveLength(1)
    expect(spans[0].startIndex).toBe(1) // Monday Dec 1
    expect(spans[0].endIndex).toBe(1)
    expect(spans[0].lane).toBe(0)
  })

  it('spans a multi-day all-day event across cells', () => {
    const events = resolve([
      { id: 'expo', title: 'Expo', start: '2025-12-01', end: '2025-12-04', allDay: true },
    ])
    const { spans } = layoutWeekSpans(events, week, LA)
    expect(spans[0].startIndex).toBe(1)
    expect(spans[0].endIndex).toBe(4)
    expect(spans[0].continuesBefore).toBe(false)
    expect(spans[0].continuesAfter).toBe(false)
  })

  it('clips a span that starts before the week and flags continuation', () => {
    const events = resolve([
      { id: 'long', title: 'Long', start: '2025-11-25', end: '2025-12-10', allDay: true },
    ])
    const { spans } = layoutWeekSpans(events, week, LA)
    expect(spans[0].startIndex).toBe(0)
    expect(spans[0].endIndex).toBe(6)
    expect(spans[0].continuesBefore).toBe(true)
    expect(spans[0].continuesAfter).toBe(true)
  })

  it('stacks overlapping spans into separate lanes', () => {
    const events = resolve([
      { id: 'a', title: 'A', start: '2025-12-01', end: '2025-12-03', allDay: true },
      { id: 'b', title: 'B', start: '2025-12-02', end: '2025-12-04', allDay: true },
    ])
    const { spans, laneCount } = layoutWeekSpans(events, week, LA)
    expect(laneCount).toBe(2)
    expect(new Set(spans.map((span) => span.lane))).toEqual(new Set([0, 1]))
  })

  it('reuses a lane for spans that do not overlap', () => {
    const events = resolve([
      { id: 'a', title: 'A', start: '2025-12-01', end: '2025-12-02', allDay: true },
      { id: 'b', title: 'B', start: '2025-12-04', end: '2025-12-05', allDay: true },
    ])
    const { spans, laneCount } = layoutWeekSpans(events, week, LA)
    expect(laneCount).toBe(1)
    expect(spans.every((span) => span.lane === 0)).toBe(true)
  })

  it('reports overflow per day when lanes are capped', () => {
    const events = resolve([
      { id: 'a', title: 'A', start: '2025-12-01 09:00', end: '2025-12-01 10:00' },
      { id: 'b', title: 'B', start: '2025-12-01 09:00', end: '2025-12-01 10:00' },
      { id: 'c', title: 'C', start: '2025-12-01 09:00', end: '2025-12-01 10:00' },
    ])
    const { spans, overflowByIndex } = layoutWeekSpans(events, week, LA, 2)
    expect(spans).toHaveLength(2)
    expect(overflowByIndex[1]).toBe(1)
  })

  it('shifts a span to the next day when the display timezone moves it', () => {
    const events = resolve([keynote])
    // From Tokyo the Dec 1 keynote is on Dec 2, i.e. column index 2.
    const { spans } = layoutWeekSpans(events, week, TOKYO)
    expect(spans[0].startIndex).toBe(2)
  })
})

describe('grouping', () => {
  it('groups events by display-timezone day', () => {
    const events = resolve([
      keynote,
      { id: 'later', title: 'Later', start: '2025-12-02 09:00', timeZone: LA },
    ])
    const inLA = groupEventsByDay(events, LA)
    expect(inLA.map((group) => group.key)).toEqual(['2025-12-01', '2025-12-02'])

    const inTokyo = groupEventsByDay(events, TOKYO)
    expect(inTokyo.map((group) => group.key)).toEqual(['2025-12-02', '2025-12-03'])
  })

  it('lists a multi-day event under every day it touches', () => {
    const events = resolve([
      { id: 'expo', title: 'Expo', start: '2025-12-01', end: '2025-12-03', allDay: true },
    ])
    const groups = groupEventsByDay(events, LA)
    expect(groups.map((group) => group.key)).toEqual([
      '2025-12-01',
      '2025-12-02',
      '2025-12-03',
    ])
  })

  it('selects the events for a specific day', () => {
    const events = resolve([keynote, { id: 'other', title: 'Other', start: '2025-12-05 09:00' }])
    expect(getEventsForDay(events, DEC_1, LA).map((event) => event.id)).toEqual(['KEY001'])
  })

  it('builds a set of day keys that have events', () => {
    const events = resolve([keynote])
    expect(getEventDateKeys(events, LA).has('2025-12-01')).toBe(true)
    expect(getEventDateKeys(events, TOKYO).has('2025-12-02')).toBe(true)
    expect(getEventDateKeys(events, TOKYO).has('2025-12-01')).toBe(false)
  })
})

describe('findConflicts', () => {
  it('finds an overlapping pair', () => {
    const events = resolve([
      { id: 'a', title: 'A', start: '2025-12-01 09:00', end: '2025-12-01 10:00' },
      { id: 'b', title: 'B', start: '2025-12-01 09:30', end: '2025-12-01 10:30' },
    ])
    const conflicts = findConflicts(events)
    expect(conflicts).toHaveLength(1)
    expect(getConflictingEventIds(events)).toEqual(new Set(['a', 'b']))
  })

  it('does not treat back-to-back events as conflicting', () => {
    const events = resolve([
      { id: 'a', title: 'A', start: '2025-12-01 09:00', end: '2025-12-01 10:00' },
      { id: 'b', title: 'B', start: '2025-12-01 10:00', end: '2025-12-01 11:00' },
    ])
    expect(findConflicts(events)).toHaveLength(0)
  })

  it('is independent of the display timezone', () => {
    const events = resolve([
      { id: 'a', title: 'A', start: '2025-12-01 09:00', end: '2025-12-01 10:00', timeZone: LA },
      { id: 'b', title: 'B', start: '2025-12-02 02:30', end: '2025-12-02 03:30', timeZone: TOKYO },
    ])
    // Different zones and different calendar dates, but the same absolute hour.
    expect(findConflicts(events)).toHaveLength(1)
  })

  it('ignores all-day events', () => {
    const events = resolve([
      { id: 'expo', title: 'Expo', start: '2025-12-01', allDay: true },
      { id: 'expo2', title: 'Expo 2', start: '2025-12-01', allDay: true },
    ])
    expect(findConflicts(events)).toHaveLength(0)
  })
})

describe('display helpers', () => {
  it('formats a time range in the display timezone', () => {
    const [event] = resolve([keynote])
    expect(formatEventTimeRange(event, LA, 'en-US', false)).toBe('09:00 – 10:00')
    expect(formatEventTimeRange(event, TOKYO, 'en-US', false)).toBe('02:00 – 03:00')
  })

  it('labels all-day events', () => {
    const [event] = resolve([{ id: 'expo', title: 'Expo', start: '2025-12-01', allDay: true }])
    expect(formatEventTimeRange(event, LA)).toBe('All day')
  })

  it('adds a home-timezone note only when the zones differ', () => {
    const [event] = resolve([keynote])
    expect(formatEventHomeTimeNote(event, LA)).toBeUndefined()
    const note = formatEventHomeTimeNote(event, TOKYO, 'en-US', false)
    expect(note).toContain('09:00')
    expect(note).toContain('PST')
  })

  it('detects a day-boundary crossing between zones', () => {
    const [event] = resolve([keynote])
    expect(crossesDayBoundary(event, LA)).toBe(false)
    expect(crossesDayBoundary(event, TOKYO)).toBe(true)
  })
})

describe('getHourMarks', () => {
  it('produces 24 marks on an ordinary day', () => {
    expect(getHourMarks(DEC_1, LA)).toHaveLength(24)
  })

  it('produces 23 marks on a spring-forward day', () => {
    expect(getHourMarks({ year: 2025, month: 3, day: 9 }, LA)).toHaveLength(23)
  })

  it('produces 25 marks on a fall-back day', () => {
    expect(getHourMarks({ year: 2025, month: 11, day: 2 }, LA)).toHaveLength(25)
  })
})
