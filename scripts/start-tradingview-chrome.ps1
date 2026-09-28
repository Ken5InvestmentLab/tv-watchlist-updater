[CmdletBinding()]
param(
  [int]$DebugPort = 9223
)

$ErrorActionPreference = "Stop"
$endpoint = "http://127.0.0.1:$DebugPort/json/version"
$profileDir = Join-Path $env:LOCALAPPDATA "TVWatchlistUpdater\EdgeUserData"

try {
  Invoke-RestMethod -Uri $endpoint -TimeoutSec 2 | Out-Null
  Write-Output "TradingView Edge debugging endpoint is already available."
  exit 0
} catch {
  # Launch the dedicated Edge profile below.
}

$edgeCandidates = @(
  "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
  "${env:ProgramFiles}\Microsoft\Edge\Application\msedge.exe",
  "${env:LOCALAPPDATA}\Microsoft\Edge\Application\msedge.exe"
)
$edge = $edgeCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (-not $edge) { throw "Microsoft Edge was not found." }

# Current Chromium-based Edge releases ignore remote debugging switches for the
# default browser data directory. Use an updater-owned data directory so the
# user's ordinary Edge windows can remain open and untouched.
New-Item -ItemType Directory -Force -Path $profileDir | Out-Null

$dedicatedEdge = Get-CimInstance Win32_Process -Filter "Name = 'msedge.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -and $_.CommandLine.IndexOf($profileDir, [StringComparison]::OrdinalIgnoreCase) -ge 0 }
if ($dedicatedEdge) {
  Write-Warning "The updater-owned Edge profile is running without its debugging endpoint. Restarting only that dedicated Edge instance."
  $dedicatedEdge | ForEach-Object {
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
  }
  Start-Sleep -Seconds 2
}

Start-Process -FilePath $edge -ArgumentList @(
  "--remote-debugging-address=127.0.0.1",
  "--remote-debugging-port=$DebugPort",
  "--user-data-dir=`"$profileDir`"",
  "--profile-directory=Default",
  "--no-first-run",
  "--no-default-browser-check",
  "https://www.tradingview.com/chart/"
)

for ($attempt = 1; $attempt -le 20; $attempt++) {
  Start-Sleep -Seconds 1
  try {
    Invoke-RestMethod -Uri $endpoint -TimeoutSec 2 | Out-Null
    Write-Output "TradingView Edge started with local debugging enabled."
    exit 0
  } catch {}
}

throw "Edge started but its local debugging endpoint was not available."
