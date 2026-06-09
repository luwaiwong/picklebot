import { type Page } from "playwright";
import { mkdir } from "node:fs/promises";
import { BASE_URL, type LogEvent } from "./shared/types.js";

// Markham login credentials for a single run — never persisted to disk, never logged.
export interface Creds {
  username: string;
  password: string;
}

// Headless email/password sign-in into the Markham member portal. Verified live selectors:
//   form #logonform → #textBoxUsername, #textBoxPassword, submit = the "Login" button
//   (matched by accessible name; prefer type=submit when several match).
//   __RequestVerificationToken is already in the DOM (Playwright submits it). No captcha on the
//   sign-in form (the page's reCAPTCHA belongs to the separate signup form).
// Drives whatever `page` it's given so the session lands in that context's persistent profile.

type Emit = (e: LogEvent) => void;
const iso = () => new Date().toISOString();
const SIGNIN_URL = `${BASE_URL}/Menu/MemberRegistration/MemberSignIn`;

type LoginStatus = "ok" | "login-failed" | "challenge" | "error";
interface LoginOutcome {
  ok: boolean;
  status: LoginStatus;
  detail?: string;
}

export async function ensureLoggedIn(
  page: Page,
  creds: Creds,
  emit: Emit,
  signal?: AbortSignal,
): Promise<LoginOutcome> {
  const log = (level: "info" | "warn" | "error", msg: string) =>
    emit({ type: "log", level, msg, at: iso() });
  const throwIfAborted = () => {
    if (signal?.aborted) {
      const e = new Error("aborted");
      e.name = "AbortError";
      throw e;
    }
  };

  emit({ type: "login", state: "logging-in", at: iso() });
  log("info", `logging in as ${creds.username}`);
  try {
    await page.goto(SIGNIN_URL, { waitUntil: "domcontentloaded" });
    throwIfAborted();

    // No sign-in form → already authenticated (session carried over / redirected away).
    const userBox = page.locator("#textBoxUsername");
    const needLogin = await userBox.isVisible().catch(() => false);
    if (!needLogin) {
      emit({ type: "login", state: "logged-in", at: iso() });
      log("info", "already logged in");
      return { ok: true, status: "ok" };
    }

    await userBox.fill(creds.username);
    await page.locator("#textBoxPassword").fill(creds.password);
    throwIfAborted();
    // Click the "Login" button by its accessible name (input value or button text);
    // if more than one matches, narrow to the submit-type one.
    const loginButtons = page.getByRole("button", { name: "Login" });
    const loginButton =
      (await loginButtons.count()) > 1
        ? loginButtons.and(page.locator('[type="submit"]')).first()
        : loginButtons.first();
    await loginButton.click();
    // networkidle (NOT domcontentloaded): the post-login POST redirects, and the challenge/
    // form checks below must run on the SETTLED destination page. domcontentloaded can return on
    // the pre-redirect sign-in page, so detectChallenge then catches a transient recaptcha/device-
    // token state and false-fails with "captcha/device verification". Login is one-time per run,
    // not the race-critical path, so the extra wait is worth the reliability.
    await page.waitForLoadState("networkidle").catch(() => {});
    throwIfAborted();

    if (process.env.PBALL_DEBUG === "1") {
      await mkdir("debug", { recursive: true }).catch(() => {});
      await page.screenshot({ path: "debug/login.png" }).catch(() => {});
    }

    // captcha / device-verification challenge → we can't solve it headlessly.
    if (await detectChallenge(page)) {
      const detail = "login needs a captcha/device verification";
      emit({ type: "login", state: "login-failed", detail, at: iso() });
      log("warn", detail);
      return { ok: false, status: "challenge", detail };
    }

    // still on the sign-in page with the form present → credentials rejected.
    const stillSignin = /MemberRegistration\/MemberSignIn/i.test(page.url());
    const stillHasForm = await userBox.isVisible().catch(() => false);
    if (stillSignin && stillHasForm) {
      const detail = await readError(page);
      emit({ type: "login", state: "login-failed", detail, at: iso() });
      log("warn", `login failed: ${detail}`);
      return { ok: false, status: "login-failed", detail };
    }

    emit({ type: "login", state: "logged-in", at: iso() });
    log("info", "logged in");
    return { ok: true, status: "ok" };
  } catch (e) {
    if (e instanceof Error && e.name === "AbortError") throw e; // let caller map → 'cancelled'
    const msg = e instanceof Error ? e.message : String(e);
    emit({ type: "login", state: "error", detail: msg, at: iso() });
    log("error", `login error: ${msg}`);
    return { ok: false, status: "error", detail: msg };
  }
}

/** Visible reCAPTCHA inside the sign-in form, or a device/email-verification prompt. */
async function detectChallenge(page: Page): Promise<boolean> {
  return page
    .evaluate(() => {
      const form = document.querySelector("#logonform");
      const widget = form?.querySelector('.g-recaptcha, iframe[src*="recaptcha"]');
      const recaptchaVisible =
        !!widget && (widget as HTMLElement).offsetParent !== null;
      // __deviceVerificationToken is a PERMANENT empty hidden field on the sign-in form (present
      // even before any login attempt) — its mere presence is NOT a challenge. A real device
      // verification populates it with a value, so gate on a non-empty value, not existence.
      // (Previously this false-positived on every failed login, masking "incorrect password" as a
      // device challenge.)
      const tokEl = document.querySelector(
        '[name="__deviceVerificationToken"], #__deviceVerificationToken',
      ) as HTMLInputElement | null;
      const hasDeviceToken = !!tokEl && (tokEl.value ?? "").trim().length > 0;
      const bodyText = (document.body?.innerText ?? "").toLowerCase();
      const verifyText = /verification code|verify your device|enter the code/.test(
        bodyText,
      );
      return recaptchaVisible || hasDeviceToken || verifyText;
    })
    .catch(() => false);
}

/** Best-effort visible error text from the sign-in form; falls back to "login rejected". */
async function readError(page: Page): Promise<string> {
  const txt = await page
    .evaluate(() => {
      const els = Array.from(
        document.querySelectorAll(
          "#logonform .field-validation-error, #logonform .validation-summary-errors, .field-validation-error, .validation-summary-errors, .alert, [class*='error']",
        ),
      );
      for (const el of els) {
        const t = (el as HTMLElement).innerText?.replace(/\s+/g, " ").trim();
        if (t && /invalid|incorrect|error|wrong|not\s+correct|try again/i.test(t)) {
          return t;
        }
      }
      return "";
    })
    .catch(() => "");
  return txt || "login rejected";
}
