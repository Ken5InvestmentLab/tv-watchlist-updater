const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const repoRoot = __dirname;

function readRepoFile(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
}

test("Discord notification steps use the Node helper through an ASCII cmd wrapper", () => {
  const workflow = readRepoFile(".github/workflows/update-tradingview.yml");
  const notificationSections = workflow.match(
    /- name: Notify Discord on (?:Success|Failure)[\s\S]*?(?=\n      - name:|$)/g,
  );

  assert.equal(notificationSections?.length, 2);
  assert.match(notificationSections[0], /\r?\n        shell: cmd\r?\n/);
  assert.match(notificationSections[0], /run: node scripts\/notify-discord\.js success/);
  assert.match(notificationSections[1], /\r?\n        shell: cmd\r?\n/);
  assert.match(notificationSections[1], /run: node scripts\/notify-discord\.js failure/);

  const combined = notificationSections.join("\n");
  assert.doesNotMatch(combined, /Invoke-RestMethod|ConvertTo-Json|shell: pwsh|shell: powershell/);
});

test("runner setup keeps logon startup and installs the daily readiness task", () => {
  const setupScript = readRepoFile("scripts/setup-local-runner.ps1");

  assert.match(setupScript, /TVWatchlistLocalRunner\.cmd/);
  assert.match(
    setupScript,
    /schtasks\.exe \/Create \/TN \$taskName \/SC DAILY \/ST "09:05"/,
  );
  assert.match(setupScript, /powershell\.exe -NoProfile -WindowStyle Hidden/);
});

test("Edge launcher uses and repairs only the updater-owned non-default profile", () => {
  const launcher = readRepoFile("scripts/start-tradingview-chrome.ps1");
  const edgeCheck = readRepoFile("scripts/ensure-tradingview-edge.ps1");

  assert.match(launcher, /TVWatchlistUpdater\\EdgeUserData/);
  assert.doesNotMatch(launcher, /Microsoft\\Edge\\User Data/);
  assert.match(launcher, /CommandLine\.IndexOf\(\$profileDir/);
  assert.match(launcher, /Stop-Process -Id \$_\.ProcessId/);
  assert.doesNotMatch(edgeCheck, /Get-Process msedge/);
});
