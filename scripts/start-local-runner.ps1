[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
$runnerRoot = Join-Path $repoRoot ".local-runner"
$runCommand = Join-Path $runnerRoot "run.cmd"

& (Join-Path $PSScriptRoot "start-tradingview-chrome.ps1")

if (-not (Test-Path -LiteralPath $runCommand)) {
  throw "The local GitHub Actions runner is not installed. Run scripts/setup-local-runner.ps1 first."
}

$runnerAlreadyStarted = Get-CimInstance Win32_Process | Where-Object {
  $_.Name -ieq "cmd.exe" -and $_.CommandLine -like "*$runCommand*"
}
if ($runnerAlreadyStarted) {
  Write-Output "Local GitHub Actions runner is already running."
  exit 0
}

Start-Process -FilePath "cmd.exe" -ArgumentList "/c", $runCommand -WorkingDirectory $runnerRoot -WindowStyle Hidden
Write-Output "Local GitHub Actions runner started."
