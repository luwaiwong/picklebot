import { chromium, type BrowserContext } from "playwright";
import { BASE_URL, type LogEvent } from "./shared/types.js";
import { profileLock } from "./profile.js";

// Server-launched login window. Mirrors `npm run login`: open the persistent profile against the
// Markham sign-in page so the user signs in by hand; the session persists to disk and is reused
// by the booker. Shares the single-profile mutex with booking — only one can drive the profile.

type Emit = (e: LogEvent) => void;
const iso = () => new Date().toISOString();
const SIGNIN_URL = `${BASE_URL}/Menu/MemberRegistration/MemberSignIn`;
// Safety: never hold the profile lock forever if the user walks away — auto-close the window.
const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;

let running: Promise<void> | null = null;

export const loginManager = {
  active: () => profileLock.who() === "login",

  start(emit: Emit): { ok: boolean; busy?: boolean } {
    if (!profileLock.acquire("login")) return { ok: false, busy: true };
    emit({ type: "login", state: "opening", at: iso() });
    emit({ type: "log", level: "info", msg: "opening login window", at: iso() });
    // fire-and-forget: the window lives for as long as the user needs; the route returns now.
    running = drive(emit).finally(() => {
      profileLock.release("login");
      running = null;
    });
    return { ok: true };
  },
};

async function drive(emit: Emit): Promise<void> {
  const log = (level: "info" | "warn" | "error", msg: string) =>
    emit({ type: "log", level, msg, at: iso() });
  const userDataDir = process.env.PBALL_USER_DATA_DIR ?? ".pball-profile";
  let ctx: BrowserContext | null = null;
  try {
    ctx = await chromium.launchPersistentContext(userDataDir, {
      headless: false,
    });
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    await page.goto(SIGNIN_URL).catch(() => {});
    emit({ type: "login", state: "open", at: iso() });
    log("info", "sign in, then close the window — session is saved to the profile");

    // best-effort: once we leave the sign-in page for a Markham page, the user is signed in.
    let signaled = false;
    page.on("framenavigated", (f) => {
      if (signaled || f !== page.mainFrame()) return;
      const u = f.url();
      if (!/MemberRegistration\/MemberSignIn/i.test(u) && /perfectmind\.com/i.test(u)) {
        signaled = true;
        emit({ type: "login", state: "signed-in", at: iso() });
        log("info", "signed in — you can close the window");
      }
    });

    // park until the user closes the window, or the safety timeout fires.
    const closed = ctx;
    await Promise.race([
      new Promise<void>((res) => closed.on("close", () => res())),
      new Promise<void>((res) => setTimeout(res, LOGIN_TIMEOUT_MS)),
    ]);
    await ctx.close().catch(() => {});
    ctx = null;
    emit({ type: "login", state: "closed", at: iso() });
    log("info", "login window closed — session saved");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await ctx?.close().catch(() => {});
    log("error", `login window failed: ${msg}`);
    emit({ type: "login", state: "error", detail: msg, at: iso() });
  }
}
