import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { streamSSE } from 'hono/streaming';
import { BookRequestSchema, type LogEvent } from './shared/types.js';
import { events } from './events.js';
import { jobManager } from './job.js';
import { loginManager } from './login.js';
import { profileLock } from './profile.js';

const app = new Hono();

// Start a book-by-code job. One job at a time: a second request while running gets 409 busy.
app.post('/api/book', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const parsed = BookRequestSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
  const r = jobManager.start(parsed.data.code);
  if (r.busy) return c.json({ error: 'busy', state: r.state }, 409);
  return c.json({ started: true, state: r.state });
});

app.post('/api/stop', (c) => {
  const r = jobManager.stop();
  return c.json(r);
});

// Open a server-launched login window (shares the single-profile mutex with booking).
app.post('/api/login', (c) => {
  const r = loginManager.start((e) => events.emit(e));
  if (r.busy) return c.json({ error: 'busy' }, 409);
  return c.json({ started: true });
});

app.get('/api/health', (c) =>
  c.json({
    uptimeSec: Math.round(process.uptime()),
    job: jobManager.snapshot(),
    loginActive: profileLock.who() === 'login',
  }),
);

app.get('/events', (c) =>
  streamSSE(c, async (stream) => {
    let open = true;
    // hydrate a late-connecting UI with the current job state before live events stream.
    await stream.writeSSE({ data: JSON.stringify({ type: 'job', state: jobManager.snapshot(), at: new Date().toISOString() }) });
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
serve({ fetch: app.fetch, port }, (info) => console.log(`pball UI → http://localhost:${info.port}`));
