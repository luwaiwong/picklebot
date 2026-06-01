# pball — Markham drop-in booker

A local bot that books a City of Markham **drop-in** session **on demand, by code** — works for
any drop-in activity in the Markham drop-in widget (pickleball, badminton, volleyball, …), not
just one sport. Enter the session's numeric activity code in the web UI; the bot immediately
opens the site, finds that row, opens its landing page, and waits (bounded) for the **Register**
button to appear — then clicks it and selects the first family member, stopping just before the
final/payment confirm.

## How it works

1. **You enter a code** — the numeric activity code (`#NNNNNN`, == the site's `CourseId`) shown
   on the Classes list for the session you want.
2. **Find + open:** the bot opens the public Classes list (default widget + calendar), matches
   the row by that code, and clicks its button to navigate to the activity landing page.
3. **Wait for "Register":** it refreshes the landing page until `Register` appears (the site
   only renders it once registration opens), up to ~10 minutes, then clicks it.
4. **Select attendee:** it checks the first family member on the attendee step and stops there.
   The final/payment confirm is **not** automated.
5. **Queue-it:** if a Queue-it waiting room appears at any point, the bot holds position
   passively until released (tokens are server-signed; nothing to solve).

It drives a real Chromium (Playwright) using your saved login session, so the Queue-it token +
ASP.NET anti-forgery are handled like a human. Only **one** job runs at a time — starting a new
one while a job is running is rejected as busy; use **Stop** to cancel the active job.

⚠️ **No-show policy:** Markham suspends memberships for *"frequent no-shows or misuse of
pre-registering."* Only book sessions you will actually attend.

## Setup (run order)

```bash
npm install
npm run install-browsers          # playwright chromium

# 1) Log in ONCE by hand into the persistent profile (solve the reCAPTCHA)
npm run login                     # opens a browser; sign in, then close it

# 2) Start the app (leave it running)
npm run dev                       # two processes: Hono API (:8787) + Vite dev (:5173)
                                  # open http://localhost:5173 — Vite proxies /api + /events to the backend
```

`npm run login` opens a browser against the Markham sign-in page using the persistent profile
(`PBALL_USER_DATA_DIR`, default `.pball-profile`). Sign in, then close the window — the session
persists to disk and is reused by every booker run (no `auth.json`, no password stored).

`npm run dev` runs the backend (`tsx watch src/server.ts`) and the Vite dev server (`vite`,
hot-reloading the `web/` Svelte app) together via `concurrently`. For a production-style run,
`npm start` builds the frontend (`vite build` → `static/`) and serves it from Hono on
http://localhost:8787.

## Keep it running (Arch, systemd --user)

```bash
cp pball.service ~/.config/systemd/user/pball.service
loginctl enable-linger "$USER"           # survive logout
systemctl --user enable --now pball
journalctl --user -u pball -f            # logs
```

## Re-login when the session expires

The UI shows a red **auth expired** line. Re-run `npm run login`. No code change needed.

## Files

| path | role |
|---|---|
| `src/shared/types.ts` | zod `BookRequest` schema + job/result/event types + constants |
| `src/events.ts` | SSE bus + `bookings.log` audit trail |
| `src/booker.ts` | Playwright worker: find-by-code, queue-it, wait-for-Register, attendee select |
| `src/job.ts` | single active-job manager (start / stop / snapshot, broadcasts `JobState`) |
| `src/server.ts` | Hono REST (`/api/book`, `/api/stop`, `/api/health`) + SSE + static UI |
| `web/` | Vite + Svelte 5 frontend (code form + live log); `web/src/App.svelte` is the root |
| `static/` | **generated** by `vite build` (gitignored); Hono serves it as the UI |
| `scripts/login.ts` | one-time login into the persistent profile |
