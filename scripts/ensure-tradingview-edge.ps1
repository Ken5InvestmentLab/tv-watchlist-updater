[CmdletBinding()]
param(
  [int]$DebugPort = 9223
)

$ErrorActionPreference = "Stop"
$endpoint = "http://127.0.0.1:$DebugPort/json/version"
$launcher = Join-Path $PSScriptRoot "start-tradingview-chrome.ps1"

function Test-EdgeDebugEndpoint {
  try {
    Invoke-RestMethod -Uri $endpoint -TimeoutSec 2 | Out-Null
    return $true
  } catch {
    return $false
  }
}

if (Test-EdgeDebugEndpoint) {
  Write-Output "TradingView Edge debugging endpoint is already available."
  exit 0
}

$runningEdge = Get-Process msedge -ErrorAction SilentlyContinue
if ($runningEdge) {
  Write-Warning "Microsoft Edge is open but the TradingView debugging endpoint is unavailable. It was left untouched; close all Edge windows once and start the launcher again."
  exit 1
}

& $launcher -DebugPort $DebugPort
if (-not (Test-EdgeDebugEndpoint)) {
  throw "Edge was started but the TradingView debugging endpoint was not available."
}

Write-Output "TradingView Edge is ready for the scheduled updater."
