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

const ALERT_SLOT_RELEASE_WAIT_MS = Number(process.env.ALERT_SLOT_RELEASE_WAIT_MS || 180000);
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

// ==============================
// Base UI: Watchlist panel / menu (UI変更に強い版)
// ==============================

async function getWatchlistButton(page) {
  // 1. data-name 属性（最も信頼できる）
  const dataNameBtn = page.locator('button[data-name="watchlists-button"]').first();
  if (await dataNameBtn.isVisible().catch(() => false)) return dataNameBtn;

  // 2. ロール + テキスト
  const roleBtn = page.getByRole('button', { name: /ウォッチリスト|Watchlist/i }).first();
  if (await roleBtn.isVisible().catch(() => false)) return roleBtn;

  // 3. aria-label や title
  const attrBtn = page.locator('button[aria-label*="ウォッチリスト"], button[aria-label*="Watchlist"], button[title*="ウォッチリスト"], button[title*="Watchlist"]').first();
  if (await attrBtn.isVisible().catch(() => false)) return attrBtn;

  // 4. data-tooltip
  const tooltipBtn = page.locator('button[data-tooltip*="ウォッチリスト"], button[data-tooltip*="Watchlist"]').first();
  if (await tooltipBtn.isVisible().catch(() => false)) return tooltipBtn;

  // 5. 部分クラス名
  const classBtn = page.locator('button[class*="watchlist"], button[class*="Watchlist"]').first();
  if (await classBtn.isVisible().catch(() => false)) return classBtn;

  // 6. 最終手段: SVG アイコンの親ボタン
  const svgBtn = page.locator('svg').locator('xpath=ancestor::button').first();
  if (await svgBtn.isVisible().catch(() => false)) return svgBtn;

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

  return fullText.trim().split("\n")[0];
}

async function getVisibleWatchlistMenuRoot(page) {
  const roots = [
    'div[data-name="menu-inner"]',
    'div[class*="menuWrap"]',
    'div[class*="contextMenu"]',
    'div[role="menu"]',
    'div[class*="menu-"]'
  ];
  for (const sel of roots) {
    const el = page.locator(sel).first();
    if (await el.isVisible().catch(() => false)) {
      // メニューらしいテキストが含まれているか確認
      const text = await el.innerText().catch(() => "");
      if (/リストにアラート|Open list|Upload list|Rename|Rename list|リストをリネーム/i.test(text)) {
        return el;
      }
    }
  }
  return null;
}

async function findMenuItemByText(page, re) {
  const candidates = [
    page.locator('[role="menuitem"]').filter({ hasText: re }),
    page.locator('[data-role="menuitem"]').filter({ hasText: re }),
    page.locator('div[class*="item-"]').filter({ hasText: re }),
    page.locator('button').filter({ hasText: re }),
    page.locator('span').filter({ hasText: re }),
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
  // 新しいUI: メニュー内に直接リスト一覧が表示されている場合は何もしない
  const directListItems = page.locator('[data-qa-id="menu-inner"] [class*="item-"], [role="menuitem"][data-role="list-item"], div[data-role="list-item"]');
  if (await directListItems.first().isVisible().catch(() => false)) {
    console.log("List dialog already open (direct items in menu)");
    return;
  }

  // 従来の「リストを開く」メニューを開く（旧UI用フォールバック）
  for (let attempt = 0; attempt < 3; attempt++) {
    const opened = await openWatchlistMenuHard(page, 6);
    if (!opened) {
      await page.waitForTimeout(1000);
      continue;
    }

    const openTexts = [/リストを開く/i, /Open list/i, /Manage watchlists/i, /すべてのリスト/i];
    let clicked = false;
    for (const re of openTexts) {
      const item = await findMenuItemByText(page, re);
      if (item) {
        await clickBestEffort(item, 8000);
        clicked = true;
        break;
      }
    }
    
    if (clicked) {
      await page.waitForTimeout(1500);
      // ダイアログまたは新しいリスト一覧が表示されるのを待つ
      const listVisible = await directListItems.first().isVisible({ timeout: 5000 }).catch(() => false);
      if (listVisible) return;
    }
    
    await closeAnyMenu(page);
    await page.waitForTimeout(1000);
  }

  // 最終確認：それでもリスト一覧が出ない場合はエラー
  if (!(await directListItems.first().isVisible().catch(() => false))) {
    await safeScreenshot(page, "open_list_dialog_not_visible");
    throw new Error("リスト一覧を開けませんでした（新旧UIどちらにも対応できず）");
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
  await closeOpenListDialogIfVisible(page).catch(() => {});
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
  const prefixes = [prefix, prefix.replace('l', '')];
  console.log(`[delete] "${prefix}" で始まるウォッチリストを削除します（バリエーション: ${prefixes.join(', ')}）...`);

  const todayDateStr = RUN_TS.split('_')[0];

  // 最大3ラウンド
  for (let round = 0; round < 3; round++) {
    // ---------- ステップ1: メニューを開き、「リストを開く...」をクリック ----------
    await openWatchlistMenuHard(page, 6);
    await page.waitForTimeout(800);

    // 「リストを開く...」メニュー項目を探す（複数パターン）
    let openListItem = null;
    const openListPatterns = [
      /リストを開く/i,
      /Open list/i,
      /Manage watchlists/i,
      /すべてのリスト/i
    ];
    for (const pattern of openListPatterns) {
      const item = await findMenuItemByText(page, pattern);
      if (item) {
        openListItem = item;
        break;
      }
    }
    if (!openListItem) {
      console.log(`[delete] 「リストを開く...」が見つかりません。リトライ ${round + 1}/3`);
      await closeAnyMenu(page);
      await page.waitForTimeout(1000);
      continue;
    }
    await clickBestEffort(openListItem, 5000);
    await page.waitForTimeout(1500);

    // ---------- ステップ2: リスト一覧パネルが開くのを待つ ----------
    let listPanel = null;
    const panelSelectors = [
      '[data-role="list"]',
      '[data-name="watchlist-list"]',
      '[role="listbox"]',
      'div[class*="watchlistList"]',
      '[data-qa-id="open-list-dialog"]',
      'div[role="dialog"]'
    ];
    for (const sel of panelSelectors) {
      const panel = page.locator(sel).first();
      if (await panel.isVisible({ timeout: 2000 }).catch(() => false)) {
        listPanel = panel;
        break;
      }
    }
    if (!listPanel) {
      console.log(`[delete] リスト一覧パネルが見つかりません。リトライ ${round + 1}/3`);
      await closeAnyMenu(page);
      await page.waitForTimeout(1000);
      continue;
    }

    // ---------- ステップ3: パネル内の全リスト項目をスクロール収集 ----------
    let allItems = [];
    let previousCount = 0;
    let scrollAttempts = 0;
    const maxScrolls = 12;

    while (scrollAttempts < maxScrolls) {
      const itemSelectors = [
        '[data-role="list-item"]',
        '[role="option"]',
        '[class*="item"]',
        'div[data-title]'
      ];
      let items = null;
      for (const sel of itemSelectors) {
        const found = listPanel.locator(sel);
        if ((await found.count()) > 0) {
          items = found;
          break;
        }
      }
      if (!items) break;

      const count = await items.count();
      for (let i = 0; i < count; i++) {
        const text = await items.nth(i).innerText().catch(() => "");
        if (text && text.trim()) {
          allItems.push({ element: items.nth(i), name: text.trim() });
        }
      }
      // 重複除去
      allItems = allItems.filter((item, idx, self) => self.findIndex(i => i.name === item.name) === idx);

      if (count === previousCount && scrollAttempts > 0) break;
      previousCount = count;

      await listPanel.evaluate(el => { el.scrollTop += 400; }).catch(() => {});
      await page.waitForTimeout(600);
      scrollAttempts++;
    }

    // 削除対象を抽出（今日のリストは除外）
    let targets = allItems.filter(item => {
      const name = item.name;
      // プレフィックス一致チェック
      if (!prefixes.some(p => name.toLowerCase().startsWith(p.toLowerCase()))) return false;
      
      // 今日のリストは除外
      const dateMatch = name.match(/_(\d{8})_/);
      if (dateMatch && dateMatch[1] === todayDateStr) {
        console.log(`[delete] スキップ: 今日作成されたリスト "${name}"`);
        return false;
      }
      return true;
    });

    if (targets.length === 0) {
      console.log(`[delete] 削除対象なし。ラウンド ${round + 1} 終了。`);
      break;
    }

    console.log(`[delete] ラウンド ${round + 1}: ${targets.length}件削除 (${targets.map(t => t.name).join(", ")})`);

    // ---------- ステップ4: 各リストを削除（ホバー → ゴミ箱） ----------
    for (const target of targets) {
      console.log(`[delete] "${target.name}" を削除中...`);

      // 行を再取得
      const row = page.locator(`[data-role="list-item"]:has-text("${target.name}"), [role="option"]:has-text("${target.name}"), div[data-title="${target.name}"]`).first();
      await row.waitFor({ state: "visible", timeout: 10000 });

      // ホバーしてゴミ箱ボタンを表示
      await row.hover();
      await page.waitForTimeout(800);

      let deleted = false;
      const deleteBtnSelectors = [
        'button[data-name="remove-button"]',
        'button[aria-label*="削除"]',
        'button[aria-label*="Delete"]',
        'button[class*="delete"]',
        'button[class*="remove"]',
        '[data-qa-id="remove-button"]',
        'button:has(svg[class*="trash"])'
      ];

      for (const sel of deleteBtnSelectors) {
        const btn = row.locator(sel).first();
        if (await btn.isVisible({ timeout: 1000 }).catch(() => false)) {
          await btn.click({ force: true });
          deleted = true;
          console.log(`[delete] ゴミ箱ボタンをクリックしました。`);
          break;
        }
      }

      if (!deleted) {
        console.warn(`[delete] "${target.name}" のゴミ箱ボタンが見つかりません。スキップします。`);
        continue;
      }

      // 確認ダイアログ
      const confirmBtn = page.locator('[role="dialog"] button').filter({ hasText: /削除|Delete|はい|Yes|OK/i }).first();
      if (await confirmBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
        await confirmBtn.click({ force: true });
        console.log(`[delete] 確認ダイアログを承認しました。`);
      }
      await page.waitForTimeout(800);
    }

    // パネルを閉じてリフレッシュ
    await closeOpenListDialogIfVisible(page).catch(() => {});
    await closeAnyMenu(page);
    await page.waitForTimeout(1000);
  }

  console.log(`[delete] "${prefix}" 系のウォッチリスト削除完了。`);
}

// ==============================
// Import watchlist
// ==============================
async function importWatchlistFromFile(page, filePath, finalName) {
  console.log(`Importing watchlist: ${finalName} from ${filePath}`);

  // 1. メニューを開く
  await openWatchlistMenuHard(page, 6);
  await page.waitForTimeout(800);

  // 2. 「リストをインポート...」をクリック
  const importTexts = [/リストをインポート/i, /Import list/i, /Upload list/i];
  let importItem = null;
  for (const re of importTexts) {
    importItem = await findMenuItemByText(page, re);
    if (importItem) break;
  }

  if (!importItem) {
    await safeScreenshot(page, "import_menu_not_found");
    throw new Error("「リストをインポート...」メニューが見つかりません");
  }

  // ファイル選択を待機
  const fileChooserPromise = page.waitForEvent("filechooser");
  await clickBestEffort(importItem, 8000);
  const fileChooser = await fileChooserPromise;
  await fileChooser.setFiles(filePath);

  console.log("File uploaded, waiting for import to complete...");
  await page.waitForTimeout(3000);

  // 3. インポート直後は名前がデフォルト（"wl1" など）なので、リネームする
  // インポートされたリストが自動的に選択されるはず
  await renameCurrentWatchlist(page, finalName);
}

async function renameCurrentWatchlist(page, newName) {
  console.log(`Renaming current watchlist to: ${newName}`);

  for (let attempt = 0; attempt < 3; attempt++) {
    await openWatchlistMenuHard(page, 6);
    await page.waitForTimeout(800);

    const renameTexts = [/リストをリネーム/i, /Rename list/i, /Rename/i];
    let renameItem = null;
    for (const re of renameTexts) {
      renameItem = await findMenuItemByText(page, re);
      if (renameItem) break;
    }

    if (!renameItem) {
      console.log(`[rename] リネームメニューが見つかりません。リトライ ${attempt + 1}/3`);
      await closeAnyMenu(page);
      await page.waitForTimeout(1000);
      continue;
    }

    await clickBestEffort(renameItem, 8000);
    await page.waitForTimeout(1000);

    // 入力フィールドを探す
    const input = page.locator('input[data-role="value"], input[type="text"]').filter({ has: page.locator('xpath=ancestor::div[role="dialog"]') }).first();
    if (await input.isVisible().catch(() => false)) {
      await input.fill("");
      await input.fill(newName);
      await page.keyboard.press("Enter");
      await page.waitForTimeout(1500);
      console.log("Rename submitted.");
      return;
    }

    await closeAnyMenu(page);
  }

  throw new Error(`ウォッチリストのリネームに失敗しました: ${newName}`);
}

// ==============================
// Alerts Panel
// ==============================
async function ensureAlertsPanelOpen(page) {
  const panel = page.locator('[data-name="alerts-list"], [class*="alertsPanel"]');
  if (await panel.isVisible().catch(() => false)) return;

  const btn = page.locator('button[data-name="alerts"]').first();
  if (await btn.isVisible().catch(() => false)) {
    await btn.click();
    await page.waitForTimeout(1000);
  }
}

async function getAllAlertTickerTexts(page) {
  await ensureAlertsPanelOpen(page);
  const tickers = page.locator('[data-name="alert-item-ticker"], [class*="ticker"]');
  const count = await tickers.count().catch(() => 0);
  const out = [];
  for (let i = 0; i < count; i++) {
    const txt = await tickers.nth(i).textContent().catch(() => "");
    if (txt) out.push(txt.trim());
  }
  return out;
}

async function getManagedAlertTickerTexts(page, prefixes) {
  const all = await getAllAlertTickerTexts(page);
  return all.filter(txt => prefixes.some(p => txt.startsWith(`${p}_`) || txt === p));
}

async function deleteManagedAlerts(page, prefixes) {
  console.log("[alert] アラート削除を開始します（ホバー → ゴミ箱方式）");

  // アラートサイドバーを開く
  await ensureAlertsPanelOpen(page);
  await page.waitForTimeout(1500);

  let round = 0;
  const maxRounds = 100;

  while (round < maxRounds) {
    // アラート一覧の各行を取得
    const alertRows = page.locator('[data-name="alert-item"], [data-role="alert-item"], [class*="alertItem"]');
    const count = await alertRows.count().catch(() => 0);
    if (count === 0) {
      console.log("[alert] アラート一覧が空です。");
      break;
    }

    let targetRow = null;
    let targetText = "";

    // 削除対象のアラートを探す（ticker 部分にウォッチリスト名が含まれる）
    for (let i = 0; i < count; i++) {
      const row = alertRows.nth(i);
      const tickerEl = row.locator('[data-name="alert-item-ticker"], [class*="ticker"]').first();
      const tickerText = (await tickerEl.textContent().catch(() => "")) || "";
      // プレフィックス一致チェック（wl1_ や wl2_ で始まるもの）
      if (prefixes.some(p => tickerText.startsWith(`${p}_`) || tickerText === p)) {
        targetRow = row;
        targetText = tickerText;
        break;
      }
    }

    if (!targetRow) {
      console.log("[alert] 削除対象のアラートは見つかりませんでした。");
      break;
    }

    console.log(`[alert] 削除対象: "${targetText}"`);

    // ホバーしてゴミ箱ボタンを表示
    await targetRow.hover();
    await page.waitForTimeout(800);

    let deleted = false;
    const deleteBtnSelectors = [
      'button[data-name="delete-button"]',
      'button[aria-label*="削除"]',
      'button[aria-label*="Delete"]',
      'button[class*="delete"]',
      'button[class*="remove"]',
      '[data-qa-id="delete-button"]',
      'button:has(svg[class*="trash"])'
    ];

    for (const sel of deleteBtnSelectors) {
      const btn = targetRow.locator(sel).first();
      if (await btn.isVisible({ timeout: 1000 }).catch(() => false)) {
        await btn.click({ force: true });
        deleted = true;
        console.log(`[alert] ゴミ箱ボタンをクリックしました。`);
        break;
      }
    }

    // フォールバック：右クリックメニュー
    if (!deleted) {
      console.log(`[alert] ゴミ箱ボタンがないため右クリックメニューを試みます。`);
      await targetRow.click({ button: "right", force: true });
      await page.waitForTimeout(500);
      const delMenuItem = page.locator('[role="menuitem"]:has-text("削除"), [role="menuitem"]:has-text("Delete")').first();
      if (await delMenuItem.isVisible({ timeout: 2000 }).catch(() => false)) {
        await delMenuItem.click({ force: true });
        deleted = true;
        console.log(`[alert] 右クリックメニューから削除しました。`);
      }
    }

    if (!deleted) {
      throw new Error(`アラート削除に失敗しました: ${targetText}`);
    }

    // 確認ダイアログ（あれば）
    for (let wait = 0; wait < 10; wait++) {
      await page.waitForTimeout(500);
      const confirmBtn = page.locator('[role="dialog"] button').filter({ hasText: /削除|Delete|はい|Yes|OK/i }).first();
      if (await confirmBtn.isVisible().catch(() => false)) {
        await confirmBtn.click({ force: true });
        console.log(`[alert] 確認ダイアログを承認しました。`);
        break;
      }
      // 項目が消えたか確認
      const stillExists = await page.locator(`[data-name="alert-item-ticker"]:has-text("${targetText}")`).isVisible().catch(() => false);
      if (!stillExists) break;
    }

    await page.waitForTimeout(800);
    round++;
  }

  console.log("[alert] アラート削除完了。");
}

/**
 * ウォッチリストのドロップダウンメニューを確実に開く関数
 */
async function openWatchlistMenuHard(page, retryCount = 8) {
  const buttonSelector = 'button[data-name="watchlists-button"]';
  
  for (let i = 0; i < retryCount; i++) {
    console.log(`[menu] ウォッチリストメニューを開こうとしています... (試行 ${i + 1}/${retryCount})`);
    
    // 既にメニューが開いているかチェック
    const existingMenu = await getVisibleWatchlistMenuRoot(page);
    if (existingMenu) {
      console.log('[menu] メニューは既に開いています。');
      return true;
    }
    
    // ボタンを取得
    const button = page.locator(buttonSelector).first();
    if (!await button.isVisible().catch(() => false)) {
      console.warn('[menu] ウォッチリストボタンが見えません。リトライします。');
      await page.waitForTimeout(1000);
      continue;
    }
    
    // クリック
    const trigger = await getWatchlistMenuTrigger(page);
    if (trigger) {
      await trigger.click({ force: true }).catch(() => {});
    } else {
      await button.click({ force: true }).catch(() => {});
    }
    
    // メニューが表示されるのを待つ
    const menu = await waitForMenuOpen(page, 5000);
    if (menu) {
      console.log('[menu] メニューが開きました。');
      return true;
    }
    
    console.warn('[menu] メニューが開きませんでした。リトライします。');
    await page.waitForTimeout(1000);
  }
  
  return false;
}

async function closeAnyMenu(page) {
  await page.keyboard.press("Escape");
  await page.waitForTimeout(500);
}

async function clickBestEffort(locator, timeout = 5000) {
  try {
    await locator.waitFor({ state: "visible", timeout });
    await locator.scrollIntoViewIfNeeded().catch(() => {});
    await locator.click({ force: true, timeout });
    return true;
  } catch {
    try {
      await locator.evaluate(el => el.click());
      return true;
    } catch {
      return false;
    }
  }
}

// ==============================
// Alert Creation
// ==============================
async function createWatchlistAlertIfPossible(page, listName) {
  console.log(`[alert] Starting alert creation for: ${listName}`);

  try {
    // 1. ウォッチリストを切り替える
    await switchWatchlistTo(page, listName);

    // 2. 4時間足に切り替える
    await ensure4HTimeframe(page);

    // 3. アラート作成
    await openWatchlistMenuHard(page, 6);
    await page.waitForTimeout(800);

    const alertTexts = [/リストにアラート/i, /Add alert on/i, /Create alert on/i];
    let alertItem = null;
    for (const re of alertTexts) {
      alertItem = await findMenuItemByText(page, re);
      if (alertItem) break;
    }

    if (!alertItem) {
      throw new Error("「リストにアラートを追加...」メニューが見つかりません");
    }

    await clickBestEffort(alertItem, 8000);
    await page.waitForTimeout(2000);

    // 4. アラート設定ダイアログ
    await configureAlertSettings(page, listName);

    // 5. 作成確認
    const beforeHeader = await getCurrentWatchlistHeaderState(page);
    
    // 「作成」ボタンをクリック
    const createBtn = page.locator('button[data-name="submit"], button').filter({ hasText: /作成|Create/i }).first();
    await clickBestEffort(createBtn, 8000);
    console.log("[alert] Create button clicked.");

    await page.waitForTimeout(3000);

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

    // フォールバック: Alerts一覧確認
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

async function configureAlertSettings(page, listName) {
  // 条件設定
  const conditionBtn = page.locator('div[class*="condition-"] button, button[aria-haspopup="menu"]').first();
  await clickBestEffort(conditionBtn, 5000);
  await page.waitForTimeout(800);
  
  const conditionItem = page.locator('[role="menuitem"], [role="option"]').filter({ hasText: ALERT_CONDITION_NAME }).first();
  if (await conditionItem.isVisible().catch(() => false)) {
    await conditionItem.click({ force: true });
  } else {
    console.warn(`Condition "${ALERT_CONDITION_NAME}" not found, using default.`);
    await page.keyboard.press("Escape");
  }
  await page.waitForTimeout(800);

  // 有効期限を最大（1年後など）に設定するロジック（必要なら）
  // ここではデフォルトのまま進める
}

async function ensure4HTimeframe(page) {
  const current = await getCurrentChartTimeframeText(page);
  if (isTarget4hText(current)) {
    console.log(`Already on 4H timeframe: ${current}`);
    return;
  }

  console.log(`Switching timeframe from "${current}" to 4H...`);
  const opened = await openChartTimeframeMenu(page);
  if (!opened) {
    // 直接入力
    await page.keyboard.type("240");
    await page.keyboard.press("Enter");
  } else {
    const item = page.locator('[role="menuitem"], [role="option"]').filter({ hasText: /^4 時間$|^4h$/i }).first();
    if (await item.isVisible().catch(() => false)) {
      await item.click({ force: true });
    } else {
      await page.keyboard.type("240");
      await page.keyboard.press("Enter");
    }
  }
  await page.waitForTimeout(2000);
}

async function getCurrentWatchlistHeaderState(page) {
  const header = page.locator('[class*="watchlistHeader"]');
  const text = await header.textContent().catch(() => "");
  const iconCount = await header.locator('svg').count().catch(() => 0);
  return { text, iconCount };
}

async function waitForWatchlistAlertMarker(page, listName, beforeIconCount) {
  for (let i = 0; i < 20; i++) {
    const { text, iconCount } = await getCurrentWatchlistHeaderState(page);
    if (text.includes(listName) && iconCount > beforeIconCount) {
      return true;
    }
    await page.waitForTimeout(1000);
  }
  return false;
}

async function assertManagedAlertCreated(page, listName) {
  await ensureAlertsPanelOpen(page);
  for (let i = 0; i < 10; i++) {
    const tickers = await getAllAlertTickerTexts(page);
    if (tickers.some(t => t.includes(listName))) return true;
    await page.waitForTimeout(1000);
  }
  throw new Error(`Alert for ${listName} not found in panel.`);
}

async function waitForTradingViewReady(page) {
  await page.waitForSelector('button[data-name="watchlists-button"]', { timeout: 30000 });
  console.log("TradingView UI ready and watchlist button visible.");
}

async function isChangeIntervalDialogOpen(page) {
  return await page.locator('div[role="dialog"]').filter({ hasText: /Change interval|時間足の変更/i }).isVisible().catch(() => false);
}

async function fill4HInChangeIntervalDialog(page) {
  const input = page.locator('div[role="dialog"] input').first();
  await input.fill("240");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(1000);
}

async function isWatchlistPromoDialogVisible(page) {
  return await page.locator('div[role="dialog"]').filter({ hasText: /Watchlist/i }).locator('button').filter({ hasText: /Close|閉じる/i }).isVisible().catch(() => false);
}

async function closeWatchlistPromoDialog(page) {
  const btn = page.locator('div[role="dialog"] button').filter({ hasText: /Close|閉じる/i }).first();
  await btn.click({ force: true });
}

async function describeLocator(locator) {
  try {
    return await locator.evaluate(el => ({
      tag: el.tagName,
      text: el.innerText,
      ariaLabel: el.getAttribute('aria-label'),
      dataName: el.getAttribute('data-name')
    }));
  } catch {
    return null;
  }
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
    t.startsWith("4h|") ||
    t.startsWith("4時間|")
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
  return "";
}

async function openChartTimeframeMenu(page) {
  const candidates = [
    page.locator('button[aria-haspopup="menu"][aria-label="4 時間"]').first(),
    page.locator('button[aria-haspopup="menu"][data-tooltip="4 時間"]').first(),
    page.locator('button[aria-haspopup="menu"][aria-label*="時間"]').first(),
    page.locator('button[aria-haspopup="menu"][data-tooltip*="時間"]').first(),
    page.locator('[data-name="header-toolbar-intervals"] button').first(),
  ];

  for (const c of candidates) {
    if (!(await c.count().catch(() => 0))) continue;
    if (!(await c.isVisible().catch(() => false))) continue;

    const clicked = await clickBestEffort(c, 4000);
    if (!clicked) continue;

    await page.waitForTimeout(1200);
    const root = page.locator('[role="menu"], [role="listbox"], div[data-name="menu-inner"]').first();
    if (await root.isVisible().catch(() => false)) return true;
  }
  return false;
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
    await waitForTradingViewReady(page);

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

      const remainAlerts = await getManagedAlertTickerTexts(page, [WATCHLIST_1_PREFIX, WATCHLIST_2_PREFIX]);
      if (remainAlerts.length > 0) {
        await safeScreenshot(page, "alerts_remain_after_delete");
        console.warn(`アラート削除後も残っています: ${remainAlerts.join(", ")}`);
        // 続行するかエラーにするか。ユーザーの要望は「狙い撃ち削除」なので、残っている場合はリトライするか警告を出す。
        // ここでは一旦警告に留め、処理を続行する（完全に消えない場合でもインポート等は進めたいため）
      }

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
    if (browser) await browser.close().catch(() => {});
    process.exit(1);
  }
})();
