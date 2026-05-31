import type { Health, LogEvent, TargetRow, WidgetFilters } from './types';

export async function listTargets(): Promise<TargetRow[]> {
  return fetch('/api/targets').then((r) => r.json());
}

// POST /api/targets. Body may include `id` for update. On !ok, returns parsed
// error json so caller can alert; on ok, returns the saved target.
export async function saveTarget(body: unknown): Promise<{ ok: boolean; data: unknown }> {
  const res = await fetch('/api/targets', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { ok: res.ok, data: await res.json() };
}

export async function deleteTarget(id: string): Promise<void> {
  await fetch('/api/targets/' + id, { method: 'DELETE' });
}

export function runNow(id: string): Promise<Response> {
  return fetch('/api/targets/' + id + '/run', { method: 'POST' });
}

export async function getHealth(): Promise<Health> {
  return fetch('/api/health').then((r) => r.json());
}

// GET /api/filters — activity + location options from the live Markham widget.
export async function getFilters(): Promise<WidgetFilters> {
  return fetch('/api/filters').then((r) => r.json());
}

export function subscribeEvents(onEvent: (e: LogEvent) => void): EventSource {
  const es = new EventSource('/events');
  es.onmessage = (m) => onEvent(JSON.parse(m.data) as LogEvent);
  return es;
}
