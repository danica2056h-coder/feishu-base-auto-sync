const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const { cleanName, processTableNames } = require('../sync-feishu');

test('table names are normalized without hard-coded targets', () => {
  assert.equal(cleanName('\n  渠道效果  \n更多'), '渠道效果');
  assert.equal(cleanName(''), '');
});

test('multi-table processing logs every outcome and continues after one failure', async () => {
  const logs = [];
  const detected = [];
  const synced = [];
  const page = { keyboard: { press: async () => {} } };
  const names = ['连接器一', '普通表', '连接器二'];

  const stats = await processTableNames(page, names, {
    deadline: Date.now() + 5_000,
    log: (line) => logs.push(line),
    detectConnector: async (_page, name) => {
      detected.push(name);
      return name !== '普通表';
    },
    syncTable: async (_page, name) => {
      synced.push(name);
      if (name === '连接器二') throw new Error('TEST_SYNC_FAILURE');
    }
  });

  assert.deepEqual(detected, names);
  assert.deepEqual(synced, ['连接器一', '连接器二']);
  assert.equal(stats.totalTables, 3);
  assert.equal(stats.connectorTablesFound, 2);
  assert.equal(stats.syncSuccessCount, 1);
  assert.equal(stats.syncFailedCount, 1);
  assert.deepEqual(stats.successfulTableNames, ['连接器一']);
  assert.ok(logs.includes('TABLE_SCAN_START=连接器一'));
  assert.ok(logs.includes('TABLE_SYNC_START=连接器一'));
  assert.ok(logs.includes('TABLE_SYNC_SUCCESS=连接器一'));
  assert.ok(logs.includes('TABLE_SKIP_NO_CONNECTOR=普通表'));
  assert.ok(logs.includes('TABLE_SCAN_ERROR=连接器二'));
});

test('a stuck non-connector detection is capped and later tables are still scanned', async () => {
  const logs = [];
  const detected = [];
  const page = { keyboard: { press: async () => {} } };
  const started = Date.now();

  const stats = await processTableNames(page, ['卡住的表', '后续普通表'], {
    deadline: Date.now() + 1_000,
    scanTimeoutMs: 25,
    log: (line) => logs.push(line),
    detectConnector: async (_page, name) => {
      detected.push(name);
      if (name === '卡住的表') return new Promise(() => {});
      return false;
    },
    syncTable: async () => { throw new Error('must not sync'); }
  });

  assert.ok(Date.now() - started < 500);
  assert.deepEqual(detected, ['卡住的表', '后续普通表']);
  assert.equal(stats.syncFailedCount, 1);
  assert.ok(logs.includes('TABLE_SCAN_ERROR=卡住的表'));
  assert.ok(logs.includes('TABLE_SKIP_NO_CONNECTOR=后续普通表'));
});

test('production traversal uses the real table-name DOM and bounded deadlines', () => {
  const source = fs.readFileSync('sync-feishu.js', 'utf8');
  assert.match(source, /TABLE_NAME_SELECTOR = '\.bitable-new-table-tab__item-name'/);
  assert.match(source, /TABLE_SCAN_TIMEOUT_MS = 3_000/);
  assert.match(source, /MAX_BASE_DURATION_MS = 8 \* 60_000/);
  assert.doesNotMatch(source, /locator\('div,span'\)/);
  assert.match(source, /Always re-read the current sidebar DOM/);
  assert.match(source, /Re-locate again immediately before interaction/);
  assert.match(source, /TOTAL_TABLES=/);
  assert.match(source, /CONNECTOR_TABLES_FOUND=/);
  assert.match(source, /SYNC_SUCCESS_COUNT=/);
  assert.match(source, /SYNC_FAILED_COUNT=/);
});
