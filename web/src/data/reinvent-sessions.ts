import type { CalendarEventInput } from '@/lib/events'

/**
 * AWS re:Invent 2025 runs Dec 1-5 in Las Vegas.
 *
 * Every session below is authored as a *floating* wall-clock string plus an
 * explicit `timeZone`, which is exactly the shape the MCP server's `sessions`
 * table stores (`start_datetime` / `end_datetime` as naive TEXT). Pinning them
 * to `EVENT_TIME_ZONE` here is what makes them survive a timezone change in the
 * viewer.
 */
export const EVENT_TIME_ZONE = 'America/Los_Angeles'

export const REINVENT_DAYS = [
  { day: 'monday', date: '2025-12-01' },
  { day: 'tuesday', date: '2025-12-02' },
  { day: 'wednesday', date: '2025-12-03' },
  { day: 'thursday', date: '2025-12-04' },
  { day: 'friday', date: '2025-12-05' },
] as const

export const REINVENT_SESSIONS: CalendarEventInput[] = [
  // ----------------------------- Monday Dec 1 -----------------------------
  {
    id: 'REG100',
    title: 'Registration open',
    start: '2025-12-01 07:00',
    end: '2025-12-01 19:00',
    timeZone: EVENT_TIME_ZONE,
    location: 'The Venetian — Level 2',
    color: 'muted',
    meta: { type: 'Logistics' },
  },
  {
    id: 'EXPO01',
    title: 'Expo open',
    start: '2025-12-01',
    end: '2025-12-04',
    allDay: true,
    timeZone: EVENT_TIME_ZONE,
    location: 'The Venetian — Expo Hall',
    color: 'chart-5',
    meta: { type: 'Expo' },
  },
  {
    id: 'CMP201',
    title: 'Deep dive on Graviton4 price/performance',
    start: '2025-12-01 10:00',
    end: '2025-12-01 11:00',
    timeZone: EVENT_TIME_ZONE,
    location: 'Wynn — Cristal 5',
    color: 'chart-1',
    description: 'Benchmarks and migration patterns for Arm-based workloads.',
    meta: { level: 200, type: 'Breakout session' },
  },
  {
    id: 'DAT301',
    title: 'Aurora DSQL: how active-active actually works',
    start: '2025-12-01 10:30',
    end: '2025-12-01 11:30',
    timeZone: EVENT_TIME_ZONE,
    location: 'Caesars Forum — Summit 220',
    color: 'chart-2',
    description: 'Overlaps CMP201 deliberately, to exercise conflict detection.',
    meta: { level: 300, type: 'Breakout session' },
  },
  {
    id: 'AIM205',
    title: 'Bedrock AgentCore in production',
    start: '2025-12-01 13:00',
    end: '2025-12-01 14:00',
    timeZone: EVENT_TIME_ZONE,
    location: 'MGM Grand — Room 122',
    color: 'chart-3',
    meta: { level: 200, type: 'Breakout session' },
  },
  {
    id: 'NET401',
    title: 'Advanced VPC routing patterns',
    start: '2025-12-01 15:30',
    end: '2025-12-01 17:00',
    timeZone: EVENT_TIME_ZONE,
    location: 'Mandalay Bay — Oceanside D',
    color: 'chart-4',
    meta: { level: 400, type: 'Workshop' },
  },

  // ---------------------------- Tuesday Dec 2 -----------------------------
  {
    id: 'KEY001',
    title: 'Opening Keynote — Matt Garman',
    start: '2025-12-02 08:00',
    end: '2025-12-02 10:30',
    timeZone: EVENT_TIME_ZONE,
    location: 'The Venetian — Palazzo Ballroom',
    color: 'primary',
    description: 'The one session everyone plans their week around.',
    meta: { type: 'Keynote' },
  },
  {
    id: 'SEC302',
    title: 'Zero-trust service-to-service auth',
    start: '2025-12-02 11:30',
    end: '2025-12-02 12:30',
    timeZone: EVENT_TIME_ZONE,
    location: 'Wynn — Latour 4',
    color: 'chart-2',
    meta: { level: 300, type: 'Breakout session' },
  },
  {
    id: 'SVS309',
    title: 'Lambda cold starts: measuring what matters',
    start: '2025-12-02 13:00',
    end: '2025-12-02 14:00',
    timeZone: EVENT_TIME_ZONE,
    location: 'Caesars Forum — Academy 411',
    color: 'chart-1',
    meta: { level: 300, type: 'Breakout session' },
  },
  {
    id: 'DAT402',
    title: 'S3 Tables and Iceberg at petabyte scale',
    start: '2025-12-02 13:30',
    end: '2025-12-02 14:30',
    timeZone: EVENT_TIME_ZONE,
    location: 'MGM Grand — Chairman 355',
    color: 'chart-4',
    description: 'Overlaps SVS309 by 30 minutes.',
    meta: { level: 400, type: 'Breakout session' },
  },
  {
    id: 'AIM410',
    title: 'Fine-tuning on SageMaker HyperPod',
    start: '2025-12-02 14:00',
    end: '2025-12-02 15:00',
    timeZone: EVENT_TIME_ZONE,
    location: 'The Venetian — Murano 3201',
    color: 'chart-3',
    description: 'Three-way overlap with SVS309 and DAT402.',
    meta: { level: 400, type: 'Breakout session' },
  },
  {
    id: 'PARTY01',
    title: 'Partner reception',
    start: '2025-12-02 18:30',
    end: '2025-12-02 21:00',
    timeZone: EVENT_TIME_ZONE,
    location: 'Wynn — Encore Beach Club',
    color: 'chart-5',
    meta: { type: 'Social' },
  },

  // --------------------------- Wednesday Dec 3 ----------------------------
  {
    id: 'KEY002',
    title: 'Keynote — Dr. Swami Sivasubramanian',
    start: '2025-12-03 08:30',
    end: '2025-12-03 10:30',
    timeZone: EVENT_TIME_ZONE,
    location: 'The Venetian — Palazzo Ballroom',
    color: 'primary',
    meta: { type: 'Keynote' },
  },
  {
    id: 'CON312',
    title: 'EKS Auto Mode in anger',
    start: '2025-12-03 11:00',
    end: '2025-12-03 12:00',
    timeZone: EVENT_TIME_ZONE,
    location: 'Caesars Forum — Alliance 305',
    color: 'chart-1',
    meta: { level: 300, type: 'Breakout session' },
  },
  {
    id: 'OPS205',
    title: 'Observability without the bill shock',
    start: '2025-12-03 14:00',
    end: '2025-12-03 15:30',
    timeZone: EVENT_TIME_ZONE,
    location: 'Mandalay Bay — Reef C',
    color: 'chart-2',
    meta: { level: 200, type: 'Chalk talk' },
  },
  {
    id: 'DEV301',
    title: 'Building agentic developer workflows',
    start: '2025-12-03 16:00',
    end: '2025-12-03 17:00',
    timeZone: EVENT_TIME_ZONE,
    location: 'MGM Grand — Premier 314',
    color: 'chart-3',
    meta: { level: 300, type: 'Breakout session' },
  },

  // ---------------------------- Thursday Dec 4 ----------------------------
  {
    id: 'KEY003',
    title: 'Keynote — Werner Vogels',
    start: '2025-12-04 08:30',
    end: '2025-12-04 10:30',
    timeZone: EVENT_TIME_ZONE,
    location: 'The Venetian — Palazzo Ballroom',
    color: 'primary',
    meta: { type: 'Keynote' },
  },
  {
    id: 'ARC403',
    title: 'Multi-region failover you can actually test',
    start: '2025-12-04 11:00',
    end: '2025-12-04 12:30',
    timeZone: EVENT_TIME_ZONE,
    location: 'Wynn — Margaux 2',
    color: 'chart-4',
    meta: { level: 400, type: 'Workshop' },
  },
  {
    id: 'REPLAY',
    title: 're:Play party',
    start: '2025-12-04 20:00',
    // Deliberately crosses midnight to exercise segment clamping.
    end: '2025-12-05 01:00',
    timeZone: EVENT_TIME_ZONE,
    location: 'Las Vegas Festival Grounds',
    color: 'chart-5',
    meta: { type: 'Social' },
  },

  // ----------------------------- Friday Dec 5 -----------------------------
  {
    id: 'CMP405',
    title: 'Nitro internals and confidential compute',
    start: '2025-12-05 09:00',
    end: '2025-12-05 10:00',
    timeZone: EVENT_TIME_ZONE,
    location: 'The Venetian — Lido 3005',
    color: 'chart-1',
    meta: { level: 400, type: 'Breakout session' },
  },
  {
    id: 'CLOSE1',
    title: 'Closing remarks and Dev Chat',
    start: '2025-12-05 11:30',
    end: '2025-12-05 12:30',
    timeZone: EVENT_TIME_ZONE,
    location: 'The Venetian — Level 4',
    color: 'chart-2',
    meta: { type: 'Session' },
  },

  // A personal event authored in a *different* zone, to prove per-event zones.
  // 08:00 in Paris on Dec 3 is 23:00 on Dec 2 in Las Vegas.
  {
    id: 'PERSONAL01',
    title: 'Standup with the Paris team',
    start: '2025-12-03 08:00',
    end: '2025-12-03 08:30',
    timeZone: 'Europe/Paris',
    location: 'Video call',
    color: 'destructive',
    description:
      'Authored in Europe/Paris. Note how it lands late on Dec 2 in Las Vegas time.',
    meta: { type: 'Personal' },
  },
]

/** Zones offered in the demo switcher, chosen to span the interesting cases. */
export const TIME_ZONE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'America/Los_Angeles', label: 'Las Vegas (event time)' },
  { value: 'America/New_York', label: 'New York' },
  { value: 'America/Sao_Paulo', label: 'São Paulo' },
  { value: 'UTC', label: 'UTC' },
  { value: 'Europe/London', label: 'London' },
  { value: 'Europe/Paris', label: 'Paris' },
  { value: 'Asia/Kolkata', label: 'Bengaluru (+5:30)' },
  { value: 'Asia/Tokyo', label: 'Tokyo' },
  { value: 'Australia/Sydney', label: 'Sydney' },
]
