import type { Health, LogEvent } from './types';

// POST /api/book — start an on-demand booking for a numeric activity code.
// On 409 the server is busy; data carries { error:'busy', state }.
export async function book(code: string): Promise<{ ok: boolean; status: number; data: any }> {
  const res = await fetch('/api/book', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code }),
  });
  return { ok: res.ok, status: res.status, data: await res.json() };
}

// POST /api/stop — cancel the running job. Returns { stopped, state }.
export async function stop(): Promise<any> {
  return fetch('/api/stop', { method: 'POST' }).then((r) => r.json());
}

// POST /api/login — open a server-side browser window for the user to sign into Markham.
// 200 { started:true } | 409 { error:'busy' }.
export async function login(): Promise<{ ok: boolean; status: number; data: any }> {
  const res = await fetch('/api/login', { method: 'POST' });
  return { ok: res.ok, status: res.status, data: await res.json() };
}

export async function getHealth(): Promise<Health> {
  return fetch('/api/health').then((r) => r.json());
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
