const AUTH_FILE = 'playwright/.auth/feishu.json';
const BASE_URL = process.env.FEISHU_BASE_URL || process.argv[2];
const MENU_TEXT = '同步数据';
const TABLE_NAME_SELECTOR = '.bitable-new-table-tab__item-name';
const TABLE_ROW_XPATH = 'xpath=ancestor::div[contains(@class,"bitable-new-table-item")][1]';
const CONNECTOR_ICON_SELECTOR = '.sync-icon-wrapper';
const TABLE_MENU_SELECTOR = '.bitable-new-table-tab__item-icons';
const TABLE_SCAN_TIMEOUT_MS = 3_000;
const SYNC_CONFIRM_TIMEOUT_MS = 60_000;
const SYNC_POLL_INTERVAL_MS = 1_500;
const MAX_BASE_DURATION_MS = 8 * 60_000;

class SyncError extends Error {
  constructor(code) { super(code); this.code = code; }
}

const visible = async (locator) => locator.isVisible().catch(() => false);
const fail = (code) => { throw new SyncError(code); };

function cleanName(value) {
  return String(value || '').split('\n').map((part) => part.trim()).find(Boolean) || '';
}

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function errorCode(error) {
  return error?.code || error?.message || 'SYNC_FAILED';
}

function remainingMs(deadline) {
  return Math.max(0, deadline - Date.now());
}

function relativeAgeSeconds(value) {
  const text = normalizeText(value);
  if (!text) return null;
  if (/刚刚|刚才|少于\s*1\s*分钟|不到\s*1\s*分钟/.test(text)) return 0;
  let match = text.match(/(\d+)\s*秒前/);
  if (match) return Number(match[1]);
  match = text.match(/(\d+)\s*分钟前/);
  if (match) return Number(match[1]) * 60;
  match = text.match(/(\d+)\s*小时前/);
  if (match) return Number(match[1]) * 3600;
  match = text.match(/(\d+)\s*天前/);
  if (match) return Number(match[1]) * 86400;
  return null;
}

function evaluateSyncSnapshot(before, after, sawProgress = false) {
  const beforeText = normalizeText(before?.text);
  const afterText = normalizeText(after?.text);
  const progress = Boolean(after?.progress || after?.disabled);

  if (/同步成功|同步完成|数据同步完成/.test(afterText)) {
    return { confirmed: true, progress, signal: 'SUCCESS_TEXT' };
  }

  const beforeAge = relativeAgeSeconds(beforeText);
  const afterAge = relativeAgeSeconds(afterText);
  if (afterAge !== null) {
    if (afterAge <= 5 && (beforeAge === null || beforeAge > 5 || beforeText !== afterText)) {
      return { confirmed: true, progress, signal: 'FRESH_LAST_SYNC' };
    }
    if (beforeAge !== null && afterAge + 5 < beforeAge) {
      return { confirmed: true, progress, signal: 'LAST_SYNC_BECAME_NEWER' };
    }
  }

  if (sawProgress && !progress && afterText && !/失败|异常|错误/.test(afterText)) {
    return { confirmed: true, progress, signal: 'PROGRESS_FINISHED' };
  }

  return { confirmed: false, progress, signal: null };
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

async function readSyncMenuSnapshot(syncButton) {
  const snapshot = await syncButton.evaluate((element) => {
    let node = element;
    let bestText = (element.innerText || element.textContent || '').trim();
    let disabled = false;

    for (let depth = 0; node && depth < 7; depth += 1, node = node.parentElement) {
      const text = (node.innerText || node.textContent || '').replace(/\s+/g, ' ').trim();
      const className = typeof node.className === 'string' ? node.className : '';
      if (node.getAttribute?.('aria-disabled') === 'true' || /disabled|is-disabled/i.test(className)) {
        disabled = true;
      }
      if (text && text.length <= 500 && /上次同步|最近同步|同步中|正在同步|同步完成|同步成功/.test(text)) {
        bestText = text;
        break;
      }
    }

    return {
      text: bestText,
      disabled,
      progress: /同步中|正在同步|同步进行中|更新中|正在更新|刷新中/.test(bestText)
    };
  }).catch(() => ({ text: '', disabled: false, progress: false }));

  return {
    text: normalizeText(snapshot.text),
    disabled: Boolean(snapshot.disabled),
    progress: Boolean(snapshot.progress)
  };
}

async function readCurrentSyncState(page, tableName, deadline) {
  await page.keyboard.press('Escape').catch(() => {});
  const timeout = Math.min(TABLE_SCAN_TIMEOUT_MS, remainingMs(deadline));
  if (timeout <= 0) fail('BASE_TIMEOUT_8_MINUTES');

  const row = await findTableRow(page, tableName, timeout);
  await row.hover({ timeout });
  await row.locator(TABLE_MENU_SELECTOR).first().click({ timeout });

  const progressText = page.getByText(/同步中|正在同步|同步进行中|更新中|正在更新|刷新中/, { exact: false })
    .filter({ visible: true }).first();
  if (await visible(progressText)) {
    const snapshot = {
      text: normalizeText(await progressText.textContent().catch(() => '同步中')),
      disabled: true,
      progress: true
    };
    await page.keyboard.press('Escape').catch(() => {});
    return snapshot;
  }

  const syncButton = page.getByText(MENU_TEXT, { exact: true }).filter({ visible: true }).first();
  try {
    await syncButton.waitFor({ state: 'visible', timeout });
    const snapshot = await readSyncMenuSnapshot(syncButton);
    await page.keyboard.press('Escape').catch(() => {});
    return snapshot;
  } catch (error) {
    await page.keyboard.press('Escape').catch(() => {});
    throw error;
  }
}

async function waitForSync(page, tableName, before, timeoutMs, deadline, initialToastVisible = false) {
  const confirmDeadline = Math.min(deadline, Date.now() + timeoutMs);
  let sawProgress = false;
  let probeFailures = 0;
  let toastArmed = !initialToastVisible;

  while (remainingMs(confirmDeadline) > 0) {
    const toastVisible = await visible(successToastLocator(page));
    if (!toastArmed && !toastVisible) toastArmed = true;
    if (toastArmed && toastVisible) {
      console.log(`SYNC_CONFIRM_SIGNAL=${tableName}:TOAST`);
      return true;
    }

    try {
      const after = await readCurrentSyncState(page, tableName, confirmDeadline);
      const result = evaluateSyncSnapshot(before, after, sawProgress);
      sawProgress = sawProgress || result.progress;
      if (result.confirmed) {
        console.log(`SYNC_CONFIRM_SIGNAL=${tableName}:${result.signal}`);
        return true;
      }
      probeFailures = 0;
    } catch (error) {
      probeFailures += 1;
      if (probeFailures >= 3) {
        console.log(`SYNC_CONFIRM_PROBE_ERROR=${tableName}:${errorCode(error)}`);
        probeFailures = 0;
      }
    }

    const sleepMs = Math.min(SYNC_POLL_INTERVAL_MS, remainingMs(confirmDeadline));
    if (sleepMs > 0) await page.waitForTimeout(sleepMs);
  }

  return false;
}

async function syncTable(page, tableName, deadline) {
  const previousToast = successToastLocator(page);
  const initialToastVisible = await visible(previousToast);
  if (initialToastVisible) {
    await previousToast.waitFor({ state: 'hidden', timeout: TABLE_SCAN_TIMEOUT_MS }).catch(() => {});
  }

  const syncButton = await openTableMenu(page, tableName, deadline);
  const before = await readSyncMenuSnapshot(syncButton);
  await syncButton.click({ timeout: Math.min(TABLE_SCAN_TIMEOUT_MS, remainingMs(deadline)) });

  const confirmTimeout = Math.min(SYNC_CONFIRM_TIMEOUT_MS, remainingMs(deadline));
  if (!await waitForSync(page, tableName, before, confirmTimeout, deadline, initialToastVisible)) fail('SYNC_NOT_CONFIRMED');
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
    successfulTableNames: [],
    failedTableNames: [],
    failureReasons: {}
  };
  stats.failedTableNames ||= [];
  stats.failureReasons ||= {};

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
      stats.failedTableNames.push(tableName);
      stats.failureReasons[tableName] = errorCode(error);
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
      stats.failedTableNames.push(tableName);
      stats.failureReasons[tableName] = errorCode(error);
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
  console.log(`SYNC_FAILED_NAMES=${JSON.stringify(stats.failedTableNames || [])}`);
  console.log(`SYNC_FAILURE_REASONS=${JSON.stringify(stats.failureReasons || {})}`);
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
    successfulTableNames: [],
    failedTableNames: [],
    failureReasons: {}
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
  evaluateSyncSnapshot,
  findTableRow,
  processTableNames,
  relativeAgeSeconds,
  snapshotTableNames,
  withTimeout
};
