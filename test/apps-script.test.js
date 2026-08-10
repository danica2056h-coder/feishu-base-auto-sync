const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function loadScript(nowParts = {}, expectedSecret = 'test-secret') {
  const code = fs.readFileSync('apps-script/Code.gs', 'utf8');
  const context = {
    Date,
    Math,
    Number,
    String,
    JSON,
    PropertiesService: {
      getScriptProperties() {
        return { getProperty: (name) => name === 'CONTROL_API_SECRET' ? expectedSecret : null };
      }
    },
    ContentService: {
      MimeType: { JSON: 'application/json' },
      createTextOutput(content) {
        return {
          content,
          mimeType: null,
          setMimeType(mimeType) { this.mimeType = mimeType; return this; }
        };
      }
    },
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

function jsonOutput(output) {
  assert.equal(output.mimeType, 'application/json');
  return JSON.parse(output.content);
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

test('doGet returns unified JSON for tasks=[]', () => {
  const script = loadScript();
  script.claimTasks_ = () => [];
  const body = jsonOutput(script.doGet({ parameter: { action: 'check', mode: 'due', secret: 'test-secret' } }));
  assert.deepEqual(JSON.parse(JSON.stringify(body)), { ok: true, action: 'check', tasks: [] });
});

test('doGet returns unified JSON with tasks', () => {
  const script = loadScript();
  script.claimTasks_ = () => [{ row: 2, baseUrl: 'https://example.invalid/base' }];
  const body = jsonOutput(script.doGet({ parameter: { action: 'check', mode: 'row', row: '2', secret: 'test-secret' } }));
  assert.equal(body.ok, true);
  assert.equal(body.action, 'check');
  assert.equal(body.tasks.length, 1);
  assert.equal(body.tasks[0].row, 2);
});

test('doPost returns unified JSON after completion', () => {
  const script = loadScript();
  script.completeTask_ = () => {};
  const body = jsonOutput(script.doPost({
    postData: { contents: JSON.stringify({ action: 'complete', row: 2, secret: 'test-secret' }) }
  }));
  assert.deepEqual(JSON.parse(JSON.stringify(body)), { ok: true, action: 'complete' });
});

test('secret mismatch returns JSON error instead of throwing HTML', () => {
  const script = loadScript();
  const body = jsonOutput(script.doGet({ parameter: { action: 'check', secret: 'wrong-secret' } }));
  assert.deepEqual(JSON.parse(JSON.stringify(body)), { ok: false, error: 'UNAUTHORIZED' });
});
