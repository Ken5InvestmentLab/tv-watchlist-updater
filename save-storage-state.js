const { chromium } = require("playwright");
const fs = require("fs");

(async () => {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.goto("https://www.tradingview.com/#signin", { waitUntil: "domcontentloaded" });

  console.log("TradingView に手動ログインしてください。");
  console.log("2段階認証も完了したら Enter を押してください。");

  process.stdin.resume();
  process.stdin.once("data", async () => {
    const state = await context.storageState();
    fs.writeFileSync("storageState.json", JSON.stringify(state));
    console.log("storageState.json を保存しました。");
    await browser.close();
    process.exit(0);
  });
})();
