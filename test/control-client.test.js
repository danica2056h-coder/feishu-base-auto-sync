const test = require('node:test');
const assert = require('node:assert/strict');

process.env.CONTROL_API_URL = 'https://example.invalid/exec';
process.env.CONTROL_API_SECRET = 'test-secret';

const { callApi, check, safePreview } = require('../control-client');

function response(body, status = 200, contentType = 'application/json; charset=utf-8') {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => name.toLowerCase() === 'content-type' ? contentType : null },
    text: async () => body
  };
}

async function captureErrors(callback) {
  const original = console.error;
  const lines = [];
  console.error = (...values) => lines.push(values.join(' '));
  try { await callback(); }
  finally { console.error = original; }
  return lines;
}

async function captureLogs(callback) {
  const original = console.log;
  const lines = [];
  console.log = (...values) => lines.push(values.join(' '));
  try { return { result: await callback(), lines }; }
  finally { console.log = original; }
}

test('CLI check sends API action=claim for scheduled/due mode and accepts no tasks', async () => {
  let request;
  global.fetch = async (url, options) => {
    request = { url: new URL(url), options };
    return response(JSON.stringify({ ok: true, tasks: [] }));
  };

  const { result, lines } = await captureLogs(() => check('due', ''));
  assert.deepEqual(result, []);
  assert.equal(request.options.method, 'GET');
  assert.equal(request.options.body, undefined);
  assert.equal(request.url.searchParams.get('action'), 'claim');
  assert.equal(request.url.searchParams.get('mode'), 'due');
  assert.equal(request.url.searchParams.has('row'), false);
  assert.equal(request.url.searchParams.get('secret'), 'test-secret');
  assert.ok(lines.includes('has_tasks=false'));
  assert.ok(lines.includes('tasks=[]'));
  assert.ok(lines.includes('NO_DUE_TASKS'));
});

test('CLI check preserves row mode and exposes workflow-compatible task outputs', async () => {
  let request;
  const tasks = [{ row: 2, baseUrl: 'https://example.invalid/base', lockKey: 'abc' }];
  global.fetch = async (url, options) => {
    request = { url: new URL(url), options };
    return response(JSON.stringify({ ok: true, tasks }));
  };

  const { result, lines } = await captureLogs(() => check('row', '2'));
  assert.deepEqual(result, tasks);
  assert.equal(request.url.searchParams.get('action'), 'claim');
  assert.equal(request.url.searchParams.get('mode'), 'row');
  assert.equal(request.url.searchParams.get('row'), '2');
  assert.ok(lines.includes('has_tasks=true'));
  assert.ok(lines.includes(`tasks=${JSON.stringify(tasks)}`));
});

test('claim accepts an explicit matching action in a forward-compatible response', async () => {
  const tasks = [{ row: 3, baseUrl: 'https://example.invalid/base/3', lockKey: 'def' }];
  global.fetch = async () => response(JSON.stringify({ ok: true, action: 'claim', tasks }));
  const { result } = await captureLogs(() => check('all', ''));
  assert.deepEqual(result, tasks);
});

test('check no longer sends the action that causes INVALID_ACTION', async () => {
  global.fetch = async (url) => {
    const action = new URL(url).searchParams.get('action');
    if (action !== 'claim') return response(JSON.stringify({ ok: false, error: 'INVALID_ACTION' }));
    return response(JSON.stringify({ ok: true, tasks: [] }));
  };
  const { result } = await captureLogs(() => check('due', ''));
  assert.deepEqual(result, []);
});

test('completion uses POST with the unified JSON response', async () => {
  let request;
  global.fetch = async (url, options) => {
    request = { url, options };
    return response(JSON.stringify({ ok: true }));
  };

  await callApi({ action: 'complete', row: 2, status: '成功', durationMs: 1000 });
  assert.equal(request.options.method, 'POST');
  assert.equal(request.options.headers['content-type'], 'application/json');
  const payload = JSON.parse(request.options.body);
  assert.equal(payload.action, 'complete');
  assert.equal(payload.secret, 'test-secret');
});

test('HTTP 200 HTML is classified explicitly', async () => {
  global.fetch = async () => response('<!DOCTYPE html><html><body>Not the API</body></html>', 200, 'text/html');
  const lines = await captureErrors(async () => {
    await assert.rejects(() => callApi({ action: 'claim', mode: 'due' }), { message: 'CONTROL_API_HTML_RESPONSE' });
  });
  assert.ok(lines.includes('CONTROL_API_STATUS=200'));
  assert.ok(lines.includes('CONTROL_API_CONTENT_TYPE=text/html'));
  assert.ok(lines.some((line) => line.startsWith('CONTROL_API_RESPONSE_LENGTH=')));
  assert.ok(lines.some((line) => line.startsWith('CONTROL_API_RESPONSE_PREVIEW=')));
});

test('Google login HTML is classified as authorization required', async () => {
  global.fetch = async () => response('<html><a href="https://accounts.google.com/ServiceLogin">Sign in</a></html>', 200, 'text/html');
  await captureErrors(() => assert.rejects(
    () => callApi({ action: 'claim', mode: 'due' }),
    { message: 'CONTROL_API_GOOGLE_AUTH_REQUIRED' }
  ));
});

test('HTTP 200 invalid JSON is classified explicitly', async () => {
  global.fetch = async () => response('not-json');
  await captureErrors(() => assert.rejects(
    () => callApi({ action: 'claim', mode: 'due' }),
    { message: 'CONTROL_API_INVALID_JSON' }
  ));
});

test('claim requires a task array', async () => {
  global.fetch = async () => response(JSON.stringify({ ok: true }));
  await captureErrors(() => assert.rejects(
    () => callApi({ action: 'claim', mode: 'due' }),
    { message: 'CONTROL_API_SCHEMA_INVALID' }
  ));
});

test('an explicit mismatched response action is rejected', async () => {
  global.fetch = async () => response(JSON.stringify({ ok: true, action: 'check', tasks: [] }));
  await captureErrors(() => assert.rejects(
    () => callApi({ action: 'claim', mode: 'due' }),
    { message: 'CONTROL_API_SCHEMA_INVALID' }
  ));
});

test('HTTP 401 and 403 retain their status codes', async (context) => {
  for (const status of [401, 403]) {
    await context.test(String(status), async () => {
      global.fetch = async () => response(JSON.stringify({ ok: false, error: 'UNAUTHORIZED' }), status);
      await captureErrors(() => assert.rejects(
        () => callApi({ action: 'claim', mode: 'due' }),
        { message: `CONTROL_API_HTTP_${status}` }
      ));
    });
  }
});

test('safe preview redacts known secrets and credentials', () => {
  const preview = safePreview('CONTROL_API_SECRET=test-secret Authorization: Bearer abc Cookie=session123 token=xyz');
  assert.equal(preview.includes('test-secret'), false);
  assert.equal(preview.includes('abc'), false);
  assert.equal(preview.includes('session123'), false);
  assert.equal(preview.includes('xyz'), false);
});
