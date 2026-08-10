const AUTH_FILE = 'playwright/.auth/feishu.json';
const BASE_URL = process.env.FEISHU_BASE_URL || process.argv[2];
const MENU_TEXT = '同步数据';
const TABLE_NAME_SELECTOR = '.bitable-new-table-tab__item-name';
const TABLE_ROW_XPATH = 'xpath=ancestor::div[contains(@class,"bitable-new-table-item")][1]';
const CONNECTOR_ICON_SELECTOR = '.sync-icon-wrapper';
const TABLE_MENU_SELECTOR = '.bitable-new-table-tab__item-icons';
const TABLE_SCAN_TIMEOUT_MS = 3_000;
const SYNC_CONFIRM_TIMEOUT_MS = 120_000;
const MAX_BASE_DURATION_MS = 8 * 60_000;

class SyncError extends Error {
  constructor(code) { super(code); this.code = code; }
}

const visible = async (locator) => locator.isVisible().catch(() => false);
const fail = (code) => { throw new SyncError(code); };

function cleanName(value) {
  return String(value || '').split('\n').map((part) => part.trim()).find(Boolean) || '';
}

function errorCode(error) {
  return error?.code || error?.message || 'SYNC_FAILED';
}

function remainingMs(deadline) {
  return Math.max(0, deadline - Date.now());
}

async function withTimeout(promise, timeoutMs, code) {
  if (timeoutMs <= 0) fail(code);
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new SyncError(code)), timeoutMs);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function assertAuthenticated(page) {
  const loginText = page.getByText(/登录|扫码登录|验证码/).filter({ visible: true }).first();
  if (/login|accounts/i.test(page.url()) || await visible(loginText)) fail('CLOUD_SESSION_REJECTED');
}

async function snapshotTableNames(page, deadline) {
  const timeout = Math.min(10_000, remainingMs(deadline));
  const names = await withTimeout(
    page.locator(TABLE_NAME_SELECTOR).filter({ visible: true }).allTextContents(),
    timeout,
    'TABLE_LIST_TIMEOUT'
  );
  return [...new Set(names.map(cleanName).filter(Boolean))];
}

async function findTableRow(page, tableName, timeoutMs = TABLE_SCAN_TIMEOUT_MS) {
  const names = page.locator(TABLE_NAME_SELECTOR).filter({ visible: true });
  const count = await withTimeout(names.count(), timeoutMs, 'TABLE_RELOCATE_TIMEOUT');

  for (let index = 0; index < count; index += 1) {
    const name = cleanName(await withTimeout(
      names.nth(index).innerText({ timeout: timeoutMs }),
      timeoutMs,
      'TABLE_RELOCATE_TIMEOUT'
    ));
    if (name === tableName) return names.nth(index).locator(TABLE_ROW_XPATH);
  }
  fail('TABLE_NOT_FOUND_AFTER_REFRESH');
}

async function detectConnector(page, tableName) {
  // Always re-read the current sidebar DOM. A completed sync can rerender every row.
  const row = await findTableRow(page, tableName, TABLE_SCAN_TIMEOUT_MS);
  return visible(row.locator(CONNECTOR_ICON_SELECTOR).first());
}

async function openTableMenu(page, tableName, deadline) {
  // Re-locate again immediately before interaction; never reuse a row from detection.
  const timeout = Math.min(TABLE_SCAN_TIMEOUT_MS, remainingMs(deadline));
  const row = await findTableRow(page, tableName, timeout);
  await row.hover({ timeout });
  const menuButton = row.locator(TABLE_MENU_SELECTOR).first();
  await menuButton.click({ timeout });
  const syncButton = page.getByText(MENU_TEXT, { exact: true }).filter({ visible: true }).first();
  await syncButton.waitFor({ state: 'visible', timeout });
  return syncButton;
}

function successToastLocator(page) {
  return page.getByText(/同步成功|同步完成|数据同步完成/, { exact: false })
    .filter({ visible: true }).first();
}

async function waitForSync(page, previousText, timeoutMs, allowToast) {
  const toastPromise = allowToast
    ? successToastLocator(page).waitFor({ state: 'visible', timeout: timeoutMs }).then(() => true)
    : Promise.reject(new Error('STALE_SUCCESS_TOAST'));
  const changedPromise = previousText
    ? page.waitForFunction((oldText) => {
        const current = document.body.innerText.split('\n').find((row) => /上次同步|最近同步/.test(row));
        return Boolean(current && current !== oldText);
      }, previousText, { timeout: timeoutMs }).then(() => true)
    : new Promise((_, reject) => setTimeout(() => reject(new Error('NO_PREVIOUS_SYNC_TEXT')), timeoutMs));
  return Promise.any([toastPromise, changedPromise]).catch(() => false);
}

async function syncTable(page, tableName, deadline) {
  const previousToast = successToastLocator(page);
  if (await visible(previousToast)) {
    await previousToast.waitFor({ state: 'hidden', timeout: TABLE_SCAN_TIMEOUT_MS }).catch(() => {});
  }
  const allowToast = !await visible(previousToast);
  const syncButton = await openTableMenu(page, tableName, deadline);
  const lastSync = page.getByText(/上次同步|最近同步/, { exact: false }).filter({ visible: true }).first();
  const before = await lastSync.textContent({ timeout: TABLE_SCAN_TIMEOUT_MS }).catch(() => null);
  await syncButton.click({ timeout: Math.min(TABLE_SCAN_TIMEOUT_MS, remainingMs(deadline)) });
  const confirmTimeout = Math.min(SYNC_CONFIRM_TIMEOUT_MS, remainingMs(deadline));
  if (!await waitForSync(page, before, confirmTimeout, allowToast)) fail('SYNC_NOT_CONFIRMED');
}

async function processTableNames(page, tableNames, options = {}) {
  const deadline = options.deadline || Date.now() + MAX_BASE_DURATION_MS;
  const inspect = options.detectConnector || detectConnector;
  const sync = options.syncTable || syncTable;
  const log = options.log || console.log;
  const scanTimeoutMs = options.scanTimeoutMs || TABLE_SCAN_TIMEOUT_MS;
  const stats = options.stats || {
    totalTables: tableNames.length,
    connectorTablesFound: 0,
    syncSuccessCount: 0,
    syncFailedCount: 0,
    successfulTableNames: []
  };

  for (const tableName of tableNames) {
    if (remainingMs(deadline) <= 0) fail('BASE_TIMEOUT_8_MINUTES');
    log(`TABLE_SCAN_START=${tableName}`);

    let isConnector;
    try {
      isConnector = await withTimeout(
        Promise.resolve().then(() => inspect(page, tableName)),
        Math.min(scanTimeoutMs, remainingMs(deadline)),
        'TABLE_SCAN_TIMEOUT'
      );
    } catch (error) {
      stats.syncFailedCount += 1;
      log(`TABLE_SCAN_ERROR=${tableName}`);
      log(`ERROR=${errorCode(error)}`);
      continue;
    }

    if (!isConnector) {
      log(`TABLE_SKIP_NO_CONNECTOR=${tableName}`);
      continue;
    }

    stats.connectorTablesFound += 1;
    log(`TABLE_SYNC_START=${tableName}`);
    try {
      await sync(page, tableName, deadline);
      stats.syncSuccessCount += 1;
      stats.successfulTableNames.push(tableName);
      log(`TABLE_SYNC_SUCCESS=${tableName}`);
    } catch (error) {
      stats.syncFailedCount += 1;
      log(`TABLE_SCAN_ERROR=${tableName}`);
      log(`ERROR=${errorCode(error)}`);
      await page.keyboard.press('Escape').catch(() => {});
    }
  }
  return stats;
}

function printSummary(stats) {
  console.log(`TOTAL_TABLES=${stats.totalTables}`);
  console.log(`CONNECTOR_TABLES_FOUND=${stats.connectorTablesFound}`);
  console.log(`SYNC_SUCCESS_COUNT=${stats.syncSuccessCount}`);
  console.log(`SYNC_FAILED_COUNT=${stats.syncFailedCount}`);
  console.log(`SYNC_SUCCESS_NAMES=${JSON.stringify(stats.successfulTableNames)}`);
}

async function run() {
  if (!BASE_URL) fail('BASE_URL_MISSING');
  const { chromium } = require('playwright');
  const deadline = Date.now() + MAX_BASE_DURATION_MS;
  const stats = {
    totalTables: 0,
    connectorTablesFound: 0,
    syncSuccessCount: 0,
    syncFailedCount: 0,
    successfulTableNames: []
  };
  let browser;
  console.log(`BASE=${BASE_URL}`);

  try {
    browser = await withTimeout(chromium.launch({ headless: true }), remainingMs(deadline), 'BASE_TIMEOUT_8_MINUTES');
    const context = await browser.newContext({ storageState: AUTH_FILE });
    const page = await context.newPage();
    await page.goto(BASE_URL, {
      waitUntil: 'domcontentloaded',
      timeout: Math.min(60_000, remainingMs(deadline))
    }).catch(() => fail('BASE_OPEN_FAILED'));
    await assertAuthenticated(page);

    const tableNames = await snapshotTableNames(page, deadline);
    if (!tableNames.length) fail('TABLE_LIST_NOT_FOUND');
    stats.totalTables = tableNames.length;
    await processTableNames(page, tableNames, { deadline, stats });

    if (!stats.connectorTablesFound) fail('NO_SYNCABLE_TABLES');
    if (stats.syncFailedCount) fail('BASE_PARTIAL_FAILURE');
    console.log('BASE_SYNC_SUCCESS');
  } finally {
    printSummary(stats);
    await browser?.close().catch(() => {});
  }
}

if (require.main === module) {
  run().catch((error) => {
    console.error(`ERROR=${errorCode(error)}`);
    process.exitCode = 1;
  });
}

module.exports = {
  cleanName,
  detectConnector,
  findTableRow,
  processTableNames,
  snapshotTableNames,
  withTimeout
};
