const test = require('node:test');
const assert = require('node:assert/strict');

test('table names are normalized without hard-coded targets', () => {
  const { cleanName } = require('../sync-feishu');
  assert.equal(cleanName('\n  渠道效果  \n更多'), '渠道效果');
  assert.equal(cleanName(''), '');
});

test('candidate rows are deduplicated by visible name and position', () => {
  const { deduplicate } = require('../sync-feishu');
  const rows = [
    { name: 'A', box: { y: 30 } },
    { name: 'A', box: { y: 31 } },
    { name: 'B', box: { y: 60 } }
  ];
  assert.deepEqual(deduplicate(rows).map((row) => row.name), ['A', 'B']);
});
