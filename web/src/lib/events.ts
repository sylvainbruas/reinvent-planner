/**
 * Event model and geometry for the calendar views.
 *
 * The central idea: an event carries **its own** timezone — the zone it
 * physically happens in — which is independent of the **display timezone** the
 * viewer is looking at it through. A re:Invent session at 9:00am in Las Vegas
 * is the same instant whether you read it from Nevada or Tokyo, but it lands on
 * a different calendar day and a different row of the grid.
 *
 * Layout is therefore always a function of (event instants, display timezone).
 * Nothing here caches geometry across timezone changes.
 */

import type { Disambiguation, Instant, PlainDate } from './temporal'
import {
  addDays,
  comparePlainDate,
  dayLengthMinutes,
  differenceInDays,
  formatInstant,
  instantToPlainDate,
  isSamePlainDate,
  MINUTE_MS,
  plainDateToString,
  resolveInstant,
  shortTimeZoneName,
  startOfDayInstant,
} from './temporal'

/** Colors are design-system tokens, never literals. */
export type EventColor =
  | 'chart-1'
  | 'chart-2'
  | 'chart-3'
  | 'chart-4'
  | 'chart-5'
  | 'primary'
  | 'destructive'
  | 'muted'

export const EVENT_COLORS: EventColor[] = [
  'chart-1',
  'chart-2',
  'chart-3',
  'chart-4',
  'chart-5',
]

/** Maps a token name to the CSS variable reference the design system defines. */
export function eventColorVar(color: EventColor): string {
  return `var(--${color})`
}

export function eventForegroundVar(color: EventColor): string {
  if (color === 'primary') return 'var(--primary-foreground)'
  if (color === 'destructive') return 'var(--destructive-foreground)'
  if (color === 'muted') return 'var(--muted-foreground)'
  // Chart tokens have no paired foreground token; white reads correctly on all
  // five in both light and dark mode.
  return 'var(--primary-foreground)'
}

/* -------------------------------------------------------------------------- */
/* Input + resolved shapes                                                     */
/* -------------------------------------------------------------------------- */

export interface CalendarEventInput {
  id: string
  title: string
  /**
   * Start of the event. An ISO string with `Z` or an offset is an absolute
   * instant. A *floating* string (`2025-12-01 09:00`) is a wall-clock reading
   * interpreted in `timeZone`.
   */
  start: string | number | Date
  /** End of the event. Falls back to `durationMinutes`, then to one hour. */
  end?: string | number | Date
  durationMinutes?: number
  /** IANA zone the event actually takes place in. */
  timeZone?: string
  /** All-day events are floating: they show on the same date in every zone. */
  allDay?: boolean
  location?: string
  description?: string
  color?: EventColor
  /** How to resolve a floating start/end that hits a DST gap or overlap. */
  disambiguation?: Disambiguation
  meta?: Record<string, unknown>
}

interface ResolvedEventBase {
  id: string
  title: string
  location?: string
  description?: string
  color: EventColor
  meta?: Record<string, unknown>
}

export interface TimedEvent extends ResolvedEventBase {
  allDay: false
  startInstant: Instant
  endInstant: Instant
  /** The zone the event happens in — used to label "event local time". */
  timeZone: string
}

export interface AllDayEvent extends ResolvedEventBase {
  allDay: true
  /** Inclusive start date. */
  startDate: PlainDate
  /** Inclusive end date. */
  endDate: PlainDate
}

export type ResolvedEvent = TimedEvent | AllDayEvent

export function isTimedEvent(event: ResolvedEvent): event is TimedEvent {
  return !event.allDay
}

export function isAllDayEvent(event: ResolvedEvent): event is AllDayEvent {
  return event.allDay
}

export interface ResolveEventsOptions {
  /** Zone applied to events that do not declare one. */
  defaultTimeZone: string
  /** Duration used when neither `end` nor `durationMinutes` is supplied. */
  defaultDurationMinutes?: number
}

/**
 * Turn raw input into resolved events with absolute instants.
 *
 * Invalid rows are collected rather than thrown so one malformed record cannot
 * blank the whole calendar — the caller decides how loudly to fail.
 */
export function resolveEvents(
  inputs: readonly CalendarEventInput[],
  options: ResolveEventsOptions,
): { events: ResolvedEvent[]; errors: Array<{ input: CalendarEventInput; error: Error }> } {
  const defaultDuration = options.defaultDurationMinutes ?? 60
  const events: ResolvedEvent[] = []
  const errors: Array<{ input: CalendarEventInput; error: Error }> = []

  for (const input of inputs) {
    try {
      const timeZone = input.timeZone ?? options.defaultTimeZone
      const base: ResolvedEventBase = {
        id: input.id,
        title: input.title,
        location: input.location,
        description: input.description,
        color: input.color ?? 'chart-1',
        meta: input.meta,
      }

      if (input.allDay) {
        // Floating: read the calendar date directly, with no zone conversion.
        const startDate = toPlainDateLoose(input.start, timeZone)
        const endDate = input.end ? toPlainDateLoose(input.end, timeZone) : startDate
        events.push({
          ...base,
          allDay: true,
          startDate,
          endDate: comparePlainDate(endDate, startDate) < 0 ? startDate : endDate,
        })
        continue
      }

      const startInstant = resolveInstant(input.start, timeZone, input.disambiguation)
      let endInstant: Instant
      if (input.end !== undefined) {
        endInstant = resolveInstant(input.end, timeZone, input.disambiguation)
      } else {
        endInstant = startInstant + (input.durationMinutes ?? defaultDuration) * MINUTE_MS
      }
      if (endInstant < startInstant) {
        throw new RangeError(
          `Event "${input.id}" ends before it starts (${new Date(startInstant).toISOString()} → ${new Date(endInstant).toISOString()})`,
        )
      }

      events.push({ ...base, allDay: false, startInstant, endInstant, timeZone })
    } catch (cause) {
      errors.push({
        input,
        error: cause instanceof Error ? cause : new Error(String(cause)),
      })
    }
  }

  events.sort(compareEvents)
  return { events, errors }
}

function toPlainDateLoose(value: string | number | Date, timeZone: string): PlainDate {
  if (typeof value === 'string') {
    const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value.trim())
    if (match) {
      return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) }
    }
  }
  return instantToPlainDate(resolveInstant(value, timeZone), timeZone)
}

function eventSortInstant(event: ResolvedEvent): number {
  return event.allDay
    ? Date.UTC(event.startDate.year, event.startDate.month - 1, event.startDate.day)
    : event.startInstant
}

export function compareEvents(a: ResolvedEvent, b: ResolvedEvent): number {
  // All-day events sort above timed events on the same day.
  if (a.allDay !== b.allDay) return a.allDay ? -1 : 1
  const delta = eventSortInstant(a) - eventSortInstant(b)
  if (delta !== 0) return delta
  return a.title.localeCompare(b.title)
}

/* -------------------------------------------------------------------------- */
/* Day segments for time-grid views                                            */
/* -------------------------------------------------------------------------- */

/**
 * One event's slice of a single display day, measured in minutes from that
 * day's midnight in the display timezone.
 */
export interface DaySegment {
  event: TimedEvent
  /** Minutes from the start of the display day. Never negative. */
  startMinute: number
  /** Minutes from the start of the display day. Never past the day's length. */
  endMinute: number
  /** The event began before this day — render a flat top edge. */
  continuesBefore: boolean
  /** The event runs past this day — render a flat bottom edge. */
  continuesAfter: boolean
  /** Horizontal slot among mutually overlapping segments. */
  column: number
  /** Total slots in this segment's overlap cluster. */
  columnCount: number
}

/** Minimum minutes a segment occupies for collision purposes, so 5-minute
 *  events still get their own column instead of being drawn on top of another. */
const MIN_COLLISION_MINUTES = 15

/**
 * Slice every timed event that intersects `date` in `displayTimeZone`, then
 * pack overlapping slices into columns.
 *
 * Day length comes from `dayLengthMinutes`, so on a DST transition day the grid
 * is 23 or 25 hours tall and events stay pinned to the correct wall time.
 */
export function getDaySegments(
  events: readonly ResolvedEvent[],
  date: PlainDate,
  displayTimeZone: string,
  options?: { minCollisionMinutes?: number },
): DaySegment[] {
  const dayStart = startOfDayInstant(date, displayTimeZone)
  const dayEnd = startOfDayInstant(addDays(date, 1), displayTimeZone)
  const dayMinutes = (dayEnd - dayStart) / MINUTE_MS

  const segments: DaySegment[] = []
  for (const event of events) {
    if (!isTimedEvent(event)) continue

    const isInstantaneous = event.endInstant === event.startInstant
    const intersects = isInstantaneous
      ? event.startInstant >= dayStart && event.startInstant < dayEnd
      : event.startInstant < dayEnd && event.endInstant > dayStart
    if (!intersects) continue

    const rawStart = (event.startInstant - dayStart) / MINUTE_MS
    const rawEnd = (event.endInstant - dayStart) / MINUTE_MS

    segments.push({
      event,
      startMinute: Math.max(0, Math.min(rawStart, dayMinutes)),
      endMinute: Math.min(dayMinutes, Math.max(rawEnd, 0)),
      continuesBefore: event.startInstant < dayStart,
      continuesAfter: event.endInstant > dayEnd,
      column: 0,
      columnCount: 1,
    })
  }

  return packSegments(segments, options?.minCollisionMinutes ?? MIN_COLLISION_MINUTES)
}

/**
 * Assign columns to overlapping segments.
 *
 * Segments are grouped into clusters of transitively-overlapping items; each
 * cluster is packed greedily into the leftmost free column. `columnCount` is
 * uniform per cluster so every card in a cluster is the same width and the row
 * reads as a set.
 */
export function packSegments(
  segments: DaySegment[],
  minCollisionMinutes = MIN_COLLISION_MINUTES,
): DaySegment[] {
  if (segments.length === 0) return []

  const collisionEnd = (segment: DaySegment) =>
    Math.max(segment.endMinute, segment.startMinute + minCollisionMinutes)

  const sorted = [...segments].sort((a, b) => {
    if (a.startMinute !== b.startMinute) return a.startMinute - b.startMinute
    // Longer events first so they take the leftmost column.
    const lengthDelta = collisionEnd(b) - b.startMinute - (collisionEnd(a) - a.startMinute)
    if (lengthDelta !== 0) return lengthDelta
    return a.event.title.localeCompare(b.event.title)
  })

  let cluster: DaySegment[] = []
  let clusterEnd = -Infinity
  const result: DaySegment[] = []

  const flush = () => {
    if (cluster.length === 0) return
    // Greedy column assignment within the cluster.
    const columnEnds: number[] = []
    for (const segment of cluster) {
      let column = columnEnds.findIndex((end) => end <= segment.startMinute)
      if (column === -1) {
        column = columnEnds.length
        columnEnds.push(collisionEnd(segment))
      } else {
        columnEnds[column] = collisionEnd(segment)
      }
      segment.column = column
    }
    for (const segment of cluster) {
      segment.columnCount = columnEnds.length
      result.push(segment)
    }
    cluster = []
    clusterEnd = -Infinity
  }

  for (const segment of sorted) {
    if (cluster.length > 0 && segment.startMinute >= clusterEnd) flush()
    cluster.push(segment)
    clusterEnd = Math.max(clusterEnd, collisionEnd(segment))
  }
  flush()

  return result
}

/* -------------------------------------------------------------------------- */
/* Week-row spans for the month grid                                           */
/* -------------------------------------------------------------------------- */

/** A horizontal bar spanning one or more day cells inside a single week row. */
export interface WeekSpan {
  event: ResolvedEvent
  /** Column index within the week, 0-6. */
  startIndex: number
  /** Inclusive column index within the week, 0-6. */
  endIndex: number
  /** Stacking row within the cell. */
  lane: number
  /** Event started in an earlier week. */
  continuesBefore: boolean
  /** Event continues into a later week. */
  continuesAfter: boolean
}

export interface WeekSpanLayout {
  spans: WeekSpan[]
  /** Count of events hidden by `maxLanes`, indexed by day column 0-6. */
  overflowByIndex: number[]
  /** Lanes actually used after clamping. */
  laneCount: number
}

/**
 * Resolve an event's inclusive date range as seen from the display timezone.
 * All-day events are floating and are read directly.
 */
export function getEventDateRange(
  event: ResolvedEvent,
  displayTimeZone: string,
): { start: PlainDate; end: PlainDate } {
  if (isAllDayEvent(event)) {
    return { start: event.startDate, end: event.endDate }
  }
  const start = instantToPlainDate(event.startInstant, displayTimeZone)
  // An event ending exactly at midnight belongs to the previous day, not the
  // next one — otherwise a 5pm-midnight session bleeds an empty extra cell.
  const endInstant =
    event.endInstant > event.startInstant ? event.endInstant - 1 : event.endInstant
  const end = instantToPlainDate(endInstant, displayTimeZone)
  return { start, end }
}

/**
 * Lay out event bars across one week row of the month grid.
 *
 * Longer spans are placed first so multi-day bars stay visually continuous, and
 * a lane is reserved across the full width of a span so nothing overlaps it.
 */
export function layoutWeekSpans(
  events: readonly ResolvedEvent[],
  weekDates: readonly PlainDate[],
  displayTimeZone: string,
  maxLanes?: number,
): WeekSpanLayout {
  const weekStart = weekDates[0]
  const weekEnd = weekDates[weekDates.length - 1]
  const candidates: Array<{ event: ResolvedEvent; startIndex: number; endIndex: number; continuesBefore: boolean; continuesAfter: boolean }> = []

  for (const event of events) {
    const { start, end } = getEventDateRange(event, displayTimeZone)
    if (comparePlainDate(end, weekStart) < 0) continue
    if (comparePlainDate(start, weekEnd) > 0) continue

    const rawStartIndex = differenceInDays(weekStart, start)
    const rawEndIndex = differenceInDays(weekStart, end)
    candidates.push({
      event,
      startIndex: Math.max(0, rawStartIndex),
      endIndex: Math.min(weekDates.length - 1, rawEndIndex),
      continuesBefore: rawStartIndex < 0,
      continuesAfter: rawEndIndex > weekDates.length - 1,
    })
  }

  candidates.sort((a, b) => {
    const spanDelta = b.endIndex - b.startIndex - (a.endIndex - a.startIndex)
    if (spanDelta !== 0) return spanDelta
    if (a.startIndex !== b.startIndex) return a.startIndex - b.startIndex
    return compareEvents(a.event, b.event)
  })

  const occupancy: boolean[][] = []
  const spans: WeekSpan[] = []
  const overflowByIndex = new Array(weekDates.length).fill(0)
  let laneCount = 0

  for (const candidate of candidates) {
    let lane = 0
    for (;;) {
      if (!occupancy[lane]) occupancy[lane] = new Array(weekDates.length).fill(false)
      const row = occupancy[lane]
      let free = true
      for (let index = candidate.startIndex; index <= candidate.endIndex; index += 1) {
        if (row[index]) {
          free = false
          break
        }
      }
      if (free) break
      lane += 1
    }

    if (maxLanes !== undefined && lane >= maxLanes) {
      for (let index = candidate.startIndex; index <= candidate.endIndex; index += 1) {
        overflowByIndex[index] += 1
      }
      continue
    }

    for (let index = candidate.startIndex; index <= candidate.endIndex; index += 1) {
      occupancy[lane][index] = true
    }
    laneCount = Math.max(laneCount, lane + 1)
    spans.push({ ...candidate, lane })
  }

  return { spans, overflowByIndex, laneCount }
}

/* -------------------------------------------------------------------------- */
/* Grouping + conflicts                                                        */
/* -------------------------------------------------------------------------- */

export interface EventDayGroup {
  date: PlainDate
  key: string
  events: ResolvedEvent[]
}

/**
 * Group events by display-timezone calendar day for the agenda view.
 * A multi-day event appears under every day it touches.
 */
export function groupEventsByDay(
  events: readonly ResolvedEvent[],
  displayTimeZone: string,
): EventDayGroup[] {
  const groups = new Map<string, EventDayGroup>()

  for (const event of events) {
    const { start, end } = getEventDateRange(event, displayTimeZone)
    const span = Math.max(0, differenceInDays(start, end))
    for (let offset = 0; offset <= span; offset += 1) {
      const date = addDays(start, offset)
      const key = plainDateToString(date)
      let group = groups.get(key)
      if (!group) {
        group = { date, key, events: [] }
        groups.set(key, group)
      }
      group.events.push(event)
    }
  }

  const ordered = [...groups.values()].sort((a, b) => comparePlainDate(a.date, b.date))
  for (const group of ordered) group.events.sort(compareEvents)
  return ordered
}

export function getEventsForDay(
  events: readonly ResolvedEvent[],
  date: PlainDate,
  displayTimeZone: string,
): ResolvedEvent[] {
  return events
    .filter((event) => {
      const { start, end } = getEventDateRange(event, displayTimeZone)
      return comparePlainDate(date, start) >= 0 && comparePlainDate(date, end) <= 0
    })
    .sort(compareEvents)
}

/** Days that have at least one event — drives the dots under picker days. */
export function getEventDateKeys(
  events: readonly ResolvedEvent[],
  displayTimeZone: string,
): Set<string> {
  const keys = new Set<string>()
  for (const event of events) {
    const { start, end } = getEventDateRange(event, displayTimeZone)
    const span = Math.max(0, differenceInDays(start, end))
    for (let offset = 0; offset <= span; offset += 1) {
      keys.add(plainDateToString(addDays(start, offset)))
    }
  }
  return keys
}

/**
 * Pairs of timed events that overlap in absolute time.
 *
 * Deliberately timezone-independent: a scheduling clash is a clash no matter
 * which zone you view it from. Uses a sweep over start-ordered events rather
 * than an O(n²) scan.
 */
export function findConflicts(
  events: readonly ResolvedEvent[],
): Array<[TimedEvent, TimedEvent]> {
  const timed = events.filter(isTimedEvent).sort((a, b) => a.startInstant - b.startInstant)
  const conflicts: Array<[TimedEvent, TimedEvent]> = []

  for (let i = 0; i < timed.length; i += 1) {
    for (let j = i + 1; j < timed.length; j += 1) {
      if (timed[j].startInstant >= timed[i].endInstant) break
      if (timed[j].startInstant < timed[i].endInstant && timed[j].endInstant > timed[i].startInstant) {
        conflicts.push([timed[i], timed[j]])
      }
    }
  }
  return conflicts
}

/** Set of event ids involved in at least one conflict. */
export function getConflictingEventIds(events: readonly ResolvedEvent[]): Set<string> {
  const ids = new Set<string>()
  for (const [a, b] of findConflicts(events)) {
    ids.add(a.id)
    ids.add(b.id)
  }
  return ids
}

/* -------------------------------------------------------------------------- */
/* Display helpers                                                             */
/* -------------------------------------------------------------------------- */

export function formatEventTimeRange(
  event: ResolvedEvent,
  displayTimeZone: string,
  locale?: string,
  hour12?: boolean,
): string {
  if (isAllDayEvent(event)) return 'All day'
  const timeOptions: Intl.DateTimeFormatOptions = {
    hour: 'numeric',
    minute: '2-digit',
    ...(hour12 === undefined ? {} : { hour12 }),
  }
  const start = formatInstant(event.startInstant, displayTimeZone, timeOptions, locale)
  if (event.endInstant === event.startInstant) return start
  const end = formatInstant(event.endInstant, displayTimeZone, timeOptions, locale)
  return `${start} – ${end}`
}

/**
 * When the viewer's zone differs from the event's own zone, describe the event
 * in its home zone so the local time is never the only reading available.
 * Returns `undefined` when the zones agree and the note would be noise.
 */
export function formatEventHomeTimeNote(
  event: ResolvedEvent,
  displayTimeZone: string,
  locale?: string,
  hour12?: boolean,
): string | undefined {
  if (isAllDayEvent(event)) return undefined
  if (event.timeZone === displayTimeZone) return undefined

  const displayOffset = formatInstant(event.startInstant, displayTimeZone, {
    timeZoneName: 'short',
  })
  const homeOffset = formatInstant(event.startInstant, event.timeZone, {
    timeZoneName: 'short',
  })
  // Zones that are merely aliases (Europe/Paris vs Europe/Berlin) render
  // identically; suppress the note in that case too.
  if (displayOffset === homeOffset) return undefined

  const range = formatEventTimeRange(
    { ...event, timeZone: event.timeZone },
    event.timeZone,
    locale,
    hour12,
  )
  return `${range} ${shortTimeZoneName(event.startInstant, event.timeZone, locale)}`
}

/** True when the event lands on a different calendar day in the two zones. */
export function crossesDayBoundary(
  event: ResolvedEvent,
  displayTimeZone: string,
): boolean {
  if (isAllDayEvent(event)) return false
  return !isSamePlainDate(
    instantToPlainDate(event.startInstant, displayTimeZone),
    instantToPlainDate(event.startInstant, event.timeZone),
  )
}

/**
 * Hour marks for a time-grid column, honouring DST.
 * On a spring-forward day the skipped hour is simply absent from the result.
 */
export function getHourMarks(
  date: PlainDate,
  displayTimeZone: string,
): Array<{ minute: number; instant: Instant }> {
  const dayStart = startOfDayInstant(date, displayTimeZone)
  const minutes = dayLengthMinutes(date, displayTimeZone)
  const marks: Array<{ minute: number; instant: Instant }> = []
  for (let minute = 0; minute < minutes; minute += 60) {
    marks.push({ minute, instant: dayStart + minute * MINUTE_MS })
  }
  return marks
}
