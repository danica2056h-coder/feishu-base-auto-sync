const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function loadScript(nowParts = {}) {
  const code = fs.readFileSync('apps-script/Code.gs', 'utf8');
  const context = {
    Date,
    Math,
    Number,
    String,
    JSON,
    Utilities: {
      formatDate(_date, _zone, pattern) {
        const values = { 'yyyy-MM-dd': '2026-08-10', u: '1', HH: '09', mm: '45', ...nowParts };
        return values[pattern];
      },
      computeDigest() { return [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]; },
      DigestAlgorithm: { SHA_256: 'SHA_256' }
    }
  };
  vm.createContext(context);
  vm.runInContext(code, context);
  return context;
}

test('parses only supported simple rules', () => {
  const script = loadScript();
  assert.deepEqual({ ...script.parseRule_('工作日 09:45') }, { type: '工作日', hour: 9, minute: 45 });
  assert.deepEqual({ ...script.parseRule_('每天 12:30') }, { type: '每天', hour: 12, minute: 30 });
  assert.equal(script.parseRule_('每周一 09:45'), null);
  assert.equal(script.parseRule_('工作日 25:00'), null);
});

test('workday task is due in Asia/Shanghai window', () => {
  const script = loadScript();
  assert.equal(script.isDue_('工作日 09:45', new Date(), null), true);
  assert.equal(script.isDue_('工作日 09:45', new Date(), '2026-08-10'), false);
});

test('workday skips weekends while daily still runs', () => {
  const script = loadScript({ u: '6' });
  assert.equal(script.isDue_('工作日 09:45', new Date(), null), false);
  assert.equal(script.isDue_('每天 09:45', new Date(), null), true);
});

test('lock key is stable and contains no URL', () => {
  const script = loadScript();
  const key = script.lockKey_('https://example.feishu.cn/base/secret');
  assert.equal(key, '00010203040506070809');
  assert.equal(key.includes('feishu'), false);
});
