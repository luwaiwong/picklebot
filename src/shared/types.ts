import { z } from 'zod';

// ── Constants (verified live against the Markham PerfectMind widget) ──
export const TZ = 'America/Toronto';
export const BASE_URL = 'https://cityofmarkham.perfectmind.com';
export const DEFAULT_WIDGET_ID = '6825ea71-e5b7-4c2a-948f-9195507ad90a'; // Drop-In programs widget
export const DEFAULT_CALENDAR_ID = '491a603e-4043-4ab6-b04d-8fac51edbcfc'; // Sports & Activities calendar

// ── Book-by-code request: the user types a numeric activity code (== CourseId on the site) ──
export const BookRequestSchema = z.object({ code: z.string().trim().regex(/^\d+$/, 'code must be numeric') });
export type BookRequest = z.infer<typeof BookRequestSchema>;

export type BookStatus = 'booked' | 'no-slot' | 'not-found' | 'auth-expired' | 'queue-timeout' | 'cancelled' | 'error';
export interface BookResult { ok: boolean; status: BookStatus; detail?: string; at: string; }

export type JobPhase = 'idle' | 'running' | 'success' | 'failed';
export interface JobState { phase: JobPhase; code: string | null; startedAt: string | null; finishedAt: string | null; lastStatus: BookStatus | null; lastDetail: string | null; }

export type LogEvent =
  | { type: 'log'; code?: string; level: 'info' | 'warn' | 'error'; msg: string; at: string }
  | { type: 'queue'; code: string; state: 'waiting' | 'through'; at: string }
  | { type: 'result'; code: string; result: BookResult; at: string }
  | { type: 'job'; state: JobState; at: string }
  | { type: 'login'; state: 'opening' | 'open' | 'signed-in' | 'closed' | 'error'; detail?: string; at: string };
