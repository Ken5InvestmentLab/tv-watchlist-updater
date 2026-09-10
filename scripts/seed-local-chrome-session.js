const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const stateCandidates = [
  path.resolve(__dirname, "..", "storageState.json"),
  path.resolve(__dirname, "..", "..", "tv-watchlist-updater-main", "tv-watchlist-updater-main", "storageState.json"),
];
const statePath = stateCandidates.find((candidate) => fs.existsSync(candidate));
if (!statePath) {
  throw new Error("No local storageState.json was found. Capture a TradingView session first.");
}

(async () => {
  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
  const context = browser.contexts()[0];
  if (!context) throw new Error("The local Chrome debugging endpoint has no browser context.");

  await context.addCookies(state.cookies || []);
  for (const origin of state.origins || []) {
    if (!origin.origin || !origin.localStorage?.length) continue;
    const page = await context.newPage();
    await page.goto(origin.origin, { waitUntil: "domcontentloaded" }).catch(() => {});
    await page.evaluate((items) => {
      for (const item of items) localStorage.setItem(item.name, item.value);
    }, origin.localStorage);
    await page.close();
  }

  const page = await context.newPage();
  await page.goto("https://www.tradingview.com/chart/", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);
  console.log(JSON.stringify({ url: page.url(), title: await page.title() }));
  // Keep Chrome open; the updater owns only this tab.
  process.exit(0);
})().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
