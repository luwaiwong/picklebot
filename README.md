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

It drives a real Chromium (Playwright). You save your Markham email + password once in the UI;
the bot then **logs in automatically (headless) before each booking**, so the Queue-it token +
ASP.NET anti-forgery are handled like a human. Only **one** job runs at a time — starting a new
one while a job (or a login) is running is rejected as busy; use **Stop** to cancel the active job.

⚠️ **No-show policy:** Markham suspends memberships for *"frequent no-shows or misuse of
pre-registering."* Only book sessions you will actually attend.

## Setup (run order)

```bash
npm install
npm run install-browsers          # playwright chromium

# 1) Start the app (leave it running)
npm run dev                       # two processes: Hono API (:8787) + Vite dev (:5173)
                                  # open http://localhost:5173 — Vite proxies /api + /events to the backend

# 2) In the UI: enter your Markham email + password (saved once), then you're set.
```

**Credentials:** enter your Markham email + password in the web UI — they're saved to a
**gitignored `creds.json`** (overridable via `PBALL_CREDS`). The bot reads them to log in
headlessly before each booking; you can also hit **Login** in the UI to sign in immediately and
verify the credentials work. ⚠️ `creds.json` stores your password in **plaintext on this machine**
(gitignored, never committed). The signed-in session persists to the profile
(`PBALL_USER_DATA_DIR`, default `.pball-profile`).

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

If the bot hits the sign-in wall it reports **auth expired / login-failed**. Because it
auto-logs in before each booking, just retry — it will re-authenticate with your saved creds. If
your password changed, update it in the UI. If login fails with a captcha/device-verification
**challenge**, sign in once manually via the CLI fallback (`npm run login`) to clear the device
check, then the headless login works again.

## Files

| path | role |
|---|---|
| `src/shared/types.ts` | zod `BookRequest` schema + job/result/event/login types + constants |
| `src/events.ts` | SSE bus + `bookings.log` audit trail |
| `src/creds.ts` | credential store (gitignored `creds.json`; never exposes the password) |
| `src/auth.ts` | headless email/password sign-in routine (`ensureLoggedIn`) |
| `src/booker.ts` | Playwright worker: login-then find-by-code, queue-it, wait-for-Register, attendee select |
| `src/job.ts` | single active-job manager (start / stop / snapshot, broadcasts `JobState`) |
| `src/login.ts` | on-demand headless auto-login manager (shares the profile mutex) |
| `src/profile.ts` | single-profile mutex shared by booking + login |
| `src/server.ts` | Hono REST (`/api/book`, `/api/stop`, `/api/creds`, `/api/login`, `/api/health`) + SSE + static UI |
| `web/` | Vite + Svelte 5 frontend (code form + account form + live log); `web/src/App.svelte` is the root |
| `static/` | **generated** by `vite build` (gitignored); Hono serves it as the UI |
| `scripts/login.ts` | CLI fallback: manual headed login into the profile (e.g. to clear a device-verification challenge) |
