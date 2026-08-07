import * as React from 'react'
import { CalendarDaysIcon, MoonIcon, SunIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Calendar } from '@/components/ui/calendar'
import { EventCalendar, type CalendarView } from '@/components/ui/event-calendar'
import { cn } from '@/lib/utils'
import {
  EVENT_TIME_ZONE,
  REINVENT_SESSIONS,
  TIME_ZONE_OPTIONS,
} from '@/data/reinvent-sessions'
import {
  formatOffset,
  getLocalTimeZone,
  instantToPlainDate,
  plainDateToInstant,
  timeZoneDisplayName,
} from '@/lib/temporal'
import {
  formatEventHomeTimeNote,
  formatEventTimeRange,
  getConflictingEventIds,
  getEventDateKeys,
  resolveEvents,
  type ResolvedEvent,
} from '@/lib/events'

/** re:Invent 2025 opens on Dec 1; anchor the demo there rather than on "now". */
const DEFAULT_DATE = new Date('2025-12-02T12:00:00-08:00')

export default function App() {
  const [displayTimeZone, setDisplayTimeZone] = React.useState(EVENT_TIME_ZONE)
  const [view, setView] = React.useState<CalendarView>('week')
  const [isDark, setIsDark] = React.useState(false)
  const [selectedEvent, setSelectedEvent] = React.useState<ResolvedEvent | undefined>()
  const [anchorDate, setAnchorDate] = React.useState<Date>(DEFAULT_DATE)
  const [hostTimeZone, setHostTimeZone] = React.useState<string>()

  // Resolve the host zone in an effect, never during render — otherwise SSR and
  // client disagree and React reports a hydration mismatch.
  React.useEffect(() => setHostTimeZone(getLocalTimeZone()), [])

  React.useEffect(() => {
    document.documentElement.classList.toggle('dark', isDark)
  }, [isDark])

  const { events, errors } = React.useMemo(
    () =>
      resolveEvents(REINVENT_SESSIONS, {
        defaultTimeZone: EVENT_TIME_ZONE,
        defaultDurationMinutes: 60,
      }),
    [],
  )

  const eventDayKeys = React.useMemo(
    () => getEventDateKeys(events, displayTimeZone),
    [events, displayTimeZone],
  )

  const conflictCount = React.useMemo(
    () => getConflictingEventIds(events).size,
    [events],
  )

  const zoneOptions = React.useMemo(() => {
    if (!hostTimeZone || TIME_ZONE_OPTIONS.some((zone) => zone.value === hostTimeZone)) {
      return TIME_ZONE_OPTIONS
    }
    return [{ value: hostTimeZone, label: `${hostTimeZone} (your zone)` }, ...TIME_ZONE_OPTIONS]
  }, [hostTimeZone])

  return (
    // A fixed-height shell so the time grid itself becomes the scroll
    // container. With `min-h-svh` the layout grows to content height and the
    // whole page scrolls instead, which breaks scroll-to-hour.
    <div className="flex h-svh flex-col overflow-hidden bg-background text-foreground">
      <header className="flex flex-wrap items-center gap-3 border-b px-4 py-3 lg:px-6">
        <span className="flex items-center gap-2 font-semibold">
          <CalendarDaysIcon className="size-5" aria-hidden="true" />
          re:Invent Planner
        </span>

        <span className="rounded-md bg-muted px-2 py-1 text-xs text-muted-foreground">
          Dec 1–5, 2025 · Las Vegas
        </span>

        <div className="ml-auto flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            View times in
            <select
              value={displayTimeZone}
              onChange={(event) => setDisplayTimeZone(event.target.value)}
              className="h-8 rounded-md border border-input bg-background px-2 text-xs text-foreground shadow-xs focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
            >
              {zoneOptions.map((zone) => (
                <option key={zone.value} value={zone.value}>
                  {zone.label}
                </option>
              ))}
            </select>
          </label>

          <Button
            variant="outline"
            size="icon-sm"
            aria-label={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
            onClick={() => setIsDark((value) => !value)}
          >
            {isDark ? <SunIcon /> : <MoonIcon />}
          </Button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <aside className="flex shrink-0 flex-col gap-4 overflow-y-auto border-b bg-sidebar p-4 lg:w-80 lg:border-r lg:border-b-0">
          {/* Our own Calendar, used here as the mini date picker. */}
          <section>
            <h2 className="mb-2 px-1 text-xs font-medium text-muted-foreground">
              Navigate
            </h2>
            <Calendar
              mode="single"
              selected={anchorDate}
              onSelect={(date) => date && setAnchorDate(date)}
              month={anchorDate}
              onMonthChange={setAnchorDate}
              timeZone={displayTimeZone}
              eventDays={eventDayKeys}
              showWeekNumber
              captionLayout="dropdown"
              fromDate={new Date('2025-01-01T00:00:00Z')}
              toDate={new Date('2026-12-31T00:00:00Z')}
              className="rounded-lg border bg-background"
              aria-label="Select a date"
            />
          </section>

          <section className="rounded-lg border bg-background p-3 text-xs">
            <h2 className="mb-2 font-medium">Timezone</h2>
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-muted-foreground">
              <dt>Event</dt>
              <dd className="text-foreground">
                {EVENT_TIME_ZONE.split('/')[1]?.replace('_', ' ')}{' '}
                <span className="opacity-70">
                  {formatOffset(anchorDate.getTime(), EVENT_TIME_ZONE)}
                </span>
              </dd>
              <dt>Viewing</dt>
              <dd className="text-foreground">
                {timeZoneDisplayName(anchorDate.getTime(), displayTimeZone)}{' '}
                <span className="opacity-70">
                  {formatOffset(anchorDate.getTime(), displayTimeZone)}
                </span>
              </dd>
            </dl>
            {displayTimeZone !== EVENT_TIME_ZONE && (
              <p className="mt-2 rounded bg-muted p-2 leading-snug text-muted-foreground">
                Times are shifted from event-local. Cards show the event's home
                time underneath.
              </p>
            )}
          </section>

          <section className="rounded-lg border bg-background p-3 text-xs">
            <h2 className="mb-2 font-medium">Schedule</h2>
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-muted-foreground">
              <dt>Events</dt>
              <dd className="text-foreground">{events.length}</dd>
              <dt>Conflicts</dt>
              <dd className={cn(conflictCount > 0 && 'text-destructive')}>
                {conflictCount}
              </dd>
              {errors.length > 0 && (
                <>
                  <dt>Invalid</dt>
                  <dd className="text-destructive">{errors.length}</dd>
                </>
              )}
            </dl>
          </section>

          {selectedEvent && (
            <section className="rounded-lg border bg-background p-3">
              <h2 className="text-sm font-medium">{selectedEvent.title}</h2>
              <p className="mt-1 text-xs tabular-nums text-muted-foreground">
                {formatEventTimeRange(selectedEvent, displayTimeZone, undefined, false)}
              </p>
              {formatEventHomeTimeNote(selectedEvent, displayTimeZone, undefined, false) && (
                <p className="text-xs text-muted-foreground opacity-80">
                  {formatEventHomeTimeNote(
                    selectedEvent,
                    displayTimeZone,
                    undefined,
                    false,
                  )}{' '}
                  event local
                </p>
              )}
              {selectedEvent.location && (
                <p className="mt-1 text-xs text-muted-foreground">
                  {selectedEvent.location}
                </p>
              )}
              {selectedEvent.description && (
                <p className="mt-2 text-xs leading-snug text-muted-foreground">
                  {selectedEvent.description}
                </p>
              )}
              <Button
                variant="ghost"
                size="xs"
                className="mt-2"
                onClick={() => setSelectedEvent(undefined)}
              >
                Clear
              </Button>
            </section>
          )}
        </aside>

        <main className="flex min-h-0 min-w-0 flex-1 flex-col">
          <EventCalendar
            events={events}
            displayTimeZone={displayTimeZone}
            view={view}
            onViewChange={setView}
            date={anchorDate}
            onDateChange={setAnchorDate}
            hour12={false}
            scrollToHour={7}
            selectedEventId={selectedEvent?.id}
            onEventClick={setSelectedEvent}
            onDayClick={(date) => {
              setAnchorDate(date)
              setView('day')
            }}
            // Pin "now" into the conference week so the current-time indicator
            // is visible in the demo instead of sitting months away.
            now={
              new Date(
                plainDateToInstant(
                  instantToPlainDate(DEFAULT_DATE.getTime(), EVENT_TIME_ZONE),
                  EVENT_TIME_ZONE,
                ) +
                  11 * 3_600_000,
              )
            }
            className="flex-1"
          />
        </main>
      </div>
    </div>
  )
}
