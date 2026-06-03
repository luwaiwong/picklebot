# Run pball from a USB stick (Windows, zero-install)

Goal: plug the stick into **any Windows x64 PC**, double-click one file, and the booker runs —
no Node, no installs, no admin rights on the host. All dependencies and your login live **on the
stick**.

Method: bundle the OS-independent parts now; a **one-time first run** on a Windows PC (with
internet) installs the Windows-specific parts (`node_modules` + Chromium) onto the stick. Every
run after that is plug-and-go and works offline.

> Why not pre-install everything from Linux first? `node_modules` contains Windows-native binaries
> (esbuild / rollup / vite), and Playwright's installer only downloads Chromium for the OS it runs
> on. Both must be produced on Windows to be correct. The first run does exactly that, once.

---

## Stick layout (target)

```
PBALL\                 <- USB root, or any folder on the stick
├─ pball-usb.bat       the launcher you double-click
├─ node\               portable Windows Node.js (node.exe, npm.cmd, npx.cmd, ...)
├─ app\                the project source
│   └─ node_modules\   created on first run
├─ browsers\           Playwright Chromium      (created on first run)
├─ profile\            your reused Markham session  (created on first run)
└─ data\               bookings.log             (created on first run)
```

The launcher points every path at folders on the stick (relative to itself), so the drive letter
(`E:`, `F:`, …) changing between PCs does not matter.

---

## Part A — Build the stick (one time, ~10 min, needs a Windows PC + internet)

### 1. Portable Node.js
- Go to <https://nodejs.org/en/download> → choose **Windows / x64 / .zip** (use the **v20 LTS**
  line to match what the project was tested on).
- Extract the zip. It produces a folder like `node-v20.x.x-win-x64\` containing `node.exe`,
  `npm.cmd`, `npx.cmd`.
- **Rename that folder to `node`** and copy it to the stick as `PBALL\node\`.

### 2. The project
Copy the project onto the stick as `PBALL\app\`. You do **not** need to copy these (regenerated on
first run, and they bloat / are wrong-OS): `node_modules\`, `static\`, `.git\`, `debug\`,
`bookings.log`, `.pball-profile\`.

So the minimum to copy into `PBALL\app\`:
```
src\  web\  static\index.html (and static\assets\)
package.json  package-lock.json
svelte.config.js  vite.config.ts  tsconfig.json
README.md
```
(Copying the whole folder and deleting `node_modules\` / `.git\` afterward is fine too.)

> **Reuse an existing session (optional):** the bot signs in automatically with the email +
> password you enter in the UI, and saves the session to `PBALL\profile\`. If you already have a
> `.pball-profile\` from your dev machine, copy it to `PBALL\profile\` to start pre-signed-in.
> (It's your private session — only do this on a stick you control.)

### 3. The launcher
Create `PBALL\pball-usb.bat` with exactly this content:

```bat
@echo off
REM === pball portable USB launcher (Windows x64, zero-install) ===
title pball - Markham drop-in booker (USB)
setlocal

REM --- use the bundled portable Node (no host Node needed) ---
set "PATH=%~dp0node;%PATH%"

REM --- keep EVERYTHING on the stick, relative to this .bat ---
set "PLAYWRIGHT_BROWSERS_PATH=%~dp0browsers"
set "PBALL_USER_DATA_DIR=%~dp0profile"
set "PBALL_HISTORY=%~dp0data\bookings.log"
set "PBALL_PORT=8787"

if not exist "%~dp0data" mkdir "%~dp0data"
cd /d "%~dp0app"

REM --- require the bundled node ---
where node >nul 2>nul || (echo [pball] Bundled Node not found in node\. & pause & exit /b 1)

REM --- first run: install deps + Chromium ONTO the stick ---
if not exist "node_modules" (
  echo [pball] First run: installing dependencies onto the stick (a few minutes)...
  call npm ci || goto :fail
)
if not exist "%PLAYWRIGHT_BROWSERS_PATH%" (
  echo [pball] First run: downloading Chromium onto the stick (~400 MB)...
  call npm run install-browsers || goto :fail
)

REM --- open the UI shortly after the server starts, then run the server (blocking) ---
start "" cmd /c "timeout /t 10 >nul & start http://localhost:%PBALL_PORT%"
echo.
echo [pball] Starting on http://localhost:%PBALL_PORT%  (leave this window open; Ctrl+C to stop)
echo.
call npm run start
goto :end

:fail
echo.
echo [pball] Setup failed. See the error above.
pause
exit /b 1
:end
echo.
echo [pball] Server stopped.
pause
```

### 4. First run (do this once, on a Windows PC with internet)
- Double-click `PBALL\pball-usb.bat`.
- It will: `npm ci` (installs `node_modules\` on the stick) → download Chromium into `browsers\`
  → build the UI and start the server. A browser tab opens at <http://localhost:8787>. You sign in
  by entering your Markham email + password in the UI when you book.
- When it finishes successfully once, the stick is fully provisioned.

---

## Part B — Daily use (any Windows x64 PC)

1. Plug in the stick.
2. Double-click `PBALL\pball-usb.bat`.
3. A browser opens at <http://localhost:8787>. Enter the activity code and book.
4. Leave the console window open while using it; close it (or Ctrl+C) to stop.

No setup, no Node install, no admin — it reuses what's on the stick.

---

## Notes & caveats

- **Windows x64 only.** The bundled Node, `node_modules`, and Chromium are Windows-x64 binaries.
  Don't run this same stick on Linux/macOS or 32-bit/ARM Windows.
- **Internet:** needed for the first run (to install) and for the actual booking (it drives the
  Markham site). The install bits are cached on the stick, so later launches don't re-download.
- **Drive letter** changing per PC is fine — the launcher uses `%~dp0` (its own folder) for every
  path, never a hardcoded letter.
- **USB speed:** Chromium launches noticeably faster from a USB 3.0 stick than a cheap USB 2.0 one.
- **SmartScreen / antivirus** may warn on a `.bat` from removable media — allow it ("More info →
  Run anyway").
- **Session expiry:** the bot re-signs-in automatically each time you book (using the email +
  password you enter), so an expired session self-heals on the next booking. To start fresh,
  delete `PBALL\profile\`.
- **Faster relaunch (optional):** `npm run start` rebuilds the UI each launch. After the first
  successful build you can swap the last `call npm run start` line for
  `call npx tsx src/server.ts` to skip the rebuild and just serve the existing `static\`.
- **No-show policy:** Markham suspends memberships for *"frequent no-shows or misuse of
  pre-registering."* Only book sessions you'll actually attend.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `Bundled Node not found` | The `node\` folder is missing or mis-named — it must contain `node.exe` and `npm.cmd` directly (not nested in another folder). |
| `npm ci` fails offline on first run | The first run needs internet. Run it once on a connected PC. |
| Chromium won't launch / missing | Delete `PBALL\browsers\` and relaunch — it re-downloads. Confirm `PLAYWRIGHT_BROWSERS_PATH` line is intact in the `.bat`. |
| Port 8787 in use | Edit `set "PBALL_PORT=8787"` in the `.bat` to another port (e.g. 8080). |
| Asks to log in every time | The profile isn't persisting — confirm `PBALL_USER_DATA_DIR=%~dp0profile` and that the stick isn't read-only. |
