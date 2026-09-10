[CmdletBinding()]
param(
  [int]$DebugPort = 9223
)

$ErrorActionPreference = "Stop"
$endpoint = "http://127.0.0.1:$DebugPort/json/version"

try {
  Invoke-RestMethod -Uri $endpoint -TimeoutSec 2 | Out-Null
  Write-Output "TradingView Edge debugging endpoint is already available."
  exit 0
} catch {
  # Launch the ordinary Edge profile below.
}

$edgeCandidates = @(
  "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
  "${env:ProgramFiles}\Microsoft\Edge\Application\msedge.exe",
  "${env:LOCALAPPDATA}\Microsoft\Edge\Application\msedge.exe"
)
$edge = $edgeCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (-not $edge) { throw "Microsoft Edge was not found." }

$profileDir = Join-Path $env:LOCALAPPDATA "Microsoft\Edge\User Data"
if (-not (Test-Path -LiteralPath $profileDir)) { throw "The normal Microsoft Edge profile directory was not found." }

$runningEdge = Get-Process msedge -ErrorAction SilentlyContinue
if ($runningEdge) {
  throw "Close all Microsoft Edge windows once, then run this launcher again so Edge can start with local debugging enabled."
}

Start-Process -FilePath $edge -ArgumentList @(
  "--remote-debugging-address=127.0.0.1",
  "--remote-debugging-port=$DebugPort",
  "--user-data-dir=$profileDir",
  "--profile-directory=Default",
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
