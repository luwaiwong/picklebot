import { chromium, type BrowserContext, type Page } from "playwright";
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
//   4. refresh the landing page until its "Register" (a#bookEventButton) appears (bounded wait)
//   5. click it, then select the first family member on the attendee step
// The landing "Register" is what we wait on: the site only renders it once registration opens,
// so there is no early-booking risk. Selecting the attendee is the last step automated — the
// final/payment confirm is left to the human.

export const config = {
  pollIntervalMs: 1000,
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
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// One scanned row on the Classes list, in the page's own words.
interface Row {
  code: string; // visible code with leading '#' stripped, e.g. "310024"
  title: string; // activity title from .bm-class-title
  value: string; // button value: "Register" | "More Info"
  btnId: string; // input id, used to click the exact row
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
  //   otherwise         → launch a persistent on-disk profile; log in once via `npm run login`,
  //                       reused every run (no auth.json).
  const cdpUrl = process.env.PBALL_CDP_URL;
  const userDataDir = process.env.PBALL_USER_DATA_DIR ?? ".pball-profile";

  let cleanup: () => Promise<void> = async () => {};
  // when true, skip cleanup so the Chrome window stays open after a successful run.
  let keepBrowserOpen = false;
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
    }

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

    // ── click the row's button → navigate to the activity landing page ──
    const rowBtn = target.btnId
      ? page.locator(`#${cssEscape(target.btnId)}`)
      : page.locator(config.sel.button).first();
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
      log("error", "redirected to sign-in — run `npm run login` to re-login");
      return result("auth-expired", false, {
        detail: "not logged in at click",
      });
    }
    log("info", `on landing page → ${page.url()}`);

    // ── bounded retry-until-open: refresh the landing page until its Register button appears ──
    const deadline = Date.now() + config.registerWaitMs;
    let warnedMissing = false;
    while (Date.now() < deadline) {
      throwIfAborted();
      const btn = page.locator("a#bookEventButton").first();
      const found = await btn
        .waitFor({ state: "visible", timeout: config.pollIntervalMs * 3 })
        .then(() => true)
        .catch(() => false);
      if (found) break;
      if (!warnedMissing) {
        log("info", "register button not present yet — refreshing landing");
        warnedMissing = true; // don't spam every poll
      }
      await sleep(config.pollIntervalMs);
      await page.reload({ waitUntil: "domcontentloaded" }).catch(() => {});
      await passQueueIfPresent(page, code, emit, log, signal);
    }
    throwIfAborted();
    const landingRegister = page.locator("a#bookEventButton").first();
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
      log("error", "redirected to sign-in — run `npm run login` to re-login");
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
    if (e instanceof Error && e.name === "AbortError") {
      log("warn", "stopped by user");
      return result("cancelled", false, { detail: "stopped by user" });
    }
    if (e instanceof Error && e.name === "QueueTimeout") {
      log("error", e.message);
      return result("queue-timeout", false, { detail: e.message });
    }
    const msg = e instanceof Error ? e.message : String(e);
    log("error", msg);
    return result("error", false, { detail: msg });
  } finally {
    if (!keepBrowserOpen) await cleanup();
  }
}

// ── read every class row on the list, in document order ──
async function scan(page: Page): Promise<Row[]> {
  return page.evaluate((sel) => {
    const out: Row[] = [];
    const clean = (s: string | null | undefined) =>
      (s ?? "").replace(/\s+/g, " ").trim();
    document.querySelectorAll(sel.row).forEach((tr) => {
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

/** Minimal CSS.escape for element ids (the booker only ever escapes simple bm-book-button-NNN ids). */
function cssEscape(id: string): string {
  return id.replace(/([^a-zA-Z0-9_-])/g, "\\$1");
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
