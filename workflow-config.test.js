const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const repoRoot = __dirname;

function readRepoFile(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
}

test("Discord notification steps use Windows PowerShell available to the startup runner", () => {
  const workflow = readRepoFile(".github/workflows/update-tradingview.yml");
  const notificationSections = workflow.match(
    /- name: Notify Discord on (?:Success|Failure)[\s\S]*?(?=\n      - name:|$)/g,
  );

  assert.equal(notificationSections?.length, 2);
  for (const section of notificationSections) {
    assert.match(section, /\n        shell: powershell\n/);
    assert.doesNotMatch(section, /\n        shell: pwsh\n/);
  }
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
