[CmdletBinding()]
param(
  [int]$DebugPort = 9222
)

$ErrorActionPreference = "Stop"
$endpoint = "http://127.0.0.1:$DebugPort/json/version"

try {
  Invoke-RestMethod -Uri $endpoint -TimeoutSec 2 | Out-Null
  Write-Output "TradingView Chrome debugging endpoint is already available."
  exit 0
} catch {
  # Launch the dedicated, ordinary Chrome profile below.
}

$chromeCandidates = @(
  "${env:ProgramFiles}\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
  "${env:LOCALAPPDATA}\Google\Chrome\Application\chrome.exe"
)
$chrome = $chromeCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (-not $chrome) { throw "Google Chrome was not found." }

$profileDir = Join-Path $env:LOCALAPPDATA "Google\Chrome\User Data"
if (-not (Test-Path -LiteralPath $profileDir)) { throw "The normal Google Chrome profile directory was not found." }

$runningChrome = Get-Process chrome -ErrorAction SilentlyContinue
if ($runningChrome) {
  throw "Close all normal Chrome windows once, then run this launcher again so Chrome can start with local debugging enabled."
}

Start-Process -FilePath $chrome -ArgumentList @(
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
    Write-Output "TradingView Chrome started with local debugging enabled."
    exit 0
  } catch {}
}

throw "Chrome started but its local debugging endpoint was not available."
