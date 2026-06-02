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

It drives a real Chromium (Playwright). You enter your Markham email + password **alongside the
code**; on **Book** the bot logs in (headless) and then books — one action, so the Queue-it token +
ASP.NET anti-forgery are handled like a human. Credentials are used only for that run — **never
saved to disk, never logged**. Only **one** job runs at a time — a second request while a job is
running is rejected as busy; use **Stop** to cancel the active job.

⚠️ **No-show policy:** Markham suspends memberships for *"frequent no-shows or misuse of
pre-registering."* Only book sessions you will actually attend.

## Setup (run order)

```bash
npm install
npm run install-browsers          # playwright chromium

# 1) Start the app (leave it running)
npm run dev                       # two processes: Hono API (:8787) + Vite dev (:5173)
                                  # open http://localhost:5173 — Vite proxies /api + /events to the backend

# 2) In the UI: enter the activity code + your Markham email & password, then click Book.
```

**Credentials:** entered in the web UI together with the activity code and submitted with the
**Book** request. They are used only to log in for that single run — **nothing is written to disk
and the password is never logged or emitted**. The signed-in browser session is reused from the
profile (`PBALL_USER_DATA_DIR`, default `.pball-profile`) when still valid, so repeat bookings
skip the login step.

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

## When login fails

If the bot can't sign in, the booking ends with **login-failed** and a reason in the live log
(bad email/password, or a captcha/device-verification **challenge** the headless login can't
solve). For a challenge, sign in once manually via the CLI fallback (`npm run login`) to clear
the device check on the profile, then re-Book — the reused session skips the login step.

## Files

| path | role |
|---|---|
| `src/shared/types.ts` | zod `BookRequest` schema (code + creds) + job/result/event/login types + constants |
| `src/events.ts` | SSE bus + `bookings.log` audit trail |
| `src/auth.ts` | headless email/password sign-in routine (`ensureLoggedIn`); creds never persisted/logged |
| `src/booker.ts` | Playwright worker: login-then find-by-code, queue-it, wait-for-Register, attendee select |
| `src/job.ts` | single active-job manager (start / stop / snapshot, broadcasts `JobState`) |
| `src/profile.ts` | single-profile mutex (one Chromium drives the profile at a time) |
| `src/server.ts` | Hono REST (`/api/book`, `/api/stop`, `/api/health`) + SSE + static UI |
| `web/` | Vite + Svelte 5 frontend (book form with code + creds, live log); `web/src/App.svelte` is the root |
| `static/` | **generated** by `vite build` (gitignored); Hono serves it as the UI |
| `scripts/login.ts` | CLI fallback: manual headed login into the profile (e.g. to clear a device-verification challenge) |
