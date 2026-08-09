const { chromium } = require('playwright');

const URL = 'https://qingmutec.feishu.cn/base/SaMJbxVT8aieonsxJ8PcCw9YnHh?table=tbl2PzLA34XmPYpm&view=vewN6keiIV';
const AUTH_FILE = 'playwright/.auth/feishu.json';

(async () => {
  const browser = await chromium.launch({ headless: false });

  const context = await browser.newContext({
    storageState: AUTH_FILE
  });

  const page = await context.newPage();

  await page.goto(URL, {
    waitUntil: 'domcontentloaded',
    timeout: 60000
  });

  console.log('FEISHU_BASE_OPENED');

  const tableText = page.getByText(/月维度付费渠道效果/, {
    exact: false
  }).first();

  await tableText.waitFor({
    state: 'visible',
    timeout: 60000
  });

  console.log('TABLE_FOUND');

  // 鼠标移到当前表，确保右侧菜单按钮显示
  await tableText.hover();
  await page.waitForTimeout(1000);

  const box = await tableText.boundingBox();

  if (!box) {
    throw new Error('TABLE_BOX_NOT_FOUND');
  }

  // 当前飞书左侧表项的 ⋮ 位于表名文本右侧
  await page.mouse.click(
    box.x + box.width + 20,
    box.y + box.height / 2
  );

  console.log('MENU_CLICK_ATTEMPT');

  await page.waitForTimeout(1000);

  const syncButton = page.getByText('同步数据', { exact: true }).filter({ visible: true }).first();

  await syncButton.waitFor({
    state: 'visible',
    timeout: 10000
  });

  console.log('SYNC_BUTTON_FOUND');
  console.log('LOCAL_BUTTON_CONFIRMED');

  // 本轮仍然只验证，不真正点击同步数据
  await page.waitForTimeout(5000);

  await browser.close();

})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
