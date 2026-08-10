const { chromium } = require('playwright');

const URL = process.env.FEISHU_BASE_URL;
const AUTH_FILE = 'playwright/.auth/feishu.json';

if (!URL) {
  console.error('FEISHU_BASE_URL_MISSING');
  process.exit(1);
}

(async () => {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  console.log('FEISHU_BASE_OPENED');
  console.log('Complete login, then press Enter in this terminal.');
  await new Promise((resolve) => process.stdin.once('data', resolve));
  await context.storageState({ path: AUTH_FILE });
  console.log('AUTH_SAVED');
  await browser.close();
})().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
