const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright-core");
const { Browserbase } = require("@browserbasehq/sdk");

// ==============================
// 環境変数（GitHub Secrets / Variables 推奨）
// ==============================
const BROWSERBASE_API_KEY = process.env.BROWSERBASE_API_KEY;
const BROWSERBASE_PROJECT_ID = process.env.BROWSERBASE_PROJECT_ID;
const TRADINGVIEW_STORAGE_STATE = process.env.TRADINGVIEW_STORAGE_STATE; // storageState.json の中身(JSON文字列)

// 生成されたtxtの raw URL（watchlist generator 側が output/ にコミットしている前提）
const WATCHLIST_1_URL = process.env.WATCHLIST_1_URL; // 例: https://raw.githubusercontent.com/<user>/<repo>/main/output/tradingview_tse_price_le_1000_001.txt
const WATCHLIST_2_URL = process.env.WATCHLIST_2_URL; // 例: https://raw.githubusercontent.com/<user>/<repo>/main/output/tradingview_tse_price_le_1000_002.txt

// TradingView 側で作りたいウォッチリスト名
const WATCHLIST_1_NAME = process.env.WATCHLIST_1_NAME || "auto-list-001";
const WATCHLIST_2_NAME = process.env.WATCHLIST_2_NAME || "auto-list-002";

// 動作スイッチ
const DO_DELETE_ALERTS = (process.env.DO_DELETE_ALERTS || "true") === "true";
const DO_DELETE_WATCHLISTS = (process.env.DO_DELETE_WATCHLISTS || "true") === "true";
const DO_IMPORT_WATCHLISTS = (process.env.DO_IMPORT_WATCHLISTS || "true") === "true";

// 「ウォッチリスト全体アラート」作成（プラン/画面で無い場合があるので基本OFF推奨）
const DO_CREATE_WATCHLIST_ALERT = (process.env.DO_CREATE_WATCHLIST_ALERT || "false") === "true";

// アラート作成のパラメータ（watchlist alert が作れるUIがある場合にだけ使う）
const ALERT_NAME_PREFIX = process.env.ALERT_NAME_PREFIX || "AUTO_WL";
const ALERT_WEBHOOK_URL = process.env.ALERT_WEBHOOK_URL || ""; // TradingView 側で webhook を設定するUIがある場合に使用
const ALERT_MESSAGE = process.env.ALERT_MESSAGE || "AUTO|{{ticker}}|{{interval}}";

// タイムアウトなど
const NAV_TIMEOUT = 60_000;
const STEP_TIMEOUT = 30_000;

// 保存先
const WORKDIR = path.resolve(process.cwd(), "tmp");
const OUT1 = path.join(WORKDIR, "wl1.txt");
const OUT2 = path.join(WORKDIR, "wl2.txt");

function reqEnv(name, val) {
  if (!val) throw new Error(`Missing env: ${name}`);
}

async function ensureDir(p) {
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
    await ensureDir(WORKDIR);
    const p = path.join(WORKDIR, `screenshot_${Date.now()}_${label}.png`);
    await page.screenshot({ path: p, fullPage: true });
    console.log("Saved screenshot:", p);
  } catch (e) {
    console.log("Screenshot failed:", e?.message || e);
  }
}

// いろんなテキスト候補からボタン/メニューを探す（UI差分に強くする）
async function clickByText(page, texts, options = {}) {
  const { timeout = STEP_TIMEOUT } = options;
  for (const t of texts) {
    const loc = page.getByText(t, { exact: true });
    if (await loc.first().isVisible().catch(() => false)) {
      await loc.first().click({ timeout });
      return true;
    }
  }
  return false;
}

async function clickByPartialText(page, texts, options = {}) {
  const { timeout = STEP_TIMEOUT } = options;
  for (const t of texts) {
    const loc = page.getByText(t);
    if (await loc.first().isVisible().catch(() => false)) {
      await loc.first().click({ timeout });
      return true;
    }
  }
  return false;
}

// ヘッダー/サイドのどこかにある Watchlist/Alerts を開く（TradingView UI差分に対応）
async function openPanel(page, panel) {
  // panel: "watchlist" | "alerts"
  if (panel === "watchlist") {
    // 右側パネルの「Watchlist」ボタンや、上部の watchlist 表示を探す
    const ok =
      (await clickByPartialText(page, ["Watchlist", "ウォッチリスト"])) ||
      (await clickByPartialText(page, ["Lists", "リスト"])) ||
      false;
    return ok;
  }
  if (panel === "alerts") {
    const ok =
      (await clickByPartialText(page, ["Alerts", "アラート"])) ||
      (await clickByPartialText(page, ["Alert", "アラート"])) ||
      false;
    return ok;
  }
  return false;
}

// Watchlist UI の「リスト名ドロップダウン（現在のリスト名）」を開く
async function openWatchlistDropdown(page) {
  // TradingView は watchlist パネル上部に現在のリスト名が出ていてクリックでメニューが出ることが多い
  // うまく取れない場合は「…」「More」系も試す
  const candidates = [
    page.getByRole("button", { name: /watchlist/i }),
    page.getByRole("button", { name: /ウォッチリスト/i }),
    page.getByRole("button", { name: /list/i }),
    page.getByRole("button", { name: /リスト/i }),
    page.getByRole("button", { name: /more/i }),
    page.getByRole("button", { name: /その他|もっと|…/ }),
  ];

  for (const c of candidates) {
    if (await c.first().isVisible().catch(() => false)) {
      await c.first().click({ timeout: STEP_TIMEOUT }).catch(() => {});
      // ドロップダウンが開かなくても次候補へ
      await page.waitForTimeout(500);
    }
  }
}

// Watchlist の「Import list…」を探して押し、ファイルをアップロードする
async function importWatchlistFromFile(page, filePath, desiredName) {
  // 1) Watchlist パネルを開く
  await openPanel(page, "watchlist");
  await page.waitForTimeout(1000);

  // 2) Watchlist のメニューを開く（ドロップダウン/三点）
  await openWatchlistDropdown(page);
  await page.waitForTimeout(1000);

  // 3) Import list を探して押す
  const clicked = await clickByPartialText(page, [
    "Import list",
    "Import",
    "インポート",
    "リストをインポート",
    "Import watchlist",
    "インポートする",
  ]);

  if (!clicked) {
    // 右クリックメニュー等の場合もあるので、もう一回だけ試す
    await openWatchlistDropdown(page);
    const clicked2 = await clickByPartialText(page, ["Import list", "インポート"]);
    if (!clicked2) throw new Error("Import list... が見つかりませんでした（UIが違う可能性）");
  }

  // 4) ファイル選択（FileChooser or input[type=file]）
  // Playwright は file chooser を待つのが一番確実
  const [chooser] = await Promise.all([
    page.waitForEvent("filechooser", { timeout: STEP_TIMEOUT }).catch(() => null),
    page.waitForTimeout(500),
  ]);

  if (chooser) {
    await chooser.setFiles(filePath);
  } else {
    // input[type=file] があれば直接セット
    const input = page.locator('input[type="file"]').first();
    if (await input.isVisible().catch(() => false)) {
      await input.setInputFiles(filePath);
    } else {
      throw new Error("ファイル入力が見つかりませんでした");
    }
  }

  // 5) 名前入力が出る場合に備えて（任意）
  // 「List name」「Name」「名前」などの入力が出たら desiredName を入れる
  const nameInput = page.locator('input[placeholder*="name" i], input[placeholder*="Name" i], input[placeholder*="名前"], input[name*="name" i]').first();
  if (await nameInput.isVisible().catch(() => false)) {
    await nameInput.fill(desiredName).catch(() => {});
  }

  // 6) Confirm/OK/Import ボタン押下
  await clickByText(page, ["OK", "Ok", "Import", "インポート", "作成", "Create", "Save", "保存"]).catch(() => {});
  await page.waitForTimeout(2000);
}

// Watchlist を削除（リスト名から削除を試す）
async function deleteWatchlistByName(page, listName) {
  await openPanel(page, "watchlist");
  await page.waitForTimeout(1000);

  // リスト名を探して開く
  // UIによっては watchlist ドロップダウン内に一覧がある
  await openWatchlistDropdown(page);
  await page.waitForTimeout(800);

  const found = await page.getByText(listName).first().isVisible().catch(() => false);
  if (!found) {
    // 一覧が出てない場合は検索窓を探す
    const search = page.locator('input[placeholder*="Search" i], input[placeholder*="検索"]').first();
    if (await search.isVisible().catch(() => false)) {
      await search.fill(listName).catch(() => {});
      await page.waitForTimeout(500);
    }
  }

  const item = page.getByText(listName).first();
  if (!(await item.isVisible().catch(() => false))) {
    console.log(`Watchlist "${listName}" not found. skip delete.`);
    return;
  }

  // 右クリックメニューで Delete を探す
  await item.click({ button: "right", timeout: STEP_TIMEOUT }).catch(async () => {
    // 右クリックできないUIもあるので、普通クリック→三点→Deleteも試す
    await item.click({ timeout: STEP_TIMEOUT }).catch(() => {});
  });

  await page.waitForTimeout(500);

  const clicked = await clickByPartialText(page, ["Delete", "削除", "Remove", "削除する"]);
  if (!clicked) {
    // 3点メニューを探す
    const more = page.getByRole("button", { name: /more|…|その他|オプション/i }).first();
    if (await more.isVisible().catch(() => false)) {
      await more.click().catch(() => {});
      await page.waitForTimeout(500);
      await clickByPartialText(page, ["Delete", "削除", "Remove"]);
    }
  }

  // 確認ダイアログ
  await clickByText(page, ["Delete", "削除", "OK", "Ok", "はい", "Yes"]).catch(() => {});
  await page.waitForTimeout(1200);
}

// アラート全削除（UI差分が大きいので「見える範囲で全部削除」方式）
async function deleteAllAlerts(page) {
  await openPanel(page, "alerts");
  await page.waitForTimeout(1500);

  // 「Manage alerts」「…」などから “Remove all” がある場合はそれを優先
  const bulkOk =
    (await clickByPartialText(page, ["More", "…", "Manage", "管理"])) &&
    (await clickByPartialText(page, ["Remove all", "Delete all", "すべて削除", "全削除"]));
  if (bulkOk) {
    await clickByText(page, ["OK", "Ok", "Yes", "はい", "Delete", "削除"]).catch(() => {});
    await page.waitForTimeout(1500);
    return;
  }

  // 個別に削除：ゴミ箱/削除ボタンが並んでいるパターンに対応
  // 「Delete」アイコンが見える要素を順にクリック
  for (let i = 0; i < 50; i++) {
    const trash = page.locator('button[title*="Delete" i], button[aria-label*="Delete" i], button:has-text("Delete"), button:has-text("削除")').first();
    if (!(await trash.isVisible().catch(() => false))) break;
    await trash.click().catch(() => {});
    await page.waitForTimeout(400);
    await clickByText(page, ["OK", "Ok", "Yes", "はい", "Delete", "削除"]).catch(() => {});
    await page.waitForTimeout(600);
  }
}

// （オプション）ウォッチリスト全体アラート作成：画面/プランで存在しない場合がある
async function createWatchlistAlertIfPossible(page, listName) {
  await openPanel(page, "alerts");
  await page.waitForTimeout(1200);

  // Create alert
  const ok = await clickByPartialText(page, ["Create alert", "Create Alert", "アラートを作成", "アラート作成", "New alert", "新しいアラート"]);
  if (!ok) {
    console.log("Create alert button not found. skip.");
    return;
  }

  await page.waitForTimeout(1200);

  // ここから先は UI 依存がかなり強いので、できる範囲での自動化
  // 例：watchlist（複数銘柄）を選ぶドロップダウンがあれば listName を選ぶ
  const wlDropdown = page.locator('text=/Watchlist|ウォッチリスト/i').first();
  if (await wlDropdown.isVisible().catch(() => false)) {
    await wlDropdown.click().catch(() => {});
    await page.waitForTimeout(600);
    await page.getByText(listName).first().click().catch(() => {});
  }

  // alert name
  const nameInput = page.locator('input[placeholder*="Name" i], input[placeholder*="名前"], input[name*="name" i]').first();
  if (await nameInput.isVisible().catch(() => false)) {
    await nameInput.fill(`${ALERT_NAME_PREFIX}_${listName}`).catch(() => {});
  }

  // webhook
  if (ALERT_WEBHOOK_URL) {
    const webhookToggle = page.getByText(/Webhook|webhook|ウェブフック/i).first();
    if (await webhookToggle.isVisible().catch(() => false)) {
      await webhookToggle.click().catch(() => {});
      await page.waitForTimeout(300);
    }
    const webhookInput = page.locator('input[placeholder*="Webhook" i], input[name*="webhook" i], textarea').first();
    if (await webhookInput.isVisible().catch(() => false)) {
      await webhookInput.fill(ALERT_WEBHOOK_URL).catch(() => {});
    }
  }

  // message
  const msgInput = page.locator('textarea, input[placeholder*="Message" i], input[placeholder*="メッセージ"]').first();
  if (await msgInput.isVisible().catch(() => false)) {
    await msgInput.fill(ALERT_MESSAGE).catch(() => {});
  }

  // Create
  await clickByText(page, ["Create", "作成", "OK", "Ok", "Save", "保存"]).catch(() => {});
  await page.waitForTimeout(1500);
}

(async () => {
  try {
    reqEnv("BROWSERBASE_API_KEY", BROWSERBASE_API_KEY);
    reqEnv("BROWSERBASE_PROJECT_ID", BROWSERBASE_PROJECT_ID);
    reqEnv("TRADINGVIEW_STORAGE_STATE", TRADINGVIEW_STORAGE_STATE);
    reqEnv("WATCHLIST_1_URL", WATCHLIST_1_URL);
    reqEnv("WATCHLIST_2_URL", WATCHLIST_2_URL);

    await ensureDir(WORKDIR);

    console.log("Downloading watchlists...");
    await downloadToFile(WATCHLIST_1_URL, OUT1);
    await downloadToFile(WATCHLIST_2_URL, OUT2);

    console.log("Starting Browserbase session...");
    const bb = new Browserbase({ apiKey: BROWSERBASE_API_KEY });
    const session = await bb.sessions.create({ projectId: BROWSERBASE_PROJECT_ID });

    const browser = await chromium.connectOverCDP(session.connectUrl);

    const storageState = JSON.parse(TRADINGVIEW_STORAGE_STATE);
    const context = await browser.newContext({ storageState });
    const page = await context.newPage();

    page.setDefaultTimeout(STEP_TIMEOUT);
    page.setDefaultNavigationTimeout(NAV_TIMEOUT);

    console.log("Opening TradingView...");
    await page.goto("https://www.tradingview.com/chart/", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(5000);

    // ログインが切れてるとここでサインインを促すUIになることが多い
    const maybeSignIn = await page.getByText(/Sign in|ログイン/i).first().isVisible().catch(() => false);
    if (maybeSignIn) {
      await safeScreenshot(page, "need_login");
      throw new Error("TradingView がログイン状態ではありません（storageState が無効/期限切れ）。再取得してください。");
    }

    // 1) アラート全削除
    if (DO_DELETE_ALERTS) {
      console.log("Deleting alerts...");
      await deleteAllAlerts(page);
    }

    // 2) ウォッチリスト削除（任意）
    if (DO_DELETE_WATCHLISTS) {
      console.log("Deleting watchlists...");
      await deleteWatchlistByName(page, WATCHLIST_1_NAME);
      await deleteWatchlistByName(page, WATCHLIST_2_NAME);
    }

    // 3) インポート
    if (DO_IMPORT_WATCHLISTS) {
      console.log("Importing watchlists...");
      await importWatchlistFromFile(page, OUT1, WATCHLIST_1_NAME);
      await importWatchlistFromFile(page, OUT2, WATCHLIST_2_NAME);
    }

    // 4) ウォッチリスト全体アラート作成（プラン/UIにある場合のみ）
    if (DO_CREATE_WATCHLIST_ALERT) {
      console.log("Creating watchlist alerts (if possible)...");
      await createWatchlistAlertIfPossible(page, WATCHLIST_1_NAME);
      await createWatchlistAlertIfPossible(page, WATCHLIST_2_NAME);
    }

    console.log("DONE.");
    await safeScreenshot(page, "done");
    await browser.close();
  } catch (err) {
    console.error("FAILED:", err?.message || err);
    // 可能ならスクショ
    try {
      // page がスコープ外になり得るので握りつぶし
    } catch (_) {}
    process.exit(1);
  }
})();
