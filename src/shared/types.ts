import { z } from 'zod';
import { ACTIVITY_IDS } from './activities.js';

// ── Constants (verified live against the Markham PerfectMind widget) ──
export const TZ = 'America/Toronto';
export const BASE_URL = 'https://cityofmarkham.perfectmind.com';
export const DEFAULT_WIDGET_ID = '6825ea71-e5b7-4c2a-948f-9195507ad90a'; // Drop-In programs widget
export const DEFAULT_CALENDAR_ID = '491a603e-4043-4ab6-b04d-8fac51edbcfc'; // Sports & Activities calendar
// ACTIVITY_IDS now lives in ./activities (zero-dep, so the web client can import it without zod)
export { ACTIVITY_IDS };

// ── A booking target: what to grab, when to try, and the safety rules ──
// Slots are resolved by ATTRIBUTE (date + time + facility) at run time, never by a cached
// EventId — EventId is not stable per occurrence on this site.
const TargetObject = z.object({
  id: z.string().optional(),
  widgetId: z.string().default(DEFAULT_WIDGET_ID),
  calendarId: z.string().default(DEFAULT_CALENDAR_ID),
  // One or more Service-group activity GUIDs; the calendar is fetched per id and merged.
  activityIds: z.array(z.string()).min(1).default([ACTIVITY_IDS.ADULTS]),

  // Which session to book — an absolute instant (stored ISO; JSON bodies/strings are coerced
  // to a Date). The America/Toronto wall-clock date+time is derived from it for calendar
  // matching. One time per target — alternate times = separate one-shot targets.
  sessionStart: z.coerce.date(), // e.g. new Date("2026-06-09T19:00:00-04:00")
  locationPrefs: z.array(z.string()).default([]), // ordered Facility/Location substrings; [] = any

  // Attempt window. release = sessionStart - windowLeadHours (resident lead = 18h),
  // refined live from GetEvent when available. The bot only acts inside the window.
  windowLeadHours: z.number().default(18),
  warmupSeconds: z.number().int().min(0).default(60), // be authed + on-page this early
  windowMinutes: z.number().min(0.1).default(10), // keep trying this long after release, then give up

  // Safety rules. Cost is NOT configurable: the bot books only when the slot is FREE ($0).
  // Any price > $0 -> STOP + report 'too-expensive', never charges.
  joinWaitlistIfFull: z.boolean().default(true), // full + waitlist offered -> join; else report
  dryRun: z.boolean().default(false), // true = stop before the final irreversible confirm (testing)
  // No `enabled` flag: every saved target is armed. Targets are create-only (delete + recreate to change).
});

// Back-compat: older rows stored a single `activityId` — fold it into the array before validating.
export const TargetSchema = z.preprocess((v) => {
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    const o = v as Record<string, unknown>;
    if (o.activityIds === undefined && o.activityId !== undefined) {
      const { activityId, ...rest } = o;
      return { ...rest, activityIds: activityId ? [activityId] : undefined };
    }
  }
  return v;
}, TargetObject);
export type Target = z.infer<typeof TargetSchema>;
export type TargetInput = z.input<typeof TargetSchema>;

export type BookStatus =
  | 'booked'
  | 'waitlisted'
  | 'would-book' // dryRun reached the confirm step
  | 'full-no-waitlist'
  | 'too-expensive' // slot had a cost > $0; bot books only when free
  | 'no-slot' // window elapsed, slot never became bookable
  | 'auth-expired'
  | 'queue-timeout'
  | 'not-captured' // commit selectors not yet captured (M3)
  | 'error';

export interface BookResult {
  ok: boolean;
  status: BookStatus;
  detail?: string;
  facility?: string;
  priceCents?: number;
  at: string; // ISO
}

export type LogEvent =
  | { type: 'scheduled'; targetId: string; label: string; fireAt: string; release: string; at: string }
  | { type: 'log'; targetId?: string; level: 'info' | 'warn' | 'error'; msg: string; at: string }
  | { type: 'queue'; targetId: string; state: 'waiting' | 'through'; etaSec?: number; at: string }
  | { type: 'auth'; valid: boolean; at: string }
  | { type: 'result'; targetId: string; label: string; result: BookResult; at: string }
  | { type: 'deleted'; targetId: string; label: string; at: string };
