# === pball one-click launcher (Windows / PowerShell) ===
# Right-click -> "Run with PowerShell", or run: powershell -ExecutionPolicy Bypass -File pball.ps1
# First run installs deps + the Playwright browser and does the one-time login.
# Then it builds the UI and serves it at http://localhost:8787 (opens your browser).

$ErrorActionPreference = 'Stop'
Set-Location -Path $PSScriptRoot
$Host.UI.RawUI.WindowTitle = 'pball - Markham drop-in booker'

# --- require Node.js ---
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host '[pball] Node.js not found. Install it from https://nodejs.org/ then re-run this.'
  Read-Host 'Press Enter to exit'
  exit 1
}

try {
  # --- first run: install deps + Playwright Chromium ---
  if (-not (Test-Path 'node_modules')) {
    Write-Host '[pball] Installing dependencies (first run, may take a few minutes)...'
    npm install
    Write-Host '[pball] Installing Playwright Chromium...'
    npm run install-browsers
  }

  # --- one-time login: persistent profile must exist ---
  if (-not (Test-Path '.pball-profile')) {
    Write-Host '[pball] No saved login. A browser will open on the Markham sign-in page.'
    Write-Host '[pball] Sign in (solve the reCAPTCHA), then CLOSE the browser window.'
    Read-Host 'Press Enter to open the sign-in browser'
    npm run login
  }

  # --- open the UI shortly after the server starts, then run the server (blocking) ---
  $env:PBALL_PORT = '8787'
  $url = "http://localhost:$($env:PBALL_PORT)"
  Start-Job { Start-Sleep -Seconds 10; Start-Process $using:url } | Out-Null

  Write-Host ''
  Write-Host "[pball] Starting server on $url"
  Write-Host '[pball] Leave this window open. Press Ctrl+C to stop the bot.'
  Write-Host ''
  npm run start
}
catch {
  Write-Host ''
  Write-Host "[pball] Setup failed: $_"
  Read-Host 'Press Enter to exit'
  exit 1
}
