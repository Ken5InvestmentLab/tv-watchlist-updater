const { chromium } = require('playwright-core');
const { Browserbase } = require('@browserbasehq/sdk');

(async () => {
  const bb = new Browserbase({
    apiKey: process.env.BROWSERBASE_API_KEY,
  });

  const session = await bb.sessions.create({
    projectId: process.env.BROWSERBASE_PROJECT_ID,
  });

  const browser = await chromium.connectOverCDP(session.connectUrl);

  const storageState = JSON.parse(process.env.TRADINGVIEW_STORAGE_STATE);
  const context = await browser.newContext({ storageState });
  const page = await context.newPage();

  await page.goto('https://www.tradingview.com/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(8000);

  console.log('TradingView をログイン済み状態で開こうとしました');

  // ログイン済みかざっくり確認するためにURLとタイトルを出す
  console.log('Current URL:', page.url());
  console.log('Page title:', await page.title());

  await browser.close();
})();
