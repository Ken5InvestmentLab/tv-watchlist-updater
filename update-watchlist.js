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

const WATCHLIST_1_NAME = process.env.WATCHLIST_1_NAME || "auto-list-001";
const WATCHLIST_2_NAME = process.env.WATCHLIST_2_NAME || "auto-list-002";

const DO_DELETE_ALERTS = (process.env.DO_DELETE_ALERTS || "false") === "true";
const DO_DELETE_WATCHLISTS = (process.env.DO_DELETE_WATCHLISTS || "false") === "true";
const DO_IMPORT_WATCHLISTS = (process.env.DO_IMPORT_WATCHLISTS || "true") === "true";
const DO_CREATE_WATCHLIST_ALERT = (process.env.DO_CREATE_WATCHLIST_ALERT || "false") === "true";

const NAV_TIMEOUT = 60000;
const STEP_TIMEOUT = 30000;

const WORKDIR = path.resolve(process.cwd(), "tmp");
const OUT1 = path.join(WORKDIR, "wl1.txt");
const OUT2 = path.join(WORKDIR, "wl2.txt");

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
  if (!res.ok) {
    throw new Error(`Download failed ${res.status}: ${url}`);
  }
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

async function isVisible(locator) {
  return await locator.first().isVisible().catch(() => false);
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

// ==============================
// TradingView UI Actions
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

  await page.waitForTimeout(2000);
}

async function ensureWatchlistPanelOpen(page) {
  const menuButton = page.locator('button[data-name="watchlists-button"]').first();
  if (await menuButton.isVisible().catch(() => false)) {
    return;
  }

  await openWatchlistPanel(page);
  await page.waitForTimeout(2000);

  const stillNotVisible = !(await menuButton.isVisible().catch(() => false));
  if (stillNotVisible) {
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

async function clickUploadList(page) {
  const menuRootCandidates = [
    page.locator('[data-name="active-watchlist-menu"]').first(),
    page.locator('[data-qa-id="popup-menu-container"]').first(),
    page.locator('[role="menu"]').first(),
    page.locator('div[data-role="menu-inner"]').first(),
  ];

  let scopedRoot = page;
  for (const root of menuRootCandidates) {
    if (await root.isVisible().catch(() => false)) {
      scopedRoot = root;
      break;
    }
  }

  const candidates = [
    scopedRoot.locator('div[data-role="menuitem"]').filter({ hasText: "リストをアップロード…" }),
    scopedRoot.locator('div[data-role="menuitem"]').filter({ hasText: "リストをアップロード..." }),
    scopedRoot.locator('div[data-role="menuitem"]').filter({ hasText: /リストをアップロード/ }),
    scopedRoot.locator('div[data-role="menuitem"]').filter({ hasText: /Upload list/i }),
    scopedRoot.locator('div[data-role="menuitem"] span.label-jFqVJoPk').filter({ hasText: /リストをアップロード|Upload list/i }).locator(".."),
  ];

  for (const locator of candidates) {
    const el = locator.first();
    if (!(await el.isVisible().catch(() => false))) continue;
    await el.scrollIntoViewIfNeeded().catch(() => {});
    const clicked = await el.click({ timeout: 5000, force: true }).then(() => true).catch(() => false);
    if (clicked) {
      await page.waitForTimeout(1000);
      return true;
    }
  }

  await safeScreenshot(page, "upload_list_menuitem_not_found");
  throw new Error("『リストをアップロード…』メニューが見つかりませんでした");
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

  const confirmed = await clickFirstVisible(confirmCandidates, { timeout: 3000 });
  if (filled || confirmed) {
    await page.waitForTimeout(1500);
  }
}

async function importWatchlistFromFile(page, filePath, desiredName) {
  await ensureWatchlistPanelOpen(page);
  await openWatchlistMenu(page);

  const [chooser] = await Promise.all([
    page.waitForEvent("filechooser", { timeout: 10000 }),
    clickUploadList(page),
  ]);

  await chooser.setFiles(filePath);
  await page.waitForTimeout(2500);

  await maybeRenameImportedList(page, desiredName);
  await page.waitForTimeout(2500);
}

// ==============================
// Placeholder functions
// ==============================
async function deleteAllAlerts(page) {
  console.log("DO_DELETE_ALERTS is true, but delete logic is currently disabled for stability.");
}

async function deleteWatchlistByName(page, listName) {
  console.log(`DO_DELETE_WATCHLISTS is true, but delete logic is currently disabled for stability. skip: ${listName}`);
}

async function createWatchlistAlertIfPossible(page, listName) {
  console.log(`DO_CREATE_WATCHLIST_ALERT is true, but create alert logic is currently disabled for stability. skip: ${listName}`);
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
      console.log("Deleting alerts...");
      await deleteAllAlerts(page);
    }

    if (DO_DELETE_WATCHLISTS) {
      console.log("Deleting watchlists...");
      await deleteWatchlistByName(page, WATCHLIST_1_NAME);
      await deleteWatchlistByName(page, WATCHLIST_2_NAME);
    }

    if (DO_IMPORT_WATCHLISTS) {
      console.log("Importing watchlists...");
      await importWatchlistFromFile(page, OUT1, WATCHLIST_1_NAME);
      await importWatchlistFromFile(page, OUT2, WATCHLIST_2_NAME);
    }

    if (DO_CREATE_WATCHLIST_ALERT) {
      console.log("Creating watchlist alerts...");
      await createWatchlistAlertIfPossible(page, WATCHLIST_1_NAME);
      await createWatchlistAlertIfPossible(page, WATCHLIST_2_NAME);
    }

    console.log("DONE.");
    await safeScreenshot(page, "done");

    await browser.close();
  } catch (err) {
    console.error("FAILED:", err?.message || err);

    if (page) {
      await safeScreenshot(page, "failed");
    }

    if (browser) {
      await browser.close().catch(() => {});
    }

    process.exit(1);
  }
})();
