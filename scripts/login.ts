import { chromium } from 'playwright';
import { BASE_URL } from '../src/shared/types.js';

// One-time login into the persistent profile the booker reuses (PBALL_USER_DATA_DIR, default
// .pball-profile). Sign in to Markham in the window, then close it — the session is written to
// the profile on disk and reused by every booker run, so you never need auth.json or codegen.
const USER_DATA_DIR = process.env.PBALL_USER_DATA_DIR ?? '.pball-profile';
const SIGNIN_URL = `${BASE_URL}/Menu/MemberRegistration/MemberSignIn`;

const ctx = await chromium.launchPersistentContext(USER_DATA_DIR, { headless: false });
const page = ctx.pages()[0] ?? (await ctx.newPage());
await page.goto(SIGNIN_URL).catch(() => {});

console.log(`
─────────────────────────────────────────────────────────────
 LOGIN  → profile: ${USER_DATA_DIR}
 1. Sign in to Markham in the browser window.
 2. Close the window (or press Ctrl+C here) when done.
 Your session persists to the profile and is reused by the booker.
─────────────────────────────────────────────────────────────
`);

// keep the process alive until the user closes the browser or hits Ctrl+C
ctx.on('close', () => process.exit(0));
process.on('SIGINT', () => void ctx.close().then(() => process.exit(0)));
await new Promise(() => {}); // park until one of the handlers above fires
