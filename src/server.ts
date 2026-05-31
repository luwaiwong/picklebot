import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { streamSSE } from 'hono/streaming';
import { TargetSchema, DEFAULT_WIDGET_ID, DEFAULT_CALENDAR_ID, type LogEvent } from './shared/types.js';
import { fetchWidgetFilters, type WidgetFilters } from './markham.js';
import { db } from './db.js';
import { events } from './events.js';
import { scheduler, fireAt } from './scheduler.js';

const app = new Hono();

app.get('/api/targets', async (c) => {
  const ts = await db.list();
  return c.json(ts.map((t) => ({ ...t, fireAt: fireAt(t).toISOString() })));
});

app.post('/api/targets', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const parsed = TargetSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
  try {
    const saved = parsed.data.id ? await db.update(parsed.data.id, parsed.data) : await db.create(parsed.data);
    scheduler.schedule(saved);
    return c.json(saved);
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
  }
});

app.delete('/api/targets/:id', async (c) => {
  const id = c.req.param('id');
  scheduler.unschedule(id);
  await db.remove(id);
  events.emit({ type: 'deleted', targetId: id, label: '(deleted)', at: new Date().toISOString() });
  return c.json({ ok: true });
});

app.post('/api/targets/:id/run', async (c) => {
  void scheduler.runNow(c.req.param('id'));
  return c.json({ started: true });
});

// Widget filter options (activities + locations) for the form pickers. Near-static, so cache
// per widget+calendar with a 1h TTL; on upstream failure serve stale rather than break the form.
const FILTER_TTL_MS = 60 * 60 * 1000;
const filterCache = new Map<string, { at: number; data: WidgetFilters }>();

app.get('/api/filters', async (c) => {
  const widgetId = c.req.query('widgetId') ?? DEFAULT_WIDGET_ID;
  const calendarId = c.req.query('calendarId') ?? DEFAULT_CALENDAR_ID;
  const key = `${widgetId}:${calendarId}`;
  const hit = filterCache.get(key);
  if (hit && Date.now() - hit.at < FILTER_TTL_MS) return c.json(hit.data);
  try {
    const data = await fetchWidgetFilters(widgetId, calendarId);
    filterCache.set(key, { at: Date.now(), data });
    return c.json(data);
  } catch (e) {
    if (hit) return c.json(hit.data); // stale beats failing the picker
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 502);
  }
});

app.get('/api/health', (c) =>
  c.json({ uptimeSec: Math.round(process.uptime()), armed: scheduler.armedCount(), nextFireAt: scheduler.nextFireAt() }),
);

app.get('/events', (c) =>
  streamSSE(c, async (stream) => {
    let open = true;
    const unsub = events.subscribe((e: LogEvent) => {
      void stream.writeSSE({ data: JSON.stringify(e) });
    });
    stream.onAbort(() => {
      open = false;
      unsub();
    });
    while (open) await stream.sleep(15_000);
  }),
);

app.get(
  '/*',
  serveStatic({ root: './static', rewriteRequestPath: (p) => (p === '/' ? '/index.html' : p) }),
);

const port = Number(process.env.PBALL_PORT ?? 8787);
await db.init();
await scheduler.reconcile();
serve({ fetch: app.fetch, port }, (info) => console.log(`pball UI → http://localhost:${info.port}`));
