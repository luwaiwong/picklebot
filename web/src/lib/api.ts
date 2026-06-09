import type { LogEvent } from './types';

// POST /api/book — log in with the given creds then start an on-demand booking.
// Creds are sent per booking; the UI persists them client-side (localStorage) for prefill, never server-side.
// On 409 the server is busy; data carries { error:'busy', state }.
export async function book(
  code: string,
  username: string,
  password: string,
): Promise<{ ok: boolean; status: number; data: any }> {
  const res = await fetch('/api/book', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code, username, password }),
  });
  return { ok: res.ok, status: res.status, data: await res.json() };
}

// POST /api/stop — cancel the running job. Returns { stopped, state }.
export async function stop(): Promise<any> {
  return fetch('/api/stop', { method: 'POST' }).then((r) => r.json());
}

export function subscribeEvents(onEvent: (e: LogEvent) => void): EventSource {
  const es = new EventSource('/events');
  // one malformed frame must not kill the stream
  es.onmessage = (m) => {
    try {
      onEvent(JSON.parse(m.data) as LogEvent);
    } catch (err) {
      console.error('bad SSE frame', err);
    }
  };
  return es;
}
