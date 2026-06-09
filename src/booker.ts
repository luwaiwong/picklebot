import {
  chromium,
  type Locator,
  type Page,
  type Response,
} from "playwright";
import { mkdir, readlink, unlink, readFile } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
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

const config = {
  pollIntervalMs: 1000,
  registerExactWindowMs: 5 * 1000,
  registerPostOpenWindowMs: 5 * 60 * 1000,
  registerBurstRefreshMs: 200,
  queueTimeoutMs: 15 * 60 * 1000,
  registerWaitMs: 10 * 60 * 1000,
  // After a successful booking the browser is left open for the manual payment step; auto-close it
  // this long afterward so a walked-away window never lingers indefinitely holding the profile.
  keepOpenMaxMs: 40 * 60 * 1000,
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

// ── env-gated attendee-step instrumentation (PBALL_TIMING=1) ──
// Zero overhead unless enabled. Marks wall-clock checkpoints across the Register-click →
// attendee-select flow and logs the deltas, so a single live run shows exactly where the time
// goes (the suspected culprit being domcontentloaded → checkbox-visible, the async family-list
// render). PBALL_TRACE=1 additionally captures a Playwright trace.zip.
function makeStepTimer(log: (l: "info" | "warn" | "error", m: string) => void) {
  const on = process.env.PBALL_TIMING === "1";
  const marks: Array<[string, number]> = [];
  return {
    on,
    mark(name: string): void {
      if (on) marks.push([name, performance.now()]);
    },
    dump(): void {
      if (!on || marks.length < 2) return;
      const deltas: Record<string, string> = {};
      for (let i = 1; i < marks.length; i++) {
        deltas[marks[i]![0]] = `${Math.round(marks[i]![1] - marks[i - 1]![1])}ms`;
      }
      const total = Math.round(marks[marks.length - 1]![1] - marks[0]![1]);
      log("info", `attendee timing ${JSON.stringify(deltas)} total=${total}ms`);
    },
  };
}

// env-gated (PBALL_TIMING=1): log the booking-relevant responses during the attendee step so the
// participant-list XHR that gates the checkbox can be identified from a real run. Returns a
// detach fn (no-op when disabled).
function attachXhrLog(
  page: Page,
  log: (l: "info" | "warn" | "error", m: string) => void,
): () => void {
  if (process.env.PBALL_TIMING !== "1") return () => {};
  const onResp = (r: Response) => {
    const u = r.url();
    if (/Participant|Family|BookMe4/i.test(u)) {
      log("info", `xhr ${r.request().method()} ${r.status()} ${u}`);
    }
  };
  page.on("response", onResp);
  return () => page.off("response", onResp);
}

// Screenshots are debug aids that force a layout+paint+disk write on the booking path; keep them
// OFF by default and enable with PBALL_DEBUG=1 when diagnosing. Never throws.
async function debugShot(page: Page, name: string): Promise<void> {
  if (process.env.PBALL_DEBUG !== "1") return;
  await mkdir("debug", { recursive: true }).catch(() => {});
  await page.screenshot({ path: `debug/${name}.png` }).catch(() => {});
}

// Tear-down for the browser this process launched/attached to. Held at module scope so a new
// run() can kill a window left open by a previous (kept-open) run, and so stop() can force the
// current run's window closed — which makes any in-flight Playwright op reject immediately
// instead of hanging until its own timeout. A persistent profile allows ONE live Chromium at a
// time, so a leftover window must be closed before the next launch or it freezes on startup.
// Every browser this process currently owns — one entry per racing window. closeActive() tears
// down ALL of them (used by stop() and at the start of a fresh job); each run() adds/removes its
// own entry. A Set (not a single ref) is what lets N windows coexist without clobbering each other.
const activeCleanups = new Set<() => Promise<void>>();
// Safety timer for the keep-open-after-success window: bounds how long a browser left open for the
// manual payment step may linger before we auto-close it, so a user who walks away never orphans it.
let keepOpenTimer: ReturnType<typeof setTimeout> | null = null;

// Close every browser this process currently owns, if any. Idempotent and never throws.
export async function closeActive(): Promise<void> {
  if (keepOpenTimer) {
    clearTimeout(keepOpenTimer);
    keepOpenTimer = null;
  }
  const cleanups = [...activeCleanups];
  activeCleanups.clear();
  await Promise.all(cleanups.map((c) => c().catch(() => {})));
}

// Arm the auto-close safety net for a browser intentionally left open after a successful booking.
// Cleared by the next closeActive() (a fresh run() or a Stop), so it only fires if nothing else does.
function scheduleKeepOpenClose(
  log: (l: "info" | "warn" | "error", m: string) => void,
): void {
  if (keepOpenTimer) clearTimeout(keepOpenTimer);
  keepOpenTimer = setTimeout(() => {
    keepOpenTimer = null;
    log(
      "info",
      `auto-closing kept-open browser after ${Math.round(config.keepOpenMaxMs / 60000)} min idle`,
    );
    void closeActive();
  }, config.keepOpenMaxMs);
  // never let this timer alone keep the process alive
  (keepOpenTimer as unknown as { unref?: () => void }).unref?.();
}

// Kill any stray Chromium left owning the persistent profile by a previous (crashed or restarted)
// process, then clear its singleton lock — otherwise launching a second Chromium on the same
// profile freezes on startup. closeActive() only covers windows THIS process owns; this covers ones
// it doesn't. Best-effort and Linux-focused: it verifies via /proc that the lock's PID really is a
// Chromium on this profile before killing (guards against PID reuse), and never throws. No-op if free.
async function reapProfileOwner(
  userDataDir: string,
  log: (l: "info" | "warn" | "error", m: string) => void,
): Promise<void> {
  // Chromium's own SingletonLock is a symlink whose target ends in the owning PID ("<host>-<pid>").
  let pid: number | null = null;
  try {
    const target = await readlink(join(userDataDir, "SingletonLock"));
    const tail = target.split("-").pop() ?? "";
    if (/^\d+$/.test(tail)) pid = Number(tail);
  } catch {
    return; // no lock → profile is already free
  }
  const clearLocks = async () => {
    for (const f of ["SingletonLock", "SingletonCookie", "SingletonSocket"]) {
      await unlink(join(userDataDir, f)).catch(() => {});
    }
  };
  if (pid === null) {
    await clearLocks();
    return;
  }
  let alive = false;
  try {
    process.kill(pid, 0); // signal 0 = liveness probe; throws if the pid is gone
    alive = true;
  } catch {
    alive = false;
  }
  if (!alive) {
    await clearLocks(); // stale lock from a dead process → safe to clear
    return;
  }
  // Alive: only kill if we can confirm it's a Chromium on THIS profile, so we never SIGKILL an
  // unrelated process that happens to have reused the pid.
  let isOurs = false;
  try {
    const cmd = await readFile(`/proc/${pid}/cmdline`, "utf8");
    isOurs = cmd.includes(userDataDir) && /chrome|chromium/i.test(cmd);
  } catch {
    isOurs = false; // /proc unavailable (non-Linux) or process vanished
  }
  if (!isOurs) {
    log("warn", `profile lock held by live pid ${pid}; not reaping (unverified owner)`);
    return;
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch {}
  await sleep(1500).catch(() => {});
  try {
    process.kill(pid, 0);
    process.kill(pid, "SIGKILL"); // still alive after the grace period → force it
  } catch {}
  await clearLocks();
  log("warn", `reaped stray Chromium pid ${pid} that was holding ${userDataDir}`);
}

// One scanned row on the Classes list, in the page's own words.
interface Row {
  index: number; // row position in the page, used to click the matched row's button
  code: string; // visible code with leading '#' stripped, e.g. "310024"
  title: string; // activity title from .bm-class-title
  value: string; // button value: "Register" | "More Info"
}

export interface RunOpts {
  userDataDir?: string; // override the profile dir — each racing window gets its own
  label?: string; // log prefix to tell racing windows apart, e.g. "w2"
  manageGlobalClose?: boolean; // default true: closeActive() leftovers at start. false in a race
  // (closeActive tears down ALL windows, which would kill our own siblings).
}

export async function run(
  code: string,
  emit: Emit,
  signal: AbortSignal | undefined,
  creds: Creds,
  opts?: RunOpts,
): Promise<BookResult> {
  const tag = opts?.label ? `[${opts.label}] ` : "";
  const log = (level: "info" | "warn" | "error", msg: string) =>
    emit({ type: "log", level, msg: `${tag}${msg}`, code, at: nowIso() });
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

  // Browser source: launch a persistent on-disk profile; the bot signs in with your creds at the
  // start of each run (the session is reused while still valid).
  const userDataDir =
    opts?.userDataDir ?? process.env.PBALL_USER_DATA_DIR ?? ".pball-profile";

  let cleanup: () => Promise<void> = async () => {};
  // when true, skip cleanup so the Chrome window stays open after a successful run.
  let keepBrowserOpen = false;
  let browserWindowClosed = false;
  // reset completely: kill any window a previous run left open before launching a new one, so the
  // persistent profile is free and we never collide with a stale Chromium instance. Skipped in a
  // race (manageGlobalClose:false): closeActive() tears down ALL windows and would kill our own
  // siblings, so the race orchestrator does one closeActive() up front instead.
  if (opts?.manageGlobalClose !== false) await closeActive();
  try {
    // reap any stray Chromium a previous/crashed process left holding THIS profile dir, so the
    // launch below can't freeze on a stale singleton lock. Per-dir, so siblings are unaffected.
    await reapProfileOwner(userDataDir, log);
    // persistent profile holds the login across runs. ALWAYS headed: the racing windows must be
    // watchable to be useful, and headless is more bot-detectable anyway.
    const ctx = await chromium.launchPersistentContext(userDataDir, {
      headless: false,
    });
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    cleanup = async () => {
      await ctx.close().catch(() => {});
    };
    activeCleanups.add(cleanup);
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
    const navResp = await page.goto(classesUrl, { waitUntil: "domcontentloaded" });
    // Correct for browser↔server clock skew: the open-time scheduler compares the server's
    // ABSOLUTE registration timestamp against the LOCAL clock, so a machine clock that is off by
    // a second or two would miss the exact landing. Anchor to the server's Date header once (HTTP
    // dates are whole-second precision — enough to catch gross skew). delta stays 0 if absent.
    let clockDeltaMs = 0;
    const dateHeader = navResp?.headers()["date"];
    if (dateHeader) {
      const serverMs = Date.parse(dateHeader);
      if (Number.isFinite(serverMs)) clockDeltaMs = serverMs - Date.now();
    }
    if (clockDeltaMs !== 0)
      log("info", `server clock skew ${clockDeltaMs}ms — correcting open-time schedule`);
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
    await debugShot(page, `clicked-${code}`);
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
      // Pick the refresh cadence FIRST, then bound the visible-check by it. Previously a fixed 1s
      // waitFor ran before the reload every cycle, so the 200ms burst the scheduler picks at open
      // was really ~1.2s and detection lagged the opening by over a second. Now the check never
      // outlasts the chosen cadence.
      const { delayMs, preOpen } = await nextRegisterRefresh(page, clockDeltaMs);
      if (preOpen) {
        // Strictly before the open instant: the server has not rendered the button yet, so a
        // visible-check would only burn the window. Sleep so the next reload lands at open.
        if (!warnedMissing) {
          log("info", "register button not present yet");
          warnedMissing = true; // don't spam every poll
        }
        await sleep(delayMs, signal);
      } else {
        // Registration may be open: the button can already be in this DOM. Wait for it — but only
        // for the chosen cadence — then reload for a fresh server render.
        const found = await btn
          .waitFor({ state: "visible", timeout: Math.max(delayMs, 1) })
          .then(() => true)
          .catch(() => false);
        if (found) break;
      }
      refreshCount += 1;
      log("info", `refreshing for #${code} (#${refreshCount}, cadence ${delayMs}ms)`);
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
    // PBALL_TIMING=1 marks each step below so a live run shows where the ~1s goes (suspected:
    // domcontentloaded → checkbox-visible, the async family-list render); PBALL_TRACE=1 also
    // writes a trace.zip. All instrumentation is a no-op when those env vars are unset.
    const timer = makeStepTimer(log);
    const detachXhr = attachXhrLog(page, log);
    if (timer.on && process.env.PBALL_TRACE === "1") {
      await ctx.tracing
        .start({ screenshots: true, snapshots: true })
        .catch(() => {});
    }
    try {
      timer.mark("registerClick");
      await landingRegister.click();
      await passQueueIfPresent(page, code, emit, log, signal);
      timer.mark("afterQueue");
      await page.waitForLoadState("domcontentloaded").catch(() => {});
      timer.mark("afterDomContentLoaded");
      if (timer.on) {
        const cbCount = await page
          .evaluate(
            () =>
              document.querySelectorAll(
                'input[id^="ParticipantsFamily_FamilyMembers"]',
              ).length,
          )
          .catch(() => -1);
        log(
          "info",
          `domcontentloaded: ${cbCount} attendee checkboxes at ${page.url()}`,
        );
      }
      if (/MemberRegistration\/MemberSignIn/i.test(page.url())) {
        log("error", "redirected to sign-in mid-flow — session lost; re-Book to log in again");
        return result("auth-expired", false, {
          detail: "not logged in at attendee step",
        });
      }

      // ── Select Attendee step: wait for the participant list, then check the first family
      // member (its checkbox id starts with "ParticipantsFamily_FamilyMembers"). ──
      const firstAttendee = page
        .locator(
          'input[type="checkbox"][id^="ParticipantsFamily_FamilyMembers"]',
        )
        .first();
      const attendeeReady = await firstAttendee
        .waitFor({ state: "visible", timeout: 20_000 })
        .then(() => true)
        .catch(() => false);
      timer.mark("checkboxVisible");
      if (!attendeeReady) {
        log("warn", `attendee selection did not load (at ${page.url()})`);
        return result("error", false, {
          detail: `attendee selection not reached (${page.url()})`,
        });
      }
      // Click the instant it's visible+enabled, natively IN-PAGE via a raf-polled waitForFunction.
      // A real HTMLInputElement.click() toggles .checked and fires the bubbling change event the
      // page's jQuery/ASP.NET handler listens on (handlers don't gate on event.isTrusted), so
      // fees/eligibility advance — with ZERO Node↔browser round-trips and no scrollIntoViewIfNeeded.
      // That scroll + CDP mouse-click is exactly what .check({force:true}) still does (force skips
      // only the actionability *checks*, not the scroll/click), and is where the ~500ms went.
      const clickedChecked = await page
        .waitForFunction(
          () => {
            const el = document.querySelector(
              'input[type="checkbox"][id^="ParticipantsFamily_FamilyMembers"]',
            ) as HTMLInputElement | null;
            if (
              !el ||
              el.disabled ||
              el.offsetParent === null ||
              el.offsetWidth === 0 ||
              el.offsetHeight === 0
            )
              return false;
            if (el.checked) return true; // already selected — don't re-click (would toggle it off)
            el.click();
            return el.checked;
          },
          { polling: "raf", timeout: 20_000 },
        )
        .then(() => true)
        .catch(() => false);
      timer.mark("checkboxClickedNatively");
      // Confirm the selection actually registered before claiming success: the page only advances
      // (fees/eligibility) off a real checked input, so a silent miss must surface as an error
      // rather than a false "booked". If the fast native click didn't land (transient overlay, or the
      // page unexpectedly gates on a trusted gesture), retry once WITH Playwright actionability.
      let stuck =
        clickedChecked && (await firstAttendee.isChecked().catch(() => false));
      if (!stuck) {
        await firstAttendee.check().catch(() => {});
        stuck = await firstAttendee.isChecked().catch(() => false);
      }
      timer.mark("checkDone");
      if (!stuck) {
        log("warn", "checkbox did not register as checked after check()");
        return result("error", false, {
          detail: "attendee not actually selected (checkbox not checked)",
        });
      }
      log("info", "selected first family member on the attendee step");
      await debugShot(page, `attendee-${code}`);

      // scope ends here: first attendee selected; Next / Fees / Payment not automated.
      // leave the window open so the user can finish Next / Fees / Payment by hand.
      keepBrowserOpen = true;
      scheduleKeepOpenClose(log);
      log(
        "info",
        `leaving browser open — finish Next / Fees / Payment manually (auto-closes in ${Math.round(config.keepOpenMaxMs / 60000)} min)`,
      );
      return result("booked", true, {
        detail: `attendee selected → ${page.url()}`,
      });
    } finally {
      timer.dump();
      detachXhr();
      if (timer.on && process.env.PBALL_TRACE === "1") {
        await ctx.tracing
          .stop({ path: `debug/attendee-${code}.zip` })
          .catch(() => {});
      }
    }
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
      // window stays open: keep its cleanup registered so the next run/stop can close it.
    } else {
      await cleanup();
      activeCleanups.delete(cleanup);
    }
  }
}

// ── Multi-window race ──
// Spin up N independent windows, each with its OWN on-disk profile + login/session — so each holds
// its OWN Queue-it position — all booking the same code. The first window to reach the attendee
// step wins; the rest are aborted (one account books a given spot once anyway). Window 1 reuses the
// primary profile (often already logged in); windows 2..N use sibling dirs (".pball-profile-2", …).
// Windows open ALL AT ONCE by default (PBALL_WINDOW_STAGGER_MS=0); raise it only if N simultaneous
// cold logins trip the site's velocity-based anti-bruteforce captcha. Once each profile holds a
// session, later runs skip login entirely, so the stagger only ever matters on the first cold run.
export async function runRace(
  code: string,
  emit: Emit,
  signal: AbortSignal | undefined,
  creds: Creds,
  windows: number,
): Promise<BookResult> {
  const n = Math.max(1, Math.floor(windows));
  if (n === 1) return run(code, emit, signal, creds);
  const baseDir = process.env.PBALL_USER_DATA_DIR ?? ".pball-profile";
  const staggerMs = Number(process.env.PBALL_WINDOW_STAGGER_MS ?? "0");
  // one clean slate up front; each window then reaps only its OWN profile dir.
  await closeActive();
  emit({
    type: "log",
    level: "info",
    msg: `racing ${n} windows for #${code}`,
    code,
    at: nowIso(),
  });

  const dirs = Array.from({ length: n }, (_, i) =>
    i === 0 ? baseDir : `${baseDir}-${i + 1}`,
  );
  const controllers = dirs.map(() => new AbortController());
  const abortAll = () => controllers.forEach((c) => c.abort());
  if (signal) {
    if (signal.aborted) abortAll();
    else signal.addEventListener("abort", abortAll, { once: true });
  }

  let winner: BookResult | null = null;
  const runs = dirs.map((dir, i) =>
    // stagger the START of each window so cold logins don't fire all at once; run() handles an
    // already-aborted signal cleanly, so a window aborted during its stagger just returns cancelled.
    sleep(i * staggerMs, controllers[i]!.signal)
      .catch(() => {})
      .then(() =>
        run(code, emit, controllers[i]!.signal, creds, {
          userDataDir: dir,
          label: `w${i + 1}`,
          manageGlobalClose: false,
        }),
      )
      .then((res) => {
        // first window to actually book wins → cancel the rest so they don't sit in the queue.
        if (res.ok && !winner) {
          winner = res;
          controllers.forEach((c, j) => {
            if (j !== i) c.abort();
          });
        }
        return res;
      }),
  );
  const results = await Promise.all(runs);
  if (signal) signal.removeEventListener("abort", abortAll);

  // prefer the winning booking; else the most informative non-cancelled result; else the first.
  return (
    winner ??
    results.find((r) => r.ok) ??
    results.find((r) => r.status !== "cancelled") ??
    results[0]!
  );
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

// Decide how long to wait before the next landing-page reload, and whether registration is still
// strictly in the future (preOpen) — in which case the Register button cannot exist yet and a
// visible-check would only burn the window. clockDeltaMs corrects the local clock to server time
// so the "exact window" actually lands on the opening instant.
async function nextRegisterRefresh(
  page: Page,
  clockDeltaMs: number,
): Promise<{ delayMs: number; preOpen: boolean }> {
  const registrationStartMs = await registrationStartTimeMs(page);
  const msUntilRegistration =
    registrationStartMs === null
      ? null
      : registrationStartMs - (Date.now() + clockDeltaMs);
  if (msUntilRegistration !== null) {
    // Within the exact window: schedule the next reload to land precisely when
    // the current booking target's registration window opens.
    if (
      msUntilRegistration > 0 &&
      msUntilRegistration <= config.registerExactWindowMs
    ) {
      return { delayMs: msUntilRegistration, preOpen: true };
    }
    // Just after registration opened, within the post-open window: burst-refresh.
    if (
      msUntilRegistration <= 0 &&
      msUntilRegistration >= -config.registerPostOpenWindowMs
    ) {
      return { delayMs: config.registerBurstRefreshMs, preOpen: false };
    }
    // Strictly before open but outside the exact window: still pre-open, poll slowly.
    if (msUntilRegistration > 0) {
      return { delayMs: config.pollIntervalMs, preOpen: true };
    }
  }
  // Unknown timing, or long after open: treat as possibly-open and poll.
  return { delayMs: config.pollIntervalMs, preOpen: false };
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
