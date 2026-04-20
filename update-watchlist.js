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

const ALERT_SLOT_RELEASE_WAIT_MS = Number(process.env.ALERT_SLOT_RELEASE_WAIT_MS || 30000);
const WATCHLIST_PROMO_RETRY_MAX = Number(process.env.WATCHLIST_PROMO_RETRY_MAX || 6);
const WATCHLIST_PROMO_RETRY_WAIT_MS = Number(process.env.WATCHLIST_PROMO_RETRY_WAIT_MS || 30000);

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
    await page.screenshot({ path: p });
    console.log("Saved screenshot:", p);
  } catch (e) {
    console.log("Screenshot failed:", e?.message || e);
  }
}

async function safeClick(locator, options = {}) {
  try {
    const el = locator.first();
    await el.waitFor({ state: "visible", timeout: options.timeout || STEP_TIMEOUT });
    await el.scrollIntoViewIfNeeded().catch(() => { });
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

async function findVisibleDeleteButtonWithin(scope, page = null) {
  const deleteBtnSelectors = [
    'button[data-name="remove-button"]',
    'button[data-name="delete-button"]',
    'button[data-qa-id="remove-button"]',
    '[data-qa-id="remove-button"]',
    '[data-name="remove-button"]',
    '[data-name="remove"]',
    '[data-name="delete"]',
    'button[aria-label*="削除"]',
    'button[aria-label*="Delete"]',
    'button[aria-label*="Remove"]',
    '[aria-label*="削除"]',
    '[aria-label*="Delete"]',
    '[aria-label*="Remove"]',
    '[class*="remove"]',
    '[class*="delete"]',
    'button:has([data-name*="trash"])',
    'button:has([class*="trash"])',
    'svg[class*="remove"]',
  ];

  for (const sel of deleteBtnSelectors) {
    const btn = scope.locator(sel).first();
    if (await btn.isVisible().catch(() => false)) return btn;
  }

  // scope に見つからない場合、親に近い階層でその行に紐づくかもしれない要素だけを限定的に探す
  // 以前の全体(page)からの取得は関係ないアラート削除ボタン等を拾うため削除
  return null;
}

// ==============================
// Base UI: Watchlist panel / menu (UI変更に強い版)
// ==============================

async function getWatchlistButton(page) {
  // 1. data-name 属性（最も信頼できる - パネルが開いているときのみ表示）
  const dataNameBtn = page.locator('button[data-name="watchlists-button"]').first();
  if (await dataNameBtn.isVisible().catch(() => false)) return dataNameBtn;

  // 2. ロール + テキスト
  const roleBtn = page.getByRole('button', { name: /ウォッチリスト|Watchlist/i }).first();
  if (await roleBtn.isVisible().catch(() => false)) return roleBtn;

  // 3. aria-label や title (部分一致)
  const attrBtn = page.locator('button[aria-label*="ウォッチリスト"], button[aria-label*="Watchlist"], button[title*="ウォッチリスト"], button[title*="Watchlist"]').first();
  if (await attrBtn.isVisible().catch(() => false)) return attrBtn;

  // 4. data-tooltip (部分一致)
  const tooltipBtn = page.locator('button[data-tooltip*="ウォッチリスト"], button[data-tooltip*="Watchlist"]').first();
  if (await tooltipBtn.isVisible().catch(() => false)) return tooltipBtn;

  // 5. 部分クラス名
  const classBtn = page.locator('button[class*="watchlist"], button[class*="Watchlist"]').first();
  if (await classBtn.isVisible().catch(() => false)) return classBtn;

  // SVG フォールバックは廃止（マッチが広すぎてランダムなボタンを返すリスクがある）

  return null;
}

// ウォッチリストパネルのサイドバートグルボタンを取得（パネル開閉専用）
async function getWatchlistToggleButton(page) {
  const candidates = [
    // aria-label 部分一致（日本語・英語）
    page.locator('button[aria-label*="ウォッチリスト"]').first(),
    page.locator('button[aria-label*="Watchlist"]').first(),
    // data-tooltip 部分一致
    page.locator('button[data-tooltip*="ウォッチリスト"]').first(),
    page.locator('button[data-tooltip*="Watchlist"]').first(),
    // title 部分一致
    page.locator('button[title*="ウォッチリスト"]').first(),
    page.locator('button[title*="Watchlist"]').first(),
    // data-name による推測（TradingView UIバリエーション）
    page.locator('[data-name*="watchlist"]:not([data-name="watchlists-button"])').first(),
    // ロール + テキスト
    page.getByRole('button', { name: /ウォッチリスト|Watchlist/i }).first(),
  ];

  for (const c of candidates) {
    if (await c.isVisible().catch(() => false)) return c;
  }
  return null;
}

async function waitForMenuOpen(page, timeout = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    // 既存のチェック
    const menu = await getVisibleWatchlistMenuRoot(page);
    if (menu) return menu;

    // 新たに追加：任意の絶対位置にある div で、メニューらしいテキストを含むもの
    const anyFloat = page.locator('body > div:not([style*="display: none"])').filter({ hasText: /リストにアラート|Open list|Upload list/i }).first();
    if (await anyFloat.isVisible().catch(() => false)) return anyFloat;

    await page.waitForTimeout(300);
  }
  return null;
}

async function findMenuItemByRole(page, nameRegex) {
  // role="menuitem" かつテキストが一致
  const item = page.getByRole('menuitem', { name: nameRegex }).first();
  if (await item.isVisible().catch(() => false)) return item;

  // フォールバック: 任意のロール + テキスト
  const anyRole = page.locator('[role="menuitem"], [role="option"], [role="row"]').filter({ hasText: nameRegex }).first();
  if (await anyRole.isVisible().catch(() => false)) return anyRole;

  return null;
}

async function handleUnexpectedDialogs(page) {
  // Change interval ダイアログ
  if (await isChangeIntervalDialogOpen(page)) {
    await fill4HInChangeIntervalDialog(page);
    return true;
  }
  // オファー / フラッシュセール ポップアップ
  if (await isOfferPopupVisible(page)) {
    await closeOfferPopup(page);
    return true;
  }
  // ウォッチリストのプロモーション
  if (await isWatchlistPromoDialogVisible(page)) {
    await closeWatchlistPromoDialog(page);
    return true;
  }
  // その他「OK」だけで閉じるエラーダイアログ
  const errorOk = page.getByRole('button', { name: /OK|閉じる|Close/i }).first();
  if (await errorOk.isVisible().catch(() => false)) {
    await errorOk.click();
    return true;
  }
  return false;
}

async function debugDump(page, label) {
  const dump = {
    label,
    url: page.url(),
    buttons: await page.locator('button').evaluateAll(btns => btns.slice(0, 20).map(b => ({
      text: b.innerText?.slice(0, 50),
      ariaLabel: b.getAttribute('aria-label'),
      role: b.getAttribute('role'),
      visible: b.offsetParent !== null
    }))),
    watchlistButton: await getWatchlistButton(page) ? 'exists' : 'missing'
  };
  fs.writeFileSync(path.join(WORKDIR, `debug_${label}.json`), JSON.stringify(dump, null, 2));
}

async function getWatchlistMenuTrigger(page) {
  const watchlistBtn = await getWatchlistButton(page);
  if (!watchlistBtn) return null;

  // 1. 現在のウォッチリスト名のテキストをクリック（最も安定）
  const currentName = await getCurrentWatchlistTitle(page);
  if (currentName) {
    const nameElement = watchlistBtn.locator(`text=${currentName}`).first();
    if (await nameElement.isVisible().catch(() => false)) {
      console.log(`[trigger] using watchlist name text: "${currentName}"`);
      return nameElement;
    }
  }

  // 2. 従来の矢印探索
  const arrowSelectors = [
    '[class*="arrow"]',
    'svg',
    'span[role="img"]',
    'text=/[▼⌄↓]/',
    '> :last-child',
  ];
  for (const sel of arrowSelectors) {
    const el = watchlistBtn.locator(sel).first();
    if (await el.count().catch(() => 0) && await el.isVisible().catch(() => false)) {
      console.log(`[trigger] using arrow selector: ${sel}`);
      return el;
    }
  }

  // 3. ボタン内の全ての可視子要素を順に試す（最終手段）
  const allChildren = watchlistBtn.locator('*');
  const childCount = Math.min(await allChildren.count().catch(() => 0), 30);
  for (let i = 0; i < childCount; i++) {
    const child = allChildren.nth(i);
    if (await child.isVisible().catch(() => false)) {
      console.log(`[trigger] using child element #${i}`);
      return child;
    }
  }

  // 4. どうしてもダメならボタン全体
  console.log(`[trigger] falling back to whole button`);
  return watchlistBtn;
}

async function getCurrentWatchlistTitle(page) {
  const btn = await getWatchlistButton(page);
  if (!btn) return "";

  // aria-label から抽出
  const ariaLabel = await btn.getAttribute('aria-label');
  if (ariaLabel) {
    const match = ariaLabel.match(/(w[al]?[12]?_\d{8}_\d{4})/);
    if (match) return match[1];
  }

  // ボタン内の特定クラス
  const nameSelectors = [
    '[class*="watchlistName"]',
    '[class*="name"]',
    '[data-role="watchlist-name"]',
    'span[class*="title"]'
  ];
  for (const sel of nameSelectors) {
    const el = btn.locator(sel).first();
    if (await el.isVisible().catch(() => false)) {
      const text = await el.textContent();
      if (text && text.trim()) {
        const match = text.trim().match(/(w[al]?[12]?_\d{8}_\d{4})/);
        if (match) return match[1];
        return text.trim();
      }
    }
  }

  // ボタン全体のテキストから抽出
  const fullText = await btn.evaluate(el => el.innerText || el.textContent || "");
  const match = fullText.match(/(w[al]?[12]?_\d{8}_\d{4})/);
  if (match) return match[1];

  // 従来のトークン分割（フォールバック）
  const tokens = fullText.split(/\s+/).filter(t => t && !t.match(/[▼⌄↓▶›»]/));
  return tokens[0] || "";
}

// パネルが開いているか（複数の方法で判定）
async function isWatchlistPanelReady(page) {
  // 方法1: パネル内のドロップダウンボタン（最も確実）
  const dropdownBtn = page.locator('button[data-name="watchlists-button"]').first();
  if (await dropdownBtn.isVisible().catch(() => false)) return true;

  // 方法2: サイドバートグルボタンの aria-pressed 属性
  const toggleBtn = await getWatchlistToggleButton(page);
  if (toggleBtn) {
    const pressed = await toggleBtn.getAttribute('aria-pressed');
    if (pressed === 'true') return true;
  }

  // 方法3: パネル内の具体的な要素（より特定性の高いセレクタを優先）
  const panelIndicators = [
    'div[data-name="watchlist-list"]',
    'div[data-role="list"]',
    '[data-widget-type="watchlist"]',
    '[data-name="watchlist-widget"]',
    '[role="tabpanel"]',
  ];

  for (const sel of panelIndicators) {
    if (await page.locator(sel).first().isVisible().catch(() => false)) {
      return true;
    }
  }

  return false;
}

// ウォッチリストパネルを開く（閉じている場合のみ）
async function openWatchlistPanel(page) {
  if (await isWatchlistPanelReady(page)) return;

  // パネル開閉専用のトグルボタンを使用（パネル内のドロップダウンと混同しない）
  const toggleBtn = await getWatchlistToggleButton(page);
  if (!toggleBtn) {
    await safeScreenshot(page, "watchlist_button_not_found");
    throw new Error("ウォッチリストパネルのトグルボタンが見つかりません");
  }

  await toggleBtn.click({ force: true });
  await page.waitForTimeout(1000);

  // ポーリングでパネルの表示を確認（最大8秒）
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (await isWatchlistPanelReady(page)) return;
    await page.waitForTimeout(400);
  }

  throw new Error("ウォッチリストパネルが開きませんでした");
}

async function ensureWatchlistPanelOpen(page) {
  for (let attempt = 0; attempt < 3; attempt++) {
    await handleUnexpectedDialogs(page);
    if (await isWatchlistPanelReady(page)) return;

    // 余計なメニューを閉じてからリトライ
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);

    await openWatchlistPanel(page);

    if (await isWatchlistPanelReady(page)) return;

    console.log(`パネルオープンリトライ ${attempt + 1}/3`);
  }

  await safeScreenshot(page, "watchlist_panel_not_open");
  throw new Error("ウォッチリストパネルを開けませんでした");
}

// ページ準備完了待機（複数セレクタで待つ）
async function waitForTradingViewReady(page) {
  const selectors = [
    'button[aria-label*="ウォッチリスト"]',
    'button[aria-label*="Watchlist"]',
    '[data-name="chart"]',
    'canvas',
  ];

  let found = false;
  for (const sel of selectors) {
    if (await page.locator(sel).first().isVisible({ timeout: 5000 }).catch(() => false)) {
      found = true;
      break;
    }
  }

  if (!found) {
    await safeScreenshot(page, "tradingview_not_ready");
    throw new Error("TradingViewのUIが読み込まれませんでした");
  }

  // ウォッチリストのトグルボタンが表示されるのを待つ（サイドバーボタン）
  const toggleBtn = await getWatchlistToggleButton(page);
  if (!toggleBtn) {
    await safeScreenshot(page, "watchlist_button_missing");
    throw new Error("ウォッチリストボタンが見つかりません（タイムアウト）");
  }

  await page.waitForTimeout(2000);
}

async function clickBestEffort(locator, timeout = 8000) {
  try {
    await locator.scrollIntoViewIfNeeded().catch(() => { });
    await locator.click({ force: true, timeout });
    return true;
  } catch { }
  try {
    await locator.dispatchEvent('click');
    return true;
  } catch { }
  try {
    // ネイティブな mousedown + mouseup を発火
    await locator.evaluate(el => {
      const evtDown = new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window });
      const evtUp = new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window });
      el.dispatchEvent(evtDown);
      el.dispatchEvent(evtUp);
      el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    });
    return true;
  } catch { }
  return false;
}

async function closeAnyMenu(page) {
  await page.keyboard.press("Escape").catch(() => { });
  await page.waitForTimeout(200);
  await page.keyboard.press("Escape").catch(() => { });
  await page.waitForTimeout(250);
}

async function getVisibleWatchlistMenuRoot(page) {
  const menuKeywords = /リストに(高度な)?アラートを追加|リストを開く|リストをアップロード|Open list|Upload list|Add( advanced)? alert/i;

  const selectors = [
    '[role="menu"]',
    '[role="listbox"]',
    'div[data-name="menu-inner"]',
    'div[class*="menu"]',
    'div[class*="dropdown"]',
    'div[class*="popup"]',
  ];

  for (const sel of selectors) {
    const roots = page.locator(sel);
    const count = await roots.count();
    for (let i = 0; i < count; i++) {
      const root = roots.nth(i);
      if (!(await root.isVisible())) continue;
      const text = await root.textContent();
      if (menuKeywords.test(text)) return root;
      // メニュー項目が2つ以上あるか
      const itemCount = await root.locator('[role="menuitem"], [data-role="menuitem"]').count();
      if (itemCount >= 2) return root;
    }
  }
  return null;
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
  // まず role ベースで探す
  let item = await findMenuItemByRole(page, re);
  if (!item) {
    // 従来の findMenuItemByText をフォールバック
    item = await findMenuItemByText(page, re);
  }
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
  // ダイアログ固有のクローズボタンで判定（サイドバーの list-item と混同しないため）
  const dialogClose = page.locator('button[data-qa-id="close"]').first();
  if (await dialogClose.isVisible().catch(() => false)) return;

  const opened = await openWatchlistMenuHard(page, 8);
  if (!opened) throw new Error("ウォッチリストメニューが開けませんでした");

  await clickMenuItemByText(page, /リストを開く|Open list/i);
  await page.waitForTimeout(1200);

  const listAnyRow = page.locator('div[data-role="list-item"]').first();
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

async function getWatchlistNameElement(page, listName) {
  const btn = await getWatchlistButton(page);
  if (!btn) return null;

  // ボタン内のすべての要素から、テキストが listName と一致するものを探す（部分一致でも可）
  const allElements = btn.locator('*');
  const count = await allElements.count();
  for (let i = 0; i < count; i++) {
    const el = allElements.nth(i);
    const text = await el.textContent();
    if (text && text.trim() === listName) {
      return el;
    }
  }
  // 見つからなければ、テキストを含む任意の要素を返す（フォールバック）
  return btn.locator(`:has-text("${listName}")`).first();
}

async function switchWatchlistTo(page, listName) {
  console.log("Switching watchlist to:", listName);

  await handleUnexpectedDialogs(page);

  // 既に目的のリストか確認
  const current = await getCurrentWatchlistTitle(page);
  if (current === listName) {
    console.log(`Already on watchlist: ${listName}`);
    return;
  }

  // リスト一覧を開く（新しいUIではメニュー内に直接表示）
  await openListOpenDialog(page);

  // リスト一覧の中から目的のリストをクリック
  const selectors = [
    `div[data-role="list-item"][data-title="${listName}"]`,
    `[role="menuitem"]:has-text("${listName}")`,
    `[data-qa-id="menu-inner"] [class*="item-"]:has-text("${listName}")`,
    `div[data-role="list-item"]:has-text("${listName}")`
  ];

  let row = null;
  for (const sel of selectors) {
    const r = page.locator(sel).first();
    if (await r.isVisible().catch(() => false)) {
      row = r;
      break;
    }
  }

  if (!row) {
    await safeScreenshot(page, `watchlist_not_found_in_list_${listName}`);
    throw new Error(`リスト一覧に "${listName}" が見つかりません`);
  }

  await row.click({ force: true, timeout: 8000 });

  // ダイアログやメニューを閉じる
  await closeOpenListDialogIfVisible(page).catch(() => { });
  await closeAnyMenu(page);
  await page.waitForTimeout(1500);

  // 切り替え確認（最大20秒）
  let ok = false;
  for (let i = 0; i < 20; i++) {
    const cur = await getCurrentWatchlistTitle(page);
    console.log(`[switch] current="${cur}", target="${listName}"`);
    if (cur === listName || cur.includes(listName)) {
      ok = true;
      console.log("Watchlist switched successfully:", cur);
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

  await closeOpenListDialogIfVisible(page).catch(() => { });
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
  console.log(`[delete] "${prefix}" で始まるウォッチリストを削除します...`);

  for (let round = 0; round < 80; round++) {
    // 毎ラウンド、ダイアログを閉じてから「メニュー → リストを開く」手順で再オープン
    // （削除後に TradingView が管理対象リストをアクティブにするため、
    //   毎回の再オープンで非管理対象へ切り替えてからゴミ箱を出す必要がある）
    await closeOpenListDialogIfVisible(page).catch(() => {});
    await openListOpenDialog(page);

    const rows = page.locator('div[data-role="list-item"][data-title]');
    const count = await rows.count().catch(() => 0);
    console.log(`[delete] Dialog rows found (round ${round}): ${count}`);

    // 削除対象の有無と、切り替え先となる非管理対象ウォッチリスト名を収集
    let targetFound = false;
    let nonManagedTitle = null;

    for (let i = 0; i < count; i++) {
      const row = rows.nth(i);
      const dataTitle = ((await row.getAttribute("data-title").catch(() => "")) || "").trim();
      if (!dataTitle) continue;

      if (isManagedListName(dataTitle, prefix)) {
        targetFound = true;
      } else if (!nonManagedTitle) {
        nonManagedTitle = dataTitle;
      }
    }

    if (!targetFound) {
      console.log(`[delete] 対象なし: "${prefix}"`);
      await closeOpenListDialogIfVisible(page).catch(() => {});
      await closeAnyMenu(page);
      return;
    }

    if (!nonManagedTitle) {
      // 非管理対象がない = 管理対象しか存在しない（最後の1つは TradingView が削除を許可しない）
      console.log(`[delete] 警告: 非管理対象ウォッチリストが見つからないため "${prefix}" の削除をスキップします。`);
      await closeOpenListDialogIfVisible(page).catch(() => {});
      await closeAnyMenu(page);
      return;
    }

    // ダイアログを閉じてから switchWatchlistTo で確実に非管理対象へ切り替える。
    // （ダイアログが開いたままのクリックでは active が変わらない場合があるため）
    await closeOpenListDialogIfVisible(page).catch(() => {});
    await closeAnyMenu(page);

    const currentTitle = await getCurrentWatchlistTitle(page).catch(() => "");
    if (currentTitle !== nonManagedTitle) {
      console.log(`[delete] "${nonManagedTitle}" に切り替えて管理対象をアクティブ解除...`);
      await switchWatchlistTo(page, nonManagedTitle);
    } else {
      console.log(`[delete] "${nonManagedTitle}" は既にアクティブ。`);
    }

    // ダイアログを再オープン（管理対象が非アクティブ → ゴミ箱アイコンが表示される）
    await openListOpenDialog(page);

    // ダイアログ内の行を再取得して削除対象を探す
    const rows2 = page.locator('div[data-role="list-item"][data-title]');
    const count2 = await rows2.count().catch(() => 0);

    let deleted = false;
    for (let i = 0; i < count2; i++) {
      const row = rows2.nth(i);
      const dataTitle = ((await row.getAttribute("data-title").catch(() => "")) || "").trim();
      if (!isManagedListName(dataTitle, prefix)) continue;

      console.log(`[delete] "${dataTitle}" を削除中... (row index ${i})`);

      await row.scrollIntoViewIfNeeded().catch(() => {});
      await row.hover({ force: true }).catch(() => {});
      await page.waitForTimeout(800);

      const deleteBtn = await findVisibleDeleteButtonWithin(row);
      if (!deleteBtn) {
        console.log(`[delete] row ${i} に削除ボタンなし。次の行を試します...`);
        continue;
      }

      await deleteBtn.click({ force: true });
      await page.waitForTimeout(500);
      await confirmTradingViewDialog(page);
      await page.waitForTimeout(1200);
      deleted = true;
      break;
    }

    if (!deleted) {
      await safeScreenshot(page, `delete_btn_not_found_${prefix}`);
      throw new Error(`削除ボタン（ゴミ箱）が全行で見つかりませんでした: ${prefix}`);
    }
  }

  throw new Error(`削除ループが上限に達しました: ${prefix}`);
}

async function confirmTradingViewDialog(page) {
  console.log("[dialog] 確認ダイアログを待機中...");

  // 最大 5 秒間、ダイアログの出現を待つ
  let dialog = null;
  for (let i = 0; i < 10; i++) {
    const candidates = [
      page.locator('[role="dialog"]:has-text("Delete this watchlist")'),
      page.locator('[role="dialog"]:has-text("ウォッチリストを削除")'),
      page.locator('[role="dialog"]:has-text("permanently delete")'),
      page.locator('[data-qa-id="yes-btn"]').locator('xpath=ancestor::*[@role="dialog"][1]'),
      page.locator('button[data-qa-id="yes-btn"]').locator('xpath=ancestor::div[contains(@class,"dialog")][1]'),
    ];

    for (const sel of candidates) {
      const d = sel.first();
      if (await d.isVisible().catch(() => false)) {
        dialog = d;
        break;
      }
    }
    if (dialog) break;
    await page.waitForTimeout(500);
  }

  if (!dialog) {
    console.log("[dialog] 確認ダイアログが見つかりませんでした（既に閉じているか不要）");
    return;
  }

  // 確認ボタンを探す (優先順位付き)
  const confirmSelectors = [
    dialog.locator('button[data-qa-id="yes-btn"]'),
    dialog.locator('button:has-text("Delete")'),
    dialog.locator('button:has-text("削除")'),
    dialog.locator('button:has-text("Yes")'),
    dialog.locator('button[data-name="yes"]'),
    dialog.locator('button.red-D4RPB3ZC'), // クラス名の一部を指定
  ];

  let clicked = false;
  for (const btnLocator of confirmSelectors) {
    const btn = btnLocator.first();
    if (await btn.isVisible().catch(() => false)) {
      await btn.click({ force: true });
      console.log("[dialog] 削除を承認しました。");
      clicked = true;
      break;
    }
  }

  if (!clicked) {
    // デバッグ用にダイアログ内のボタンを出力
    const allButtons = await dialog.locator('button').all();
    const buttonTexts = await Promise.all(allButtons.map(async (b) => {
      return {
        text: await b.textContent().catch(() => ''),
        dataQa: await b.getAttribute('data-qa-id').catch(() => ''),
        className: await b.getAttribute('class').catch(() => ''),
      };
    }));
    console.log("[dialog] ボタン一覧:", JSON.stringify(buttonTexts, null, 2));
    console.warn("[dialog] 確認ボタンが見つかりません。Esc で閉じます。");
    await page.keyboard.press("Escape");
  }

  // ダイアログが消えるのを少し待つ
  await page.waitForTimeout(1000);
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

  await closeOpenListDialogIfVisible(page).catch(() => { });
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
    'button[data-name="alerts"]',
    'button[data-name="alerts-button"]',
    'button[data-name="alerts-widget-button"]',
    'button[data-qa-id="alerts-button"]',
    '[role="button"][data-name="alerts"]',

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

async function closeCreateAlertDialogIfVisible(page) {
  const title = page.getByText(/Create alert on|アラートを作成/i).first();
  const visible = await title.isVisible().catch(() => false);
  if (!visible) return false;

  const closeBtn = page.locator('[role="dialog"] button[aria-label="Close"], [role="dialog"] button[aria-label="閉じる"]').first();
  if (await closeBtn.isVisible().catch(() => false)) {
    await clickBestEffort(closeBtn, 4000);
    await page.waitForTimeout(600);
    return true;
  }

  await page.keyboard.press("Escape").catch(() => { });
  await page.waitForTimeout(600);
  return true;
}

async function isAlertsContentReady(page) {
  const markers = [
    page.locator('[data-name="alert-item-ticker"]').first(),
    page.locator('[data-name="alerts-manager"]').first(),
    page.locator('[data-name="alerts-list"]').first(),
    page.locator('[data-qa-id="alerts-list"]').first(),
    page.locator('[data-name="alerts-list-wrapper"], [data-qa-id="alerts-list-wrapper"]').first(),
    page.locator('[data-name="alert-item"], [data-role="alert-item"], [data-qa-id*="alert-item"]').first(),
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
    await closeCreateAlertDialogIfVisible(page);

    const toggle = await findAlertsPanelToggle(page);
    if (toggle) {
      const meta = await describeLocator(toggle);
      if (meta) {
        console.log("alerts toggle candidate:", JSON.stringify(meta));
      }

      const clicked = await clickBestEffort(toggle, 8000);
      if (clicked) {
        await page.waitForTimeout(1500);
        await closeCreateAlertDialogIfVisible(page);
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
      await page.waitForLoadState("networkidle").catch(() => { });
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

    // 「Log」タブを掴んでしまうケース対策：毎回 Alerts タブを明示的に押す
    const forceAlertsTabCandidates = [
      page.locator('[role="tab"]').filter({ hasText: /^Alerts$|^アラート$/i }).first(),
      page.locator('button').filter({ hasText: /^Alerts$|^アラート$/i }).first(),
      page.locator('[data-name*="alert"][role="tab"]').filter({ hasText: /Alerts|アラート/i }).first(),
    ];
    for (const tab of forceAlertsTabCandidates) {
      if (await tab.isVisible().catch(() => false)) {
        await safeClick(tab, { timeout: 4000, force: true });
        await page.waitForTimeout(500);
        break;
      }
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

  const rows = await getVisibleAlertRows(page);
  const arr = [];
  for (const row of rows) {
    const txt = await getAlertTickerFromRow(row);
    if (txt) arr.push(txt);
  }

  console.log("Detected alert ticker count:", arr.length);
  return arr;
}

async function getVisibleAlertRows(page) {
  const rowSelectors = [
    '[data-name="alert-item"]',
    '[data-role="alert-item"]',
    '[data-qa-id*="alert-item"]',
    '[data-name*="alert-row"]',
    '[class*="alertItem"]',
    '[class*="alert-row"]',
    '[class*="itemRow"]',
    '[class*="itemRow"][class*="alert"]',
  ];

  for (const sel of rowSelectors) {
    const rows = page.locator(sel);
    const count = Math.min(await rows.count().catch(() => 0), 300);
    if (!count) continue;

    const visible = [];
    for (let i = 0; i < count; i++) {
      const row = rows.nth(i);
      if (await row.isVisible().catch(() => false)) visible.push(row);
    }
    if (visible.length > 0) return visible;
  }

  const tickerItems = page.locator('[data-name="alert-item-ticker"], [data-qa-id*="alert-item-ticker"]');
  const tickerCount = Math.min(await tickerItems.count().catch(() => 0), 300);
  const tickerRows = [];
  for (let i = 0; i < tickerCount; i++) {
    const row = tickerItems.nth(i).locator(
      'xpath=ancestor::*[@data-name="alert-item" or @data-role="alert-item" or contains(@class,"alert")][1]'
    ).first();
    if (await row.isVisible().catch(() => false)) tickerRows.push(row);
  }
  return tickerRows;
}

async function getAlertActionRow(row) {
  const candidates = [
    row.locator('xpath=ancestor-or-self::*[@data-name="alerts-log-item" or @data-name="alert-item" or @data-role="alert-item"][1]').first(),
    row.locator('xpath=ancestor-or-self::*[contains(@class,"itemRow") or contains(@class,"alert-row")][1]').first(),
    row,
  ];

  for (const c of candidates) {
    if (await c.isVisible().catch(() => false)) return c;
  }

  return row;
}


async function getAlertTickerFromRow(row) {
  const directTicker = row.locator('[data-name="alert-item-ticker"], [data-qa-id*="alert-item-ticker"]').first();
  if (await directTicker.isVisible().catch(() => false)) {
    return ((await directTicker.textContent().catch(() => "")) || "").trim();
  }
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
    const currentAlerts = await getManagedAlertTickerTexts(page, prefixes);
    if (currentAlerts.length === 0) {
      console.log("No more managed alerts.");
      return;
    }
    const targetText = currentAlerts[0];
    console.log(`Deleting alert: ${targetText}`);

    // 対象行を再取得
    const rows = await getVisibleAlertRows(page);
    let targetRow = null;
    for (const row of rows) {
      const txt = await getAlertTickerFromRow(row);
      if (txt === targetText) {
        targetRow = row;
        break;
      }
    }
    if (!targetRow) {
      console.warn(`Target alert row not found visually: ${targetText}, retrying...`);
      await page.waitForTimeout(1000);
      continue;
    }

    // 行の要素ハンドルを取得
    const rowHandle = await targetRow.elementHandle();
    if (!rowHandle) continue;

    // 1. 強制的に削除ボタンを探してクリック（DOM 直接操作）
    const deleted = await page.evaluate((row) => {
      // 行内の削除ボタンを探す（非表示でも DOM に存在する場合がある）
      const selectors = [
        '[data-name="alert-delete-button"]',
        'button[aria-label="Delete alert"]',
        'button[aria-label="Delete"]',
        'button[aria-label="削除"]',
        'button[data-name="remove-button"]',
        'button[data-qa-id="remove-button"]',
        'button[class*="delete"]',
        'button[class*="remove"]',
        'button[class*="trash"]',
      ];
      for (const sel of selectors) {
        const btn = row.querySelector(sel);
        if (btn && typeof btn.click === 'function') {
          btn.click();
          return true;
        }
      }
      // ホバーを強制的に発火させてボタンを出現させる
      row.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
      row.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      // 少し待ってから再度探索
      return new Promise(resolve => {
        setTimeout(() => {
          for (const sel of selectors) {
            const btn = row.querySelector(sel);
            if (btn && typeof btn.click === 'function') {
              btn.click();
              resolve(true);
              return;
            }
          }
          resolve(false);
        }, 500);
      });
    }, rowHandle);

    if (deleted) {
      console.log("✅ 削除ボタンを直接クリックしました");
      await page.waitForTimeout(1500);
      await confirmTradingViewDialog(page).catch(() => {});
    } else {
      console.log("⚠️ 削除ボタンが見つからないため、右クリックメニューを強制表示します");

      // 行のホバーを強制して、中のDOM要素（ボタン等）をデバッグ出力する
      await targetRow.hover({ force: true });
      await page.waitForTimeout(500);
      const rowDump = await page.evaluate((row) => {
        const btns = Array.from(row.querySelectorAll('button, [role="button"], svg, div[class*="icon"], div[class*="button"]'));
        return btns.map(b => {
          const cls = typeof b.className === 'string' ? b.className : String(b.getAttribute('class') || '');
          return {
            tag: b.tagName,
            className: cls,
            ariaLabel: b.getAttribute('aria-label'),
            dataName: b.getAttribute('data-name'),
            text: b.textContent.trim()
          };
        }).filter(x => x.ariaLabel || x.dataName || x.text || x.className.includes('icon') || x.className.includes('remove') || x.className.includes('close') || x.className.includes('button'));
      }, rowHandle);
      console.log("🛠️ [デバッグ] 行内のアイコン類:", JSON.stringify(rowDump, null, 2));

      // 2. 右クリックメニューを強制表示（座標指定）
      const box = await targetRow.boundingBox();
      if (box) {
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: 'right' });
        await page.waitForTimeout(800);

        // 新しいLocatorでの削除項目探し
        const delMenuItem = page.locator([
          '[role="menuitem"]:has-text("削除")',
          '[role="menuitem"]:has-text("Delete")',
          '[role="menuitem"]:has-text("Remove")',
          '[data-role="menuitem"]:has-text("削除")',
          '[data-role="menuitem"]:has-text("Delete")',
          '[data-role="menuitem"]:has-text("Remove")',
          'div[class*="item"]:has-text("削除")',
          'div[class*="item"]:has-text("Delete")',
          'div[class*="item"]:has-text("Remove")'
        ].join(', ')).first();

        let menuDeleted = false;

        if (await delMenuItem.isVisible().catch(() => false)) {
          await delMenuItem.click({ force: true });
          menuDeleted = true;
          console.log("✅ 右クリックメニューから削除しました (Playwright)");
        } else {
          // Playwrightでダメなら現状のメニュー画面をデバッグ出力
          const menuDump = await page.evaluate(() => {
            const allItems = Array.from(document.querySelectorAll('[role="menuitem"], [data-role="menuitem"], div[class*="menu"] div[class*="item"]'));
            return allItems.map(m => ({
              text: m.textContent.trim(),
              className: m.className,
              dataName: m.getAttribute("data-name"),
              html: m.innerHTML
            }));
          });
          console.log("🛠️ [デバッグ] メニュー項目ダンプ:", JSON.stringify(menuDump, null, 2));

          menuDeleted = await page.evaluate(() => {
            const menu = document.querySelector('[data-role="menu"], [role="menu"]');
            const items = menu 
              ? Array.from(menu.querySelectorAll('[data-role="menuitem"], [role="menuitem"]'))
              : Array.from(document.querySelectorAll('[role="menuitem"], [data-role="menuitem"], div[class*="menu"] div[class*="item"]'));
            
            const deleteItem = items.find(el => /削除|Delete|Remove|Stop|停止|x/i.test(el.textContent || '') || (el.getAttribute('data-name')||'').includes('remove'));
            if (deleteItem && typeof deleteItem.click === 'function') {
              deleteItem.click();
              return true;
            }
            return false;
          });

          if (menuDeleted) {
            console.log("✅ 右クリックメニューから削除しました (DOM Evaluate)");
          }
        }

        if (menuDeleted) {
          await page.waitForTimeout(1500);
          await confirmTradingViewDialog(page).catch(() => {});
        } else {
          console.log("❌ 右クリックメニューにも削除項目なし。Deleteキーを試行します。");
          await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2); // 左クリックで選択
          await page.waitForTimeout(300);
          await page.keyboard.press('Delete').catch(() => {});
          await page.waitForTimeout(1500);
          await confirmTradingViewDialog(page).catch(() => {});
        }
      }
    }

    // 削除確認（最大15秒）
    let success = false;
    for (let i = 0; i < 15; i++) {
      const remaining = await getManagedAlertTickerTexts(page, prefixes);
      if (!remaining.includes(targetText)) {
        success = true;
        console.log(`🎉 削除成功: ${targetText}`);
        break;
      }
      await page.waitForTimeout(1000);
    }

    if (!success) {
      await safeScreenshot(page, `alert_delete_failed_${Date.now()}`);
      throw new Error(`アラート削除に失敗しました: ${targetText}`);
    }
  }

  throw new Error("アラート削除ループが上限に達しました");
}

async function openWatchlistMenuHard(page, retryCount = 8) {
  const menuSelector = '[data-qa-id="active-watchlist-menu"], [data-role="menu"]';
  const menuInnerSelector = '[data-qa-id="menu-inner"], [role="menu"]';

  for (let i = 0; i < retryCount; i++) {
    try {
      console.log(`[menu] ウォッチリストメニューを開こうとしています... (試行 ${i + 1}/${retryCount})`);

      // 既にメニューが開いているかチェック（二重クリック防止）
      if (await page.locator(menuSelector).first().isVisible().catch(() => false)) {
        console.log('[menu] メニューは既に開いています。');
        return true;
      }

      let button = null;
      if (typeof getWatchlistButton === 'function') {
        button = await getWatchlistButton(page);
      }
      if (!button) {
        await page.waitForTimeout(1000);
        if (typeof getWatchlistButton === 'function') button = await getWatchlistButton(page);
      }
      if (!button) {
        button = page.locator('button[data-name="watchlists-button"], button[aria-label*="Watchlist"], button[aria-label*="ウォッチリスト"]').first();
        if (!(await button.isVisible().catch(() => false))) {
          console.warn(`[menu] ウォッチリストボタンが見つからないためリトライします...`);
          continue;
        }
      }

      // 1. 通常クリックを試行
      // 手動でどこを押しても開くとのことなので、まずはボタン中央をクリック
      await button.click({ delay: 50 });

      // 2. メニューが出現したか「確定した属性」で判定
      try {
        await page.waitForSelector(menuSelector, { state: 'visible', timeout: 2500 });
        // 中身（menu-inner）もしっかり描画されるまで待機
        await page.waitForSelector(menuInnerSelector, { state: 'visible', timeout: 1000 });

        console.log('[menu] メニューの出現を確定しました。');
        return true;
      } catch (e) {
        console.warn(`[menu] 通常クリックでメニューが確認できません。強制発火を試みます...`);

        // 3. バックアップ：座標指定クリック（右端の矢印付近を狙う）
        const box = await button.boundingBox();
        if (box) {
          await page.mouse.click(box.x + box.width - 10, box.y + box.height / 2);
        }

        // 4. 最終手段：JavaScriptでの直接イベント発火
        await button.evaluate(el => {
          el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
          el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
          el.click();
        });

        // 判定
        await page.waitForTimeout(1000);
        if (await page.locator(menuSelector).isVisible()) {
          console.log('[menu] 強制発火によりメニューが開きました。');
          return true;
        }
      }

    } catch (err) {
      console.error(`[menu] 試行 ${i + 1} 中にエラー: ${err.message}`);
    }
    await page.waitForTimeout(1000);
  }
  throw new Error('ウォッチリストメニューを規定回数内に開けませんでした。判定用セレクタが正しいか再確認が必要です。');
}
// ==============================
// Offer / Flash sale popup (site-wide promotion dialog)
// ==============================
async function isOfferPopupVisible(page) {
  const markers = [
    page.getByText(/Don't miss this/i).first(),
    page.getByText(/Flash sale/i).first(),
    page.getByText(/Up to \d+% off/i).first(),
    page.getByText(/Explore offers/i).first(),
  ];

  let hitCount = 0;
  for (const marker of markers) {
    if (await marker.isVisible().catch(() => false)) hitCount++;
  }

  return hitCount >= 2;
}

async function closeOfferPopup(page) {
  // Strategy 1: JavaScript — find close button by SVG X-path geometry or
  // CSS-module class prefix "closeButton" scoped to the popup container.
  // Both are stable across TradingView UI updates:
  //   • The X-shape SVG path "m1.5 1.5 21 21m0-21-21 21" is geometric constant
  //   • CSS-module class names hash the suffix but keep the prefix (closeButton-*)
  const strategy1 = await page.evaluate(() => {
    // Walk up from any element that contains the offer popup text to find the
    // shallowest ancestor that also contains the close button.
    const offerKeywords = ["Flash sale", "Don't miss this", "Up to", "Explore offers"];
    const allText = document.querySelectorAll('*');
    let popupRoot = null;

    for (const el of allText) {
      if (el.children.length === 0) continue; // skip leaf text nodes
      if (el.children.length > 50) continue;  // skip huge containers
      const t = el.textContent || '';
      if (offerKeywords.filter(k => t.includes(k)).length >= 2) {
        popupRoot = el;
        break;
      }
    }

    // Walk up to find the first ancestor that has a closeButton-* class button
    let container = popupRoot;
    while (container && container !== document.body) {
      const closeBtn = container.querySelector('button[class*="closeButton"]');
      if (closeBtn) {
        const rect = closeBtn.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          closeBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
          return 'closeButton-class';
        }
      }
      container = container.parentElement;
    }

    // Fallback within JS: any visible button whose SVG path draws an X shape
    const xPathFragments = ['1.5 1.5 21 21', '21m0-21-21 21', 'm1.5 1.5'];
    for (const btn of document.querySelectorAll('button')) {
      for (const path of btn.querySelectorAll('svg path')) {
        const d = path.getAttribute('d') || '';
        if (xPathFragments.some(f => d.includes(f))) {
          const rect = btn.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0) {
            btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
            return 'svg-x-path';
          }
        }
      }
    }
    return null;
  });

  if (strategy1) {
    await page.waitForTimeout(800);
    if (!(await isOfferPopupVisible(page))) {
      console.log(`[offer-popup] offer popup closed via JS (${strategy1})`);
      return true;
    }
  }

  // Strategy 2: Playwright CSS selector — class prefix match
  for (const sel of [
    'button[class*="closeButton"]',
    'button[data-qa-id="close"]',
    'button[aria-label="Close"]',
    'button[aria-label="閉じる"]',
  ]) {
    const btn = page.locator(sel).first();
    if (!(await btn.isVisible().catch(() => false))) continue;
    const clicked = await clickBestEffort(btn, 5000);
    if (clicked) {
      await page.waitForTimeout(800);
      if (!(await isOfferPopupVisible(page))) {
        console.log(`[offer-popup] offer popup closed via selector: ${sel}`);
        return true;
      }
    }
  }

  // Strategy 3: Playwright :has() with SVG path geometry
  const bySvg = page.locator('button:has(svg path[d*="1.5 1.5 21 21"])').first();
  if (await bySvg.isVisible().catch(() => false)) {
    const clicked = await clickBestEffort(bySvg, 5000);
    if (clicked) {
      await page.waitForTimeout(800);
      if (!(await isOfferPopupVisible(page))) {
        console.log("[offer-popup] offer popup closed via SVG path :has() selector");
        return true;
      }
    }
  }

  // Strategy 4: Escape key
  await page.keyboard.press("Escape");
  await page.waitForTimeout(800);
  if (!(await isOfferPopupVisible(page))) {
    console.log("[offer-popup] offer popup closed via Escape");
    return true;
  }

  // Strategy 5: Click outside the popup (backdrop area – top-left corner)
  await page.mouse.click(10, 10);
  await page.waitForTimeout(800);
  if (!(await isOfferPopupVisible(page))) {
    console.log("[offer-popup] offer popup closed via backdrop click");
    return true;
  }

  console.warn("[offer-popup] could not close offer popup");
  return false;
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
  const t = compactTvText(s);
  return (
    t === "4h" ||
    t === "4hr" ||
    t === "4hrs" ||
    t === "4hour" ||
    t === "4hours" ||
    t === "240" ||
    t === "4時間" ||
    // ↓ 追加: "4h | 4h | Change interval" → "4h|4h|changeinterval" のような複合テキストを許容
    t.startsWith("4h|") ||
    t.startsWith("4時間|")
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
    if (!(await el.isVisible().catch(() => false))) continue;
    const txt = await readLocatorTextWithAttrs(el);
    if (!txt) continue;
    out.push(txt);
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

    await page.waitForTimeout(1200);
    // Change interval ダイアログが出た場合は即脱出（後続候補の誤クリック防止）
    if (await isChangeIntervalDialogOpen(page)) return false;
    const root = await findTimeframeMenuRoot(page);
    if (root) return true;

    await page.waitForTimeout(800);
    if (await isChangeIntervalDialogOpen(page)) return false;
    const rootRetry = await findTimeframeMenuRoot(page);
    if (rootRetry) return true; // rootRetry → true に修正
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

    await page.waitForTimeout(1200);
    if (await isChangeIntervalDialogOpen(page)) return false;
    const root = await findTimeframeMenuRoot(page);
    if (root) return true;
  }

  return false;
}

async function findTimeframeMenuRoot(page) {
  const selectors = [
    '[role="menu"]', '[role="listbox"]',
    'div[data-name="menu-inner"]', 'div[class*="menu"]',
  ];

  // 第1優先: [data-value="240"] を含む要素
  for (const sel of selectors) {
    const loc = page.locator(sel);
    const count = Math.min(await loc.count().catch(() => 0), 20);
    for (let i = 0; i < count; i++) {
      const root = loc.nth(i);
      if (!(await root.isVisible().catch(() => false))) continue;
      const has240 = (await root.locator('[data-value="240"]').count().catch(() => 0)) > 0;
      if (has240) return root;
    }
  }

  // 第2優先: "hours/時間" と "days/日" の両方を含む要素
  for (const sel of selectors) {
    const loc = page.locator(sel);
    const count = Math.min(await loc.count().catch(() => 0), 20);
    for (let i = count - 1; i >= 0; i--) {
      const root = loc.nth(i);
      if (!(await root.isVisible().catch(() => false))) continue;
      const text = normalizeTvText(await root.textContent().catch(() => ""));
      const hasHoursAndDays = /hours|時間/.test(text) && /days|日/.test(text);
      const has240 = (await root.locator('[data-value="240"]').count().catch(() => 0)) > 0;
      if (has240 || hasHoursAndDays) return root;
    }
  }

  // ===== 以下を追加 =====

  // 第3優先: より広いセレクタで、複数の時間足テキストを含むドロップダウン
  const broadSelectors = [
    '[role="menu"]', '[role="listbox"]',
    'div[data-name="menu-inner"]', 'div[class*="menu"]',
    'div[class*="dropdown"]', 'div[class*="popup"]',
    'div[class*="popover"]', 'div[class*="flyout"]',
  ];

  for (const sel of broadSelectors) {
    const loc = page.locator(sel);
    const count = Math.min(await loc.count().catch(() => 0), 20);
    for (let i = count - 1; i >= 0; i--) {
      const root = loc.nth(i);
      if (!(await root.isVisible().catch(() => false))) continue;
      const text = normalizeTvText(await root.textContent().catch(() => ""));
      // 複数の時間足文字列（"1m","5m","1h","4h","1d" など）を2つ以上含む
      const tfCount = (text.match(/\b(1m|5m|15m|30m|1h|2h|3h|4h|6h|12h|1d|1w|1mo)\b/gi) || []).length;
      if (tfCount >= 2) return root;
    }
  }

  // 第4優先: data-value が数値のメニュー項目を持つ任意のオーバーレイ
  const anyOverlay = page.locator('[role="menu"], [role="listbox"], div[data-name="menu-inner"]');
  const overlayCount = Math.min(await anyOverlay.count().catch(() => 0), 20);
  for (let i = overlayCount - 1; i >= 0; i--) {
    const root = anyOverlay.nth(i);
    if (!(await root.isVisible().catch(() => false))) continue;
    const hasNumericDataValue = (await root.locator('[data-value]').count().catch(() => 0)) >= 3;
    if (hasNumericDataValue) return root;
  }

  return null;
}

// ==============================
// Change interval ダイアログ対応 (追加)
// ==============================
async function isChangeIntervalDialogOpen(page) {
  return await page.getByText(/^Change interval$/i).first().isVisible().catch(() => false);
}

async function fill4HInChangeIntervalDialog(page) {
  console.log("[timeframe] Change interval dialog detected, typing 240...");
  const inputs = page.locator("input");
  const count = Math.min(await inputs.count().catch(() => 0), 20);
  for (let i = 0; i < count; i++) {
    const inp = inputs.nth(i);
    if (!(await inp.isVisible().catch(() => false))) continue;
    await inp.click({ force: true }).catch(() => { });
    await page.keyboard.press("Control+A");
    await inp.fill("240");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(1000);
    console.log("[timeframe] filled 240 in Change interval dialog");
    return true;
  }
  console.log("[timeframe] input not found in Change interval dialog");
  return false;
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
  const directCandidates = [
    menuRoot.locator('[data-role="menuitem"][data-value="240"]').first(),
    menuRoot.locator('[role="row"][data-value="240"]').first(),
    menuRoot.locator('[data-value="240"]').first(),
    menuRoot.locator('[data-role="menuitem"]').filter({ hasText: /^4 ?時間$|^4 ?hours?$|^4h$/i }).first(),
    menuRoot.locator('[role="row"]').filter({ hasText: /^4 ?時間$|^4 ?hours?$|^4h$/i }).first(),
  ];

  for (const c of directCandidates) {
    if (!(await c.count().catch(() => 0))) continue;
    if (!(await c.isVisible().catch(() => false))) continue;
    const meta = await describeLocator(c);
    if (meta) {
      console.log("[timeframe] direct 4H candidate:", JSON.stringify(meta));
    }
    const clicked = await clickBestEffort(c, 4000);
    if (clicked) return true;
  }

  const scanSelectors = [
    '[data-role="menuitem"]',
    '[role="row"]',
    '[role="option"]',
    'button',
    'div',
    'span',
  ].join(', ');

  let items = menuRoot.locator(scanSelectors);
  let count = Math.min(await items.count().catch(() => 0), 400);

  for (let i = 0; i < count; i++) {
    const el = items.nth(i);
    if (!(await el.isVisible().catch(() => false))) continue;
    const txt = await readLocatorTextWithAttrs(el);
    if (!isTarget4hText(txt)) continue;
    const clicked = await clickBestEffort(el, 4000);
    if (clicked) return true;
  }

  await expandHoursSectionIfNeeded(page, menuRoot);
  await page.waitForTimeout(250);

  items = menuRoot.locator(scanSelectors);
  count = Math.min(await items.count().catch(() => 0), 400);

  for (let i = 0; i < count; i++) {
    const el = items.nth(i);
    if (!(await el.isVisible().catch(() => false))) continue;
    const txt = await readLocatorTextWithAttrs(el);
    if (!isTarget4hText(txt)) continue;
    const clicked = await clickBestEffort(el, 4000);
    if (clicked) return true;
  }

  for (let r = 0; r < 10; r++) {
    await menuRoot.evaluate((el) => {
      el.scrollTop = (el.scrollTop || 0) + 240;
    }).catch(() => { });
    await page.waitForTimeout(200);

    items = menuRoot.locator(scanSelectors);
    count = Math.min(await items.count().catch(() => 0), 400);

    for (let i = 0; i < count; i++) {
      const el = items.nth(i);
      if (!(await el.isVisible().catch(() => false))) continue;
      const txt = await readLocatorTextWithAttrs(el);
      if (!isTarget4hText(txt)) continue;
      const clicked = await clickBestEffort(el, 4000);
      if (clicked) return true;
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

  // クリック前にすでにダイアログが開いている場合を処理
  if (await isChangeIntervalDialogOpen(page)) {
    const ok = await fill4HInChangeIntervalDialog(page);
    if (!ok) throw new Error("Change interval ダイアログへの入力に失敗しました (pre-click)");
    // 検証へ
  } else {
    const opened = await openChartTimeframeMenu(page);

    if (!opened) {
      // ボタンクリック後に Change interval ダイアログが出た場合
      if (await isChangeIntervalDialogOpen(page)) {
        const ok = await fill4HInChangeIntervalDialog(page);
        if (!ok) throw new Error("Change interval ダイアログへの入力に失敗しました (post-click)");
        // 検証へ
      } else {
        await safeScreenshot(page, "chart_timeframe_button_not_found");
        throw new Error("チャート時間足メニューを開けませんでした（ドロップダウン未検出・ダイアログ未検出）");
      }
    } else {
      await logChartTimeframeMenuState(page, "chart-timeframe-opened");

      const root = await findTimeframeMenuRoot(page);
      if (!root) {
        await safeScreenshot(page, "chart_timeframe_menu_not_found");
        throw new Error("チャート時間足メニューが見つかりませんでした");
      }

      const ok = await select4hFromMenu(page, root);
      if (!ok) {
        await safeScreenshot(page, "chart_4h_not_found");
        throw new Error(`チャート時間足 "${targetLabel}" が見つかりませんでした`);
      }
    }
  }

  await page.waitForTimeout(1200);

  const after = await getCurrentChartTimeframeText(page);
  console.log(`[timeframe] current chart timeframe after change: "${after}"`);

  if (!isTarget4hText(after)) {
    await safeScreenshot(page, "chart_timeframe_verify_failed");
    throw new Error(`チャート時間足の変更確認に失敗しました。現在: "${after}"`);
  }
}

async function getAlertIntervalButton(dialog) {
  if (!dialog) return null;

  const candidates = [
    dialog.locator('[role="button"], [role="combobox"], button').filter({ hasText: /Same as chart|チャートと同一|チャートと同じ/i }).first(),
    dialog.locator('[role="button"], [role="combobox"], button').filter({ hasText: /4 ?時間|4 ?hours?|4h|240/i }).first(),
    dialog.locator('button[aria-haspopup="menu"]').filter({ hasText: /4 ?時間|4 ?hours?|4h|Same as chart|チャート/i }).first(),
  ];

  for (const c of candidates) {
    if (!(await c.count().catch(() => 0))) continue;
    if (await c.isVisible().catch(() => false)) return c;
  }

  const controls = dialog.locator('[role="button"], [role="combobox"], button');
  const count = Math.min(await controls.count().catch(() => 0), 120);

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
    await safeScreenshot(page, `${tag}_dialog_not_found`);
    return;
  }

  const chartTf = await getCurrentChartTimeframeText(page);
  console.log(`[${tag}] current chart timeframe: "${chartTf}"`);

  const dialogText = ((await dialog.textContent().catch(() => '')) || '').replace(/\s+/g, ' ').trim();
  console.log(`[${tag}] dialog text preview:`, dialogText.slice(0, 400));

  const buttonTexts = await collectVisibleTexts(dialog.locator('button, [role="button"], [role="combobox"]'), 120);
  console.log(`[${tag}] visible dialog button texts:`, buttonTexts);

  const intervalBtn = await getAlertIntervalButton(dialog);
  if (!intervalBtn) {
    console.log(`[${tag}] interval button not found inside alert dialog`);
    await safeScreenshot(page, `${tag}_interval_button_not_found`);
    return;
  }

  const intervalText = await readLocatorTextWithAttrs(intervalBtn);
  console.log(`[${tag}] interval button text: "${intervalText}"`);

  await safeScreenshot(page, tag);
}

async function verifyAlertIntervalIsSameAsChart(page) {
  const dialog = await getAlertDialogRoot(page);
  if (!dialog) {
    await safeScreenshot(page, 'alert_interval_dialog_missing');
    throw new Error('Alert ダイアログが途中で閉じました');
  }

  const intervalBtn = await getAlertIntervalButton(dialog);
  if (!intervalBtn) {
    await logAlertIntervalState(page, 'alert_interval_missing');
    throw new Error('Alert の Interval ボタンが見つかりませんでした');
  }

  const txt = await readLocatorTextWithAttrs(intervalBtn);
  const chartTf = await getCurrentChartTimeframeText(page);

  if (isSameAsChartText(txt)) {
    console.log(`[alert] interval is Same as chart: "${txt}"`);
    return;
  }

  if (isTarget4hText(txt) && isTarget4hText(chartTf)) {
    console.log(`[alert] interval text is explicit 4H while chart is 4H. accepted: "${txt}"`);
    return;
  }

  await logAlertIntervalState(page, 'alert_interval_not_same_as_chart');
  throw new Error(`Alert の Interval が想定外でした: ${txt}`);
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

      await item.scrollIntoViewIfNeeded().catch(() => { });
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
  console.log('Selecting alert condition:', conditionName);

  const dialog = await getAlertDialogRoot(page);
  if (!dialog) {
    await safeScreenshot(page, 'alert_dialog_missing_before_condition_select');
    throw new Error('条件選択前に Alert ダイアログが見つかりませんでした');
  }

  const dropdownCandidates = [
    dialog.locator('[data-qa-id="main-series-select-title"]').first(),
    dialog.locator('[role="button"], [role="combobox"], button').filter({ hasText: /^Price$|^価格$/ }).first(),
    dialog.locator('span').filter({ hasText: /^Price$|^価格$/ }).first(),
    dialog.locator('div').filter({ hasText: /^Price$|^価格$/ }).last(),
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
    await safeScreenshot(page, 'alert_condition_dropdown_not_opened');
    throw new Error('アラート条件ドロップダウンを開けませんでした');
  }

  await page.waitForTimeout(800);

  const shortName = conditionName.split('(')[0].trim();
  console.log('Looking for option matching:', shortName);

  const optionCandidates = [
    page.locator('[role="option"]').filter({ hasText: conditionName }).first(),
    page.locator('[role="option"]').filter({ hasText: shortName }).first(),
    page.locator('[data-role="menuitem"]').filter({ hasText: conditionName }).first(),
    page.locator('[data-role="menuitem"]').filter({ hasText: shortName }).first(),
    page.locator('div[role="row"]').filter({ hasText: shortName }).first(),
    page.locator('span').filter({ hasText: shortName }).first(),
    page.getByText(shortName, { exact: false }).first(),
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
    await safeScreenshot(page, 'alert_condition_not_found');
    throw new Error(`アラート条件が見つかりませんでした: ${conditionName} (短縮検索: ${shortName})`);
  }

  await page.waitForTimeout(700);

  const dialogAfter = await getAlertDialogRoot(page);
  if (!dialogAfter) {
    await safeScreenshot(page, 'alert_dialog_disappeared_after_condition_select');
    throw new Error('条件選択後に Alert ダイアログが閉じました');
  }
}

async function selectAlertResolution(page, label) {
  console.log(`[deprecated] selectAlertResolution() is no longer used directly. target=${label}`);
  await ensureChartTimeframe(page, label || "4 時間");
}

async function getAlertDialogRoot(page) {
  const roleDialogs = page.locator('[role="dialog"]');
  const count = Math.min(await roleDialogs.count().catch(() => 0), 10);

  for (let i = count - 1; i >= 0; i--) {
    const d = roleDialogs.nth(i);
    if (!(await d.isVisible().catch(() => false))) continue;

    const txt = ((await d.textContent().catch(() => '')) || '').replace(/\s+/g, ' ').trim();
    if (/Create alert on|アラートを作成|Open-ended alert|Once only|Toasts|Webhook|Cancel|Create/i.test(txt)) {
      return d;
    }
  }

  const titled = page.getByText(/Create alert on|アラートを作成/i).first();
  if (await titled.isVisible().catch(() => false)) {
    const parent = titled.locator('xpath=ancestor::*[@role="dialog" or contains(@class,"dialog") or contains(@class,"modal")][1]').first();
    if (await parent.isVisible().catch(() => false)) return parent;
  }

  return null;
}

async function ensureAlertTargetList(page, listName) {
  const dialog = await getAlertDialogRoot(page);
  if (!dialog) {
    await safeScreenshot(page, `alert_dialog_missing_for_target_${listName}`);
    throw new Error(`アラート対象リスト確認時にダイアログが見つかりませんでした: ${listName}`);
  }

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

// submitAlertDialog の promo retry ブロックを以下に差し替え
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

  for (let i = 0; i < 20; i++) {   // ← 14 → 20 に拡張
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

      // ★ 変更点: スロット解放待機を指数バックオフに
      const waitMs = WATCHLIST_PROMO_RETRY_WAIT_MS * promoRetryCount;
      console.log(`[promo] waiting ${waitMs}ms before retrying Create (backoff x${promoRetryCount})`);
      await page.waitForTimeout(waitMs);

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

    if (i < 19) {
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
    await debugDump(page, `error_${listName}`);
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
    await page.waitForLoadState("networkidle").catch(() => { });
    await waitForTradingViewReady(page);  // 新しい関数を使用

    // オファー / フラッシュセール ポップアップを proactive に閉じる
    if (await isOfferPopupVisible(page)) {
      console.log("[offer-popup] offer popup detected on page load, closing...");
      await safeScreenshot(page, "offer_popup_detected");
      await closeOfferPopup(page);
    }

    // ログイン状態確認（必要に応じて）
    const needLogin = await page.getByText(/Sign in|ログイン/i).first().isVisible().catch(() => false);
    if (needLogin) {
      await safeScreenshot(page, "need_login");
      throw new Error("TradingView がログイン状態ではありません");
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
    if (page) {
      await debugDump(page, "final_error");
      await safeScreenshot(page, "failed");
    }
    if (browser) await browser.close().catch(() => { });
    process.exit(1);
  }
})();
