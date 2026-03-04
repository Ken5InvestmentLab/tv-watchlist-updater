const fs = require('fs');
const { chromium } = require('playwright-core');
const { Browserbase } = require('@browserbasehq/sdk');

(async () => {
  const bb = new Browserbase({
    apiKey: process.env.BROWSERBASE_API_KEY,
  });

  const session = await bb.sessions.create({
    projectId: process.env.BROWSERBASE_PROJECT_ID,
  });

  const wsUrl = session.connectUrl;
  const browser = await chromium.connectOverCDP(wsUrl);

  const storageState = JSON.parse(process.env.TRADINGVIEW_STORAGE_STATE);
  const context = await browser.newContext({ storageState });
  const page = await context.newPage();

  await page.goto('https://www.tradingview.com/');
  await page.waitForTimeout(5000);

  console.log('TradingView を開きました');

  await browser.close();
})();
