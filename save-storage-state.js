const { chromium } = require("playwright");
const fs = require("fs");

(async () => {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    await page.goto("https://www.tradingview.com/#signin", { waitUntil: "domcontentloaded" });

    console.log("TradingView に手動ログインしてください。");
    console.log("2段階認証/CAPTCHA も完了し、チャート画面まで戻ったら Enter を押してください。");

    process.stdin.resume();
    await new Promise((resolve) => process.stdin.once("data", resolve));

    const state = await context.storageState();
    const tradingViewCookies = state.cookies.filter((cookie) =>
      /(^|\.)tradingview\.com$/i.test(cookie.domain || "")
    );
    const cookieNames = new Set(tradingViewCookies.map((cookie) => cookie.name));
    const requiredCookies = ["sessionid", "sessionid_sign"];
    const missing = requiredCookies.filter((name) => !cookieNames.has(name));

    if (missing.length > 0) {
      throw new Error(
        `TradingView のログインセッションCookieが不足しています: ${missing.join(", ")}。ログイン完了後にもう一度実行してください。`
      );
    }

    fs.writeFileSync("storageState.json", JSON.stringify(state));
    console.log("storageState.json を保存しました。");
    console.log("このファイル全体を GitHub Actions Secret の TRADINGVIEW_STORAGE_STATE に設定してください。");
  } finally {
    await browser.close();
  }
})().catch((err) => {
  console.error("FAILED:", err?.message || err);
  process.exit(1);
});
