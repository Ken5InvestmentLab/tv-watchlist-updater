const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

// ==============================
// ENV
// ==============================
const TRADINGVIEW_STORAGE_STATE = process.env.TRADINGVIEW_STORAGE_STATE;
const WATCHLIST_1_URL = process.env.WATCHLIST_1_URL;
const WATCHLIST_2_URL = process.env.WATCHLIST_2_URL;
const WATCHLIST_1_PREFIX = process.env.WATCHLIST_1_NAME || "wl1";
const WATCHLIST_2_PREFIX = process.env.WATCHLIST_2_NAME || "wl2";

const DO_DELETE_ALERTS = (process.env.DO_DELETE_ALERTS || "true") === "true";
const DO_DELETE_WATCHLISTS = (process.env.DO_DELETE_WATCHLISTS || "true") === "true";
const DO_IMPORT_WATCHLISTS = (process.env.DO_IMPORT_WATCHLISTS || "true") === "true";
const DO_CREATE_WATCHLIST_ALERT = (process.env.DO_CREATE_WATCHLIST_ALERT || "true") === "true";

const ALERT_CONDITION_NAME = process.env.ALERT_CONDITION_NAME || "天底極致 - 通常モード Alert用 (20, 2, 12, 75, 35, 0.18, 5, 2.5)";
const ALERT_TIMEFRAME_LABEL = process.env.ALERT_TIMEFRAME_LABEL || "4 時間";

const NAV_TIMEOUT = 90000;
const STEP_TIMEOUT = 45000;
const WORKDIR = path.resolve(process.cwd(), "tmp");
const OUT1 = path.join(WORKDIR, "wl1.txt");
const OUT2 = path.join(WORKDIR, "wl2.txt");

// ==============================
// Utils (省略せず維持)
// ==============================
function getTimestampJst() {
  const now = new Date();
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const yyyy = jst.getUTCFullYear();
  const mm = String(jst.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(jst.getUTCDate()).padStart(2, "0");
  const hh = String(jst.getUTCHours()).padStart(2, "0");
  const mi = String(jst.getUTCMinutes()).padStart(2, "0");
  return `${yyyy}${mm}${dd}_${hh}${mi}`;
}
const RUN_TS = getTimestampJst();
const WATCHLIST_1_FINAL_NAME = `${WATCHLIST_1_PREFIX}_${RUN_TS}`;
const WATCHLIST_2_FINAL_NAME = `${WATCHLIST_2_PREFIX}_${RUN_TS}`;

function reqEnv(name, val) { if (!val) throw new Error(`Missing env: ${name}`); }
function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); }
async function downloadToFile(url, filePath) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed ${res.status}: ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(filePath, buf);
}
async function safeScreenshot(page, label) {
  try {
    ensureDir(WORKDIR);
    const p = path.join(WORKDIR, `screenshot_${Date.now()}_${label}.png`);
    await page.screenshot({ path: p, fullPage: true });
    console.log("Saved screenshot:", p);
  } catch (e) { console.log("Screenshot failed:", e?.message || e); }
}
async function safeClick(locator, options = {}) {
  try {
    const el = locator.first();
    await el.waitFor({ state: "visible", timeout: options.timeout || STEP_TIMEOUT });
    await el.scrollIntoViewIfNeeded().catch(() => {});
    await el.click(options);
    return true;
  } catch { return false; }
}
function escapeRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function isManagedListName(name, prefix) { return name === prefix || (name && name.startsWith(`${prefix}_`)); }
async function firstVisible(locator, max = 30) {
  const count = Math.min(await locator.count().catch(() => 0), max);
  for (let i = 0; i < count; i++) {
    const el = locator.nth(i);
    if (await el.isVisible().catch(() => false)) return el;
  }
  return null;
}
async function clickBestEffort(locator, timeout = 8000) {
  try { await locator.scrollIntoViewIfNeeded().catch(() => {}); await locator.click({ force: true, timeout }); return true; } catch {}
  try { await locator.dispatchEvent("click"); return true; } catch {}
  try { await locator.evaluate((el) => el.click()); return true; } catch {}
  return false;
}

// ==============================
// UI Helpers (Watchlist関連は維持)
// ==============================
async function openWatchlistPanel(page) {
  const candidates = [
    page.locator('button[aria-label*="ウォッチリスト"]'),
    page.locator('button[aria-label*="Watchlist"]'),
  ];
  for (const c of candidates) { if (await safeClick(c, { timeout: 8000 })) return; }
  throw new Error("ウォッチリストパネルを開けませんでした");
}

async function ensureWatchlistPanelOpen(page) {
  if (await page.locator('button[data-name="watchlists-button"]').first().isVisible().catch(() => false)) return;
  await openWatchlistPanel(page);
}

async function closeAnyMenu(page) {
  await page.keyboard.press("Escape").catch(() => {});
  await page.waitForTimeout(400);
}

async function getVisibleWatchlistMenuRoot(page) {
  const re = /リストに(高度な)?アラートを追加|リストを開く|リストをアップロード|Open list|Upload list|Add( advanced)? alert/i;
  const roots = [
    page.locator('[role="menu"]').filter({ hasText: re }),
    page.locator('div[data-name="menu-inner"]').filter({ hasText: re }),
    page.locator('div[class*="menu"]').filter({ hasText: re }),
  ];
  for (const root of roots) {
    const el = await firstVisible(root, 10);
    if (el) return el;
  }
  return null;
}

async function openWatchlistMenuHard(page, retry = 8) {
  await ensureWatchlistPanelOpen(page);
  const btn = page.locator('button[data-name="watchlists-button"] .arrow-merBkM5y').first();
  for (let i = 0; i < retry; i++) {
    await closeAnyMenu(page);
    if (await safeClick(btn, { timeout: 8000, force: true })) {
      await page.waitForTimeout(900);
      if (await getVisibleWatchlistMenuRoot(page)) return true;
    }
  }
  return false;
}

async function getCurrentWatchlistTitle(page) {
  const t = await page.locator('button[data-name="watchlists-button"]').first().textContent().catch(() => "");
  return (t || "").trim();
}

async function findMenuItemByText(page, re) {
  const root = await getVisibleWatchlistMenuRoot(page);
  if (!root) return null;
  const candidates = [root.locator('[role="menuitem"]').filter({ hasText: re }), page.getByText(re)];
  for (const c of candidates) {
    const el = await firstVisible(c, 10);
    if (el) return el;
  }
  return null;
}

async function clickMenuItemByText(page, re) {
  const item = await findMenuItemByText(page, re);
  if (!item || !(await clickBestEffort(item))) throw new Error(`メニュー項目失敗: ${re}`);
  await page.waitForTimeout(900);
}

// ==============================
// Watchlist Management (維持)
// ==============================
async function openListOpenDialog(page) {
  if (await page.locator('div[data-role="list-item"]').first().isVisible().catch(() => false)) return;
  if (!(await openWatchlistMenuHard(page))) throw new Error("メニューが開けません");
  await clickMenuItemByText(page, /リストを開く|Open list/i);
}

async function closeOpenListDialogIfVisible(page) {
  const closeBtn = page.locator('button[data-qa-id="close"]').first();
  if (await closeBtn.isVisible().catch(() => false)) { await safeClick(closeBtn); return true; }
  return false;
}

async function switchWatchlistTo(page, listName) {
  await openListOpenDialog(page);
  const row = page.locator(`div[data-role="list-item"][data-title="${listName}"]`).first();
  await row.click({ force: true });
  await closeOpenListDialogIfVisible(page);
  await closeAnyMenu(page);
  await page.waitForTimeout(2000);
}

async function deleteManagedWatchlistsByPrefix(page, prefix) {
  await openListOpenDialog(page);
  for (let round = 0; round < 50; round++) {
    const titles = page.locator("div.title-ODL8WA9K");
    let targetName = "";
    for (let i = 0; i < await titles.count(); i++) {
      const text = (await titles.nth(i).textContent()).trim();
      if (isManagedListName(text, prefix)) { targetName = text; break; }
    }
    if (!targetName) break;
    const row = page.locator(`div[data-role="list-item"][data-title="${targetName}"]`).first();
    await row.hover();
    await safeClick(row.locator('[data-name="remove-button"]'));
    await safeClick(page.getByRole("button", { name: /削除|Delete|はい|Yes|OK/i }));
    await page.waitForTimeout(1000);
  }
  await closeOpenListDialogIfVisible(page);
}

async function importWatchlistFromFile(page, filePath, desiredName) {
  const uploadPath = makeUploadCopyWithDesiredName(filePath, desiredName);
  await closeOpenListDialogIfVisible(page);
  await closeAnyMenu(page);
  if (!(await openWatchlistMenuHard(page))) throw new Error("メニューが開けません");
  const chooserPromise = page.waitForEvent("filechooser", { timeout: 12000 });
  await clickMenuItemByText(page, /リストをアップロード|Upload list/i);
  const chooser = await chooserPromise;
  await chooser.setFiles(uploadPath);
  await page.waitForTimeout(3000);
}

function makeUploadCopyWithDesiredName(srcPath, desiredName) {
  ensureDir(WORKDIR);
  const dstPath = path.join(WORKDIR, `${desiredName}.txt`);
  fs.copyFileSync(srcPath, dstPath);
  return dstPath;
}

// ==============================
// Alerts (★ここを大幅に修正・強化)
// ==============================
async function openAlertsPanel(page) {
  const candidates = [page.locator('button[data-name="alerts"]'), page.locator('button[aria-label="アラート"]')];
  for (const c of candidates) { if (await safeClick(c)) return; }
}

async function deleteManagedAlerts(page, prefixes) {
  await openAlertsPanel(page);
  for (let round = 0; round < 100; round++) {
    const tickerItems = page.locator('[data-name="alert-item-ticker"]');
    let target = null;
    for (let i = 0; i < await tickerItems.count(); i++) {
      const txt = (await tickerItems.nth(i).textContent()).trim();
      if (prefixes.some(p => txt.startsWith(p))) { target = tickerItems.nth(i); break; }
    }
    if (!target) break;
    await target.click({ button: "right" });
    await safeClick(page.locator('tr[data-role="menuitem"]').filter({ hasText: /削除|Delete/ }));
    await safeClick(page.getByRole("button", { name: /削除|Delete|はい|Yes|OK/i }));
    await page.waitForTimeout(1000);
  }
}

async function clickAddAlertToList(page) {
  const re = /リストに(高度な)?アラートを追加|Add( advanced)? alert( to list)?|アラートを追加/i;
  for (let i = 0; i < 10; i++) {
    if (await openWatchlistMenuHard(page)) {
      const item = page.locator('[data-role="menuitem"], div[class*="item"], button').filter({ hasText: re }).first();
      if (await clickBestEffort(item)) return true;
    }
    await closeAnyMenu(page);
  }
  throw new Error("『リストにアラートを追加』が見つかりません");
}

async function selectAlertCondition(page, conditionName) {
  console.log("Selecting condition:", conditionName);
  // Conditionドロップダウンを開く
  const dropdown = page.locator('div').filter({ hasText: /^Price$|^価格$|^Condition$|^条件$/ }).last();
  await clickBestEffort(dropdown);
  await page.waitForTimeout(1000);
  
  // インジケーター名で選択（部分一致）
  const shortName = conditionName.split('(')[0].trim();
  const option = page.locator('[role="option"]').filter({ hasText: shortName }).first();
  if (!(await clickBestEffort(option))) throw new Error("条件の選択に失敗");
}

/**
 * 修正ポイント：時間足（Interval）を確実に選択する関数
 */
async function selectAlertResolution(page, label) {
  console.log("Selecting interval:", label);
  // 「Same as chart」等と表示されている時間足ドロップダウンを探してクリック
  const dropdown = page.getByText(/Same as chart|チャートと同じ|1 分|1 min/i).first();
  await clickBestEffort(dropdown);
  await page.waitForTimeout(1000);

  // 目的の時間足を選択
  const option = page.locator('[role="option"]').filter({ hasText: label.trim() }).first();
  if (!(await clickBestEffort(option))) {
    // 予備：テキストのみで探す
    await clickBestEffort(page.getByRole('option', { name: label }).first());
  }
  await page.waitForTimeout(800);
}

async function selectAlertSymbolsList(page, listName) {
  const disclosure = page.locator('[data-qa-id*="symbols-select"]').first();
  if (!(await disclosure.textContent()).includes(listName)) {
    await disclosure.click();
    await safeClick(page.locator('[role="option"]').filter({ hasText: new RegExp(`^${escapeRegex(listName)}$`) }));
  }
}

/**
 * 修正ポイント：作成ボタンを確実にクリックする関数
 */
async function submitAlertDialog(page) {
  console.log("Submitting alert dialog...");
  const btn = page.getByRole("button", { name: /作成|Create|保存|Save/i }).first();
  
  // ボタンが有効になるまで少し待つ
  await btn.waitFor({ state: 'visible', timeout: 5000 });
  
  if (!(await clickBestEffort(btn))) throw new Error("作成ボタンが押せませんでした");
  
  // ダイアログが閉じるのを待機
  await page.waitForTimeout(3000);
}

async function createWatchlistAlertIfPossible(page, listName) {
  console.log("--- Creating alert for:", listName);
  await switchWatchlistTo(page, listName);
  await clickAddAlertToList(page);

  await selectAlertCondition(page, ALERT_CONDITION_NAME);
  await selectAlertResolution(page, ALERT_TIMEFRAME_LABEL); // ここで修正後のロジックが動く
  await selectAlertSymbolsList(page, listName);

  await safeScreenshot(page, `before_submit_${listName}`);
  await submitAlertDialog(page); // ここで修正後の安定クリックが動く
  await safeScreenshot(page, `after_submit_${listName}`);
}

// ==============================
// Main (維持)
// ==============================
(async () => {
  let browser, context, page;
  try {
    reqEnv("TRADINGVIEW_STORAGE_STATE", TRADINGVIEW_STORAGE_STATE);
    reqEnv("WATCHLIST_1_URL", WATCHLIST_1_URL);
    reqEnv("WATCHLIST_2_URL", WATCHLIST_2_URL);
    ensureDir(WORKDIR);

    browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
    context = await browser.newContext({ storageState: JSON.parse(TRADINGVIEW_STORAGE_STATE) });
    page = await context.newPage();
    page.setDefaultTimeout(STEP_TIMEOUT);

    await page.goto("https://www.tradingview.com/chart/", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(5000);

    if (DO_DELETE_ALERTS) await deleteManagedAlerts(page, [WATCHLIST_1_PREFIX, WATCHLIST_2_PREFIX]);
    if (DO_DELETE_WATCHLISTS) {
      await deleteManagedWatchlistsByPrefix(page, WATCHLIST_1_PREFIX);
      await deleteManagedWatchlistsByPrefix(page, WATCHLIST_2_PREFIX);
    }
    if (DO_IMPORT_WATCHLISTS) {
      await importWatchlistFromFile(page, OUT1, WATCHLIST_1_FINAL_NAME);
      await importWatchlistFromFile(page, OUT2, WATCHLIST_2_FINAL_NAME);
    }
    if (DO_CREATE_WATCHLIST_ALERT) {
      await createWatchlistAlertIfPossible(page, WATCHLIST_1_FINAL_NAME);
      await createWatchlistAlertIfPossible(page, WATCHLIST_2_FINAL_NAME);
    }

    console.log("ALL DONE.");
    await browser.close();
  } catch (err) {
    console.error("FAILED:", err);
    if (page) await safeScreenshot(page, "crash");
    if (browser) await browser.close();
    process.exit(1);
  }
})();
