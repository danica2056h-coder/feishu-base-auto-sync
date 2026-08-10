const AUTH_FILE = 'playwright/.auth/feishu.json';
const BASE_URL = process.env.FEISHU_BASE_URL || process.argv[2];
const MENU_TEXT = '同步数据';
const TABLE_ITEM_SELECTORS = [
  '[role="treeitem"]',
  '[data-testid*="table-item"]',
  '[data-entity-type="table"]'
].join(',');

class SyncError extends Error {
  constructor(code) { super(code); this.code = code; }
}

const visible = async (locator) => locator.isVisible().catch(() => false);
const fail = (code) => { throw new SyncError(code); };

function cleanName(value) {
  return String(value || '').split('\n').map((part) => part.trim()).find(Boolean) || '';
}

async function assertAuthenticated(page) {
  const loginText = page.getByText(/登录|扫码登录|验证码/).filter({ visible: true }).first();
  if (/login|accounts/i.test(page.url()) || await visible(loginText)) fail('CLOUD_SESSION_REJECTED');
}

async function sidebarTableItems(page) {
  await page.waitForTimeout(2_000);
  const direct = page.locator(TABLE_ITEM_SELECTORS).filter({ visible: true });
  const count = await direct.count();
  const candidates = [];

  for (let index = 0; index < count; index += 1) {
    const item = direct.nth(index);
    const name = cleanName(await item.innerText().catch(() => ''));
    const box = await item.boundingBox().catch(() => null);
    if (name && box && box.width > 20 && box.height >= 18) candidates.push({ item, name, box });
  }

  if (candidates.length) return deduplicate(candidates);

  // Feishu occasionally removes semantic roles. Restrict the geometric scan to the
  // left navigation rail; table names remain visible text and are never hard-coded.
  const viewport = page.viewportSize() || { width: 1280, height: 720 };
  const textNodes = page.locator('div,span').filter({ visible: true });
  const textCount = await textNodes.count();
  for (let index = 0; index < Math.min(textCount, 1_500); index += 1) {
    const item = textNodes.nth(index);
    const box = await item.boundingBox().catch(() => null);
    if (!box || box.x > viewport.width * 0.34 || box.height < 18 || box.height > 52 || box.width < 30) continue;
    const name = cleanName(await item.innerText().catch(() => ''));
    if (!name || name.length > 100) continue;
    candidates.push({ item, name, box });
  }
  return deduplicate(candidates);
}

function deduplicate(candidates) {
  const seen = new Set();
  return candidates.filter(({ name, box }) => {
    const key = `${name}|${Math.round(box.y / 3)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((a, b) => a.box.y - b.box.y);
}

async function openTableMenu(page, candidate) {
  await candidate.item.hover().catch(() => {});
  await page.waitForTimeout(350);

  const localMenu = candidate.item.locator('button,[role="button"]').filter({ visible: true }).last();
  if (await visible(localMenu)) {
    await localMenu.click().catch(() => {});
  } else {
    const current = await candidate.item.boundingBox().catch(() => candidate.box);
    await page.mouse.click(current.x + current.width + 18, current.y + current.height / 2);
  }
  await page.waitForTimeout(500);
  return page.getByText(MENU_TEXT, { exact: true }).filter({ visible: true }).first();
}

async function waitForSync(page, previousText) {
  const successToast = page.getByText(/同步成功|同步完成|数据同步完成/, { exact: false })
    .filter({ visible: true }).first();
  const toastPromise = successToast.waitFor({ state: 'visible', timeout: 120_000 }).then(() => true);
  const changedPromise = previousText
    ? page.waitForFunction((oldText) => {
        const current = document.body.innerText.split('\n').find((row) => /上次同步|最近同步/.test(row));
        return Boolean(current && current !== oldText);
      }, previousText, { timeout: 120_000 }).then(() => true)
    : new Promise((_, reject) => setTimeout(() => reject(new Error('NO_PREVIOUS_SYNC_TEXT')), 120_000));
  return Promise.any([toastPromise, changedPromise]).catch(() => false);
}

async function syncCandidate(page, candidate) {
  const syncButton = await openTableMenu(page, candidate);
  if (!await visible(syncButton)) {
    await page.keyboard.press('Escape').catch(() => {});
    return { syncable: false };
  }

  console.log(`TABLE_FOUND=${candidate.name}`);
  console.log(`TABLE_SYNC_START=${candidate.name}`);
  const lastSync = page.getByText(/上次同步|最近同步/, { exact: false }).filter({ visible: true }).first();
  const before = await lastSync.textContent().catch(() => null);
  await syncButton.click();
  if (!await waitForSync(page, before)) throw new SyncError('SYNC_NOT_CONFIRMED');
  console.log(`TABLE_SYNC_SUCCESS=${candidate.name}`);
  return { syncable: true };
}

async function run() {
  if (!BASE_URL) fail('BASE_URL_MISSING');
  const { chromium } = require('playwright');
  let browser;
  let total = 0;
  let success = 0;
  let failed = 0;
  console.log(`BASE=${BASE_URL}`);

  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ storageState: AUTH_FILE });
    const page = await context.newPage();
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 })
      .catch(() => fail('BASE_OPEN_FAILED'));
    await assertAuthenticated(page);

    const candidates = await sidebarTableItems(page);
    if (!candidates.length) fail('TABLE_LIST_NOT_FOUND');

    for (const candidate of candidates) {
      try {
        const result = await syncCandidate(page, candidate);
        if (result.syncable) { total += 1; success += 1; }
      } catch (error) {
        total += 1;
        failed += 1;
        console.error(`FAILED_TABLE=${candidate.name}`);
        console.error(`ERROR=${error.code || error.message || 'SYNC_FAILED'}`);
        await page.keyboard.press('Escape').catch(() => {});
      }
    }

    console.log(`TOTAL_SYNCABLE_TABLES=${total}`);
    console.log(`SUCCESS=${success}`);
    console.log(`FAILED=${failed}`);
    if (!total) fail('NO_SYNCABLE_TABLES');
    if (failed) fail('BASE_PARTIAL_FAILURE');
    console.log('BASE_SYNC_SUCCESS');
  } finally {
    await browser?.close().catch(() => {});
  }
}

if (require.main === module) {
  run().catch((error) => {
    console.error(`ERROR=${error.code || error.message || 'SYNC_FAILED'}`);
    process.exitCode = 1;
  });
}

module.exports = { cleanName, deduplicate, run };
