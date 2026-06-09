import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { streamSSE } from 'hono/streaming';
import { BookRequestSchema, type LogEvent } from './shared/types.js';
import { events } from './events.js';
import { jobManager } from './job.js';
import { closeActive } from './booker.js';

const app = new Hono();

// Start a book-by-code job: log in with the supplied creds, then book. One job at a time — a
// second request while running gets 409 busy. Credentials are used only for this run, never stored.
app.post('/api/book', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const parsed = BookRequestSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
  const { code, username, password } = parsed.data;
  const r = jobManager.start(code, { username, password });
  if (r.busy) return c.json({ error: 'busy', state: r.state }, 409);
  return c.json({ started: true, state: r.state });
});

app.post('/api/stop', (c) => {
  const r = jobManager.stop();
  return c.json(r);
});

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

// Close any browser this process owns on shutdown so a stop/restart never orphans a Chromium
// holding the persistent profile (which would otherwise freeze the next launch). stop() only
// closes a browser while a job is RUNNING, so the keep-open-after-success window needs the
// explicit closeActive() here too.
let shuttingDown = false;
const shutdown = async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    jobManager.stop();
    await closeActive();
  } finally {
    process.exit(0);
  }
};
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
  process.on(sig, () => void shutdown());
}
