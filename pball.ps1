# === pball one-click launcher (Windows / PowerShell) ===
# Right-click -> "Run with PowerShell", or run: powershell -ExecutionPolicy Bypass -File pball.ps1
# First run installs deps + the Playwright browser. You sign in from the UI when you book.
# Then it builds the UI and serves it at http://localhost:8787 (opens your browser).

$ErrorActionPreference = 'Stop'
Set-Location -Path $PSScriptRoot
$Host.UI.RawUI.WindowTitle = 'pball - Markham drop-in booker'

# --- update from GitHub before starting ---
if ((Get-Command git -ErrorAction SilentlyContinue) -and (Test-Path '.git')) {
  Write-Host '[pball] Fetching latest update from GitHub...'
  git fetch
  Write-Host '[pball] Pulling latest update from GitHub...'
  git pull
}
else {
  Write-Host '[pball] Git checkout not found; skipping GitHub update.'
}

# --- full restart: stop any prior pball server still holding the port ---
$env:PBALL_PORT = '8787'
$port = [int]$env:PBALL_PORT
Write-Host "[pball] Checking for a running instance on port $port..."
$existingPids = @()
try {
  $existingPids = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction Stop |
    Select-Object -ExpandProperty OwningProcess -Unique
}
catch {
  # fallback for systems without Get-NetTCPConnection
  $existingPids = netstat -ano |
    Select-String ":$port\s+.*LISTENING" |
    ForEach-Object { ($_ -split '\s+')[-1] } |
    Sort-Object -Unique
}
foreach ($procId in $existingPids) {
  if ($procId -and $procId -ne 0 -and $procId -ne $PID) {
    try {
      Write-Host "[pball] Stopping existing instance (PID $procId) for a clean restart..."
      Stop-Process -Id $procId -Force -ErrorAction Stop
    }
    catch {
      Write-Host "[pball] Could not stop PID ${procId}: $_"
    }
  }
}

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

  # --- open the UI shortly after the server starts, then run the server (blocking) ---
  $url = "http://localhost:$port"
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
