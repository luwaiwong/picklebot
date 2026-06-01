@echo off
REM === pball one-click launcher (Windows) ===
REM Double-click to start the Markham drop-in booker. On first run it installs
REM dependencies + the Playwright browser and walks you through the one-time login.
REM Then it builds the UI and serves it at http://localhost:8787 (opens your browser).

title pball - Markham drop-in booker
setlocal
cd /d "%~dp0"

REM --- require Node.js ---
where node >nul 2>nul
if errorlevel 1 (
  echo [pball] Node.js not found. Install it from https://nodejs.org/ then re-run this.
  echo.
  pause
  exit /b 1
)

REM --- first run: install deps + Playwright Chromium ---
if not exist "node_modules" (
  echo [pball] Installing dependencies (first run, may take a few minutes)...
  call npm install || goto :fail
  echo [pball] Installing Playwright Chromium...
  call npm run install-browsers || goto :fail
)

REM --- one-time login: persistent profile must exist ---
if not exist ".pball-profile" (
  echo [pball] No saved login. A browser will open on the Markham sign-in page.
  echo [pball] Sign in (solve the reCAPTCHA), then CLOSE the browser window.
  echo.
  pause
  call npm run login || goto :fail
)

REM --- open the UI shortly after the server starts, then run the server (blocking) ---
set "PBALL_PORT=8787"
start "" cmd /c "timeout /t 10 >nul & start http://localhost:%PBALL_PORT%"

echo.
echo [pball] Starting server on http://localhost:%PBALL_PORT%
echo [pball] Leave this window open. Close it (or press Ctrl+C) to stop the bot.
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
