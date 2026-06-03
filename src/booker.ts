import {
  chromium,
  type BrowserContext,
  type Locator,
  type Page,
} from "playwright";
import { mkdir } from "node:fs/promises";
import {
  BASE_URL,
  DEFAULT_WIDGET_ID,
  DEFAULT_CALENDAR_ID,
  type BookResult,
  type BookStatus,
  type LogEvent,
} from "./shared/types.js";
import { ensureLoggedIn, type Creds } from "./auth.js";

// ── Book-by-code booker ──
// Drives the public Classes list page by READING and CLICKING, exactly like a human:
//   1. open the Classes page (default widget + calendar)
//   2. find the row whose visible code (#NNNNNN == CourseId) matches the requested code
//   3. click its button → navigate to the activity landing page
//   4. refresh the landing page until its "Register" booking link appears (bounded wait)
//   5. click it, then select the first family member on the attendee step
// The landing "Register" is what we wait on: the site only renders it once registration opens,
// so there is no early-booking risk. Selecting the attendee is the last step automated — the
// final/payment confirm is left to the human.

export const config = {
  pollIntervalMs: 1000,
  registerFastWindowMs: 60 * 1000,
  registerSlowRefreshMinMs: 5 * 1000,
  registerSlowRefreshMaxMs: 15 * 1000,
  queueTimeoutMs: 15 * 60 * 1000,
  registerWaitMs: 10 * 60 * 1000,
  // Selectors for the BookMe4BookingPages/Classes list (verified live).
  sel: {
    row: "tr.bm-class-row", // one class occurrence
    code: "span.bm-event-description", // "#310024" — the visible code (== CourseId)
    button: "input.bm-button", // value = "Register" | "More Info"
  },
};

type Emit = (e: LogEvent) => void;
const nowIso = () => new Date().toISOString();
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      const e = new Error("aborted");
      e.name = "AbortError";
      reject(e);
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        const e = new Error("aborted");
        e.name = "AbortError";
        reject(e);
      },
      { once: true },
    );
  });
}

// Tear-down for the browser this process launched/attached to. Held at module scope so a new
// run() can kill a window left open by a previous (kept-open) run, and so stop() can force the
// current run's window closed — which makes any in-flight Playwright op reject immediately
// instead of hanging until its own timeout. A persistent profile allows ONE live Chromium at a
// time, so a leftover window must be closed before the next launch or it freezes on startup.
let activeCleanup: (() => Promise<void>) | null = null;

// Close whatever browser this process currently owns, if any. Idempotent and never throws.
export async function closeActive(): Promise<void> {
  const c = activeCleanup;
  activeCleanup = null;
  if (c) await c().catch(() => {});
}

// One scanned row on the Classes list, in the page's own words.
interface Row {
  index: number; // row position in the page, used to click the matched row's button
  code: string; // visible code with leading '#' stripped, e.g. "310024"
  title: string; // activity title from .bm-class-title
  value: string; // button value: "Register" | "More Info"
  btnId: string; // input id, retained for diagnostics
}

export async function run(
  code: string,
  emit: Emit,
  signal: AbortSignal | undefined,
  creds: Creds,
): Promise<BookResult> {
  const log = (level: "info" | "warn" | "error", msg: string) =>
    emit({ type: "log", level, msg, code, at: nowIso() });
  const result = (
    status: BookStatus,
    ok: boolean,
    extra?: Partial<BookResult>,
  ): BookResult => {
    const r: BookResult = { ok, status, at: nowIso(), ...extra };
    emit({ type: "result", code, result: r, at: nowIso() });
    return r;
  };
  // cooperative cancellation: throw a tagged AbortError the catch maps to 'cancelled'.
  const throwIfAborted = () => {
    if (signal?.aborted) {
      const e = new Error("aborted");
      e.name = "AbortError";
      throw e;
    }
  };

  // Browser source:
  //   PBALL_CDP_URL set → attach to an already-running browser (its login + queue-it carry over)
  //   otherwise         → launch a persistent on-disk profile; the bot signs in with your creds
  //                       at the start of each run (the session is reused while still valid).
  const cdpUrl = process.env.PBALL_CDP_URL;
  const userDataDir = process.env.PBALL_USER_DATA_DIR ?? ".pball-profile";

  let cleanup: () => Promise<void> = async () => {};
  // when true, skip cleanup so the Chrome window stays open after a successful run.
  let keepBrowserOpen = false;
  let browserWindowClosed = false;
  // reset completely: kill any window a previous run left open before launching a new one, so the
  // persistent profile is free and we never collide with a stale Chromium instance.
  await closeActive();
  try {
    let ctx: BrowserContext;
    let page: Page;
    if (cdpUrl) {
      // reuse the user's existing browser; open our OWN tab so we never hijack their open tabs.
      const browser = await chromium.connectOverCDP(cdpUrl);
      browser.on("disconnected", () => {
        browserWindowClosed = true;
      });
      ctx = browser.contexts()[0] ?? (await browser.newContext());
      page = await ctx.newPage();
      // over CDP, close() only disconnects — it must NOT terminate the user's browser.
      cleanup = async () => {
        await page.close().catch(() => {});
        await browser.close().catch(() => {});
      };
      activeCleanup = cleanup;
      log("info", `attached to existing browser at ${cdpUrl}`);
    } else {
      // persistent profile holds the login across runs. Visible by default; PBALL_HEADLESS=1 to hide.
      ctx = await chromium.launchPersistentContext(userDataDir, {
        headless: process.env.PBALL_HEADLESS === "1",
      });
      page = ctx.pages()[0] ?? (await ctx.newPage());
      cleanup = async () => {
        await ctx.close().catch(() => {});
      };
      activeCleanup = cleanup;
    }
    ctx.on("close", () => {
      browserWindowClosed = true;
    });
    page.on("close", () => {
      browserWindowClosed = true;
    });

    // esbuild/tsx wraps named functions with a `__name` helper that doesn't exist in the page
    // context; shim it so serialized page.evaluate callbacks run. Persists across reloads.
    await page.addInitScript(() => {
      const g = globalThis as unknown as { __name?: (f: unknown) => unknown };
      g.__name ??= (f) => f;
    });

    // Log in BEFORE booking (ensureLoggedIn short-circuits to ok if the profile session is still
    // valid, so a still-authenticated profile won't be needlessly re-logged-in).
    const r = await ensureLoggedIn(page, creds, emit, signal);
    if (!r.ok) {
      return result("login-failed", false, {
        detail: r.detail ?? `login ${r.status}`,
      });
    }

    log("info", `booking code #${code}`);

    const classesUrl = `${BASE_URL}/Clients/BookMe4BookingPages/Classes?widgetId=${DEFAULT_WIDGET_ID}&calendarId=${DEFAULT_CALENDAR_ID}`;
    await page.goto(classesUrl, { waitUntil: "domcontentloaded" });
    await passQueueIfPresent(page, code, emit, log, signal);

    // ── find the row whose visible code matches ──
    await page
      .locator(config.sel.row)
      .first()
      .waitFor({ timeout: 15_000 })
      .catch(() => {});
    const rows = await scan(page);
    const matches = rows.filter((r) => r.code === code);
    if (matches.length === 0) {
      log(
        "warn",
        `no row with code #${code} — scanned: [${rows.map((r) => r.code).join(", ")}]`,
      );
      return result("not-found", false, {
        detail: `no row with code #${code} on the list page`,
      });
    }
    // prefer an already-open ("Register") row; else take the first match.
    const target =
      matches.find((m) => m.value.toLowerCase() === "register") ?? matches[0]!;
    log("info", `matched #${code}: ${target.title} [${target.value}]`);

    // ── click the matched row's button → navigate to the activity landing page ──
    const rowBtn = page
      .locator(config.sel.row)
      .nth(target.index)
      .locator(config.sel.button)
      .first();
    await rowBtn.click();
    await page
      .waitForURL((u) => !/BookMe4BookingPages\/Classes/i.test(u.toString()), {
        timeout: 20_000,
      })
      .catch(() => {});
    await passQueueIfPresent(page, code, emit, log, signal);
    await page.waitForLoadState("domcontentloaded").catch(() => {});
    await mkdir("debug", { recursive: true }).catch(() => {});
    await page
      .screenshot({ path: `debug/clicked-${code}.png` })
      .catch(() => {});
    if (/MemberRegistration\/MemberSignIn/i.test(page.url())) {
      log("error", "redirected to sign-in mid-flow — session lost; re-Book to log in again");
      return result("auth-expired", false, {
        detail: "not logged in at click",
      });
    }
    log("info", `on landing page → ${page.url()}`);

    // ── bounded retry-until-open: refresh the landing page until its Register button appears ──
    const deadline = Date.now() + config.registerWaitMs;
    let warnedMissing = false;
    let refreshCount = 0;
    while (Date.now() < deadline) {
      throwIfAborted();
      const btn = landingRegisterButton(page);
      const found = await btn
        .waitFor({ state: "visible", timeout: config.pollIntervalMs })
        .then(() => true)
        .catch(() => false);
      if (found) break;
      const refreshDelayMs = await nextRegisterRefreshDelayMs(page);
      if (!warnedMissing) {
        log("info", "register button not present yet");
        warnedMissing = true; // don't spam every poll
      }
      log(
        "info",
        `refreshing for #${code} in ${Math.round(refreshDelayMs / 1000)}s (${refreshCount + 1})`,
      );
      await sleep(refreshDelayMs, signal);
      refreshCount += 1;
      await page.reload({ waitUntil: "domcontentloaded" }).catch(() => {});
      await passQueueIfPresent(page, code, emit, log, signal);
    }
    throwIfAborted();
    const landingRegister = landingRegisterButton(page);
    if (!(await landingRegister.isVisible().catch(() => false))) {
      return result("no-slot", false, {
        detail: "Register button never appeared within wait window",
      });
    }

    // ── click landing "Register" → attendee-selection flow ──
    await landingRegister.click();
    await passQueueIfPresent(page, code, emit, log, signal);
    await page.waitForLoadState("domcontentloaded").catch(() => {});
    if (/MemberRegistration\/MemberSignIn/i.test(page.url())) {
      log("error", "redirected to sign-in mid-flow — session lost; re-Book to log in again");
      return result("auth-expired", false, {
        detail: "not logged in at attendee step",
      });
    }

    // ── Select Attendee step: wait for the participant list, then check the first family member
    // (its checkbox id starts with "ParticipantsFamily_FamilyMembers"). ──
    const firstAttendee = page
      .locator('input[type="checkbox"][id^="ParticipantsFamily_FamilyMembers"]')
      .first();
    const attendeeReady = await firstAttendee
      .waitFor({ state: "visible", timeout: 20_000 })
      .then(() => true)
      .catch(() => false);
    if (!attendeeReady) {
      log("warn", `attendee selection did not load (at ${page.url()})`);
      return result("error", false, {
        detail: `attendee selection not reached (${page.url()})`,
      });
    }
    await firstAttendee.check();
    log("info", "selected first family member on the attendee step");
    await mkdir("debug", { recursive: true }).catch(() => {});
    await page
      .screenshot({ path: `debug/attendee-${code}.png` })
      .catch(() => {});

    // scope ends here: first attendee selected; Next / Fees / Payment not automated.
    // leave the window open so the user can finish Next / Fees / Payment by hand.
    keepBrowserOpen = true;
    log("info", "leaving browser open — finish Next / Fees / Payment manually");
    return result("booked", true, {
      detail: `attendee selected → ${page.url()}`,
    });
  } catch (e) {
    // a user stop() force-closes the browser, so the failing op may throw "Target closed" rather
    // than our AbortError — treat anything that happens after abort as a clean cancel.
    if (signal?.aborted || (e instanceof Error && e.name === "AbortError")) {
      log("warn", "stopped by user");
      return result("cancelled", false, { detail: "stopped by user" });
    }
    if (browserWindowClosed || isBrowserClosedError(e)) {
      log("warn", "browser window closed — stopping booking");
      return result("cancelled", false, { detail: "browser window closed" });
    }
    if (e instanceof Error && e.name === "QueueTimeout") {
      log("error", e.message);
      return result("queue-timeout", false, { detail: e.message });
    }
    const msg = e instanceof Error ? e.message : String(e);
    log("error", msg);
    return result("error", false, { detail: msg });
  } finally {
    if (keepBrowserOpen) {
      // window stays open: keep activeCleanup pointing at it so the next run/stop can close it.
    } else {
      await cleanup();
      // only clear if still ours — a concurrent stop() may have already swapped/cleared it.
      if (activeCleanup === cleanup) activeCleanup = null;
    }
  }
}

// ── read every class row on the list, in document order ──
async function scan(page: Page): Promise<Row[]> {
  return page.evaluate((sel) => {
    const out: Row[] = [];
    const clean = (s: string | null | undefined) =>
      (s ?? "").replace(/\s+/g, " ").trim();
    document.querySelectorAll(sel.row).forEach((tr, index) => {
      const q = (s: string) => clean(tr.querySelector(s)?.textContent);
      const btn = tr.querySelector(sel.button) as HTMLInputElement | null;
      // Multiple span.bm-event-description per row (the title reuses the class) — pick the
      // numeric one (#NNNNNN == CourseId), strip the leading '#'.
      let code = "";
      tr.querySelectorAll(sel.code).forEach((el) => {
        const m = clean(el.textContent).match(/^#?(\d{4,})$/);
        if (m && !code) code = m[1]!;
      });
      out.push({
        index,
        code,
        title: q(".bm-class-title"),
        value: clean(btn?.getAttribute("value")),
        btnId: btn?.id ?? "",
      });
    });
    return out;
  }, config.sel);
}

// ── helpers ──

function isBrowserClosedError(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  return /(?:target|page|context|browser).*(?:closed|disconnected)/i.test(
    e.message,
  );
}

function landingRegisterButton(page: Page): Locator {
  return page
    .locator(
      [
        'a[href*="/Clients/BookMe4EventParticipants"]',
        "a.bm-book-button",
        "a#bookButton",
        "a#bookEventButton",
        'a[aria-label^="Register"]',
      ].join(", "),
    )
    .filter({ hasText: /^\s*Register\s*$/i })
    .first();
}

async function nextRegisterRefreshDelayMs(page: Page): Promise<number> {
  const registrationStartMs = await registrationStartTimeMs(page);
  const msUntilRegistration =
    registrationStartMs === null ? null : registrationStartMs - Date.now();
  if (
    msUntilRegistration !== null &&
    msUntilRegistration <= config.registerFastWindowMs
  ) {
    return config.pollIntervalMs;
  }
  return randomInt(
    config.registerSlowRefreshMinMs,
    config.registerSlowRefreshMaxMs,
  );
}

async function registrationStartTimeMs(page: Page): Promise<number | null> {
  return page
    .evaluate(() => {
      const info = (
        window as unknown as {
          eventInfo?: Record<string, unknown>;
        }
      ).eventInfo;
      if (!info) return null;
      const names = [
        "PublicRegistrationStartDateWithOffset",
        "ResidentsRegistrationDateWithOffset",
        "MembersRegistrationDateWithOffset",
        "PublicRegistrationStartDateValue",
        "ResidentsRegistrationDateValue",
        "MembersRegistrationDateValue",
      ];
      const timestamps = names
        .map((name) => info[name])
        .filter((value): value is string => typeof value === "string" && value.length > 0)
        .map((value) => Date.parse(value))
        .filter((value) => Number.isFinite(value));
      if (timestamps.length === 0) return null;
      const now = Date.now();
      const future = timestamps.filter((value) => value > now);
      return Math.min(...(future.length > 0 ? future : timestamps));
    })
    .catch(() => null);
}

function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// ── Queue-it: detect by host, wait passively until redirected back; tokens are server-signed ──
// Interruptible: races the queue wait against `signal` (Stop), and surfaces a hit on the wait
// window as a tagged 'QueueTimeout' so run()'s catch can map it to the 'queue-timeout' status.
async function passQueueIfPresent(
  page: Page,
  code: string,
  emit: Emit,
  log: (l: "info" | "warn" | "error", m: string) => void,
  signal?: AbortSignal,
): Promise<void> {
  const inQueue = () => /queue-it\.net/.test(new URL(page.url()).host);
  if (!inQueue()) return;
  log("info", "in Queue-it waiting room — holding position");
  emit({ type: "queue", code, state: "waiting", at: nowIso() });
  try {
    await Promise.race([
      page.waitForURL(
        (u) => !/queue-it\.net/.test(new URL(u.toString()).host),
        { timeout: config.queueTimeoutMs },
      ),
      new Promise<never>((_, rej) => {
        signal?.addEventListener(
          "abort",
          () => {
            const e = new Error("aborted");
            e.name = "AbortError";
            rej(e);
          },
          { once: true },
        );
      }),
    ]);
  } catch (e) {
    if (e instanceof Error && e.name === "AbortError") throw e;
    // waitForURL hit its window (or errored) while still walled — report queue-timeout, not error.
    const qe = new Error(
      `stuck in Queue-it waiting room > ${Math.round(config.queueTimeoutMs / 60000)} min`,
    );
    qe.name = "QueueTimeout";
    throw qe;
  }
  log("info", "released from queue");
  emit({ type: "queue", code, state: "through", at: nowIso() });
}
