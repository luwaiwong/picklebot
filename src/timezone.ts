import { DateTime } from 'luxon';
import { TZ } from './shared/types.js';

// sessionStart is an absolute instant, so release math is plain instant subtraction
// (DST-safe by construction — absolute time has no offset ambiguity). The Toronto
// wall-clock date/time is derived from the instant only for calendar matching/display.

interface HM {
  hour: number;
  minute: number;
}

export function parseTime(s: string): HM {
  const str = s.trim().toUpperCase();
  let m = /^(\d{1,2}):(\d{2})\s*(AM|PM)$/.exec(str);
  if (m) {
    let h = Number(m[1]) % 12;
    if (m[3] === 'PM') h += 12;
    return { hour: h, minute: Number(m[2]) };
  }
  m = /^(\d{1,2})\s*(AM|PM)$/.exec(str);
  if (m) {
    let h = Number(m[1]) % 12;
    if (m[2] === 'PM') h += 12;
    return { hour: h, minute: 0 };
  }
  m = /^(\d{1,2}):(\d{2})$/.exec(str);
  if (m) return { hour: Number(m[1]), minute: Number(m[2]) };
  throw new Error(`unparseable time: ${s}`);
}

/** Toronto wall-clock parts of an instant, used to match the calendar (yyyyMMdd + HH:mm). */
export function torontoParts(d: Date): { date: string; compact: string; hhmm: string } {
  const dt = DateTime.fromJSDate(d).setZone(TZ);
  return { date: dt.toFormat('yyyy-LL-dd'), compact: dt.toFormat('yyyyLLdd'), hhmm: dt.toFormat('HH:mm') };
}

/** UTC instant registration opens = sessionStart - leadHours. */
export function releaseInstant(sessionStart: Date, leadHours: number): Date {
  return new Date(sessionStart.getTime() - leadHours * 3_600_000);
}

/** Parse PerfectMind's "/Date(1780009200000)/" epoch-ms format -> Date (UTC instant). */
export function parseMsDate(s: string | null | undefined): Date | null {
  if (!s) return null;
  const m = /\/Date\((\d+)(?:[-+]\d+)?\)\//.exec(s);
  return m ? new Date(Number(m[1])) : null;
}

/** Human label in Toronto wall-time, for logs/UI. */
export function fmt(d: Date): string {
  return DateTime.fromJSDate(d).setZone(TZ).toFormat('ccc yyyy-LL-dd HH:mm:ss ZZZZ');
}
