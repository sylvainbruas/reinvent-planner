# re:Invent Planner — Calendar

A custom, timezone-aware calendar view built to replace the design system's
`Calendar` component, which is a thin wrapper over
[`react-day-picker`](https://daypicker.dev/).

## Why replace react-day-picker

`react-day-picker` is a *date picker*. Its `timeZone` prop affects which day a
selection resolves to, but it has no concept of an event, let alone an event that
happens in a timezone different from the viewer's. re:Invent sessions all happen
in Las Vegas while attendees plan from everywhere, so timezone handling has to be
a property of each event rather than a global setting.

Owning the implementation also means the markup, tokens and data attributes are
ours to shape, with no third-party class names or DOM to override.

## The timezone model

Two kinds of time value, kept strictly apart:

- **Instant** — an absolute point in time (epoch ms). Unambiguous.
- **PlainDate / PlainDateTime** — a wall-clock reading with no offset.
  "December 1st, 9:00am" is not a point in time until you say *where*.

Each event carries its **own** `timeZone` — where it physically happens. The
calendar is rendered in a separate **display timezone**. Layout is always a
function of `(event instants, display timezone)`; changing the display timezone
re-lays out everything and never mutates the events.

The same keynote instant, viewed three ways:

| Display zone | Rendered | Grid position |
|---|---|---|
| `America/Los_Angeles` (GMT-8) | 08:00 – 10:30 | 480/1440 |
| `Asia/Tokyo` (GMT+9) | 01:00 – 03:30, next day | 60/1440 |
| `Asia/Kolkata` (GMT+5:30) | 21:30 – 00:00 | 1290/1440 |

### No date library

`src/lib/temporal.ts` is built entirely on `Intl.DateTimeFormat`. The only IANA
timezone database involved is the one already in the JS engine — no `date-fns`,
`date-fns-tz`, Luxon, or Temporal polyfill.

Offsets are derived by formatting an instant into a zone, reading the parts back,
and diffing against UTC. Resolving a wall-clock time to an instant is the hard
direction, because the offset you need depends on the instant you are computing.
`plainDateTimeToInstant` probes the offsets a day either side, derives a
candidate from each, and keeps only candidates that round-trip:

- 2 survivors → ambiguous (clocks went back; the time happened twice)
- 1 survivor → the ordinary case
- 0 survivors → a gap (clocks sprang forward; the time never happened)

Callers choose the resolution via `Disambiguation`: `compatible` (matches
`Temporal` and legacy `Date`), `earlier`, `later`, or `reject` to throw rather
than silently move a user's input.

### DST is not cosmetic

A calendar day is not always 1440 minutes. `dayLengthMinutes` returns 1380 on a
spring-forward day and 1500 on a fall-back day, and the time grid sizes each
column from its own hour count. Events stay pinned to the correct wall time, and
transition days show a `23h` / `25h` badge.

## Layout

- `getDaySegments` slices events into per-day pieces, clamped at midnight, with
  `continuesBefore` / `continuesAfter` for flat edges on multi-day events.
- `packSegments` groups overlapping segments into clusters and packs each cluster
  greedily into columns, with a 15-minute collision floor so a 5-minute event
  still gets its own column instead of being drawn underneath another.
- `layoutWeekSpans` places multi-day bars into lanes across a week row, so a
  multi-day event is one continuous bar rather than seven chips.
- `findConflicts` is deliberately timezone-independent — a clash is a clash from
  any zone.
- All-day events are **floating**: they show on the same date in every zone.

## Components

| File | Purpose |
|---|---|
| `src/lib/temporal.ts` | Timezone engine and plain-date arithmetic |
| `src/lib/events.ts` | Event model, day segments, span/column layout, conflicts |
| `src/components/ui/calendar.tsx` | Date picker — drop-in replacement for the spec'd `Calendar` |
| `src/components/ui/event-calendar.tsx` | Month / week / day / agenda event views |
| `src/components/ui/button.tsx` | Design system `Button` (6 variants, 8 sizes) |

`Calendar` keeps the documented API (`mode`, `selected`, `onSelect`,
`showOutsideDays`, `captionLayout`, `buttonVariant`, `showWeekNumber`,
`timeZone`, `locale`, `dir`, `formatters`, `classNames`) and emits the specified
data attributes (`data-slot`, `data-day`, `data-selected-single`,
`data-range-start` / `-end` / `-middle`, `data-selected`, `data-focused`), so
existing styling and tests keep working. It adds full grid keyboard navigation
with a roving tabindex, and an `eventDays` prop that renders the design system's
event-indicator slot beneath a day.

Every colour references a CSS variable — no literals in component code — so
light/dark mode and theme swaps work through the token layer.

## Commands

```bash
npm install
npm run dev        # http://localhost:5177
npm test           # 93 unit tests
npm run typecheck
npm run build
npm run lint
```

Tests concentrate on the parts that are easy to get quietly wrong: DST gaps and
overlaps, half-hour offset zones, day-boundary crossings between zones, midnight
clamping, and overlap column packing.
