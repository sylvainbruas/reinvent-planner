import * as React from 'react'
import {
  AlertTriangleIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ClockIcon,
  GlobeIcon,
  MapPinIcon,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { PlainDate } from '@/lib/temporal'
import {
  addDays,
  addMonths,
  dayLengthMinutes,
  formatInstant,
  formatOffset,
  formatPlainDate,
  instantToPlainDate,
  isSameMonth,
  isSamePlainDate,
  MINUTE_MS,
  plainDateToString,
  shortTimeZoneName,
  startOfDayInstant,
  startOfMonth,
  startOfWeek,
  todayInTimeZone,
  weekdayNames,
} from '@/lib/temporal'
import type { DaySegment, ResolvedEvent, WeekSpan } from '@/lib/events'
import {
  eventColorVar,
  eventForegroundVar,
  formatEventHomeTimeNote,
  formatEventTimeRange,
  getConflictingEventIds,
  getDaySegments,
  getEventsForDay,
  getHourMarks,
  isAllDayEvent,
  layoutWeekSpans,
} from '@/lib/events'

export type CalendarView = 'month' | 'week' | 'day' | 'agenda'

export interface EventCalendarProps {
  /** Already-resolved events. Build these with `resolveEvents`. */
  events: readonly ResolvedEvent[]
  /**
   * The timezone the grid is drawn in. Changing this re-lays out every event;
   * it does not mutate the events themselves.
   */
  displayTimeZone: string
  view?: CalendarView
  defaultView?: CalendarView
  onViewChange?: (view: CalendarView) => void
  /** Anchor date controlling which month/week/day is shown. */
  date?: Date
  defaultDate?: Date
  onDateChange?: (date: Date) => void
  locale?: string
  hour12?: boolean
  weekStartsOn?: 0 | 1 | 2 | 3 | 4 | 5 | 6
  /** Height of one hour row in the time grid. */
  hourHeight?: string
  /** Hour the time grid scrolls to on mount. */
  scrollToHour?: number
  /** Outline events that clash in absolute time. */
  highlightConflicts?: boolean
  /** Max event bars per day cell in month view before "+N more". */
  maxEventsPerDay?: number
  selectedEventId?: string
  onEventClick?: (event: ResolvedEvent) => void
  onDayClick?: (date: Date) => void
  /** Override "now" for the current-time indicator. Useful in tests. */
  now?: Date
  className?: string
}

const VIEW_LABELS: Array<{ value: CalendarView; label: string }> = [
  { value: 'month', label: 'Month' },
  { value: 'week', label: 'Week' },
  { value: 'day', label: 'Day' },
  { value: 'agenda', label: 'Agenda' },
]

/* -------------------------------------------------------------------------- */
/* Shell                                                                       */
/* -------------------------------------------------------------------------- */

export function EventCalendar({
  events,
  displayTimeZone,
  view: viewProp,
  defaultView = 'week',
  onViewChange,
  date: dateProp,
  defaultDate,
  onDateChange,
  locale,
  hour12,
  weekStartsOn = 0,
  hourHeight = '3rem',
  scrollToHour = 7,
  highlightConflicts = true,
  maxEventsPerDay = 3,
  selectedEventId,
  onEventClick,
  onDayClick,
  now: nowProp,
  className,
}: EventCalendarProps) {
  const [internalView, setInternalView] = React.useState<CalendarView>(defaultView)
  const view = viewProp ?? internalView

  const today = React.useMemo(
    () =>
      nowProp
        ? instantToPlainDate(nowProp.getTime(), displayTimeZone)
        : todayInTimeZone(displayTimeZone),
    [nowProp, displayTimeZone],
  )

  const [internalDate, setInternalDate] = React.useState<PlainDate>(() =>
    defaultDate ? instantToPlainDate(defaultDate.getTime(), displayTimeZone) : today,
  )
  const anchorDate = dateProp
    ? instantToPlainDate(dateProp.getTime(), displayTimeZone)
    : internalDate

  const changeView = (next: CalendarView) => {
    if (!viewProp) setInternalView(next)
    onViewChange?.(next)
  }

  const changeDate = React.useCallback(
    (next: PlainDate) => {
      if (!dateProp) setInternalDate(next)
      onDateChange?.(new Date(startOfDayInstant(next, displayTimeZone)))
    },
    [dateProp, displayTimeZone, onDateChange],
  )

  const step = (direction: 1 | -1) => {
    if (view === 'month') changeDate(addMonths(anchorDate, direction))
    else if (view === 'week') changeDate(addDays(anchorDate, direction * 7))
    else if (view === 'day') changeDate(addDays(anchorDate, direction))
    else changeDate(addDays(anchorDate, direction * 7))
  }

  const conflictIds = React.useMemo(
    () => (highlightConflicts ? getConflictingEventIds(events) : new Set<string>()),
    [events, highlightConflicts],
  )

  const nowInstant = nowProp ? nowProp.getTime() : Date.now()

  const zoneAbbreviation = shortTimeZoneName(nowInstant, displayTimeZone, locale)
  const zoneOffset = formatOffset(nowInstant, displayTimeZone)

  const rangeLabel = React.useMemo(() => {
    if (view === 'month') {
      return formatPlainDate(anchorDate, { month: 'long', year: 'numeric' }, locale)
    }
    if (view === 'day') {
      return formatPlainDate(
        anchorDate,
        { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' },
        locale,
      )
    }
    const start = startOfWeek(anchorDate, weekStartsOn)
    const end = addDays(start, 6)
    const sameMonth = isSameMonth(start, end)
    const startLabel = formatPlainDate(
      start,
      sameMonth ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric' },
      locale,
    )
    const endLabel = formatPlainDate(
      end,
      sameMonth
        ? { day: 'numeric', year: 'numeric' }
        : { month: 'short', day: 'numeric', year: 'numeric' },
      locale,
    )
    return `${startLabel} – ${endLabel}`
  }, [anchorDate, locale, view, weekStartsOn])

  const sharedViewProps = {
    events,
    displayTimeZone,
    locale,
    hour12,
    conflictIds,
    selectedEventId,
    onEventClick,
    today,
    nowInstant,
  }

  return (
    <div
      data-slot="event-calendar"
      className={cn('flex min-h-0 flex-1 flex-col overflow-hidden bg-background', className)}
    >
      <header className="flex flex-wrap items-center gap-2 border-b px-4 py-3 lg:px-6">
        <div className="flex items-center gap-1">
          <Button variant="outline" size="sm" onClick={() => changeDate(today)}>
            Today
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Previous period"
            onClick={() => step(-1)}
          >
            <ChevronLeftIcon />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Next period"
            onClick={() => step(1)}
          >
            <ChevronRightIcon />
          </Button>
        </div>

        <h2 className="text-base font-medium">{rangeLabel}</h2>

        {/* The display timezone is always visible — the reading of every time on
            screen depends on it, so it should never be implicit. */}
        <span
          className="inline-flex items-center gap-1.5 rounded-md bg-muted px-2 py-1 text-xs text-muted-foreground"
          title={`All times shown in ${displayTimeZone}`}
        >
          <GlobeIcon className="size-3" aria-hidden="true" />
          {zoneAbbreviation}
          {/* Zones with no abbreviation report the offset as their short name, so
              only append the offset when it adds information. */}
          {zoneOffset !== zoneAbbreviation && (
            <span className="opacity-60">{zoneOffset}</span>
          )}
        </span>

        <div
          role="tablist"
          aria-label="Calendar view"
          className="ml-auto inline-flex items-center gap-1 rounded-md bg-muted p-1"
        >
          {VIEW_LABELS.map((entry) => (
            <Button
              key={entry.value}
              role="tab"
              aria-selected={view === entry.value}
              variant={view === entry.value ? 'default' : 'ghost'}
              size="sm"
              onClick={() => changeView(entry.value)}
            >
              {entry.label}
            </Button>
          ))}
        </div>
      </header>

      {view === 'month' && (
        <MonthView
          {...sharedViewProps}
          month={anchorDate}
          weekStartsOn={weekStartsOn}
          maxEventsPerDay={maxEventsPerDay}
          onDayClick={(date) => {
            onDayClick?.(new Date(startOfDayInstant(date, displayTimeZone)))
            changeDate(date)
          }}
        />
      )}

      {(view === 'week' || view === 'day') && (
        <TimeGridView
          {...sharedViewProps}
          dates={
            view === 'day'
              ? [anchorDate]
              : Array.from({ length: 7 }, (_, index) =>
                  addDays(startOfWeek(anchorDate, weekStartsOn), index),
                )
          }
          hourHeight={hourHeight}
          scrollToHour={scrollToHour}
        />
      )}

      {view === 'agenda' && (
        <AgendaView
          {...sharedViewProps}
          from={startOfWeek(anchorDate, weekStartsOn)}
          days={14}
        />
      )}
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* Shared view props                                                           */
/* -------------------------------------------------------------------------- */

interface SharedViewProps {
  events: readonly ResolvedEvent[]
  displayTimeZone: string
  locale?: string
  hour12?: boolean
  conflictIds: Set<string>
  selectedEventId?: string
  onEventClick?: (event: ResolvedEvent) => void
  today: PlainDate
  nowInstant: number
}

/* -------------------------------------------------------------------------- */
/* Month view                                                                  */
/* -------------------------------------------------------------------------- */

interface MonthViewProps extends SharedViewProps {
  month: PlainDate
  weekStartsOn: number
  maxEventsPerDay: number
  onDayClick: (date: PlainDate) => void
}

function MonthView({
  events,
  displayTimeZone,
  locale,
  hour12,
  conflictIds,
  selectedEventId,
  onEventClick,
  today,
  month,
  weekStartsOn,
  maxEventsPerDay,
  onDayClick,
}: MonthViewProps) {
  const weeks = React.useMemo(() => {
    const gridStart = startOfWeek(startOfMonth(month), weekStartsOn)
    return Array.from({ length: 6 }, (_, weekIndex) =>
      Array.from({ length: 7 }, (_, dayIndex) =>
        addDays(gridStart, weekIndex * 7 + dayIndex),
      ),
    )
  }, [month, weekStartsOn])

  const labels = React.useMemo(() => {
    const names = weekdayNames(locale, 'short')
    return Array.from({ length: 7 }, (_, index) => names[(index + weekStartsOn) % 7])
  }, [locale, weekStartsOn])

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-auto">
      <div className="sticky top-0 z-10 grid grid-cols-7 border-b bg-background">
        {labels.map((label) => (
          <div
            key={label}
            className="px-2 py-2 text-center text-xs font-medium text-muted-foreground"
          >
            {label}
          </div>
        ))}
      </div>

      <div className="grid flex-1 auto-rows-fr">
        {weeks.map((week) => (
          <MonthWeekRow
            key={plainDateToString(week[0])}
            week={week}
            month={month}
            events={events}
            displayTimeZone={displayTimeZone}
            locale={locale}
            hour12={hour12}
            conflictIds={conflictIds}
            selectedEventId={selectedEventId}
            onEventClick={onEventClick}
            today={today}
            maxEventsPerDay={maxEventsPerDay}
            onDayClick={onDayClick}
          />
        ))}
      </div>
    </div>
  )
}

interface MonthWeekRowProps {
  week: PlainDate[]
  month: PlainDate
  events: readonly ResolvedEvent[]
  displayTimeZone: string
  locale?: string
  hour12?: boolean
  conflictIds: Set<string>
  selectedEventId?: string
  onEventClick?: (event: ResolvedEvent) => void
  today: PlainDate
  maxEventsPerDay: number
  onDayClick: (date: PlainDate) => void
}

function MonthWeekRow({
  week,
  month,
  events,
  displayTimeZone,
  locale,
  hour12,
  conflictIds,
  selectedEventId,
  onEventClick,
  today,
  maxEventsPerDay,
  onDayClick,
}: MonthWeekRowProps) {
  const layout = React.useMemo(
    () => layoutWeekSpans(events, week, displayTimeZone, maxEventsPerDay),
    [events, week, displayTimeZone, maxEventsPerDay],
  )

  return (
    <div className="relative grid min-h-24 grid-cols-7">
      {week.map((date) => {
        const isOutside = !isSameMonth(date, month)
        const isToday = isSamePlainDate(date, today)
        return (
          <button
            type="button"
            key={plainDateToString(date)}
            onClick={() => onDayClick(date)}
            aria-label={formatPlainDate(
              date,
              { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' },
              locale,
            )}
            className={cn(
              'flex cursor-pointer flex-col items-start gap-1 border-r border-b p-1 text-left align-top transition-colors hover:bg-accent/50 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none',
              isOutside && 'bg-muted/30',
            )}
          >
            <span
              className={cn(
                'inline-flex size-6 items-center justify-center rounded-full text-xs',
                isToday && 'bg-primary text-primary-foreground',
                isOutside && 'text-muted-foreground',
              )}
            >
              {date.day}
            </span>
          </button>
        )
      })}

      {/* Event bars are absolutely positioned over the cell grid so a
          multi-day event can be one continuous bar instead of seven chips. */}
      <div className="pointer-events-none absolute inset-x-0 top-8 bottom-1">
        {layout.spans.map((span) => (
          <MonthEventBar
            key={`${span.event.id}-${span.startIndex}`}
            span={span}
            displayTimeZone={displayTimeZone}
            locale={locale}
            hour12={hour12}
            isConflicting={conflictIds.has(span.event.id)}
            isSelected={selectedEventId === span.event.id}
            onEventClick={onEventClick}
          />
        ))}

        {layout.overflowByIndex.map((count, index) =>
          count > 0 ? (
            <span
              key={`overflow-${index}`}
              className="pointer-events-auto absolute text-[0.7rem] font-medium text-muted-foreground"
              style={{
                left: `calc(${(index / 7) * 100}% + 0.25rem)`,
                top: `calc(${layout.laneCount} * 1.25rem)`,
              }}
            >
              +{count} more
            </span>
          ) : null,
        )}
      </div>
    </div>
  )
}

function MonthEventBar({
  span,
  displayTimeZone,
  locale,
  hour12,
  isConflicting,
  isSelected,
  onEventClick,
}: {
  span: WeekSpan
  displayTimeZone: string
  locale?: string
  hour12?: boolean
  isConflicting: boolean
  isSelected: boolean
  onEventClick?: (event: ResolvedEvent) => void
}) {
  const { event } = span
  const width = ((span.endIndex - span.startIndex + 1) / 7) * 100
  const left = (span.startIndex / 7) * 100
  const allDay = isAllDayEvent(event)

  return (
    <button
      type="button"
      onClick={() => onEventClick?.(event)}
      title={`${event.title} — ${formatEventTimeRange(event, displayTimeZone, locale, hour12)}`}
      className={cn(
        'pointer-events-auto absolute flex h-5 items-center gap-1 overflow-hidden rounded px-1 text-left text-[0.7rem] leading-none transition-opacity hover:opacity-80 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none',
        span.continuesBefore && 'rounded-s-none',
        span.continuesAfter && 'rounded-e-none',
        isSelected && 'ring-2 ring-ring',
        isConflicting && 'ring-1 ring-destructive',
      )}
      style={{
        left: `calc(${left}% + 0.25rem)`,
        width: `calc(${width}% - 0.5rem)`,
        top: `calc(${span.lane} * 1.25rem)`,
        backgroundColor: allDay ? eventColorVar(event.color) : 'transparent',
        color: allDay ? eventForegroundVar(event.color) : 'var(--foreground)',
      }}
    >
      {!allDay && (
        <span
          aria-hidden="true"
          className="size-1.5 shrink-0 rounded-full"
          style={{ backgroundColor: eventColorVar(event.color) }}
        />
      )}
      {!allDay && (
        <span className="shrink-0 tabular-nums opacity-70">
          {formatInstant(
            event.startInstant,
            displayTimeZone,
            { hour: 'numeric', ...(hour12 === undefined ? {} : { hour12 }) },
            locale,
          )}
        </span>
      )}
      <span className="truncate font-medium">{event.title}</span>
    </button>
  )
}

/* -------------------------------------------------------------------------- */
/* Time grid (week + day)                                                      */
/* -------------------------------------------------------------------------- */

interface TimeGridViewProps extends SharedViewProps {
  dates: PlainDate[]
  hourHeight: string
  scrollToHour: number
}

function TimeGridView({
  events,
  displayTimeZone,
  locale,
  hour12,
  conflictIds,
  selectedEventId,
  onEventClick,
  today,
  nowInstant,
  dates,
  hourHeight,
  scrollToHour,
}: TimeGridViewProps) {
  const scrollRef = React.useRef<HTMLDivElement>(null)
  const didScroll = React.useRef(false)

  // Wait for layout before measuring: on the first commit the rows have no
  // height yet, so reading clientHeight immediately scrolls by zero.
  React.useEffect(() => {
    if (didScroll.current) return
    let frame = 0
    frame = requestAnimationFrame(() => {
      const container = scrollRef.current
      if (!container) return
      const row = container.querySelector<HTMLElement>('[data-hour-row]')
      const rowHeight = row?.getBoundingClientRect().height ?? 0
      if (rowHeight <= 0) return
      container.scrollTop = rowHeight * scrollToHour
      didScroll.current = true
    })
    return () => cancelAnimationFrame(frame)
  }, [scrollToHour])

  // Hour marks come from the first column; a DST day yields 23 or 25 of them.
  const hourMarks = React.useMemo(
    () => getHourMarks(dates[0], displayTimeZone),
    [dates, displayTimeZone],
  )

  const allDayEvents = React.useMemo(
    () => events.filter(isAllDayEvent),
    [events],
  )
  const allDayLayout = React.useMemo(
    () =>
      allDayEvents.length > 0
        ? layoutWeekSpans(allDayEvents, dates, displayTimeZone)
        : undefined,
    [allDayEvents, dates, displayTimeZone],
  )

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Column headers */}
      <div className="flex border-b pr-2">
        <div className="w-16 shrink-0" />
        {dates.map((date) => {
          const isToday = isSamePlainDate(date, today)
          const dstDay = dayLengthMinutes(date, displayTimeZone) !== 1440
          return (
            <div
              key={plainDateToString(date)}
              className="flex flex-1 flex-col items-center gap-0.5 border-l py-2"
            >
              <span className="text-xs text-muted-foreground">
                {formatPlainDate(date, { weekday: 'short' }, locale)}
              </span>
              <span
                className={cn(
                  'inline-flex size-7 items-center justify-center rounded-full text-sm font-medium',
                  isToday && 'bg-primary text-primary-foreground',
                )}
              >
                {date.day}
              </span>
              {dstDay && (
                <span
                  className="inline-flex items-center gap-0.5 text-[0.65rem] text-muted-foreground"
                  title={`Clocks change on this day — it is ${dayLengthMinutes(date, displayTimeZone) / 60} hours long in ${displayTimeZone}`}
                >
                  <ClockIcon className="size-2.5" aria-hidden="true" />
                  {dayLengthMinutes(date, displayTimeZone) / 60}h
                </span>
              )}
            </div>
          )
        })}
      </div>

      {/* All-day row */}
      {allDayLayout && allDayLayout.spans.length > 0 && (
        <div className="flex border-b pr-2">
          <div className="flex w-16 shrink-0 items-start justify-end pr-2 pt-1 text-[0.7rem] text-muted-foreground">
            all-day
          </div>
          <div
            className="relative flex-1"
            style={{ height: `calc(${allDayLayout.laneCount} * 1.5rem + 0.5rem)` }}
          >
            {allDayLayout.spans.map((span) => (
              <button
                type="button"
                key={span.event.id}
                onClick={() => onEventClick?.(span.event)}
                className="absolute flex h-5 items-center overflow-hidden rounded px-1.5 text-left text-xs font-medium hover:opacity-80 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
                style={{
                  left: `calc(${(span.startIndex / dates.length) * 100}% + 0.125rem)`,
                  width: `calc(${((span.endIndex - span.startIndex + 1) / dates.length) * 100}% - 0.25rem)`,
                  top: `calc(${span.lane} * 1.5rem + 0.25rem)`,
                  backgroundColor: eventColorVar(span.event.color),
                  color: eventForegroundVar(span.event.color),
                }}
              >
                <span className="truncate">{span.event.title}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Scrollable time grid */}
      <div ref={scrollRef} className="flex min-h-0 flex-1 overflow-auto">
        {/* Hour gutter */}
        <div className="w-16 shrink-0">
          {hourMarks.map((mark) => (
            <div
              key={mark.minute}
              data-hour-row
              className="relative border-b text-right"
              style={{ height: hourHeight }}
            >
              <span className="absolute -top-2 right-2 bg-background px-1 text-[0.7rem] text-muted-foreground tabular-nums">
                {formatInstant(
                  mark.instant,
                  displayTimeZone,
                  { hour: 'numeric', ...(hour12 === undefined ? {} : { hour12 }) },
                  locale,
                )}
              </span>
            </div>
          ))}
        </div>

        {/* Day columns. `items-start` stops the columns from being stretched to
            the scroll viewport height — each one sizes to its own hour count so
            percentage-positioned events resolve against the real day height. */}
        <div className="flex flex-1 items-start pr-2">
          {dates.map((date) => (
            <DayColumn
              key={plainDateToString(date)}
              date={date}
              events={events}
              displayTimeZone={displayTimeZone}
              locale={locale}
              hour12={hour12}
              conflictIds={conflictIds}
              selectedEventId={selectedEventId}
              onEventClick={onEventClick}
              nowInstant={nowInstant}
              hourHeight={hourHeight}
            />
          ))}
        </div>
      </div>
    </div>
  )
}

function DayColumn({
  date,
  events,
  displayTimeZone,
  locale,
  hour12,
  conflictIds,
  selectedEventId,
  onEventClick,
  nowInstant,
  hourHeight,
}: {
  date: PlainDate
  events: readonly ResolvedEvent[]
  displayTimeZone: string
  locale?: string
  hour12?: boolean
  conflictIds: Set<string>
  selectedEventId?: string
  onEventClick?: (event: ResolvedEvent) => void
  nowInstant: number
  hourHeight: string
}) {
  const dayMinutes = dayLengthMinutes(date, displayTimeZone)
  const segments = React.useMemo(
    () => getDaySegments(events, date, displayTimeZone),
    [events, date, displayTimeZone],
  )
  const marks = React.useMemo(
    () => getHourMarks(date, displayTimeZone),
    [date, displayTimeZone],
  )

  const dayStart = startOfDayInstant(date, displayTimeZone)
  const nowMinute = (nowInstant - dayStart) / MINUTE_MS
  const showNow = nowMinute >= 0 && nowMinute <= dayMinutes

  return (
    <div
      className="relative flex-1 border-l"
      // Explicit height, derived from this column's own hour count, so a 23- or
      // 25-hour DST day is physically the right size.
      style={{ height: `calc(${marks.length} * ${hourHeight})` }}
    >
      {marks.map((mark) => (
        <div key={mark.minute} className="border-b" style={{ height: hourHeight }} />
      ))}

      {segments.map((segment) => (
        <TimeGridEvent
          key={`${segment.event.id}-${plainDateToString(date)}`}
          segment={segment}
          dayMinutes={dayMinutes}
          displayTimeZone={displayTimeZone}
          locale={locale}
          hour12={hour12}
          isConflicting={conflictIds.has(segment.event.id)}
          isSelected={selectedEventId === segment.event.id}
          onEventClick={onEventClick}
        />
      ))}

      {showNow && (
        <div
          className="pointer-events-none absolute inset-x-0 z-20 flex items-center"
          style={{ top: `${(nowMinute / dayMinutes) * 100}%` }}
          aria-hidden="true"
        >
          <span className="size-2 shrink-0 rounded-full bg-destructive" />
          <span className="h-px flex-1 bg-destructive" />
        </div>
      )}
    </div>
  )
}

function TimeGridEvent({
  segment,
  dayMinutes,
  displayTimeZone,
  locale,
  hour12,
  isConflicting,
  isSelected,
  onEventClick,
}: {
  segment: DaySegment
  dayMinutes: number
  displayTimeZone: string
  locale?: string
  hour12?: boolean
  isConflicting: boolean
  isSelected: boolean
  onEventClick?: (event: ResolvedEvent) => void
}) {
  const { event } = segment
  const top = (segment.startMinute / dayMinutes) * 100
  const height = ((segment.endMinute - segment.startMinute) / dayMinutes) * 100
  const width = 100 / segment.columnCount
  const homeNote = formatEventHomeTimeNote(event, displayTimeZone, locale, hour12)

  return (
    <button
      type="button"
      onClick={() => onEventClick?.(event)}
      title={[
        event.title,
        formatEventTimeRange(event, displayTimeZone, locale, hour12),
        homeNote && `${homeNote} (event local time)`,
        event.location,
      ]
        .filter(Boolean)
        .join('\n')}
      className={cn(
        'absolute z-10 flex flex-col items-start gap-0.5 overflow-hidden rounded-md border-l-2 px-1.5 py-1 text-left text-xs transition-shadow hover:shadow-md focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none',
        segment.continuesBefore && 'rounded-t-none',
        segment.continuesAfter && 'rounded-b-none',
        isSelected && 'ring-2 ring-ring',
      )}
      style={{
        top: `${top}%`,
        height: `max(${height}%, 1.25rem)`,
        left: `calc(${segment.column * width}% + 0.125rem)`,
        width: `calc(${width}% - 0.25rem)`,
        // A tinted surface keeps long text legible where a saturated fill would not.
        backgroundColor: `color-mix(in oklch, ${eventColorVar(event.color)} 18%, var(--background))`,
        borderInlineStartColor: eventColorVar(event.color),
      }}
    >
      <span className="flex w-full items-center gap-1">
        <span className="truncate font-medium">{event.title}</span>
        {isConflicting && (
          <AlertTriangleIcon
            className="size-3 shrink-0 text-destructive"
            aria-label="Overlaps another event"
          />
        )}
      </span>
      <span className="truncate text-[0.7rem] text-muted-foreground tabular-nums">
        {formatEventTimeRange(event, displayTimeZone, locale, hour12)}
      </span>
      {homeNote && (
        <span className="truncate text-[0.65rem] text-muted-foreground opacity-80">
          {homeNote}
        </span>
      )}
    </button>
  )
}

/* -------------------------------------------------------------------------- */
/* Agenda view                                                                 */
/* -------------------------------------------------------------------------- */

interface AgendaViewProps extends SharedViewProps {
  from: PlainDate
  days: number
}

function AgendaView({
  events,
  displayTimeZone,
  locale,
  hour12,
  conflictIds,
  selectedEventId,
  onEventClick,
  today,
  from,
  days,
}: AgendaViewProps) {
  const groups = React.useMemo(() => {
    return Array.from({ length: days }, (_, index) => {
      const date = addDays(from, index)
      return { date, events: getEventsForDay(events, date, displayTimeZone) }
    }).filter((group) => group.events.length > 0)
  }, [days, events, from, displayTimeZone])

  if (groups.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center p-8 text-sm text-muted-foreground">
        No events in this range.
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto p-4 lg:p-6">
      {groups.map((group) => (
        <section key={plainDateToString(group.date)}>
          <h3 className="mb-2 flex items-center gap-2 text-sm font-medium text-muted-foreground">
            {formatPlainDate(
              group.date,
              { weekday: 'long', month: 'long', day: 'numeric' },
              locale,
            )}
            {isSamePlainDate(group.date, today) && (
              <span className="rounded bg-primary px-1.5 py-0.5 text-[0.65rem] text-primary-foreground">
                Today
              </span>
            )}
          </h3>
          <div className="flex flex-col gap-2">
            {group.events.map((event) => {
              const homeNote = formatEventHomeTimeNote(
                event,
                displayTimeZone,
                locale,
                hour12,
              )
              return (
                <button
                  type="button"
                  key={event.id}
                  onClick={() => onEventClick?.(event)}
                  className={cn(
                    'flex items-start gap-3 rounded-lg border bg-card p-3 text-left transition-colors hover:bg-accent/50 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none',
                    selectedEventId === event.id && 'ring-2 ring-ring',
                  )}
                >
                  <span
                    aria-hidden="true"
                    className="mt-1 size-2 shrink-0 rounded-full"
                    style={{ backgroundColor: eventColorVar(event.color) }}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5">
                      <span className="truncate text-sm font-medium">{event.title}</span>
                      {conflictIds.has(event.id) && (
                        <AlertTriangleIcon
                          className="size-3.5 shrink-0 text-destructive"
                          aria-label="Overlaps another event"
                        />
                      )}
                    </span>
                    <span className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
                      <span className="tabular-nums">
                        {formatEventTimeRange(event, displayTimeZone, locale, hour12)}
                      </span>
                      {homeNote && (
                        <span className="opacity-80">{homeNote} event local</span>
                      )}
                      {event.location && (
                        <span className="inline-flex items-center gap-1">
                          <MapPinIcon className="size-3" aria-hidden="true" />
                          {event.location}
                        </span>
                      )}
                    </span>
                  </span>
                </button>
              )
            })}
          </div>
        </section>
      ))}
    </div>
  )
}

/** Exported for consumers that want to render a bare month grid. */
export { MonthView as EventCalendarMonthView }
