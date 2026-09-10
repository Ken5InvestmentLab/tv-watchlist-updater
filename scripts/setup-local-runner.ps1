[CmdletBinding()]
param(
  [string]$RunnerName = "$env:COMPUTERNAME-tv-watchlist"
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
$runnerRoot = Join-Path $repoRoot ".local-runner"
$repo = "Ken5InvestmentLab/tv-watchlist-updater"
$taskName = "TVWatchlistLocalRunner"

function Install-StartupLauncher {
  $startupDir = [Environment]::GetFolderPath([Environment+SpecialFolder]::Startup)
  $launcherPath = Join-Path $startupDir "TVWatchlistLocalRunner.cmd"
  $startScript = Join-Path $PSScriptRoot "start-local-runner.ps1"
  @"
@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$startScript"
"@ | Set-Content -LiteralPath $launcherPath -Encoding ascii
  Write-Warning "Task Scheduler access was denied. Installed the per-user Startup launcher instead: $launcherPath"
}

if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
  throw "GitHub CLI (gh) is required to register the local runner."
}

if (-not (Test-Path -LiteralPath (Join-Path $runnerRoot "run.cmd"))) {
  $release = gh api "repos/actions/runner/releases/latest" | ConvertFrom-Json
  $asset = $release.assets | Where-Object { $_.name -match "^actions-runner-win-x64-.*\.zip$" } | Select-Object -First 1
  if (-not $asset) { throw "Could not find the Windows x64 GitHub Actions runner download." }

  New-Item -ItemType Directory -Force -Path $runnerRoot | Out-Null
  $zipPath = Join-Path $env:TEMP $asset.name
  Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $zipPath
  Expand-Archive -LiteralPath $zipPath -DestinationPath $runnerRoot -Force
  Remove-Item -LiteralPath $zipPath -Force

  $registrationToken = gh api --method POST "repos/$repo/actions/runners/registration-token" --jq .token
  Push-Location $runnerRoot
  try {
    & .\config.cmd --unattended --url "https://github.com/$repo" --token $registrationToken --name $RunnerName --labels "tv-watchlist" --work "_work"
    if ($LASTEXITCODE -ne 0) { throw "GitHub Actions runner registration failed." }
  } finally {
    Pop-Location
  }
}

$startScript = Join-Path $PSScriptRoot "start-local-runner.ps1"
$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$startScript`""
$logonTrigger = New-ScheduledTaskTrigger -AtLogOn
$dailyTrigger = New-ScheduledTaskTrigger -Daily -At "09:05"
$triggers = @($logonTrigger, $dailyTrigger)
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -WakeToRun -ExecutionTimeLimit (New-TimeSpan -Hours 1)
try {
  Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $triggers -Settings $settings -Description "Starts the local Chrome and GitHub Actions runner for TradingView watchlist updates." -Force | Out-Null
} catch {
  Install-StartupLauncher
}

& $startScript
Write-Output "Local TradingView runner is installed and will start automatically at logon."
