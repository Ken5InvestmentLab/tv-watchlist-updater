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
async function openWatchlistPanel(page) {
  const candidates = [
    page.locator('button[aria-label="ウォッチリスト、詳細、ニュース"]'),
    page.locator('button[aria-label="Watchlist, details and news"]'),
    page.locator('button[data-tooltip="ウォッチリスト、詳細、ニュース"]'),
    page.locator('button[data-tooltip="Watchlist, details and news"]'),
  ];

  for (const c of candidates) {
    if (await safeClick(c, { timeout: 8000 })) {
      await page.waitForTimeout(1200);
      return;
    }
  }
  await safeScreenshot(page, "watchlist_panel_not_found");
  throw new Error("ウォッチリストパネルを開くボタンが見つかりませんでした");
}

async function ensureWatchlistPanelOpen(page) {
  const menuButton = page.locator('button[data-name="watchlists-button"]').first();
  if (await menuButton.isVisible().catch(() => false)) return;
  await openWatchlistPanel(page);
  await page.waitForTimeout(1200);
}

async function closeAnyMenu(page) {
  await page.keyboard.press("Escape").catch(() => {});
  await page.waitForTimeout(200);
  await page.keyboard.press("Escape").catch(() => {});
  await page.waitForTimeout(250);
}

async function getVisibleWatchlistMenuRoot(page) {
  // 正規表現を少し緩くして、表記揺れに対応
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
    await page.waitForTimeout(300);

    const ok = await safeClick(btn, { timeout: 8000, force: true });
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
  const root = (await getVisibleWatchlistMenuRoot(page)) ||
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
      const clickableAncestor = el.locator(
        'xpath=ancestor-or-self::*[@role="menuitem" or @data-role="menuitem" or self::button or @tabindex][1]'
      ).first();

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

// ==============================
// Delete watchlists
// ==============================
async function deleteManagedWatchlistsByPrefix(page, prefix) {
  console.log(`Deleting watchlists with prefix: ${prefix}`);

  await openListOpenDialog(page);

  for (let round = 0; round < 80; round++) {
    const titles = page.locator("div.title-ODL8WA9K");
    const count = await titles.count().catch(() => 0);

    let targetName = "";

    for (let i = 0; i < count; i++) {
      const text = (await titles.nth(i).textContent().catch(() => "")).trim();
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
    await safeClick(confirm, { timeout: 8000, force: true });
    await page.waitForTimeout(1200);
  }
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
async function openAlertsPanel(page) {
  const candidates = [
    page.locator('button[data-name="alerts"]'),
    page.locator('button[aria-label="アラート"]'),
    page.locator('button[data-tooltip="アラート"]'),
    page.locator('button[aria-label="Alerts"]'),
    page.locator('button[data-tooltip="Alerts"]'),
  ];
  for (const c of candidates) {
    if (await safeClick(c, { timeout: 8000 })) {
      await page.waitForTimeout(1200);
      return;
    }
  }
  await safeScreenshot(page, "alerts_panel_not_found");
  throw new Error("アラートボタンが見つかりませんでした");
}

async function deleteManagedAlerts(page, prefixes) {
  await openAlertsPanel(page);

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

    const del = page.locator('tr[data-role="menuitem"]').filter({ hasText: /^削除$|Delete/ }).first();
    const ok = await safeClick(del, { timeout: 8000, force: true });

    if (!ok) {
      console.log("Delete menu not found for this alert. skip:", targetText);
      await closeAnyMenu(page);
      return;
    }

    const confirm = page.getByRole("button", { name: /削除|Delete|はい|Yes|OK/i }).first();
    await safeClick(confirm, { timeout: 8000, force: true });
    await page.waitForTimeout(1200);
  }
}

async function clickAddAlertToList(page) {
  // "Add advanced alert to list" のような最近の表記変更にも対応
  const re = /リストに(高度な)?アラートを追加|Add( advanced)? alert( to list)?|アラートを追加/i;

  for (let i = 0; i < 16; i++) {
    await page.waitForTimeout(1200);

    const opened = await openWatchlistMenuHard(page, 6);
    if (!opened) continue;

    // 候補を大幅に増やして、どれかに引っかかるようにする
    const itemCandidates = [
      page.getByRole('menuitem', { name: re }).first(),
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
      
      // safeClick ではなく、すでにあるより強力な clickBestEffort を使う
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

  // ① 「条件（Condition）」のドロップダウンを開く
  // 新UIではデフォルトで「Price」または「価格」が選択されているため、そのテキストを狙ってクリックする
  const dropdownCandidates = [
    page.locator('[data-qa-id="main-series-select-title"]').first(),
    page.locator('span').filter({ hasText: /^Price$|^価格$/ }).first(),
    page.locator('div').filter({ hasText: /^Price$|^価格$/ }).last(),
    page.getByText(/^Condition$|^条件$/).locator('~ div').locator('[role="button"], [role="combobox"]').first()
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

  // 正規の候補で見つからなかった場合の強引なクリック
  if (!opened) {
    await clickBestEffort(page.getByText(/^Price$|^価格$/).first(), 4000);
  }
  
  await page.waitForTimeout(1000); // ドロップダウンが開くアニメーション待ち

  // ② リストからインジケーター（条件）を選択する
  // パラメータ部分「(20, 2...)」などがUI上で省略・変形されることがあるため、名前の先頭部分で部分一致させる
  const shortName = conditionName.split('(')[0].trim();
  console.log("Looking for option matching:", shortName);

  const optionCandidates = [
    page.locator('[role="option"]').filter({ hasText: conditionName }).first(),
    page.locator('[role="option"]').filter({ hasText: shortName }).first(),
    page.locator('span').filter({ hasText: shortName }).first(),
    page.getByText(shortName).first()
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
  console.log("Selecting alert resolution:", label);

  // ① 「チャートと同一」または「Same as chart」のドロップダウンを開く
  const dropdownCandidates = [
    // ユーザー指示通り「チャートと同一」あるいは英語の「Same as chart」を直接狙う
    page.locator('[role="button"], [role="combobox"]').filter({ hasText: /^チャートと同一$|^Same as chart$/ }).first(),
    page.locator('span').filter({ hasText: /^チャートと同一$|^Same as chart$/ }).first(),
    // 「Interval / 時間足」ラベルの横にあるボタンを狙う
    page.getByText(/^Interval$|^時間足$/).locator('~ div').locator('[role="button"], [role="combobox"]').first(),
    // 古いセレクタのフォールバック
    page.locator('[data-qa-id="resolution-dropdown-item"]').first()
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
    // 見つからなかった場合は強引にテキストクリックを試みる
    await clickBestEffort(page.getByText(/^チャートと同一$|^Same as chart$/).first(), 4000);
  }
  
  await page.waitForTimeout(1000); // ドロップダウンが開くアニメーション待ち

  // ② 時間足を選択する（日本語・英語両対応）
  // 環境変数から来る "4 時間" に加え、英語UIの "4 hours" にもマッチするようにする
  const re = new RegExp(`^${escapeRegex(label)}$|^4 hours$|^4 時間$`, "i");
  console.log("Looking for resolution option matching:", re);

  const optionCandidates = [
    page.locator('[role="option"]').filter({ hasText: re }).first(),
    page.locator('span').filter({ hasText: re }).first(),
    page.locator('div').filter({ hasText: re }).last()
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
    await safeScreenshot(page, "alert_resolution_not_found");
    throw new Error(`時間足が見つかりませんでした: ${label} (検索用正規表現: ${re})`);
  }
  await page.waitForTimeout(600);
}

async function selectAlertSymbolsList(page, listName) {
  const disclosure = page.locator('[data-qa-id="ui-kit-disclosure-control main-symbols-select"]').first();
  const visible = await disclosure.isVisible().catch(() => false);
  if (!visible) {
    await safeScreenshot(page, "alert_symbols_disclosure_not_found");
    throw new Error("シンボル選択ボックスが見つかりませんでした");
  }

  const cur = (await disclosure.textContent().catch(() => "")) || "";
  if (cur.includes(listName)) return;

  await disclosure.click({ force: true, timeout: 12000 });
  await page.waitForTimeout(700);

  const option = page.locator('[role="option"]').filter({ hasText: new RegExp(`^${escapeRegex(listName)}$`) }).first();
  const ok = await safeClick(option, { timeout: 20000, force: true });
  if (!ok) {
    await safeScreenshot(page, `alert_symbols_option_not_found_${listName}`);
    throw new Error(`アラート対象リストが見つかりませんでした: ${listName}`);
  }
  await page.waitForTimeout(700);
}

async function submitAlertDialog(page) {
  console.log("Submitting alert dialog...");

  // 「作成(Create)」ボタンを確実に見つけるために候補を複数用意
  const btnCandidates = [
    page.getByRole("button", { name: /作成|Create|保存|Save/i }),
    page.locator('[data-name="submit-button"]'),
    page.locator('button[type="submit"]')
  ];

  let targetBtn = null;

  for (const locator of btnCandidates) {
    const count = await locator.count().catch(() => 0);
    // ダイアログはDOM（HTML）の最後に追加されるため、後ろから探す（.last()と同等の処理）
    for (let i = count - 1; i >= 0; i--) { 
      const el = locator.nth(i);
      if (await el.isVisible().catch(() => false)) {
        targetBtn = el;
        break;
      }
    }
    if (targetBtn) break;
  }

  if (!targetBtn) {
    await safeScreenshot(page, "alert_submit_button_not_found");
    throw new Error("アラート作成ボタンが見つかりませんでした");
  }

  // 通常のクリックより強力な clickBestEffort を使用
  await clickBestEffort(targetBtn, 8000);
  console.log("Submit button clicked! Waiting for dialog to close...");

  // ダイアログが閉じるのを待機（閉じていなければ再クリックして押し込む）
  let dialogClosed = false;
  for (let i = 0; i < 5; i++) {
    await page.waitForTimeout(2000);
    const stillVisible = await targetBtn.isVisible().catch(() => false);
    if (!stillVisible) {
      dialogClosed = true;
      console.log("Dialog closed successfully.");
      break;
    }
    console.log("Dialog still visible, retrying click...");
    await clickBestEffort(targetBtn, 5000); // 空振りしていたらもう一度クリック
  }

  if (!dialogClosed) {
    console.log("Warning: Dialog might not have closed properly.");
    await safeScreenshot(page, "alert_submit_warning");
  }

  // トレビューのサーバーへ保存される通信の時間を長めに確保
  await page.waitForTimeout(4000);
}

async function createWatchlistAlertIfPossible(page, listName) {
  console.log("Creating alert for:", listName);

  // ①リスト切替
  await switchWatchlistTo(page, listName);

  // 追加：切替直後のUI安定待ち
  await page.waitForTimeout(4000);

  // ②必ず “メニューを開いてから” 「リストにアラートを追加…」を探す
  await clickAddAlertToList(page);

  // ③設定
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
      args: ["--no-sandbox", "--disable-dev-shm-usage"]
    });

    const storageState = JSON.parse(TRADINGVIEW_STORAGE_STATE);
    context = await browser.newContext({ storageState });
    page = await context.newPage();

    page.setDefaultTimeout(STEP_TIMEOUT);
    page.setDefaultNavigationTimeout(NAV_TIMEOUT);

    console.log("Opening TradingView...");
    await page.goto("https://www.tradingview.com/chart/", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(4000);

    const needLogin = await page.getByText(/Sign in|ログイン/i).first().isVisible().catch(() => false);
    if (needLogin) {
      await safeScreenshot(page, "need_login");
      throw new Error("TradingView がログイン状態ではありません（storageState が無効/期限切れの可能性）");
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
      for (const list of activeLists) {
        await importWatchlistFromFile(page, list.path, list.finalName);
      }
    }

    if (DO_CREATE_WATCHLIST_ALERT) {
      console.log("Creating watchlist alerts...");
      for (const list of activeLists) {
        await createWatchlistAlertIfPossible(page, list.finalName);
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
