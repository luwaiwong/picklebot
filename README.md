# pball — Markham drop-in pickleball booker

A local bot that books City of Markham drop-in pickleball the instant a slot opens
(~18 h before the session, for residents). Configure targets in a web UI; the bot
schedules each one, waits through any Queue-it line, and books — **only if the slot is
free** (configurable) and not full.

## How it works

- **Read/detect:** polls the solved `ClassesV2` JSON API to watch a slot flip to "Register".
- **Commit:** drives a real Chromium (Playwright) using your saved login session, so the
  Queue-it token + ASP.NET anti-forgery are handled like a human.
- **Login:** done **once, by hand** (`npm run codegen`) — the bot reuses the session cookies;
  it never stores or types your password, and never hits the login reCAPTCHA at run time.
- **One-shot:** each scheduled target runs exactly once, then is **deleted**. Alternate
  times = separate targets.

## Safety gates

- **Cost:** **free only** — not configurable. The bot reads the real price at the confirm
  step; if it is anything other than **$0** it **stops and reports** (`too-expensive`),
  never charging you.
- **Full:** joins the **waitlist** when the event offers one, else reports `full-no-waitlist`.
- **Dry run:** per-target toggle — does everything except the final confirm.
- ⚠️ **No-show policy:** Markham suspends memberships for *"frequent no-shows or misuse of
  pre-registering."* Only auto-book sessions you will actually attend.

## Setup (run order)

```bash
npm install
npm run install-browsers          # playwright chromium

# 1) Log in ONCE by hand (solve the reCAPTCHA) -> saves auth.json
npm run codegen

# 2) Capture the booking commit flow + selectors -> capture.json  (see M3 below)
npm run capture

# 3) Start the app (leave it running)
npm run dev                       # two processes: Hono API (:8787) + Vite dev (:5173)
                                  # open http://localhost:5173 — Vite proxies /api + /events to the backend
```

`npm run dev` runs the backend (`tsx watch src/server.ts`) and the Vite dev server
(`vite`, hot-reloading the `web/` Svelte app) together via `concurrently`. For a
production-style run, `npm start` builds the frontend (`vite build` → `static/`) and
serves it from Hono on http://localhost:8787.

### M3 — capture the commit selectors (one time)

`npm run capture` opens a browser with your session and logs the booking requests. Click
through Register → confirm on a real session (stop before the final confirm if there's a
fee). Then fill `src/booker.ts` → `config.selectors`:

| selector | what |
|---|---|
| `loggedInMarker` | account/sign-out link present only when logged in |
| `registerButton` | the Register / Add button on the landing page |
| `priceText` | element showing the price/total (drives the cost gate) |
| `confirmButton` | the final, irreversible confirm |
| `confirmSuccess` | success indicator after booking |
| `waitlistButton` | "Join waitlist" button (full + waitlist offered) |
| `slotTakenError` | error shown if the spot was grabbed first |

Until these are filled the bot fails **safe**: it reports `not-captured` instead of clicking.

## Keep it running (Arch, systemd --user)

```bash
cp pball.service ~/.config/systemd/user/pball.service
loginctl enable-linger "$USER"           # survive logout
systemctl --user enable --now pball
journalctl --user -u pball -f            # logs
```

## Re-login when the session expires

The UI shows a red **auth expired** line. Re-run `npm run codegen`. No code change needed.

## Files

| path | role |
|---|---|
| `src/shared/types.ts` | zod `Target` schema + constants (single source of truth) |
| `src/db.ts` | JSON persistence (`targets.json`) |
| `src/events.ts` | SSE bus + `bookings.log` audit trail |
| `src/timezone.ts` | DST-safe release math (luxon) + `/Date(ms)/` parsing |
| `src/markham.ts` | ClassesV2/GetEvent adapter; resolve-by-attribute; cost/waitlist parsing |
| `src/booker.ts` | Playwright worker: queue-it, window poll, cost/full/dry-run gates, commit |
| `src/scheduler.ts` | croner one-shot jobs; delete-after-run |
| `src/server.ts` | Hono REST + SSE + static UI |
| `web/` | Vite + Svelte 5 frontend (config UI + live log); `web/src/App.svelte` is the root |
| `static/` | **generated** by `vite build` (gitignored); Hono serves it as the UI |
| `scripts/capture.ts` | one-time selector/request capture helper |
