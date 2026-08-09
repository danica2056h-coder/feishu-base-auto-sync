const { chromium } = require('playwright');

const URL = 'https://qingmutec.feishu.cn/base/SaMJbxVT8aieonsxJ8PcCw9YnHh?table=tbl2PzLA34XmPYpm&view=vewN6keiIV';
const AUTH_FILE = 'playwright/.auth/feishu.json';

const fail = (code) => { throw new Error(code); };

(async () => {
  let browser;

  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ storageState: AUTH_FILE });
    const page = await context.newPage();

    await page.goto(URL, {
      waitUntil: 'domcontentloaded',
      timeout: 60_000
    }).catch(() => fail('BASE_OPEN_FAILED'));

    if (/login|accounts/i.test(page.url()) ||
        await page.getByText(/登录|扫码登录|验证码/).filter({ visible: true }).first().isVisible().catch(() => false)) {
      fail('CLOUD_SESSION_REJECTED');
    }

    const tableText = page.getByText(/月维度付费渠道效果/, { exact: false }).first();
    await tableText.waitFor({ state: 'visible', timeout: 60_000 }).catch(() => fail('TABLE_NOT_FOUND'));

    await tableText.hover();
    await page.waitForTimeout(1000);

    const box = await tableText.boundingBox();
    if (!box) fail('MENU_NOT_FOUND');

    await page.mouse.click(box.x + box.width + 20, box.y + box.height / 2);
    await page.waitForTimeout(1000);

    const syncButton = page.getByText('同步数据', { exact: true }).filter({ visible: true }).first();
    await syncButton.waitFor({ state: 'visible', timeout: 10_000 }).catch(() => fail('SYNC_BUTTON_NOT_FOUND'));

    const lastSync = page.getByText(/上次同步|最近同步/, { exact: false }).filter({ visible: true }).first();
    const before = await lastSync.textContent().catch(() => null);

    await syncButton.click();

    const successToast = page.getByText(/同步成功|同步完成|数据同步完成/, { exact: false })
      .filter({ visible: true }).first();

    const confirmed = await Promise.any([
      successToast.waitFor({ state: 'visible', timeout: 120_000 }).then(() => true),
      page.waitForFunction((oldText) => {
        if (!oldText) return false;
        const rows = document.body.innerText.split('\n');
        const current = rows.find((row) => /上次同步|最近同步/.test(row));
        return Boolean(current && current !== oldText);
      }, before, { timeout: 120_000 }).then(() => true)
    ]).catch(() => false);

    if (!confirmed) fail('SYNC_NOT_CONFIRMED');
    console.log('SYNC_SUCCESS');
  } catch (error) {
    const code = String(error.message || error);
    const allowed = new Set([
      'CLOUD_SESSION_REJECTED',
      'BASE_OPEN_FAILED',
      'TABLE_NOT_FOUND',
      'MENU_NOT_FOUND',
      'SYNC_BUTTON_NOT_FOUND',
      'SYNC_TIMEOUT',
      'SYNC_NOT_CONFIRMED'
    ]);
    console.error(allowed.has(code) ? code : 'SYNC_TIMEOUT');
    process.exitCode = 1;
  } finally {
    await browser?.close().catch(() => {});
  }
})();
