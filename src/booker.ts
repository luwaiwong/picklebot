import { chromium, type BrowserContext, type Page } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { DateTime } from 'luxon';
import { BASE_URL, TZ, ACTIVITY_IDS, type Target, type BookResult, type BookStatus, type LogEvent } from './shared/types.js';
import { fetchWidgetFilters } from './markham.js';
import { parseTime, torontoParts, fmt } from './timezone.js';

// ── Pure DOM booker ──
// Drives the public Classes list page by READING and CLICKING, exactly like a human:
//   1. open the Classes page (widget + calendar)
//   2. find the relevant entry by its visible text — activity title, location, time, date
//   3. refresh until that entry's button flips from "More Info" to "Register"
//   4. click it
// The button text is what we wait on: the site itself only shows "Register" once resident
// registration opens, so there is no early-booking risk and no own-clock gating needed.
// Clicking "Register" only NAVIGATES to the landing page — it is not the irreversible booking
// step — so this flow stops there (the final confirm is not automated yet).

export const config = {
  pollIntervalMs: 1000,
  queueTimeoutMs: 15 * 60 * 1000,
  classClickTimeoutMs: 15 * 60 * 1000,
  // Selectors for the BookMe4BookingPages/Classes list (verified live).
  sel: {
    row: 'tr.bm-class-row', // one class occurrence
    marker: 'tr.bm-marker-row', // date header row, e.g. "Sun, May 31st, 2026"
    title: '.bm-class-title', // h3 with just the activity name
    time: '.bm-group-item-desc .anchor span[aria-label^="Event time"]', // "12:15 pm - 01:45 pm"
    location: '.location-block span', // "Thornhill Community Centre - Gymnasium: 1"
    button: 'input.bm-button', // value = "Register" (bookable) | "More Info" (full / not open)
  },
};

// Reverse name map used if the public filter endpoint can't be read (queue/offline). The booker
// matches the activity by its visible TITLE, so it needs the activityId GUID's display name.
const FALLBACK_NAMES: Record<string, string> = {
  [ACTIVITY_IDS.ADULTS]: 'Drop-In Pickleball: Adults',
  [ACTIVITY_IDS.ADULT_AND_CHILD]: 'Drop-In Pickleball: Adult and Child',
};

type Emit = (e: LogEvent) => void;
const nowIso = () => new Date().toISOString();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pad = (n: number) => String(n).padStart(2, '0');

// One scanned entry under the table, in the page's own words.
interface Entry {
  date: string; // marker text above it, e.g. "Sun, May 31st, 2026"
  title: string; // activity, e.g. "Drop-In Pickleball: Adults"
  time: string; // "12:15 pm - 01:45 pm"
  loc: string; // location text
  value: string; // button value: "Register" | "More Info"
  btnId: string; // input id, used to click the exact row
}

export async function run(target: Target, emit: Emit): Promise<BookResult> {
  const tid = target.id ?? 'unsaved';
  const log = (level: 'info' | 'warn' | 'error', msg: string) => emit({ type: 'log', level, msg, targetId: tid, at: nowIso() });
  const result = (status: BookStatus, ok: boolean, extra?: Partial<BookResult>): BookResult => {
    const r: BookResult = { ok, status, at: nowIso(), ...extra };
    emit({ type: 'result', targetId: tid, label: fmt(target.sessionStart), result: r, at: nowIso() });
    return r;
  };

  // Browser source:
  //   PBALL_CDP_URL set → attach to an already-running browser (its login + queue-it carry over)
  //   otherwise         → launch a persistent on-disk profile; log in once via `npm run login`,
  //                       reused every run (no auth.json).
  const cdpUrl = process.env.PBALL_CDP_URL;
  const userDataDir = process.env.PBALL_USER_DATA_DIR ?? '.pball-profile';

  let cleanup: () => Promise<void> = async () => {};
  try {
    let ctx: BrowserContext;
    let page: Page;
    if (cdpUrl) {
      // reuse the user's existing browser; open our OWN tab so we never hijack their open tabs.
      const browser = await chromium.connectOverCDP(cdpUrl);
      ctx = browser.contexts()[0] ?? (await browser.newContext());
      page = await ctx.newPage();
      // over CDP, close() only disconnects — it must NOT terminate the user's browser.
      cleanup = async () => {
        await page.close().catch(() => {});
        await browser.close().catch(() => {});
      };
      log('info', `attached to existing browser at ${cdpUrl}`);
    } else {
      // persistent profile holds the login across runs. Visible by default; PBALL_HEADLESS=1 to hide.
      ctx = await chromium.launchPersistentContext(userDataDir, { headless: process.env.PBALL_HEADLESS === '1' });
      page = ctx.pages()[0] ?? (await ctx.newPage());
      cleanup = async () => {
        await ctx.close().catch(() => {});
      };
    }

    // esbuild/tsx wraps named functions with a `__name` helper that doesn't exist in the page
    // context; shim it so serialized page.evaluate callbacks run. Persists across reloads.
    await page.addInitScript(() => {
      const g = globalThis as unknown as { __name?: (f: unknown) => unknown };
      g.__name ??= (f) => f;
    });

    // What we're looking for, in the page's terms: Toronto wall-clock date + start time, and the
    // activity title(s) for the configured activityId GUID(s), in priority order.
    const want = torontoParts(target.sessionStart);
    const names = await activityNames(target, log);
    log('info', `want ${want.date} ${want.hhmm} · ${names.join(' / ') || '(any activity)'}${target.locationPrefs.length ? ' @ ' + target.locationPrefs.join('/') : ''}`);

    const classesUrl = `${BASE_URL}/Clients/BookMe4BookingPages/Classes?widgetId=${target.widgetId}&calendarId=${target.calendarId}`;
    await page.goto(classesUrl, { waitUntil: 'domcontentloaded' });
    await passQueueIfPresent(page, target, emit, log);

    // ── refresh until the matching entry's button reads "Register", then click it ──
    const deadline = Date.now() + (target.warmupSeconds + target.windowMinutes * 60) * 1000;
    log('info', `refreshing until "Register" appears, up to ${fmt(new Date(deadline))}`);
    let warnedMissing = false;

    while (Date.now() < deadline) {
      await page
        .locator(config.sel.row)
        .first()
        .waitFor({ timeout: 15_000 })
        .catch(() => {});
      const matched = rank(await scan(page), target, names, want);

      if (matched.length === 0) {
        if (!warnedMissing) {
          log('warn', `no entry yet for ${want.date} ${want.hhmm} — refreshing`);
          warnedMissing = true; // don't spam every poll
        }
      } else {
        const open = matched.find((e) => e.value.toLowerCase() === 'register');
        if (open) {
          log('info', `"Register" available: ${open.title} · ${open.time} · ${open.loc}`);
          return await clickRegister(page, target, open, emit, log, result);
        }
        // matched but still "More Info" (not open yet / full) — keep refreshing.
      }

      await sleep(config.pollIntervalMs);
      await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
      await passQueueIfPresent(page, target, emit, log);
    }

    return result('no-slot', false, { detail: `"Register" never appeared for ${want.date} ${want.hhmm} within the window` });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log('error', msg);
    return result('error', false, { detail: msg });
  } finally {
    await cleanup();
  }
}

// ── click the chosen row's Register button (or, in dry run, stop just before) ──
async function clickRegister(
  page: Page,
  target: Target,
  entry: Entry,
  emit: Emit,
  log: (l: 'info' | 'warn' | 'error', m: string) => void,
  result: (s: BookStatus, ok: boolean, extra?: Partial<BookResult>) => BookResult,
): Promise<BookResult> {
  if (target.dryRun) {
    await mkdir('debug', { recursive: true }).catch(() => {});
    await page.screenshot({ path: `debug/dryrun-${target.id ?? 'unsaved'}.png` }).catch(() => {});
    log('info', 'DRY RUN — found bookable "Register", not clicking');
    return result('would-book', true, { facility: entry.loc, detail: 'dry run — Register available, not clicked' });
  }

  const btn = entry.btnId ? page.locator(`#${cssEscape(entry.btnId)}`) : page.locator(config.sel.button, { hasText: 'Register' }).first();
  if ((await btn.count()) === 0) {
    return result('error', false, { facility: entry.loc, detail: 'Register button vanished before click' });
  }
  await btn.click();

  // clicking Register only navigates to the landing page; wait for that (passing any queue first).
  await passQueueIfPresent(page, target, emit, log);
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  await mkdir('debug', { recursive: true }).catch(() => {});
  await page.screenshot({ path: `debug/clicked-${target.id ?? 'unsaved'}.png` }).catch(() => {});

  const url = page.url();
  if (/MemberRegistration\/MemberSignIn/i.test(url)) {
    log('error', 'redirected to sign-in — run `npm run login` to re-login');
    return result('auth-expired', false, { facility: entry.loc, detail: 'not logged in at click' });
  }
  log('info', `clicked "Register" → ${url}`);
  // scope ends at the click: we reached the booking landing page, final confirm not automated.
  return result('booked', true, { facility: entry.loc, detail: `Register clicked → ${url}` });
}

// ── read every entry under the table, in document order, tagging each with its date header ──
async function scan(page: Page): Promise<Entry[]> {
  return page.evaluate((sel) => {
    const out: Entry[] = [];
    const table = document.querySelector('table');
    if (!table) return out;
    let date = '';
    const clean = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();
    table.querySelectorAll('tr').forEach((tr) => {
      if (tr.matches(sel.marker)) {
        date = clean((tr as HTMLElement).innerText);
        return;
      }
      if (!tr.matches(sel.row)) return;
      const q = (s: string) => clean(tr.querySelector(s)?.textContent);
      const btn = tr.querySelector(sel.button) as HTMLInputElement | null;
      out.push({
        date,
        title: q(sel.title),
        time: q(sel.time),
        loc: q(sel.location),
        value: clean(btn?.getAttribute('value')),
        btnId: btn?.id ?? '',
      });
    });
    return out;
  }, config.sel);
}

// ── pick the entries matching activity + location + time + date, ranked by priority ──
// Activity priority is primary (order of target.activityIds), location priority secondary.
function rank(entries: Entry[], target: Target, names: string[], want: { date: string; hhmm: string }): Entry[] {
  const matched = entries.filter(
    (e) =>
      markerToDate(e.date) === want.date &&
      startHHmm(e.time) === want.hhmm &&
      names.some((n) => normName(e.title).includes(normName(n))) &&
      (target.locationPrefs.length === 0 || target.locationPrefs.some((p) => e.loc.toLowerCase().includes(p.toLowerCase()))),
  );

  // index of first activity name matched (= priority); unknown sorts last
  const activityRank = (e: Entry) => {
    let best = names.length;
    names.forEach((n, i) => {
      if (i < best && normName(e.title).includes(normName(n))) best = i;
    });
    return best;
  };
  // index of first matching location pref; length = none / no prefs set
  const locationRank = (e: Entry) => {
    if (target.locationPrefs.length === 0) return 0;
    const i = target.locationPrefs.findIndex((p) => e.loc.toLowerCase().includes(p.toLowerCase()));
    return i < 0 ? target.locationPrefs.length : i;
  };

  return matched
    .map((e, i) => ({ e, i }))
    .sort((a, b) => activityRank(a.e) - activityRank(b.e) || locationRank(a.e) - locationRank(b.e) || a.i - b.i)
    .map((x) => x.e);
}

// ── helpers ──

/** Resolve target.activityIds → display titles (priority order), reused from the public filter
 * endpoint; falls back to the known-GUID map if that read is queue-walled/offline. */
async function activityNames(target: Target, log: (l: 'info' | 'warn' | 'error', m: string) => void): Promise<string[]> {
  let byId: Record<string, string> = { ...FALLBACK_NAMES };
  try {
    const filters = await fetchWidgetFilters(target.widgetId, target.calendarId);
    for (const a of filters.activities) byId[a.value] = a.name;
  } catch {
    log('warn', 'could not read activity filter names — using built-in fallback');
  }
  return target.activityIds.map((id) => byId[id]).filter((n): n is string => Boolean(n));
}

/** "Sun, May 31st, 2026" → "2026-05-31" (null if unparseable). */
function markerToDate(text: string): string | null {
  const cleaned = text
    .replace(/(\d+)(st|nd|rd|th)/gi, '$1') // drop ordinal suffix
    .replace(/,/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const dt = DateTime.fromFormat(cleaned, 'ccc LLL d yyyy', { zone: TZ });
  return dt.isValid ? dt.toFormat('yyyy-LL-dd') : null;
}

/** Start time of "12:15 pm - 01:45 pm" → "12:15" (24h "HH:mm"); "" if unparseable. */
function startHHmm(timeText: string): string {
  try {
    const t = parseTime(timeText.split('-')[0]!.trim());
    return `${pad(t.hour)}:${pad(t.minute)}`;
  } catch {
    return '';
  }
}

/** Loose activity-name compare: strip everything but letters/digits so "Drop-In-Pickleball"
 * and "Drop-In Pickleball" (the site uses both) match the same activity. */
function normName(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Minimal CSS.escape for element ids (the booker only ever escapes simple bm-book-button-NNN ids). */
function cssEscape(id: string): string {
  return id.replace(/([^a-zA-Z0-9_-])/g, '\\$1');
}

// ── Queue-it: detect by host, wait passively until redirected back; tokens are server-signed ──
async function passQueueIfPresent(page: Page, target: Target, emit: Emit, log: (l: 'info' | 'warn' | 'error', m: string) => void): Promise<void> {
  const inQueue = () => /queue-it\.net/.test(new URL(page.url()).host);
  if (!inQueue()) return;
  log('info', 'in Queue-it waiting room — holding position');
  emit({ type: 'queue', targetId: target.id ?? 'unsaved', state: 'waiting', at: nowIso() });
  await page.waitForURL((u) => !/queue-it\.net/.test(new URL(u.toString()).host), { timeout: config.queueTimeoutMs });
  log('info', 'released from queue');
  emit({ type: 'queue', targetId: target.id ?? 'unsaved', state: 'through', at: nowIso() });
}
