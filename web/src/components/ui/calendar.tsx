import * as React from 'react'
import { ChevronDownIcon, ChevronLeftIcon, ChevronRightIcon } from 'lucide-react'
import { Button, type ButtonVariant } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { PlainDate } from '@/lib/temporal'
import {
  addDays,
  addMonths,
  comparePlainDate,
  endOfMonth,
  formatPlainDate,
  instantToPlainDate,
  isSameMonth,
  isSamePlainDate,
  isoWeekNumber,
  monthNames,
  plainDateToInstant,
  plainDateToString,
  startOfMonth,
  startOfWeek,
  todayInTimeZone,
  weekdayNames,
} from '@/lib/temporal'

/* -------------------------------------------------------------------------- */
/* Types                                                                       */
/* -------------------------------------------------------------------------- */

export interface DateRange {
  from: Date | undefined
  to?: Date | undefined
}

export type CalendarMode = 'single' | 'multiple' | 'range'

/** Ways to mark days as disabled. */
export type DateMatcher =
  | Date
  | Date[]
  | { before?: Date; after?: Date }
  | ((date: Date) => boolean)

export interface CalendarFormatters {
  /** Caption above a month grid. */
  formatCaption?: (month: PlainDate, locale?: string) => string
  /** Column header for a weekday. `index` is 0 = Sunday. */
  formatWeekdayName?: (index: number, locale?: string) => string
  /** Text inside a day cell. */
  formatDay?: (date: PlainDate, locale?: string) => string
  /** Week number gutter. */
  formatWeekNumber?: (weekNumber: number) => string
  /** Option label in the month dropdown. */
  formatMonthDropdown?: (monthIndex: number, locale?: string) => string
  /** Option label in the year dropdown. */
  formatYearDropdown?: (year: number) => string
}

export interface CalendarClassNames {
  root?: string
  months?: string
  month?: string
  nav?: string
  button_previous?: string
  button_next?: string
  month_caption?: string
  caption_label?: string
  dropdowns?: string
  dropdown_root?: string
  dropdown?: string
  month_grid?: string
  weekdays?: string
  weekday?: string
  week?: string
  week_number_header?: string
  week_number?: string
  day?: string
  day_button?: string
}

interface CalendarBaseProps {
  /** Controlled displayed month. */
  month?: Date
  /** Initial displayed month when uncontrolled. */
  defaultMonth?: Date
  onMonthChange?: (month: Date) => void
  /** Number of month grids shown side by side. */
  numberOfMonths?: number
  /** Render days from adjacent months in the leading/trailing cells. */
  showOutsideDays?: boolean
  /** `label` shows static text; `dropdown` shows month/year selects. */
  captionLayout?: 'label' | 'dropdown'
  /** Variant applied to the previous/next navigation buttons. */
  buttonVariant?: ButtonVariant
  /** Show the ISO week-number gutter. */
  showWeekNumber?: boolean
  /**
   * IANA timezone used to decide which calendar day a `Date` falls on and what
   * "today" means. Detect client-side to avoid an SSR hydration mismatch.
   */
  timeZone?: string
  /** BCP-47 locale tag for month, weekday and day formatting. */
  locale?: string
  dir?: 'ltr' | 'rtl'
  /** 0 = Sunday (default) through 6 = Saturday. */
  weekStartsOn?: 0 | 1 | 2 | 3 | 4 | 5 | 6
  disabled?: DateMatcher
  /** Earliest selectable/navigable day. */
  fromDate?: Date
  /** Latest selectable/navigable day. */
  toDate?: Date
  /** Always render six week rows so the height never jumps between months. */
  fixedWeeks?: boolean
  /** Override "today". Useful for tests and for pinning to event time. */
  today?: Date
  /**
   * Day keys (`YYYY-MM-DD`) that have events. Renders the event indicator slot
   * beneath the day number.
   */
  eventDays?: ReadonlySet<string>
  /** Move DOM focus to the calendar on mount. */
  autoFocus?: boolean
  formatters?: CalendarFormatters
  classNames?: CalendarClassNames
  className?: string
  'aria-label'?: string
}

interface SingleProps extends CalendarBaseProps {
  mode?: 'single'
  selected?: Date | undefined
  onSelect?: (date: Date | undefined) => void
  /** Clicking the selected day clears it. */
  required?: boolean
}

interface MultipleProps extends CalendarBaseProps {
  mode: 'multiple'
  selected?: Date[] | undefined
  onSelect?: (dates: Date[] | undefined) => void
  min?: number
  max?: number
}

interface RangeProps extends CalendarBaseProps {
  mode: 'range'
  selected?: DateRange | undefined
  onSelect?: (range: DateRange | undefined) => void
}

export type CalendarProps = SingleProps | MultipleProps | RangeProps

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

/** A `Date` is an instant; which calendar day it is depends on the timezone. */
function toPlainDate(date: Date, timeZone: string): PlainDate {
  return instantToPlainDate(date.getTime(), timeZone)
}

/** Convert back to a `Date` at midnight of that day in `timeZone`. */
function toDate(date: PlainDate, timeZone: string): Date {
  return new Date(plainDateToInstant(date, timeZone))
}

function buildMonthGrid(
  month: PlainDate,
  weekStartsOn: number,
  fixedWeeks: boolean,
): PlainDate[][] {
  const firstDay = startOfMonth(month)
  const lastDay = endOfMonth(month)
  const gridStart = startOfWeek(firstDay, weekStartsOn)

  const weeks: PlainDate[][] = []
  let cursor = gridStart
  while (
    comparePlainDate(cursor, lastDay) <= 0 ||
    weeks.length === 0 ||
    (weeks.length < 6 && fixedWeeks)
  ) {
    const week: PlainDate[] = []
    for (let index = 0; index < 7; index += 1) {
      week.push(addDays(cursor, index))
    }
    weeks.push(week)
    cursor = addDays(cursor, 7)
    if (!fixedWeeks && comparePlainDate(cursor, lastDay) > 0) break
    if (weeks.length >= 6) break
  }
  return weeks
}

function matchesDate(
  date: PlainDate,
  matcher: DateMatcher | undefined,
  timeZone: string,
): boolean {
  if (!matcher) return false
  if (typeof matcher === 'function') return matcher(toDate(date, timeZone))
  if (matcher instanceof Date) return isSamePlainDate(date, toPlainDate(matcher, timeZone))
  if (Array.isArray(matcher)) {
    return matcher.some((entry) => isSamePlainDate(date, toPlainDate(entry, timeZone)))
  }
  if (matcher.before && comparePlainDate(date, toPlainDate(matcher.before, timeZone)) < 0) {
    return true
  }
  if (matcher.after && comparePlainDate(date, toPlainDate(matcher.after, timeZone)) > 0) {
    return true
  }
  return false
}

/* -------------------------------------------------------------------------- */
/* Calendar                                                                    */
/* -------------------------------------------------------------------------- */

export function Calendar(props: CalendarProps) {
  const {
    month: monthProp,
    defaultMonth,
    onMonthChange,
    numberOfMonths = 1,
    showOutsideDays = true,
    captionLayout = 'label',
    buttonVariant = 'ghost',
    showWeekNumber = false,
    timeZone: timeZoneProp,
    locale,
    dir,
    weekStartsOn = 0,
    disabled,
    fromDate,
    toDate: toDateLimit,
    fixedWeeks = false,
    today: todayProp,
    eventDays,
    autoFocus = false,
    formatters,
    classNames,
    className,
  } = props

  const mode: CalendarMode = props.mode ?? 'single'
  // Fall back to UTC rather than the host zone so render output is deterministic
  // and SSR-safe; callers opt into the host zone explicitly.
  const timeZone = timeZoneProp ?? 'UTC'

  const today = React.useMemo(
    () => (todayProp ? toPlainDate(todayProp, timeZone) : todayInTimeZone(timeZone)),
    [todayProp, timeZone],
  )

  /* ---------------------------- selection state --------------------------- */

  const selectedDates = React.useMemo<PlainDate[]>(() => {
    if (props.mode === 'multiple') {
      return (props.selected ?? []).map((date) => toPlainDate(date, timeZone))
    }
    if (props.mode === 'range') {
      const range = props.selected
      const dates: PlainDate[] = []
      if (range?.from) dates.push(toPlainDate(range.from, timeZone))
      if (range?.to) dates.push(toPlainDate(range.to, timeZone))
      return dates
    }
    return props.selected ? [toPlainDate(props.selected, timeZone)] : []
  }, [props.mode, props.selected, timeZone])

  const rangeBounds = React.useMemo(() => {
    if (props.mode !== 'range') return undefined
    const range = props.selected
    if (!range?.from) return undefined
    const from = toPlainDate(range.from, timeZone)
    const to = range.to ? toPlainDate(range.to, timeZone) : undefined
    if (to && comparePlainDate(to, from) < 0) return { from: to, to: from }
    return { from, to }
  }, [props.mode, props.selected, timeZone])

  /* ------------------------------ month state ----------------------------- */

  const firstSelected = selectedDates[0]
  const [internalMonth, setInternalMonth] = React.useState<PlainDate>(() => {
    if (monthProp) return startOfMonth(toPlainDate(monthProp, timeZone))
    if (defaultMonth) return startOfMonth(toPlainDate(defaultMonth, timeZone))
    if (firstSelected) return startOfMonth(firstSelected)
    return startOfMonth(today)
  })

  const displayMonth = monthProp
    ? startOfMonth(toPlainDate(monthProp, timeZone))
    : internalMonth

  const changeMonth = React.useCallback(
    (next: PlainDate) => {
      const normalized = startOfMonth(next)
      if (!monthProp) setInternalMonth(normalized)
      onMonthChange?.(toDate(normalized, timeZone))
    },
    [monthProp, onMonthChange, timeZone],
  )

  /* ------------------------------ focus state ----------------------------- */

  const [focusedDate, setFocusedDate] = React.useState<PlainDate>(
    () => firstSelected ?? today,
  )
  const [isFocusWithin, setIsFocusWithin] = React.useState(false)
  const dayRefs = React.useRef(new Map<string, HTMLButtonElement>())
  const shouldRestoreFocus = React.useRef(false)

  // After a month change driven by the keyboard, move DOM focus to the new day.
  React.useEffect(() => {
    if (!shouldRestoreFocus.current) return
    shouldRestoreFocus.current = false
    dayRefs.current.get(plainDateToString(focusedDate))?.focus()
  }, [focusedDate, displayMonth])

  React.useEffect(() => {
    if (!autoFocus) return
    dayRefs.current.get(plainDateToString(focusedDate))?.focus()
    // Run once on mount only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoFocus])

  const monthsShown = React.useMemo(
    () =>
      Array.from({ length: Math.max(1, numberOfMonths) }, (_, index) =>
        addMonths(displayMonth, index),
      ),
    [displayMonth, numberOfMonths],
  )

  const lastMonthShown = monthsShown[monthsShown.length - 1]

  const minDate = fromDate ? toPlainDate(fromDate, timeZone) : undefined
  const maxDate = toDateLimit ? toPlainDate(toDateLimit, timeZone) : undefined

  const isPreviousDisabled = minDate
    ? comparePlainDate(addDays(startOfMonth(displayMonth), -1), minDate) < 0
    : false
  const isNextDisabled = maxDate
    ? comparePlainDate(addDays(endOfMonth(lastMonthShown), 1), maxDate) > 0
    : false

  const isDayDisabled = React.useCallback(
    (date: PlainDate) => {
      if (minDate && comparePlainDate(date, minDate) < 0) return true
      if (maxDate && comparePlainDate(date, maxDate) > 0) return true
      return matchesDate(date, disabled, timeZone)
    },
    [disabled, maxDate, minDate, timeZone],
  )

  /* ------------------------------- selection ------------------------------ */

  const handleSelect = React.useCallback(
    (date: PlainDate) => {
      if (isDayDisabled(date)) return
      const asDate = toDate(date, timeZone)

      if (props.mode === 'multiple') {
        const current = props.selected ?? []
        const currentPlain = current.map((entry) => toPlainDate(entry, timeZone))
        const alreadySelected = currentPlain.some((entry) => isSamePlainDate(entry, date))

        let next: Date[]
        if (alreadySelected) {
          if (props.min !== undefined && current.length <= props.min) return
          next = current.filter(
            (_, index) => !isSamePlainDate(currentPlain[index], date),
          )
        } else {
          if (props.max !== undefined && current.length >= props.max) return
          next = [...current, asDate]
        }
        next.sort((a, b) => a.getTime() - b.getTime())
        props.onSelect?.(next.length > 0 ? next : undefined)
        return
      }

      if (props.mode === 'range') {
        const range = props.selected
        // No range yet, or a complete range: start a new one.
        if (!range?.from || (range.from && range.to)) {
          props.onSelect?.({ from: asDate, to: undefined })
          return
        }
        const from = toPlainDate(range.from, timeZone)
        if (comparePlainDate(date, from) < 0) {
          props.onSelect?.({ from: asDate, to: range.from })
        } else {
          props.onSelect?.({ from: range.from, to: asDate })
        }
        return
      }

      // Single.
      const current = props.selected ? toPlainDate(props.selected, timeZone) : undefined
      if (current && isSamePlainDate(current, date) && !props.required) {
        props.onSelect?.(undefined)
        return
      }
      props.onSelect?.(asDate)
    },
    [isDayDisabled, props, timeZone],
  )

  /* ------------------------------- keyboard ------------------------------- */

  const moveFocus = React.useCallback(
    (next: PlainDate) => {
      if (minDate && comparePlainDate(next, minDate) < 0) return
      if (maxDate && comparePlainDate(next, maxDate) > 0) return

      setFocusedDate(next)
      const isVisible = monthsShown.some((shown) => isSameMonth(shown, next))
      if (!isVisible) {
        shouldRestoreFocus.current = true
        // Keep the moved-to month in view, accounting for multi-month display.
        changeMonth(comparePlainDate(next, displayMonth) < 0 ? next : addMonths(next, 1 - monthsShown.length))
      } else {
        dayRefs.current.get(plainDateToString(next))?.focus()
      }
    },
    [changeMonth, displayMonth, maxDate, minDate, monthsShown],
  )

  const handleKeyDown = React.useCallback(
    (event: React.KeyboardEvent<HTMLButtonElement>, date: PlainDate) => {
      const isRtl = dir === 'rtl'
      let next: PlainDate | undefined

      switch (event.key) {
        case 'ArrowLeft':
          next = addDays(date, isRtl ? 1 : -1)
          break
        case 'ArrowRight':
          next = addDays(date, isRtl ? -1 : 1)
          break
        case 'ArrowUp':
          next = addDays(date, -7)
          break
        case 'ArrowDown':
          next = addDays(date, 7)
          break
        case 'Home':
          next = startOfWeek(date, weekStartsOn)
          break
        case 'End':
          next = addDays(startOfWeek(date, weekStartsOn), 6)
          break
        case 'PageUp':
          next = event.shiftKey ? addMonths(date, -12) : addMonths(date, -1)
          break
        case 'PageDown':
          next = event.shiftKey ? addMonths(date, 12) : addMonths(date, 1)
          break
        case 'Enter':
        case ' ':
          event.preventDefault()
          handleSelect(date)
          return
        default:
          return
      }

      event.preventDefault()
      if (next) moveFocus(next)
    },
    [dir, handleSelect, moveFocus, weekStartsOn],
  )

  /* ------------------------------ formatting ------------------------------ */

  const weekdayLabels = React.useMemo(() => {
    const names = weekdayNames(locale, 'short')
    return Array.from({ length: 7 }, (_, index) => {
      const dayIndex = (index + weekStartsOn) % 7
      return formatters?.formatWeekdayName?.(dayIndex, locale) ?? names[dayIndex]
    })
  }, [formatters, locale, weekStartsOn])

  const formatCaption = React.useCallback(
    (month: PlainDate) =>
      formatters?.formatCaption?.(month, locale) ??
      formatPlainDate(month, { month: 'long', year: 'numeric' }, locale),
    [formatters, locale],
  )

  const formatDayLabel = React.useCallback(
    (date: PlainDate) =>
      formatters?.formatDay?.(date, locale) ?? String(date.day),
    [formatters, locale],
  )

  return (
    <div
      data-slot="calendar"
      dir={dir}
      role="application"
      aria-label={props['aria-label'] ?? 'Calendar'}
      onFocus={() => setIsFocusWithin(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          setIsFocusWithin(false)
        }
      }}
      className={cn(
        'group/calendar bg-background p-3 [--cell-size:--spacing(8)]',
        '[[data-slot=card-content]_&]:bg-transparent [[data-slot=popover-content]_&]:bg-transparent',
        className,
        classNames?.root,
      )}
    >
      <div className={cn('relative flex flex-col gap-4 md:flex-row', classNames?.months)}>
        {/* Navigation sits above the month grids and spans the full width. */}
        <div
          className={cn(
            'absolute inset-x-0 top-0 flex w-full items-center justify-between gap-1',
            classNames?.nav,
          )}
        >
          <Button
            type="button"
            variant={buttonVariant}
            size="icon"
            aria-label="Go to the previous month"
            aria-disabled={isPreviousDisabled || undefined}
            disabled={isPreviousDisabled}
            onClick={() => changeMonth(addMonths(displayMonth, -1))}
            className={cn(
              'size-(--cell-size) p-0 select-none aria-disabled:opacity-50',
              classNames?.button_previous,
            )}
          >
            {dir === 'rtl' ? <ChevronRightIcon /> : <ChevronLeftIcon />}
          </Button>
          <Button
            type="button"
            variant={buttonVariant}
            size="icon"
            aria-label="Go to the next month"
            aria-disabled={isNextDisabled || undefined}
            disabled={isNextDisabled}
            onClick={() => changeMonth(addMonths(displayMonth, 1))}
            className={cn(
              'size-(--cell-size) p-0 select-none aria-disabled:opacity-50',
              classNames?.button_next,
            )}
          >
            {dir === 'rtl' ? <ChevronLeftIcon /> : <ChevronRightIcon />}
          </Button>
        </div>

        {monthsShown.map((month) => (
          <MonthGrid
            key={plainDateToString(month)}
            month={month}
            today={today}
            focusedDate={focusedDate}
            isFocusWithin={isFocusWithin}
            selectedDates={selectedDates}
            rangeBounds={rangeBounds}
            mode={mode}
            weekStartsOn={weekStartsOn}
            showOutsideDays={showOutsideDays}
            showWeekNumber={showWeekNumber}
            fixedWeeks={fixedWeeks}
            captionLayout={captionLayout}
            locale={locale}
            eventDays={eventDays}
            minDate={minDate}
            maxDate={maxDate}
            isDayDisabled={isDayDisabled}
            weekdayLabels={weekdayLabels}
            formatCaption={formatCaption}
            formatDayLabel={formatDayLabel}
            formatters={formatters}
            classNames={classNames}
            dayRefs={dayRefs}
            onSelect={handleSelect}
            onKeyDown={handleKeyDown}
            onFocusDate={setFocusedDate}
            onMonthChange={changeMonth}
          />
        ))}
      </div>
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* MonthGrid                                                                   */
/* -------------------------------------------------------------------------- */

interface MonthGridProps {
  month: PlainDate
  today: PlainDate
  focusedDate: PlainDate
  isFocusWithin: boolean
  selectedDates: PlainDate[]
  rangeBounds?: { from: PlainDate; to?: PlainDate }
  mode: CalendarMode
  weekStartsOn: number
  showOutsideDays: boolean
  showWeekNumber: boolean
  fixedWeeks: boolean
  captionLayout: 'label' | 'dropdown'
  locale?: string
  eventDays?: ReadonlySet<string>
  minDate?: PlainDate
  maxDate?: PlainDate
  isDayDisabled: (date: PlainDate) => boolean
  weekdayLabels: string[]
  formatCaption: (month: PlainDate) => string
  formatDayLabel: (date: PlainDate) => string
  formatters?: CalendarFormatters
  classNames?: CalendarClassNames
  dayRefs: React.RefObject<Map<string, HTMLButtonElement>>
  onSelect: (date: PlainDate) => void
  onKeyDown: (event: React.KeyboardEvent<HTMLButtonElement>, date: PlainDate) => void
  onFocusDate: (date: PlainDate) => void
  onMonthChange: (month: PlainDate) => void
}

function MonthGrid({
  month,
  today,
  focusedDate,
  isFocusWithin,
  selectedDates,
  rangeBounds,
  mode,
  weekStartsOn,
  showOutsideDays,
  showWeekNumber,
  fixedWeeks,
  captionLayout,
  locale,
  eventDays,
  minDate,
  maxDate,
  isDayDisabled,
  weekdayLabels,
  formatCaption,
  formatDayLabel,
  formatters,
  classNames,
  dayRefs,
  onSelect,
  onKeyDown,
  onFocusDate,
  onMonthChange,
}: MonthGridProps) {
  const weeks = React.useMemo(
    () => buildMonthGrid(month, weekStartsOn, fixedWeeks),
    [month, weekStartsOn, fixedWeeks],
  )

  // Ensure exactly one day per grid is tabbable (roving tabindex).
  const tabbableDate = React.useMemo(() => {
    if (weeks.some((week) => week.some((day) => isSamePlainDate(day, focusedDate)))) {
      return focusedDate
    }
    const inMonth = weeks.flat().find((day) => isSameMonth(day, month))
    return inMonth ?? weeks[0][0]
  }, [focusedDate, month, weeks])

  return (
    <div className={cn('flex w-full flex-col gap-4', classNames?.month)}>
      <div
        className={cn(
          'flex h-(--cell-size) w-full items-center justify-center px-(--cell-size)',
          classNames?.month_caption,
        )}
      >
        {captionLayout === 'dropdown' ? (
          <MonthYearDropdowns
            month={month}
            locale={locale}
            minDate={minDate}
            maxDate={maxDate}
            formatters={formatters}
            classNames={classNames}
            onMonthChange={onMonthChange}
          />
        ) : (
          <span
            aria-live="polite"
            className={cn('text-sm font-medium', classNames?.caption_label)}
          >
            {formatCaption(month)}
          </span>
        )}
      </div>

      <table
        role="grid"
        aria-label={formatCaption(month)}
        className={cn('w-full border-collapse', classNames?.month_grid)}
      >
        <thead aria-hidden="true">
          <tr className={cn('flex', classNames?.weekdays)}>
            {showWeekNumber && (
              <th
                scope="col"
                className={cn(
                  'flex w-(--cell-size) items-center justify-center text-[0.8rem] font-normal text-muted-foreground select-none',
                  classNames?.week_number_header,
                )}
              >
                #
              </th>
            )}
            {weekdayLabels.map((label, index) => (
              <th
                scope="col"
                key={`${label}-${index}`}
                className={cn(
                  'flex-1 rounded-md text-[0.8rem] font-normal text-muted-foreground select-none',
                  classNames?.weekday,
                )}
              >
                {label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {weeks.map((week) => (
            <tr
              key={plainDateToString(week[0])}
              role="row"
              className={cn('mt-2 flex w-full', classNames?.week)}
            >
              {showWeekNumber && (
                <td
                  role="rowheader"
                  className={cn(
                    'flex w-(--cell-size) items-center justify-center text-[0.8rem] text-muted-foreground select-none',
                    classNames?.week_number,
                  )}
                >
                  {formatters?.formatWeekNumber?.(isoWeekNumber(week[0])) ??
                    isoWeekNumber(week[0])}
                </td>
              )}
              {week.map((date) => {
                const key = plainDateToString(date)
                const isOutside = !isSameMonth(date, month)

                if (isOutside && !showOutsideDays) {
                  return (
                    <td
                      key={key}
                      role="gridcell"
                      aria-hidden="true"
                      className="relative aspect-square h-full w-full flex-1 p-0"
                    />
                  )
                }

                const isSelected = selectedDates.some((entry) => isSamePlainDate(entry, date))
                const isRangeStart =
                  !!rangeBounds && isSamePlainDate(date, rangeBounds.from) && !!rangeBounds.to
                const isRangeEnd =
                  !!rangeBounds &&
                  !!rangeBounds.to &&
                  isSamePlainDate(date, rangeBounds.to)
                const isRangeMiddle =
                  !!rangeBounds &&
                  !!rangeBounds.to &&
                  comparePlainDate(date, rangeBounds.from) > 0 &&
                  comparePlainDate(date, rangeBounds.to) < 0
                const isSelectedSingle = isSelected && mode !== 'range'
                const isToday = isSamePlainDate(date, today)
                const isDisabled = isDayDisabled(date)
                const isTabbable = isSamePlainDate(date, tabbableDate)
                const isFocused = isFocusWithin && isSamePlainDate(date, focusedDate)

                return (
                  <td
                    key={key}
                    role="gridcell"
                    aria-selected={isSelected || isRangeMiddle || undefined}
                    data-selected={isSelected || isRangeMiddle ? 'true' : undefined}
                    data-focused={isFocused ? 'true' : undefined}
                    data-today={isToday ? 'true' : undefined}
                    data-outside={isOutside ? 'true' : undefined}
                    data-disabled={isDisabled ? 'true' : undefined}
                    className={cn(
                      'group/day relative aspect-square h-full w-full flex-1 p-0 text-center select-none',
                      isToday &&
                        !isSelected &&
                        !isRangeMiddle &&
                        'rounded-md bg-accent text-accent-foreground',
                      isRangeMiddle && 'bg-accent',
                      isRangeStart && 'rounded-s-md bg-accent',
                      isRangeEnd && 'rounded-e-md bg-accent',
                      isOutside && 'text-muted-foreground',
                      isDisabled && 'text-muted-foreground opacity-50',
                      classNames?.day,
                    )}
                  >
                    <CalendarDayButton
                      ref={(node) => {
                        if (node) dayRefs.current?.set(key, node)
                        else dayRefs.current?.delete(key)
                      }}
                      date={date}
                      label={formatDayLabel(date)}
                      accessibleLabel={formatPlainDate(
                        date,
                        { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' },
                        locale,
                      )}
                      isSelectedSingle={isSelectedSingle}
                      isRangeStart={isRangeStart}
                      isRangeEnd={isRangeEnd}
                      isRangeMiddle={isRangeMiddle}
                      isDisabled={isDisabled}
                      isOutside={isOutside}
                      isTabbable={isTabbable}
                      hasEvents={eventDays?.has(key) ?? false}
                      className={classNames?.day_button}
                      onClick={() => {
                        onFocusDate(date)
                        onSelect(date)
                      }}
                      onFocus={() => onFocusDate(date)}
                      onKeyDown={(event) => onKeyDown(event, date)}
                    />
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* CalendarDayButton                                                           */
/* -------------------------------------------------------------------------- */

export interface CalendarDayButtonProps
  extends Omit<React.ComponentProps<'button'>, 'children'> {
  date: PlainDate
  label: string
  accessibleLabel: string
  isSelectedSingle?: boolean
  isRangeStart?: boolean
  isRangeEnd?: boolean
  isRangeMiddle?: boolean
  isDisabled?: boolean
  isOutside?: boolean
  isTabbable?: boolean
  hasEvents?: boolean
}

/**
 * A single day cell. Emits the data attributes the design system specifies so
 * styling and tests can target selection state without reading class strings.
 */
export const CalendarDayButton = React.forwardRef<
  HTMLButtonElement,
  CalendarDayButtonProps
>(function CalendarDayButton(
  {
    date,
    label,
    accessibleLabel,
    isSelectedSingle = false,
    isRangeStart = false,
    isRangeEnd = false,
    isRangeMiddle = false,
    isDisabled = false,
    isOutside = false,
    isTabbable = false,
    hasEvents = false,
    className,
    ...props
  },
  ref,
) {
  return (
    <Button
      ref={ref}
      type="button"
      variant="ghost"
      size="icon"
      data-day={plainDateToString(date)}
      data-selected-single={isSelectedSingle ? 'true' : 'false'}
      data-range-start={isRangeStart ? 'true' : 'false'}
      data-range-end={isRangeEnd ? 'true' : 'false'}
      data-range-middle={isRangeMiddle ? 'true' : 'false'}
      data-outside={isOutside ? 'true' : undefined}
      aria-label={accessibleLabel}
      aria-disabled={isDisabled || undefined}
      disabled={isDisabled}
      tabIndex={isTabbable ? 0 : -1}
      className={cn(
        'flex aspect-square size-auto w-full min-w-(--cell-size) flex-col gap-1 leading-none font-normal',
        'data-[selected-single=true]:bg-primary data-[selected-single=true]:text-primary-foreground',
        'data-[range-start=true]:bg-primary data-[range-start=true]:text-primary-foreground',
        'data-[range-end=true]:bg-primary data-[range-end=true]:text-primary-foreground',
        'data-[range-middle=true]:bg-accent data-[range-middle=true]:text-accent-foreground data-[range-middle=true]:rounded-none',
        'group-data-[focused=true]/day:border-ring group-data-[focused=true]/day:ring-[3px] group-data-[focused=true]/day:ring-ring/50 group-data-[focused=true]/day:relative group-data-[focused=true]/day:z-10',
        'dark:hover:text-accent-foreground',
        className,
      )}
      {...props}
    >
      <span>{label}</span>
      {/* Event indicator slot — sits beneath the day number. */}
      {hasEvents && (
        <span
          aria-hidden="true"
          data-slot="calendar-event-slot"
          className={cn(
            'absolute bottom-1 size-1 rounded-full bg-primary',
            (isSelectedSingle || isRangeStart || isRangeEnd) && 'bg-primary-foreground',
          )}
        />
      )}
    </Button>
  )
})

/* -------------------------------------------------------------------------- */
/* Dropdown caption                                                            */
/* -------------------------------------------------------------------------- */

interface MonthYearDropdownsProps {
  month: PlainDate
  locale?: string
  minDate?: PlainDate
  maxDate?: PlainDate
  formatters?: CalendarFormatters
  classNames?: CalendarClassNames
  onMonthChange: (month: PlainDate) => void
}

function MonthYearDropdowns({
  month,
  locale,
  minDate,
  maxDate,
  formatters,
  classNames,
  onMonthChange,
}: MonthYearDropdownsProps) {
  const months = React.useMemo(() => monthNames(locale, 'long'), [locale])

  const years = React.useMemo(() => {
    const start = minDate?.year ?? month.year - 10
    const end = maxDate?.year ?? month.year + 10
    return Array.from({ length: Math.max(1, end - start + 1) }, (_, index) => start + index)
  }, [maxDate, minDate, month.year])

  return (
    <div className={cn('flex items-center gap-2', classNames?.dropdowns)}>
      <DropdownShell
        label={formatters?.formatMonthDropdown?.(month.month - 1, locale) ?? months[month.month - 1]}
        classNames={classNames}
      >
        <select
          aria-label="Month"
          value={month.month}
          onChange={(event) =>
            onMonthChange({ ...month, month: Number(event.target.value), day: 1 })
          }
          className={cn('absolute inset-0 bg-popover opacity-0', classNames?.dropdown)}
        >
          {months.map((name, index) => (
            <option key={name} value={index + 1}>
              {name}
            </option>
          ))}
        </select>
      </DropdownShell>

      <DropdownShell
        label={formatters?.formatYearDropdown?.(month.year) ?? String(month.year)}
        classNames={classNames}
      >
        <select
          aria-label="Year"
          value={month.year}
          onChange={(event) =>
            onMonthChange({ ...month, year: Number(event.target.value), day: 1 })
          }
          className={cn('absolute inset-0 bg-popover opacity-0', classNames?.dropdown)}
        >
          {years.map((year) => (
            <option key={year} value={year}>
              {year}
            </option>
          ))}
        </select>
      </DropdownShell>
    </div>
  )
}

function DropdownShell({
  label,
  classNames,
  children,
}: {
  label: string
  classNames?: CalendarClassNames
  children: React.ReactNode
}) {
  return (
    <div
      className={cn(
        'relative rounded-md border border-input shadow-xs has-focus:border-ring has-focus:ring-[3px] has-focus:ring-ring/50',
        classNames?.dropdown_root,
      )}
    >
      <span
        className={cn('flex h-8 items-center gap-1 rounded-md pr-1 pl-2 text-sm', classNames?.caption_label)}
      >
        {label}
        <ChevronDownIcon className="size-3.5 opacity-60" aria-hidden="true" />
      </span>
      {children}
    </div>
  )
}
