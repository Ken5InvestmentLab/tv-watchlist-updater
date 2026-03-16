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

const ALERT_CONDITION_NAME =
  process.env.ALERT_CONDITION_NAME ||
  "天底極致 - 通常モード Alert用 (20, 2, 12, 75, 35, 0.18, 5, 2.5)";
const ALERT_TIMEFRAME_LABEL = process.env.ALERT_TIMEFRAME_LABEL || "4 時間";

const NAV_TIMEOUT = 90000;
const STEP_TIMEOUT = 45000;

const ALERT_SLOT_RELEASE_WAIT_MS = Number(process.env.ALERT_SLOT_RELEASE_WAIT_MS || 45000);
const WATCHLIST_PROMO_RETRY_MAX = Number(process.env.WATCHLIST_PROMO_RETRY_MAX || 3);
const WATCHLIST_PROMO_RETRY_WAIT_MS = Number(process.env.WATCHLIST_PROMO_RETRY_WAIT_MS || 15000);

const WORKDIR = path.resolve(process.cwd(), "tmp");
const OUT1 = path.join(WORKDIR, "wl1.txt");
const OUT2 = path.join(WORKDIR, "wl2.txt");

// ==============================
// Timestamp / Names (JST)
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

// ==============================
// Utils
// ==============================
function reqEnv(name, val) {
  if (!val) throw new Error(`Missing env: ${name}`);
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

async function downloadToFile(url, filePath, label = url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed ${res.status}: ${label} ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(filePath, buf);
}

async function downloadOptionalToFile(url, filePath, label = url) {
  if (!url) {
    console.log(`Skip optional watchlist: ${label} (URL未設定)`);
    return false;
  }

  const res = await fetch(url);

  if (res.status === 404) {
    console.log(`Skip optional watchlist: ${label} (404)`);
    return false;
  }

  if (!res.ok) throw new Error(`Download failed ${res.status}: ${label} ${url}`);

  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(filePath, buf);
  return true;
}

async function safeScreenshot(page, label) {
  try {
    ensureDir(WORKDIR);
    const p = path.join(WORKDIR, `screenshot_${Date.now()}_${label}.png`);
    await page.screenshot({ path: p, fullPage: true });
    console.log("Saved screenshot:", p);
  } catch (e) {
    console.log("Screenshot failed:", e?.message || e);
  }
}

async function safeClick(locator, options = {}) {
  try {
    const el = locator.first();
    await el.waitFor({ state: "visible", timeout: options.timeout || STEP_TIMEOUT });
    await el.scrollIntoViewIfNeeded().catch(() => {});
    await el.click(options);
    return true;
  } catch {
    return false;
  }
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isManagedListName(name, prefix) {
  if (!name) return false;
  return name === prefix || name.startsWith(`${prefix}_`);
}

async function firstVisible(locator, max = 30) {
  const count = Math.min(await locator.count().catch(() => 0), max);
  for (let i = 0; i < count; i++) {
    const el = locator.nth(i);
    if (await el.isVisible().catch(() => false)) return el;
  }
  return null;
}

async function clickBestEffort(locator, timeout = 8000) {
  try {
    await locator.scrollIntoViewIfNeeded().catch(() => {});
    await locator.click({ force: true, timeout });
    return true;
  } catch {}
  try {
    await locator.dispatchEvent("click");
    return true;
  } catch {}
  try {
    await locator.evaluate((el) => el.click());
    return true;
  } catch {}
  return false;
}

// ==============================
// Base UI: Watchlist panel / menu
// ==============================
async function isWatchlistPanelReady(page) {
  const menuButton = page.locator('button[data-name="watchlists-button"]').first();
  return await menuButton.isVisible().catch(() => false);
}

async function openWatchlistPanel(page) {
  const candidates = [
    page.locator('button[aria-label="ウォッチリスト、詳細、ニュース"]').first(),
    page.locator('button[aria-label="Watchlist, details and news"]').first(),
    page.locator('button[data-tooltip="ウォッチリスト、詳細、ニュース"]').first(),
    page.locator('button[data-tooltip="Watchlist, details and news"]').first(),
  ];

  for (let attempt = 0; attempt < 4; attempt++) {
    for (const c of candidates) {
      const clicked = await safeClick(c, { timeout: 6000, force: true });
      if (!clicked) continue;

      await page.waitForTimeout(1200);

      if (await isWatchlistPanelReady(page)) {
        return;
      }
    }

    await page.waitForTimeout(500);
  }

  await safeScreenshot(page, "watchlist_panel_not_ready");
  throw new Error("ウォッチリストパネルは開けましたが、操作可能状態にできませんでした");
}

async function ensureWatchlistPanelOpen(page) {
  if (await isWatchlistPanelReady(page)) return;

  await openWatchlistPanel(page);

  if (await isWatchlistPanelReady(page)) return;

  await safeScreenshot(page, "watchlist_panel_not_open");
  throw new Error("ウォッチリストパネルを開けませんでした");
}

async function getWatchlistMenuTrigger(page) {
  const candidates = [
    page.locator('button[data-name="watchlists-button"] [class*="arrow"]').first(),
    page.locator('button[data-name="watchlists-button"] [class*="caret"]').first(),
    page.locator('button[data-name="watchlists-button"] svg').last(),
  ];

  for (const c of candidates) {
    if (await c.isVisible().catch(() => false)) return c;
  }

  return null;
}

async function openWatchlistMenuHard(page, retry = 8) {
  await ensureWatchlistPanelOpen(page);

  for (let i = 0; i < retry; i++) {
    await closeAnyMenu(page);
    await page.waitForTimeout(300);

    const btn = await getWatchlistMenuTrigger(page);
    if (!btn) {
      await page.waitForTimeout(600);
      continue;
    }

    const ok = await clickBestEffort(btn, 8000);
    if (!ok) continue;

    await page.waitForTimeout(900);

    const root = await getVisibleWatchlistMenuRoot(page);
    if (root) {
      console.log(`watchlist menu opened. retry=${i + 1}`);
      return true;
    }

    console.log(`watchlist menu not actually opened. retry=${i + 1}`);
    await page.waitForTimeout(600);
  }

  await safeScreenshot(page, "watchlist_menu_not_opened");
  return false;
}



async function closeAnyMenu(page) {
  await page.keyboard.press("Escape").catch(() => {});
  await page.waitForTimeout(200);
  await page.keyboard.press("Escape").catch(() => {});
  await page.waitForTimeout(250);
}

async function getVisibleWatchlistMenuRoot(page) {
  const re =
    /リストに(高度な)?アラートを追加|リストを開く|リストをアップロード|Open list|Upload list|Add( advanced)? alert/i;

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

async function getCurrentWatchlistTitle(page) {
  const t = await page
    .locator('button[data-name="watchlists-button"]')
    .first()
    .textContent()
    .catch(() => "");
  return (t || "").trim();
}

// ==============================
// Menu item helpers
// ==============================
async function findMenuItemByText(page, re) {
  const root =
    (await getVisibleWatchlistMenuRoot(page)) ||
    (await firstVisible(page.locator('[role="menu"], div[data-name="menu-inner"], div[class*="menu"]'), 20));

  if (!root) return null;

  const candidates = [
    root.locator('[role="menuitem"]').filter({ hasText: re }),
    root.locator('[data-role="menuitem"]').filter({ hasText: re }),
    root.locator('button').filter({ hasText: re }),
    root.locator('div').filter({ hasText: re }),
    root.locator('span').filter({ hasText: re }),
  ];

  for (const c of candidates) {
    const el = await firstVisible(c, 50);
    if (el) {
      const clickableAncestor = el
        .locator('xpath=ancestor-or-self::*[@role="menuitem" or @data-role="menuitem" or self::button or @tabindex][1]')
        .first();

      if (await clickableAncestor.count().catch(() => 0)) {
        if (await clickableAncestor.isVisible().catch(() => false)) return clickableAncestor;
      }
      return el;
    }
  }

  return null;
}

async function clickMenuItemByText(page, re) {
  const item = await findMenuItemByText(page, re);
  if (!item) {
    await safeScreenshot(page, "menu_item_not_found");
    throw new Error(`メニュー項目が見つかりませんでした: ${re}`);
  }

  const ok = await clickBestEffort(item, 8000);
  if (!ok) {
    await safeScreenshot(page, "menu_item_click_failed");
    throw new Error(`メニュー項目をクリックできませんでした: ${re}`);
  }

  await page.waitForTimeout(900);
}

// ==============================
// Open list dialog / switch list
// ==============================
async function openListOpenDialog(page) {
  const listAnyRow = page.locator('div[data-role="list-item"]').first();
  if (await listAnyRow.isVisible().catch(() => false)) return;

  const opened = await openWatchlistMenuHard(page, 8);
  if (!opened) throw new Error("ウォッチリストメニューが開けませんでした");

  await clickMenuItemByText(page, /リストを開く|Open list/i);
  await page.waitForTimeout(1200);

  const ok = await listAnyRow.isVisible().catch(() => false);
  if (!ok) {
    await safeScreenshot(page, "open_list_dialog_not_visible");
    throw new Error("『リストを開く…』後、一覧が表示されませんでした");
  }
}

async function closeOpenListDialogIfVisible(page) {
  const closeBtn = page.locator('button[data-qa-id="close"]').first();
  if (await closeBtn.isVisible().catch(() => false)) {
    await safeClick(closeBtn, { timeout: 5000, force: true });
    await page.waitForTimeout(600);
    return true;
  }
  return false;
}

async function switchWatchlistTo(page, listName) {
  console.log("Switching watchlist to:", listName);

  await openListOpenDialog(page);

  const row = page.locator(`div[data-role="list-item"][data-title="${listName}"]`).first();
  await row.waitFor({ state: "visible", timeout: 20000 });
  await row.scrollIntoViewIfNeeded().catch(() => {});
  await row.click({ force: true, timeout: 8000 });

  await closeOpenListDialogIfVisible(page).catch(() => {});
  await closeAnyMenu(page);
  await page.waitForTimeout(1000);

  let ok = false;
  for (let i = 0; i < 20; i++) {
    const cur = await getCurrentWatchlistTitle(page);
    if (cur.includes(listName)) {
      ok = true;
      console.log("Watchlist switched:", cur);
      break;
    }
    await page.waitForTimeout(1000);
  }

  if (!ok) {
    await safeScreenshot(page, `watchlist_switch_failed_${listName}`);
    throw new Error(`ウォッチリスト切替確認失敗: ${listName}`);
  }
}

async function assertWatchlistExists(page, listName) {
  await openListOpenDialog(page);

  let found = false;
  for (let i = 0; i < 15; i++) {
    const row = page.locator(`div[data-role="list-item"][data-title="${listName}"]`).first();
    if (await row.isVisible().catch(() => false)) {
      found = true;
      break;
    }
    await page.waitForTimeout(800);
  }

  await closeOpenListDialogIfVisible(page).catch(() => {});
  await closeAnyMenu(page);

  if (!found) {
    await safeScreenshot(page, `watchlist_not_found_${listName}`);
    throw new Error(`アップロード後のウォッチリスト確認に失敗しました: ${listName}`);
  }
}

// ==============================
// Delete watchlists
// ==============================
async function deleteManagedWatchlistsByPrefix(page, prefix) {
  console.log(`Deleting watchlists with prefix: ${prefix}`);

  await openListOpenDialog(page);

  for (let round = 0; round < 80; round++) {
    const rows = page.locator('div[data-role="list-item"][data-title]');
    const count = await rows.count().catch(() => 0);

    let targetName = "";

    for (let i = 0; i < count; i++) {
      const row = rows.nth(i);
      const dataTitle = ((await row.getAttribute("data-title").catch(() => "")) || "").trim();
      const fallbackText = ((await row.textContent().catch(() => "")) || "").trim();
      const text = dataTitle || fallbackText;

      if (!isManagedListName(text, prefix)) continue;
      targetName = text;
      break;
    }

    if (!targetName) {
      console.log(`No more managed watchlists for prefix: ${prefix}`);
      await closeOpenListDialogIfVisible(page).catch(() => {});
      await closeAnyMenu(page);
      return;
    }

    console.log(`Deleting watchlist: ${targetName}`);

    const row = page.locator(`div[data-role="list-item"][data-title="${targetName}"]`).first();
    const deleteBtn = row.locator('[data-name="remove-button"]').first();

    await row.hover().catch(() => {});
    await page.waitForTimeout(300);

    const clicked = await safeClick(deleteBtn, { timeout: 8000, force: true });
    if (!clicked) {
      await safeScreenshot(page, `watchlist_delete_btn_not_found_${targetName}`);
      throw new Error(`ウォッチリスト削除ボタンが見つかりませんでした: ${targetName}`);
    }

    const confirm = page.getByRole("button", { name: /削除|Delete|はい|Yes|OK/i }).first();
    const confirmOk = await safeClick(confirm, { timeout: 8000, force: true });

    if (!confirmOk) {
      await safeScreenshot(page, `watchlist_delete_confirm_not_found_${targetName}`);
      throw new Error(`ウォッチリスト削除確認ボタンが押せませんでした: ${targetName}`);
    }

    let deleted = false;
    for (let i = 0; i < 10; i++) {
      await page.waitForTimeout(800);

      const stillExists = await page
        .locator(`div[data-role="list-item"][data-title="${targetName}"]`)
        .first()
        .isVisible()
        .catch(() => false);

      if (!stillExists) {
        deleted = true;
        break;
      }
    }

    if (!deleted) {
      await safeScreenshot(page, `watchlist_delete_not_reflected_${targetName}`);
      throw new Error(`ウォッチリスト削除後も残っています: ${targetName}`);
    }
  }

  throw new Error(`ウォッチリスト削除ループが上限に達しました: ${prefix}`);
}

// ==============================
// Import watchlist
// ==============================
function makeUploadCopyWithDesiredName(srcPath, desiredName) {
  ensureDir(WORKDIR);
  const dstPath = path.join(WORKDIR, `${desiredName}.txt`);
  fs.copyFileSync(srcPath, dstPath);
  return dstPath;
}

async function clickUploadList(page) {
  await clickMenuItemByText(page, /リストをアップロード|Upload list/i);
}

async function importWatchlistFromFile(page, filePath, desiredName) {
  const uploadPath = makeUploadCopyWithDesiredName(filePath, desiredName);

  console.log("Uploading file:", uploadPath);
  console.log("File exists:", fs.existsSync(uploadPath));
  console.log("File size:", fs.statSync(uploadPath).size);

  await closeOpenListDialogIfVisible(page).catch(() => {});
  await closeAnyMenu(page);
  await page.waitForTimeout(400);

  const opened = await openWatchlistMenuHard(page, 8);
  if (!opened) throw new Error("ウォッチリストメニューが開けませんでした（アップロード前）");

  const chooserPromise = page.waitForEvent("filechooser", { timeout: 12000 }).catch(() => null);
  const inputPromise = page
    .locator('input[type="file"]')
    .first()
    .waitFor({ state: "attached", timeout: 12000 })
    .then(() => true)
    .catch(() => false);

  await clickUploadList(page);

  const [chooser, hasInput] = await Promise.all([chooserPromise, inputPromise]);

  if (chooser) {
    await chooser.setFiles(uploadPath);
    console.log("setFiles done:", uploadPath);
  } else if (hasInput) {
    const input = page.locator('input[type="file"]').first();
    await input.setInputFiles(uploadPath);
    console.log("setInputFiles done:", uploadPath);
  } else {
    await safeScreenshot(page, "file_input_and_filechooser_not_found");
    throw new Error("input[type=file] も filechooser も取得できませんでした");
  }

  await page.waitForTimeout(2500);
  await safeScreenshot(page, `after_upload_${desiredName}`);
}

// ==============================
// Alerts
// ==============================
async function firstVisibleClickable(locator, max = 40) {
  const count = Math.min(await locator.count().catch(() => 0), max);

  for (let i = 0; i < count; i++) {
    const el = locator.nth(i);
    if (!(await el.isVisible().catch(() => false))) continue;

    const clickable = el
      .locator(
        'xpath=ancestor-or-self::*[self::button or @role="button" or @tabindex or contains(@class,"button")][1]'
      )
      .first();

    if (await clickable.isVisible().catch(() => false)) return clickable;
    return el;
  }

  return null;
}

async function describeLocator(locator) {
  try {
    return await locator.evaluate((el) => ({
      tag: el.tagName,
      text: (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 120),
      ariaLabel: el.getAttribute("aria-label"),
      dataName: el.getAttribute("data-name"),
      dataTooltip: el.getAttribute("data-tooltip"),
      title: el.getAttribute("title"),
      className:
        typeof el.className === "string"
          ? el.className.slice(0, 160)
          : String(el.className || ""),
    }));
  } catch {
    return null;
  }
}

async function findAlertsPanelToggle(page) {
  const attrSelector = [
    'button[aria-label*="Alerts" i]',
    'button[aria-label*="アラート"]',
    '[role="button"][aria-label*="Alerts" i]',
    '[role="button"][aria-label*="アラート"]',

    'button[data-tooltip*="Alerts" i]',
    'button[data-tooltip*="アラート"]',
    '[role="button"][data-tooltip*="Alerts" i]',
    '[role="button"][data-tooltip*="アラート"]',

    'button[title*="Alerts" i]',
    'button[title*="アラート"]',
    '[role="button"][title*="Alerts" i]',
    '[role="button"][title*="アラート"]',

    'button[data-name*="alert" i]',
    '[role="button"][data-name*="alert" i]',
    '[data-name*="alert" i]',
    '[data-qa-id*="alert" i]',
  ].join(", ");

  const direct = await firstVisibleClickable(page.locator(attrSelector), 80);
  if (direct) return direct;

  const textCandidates = [
    page.getByRole("button", { name: /Alerts|アラート/i }),
    page.locator('[role="tab"]').filter({ hasText: /^Alerts$|^アラート$/i }),
    page
      .locator('button, [role="button"], [tabindex]')
      .filter({ hasText: /^Alerts$|^アラート$/i }),
  ];

  for (const candidate of textCandidates) {
    const el = await firstVisibleClickable(candidate, 40);
    if (el) return el;
  }

  return null;
}

async function isAlertsContentReady(page) {
  const markers = [
    page.locator('[data-name="alert-item-ticker"]').first(),
    page.locator('[data-name="alerts-manager"]').first(),
    page.locator('[data-name="alerts-list"]').first(),
    page.locator('[data-qa-id="alerts-list"]').first(),
    page.locator('[data-name*="alert" i]').first(),
    page.locator('[data-qa-id*="alert" i]').first(),
    page
      .getByText(
        /No alerts|No alerts created|アラートがありません|アラートはありません|アラートなし/i
      )
      .first(),
  ];

  for (const marker of markers) {
    if (await marker.isVisible().catch(() => false)) return true;
  }

  return false;
}

async function isAlertsSidebarOpen(page) {
  if (await isAlertsContentReady(page)) return true;

  const selectedAlertsTab = page
    .locator('[role="tab"][aria-selected="true"]')
    .filter({ hasText: /^Alerts$|^アラート$/i })
    .first();

  if (await selectedAlertsTab.isVisible().catch(() => false)) return true;

  return false;
}

async function openAlertsPanel(page) {
  for (let attempt = 0; attempt < 6; attempt++) {
    await closeAnyMenu(page);

    const toggle = await findAlertsPanelToggle(page);
    if (toggle) {
      const meta = await describeLocator(toggle);
      if (meta) {
        console.log("alerts toggle candidate:", JSON.stringify(meta));
      }

      const clicked = await clickBestEffort(toggle, 8000);
      if (clicked) {
        await page.waitForTimeout(1500);
        if (await isAlertsSidebarOpen(page)) {
          return;
        }
      }
    } else {
      console.log(`alerts toggle not found. retry=${attempt + 1}`);
    }

    const alertTab = await firstVisibleClickable(
      page
        .locator('[role="tab"], button, [role="button"], [tabindex]')
        .filter({ hasText: /^Alerts$|^アラート$/i }),
      30
    );

    if (alertTab) {
      const meta = await describeLocator(alertTab);
      if (meta) {
        console.log("alerts tab fallback:", JSON.stringify(meta));
      }

      const clicked = await clickBestEffort(alertTab, 8000);
      if (clicked) {
        await page.waitForTimeout(1500);
        if (await isAlertsSidebarOpen(page)) {
          return;
        }
      }
    }

    if (attempt === 2) {
      console.log("alerts panel still not opening. refreshing page once...");
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.waitForLoadState("networkidle").catch(() => {});
      await page.waitForTimeout(4000);
    } else {
      await page.waitForTimeout(1000);
    }
  }

  await safeScreenshot(page, "alerts_sidebar_not_opened");
  throw new Error("アラートサイドバーを開けませんでした");
}

async function ensureAlertsPanelOpen(page) {
  for (let attempt = 0; attempt < 4; attempt++) {
    if (!(await isAlertsSidebarOpen(page))) {
      await openAlertsPanel(page);
    }

    const alertsTabCandidates = [
      page.getByRole("tab", { name: /^Alerts$|^アラート$/i }).first(),
      page.locator('[role="tab"]').filter({ hasText: /^Alerts$|^アラート$/i }).first(),
      page
        .locator('button, [role="button"], [tabindex]')
        .filter({ hasText: /^Alerts$|^アラート$/i })
        .first(),
    ];

    for (const tab of alertsTabCandidates) {
      if (await tab.isVisible().catch(() => false)) {
        await safeClick(tab, { timeout: 5000, force: true });
        await page.waitForTimeout(1000);
        break;
      }
    }

    if (await isAlertsContentReady(page)) {
      return;
    }

    console.log(`alerts panel not ready yet. retry=${attempt + 1}`);
    await closeAnyMenu(page);
    await page.waitForTimeout(800);
  }

  await safeScreenshot(page, "alerts_list_not_visible");
  throw new Error("アラート一覧タブを表示できませんでした");
}

async function getAllAlertTickerTexts(page) {
  await ensureAlertsPanelOpen(page);

  const tickerItems = page.locator('[data-name="alert-item-ticker"]');
  const count = await tickerItems.count().catch(() => 0);
  const arr = [];

  for (let i = 0; i < count; i++) {
    const txt = ((await tickerItems.nth(i).textContent().catch(() => "")) || "").trim();
    if (txt) arr.push(txt);
  }

  console.log("Detected alert ticker count:", arr.length);
  return arr;
}

async function getManagedAlertTickerTexts(page, prefixes) {
  const all = await getAllAlertTickerTexts(page);
  return all.filter((txt) =>
    prefixes.some((p) => txt.startsWith(`${p}_`) || txt.startsWith(`${p},`) || txt === p)
  );
}

async function assertNoManagedAlertsRemain(page, prefixes) {
  const remain = await getManagedAlertTickerTexts(page, prefixes);
  if (remain.length > 0) {
    await safeScreenshot(page, "managed_alerts_remain");
    throw new Error(`既存アラート削除後も管理対象アラートが残っています: ${remain.join(", ")}`);
  }
}

async function deleteManagedAlerts(page, prefixes) {
  await ensureAlertsPanelOpen(page);

  for (let round = 0; round < 200; round++) {
    const tickerItems = page.locator('[data-name="alert-item-ticker"]');
    const count = await tickerItems.count().catch(() => 0);

    let target = null;
    let targetText = "";

    for (let i = 0; i < count; i++) {
      const txt = (await tickerItems.nth(i).textContent().catch(() => "")).trim();
      if (!txt) continue;

      const matched = prefixes.some((p) => txt.startsWith(`${p}_`) || txt.startsWith(`${p},`) || txt === p);
      if (matched) {
        target = tickerItems.nth(i);
        targetText = txt;
        break;
      }
    }

    if (!target) {
      console.log("No more managed alerts.");
      return;
    }

    console.log("Deleting alert:", targetText);

    await target.scrollIntoViewIfNeeded().catch(() => {});
    await target.click({ button: "right", force: true, timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(500);

    const del = page.locator('tr[data-role="menuitem"]').filter({ hasText: /^削除$|Delete/i }).first();
    const ok = await safeClick(del, { timeout: 8000, force: true });

    if (!ok) {
      await safeScreenshot(page, `alert_delete_menu_not_found_${Date.now()}`);
      throw new Error(`アラート削除メニューが見つかりませんでした: ${targetText}`);
    }

    const confirm = page.getByRole("button", { name: /削除|Delete|はい|Yes|OK/i }).first();
    const confirmOk = await safeClick(confirm, { timeout: 8000, force: true });

    if (!confirmOk) {
      await safeScreenshot(page, `alert_delete_confirm_not_found_${Date.now()}`);
      throw new Error(`アラート削除確認ボタンが押せませんでした: ${targetText}`);
    }

    let deleted = false;
    for (let i = 0; i < 10; i++) {
      await page.waitForTimeout(800);
      const texts = await getManagedAlertTickerTexts(page, prefixes);
      if (!texts.includes(targetText)) {
        deleted = true;
        break;
      }
    }

    if (!deleted) {
      await safeScreenshot(page, `alert_delete_not_reflected_${Date.now()}`);
      throw new Error(`アラート削除後も項目が残っています: ${targetText}`);
    }
  }

  throw new Error("アラート削除ループが上限に達しました");
}

// ==============================
// Watchlist alert promo dialog
// ==============================
async function isWatchlistPromoDialogVisible(page) {
  const markers = [
    page.getByText(/One alert to track an entire watchlist/i).first(),
    page.locator('button[data-qa-id="promo-dialog-close-button"]').first(),
    page.getByText(/Current plan/i).first(),
    page.getByText(/Premium/i).first(),
    page.getByText(/Ultimate/i).first(),
  ];

  let hitCount = 0;
  for (const marker of markers) {
    if (await marker.isVisible().catch(() => false)) hitCount++;
  }

  return hitCount >= 2;
}

async function getWatchlistPromoDialogText(page) {
  const dialogByTitle = page
    .getByText(/One alert to track an entire watchlist/i)
    .first()
    .locator('xpath=ancestor::*[@role="dialog" or contains(@class,"dialog") or contains(@class,"modal")][1]')
    .first();

  const dialogText = ((await dialogByTitle.textContent().catch(() => "")) || "").trim();
  if (dialogText) return dialogText;

  const bodyText = ((await page.locator("body").textContent().catch(() => "")) || "").trim();
  const marker = "One alert to track an entire watchlist";
  const idx = bodyText.indexOf(marker);
  if (idx >= 0) {
    return bodyText.slice(idx, Math.min(bodyText.length, idx + 400));
  }

  return bodyText.slice(0, 400);
}

async function closeWatchlistPromoDialog(page) {
  const closeCandidates = [
    page.locator('button[data-qa-id="promo-dialog-close-button"]').first(),
    page.locator('button[aria-label="閉じる"]').first(),
    page.locator('button[aria-label="Close"]').first(),
    page.getByRole("button", { name: /閉じる|Close/i }).first(),
  ];

  for (const btn of closeCandidates) {
    const visible = await btn.isVisible().catch(() => false);
    if (!visible) continue;

    const clicked = await clickBestEffort(btn, 8000);
    if (clicked) {
      await page.waitForTimeout(1000);

      const stillVisible = await isWatchlistPromoDialogVisible(page);
      if (!stillVisible) {
        console.log("[promo] promo dialog closed");
        return true;
      }
    }
  }

  return false;
}

async function getCurrentWatchlistHeaderState(page) {
  const btn = page.locator('button[data-name="watchlists-button"]').first();
  await btn.waitFor({ state: "visible", timeout: 10000 });

  const text = ((await btn.textContent().catch(() => "")) || "")
    .replace(/\s+/g, " ")
    .trim();

  const iconCount = await btn.locator("svg").count().catch(() => 0);

  return { text, iconCount };
}

async function waitForWatchlistAlertMarker(page, listName, beforeIconCount) {
  for (let i = 0; i < 20; i++) {
    const { text, iconCount } = await getCurrentWatchlistHeaderState(page);
    console.log(
      `[alert-marker] text="${text}" icons=${iconCount} before=${beforeIconCount}`
    );

    if (text.includes(listName) && iconCount > beforeIconCount) {
      return true;
    }

    await page.waitForTimeout(1000);
  }

  return false;
}


function normalizeTvText(s = "") {
  return String(s)
    .normalize("NFKC")
    .replace(/[\u00A0\u2000-\u200B]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function compactTvText(s = "") {
  return normalizeTvText(s).replace(/\s+/g, "");
}

function isTarget4hText(s = "") {
  const raw = String(s).normalize("NFKC").toLowerCase();
  const compact = raw.replace(/[\s\u00A0\u2000-\u200B]+/g, "");

  return (
    compact === "4h" ||
    compact === "4hour" ||
    compact === "4hours" ||
    compact === "240" ||
    compact === "4時間" ||

    // 複合文字列にも対応
    raw.includes("4h") ||
    raw.includes("4 hour") ||
    raw.includes("4 hours") ||
    raw.includes("4時間")
  );
}

function isSameAsChartText(s = "") {
  const t = compactTvText(s);
  return (
    t.includes("sameaschart") ||
    t.includes("チャートと同一") ||
    t.includes("チャートと同じ")
  );
}

async function readLocatorTextWithAttrs(locator) {
  try {
    return await locator.evaluate((el) => {
      const bits = [
        el.textContent || "",
        el.innerText || "",
        el.getAttribute("aria-label") || "",
        el.getAttribute("data-tooltip") || "",
        el.getAttribute("title") || "",
        el.getAttribute("data-value") || "",
      ].filter(Boolean);
      return bits.join(" | ").replace(/\s+/g, " ").trim();
    });
  } catch {
    return "";
  }
}

async function collectVisibleTexts(locator, max = 120) {
  const out = [];
  const count = Math.min(await locator.count().catch(() => 0), max);

  for (let i = 0; i < count; i++) {
    const el = locator.nth(i);
    const visible = await el.isVisible().catch(() => false);
    if (!visible) continue;

    const txt = await el.evaluate((node) => {
      const text = (node.innerText || node.textContent || "").trim();
      const aria = node.getAttribute?.("aria-label") || "";
      const tooltip = node.getAttribute?.("data-tooltip") || "";
      const value = node.getAttribute?.("data-value") || "";
      return [text, aria, tooltip, value].filter(Boolean).join(" | ");
    }).catch(() => "");

    const norm = txt.replace(/\s+/g, " ").trim();
    if (norm) out.push(norm);
  }

  return [...new Set(out)];
}

async function getCurrentChartTimeframeText(page) {
  const candidates = [
    page.locator('button[aria-haspopup="menu"][aria-label="4 時間"]').first(),
    page.locator('button[aria-haspopup="menu"][data-tooltip="4 時間"]').first(),
    page.locator('button[aria-haspopup="menu"][aria-label*="時間"]').first(),
    page.locator('button[aria-haspopup="menu"][data-tooltip*="時間"]').first(),
    page.locator('button[aria-haspopup="menu"][aria-label*="hour" i]').first(),
    page.locator('button[aria-haspopup="menu"][data-tooltip*="hour" i]').first(),
    page.locator('[data-name="header-toolbar-intervals"] button').first(),
    page.locator('button[aria-label*="Interval" i]').first(),
    page.locator('button[aria-label*="時間足"]').first(),
    page.locator('button[aria-label*="時間"]').first(),
  ];

  for (const c of candidates) {
    if (!(await c.count().catch(() => 0))) continue;
    if (!(await c.isVisible().catch(() => false))) continue;
    const txt = await readLocatorTextWithAttrs(c);
    if (txt) return txt;
  }

  const buttons = page.locator('button[aria-haspopup="menu"], header button, button');
  const count = Math.min(await buttons.count().catch(() => 0), 200);

  for (let i = 0; i < count; i++) {
    const el = buttons.nth(i);
    if (!(await el.isVisible().catch(() => false))) continue;
    const txt = await readLocatorTextWithAttrs(el);
    if (/\b(1s|5s|15s|1m|3m|5m|15m|30m|45m|1h|2h|3h|4h|1d|d|1w|w|1mo|mo)\b/i.test(txt) || /4 ?時間/i.test(txt)) {
      return txt;
    }
  }

  return "";
}

async function getChartTimeframeButtonCandidates(page) {
  return [
    page.locator('button[aria-haspopup="menu"][aria-label="4 時間"]').first(),
    page.locator('button[aria-haspopup="menu"][data-tooltip="4 時間"]').first(),
    page.locator('button[aria-haspopup="menu"][aria-label*="時間"]').first(),
    page.locator('button[aria-haspopup="menu"][data-tooltip*="時間"]').first(),
    page.locator('button[aria-haspopup="menu"][aria-label*="hour" i]').first(),
    page.locator('button[aria-haspopup="menu"][data-tooltip*="hour" i]').first(),
    page.locator('[data-name="header-toolbar-intervals"] button').first(),
    page.locator('button[aria-label*="Interval" i]').first(),
    page.locator('button[aria-label*="時間足"]').first(),
    page.locator('button[aria-label*="時間"]').first(),
  ];
}

async function openChartTimeframeMenu(page) {
  const candidates = await getChartTimeframeButtonCandidates(page);

  for (const c of candidates) {
    if (!(await c.count().catch(() => 0))) continue;
    if (!(await c.isVisible().catch(() => false))) continue;

    const meta = await describeLocator(c);
    if (meta) {
      console.log("[timeframe] menu button candidate:", JSON.stringify(meta));
    }

    const clicked = await clickBestEffort(c, 4000);
    if (!clicked) continue;

    await page.waitForTimeout(300);
    const root = await findTimeframeMenuRoot(page);
    if (root) return true;
  }

  const buttons = page.locator('button[aria-haspopup="menu"], header button, button');
  const count = Math.min(await buttons.count().catch(() => 0), 200);

  for (let i = 0; i < count; i++) {
    const el = buttons.nth(i);
    if (!(await el.isVisible().catch(() => false))) continue;
    const txt = await readLocatorTextWithAttrs(el);
    if (!(/\b(1s|5s|15s|1m|3m|5m|15m|30m|45m|1h|2h|3h|4h|1d|d|1w|w|1mo|mo)\b/i.test(txt) || /4 ?時間/i.test(txt))) {
      continue;
    }

    const clicked = await clickBestEffort(el, 4000);
    if (!clicked) continue;

    await page.waitForTimeout(300);
    const root = await findTimeframeMenuRoot(page);
    if (root) return true;
  }

  return false;
}

async function findTimeframeMenuRoot(page) {
  const selectors = [
    '[role="menu"]',
    '[role="listbox"]',
    'div[data-name="menu-inner"]',
    'div[class*="menu"]',
  ];

  for (const sel of selectors) {
    const loc = page.locator(sel);
    const count = Math.min(await loc.count().catch(() => 0), 20);

    for (let i = count - 1; i >= 0; i--) {
      const root = loc.nth(i);
      if (!(await root.isVisible().catch(() => false))) continue;

      const text = normalizeTvText(await root.textContent().catch(() => ""));
      const has240 = (await root.locator('[data-value="240"]').count().catch(() => 0)) > 0;
      const looksLikeTfMenu =
        has240 ||
        /seconds|minutes|hours|days|weeks|months|秒|分|時間|日|週|月/.test(text);

      if (looksLikeTfMenu) return root;
    }
  }

  return null;
}

async function expandHoursSectionIfNeeded(page, menuRoot) {
  const headers = [
    menuRoot.locator('text=/^HOURS$/i').first(),
    menuRoot.locator('text=/^Hours$/').first(),
    menuRoot.locator('text=/^時間$/').first(),
    menuRoot.locator('text=/^時間足$/').first(),
  ];

  for (const h of headers) {
    if (!(await h.count().catch(() => 0))) continue;
    if (!(await h.isVisible().catch(() => false))) continue;
    await clickBestEffort(h, 4000);
    await page.waitForTimeout(250);
    return true;
  }

  return false;
}

async function select4hFromMenu(page, menuRoot) {
  // 1) あなたがくれたHTML構造を最優先
  const priorityLocators = [
    menuRoot.locator('[data-role="menuitem"][data-value="240"]').first(),
    menuRoot.locator('[role="row"][data-value="240"]').first(),
    menuRoot.locator('[data-value="240"]').first(),
    menuRoot.locator('text=/^4\\s*時間$|^4\\s*hours?$|^4h$/i').first(),
  ];

  for (const loc of priorityLocators) {
    const count = await loc.count().catch(() => 0);
    if (!count) continue;
    const visible = await loc.isVisible().catch(() => false);
    if (!visible) continue;

    const debugText = await loc.innerText().catch(() => "");
    console.log(`[timeframe] clicking priority 4h candidate: "${debugText}"`);

    await loc.click({ timeout: 3000 }).catch(async () => {
      await loc.evaluate((el) => el.click()).catch(() => {});
    });
    return true;
  }

  // 2) 一般探索（row / menuitem を広く拾う）
  let items = menuRoot.locator(
    [
      '[data-role="menuitem"]',
      '[role="row"]',
      '[role="option"]',
      'button',
      '[role="button"]',
      'div'
    ].join(', ')
  );

  let count = Math.min(await items.count().catch(() => 0), 400);

  for (let i = 0; i < count; i++) {
    const el = items.nth(i);
    const visible = await el.isVisible().catch(() => false);
    if (!visible) continue;

    const meta = await el.evaluate((node) => ({
      text: (node.innerText || node.textContent || "").trim(),
      aria: node.getAttribute?.("aria-label") || "",
      tooltip: node.getAttribute?.("data-tooltip") || "",
      value: node.getAttribute?.("data-value") || "",
      role: node.getAttribute?.("role") || "",
      dataRole: node.getAttribute?.("data-role") || "",
    })).catch(() => null);

    if (!meta) continue;

    const joined = [meta.text, meta.aria, meta.tooltip, meta.value].join(" | ");
    if (meta.value === "240" || isTarget4hText(joined)) {
      console.log("[timeframe] clicking fallback 4h candidate:", meta);

      await el.click({ timeout: 3000 }).catch(async () => {
        await el.evaluate((node) => node.click()).catch(() => {});
      });
      return true;
    }
  }

  // 3) スクロール探索
  for (let r = 0; r < 8; r++) {
    await menuRoot.evaluate((el) => {
      el.scrollTop = (el.scrollTop || 0) + 260;
    }).catch(() => {});
    await page.waitForTimeout(200);

    const direct = menuRoot.locator('[data-role="menuitem"][data-value="240"], [role="row"][data-value="240"]').first();
    if (await direct.count().catch(() => 0)) {
      if (await direct.isVisible().catch(() => false)) {
        const t = await direct.innerText().catch(() => "");
        console.log(`[timeframe] clicking scrolled 4h candidate: "${t}"`);
        await direct.click({ timeout: 3000 }).catch(async () => {
          await direct.evaluate((el) => el.click()).catch(() => {});
        });
        return true;
      }
    }
  }

  return false;
}

async function logChartTimeframeMenuState(page, tag = "chart-timeframe") {
  const root = await findTimeframeMenuRoot(page);
  if (!root) {
    console.log(`[${tag}] timeframe menu root not found`);
    return;
  }

  const visibleTexts = await collectVisibleTexts(
    root.locator('[data-role="menuitem"], [role="row"], [role="option"], button, div, span'),
    200
  );
  console.log(`[${tag}] visible timeframe options:`, visibleTexts);
}

async function ensureChartTimeframe(page, targetLabel = "4 時間") {
  const before = await getCurrentChartTimeframeText(page);
  console.log(`[timeframe] current chart timeframe before change: "${before}"`);

  if (isTarget4hText(before)) {
    console.log("[timeframe] chart is already 4H");
    return;
  }

  const opened = await openChartTimeframeMenu(page);
  if (!opened) {
    await safeScreenshot(page, 'chart_timeframe_button_not_found');
    throw new Error("チャート時間足ボタンが見つかりませんでした");
  }

  await logChartTimeframeMenuState(page, 'chart-timeframe-opened');

  const root = await findTimeframeMenuRoot(page);
  if (!root) {
    await safeScreenshot(page, 'chart_timeframe_menu_not_found');
    throw new Error("チャート時間足メニューが見つかりませんでした");
  }

  const ok = await select4hFromMenu(page, root);
  if (!ok) {
    await safeScreenshot(page, 'chart_4h_not_found');
    throw new Error(`チャート時間足 "${targetLabel}" が見つかりませんでした`);
  }

  await page.waitForTimeout(1200);

  const after = await getCurrentChartTimeframeText(page);
  console.log(`[timeframe] current chart timeframe after change: "${after}"`);

  if (!isTarget4hText(after)) {
    await safeScreenshot(page, 'chart_timeframe_verify_failed');
    throw new Error(`チャート時間足の変更確認に失敗しました。現在: "${after}"`);
  }
}

async function getAlertIntervalButton(dialog) {
  const candidates = [
    dialog.locator('[role="button"], [role="combobox"], button').filter({ hasText: /Same as chart|チャートと同一|チャートと同じ/i }).first(),
    dialog.locator('[role="button"], [role="combobox"], button').filter({ hasText: /4 ?時間|4 ?hours?|4h|240/i }).first(),
    dialog.locator('[data-qa-id="resolution-dropdown-item"]').first(),
    dialog.locator('button[aria-haspopup="menu"]').filter({ hasText: /4 ?時間|4 ?hours?|4h|Same as chart|チャート/i }).first(),
  ];

  for (const c of candidates) {
    if (!(await c.count().catch(() => 0))) continue;
    if (await c.isVisible().catch(() => false)) return c;
  }

  const controls = dialog.locator('[role="button"], [role="combobox"], button');
  const count = Math.min(await controls.count().catch(() => 0), 80);

  for (let i = 0; i < count; i++) {
    const el = controls.nth(i);
    if (!(await el.isVisible().catch(() => false))) continue;
    const txt = await readLocatorTextWithAttrs(el);
    if (isSameAsChartText(txt) || isTarget4hText(txt)) return el;
  }

  return null;
}

async function logAlertIntervalState(page, tag = 'alert-interval') {
  const dialog = await getAlertDialogRoot(page);
  if (!dialog) {
    console.log(`[${tag}] alert dialog not found`);
    return;
  }

  const chartTf = await getCurrentChartTimeframeText(page);
  console.log(`[${tag}] current chart timeframe: "${chartTf}"`);

  const buttonTexts = await collectVisibleTexts(dialog.locator('button, [role="button"], [role="combobox"]'), 80);
  console.log(`[${tag}] visible dialog button texts:`, buttonTexts);

  const intervalBtn = await getAlertIntervalButton(dialog);
  if (!intervalBtn) {
    console.log(`[${tag}] interval button not found`);
    await safeScreenshot(page, `${tag}_interval_button_not_found`);
    return;
  }

  const intervalText = await readLocatorTextWithAttrs(intervalBtn);
  console.log(`[${tag}] interval button text: "${intervalText}"`);

  const opened = await clickBestEffort(intervalBtn, 4000);
  if (opened) {
    await page.waitForTimeout(250);
    const root = await findTimeframeMenuRoot(page);
    if (root) {
      const optionTexts = await collectVisibleTexts(
        root.locator('[data-role="menuitem"], [role="row"], [role="option"], button, div, span'),
        200
      );
      console.log(`[${tag}] visible interval options:`, optionTexts);
    }
    await closeAnyMenu(page);
  }

  await safeScreenshot(page, tag);
}

async function verifyAlertIntervalIsSameAsChart(page) {
  const dialog = await getAlertDialogRoot(page);
  const intervalBtn = await getAlertIntervalButton(dialog);

  if (!intervalBtn) {
    await logAlertIntervalState(page, 'alert_interval_missing');
    throw new Error("Alert の Interval ボタンが見つかりませんでした");
  }

  const txt = await readLocatorTextWithAttrs(intervalBtn);
  if (isSameAsChartText(txt)) {
    console.log(`[alert] interval is Same as chart: "${txt}"`);
    return;
  }

  await logAlertIntervalState(page, 'alert_interval_not_same_as_chart');
  throw new Error(`Alert の Interval が 'Same as chart' ではありませんでした: ${txt}`);
}

// ==============================
// Create alert helpers
// ==============================
async function clickAddAlertToList(page) {
  const re = /リストに(高度な)?アラートを追加|Add( advanced)? alert( to list)?|アラートを追加/i;

  for (let i = 0; i < 16; i++) {
    await page.waitForTimeout(1200);

    const opened = await openWatchlistMenuHard(page, 6);
    if (!opened) continue;

    const itemCandidates = [
      page.getByRole("menuitem", { name: re }).first(),
      page.locator('[role="menuitem"]').filter({ hasText: re }).first(),
      page.locator('[data-role="menuitem"]').filter({ hasText: re }).first(),
      page.locator('tr[data-role="menuitem"]').filter({ hasText: re }).first(),
      page.locator('div[data-role="menuitem"]').filter({ hasText: re }).first(),
      page.locator('div[class*="item"]').filter({ hasText: re }).first(),
      page.locator('button').filter({ hasText: re }).first(),
      page.locator('span').filter({ hasText: re }).first(),
      page.getByText(re).first(),
    ];

    for (const item of itemCandidates) {
      const visible = await item.isVisible().catch(() => false);
      if (!visible) continue;

      await item.scrollIntoViewIfNeeded().catch(() => {});
      const ok = await clickBestEffort(item, 8000);
      if (ok) {
        await page.waitForTimeout(1200);
        return true;
      }
    }

    console.log(`Add-alert menu not visible yet. retry=${i + 1}`);
    await closeAnyMenu(page);
  }

  await safeScreenshot(page, "click_add_alert_to_list_failed");
  throw new Error("『リストにアラートを追加…』がメニュー内に見つかりませんでした");
}

async function selectAlertCondition(page, conditionName) {
  console.log("Selecting alert condition:", conditionName);

  const dropdownCandidates = [
    page.locator('[data-qa-id="main-series-select-title"]').first(),
    page.locator('span').filter({ hasText: /^Price$|^価格$/ }).first(),
    page.locator('div').filter({ hasText: /^Price$|^価格$/ }).last(),
    page.getByText(/^Condition$|^条件$/).locator('~ div').locator('[role="button"], [role="combobox"]').first(),
  ];

  let opened = false;
  for (const c of dropdownCandidates) {
    if (await c.isVisible().catch(() => false)) {
      if (await safeClick(c, { timeout: 4000, force: true })) {
        opened = true;
        break;
      }
    }
  }

  if (!opened) {
    await clickBestEffort(page.getByText(/^Price$|^価格$/).first(), 4000);
  }

  await page.waitForTimeout(1000);

  const shortName = conditionName.split("(")[0].trim();
  console.log("Looking for option matching:", shortName);

  const optionCandidates = [
    page.locator('[role="option"]').filter({ hasText: conditionName }).first(),
    page.locator('[role="option"]').filter({ hasText: shortName }).first(),
    page.locator('span').filter({ hasText: shortName }).first(),
    page.getByText(shortName).first(),
  ];

  let selected = false;
  for (const opt of optionCandidates) {
    if (await opt.isVisible().catch(() => false)) {
      if (await safeClick(opt, { timeout: 5000, force: true })) {
        selected = true;
        break;
      }
    }
  }

  if (!selected) {
    await safeScreenshot(page, "alert_condition_not_found");
    throw new Error(`アラート条件が見つかりませんでした: ${conditionName} (短縮検索: ${shortName})`);
  }

  await page.waitForTimeout(600);
}

async function selectAlertResolution(page, label) {
  console.log(`[deprecated] selectAlertResolution() is no longer used directly. target=${label}`);
  await ensureChartTimeframe(page, label || "4 時間");
}

async function getAlertDialogRoot(page) {
  const byTitle = page
    .getByText(/Create alert on|アラートを作成/i)
    .first()
    .locator('xpath=ancestor::*[@role="dialog" or contains(@class,"dialog") or contains(@class,"modal")][1]')
    .first();

  if (await byTitle.isVisible().catch(() => false)) return byTitle;

  const roleDialog = page.locator('[role="dialog"]').last();
  if (await roleDialog.isVisible().catch(() => false)) return roleDialog;

  return page.locator("body");
}

async function ensureAlertTargetList(page, listName) {
  const dialog = await getAlertDialogRoot(page);
  const dialogText = ((await dialog.textContent().catch(() => "")) || "").replace(/\s+/g, " ");

  if (dialogText.includes(listName)) {
    console.log(`Alert target list confirmed in dialog: ${listName}`);
    return;
  }

  const legacyDisclosure = dialog
    .locator('[data-qa-id="ui-kit-disclosure-control main-symbols-select"]')
    .first();

  const legacyVisible = await legacyDisclosure.isVisible().catch(() => false);

  if (legacyVisible) {
    const cur = ((await legacyDisclosure.textContent().catch(() => "")) || "").trim();
    if (cur.includes(listName)) {
      console.log(`Alert target list confirmed in selector: ${listName}`);
      return;
    }

    await legacyDisclosure.click({ force: true, timeout: 12000 });
    await page.waitForTimeout(700);

    const option = page
      .locator('[role="option"]')
      .filter({ hasText: new RegExp(`^${escapeRegex(listName)}$`) })
      .first();

    const ok = await safeClick(option, { timeout: 20000, force: true });
    if (!ok) {
      await safeScreenshot(page, `alert_target_option_not_found_${listName}`);
      throw new Error(`アラート対象リストを補正できませんでした: ${listName}`);
    }

    await page.waitForTimeout(700);

    const recheckText = ((await dialog.textContent().catch(() => "")) || "").replace(/\s+/g, " ");
    if (recheckText.includes(listName)) {
      console.log(`Alert target list corrected and confirmed: ${listName}`);
      return;
    }
  }

  await safeScreenshot(page, `alert_target_list_mismatch_${listName}`);
  throw new Error(`アラート対象リストを確認できませんでした: ${listName}`);
}

async function findVisibleAlertSubmitButton(page) {
  const btnCandidates = [
    page.getByRole("button", { name: /作成|Create|保存|Save/i }),
    page.locator('[data-name="submit-button"]'),
    page.locator('button[type="submit"]'),
  ];

  for (const locator of btnCandidates) {
    const count = await locator.count().catch(() => 0);
    for (let i = count - 1; i >= 0; i--) {
      const el = locator.nth(i);
      if (await el.isVisible().catch(() => false)) {
        return el;
      }
    }
  }

  return null;
}

async function submitAlertDialog(page) {
  console.log("Submitting alert dialog...");

  let targetBtn = await findVisibleAlertSubmitButton(page);
  if (!targetBtn) {
    await safeScreenshot(page, "alert_submit_button_not_found");
    throw new Error("アラート作成ボタンが見つかりませんでした");
  }

  let clicked = await clickBestEffort(targetBtn, 8000);
  if (!clicked) {
    await safeScreenshot(page, "alert_submit_click_failed");
    throw new Error("アラート作成ボタンをクリックできませんでした");
  }

  console.log("Submit button clicked! Waiting for dialog to close...");

  let dialogClosed = false;
  let promoRetryCount = 0;

  for (let i = 0; i < 14; i++) {
    await page.waitForTimeout(1500);

    if (await isWatchlistPromoDialogVisible(page)) {
      promoRetryCount += 1;
      const promoText = await getWatchlistPromoDialogText(page);

      console.log(`[promo] Watchlist promo dialog detected (${promoRetryCount}/${WATCHLIST_PROMO_RETRY_MAX})`);
      console.log(`[promo] ${promoText.replace(/\s+/g, " ").slice(0, 500)}`);

      await safeScreenshot(page, `watchlist_promo_detected_${promoRetryCount}`);

      const closed = await closeWatchlistPromoDialog(page);
      if (!closed) {
        await safeScreenshot(page, `watchlist_promo_close_failed_${promoRetryCount}`);
        throw new Error("watchlist alert の案内モーダルを閉じられませんでした");
      }

      if (promoRetryCount >= WATCHLIST_PROMO_RETRY_MAX) {
        throw new Error(
          `watchlist alert の案内モーダルが ${promoRetryCount} 回連続で表示されました。枠解放の遅延またはTV側制限の可能性があります`
        );
      }

      console.log(`[promo] waiting ${WATCHLIST_PROMO_RETRY_WAIT_MS}ms before retrying Create`);
      await page.waitForTimeout(WATCHLIST_PROMO_RETRY_WAIT_MS);

      targetBtn = await findVisibleAlertSubmitButton(page);
      if (!targetBtn) {
        await safeScreenshot(page, `alert_submit_button_missing_after_promo_${promoRetryCount}`);
        throw new Error("案内モーダルを閉じた後、アラート作成ボタンが見つかりませんでした");
      }

      clicked = await clickBestEffort(targetBtn, 8000);
      if (!clicked) {
        await safeScreenshot(page, `alert_submit_retry_click_failed_${promoRetryCount}`);
        throw new Error("案内モーダル後のCreate再クリックに失敗しました");
      }

      continue;
    }

    const stillVisible = await targetBtn.isVisible().catch(() => false);
    if (!stillVisible) {
      dialogClosed = true;
      break;
    }

    const errorText = await page.locator("body").textContent().catch(() => "");
    if (/limit|上限|too many alerts|アラート数|cannot create|作成できません|プラン/i.test(errorText || "")) {
      await safeScreenshot(page, "alert_submit_limit_error");
      throw new Error("アラート作成時に上限または作成失敗メッセージを検知しました");
    }

    if (i < 13) {
      console.log("Dialog still visible, retrying click...");
      await clickBestEffort(targetBtn, 5000);
    }
  }

  if (!dialogClosed) {
    await safeScreenshot(page, "alert_submit_dialog_not_closed");
    throw new Error("アラート作成ダイアログが閉じませんでした。作成失敗の可能性があります");
  }

  await page.waitForTimeout(3000);
}

async function assertManagedAlertCreated(page, listName) {
  await ensureAlertsPanelOpen(page);

  let found = false;

  for (let i = 0; i < 15; i++) {
    await page.waitForTimeout(1200);

    const tickerItems = page.locator('[data-name="alert-item-ticker"]');
    const count = await tickerItems.count().catch(() => 0);

    for (let j = 0; j < count; j++) {
      const txt = (await tickerItems.nth(j).textContent().catch(() => "")).trim();
      if (txt.includes(listName) || txt.startsWith(listName)) {
        found = true;
        break;
      }
    }

    if (found) break;
  }

  if (!found) {
    await safeScreenshot(page, `alert_not_created_${Date.now()}`);
    throw new Error(`アラート作成後の確認に失敗しました: ${listName}`);
  }
}

async function createWatchlistAlertIfPossible(page, listName) {
  console.log("Creating alert for:", listName);

  try {
    await switchWatchlistTo(page, listName);
    await page.waitForTimeout(4000);

    await ensureChartTimeframe(page, ALERT_TIMEFRAME_LABEL || "4 時間");

    const chartTf = await getCurrentChartTimeframeText(page);
    console.log(`[alert] chart timeframe before create: "${chartTf}"`);

    // 作成前のヘッダー状態を保持
    const beforeHeader = await getCurrentWatchlistHeaderState(page);
    console.log(
      `[before-create] watchlist="${beforeHeader.text}" icons=${beforeHeader.iconCount}`
    );

    await clickAddAlertToList(page);
    await ensureAlertTargetList(page, listName);
    await logAlertIntervalState(page, `dialog-opened-${listName}`);

    await selectAlertCondition(page, ALERT_CONDITION_NAME);
    await logAlertIntervalState(page, `condition-selected-${listName}`);

    await verifyAlertIntervalIsSameAsChart(page);

    await safeScreenshot(page, `before_alert_submit_${listName}`);
    await submitAlertDialog(page);
    await safeScreenshot(page, `after_alert_submit_${listName}`);

    // まずはウォッチリストヘッダーの時計アイコン増加で確認
    const marked = await waitForWatchlistAlertMarker(
      page,
      listName,
      beforeHeader.iconCount
    );

    if (marked) {
      console.log(`Alert marker detected on watchlist header: ${listName}`);
      return;
    }

    // フォールバック: Alerts一覧確認（ただしここで即死させない）
    console.log(
      `[fallback] header marker not detected. trying alerts panel check: ${listName}`
    );

    try {
      await assertManagedAlertCreated(page, listName);
      console.log(`Alert confirmed in alerts list: ${listName}`);
      return;
    } catch (e) {
      await safeScreenshot(page, `alert_confirm_failed_${listName}`);
      throw new Error(
        `アラート作成後の確認に失敗しました: ${listName} / ${e?.message || e}`
      );
    }
  } catch (err) {
    console.error(`[alert] failed for watchlist="${listName}":`, err?.message || err);
    await safeScreenshot(page, `failed_${listName}`);
    throw err;
  }
}

async function dumpAlertTickerTexts(page) {
  const arr = await getAllAlertTickerTexts(page);
  console.log("Current alert ticker texts:", JSON.stringify(arr, null, 2));
}

// ==============================
// Main
// ==============================
(async () => {
  let browser;
  let context;
  let page;
  let deletedAlertsThisRun = false;

  try {
    reqEnv("TRADINGVIEW_STORAGE_STATE", TRADINGVIEW_STORAGE_STATE);
    reqEnv("WATCHLIST_1_URL", WATCHLIST_1_URL);

    ensureDir(WORKDIR);

    console.log("WATCHLIST_1_FINAL_NAME:", WATCHLIST_1_FINAL_NAME);
    console.log("WATCHLIST_2_FINAL_NAME:", WATCHLIST_2_FINAL_NAME);

    console.log("Downloading watchlists...");

    const activeLists = [];

    await downloadToFile(WATCHLIST_1_URL, OUT1, "WATCHLIST_1_URL");
    activeLists.push({
      path: OUT1,
      prefix: WATCHLIST_1_PREFIX,
      finalName: WATCHLIST_1_FINAL_NAME,
    });

    const hasSecond = await downloadOptionalToFile(WATCHLIST_2_URL, OUT2, "WATCHLIST_2_URL");
    if (hasSecond) {
      activeLists.push({
        path: OUT2,
        prefix: WATCHLIST_2_PREFIX,
        finalName: WATCHLIST_2_FINAL_NAME,
      });
    }

    console.log(`Active watchlists: ${activeLists.length}`);

    console.log("Launching Playwright...");
    browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });

    const storageState = JSON.parse(TRADINGVIEW_STORAGE_STATE);
    context = await browser.newContext({
      storageState,
      viewport: { width: 1600, height: 1200 },
    });
    page = await context.newPage();

    page.setDefaultTimeout(STEP_TIMEOUT);
    page.setDefaultNavigationTimeout(NAV_TIMEOUT);

    console.log("Opening TradingView...");
    await page.goto("https://www.tradingview.com/chart/", { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle").catch(() => {});
    await page.waitForTimeout(8000);

    const needLogin = await page.getByText(/Sign in|ログイン/i).first().isVisible().catch(() => false);
    if (needLogin) {
      await safeScreenshot(page, "need_login");
      throw new Error("TradingView がログイン状態ではありません（storageState が無効/期限切れの可能性）");
    }

    if (DO_DELETE_ALERTS) {
      console.log("Before delete: alert ticker dump");
      await dumpAlertTickerTexts(page);

      console.log("Deleting old alerts...");
      await deleteManagedAlerts(page, [WATCHLIST_1_PREFIX, WATCHLIST_2_PREFIX]);
      await assertNoManagedAlertsRemain(page, [WATCHLIST_1_PREFIX, WATCHLIST_2_PREFIX]);

      console.log("After delete: alert ticker dump");
      await dumpAlertTickerTexts(page);

      deletedAlertsThisRun = true;
    }

    if (DO_DELETE_WATCHLISTS) {
      console.log("Deleting old watchlists...");
      await deleteManagedWatchlistsByPrefix(page, WATCHLIST_1_PREFIX);
      await deleteManagedWatchlistsByPrefix(page, WATCHLIST_2_PREFIX);
    }

    if (DO_IMPORT_WATCHLISTS) {
      console.log("Importing watchlists...");
      for (const list of activeLists) {
        await importWatchlistFromFile(page, list.path, list.finalName);
        await assertWatchlistExists(page, list.finalName);
      }
    }

    if (DO_CREATE_WATCHLIST_ALERT) {
      if (deletedAlertsThisRun) {
        console.log(`Waiting ${ALERT_SLOT_RELEASE_WAIT_MS}ms for TradingView alert slot release...`);
        await page.waitForTimeout(ALERT_SLOT_RELEASE_WAIT_MS);
      }

      console.log("Creating watchlist alerts...");
      for (const list of activeLists) {
        await createWatchlistAlertIfPossible(page, list.finalName);
      }

      console.log("After create: alert ticker dump");
      try {
        await dumpAlertTickerTexts(page);
      } catch (e) {
        console.log("Skip alert ticker dump after create:", e?.message || e);
      }
    }
    
    console.log("DONE.");
    await safeScreenshot(page, "done");
    await browser.close();
  } catch (err) {
    console.error("FAILED:", err?.message || err);
    if (page) await safeScreenshot(page, "failed");
    if (browser) await browser.close().catch(() => {});
    process.exit(1);
  }
})();
