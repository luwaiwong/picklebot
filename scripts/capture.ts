import { chromium } from 'playwright';
import { writeFileSync, existsSync } from 'node:fs';
import { BASE_URL, DEFAULT_WIDGET_ID, DEFAULT_CALENDAR_ID } from '../src/shared/types.js';

// One-time helper (M3): launches a real browser using your saved auth.json, records every
// ClassesV2 / GetEvent / landing-page / booking request so you can read off the exact
// commit-flow requests + selectors into src/booker.ts `config.selectors`.
const AUTH = process.env.PBALL_AUTH ?? 'auth.json';
if (!existsSync(AUTH)) {
  console.error('No auth.json — run `npm run codegen` and log in first.');
  process.exit(1);
}

const browser = await chromium.launch({ headless: false });
const ctx = await browser.newContext({ storageState: AUTH });
const page = await ctx.newPage();

const log: unknown[] = [];
const interesting = /ClassesV2|GetEvent|BookMe4LandingPages|AddToCart|Checkout|Reserve|Register|Cart|Book/i;

page.on('request', (r) => {
  if (interesting.test(r.url())) log.push({ kind: 'request', method: r.method(), url: r.url(), postData: r.postData() });
});
page.on('response', (r) => {
  if (interesting.test(r.url())) log.push({ kind: 'response', status: r.status(), url: r.url(), contentType: r.headers()['content-type'] });
});

const save = () => {
  writeFileSync('capture.json', JSON.stringify(log, null, 2));
  console.log(`\nSaved ${log.length} entries → capture.json`);
};
process.on('SIGINT', () => {
  save();
  process.exit(0);
});

await page.goto(`${BASE_URL}/Clients/BookMe4BookingPages/Classes?widgetId=${DEFAULT_WIDGET_ID}&calendarId=${DEFAULT_CALENDAR_ID}`);

console.log(`
─────────────────────────────────────────────────────────────
 CAPTURE MODE  (your auth.json session)
 1. Filter to pickleball, open a session, click Register.
 2. Go through the flow but STOP before the final irreversible
    confirm if there is a fee (drop-in pickleball can cost up to ~$5).
 3. Note these DOM selectors for src/booker.ts config.selectors:
      loggedInMarker · registerButton · priceText
      confirmButton · confirmSuccess · waitlistButton · slotTakenError
 4. Press Ctrl+C in this terminal to write capture.json.
─────────────────────────────────────────────────────────────
`);

await new Promise(() => {}); // keep the browser open until Ctrl+C
