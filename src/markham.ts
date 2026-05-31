import type { APIRequestContext } from 'playwright';
import { BASE_URL, type Target } from './shared/types.js';
import { parseMsDate, parseTime, torontoParts } from './timezone.js';

// Adapter over the live PerfectMind BookMe4 JSON endpoints (verified live):
//   POST /Clients/BookMe4BookingPagesV2/ClassesV2  -> event list (the read/poll path)
//   GET  /Clients/BookMe4/GetEvent                  -> per-occurrence detail (release time, waitlist, price)
// Operated through a Playwright request context so the logged-in cookies + any queue-it
// token are carried automatically.

const CLASSES_URL = `${BASE_URL}/Clients/BookMe4BookingPagesV2/ClassesV2`;
const GETEVENT_URL = `${BASE_URL}/Clients/BookMe4/GetEvent`;
// Filter groups for a widget+calendar (Service = activities, Location = venues). Public, no
// auth/queue-it. Source of the activityId GUIDs and the venue names used by locationPrefs.
const EVENTFILTERS_URL = `${BASE_URL}/Clients/BookMe4BookingPagesV2/EventFilterGroupsV2`;

export interface ClassRow {
  EventId: string;
  ParentEventId?: string;
  CourseId?: string;
  EventName: string;
  Location: string;
  Facility: string;
  OccurrenceDate: string; // "yyyyMMdd"
  FormattedStartTime: string; // "7:00 PM"
  FormattedEndTime: string;
  EventTimeDescription?: string;
  Spots: string; // "" | "Full" | "3 spot(s) left"
  BookButtonText: string; // "More Info" | "Register"
  BookingType: number; // 2 = drop-in
  PriceRange?: string; // "$0.00 - $5.02"
  activityId?: string; // synthetic: the activity filter that surfaced this row (set by fetchClasses)
}

export interface ClassesResponse {
  classes: ClassRow[];
  nextKey?: string | null; // next window's start date ("2026-06-05")
  classesMaxEndDateString?: string;
}

export interface EventInfo {
  residentsRegOpen: Date | null;
  publicRegOpen: Date | null;
  isWaitListAvailable: boolean;
  waitListSpotsLeft: number;
  spotsLeft: number;
  maxCapacity: number;
  prices: unknown[];
  priceRange?: string;
}

/** Thrown when a "read" endpoint returns non-JSON — i.e. a queue-it wall or an error page,
 * NOT an empty result. Callers must route this into queue handling, never treat as no-slot. */
export class NonJsonResponse extends Error {
  constructor(
    public status: number,
    public url: string,
  ) {
    super(`non-json response ${status} ${url}`);
    this.name = 'NonJsonResponse';
  }
}

export function buildClassesBody(t: Target, dateString: string, activityId: string, page = 0): string {
  const p = new URLSearchParams();
  p.set('calendarId', t.calendarId);
  p.set('widgetId', t.widgetId);
  p.set('page', String(page));
  p.set('dateString', dateString); // window start, yyyy-MM-dd
  p.set('values[0].value', activityId);
  p.set('values[0].value2', '');
  p.set('values[0].valueKind', '2'); // Service filter group
  return p.toString();
}

async function postClasses(req: APIRequestContext, t: Target, dateString: string, activityId: string, page: number): Promise<ClassesResponse> {
  const res = await req.post(CLASSES_URL, {
    headers: {
      'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'x-requested-with': 'XMLHttpRequest',
    },
    data: buildClassesBody(t, dateString, activityId, page),
  });
  const ct = res.headers()['content-type'] ?? '';
  if (!res.ok() || !ct.includes('json')) throw new NonJsonResponse(res.status(), res.url());
  // a truncated/garbled body must route into queue-retry too, not abort the run with a raw SyntaxError.
  const json = (await res.json().catch(() => {
    throw new NonJsonResponse(res.status(), res.url());
  })) as ClassesResponse;
  return { classes: json.classes ?? [], nextKey: json.nextKey ?? null };
}

/** Fetch one activity's calendar, paginating forward until the window covers the session date. */
async function fetchActivityClasses(req: APIRequestContext, t: Target, activityId: string): Promise<ClassRow[]> {
  const { date, compact: want } = torontoParts(t.sessionStart);
  let dateString = date; // start the window at the target date (Toronto wall-clock)
  const all: ClassRow[] = [];
  for (let window = 0; window < 6; window++) {
    const resp = await postClasses(req, t, dateString, activityId, 0); // page 0 of each ~14-day window
    all.push(...resp.classes);
    if (all.some((r) => r.OccurrenceDate === want)) break; // got our date
    if (!resp.nextKey || resp.nextKey === dateString) break; // no more windows
    dateString = resp.nextKey; // advance to the next window (nextKey is a date)
  }
  return all;
}

/** Fetch the calendar for each selected activity (in priority order) and merge, deduping by
 * occurrence. Each row is tagged with the activity that surfaced it; on a duplicate the
 * higher-priority activity wins (it was iterated first). */
export async function fetchClasses(req: APIRequestContext, t: Target): Promise<ClassRow[]> {
  const seen = new Set<string>();
  const merged: ClassRow[] = [];
  for (const activityId of t.activityIds) {
    for (const r of await fetchActivityClasses(req, t, activityId)) {
      const key = `${r.EventId}|${r.OccurrenceDate}`;
      if (!seen.has(key)) {
        seen.add(key);
        merged.push({ ...r, activityId });
      }
    }
  }
  return merged;
}

/** Resolve candidate rows by ATTRIBUTE (date + time + location prefs), ranked by priority.
 * Activity priority is primary, location priority secondary — so the booker books the first
 * bookable row of the most-preferred activity. Location prefs also FILTER (none of them = any).
 * Never relies on a cached EventId. */
export function matchRows(rows: ClassRow[], t: Target): ClassRow[] {
  const { compact: want, hhmm: time } = torontoParts(t.sessionStart);
  const matched = rows.filter((r) => r.OccurrenceDate === want && normTime(r.FormattedStartTime) === time);

  // index in t.activityIds (= priority); unknown/untagged sorts last
  const activityRank = (r: ClassRow) => {
    const i = r.activityId ? t.activityIds.indexOf(r.activityId) : -1;
    return i < 0 ? t.activityIds.length : i;
  };
  // index of the first matching location pref; length = no pref matched
  const locationRank = (r: ClassRow) => {
    const hay = `${r.Facility} ${r.Location}`.toLowerCase();
    const i = t.locationPrefs.findIndex((p) => hay.includes(p.toLowerCase()));
    return i < 0 ? t.locationPrefs.length : i;
  };

  // with location prefs set, only those locations are eligible (unchanged behavior)
  const pool = t.locationPrefs.length === 0 ? matched : matched.filter((r) => locationRank(r) < t.locationPrefs.length);

  // stable sort: activity priority, then location priority, then original order for ties
  return pool
    .map((r, i) => ({ r, i }))
    .sort((a, b) => activityRank(a.r) - activityRank(b.r) || locationRank(a.r) - locationRank(b.r) || a.i - b.i)
    .map((x) => x.r);
}

export function isBookable(r: ClassRow): boolean {
  return r.BookButtonText.trim().toLowerCase() === 'register';
}

export function landingUrl(t: Target, r: ClassRow): string {
  const p = new URLSearchParams({ widgetId: t.widgetId, classId: r.EventId, occurrenceDate: r.OccurrenceDate });
  return `${BASE_URL}/Clients/BookMe4LandingPages/Class?${p.toString()}`;
}

export async function getEvent(req: APIRequestContext, t: Target, eventId: string, occurrenceDate: string): Promise<EventInfo | null> {
  const p = new URLSearchParams({ eventId, calendarId: t.calendarId, widgetId: t.widgetId, occurrenceDate });
  const res = await req.get(`${GETEVENT_URL}?${p.toString()}`);
  if (!res.ok() || !(res.headers()['content-type'] ?? '').includes('json')) return null;
  const d = (await res.json()) as Record<string, unknown>;
  return {
    residentsRegOpen: parseMsDate(d['ResidentsRegistrationDateValue'] as string),
    publicRegOpen: parseMsDate(d['PublicRegistrationStartDateValue'] as string),
    isWaitListAvailable: Boolean(d['IsWaitListAvailable']),
    waitListSpotsLeft: Number(d['WaitListSpotsLeft'] ?? 0),
    spotsLeft: Number(d['SpotsLeft'] ?? 0),
    maxCapacity: Number(d['MaximumCapacity'] ?? 0),
    prices: (d['Prices'] as unknown[]) ?? [],
    priceRange: d['PriceRange'] as string | undefined,
  };
}

/** Max dollar amount (in cents) mentioned in a "$0.00 - $5.02" range string, or null. */
export function priceRangeMaxCents(range?: string): number | null {
  if (!range) return null;
  const nums = [...range.matchAll(/\$([0-9]+(?:\.[0-9]{1,2})?)/g)].map((m) => Math.round(parseFloat(m[1]!) * 100));
  return nums.length ? Math.max(...nums) : null;
}

// ── Widget filter groups (drives the form's activity + location pickers) ──
export interface FilterOption {
  value: string; // GUID (Service group value = a Target.activityIds entry)
  name: string; // display label (Location group name = a locationPrefs substring)
}
export interface WidgetFilters {
  activities: FilterOption[]; // "Service" group (FilterGroupKind 2)
  locations: FilterOption[]; // "Location" group (FilterGroupKind 5) — venues
}

interface RawFilterValue {
  Name: string;
  Value: string | null;
  ValueKind: number;
}
interface RawFilterGroup {
  GroupName: string;
  FilterGroupKind: number;
  Values: RawFilterValue[] | null;
}

/** Read a widget+calendar's filter groups straight from the public EventFilterGroupsV2 endpoint.
 * Returns the Service group (activities, each Value = an activityId GUID) and the Location group
 * (venue names that feed locationPrefs matching). Facility (kind 3) is intentionally ignored —
 * its names are generic and duplicated, useless as a substring filter. */
export async function fetchWidgetFilters(widgetId: string, calendarId: string): Promise<WidgetFilters> {
  const p = new URLSearchParams({ widgetId, calendarId });
  const res = await fetch(`${EVENTFILTERS_URL}?${p.toString()}`, { headers: { 'x-requested-with': 'XMLHttpRequest' } });
  if (!res.ok || !(res.headers.get('content-type') ?? '').includes('json')) throw new NonJsonResponse(res.status, res.url);
  const j = (await res.json()) as { filterGroups?: RawFilterGroup[] };
  const pick = (kind: number): FilterOption[] =>
    (j.filterGroups?.find((g) => g.FilterGroupKind === kind)?.Values ?? [])
      .filter((v): v is RawFilterValue & { Value: string } => Boolean(v.Value && v.Name))
      .map((v) => ({ value: v.Value, name: v.Name }));
  return { activities: pick(2), locations: pick(5) };
}

/** Normalize "07:00 PM" / "7:00 PM" / "7 PM" / "19:00" -> "19:00" for comparison. */
function normTime(s: string): string {
  try {
    const t = parseTime(s);
    return `${String(t.hour).padStart(2, '0')}:${String(t.minute).padStart(2, '0')}`;
  } catch {
    return (s ?? '').trim();
  }
}
