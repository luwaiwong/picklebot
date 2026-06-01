import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import { BookRequestSchema, type LogEvent } from './shared/types.js';
import { events } from './events.js';
import { jobManager } from './job.js';
import { loginManager } from './login.js';
import { profileLock } from './profile.js';
import { saveCreds, loadCreds, credsInfo } from './creds.js';

const app = new Hono();

const CredsSchema = z.object({
  username: z.string().trim().min(1, 'username required'),
  password: z.string().min(1, 'password required'),
});

// Start a book-by-code job. One job at a time: a second request while running gets 409 busy.
app.post('/api/book', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const parsed = BookRequestSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
  const creds = await loadCreds(); // bot logs in headlessly before booking when set
  const r = jobManager.start(parsed.data.code, creds);
  if (r.busy) return c.json({ error: 'busy', state: r.state }, 409);
  return c.json({ started: true, state: r.state });
});

// Save Markham credentials for headless auto-login (gitignored creds.json; password plaintext).
app.post('/api/creds', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const parsed = CredsSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
  await saveCreds(parsed.data);
  return c.json({ ok: true });
});

// Safe view of stored creds — never returns the password.
app.get('/api/creds', async (c) => c.json(await credsInfo()));

app.post('/api/stop', (c) => {
  const r = jobManager.stop();
  return c.json(r);
});

// Trigger a headless auto-login with the saved creds (shares the single-profile mutex with booking).
app.post('/api/login', async (c) => {
  const r = await loginManager.start((e) => events.emit(e));
  if (r.noCreds) return c.json({ error: 'no-credentials' }, 400);
  if (r.busy) return c.json({ error: 'busy' }, 409);
  return c.json({ started: true });
});

app.get('/api/health', async (c) => {
  const { hasCreds } = await credsInfo();
  return c.json({
    uptimeSec: Math.round(process.uptime()),
    job: jobManager.snapshot(),
    loginActive: profileLock.who() === 'login',
    hasCreds,
  });
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
