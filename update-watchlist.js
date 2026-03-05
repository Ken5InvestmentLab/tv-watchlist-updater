const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright-core");
const { Browserbase } = require("@browserbasehq/sdk");

// ==============================
// Environment Variables
// ==============================
const BROWSERBASE_API_KEY = process.env.BROWSERBASE_API_KEY;
const BROWSERBASE_PROJECT_ID = process.env.BROWSERBASE_PROJECT_ID;
const TRADINGVIEW_STORAGE_STATE = process.env.TRADINGVIEW_STORAGE_STATE;

const WATCHLIST_1_URL = process.env.WATCHLIST_1_URL;
const WATCHLIST_2_URL = process.env.WATCHLIST_2_URL;

// prefix 用
const WATCHLIST_1_PREFIX = process.env.WATCHLIST_1_NAME || "wl1";
const WATCHLIST_2_PREFIX = process.env.WATCHLIST_2_NAME || "wl2";

const DO_DELETE_ALERTS = (process.env.DO_DELETE_ALERTS || "true") === "true";
const DO_DELETE_WATCHLISTS = (process.env.DO_DELETE_WATCHLISTS || "true") === "true";
const DO_IMPORT_WATCHLISTS = (process.env.DO_IMPORT_WATCHLISTS || "true") === "true";
const DO_CREATE_WATCHLIST_ALERT = (process.env.DO_CREATE_WATCHLIST_ALERT || "true") === "true";

// Alert condition
const ALERT_CONDITION_NAME =
  process.env.ALERT_CONDITION_NAME ||
  "天底極致 - 通常モード Alert用 (20, 2, 12, 75, 35, 0.18, 5, 2.5)";
const ALERT_TIMEFRAME_LABEL = process.env.ALERT_TIMEFRAME_LABEL || "4 時間";

const NAV_TIMEOUT = 60000;
const STEP_TIMEOUT = 30000;

const WORKDIR = path.resolve(process.cwd(), "tmp");
const OUT1 = path.join(WORKDIR, "wl1.txt");
const OUT2 = path.join(WORKDIR, "wl2.txt");

// ==============================
// Timestamp / Names
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
// Utility
// ==============================
function reqEnv(name, val) {
  if (!val) throw new Error(`Missing env: ${name}`);
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

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
  } catch (_) {
    return false;
  }
}

async function clickFirstVisible(candidates, options = {}) {
  for (const locator of candidates) {
    const ok = await safeClick(locator, options);
    if (ok) return true;
  }
  return false;
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isOldListName(name, prefix) {
  if (!name) return false;
  if (!name.startsWith(prefix)) return false;
  const tsRe = new RegExp(`^${escapeRegex(prefix)}_\\d{8}_\\d{4}$`);
  return !tsRe.test(name);
}

function isManagedListName(name, prefix) {
  if (!name) return false;
  return name === prefix || name.startsWith(`${prefix}_`);
}

async function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ==============================
// Base UI
// ==============================
async function openWatchlistPanel(page) {
  const candidates = [
    page.locator('button[aria-label="ウォッチリスト、詳細、ニュース"]'),
    page.locator('button[aria-label="Watchlist, details and news"]'),
    page.locator('button[data-tooltip="ウォッチリスト、詳細、ニュース"]'),
    page.locator('button[data-tooltip="Watchlist, details and news"]'),
    page.locator('button[data-name="base"][data-tooltip="ウォッチリスト、詳細、ニュース"]'),
    page.locator('button[data-name="base"][data-tooltip="Watchlist, details and news"]'),
  ];

  const ok = await clickFirstVisible(candidates, { timeout: 8000 });
  if (!ok) {
    await safeScreenshot(page, "watchlist_panel_not_found");
    throw new Error("ウォッチリストパネルを開くボタンが見つかりませんでした");
  }

  await page.waitForTimeout(1500);
}

async function ensureWatchlistPanelOpen(page) {
  const menuButton = page.locator('button[data-name="watchlists-button"]').first();
  if (await menuButton.isVisible().catch(() => false)) return;

  await openWatchlistPanel(page);
  await page.waitForTimeout(1500);

  if (!(await menuButton.isVisible().catch(() => false))) {
    await safeScreenshot(page, "watchlist_panel_open_but_menu_missing");
  }
}

async function openWatchlistMenu(page) {
  await ensureWatchlistPanelOpen(page);

  const candidates = [
    page.locator('button[data-name="watchlists-button"]'),
    page.locator('button[data-name="watchlists-button"][type="button"]'),
    page.locator('[data-name="widgetbar-watchlist"] button[data-name="watchlists-button"]'),
  ];

  const ok = await clickFirstVisible(candidates, { timeout: 8000 });
  if (!ok) {
    await safeScreenshot(page, "watchlist_menu_not_found");
    throw new Error("ウォッチリストメニューボタンが見つかりませんでした");
  }

  await page.waitForTimeout(1200);
}

async function getCurrentWatchlistTitle(page) {
  const candidates = [
    page.locator('button[data-name="watchlists-button"] .titleRow-mQBvegEO').first(),
    page.locator('button[data-name="watchlists-button"]').first(),
  ];

  for (const c of candidates) {
    const txt = await c.textContent().catch(() => "");
    if (txt && txt.trim()) return txt.trim();
  }
  return "";
}

// ==============================
// Open list dialog / switch / delete
// ==============================
async function clickMenuItem(page, regex) {
  const candidates = [
    page.locator('div[data-role="menuitem"]').filter({ hasText: regex }),
    page.locator('[role="menu"] div[data-role="menuitem"]').filter({ hasText: regex }),
    page.locator('[data-qa-id="popup-menu-container"] div[data-role="menuitem"]').filter({ hasText: regex }),
  ];

  const ok = await clickFirstVisible(candidates, { timeout: 5000, force: true });
  if (!ok) {
    await safeScreenshot(page, `menuitem_not_found_${String(regex)}`);
    throw new Error(`メニュー項目が見つかりませんでした: ${regex}`);
  }

  await page.waitForTimeout(1200);
}

async function openListOpenDialog(page) {
  const alreadyOpenCandidates = [
    page.locator("div.title-ODL8WA9K").first(),
    page.locator('[data-role="list-item-action"][data-name="remove-button"]').first(),
  ];

  for (const c of alreadyOpenCandidates) {
    if (await c.isVisible().catch(() => false)) {
      return;
    }
  }

  await openWatchlistMenu(page);
  await clickMenuItem(page, /リストを開く|Open list/i);
  await page.waitForTimeout(1500);
}

async function switchWatchlistTo(page, listName) {
  console.log("Switching watchlist to:", listName);
  await openListOpenDialog(page);

  const title = page.locator("div.title-ODL8WA9K").filter({ hasText: new RegExp(`^${escapeRegex(listName)}$`) }).first();
  const visible = await title.isVisible().catch(() => false);
  if (!visible) {
    await safeScreenshot(page, `watchlist_not_found_${listName}`);
    throw new Error(`指定ウォッチリストが見つかりませんでした: ${listName}`);
  }

  await title.click({ timeout: 5000, force: true });
  await page.waitForTimeout(2000);

  const current = await getCurrentWatchlistTitle(page);
  if (!current.includes(listName)) {
    await safeScreenshot(page, `watchlist_switch_failed_${listName}`);
    throw new Error(`ウォッチリスト切替確認失敗: ${listName} / current=${current}`);
  }
}

async function deleteManagedWatchlistsByPrefix(page, prefix) {
  console.log(`Deleting watchlists with prefix: ${prefix}`);

  await openListOpenDialog(page);

  for (let round = 0; round < 50; round++) {
    const titles = page.locator("div.title-ODL8WA9K");
    const count = await titles.count().catch(() => 0);

    let targetIndex = -1;
    let targetName = "";

    for (let i = 0; i < count; i++) {
      const text = (await titles.nth(i).textContent().catch(() => "")).trim();
      if (!isManagedListName(text, prefix)) continue;
      targetIndex = i;
      targetName = text;
      break;
    }

    if (targetIndex === -1) {
      console.log(`No more managed watchlists for prefix: ${prefix}`);
      await page.keyboard.press("Escape").catch(() => {});
      await page.waitForTimeout(500);
      break;
    }

    console.log(`Deleting watchlist: ${targetName}`);

    const title = titles.nth(targetIndex);
    await title.scrollIntoViewIfNeeded().catch(() => {});
    await title.hover().catch(() => {});
    await page.waitForTimeout(500);

    const deleteCandidates = [
      page.locator('[data-role="list-item-action"][data-name="remove-button"]').nth(targetIndex),
      title.locator("xpath=ancestor::div[contains(@class,'item')][1]").locator('[data-role="list-item-action"][data-name="remove-button"]'),
      title.locator("xpath=ancestor::div[1]").locator('[data-role="list-item-action"][data-name="remove-button"]'),
      page.locator('[data-name="remove-button"]').nth(targetIndex),
    ];

    let deleted = false;
    for (const btn of deleteCandidates) {
      const ok = await safeClick(btn, { timeout: 5000, force: true });
      if (ok) {
        deleted = true;
        break;
      }
    }

    if (!deleted) {
      await safeScreenshot(page, `watchlist_delete_button_not_found_${prefix}`);
      throw new Error(`ウォッチリスト削除ボタンが見つかりませんでした: ${targetName}`);
    }

    await page.waitForTimeout(1000);

    const confirmCandidates = [
      page.getByRole("button", { name: /削除|Delete|OK|はい|Yes/i }),
      page.locator('button:has-text("削除")'),
      page.locator('button:has-text("Delete")'),
      page.locator('button:has-text("OK")'),
      page.locator('button:has-text("はい")'),
    ];

    await clickFirstVisible(confirmCandidates, { timeout: 5000, force: true });
    await page.waitForTimeout(1500);

    // 削除後に一覧が閉じた場合だけ開き直す
    const listStillVisible = await page.locator("div.title-ODL8WA9K").first().isVisible().catch(() => false);
    if (!listStillVisible) {
      await openListOpenDialog(page);
    }
  }
}

async function closeOpenListDialogIfVisible(page) {
  const closeCandidates = [
    page.locator('button[data-qa-id="close"]'),
    page.locator('button[data-qa-id="close"]').filter({ hasText: /メニューを閉じる|Close menu/i }),
  ];

  for (const c of closeCandidates) {
    const el = c.first();
    const visible = await el.isVisible().catch(() => false);
    if (!visible) continue;

    const clicked = await safeClick(el, { timeout: 3000, force: true });
    if (clicked) {
      await page.waitForTimeout(700);
      return true;
    }
  }

  return false;
}

// ==============================
// Import watchlist
// ==============================
async function clickUploadList(page) {
  await ensureWatchlistPanelOpen(page);
  await openWatchlistMenu(page);

  const candidates = [
    page.locator('div[data-role="menuitem"]').filter({ hasText: "リストをアップロード…" }),
    page.locator('div[data-role="menuitem"]').filter({ hasText: "リストをアップロード..." }),
    page.locator('div[data-role="menuitem"]').filter({ hasText: /リストをアップロード/ }),
    page.locator('div[data-role="menuitem"]').filter({ hasText: /Upload list/i }),
  ];

  const ok = await clickFirstVisible(candidates, { timeout: 5000, force: true });
  if (!ok) {
    await safeScreenshot(page, "upload_list_menuitem_not_found");
    throw new Error("『リストをアップロード…』メニューが見つかりませんでした");
  }

  await page.waitForTimeout(1000);
}

async function maybeRenameImportedList(page, desiredName) {
  const nameInputCandidates = [
    page.locator('input[placeholder*="名前"]'),
    page.locator('input[placeholder*="Name" i]'),
    page.locator('input[name*="name" i]'),
  ];

  let filled = false;
  for (const loc of nameInputCandidates) {
    const el = loc.first();
    if (await el.isVisible().catch(() => false)) {
      await el.fill(desiredName).catch(() => {});
      filled = true;
      break;
    }
  }

  const confirmCandidates = [
    page.getByRole("button", { name: /作成|保存|OK|Import|Create|Save/i }),
    page.locator('button:has-text("作成")'),
    page.locator('button:has-text("保存")'),
    page.locator('button:has-text("OK")'),
    page.locator('button:has-text("Import")'),
    page.locator('button:has-text("Create")'),
    page.locator('button:has-text("Save")'),
  ];

  const confirmed = await clickFirstVisible(confirmCandidates, { timeout: 3000, force: true });
  if (filled || confirmed) {
    await page.waitForTimeout(1500);
  }
}

async function importWatchlistFromFile(page, filePath, desiredName) {
  console.log("Uploading file:", filePath);
  console.log("File exists:", fs.existsSync(filePath));
  console.log("File size:", fs.statSync(filePath).size);

  // 削除後に一覧が残っていたら閉じる
  await closeOpenListDialogIfVisible(page).catch(() => {});
  await page.waitForTimeout(500);

  await ensureWatchlistPanelOpen(page);
  await openWatchlistMenu(page);

  const [chooser] = await Promise.all([
    page.waitForEvent("filechooser", { timeout: 10000 }),
    clickUploadList(page),
  ]);

  await chooser.setFiles(filePath);
  console.log("setFiles done:", filePath);

  await page.waitForTimeout(3000);
  await safeScreenshot(page, `after_setFiles_${desiredName}`);

  await maybeRenameImportedList(page, desiredName);
  await page.waitForTimeout(2500);
}

// ==============================
// Alerts
// ==============================
async function openAlertsPanel(page) {
  const candidates = [
    page.locator('button[data-name="alerts"]'),
    page.locator('button[aria-label="アラート"]'),
    page.locator('button[data-tooltip="アラート"]'),
    page.locator('button[aria-label="Alerts"]'),
    page.locator('button[data-tooltip="Alerts"]'),
  ];

  const ok = await clickFirstVisible(candidates, { timeout: 8000 });
  if (!ok) {
    await safeScreenshot(page, "alerts_panel_not_found");
    throw new Error("アラートボタンが見つかりませんでした");
  }

  await page.waitForTimeout(1500);
}

async function deleteManagedAlerts(page, prefixes) {
  await openAlertsPanel(page);

  for (let round = 0; round < 100; round++) {
    const tickerItems = page.locator('[data-name="alert-item-ticker"]');
    const count = await tickerItems.count().catch(() => 0);

    let targetTicker = null;
    let targetText = "";

    for (let i = 0; i < count; i++) {
      const txt = (await tickerItems.nth(i).textContent().catch(() => "")).trim();
      if (!txt) continue;

      const matched = prefixes.some(
        (p) => txt.startsWith(`${p}_`) || txt.startsWith(`${p},`) || txt === p
      );
      if (matched) {
        targetTicker = tickerItems.nth(i);
        targetText = txt;
        break;
      }
    }

    if (!targetTicker) {
      console.log("No more managed alerts.");
      break;
    }

    console.log("Deleting alert:", targetText);

    await targetTicker.scrollIntoViewIfNeeded().catch(() => {});
    await targetTicker.click({ button: "right", timeout: 5000 }).catch(async () => {
      await targetTicker.hover().catch(() => {});
      await page.waitForTimeout(500);
      await targetTicker.click({ button: "right", force: true, timeout: 5000 });
    });

    await page.waitForTimeout(800);

    const deleteMenuCandidates = [
      page.locator('tr[data-role="menuitem"]').filter({ hasText: /^削除$|Delete/ }),
      page
        .locator('tr[data-role="menuitem"] [data-label="true"]')
        .filter({ hasText: /^削除$|Delete/ })
        .locator("xpath=ancestor::tr[1]"),
      page.locator('[data-role="menuitem"]').filter({ hasText: /^削除$|Delete/ }),
    ];

    const deleted = await clickFirstVisible(deleteMenuCandidates, {
      timeout: 5000,
      force: true,
    });

    if (!deleted) {
      await safeScreenshot(page, "alert_delete_context_menu_not_found");
      throw new Error(`アラート右クリックメニューの『削除』が見つかりませんでした: ${targetText}`);
    }

    await page.waitForTimeout(1000);

    const confirmCandidates = [
      page.getByRole("button", { name: /削除|Delete|OK|はい|Yes/i }),
      page.locator('button:has-text("削除")'),
      page.locator('button:has-text("Delete")'),
      page.locator('button:has-text("OK")'),
      page.locator('button:has-text("はい")'),
    ];

    await clickFirstVisible(confirmCandidates, { timeout: 5000, force: true });
    await page.waitForTimeout(1500);
  }
}

async function clickAddAlertToList(page) {
  await openWatchlistMenu(page);
  await clickMenuItem(page, /リストにアラートを追加|Add alert to list/i);
}

async function selectAlertCondition(page, conditionName) {
  const disclosureCandidates = [
    page.locator('[data-qa-id="main-series-select-title"]').first(),
    page.locator('[data-role="listbox"]').first(),
  ];

  await clickFirstVisible(disclosureCandidates, { timeout: 5000, force: true }).catch(() => {});
  await page.waitForTimeout(1000);

  const condition = page
    .locator('[role="option"]')
    .filter({ hasText: conditionName })
    .first();

  const visible = await condition.isVisible().catch(() => false);
  if (!visible) {
    await safeScreenshot(page, "alert_condition_not_found");
    throw new Error(`アラート条件が見つかりませんでした: ${conditionName}`);
  }

  await condition.click({ timeout: 5000, force: true });
  await page.waitForTimeout(1200);
}

async function selectAlertResolution(page, label) {
  const currentResCandidates = [
    page.locator('[data-qa-id="resolution-dropdown-item"]').filter({ hasText: label }),
    page.locator('[data-qa-id="resolution-dropdown-item"]'),
    page.locator('[data-is-popover-item-button="true"]').filter({ hasText: /時間|hour/i }),
  ];

  // まず dropdown を開く側を探す
  const openDropdownCandidates = [
    page.locator('[data-qa-id="resolution-dropdown-item"]').first(),
    page.locator('[data-is-popover-item-button="true"]').first(),
    page.locator('button').filter({ hasText: /時間|hour/i }).first(),
  ];

  await clickFirstVisible(openDropdownCandidates, { timeout: 5000, force: true }).catch(() => {});
  await page.waitForTimeout(800);

  const target = page
    .locator('[role="option"], [data-qa-id="resolution-dropdown-item"]')
    .filter({ hasText: label })
    .first();

  const visible = await target.isVisible().catch(() => false);
  if (!visible) {
    // すでに selected 済みの可能性あり
    const already = await currentResCandidates[0].first().isVisible().catch(() => false);
    if (already) return;
    await safeScreenshot(page, "alert_resolution_not_found");
    throw new Error(`時間足が見つかりませんでした: ${label}`);
  }

  await target.click({ timeout: 5000, force: true });
  await page.waitForTimeout(1200);
}

async function selectAlertSymbolsList(page, listName) {
  const disclosure = page.locator('[data-qa-id="ui-kit-disclosure-control main-symbols-select"]').first();
  const visible = await disclosure.isVisible().catch(() => false);

  if (!visible) {
    await safeScreenshot(page, "alert_symbols_disclosure_not_found");
    throw new Error("シンボル選択ボックスが見つかりませんでした");
  }

  // すでに期待値ならそのまま
  const currentLabel = await disclosure.textContent().catch(() => "");
  if (currentLabel && currentLabel.includes(listName)) {
    return;
  }

  await disclosure.click({ timeout: 5000, force: true });
  await page.waitForTimeout(1000);

  const option = page.locator('[role="option"]').filter({ hasText: new RegExp(`^${escapeRegex(listName)}$`) }).first();
  const optionVisible = await option.isVisible().catch(() => false);

  if (!optionVisible) {
    await safeScreenshot(page, `alert_symbols_option_not_found_${listName}`);
    throw new Error(`アラート対象リストが見つかりませんでした: ${listName}`);
  }

  await option.click({ timeout: 5000, force: true });
  await page.waitForTimeout(1200);

  const updated = await disclosure.textContent().catch(() => "");
  if (!updated.includes(listName)) {
    await safeScreenshot(page, `alert_symbols_not_applied_${listName}`);
    throw new Error(`アラート対象リストの反映確認に失敗しました: ${listName}`);
  }
}

async function submitAlertDialog(page) {
  const createCandidates = [
    page.getByRole("button", { name: /作成|Create|保存|Save|OK/i }),
    page.locator('button:has-text("作成")'),
    page.locator('button:has-text("Create")'),
    page.locator('button:has-text("保存")'),
    page.locator('button:has-text("Save")'),
    page.locator('button:has-text("OK")'),
  ];

  const ok = await clickFirstVisible(createCandidates, { timeout: 5000, force: true });
  if (!ok) {
    await safeScreenshot(page, "alert_submit_button_not_found");
    throw new Error("アラート作成ボタンが見つかりませんでした");
  }

  await page.waitForTimeout(2500);
}

async function createWatchlistAlertIfPossible(page, listName) {
  console.log("Creating alert for:", listName);

  // 対象ウォッチリストに切り替えてからメニュー経由で追加
  await switchWatchlistTo(page, listName);
  await clickAddAlertToList(page);

  await selectAlertCondition(page, ALERT_CONDITION_NAME);
  await selectAlertResolution(page, ALERT_TIMEFRAME_LABEL);
  await selectAlertSymbolsList(page, listName);

  await safeScreenshot(page, `before_alert_submit_${listName}`);
  await submitAlertDialog(page);
  await safeScreenshot(page, `after_alert_submit_${listName}`);
}

// ==============================
// Main
// ==============================
(async () => {
  let browser;
  let context;
  let page;

  try {
    reqEnv("BROWSERBASE_API_KEY", BROWSERBASE_API_KEY);
    reqEnv("BROWSERBASE_PROJECT_ID", BROWSERBASE_PROJECT_ID);
    reqEnv("TRADINGVIEW_STORAGE_STATE", TRADINGVIEW_STORAGE_STATE);
    reqEnv("WATCHLIST_1_URL", WATCHLIST_1_URL);
    reqEnv("WATCHLIST_2_URL", WATCHLIST_2_URL);

    ensureDir(WORKDIR);

    console.log("WATCHLIST_1_FINAL_NAME:", WATCHLIST_1_FINAL_NAME);
    console.log("WATCHLIST_2_FINAL_NAME:", WATCHLIST_2_FINAL_NAME);

    console.log("Downloading watchlists...");
    await downloadToFile(WATCHLIST_1_URL, OUT1);
    await downloadToFile(WATCHLIST_2_URL, OUT2);

    console.log("Starting Browserbase session...");
    const bb = new Browserbase({ apiKey: BROWSERBASE_API_KEY });
    const session = await bb.sessions.create({ projectId: BROWSERBASE_PROJECT_ID });

    browser = await chromium.connectOverCDP(session.connectUrl);

    const storageState = JSON.parse(TRADINGVIEW_STORAGE_STATE);
    context = await browser.newContext({ storageState });
    page = await context.newPage();

    page.setDefaultTimeout(STEP_TIMEOUT);
    page.setDefaultNavigationTimeout(NAV_TIMEOUT);

    console.log("Opening TradingView...");
    await page.goto("https://www.tradingview.com/chart/", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(5000);

    const maybeSignIn = await page.getByText(/Sign in|ログイン/i).first().isVisible().catch(() => false);
    if (maybeSignIn) {
      await safeScreenshot(page, "need_login");
      throw new Error("TradingView がログイン状態ではありません（storageState が無効または期限切れです）");
    }

    if (DO_DELETE_ALERTS) {
      console.log("Deleting old alerts...");
      await deleteManagedAlerts(page, [WATCHLIST_1_PREFIX, WATCHLIST_2_PREFIX]);
    }

    if (DO_DELETE_WATCHLISTS) {
      console.log("Deleting old watchlists...");
      await deleteManagedWatchlistsByPrefix(page, WATCHLIST_1_PREFIX);
      await deleteManagedWatchlistsByPrefix(page, WATCHLIST_2_PREFIX);
    }

    if (DO_IMPORT_WATCHLISTS) {
      console.log("Importing watchlists...");
      await importWatchlistFromFile(page, OUT1, WATCHLIST_1_FINAL_NAME);
      await importWatchlistFromFile(page, OUT2, WATCHLIST_2_FINAL_NAME);
    }

    if (DO_CREATE_WATCHLIST_ALERT) {
      console.log("Creating watchlist alerts...");
      await createWatchlistAlertIfPossible(page, WATCHLIST_1_FINAL_NAME);
      await createWatchlistAlertIfPossible(page, WATCHLIST_2_FINAL_NAME);
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
