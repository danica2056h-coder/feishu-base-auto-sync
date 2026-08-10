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

test('check sends GET parameters and accepts tasks=[]', async () => {
  let request;
  global.fetch = async (url, options) => {
    request = { url: new URL(url), options };
    return response(JSON.stringify({ ok: true, action: 'check', tasks: [] }));
  };

  assert.deepEqual(await check('due', ''), []);
  assert.equal(request.options.method, 'GET');
  assert.equal(request.options.body, undefined);
  assert.equal(request.url.searchParams.get('action'), 'check');
  assert.equal(request.url.searchParams.get('mode'), 'due');
  assert.equal(request.url.searchParams.get('secret'), 'test-secret');
});

test('check accepts a valid task array', async () => {
  const tasks = [{ row: 2, baseUrl: 'https://example.invalid/base', lockKey: 'abc' }];
  global.fetch = async () => response(JSON.stringify({ ok: true, action: 'check', tasks }));
  assert.deepEqual(await check('row', '2'), tasks);
});

test('completion uses POST with the unified JSON response', async () => {
  let request;
  global.fetch = async (url, options) => {
    request = { url, options };
    return response(JSON.stringify({ ok: true, action: 'complete' }));
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
    await assert.rejects(() => callApi({ action: 'check', mode: 'due' }), { message: 'CONTROL_API_HTML_RESPONSE' });
  });
  assert.ok(lines.includes('CONTROL_API_STATUS=200'));
  assert.ok(lines.includes('CONTROL_API_CONTENT_TYPE=text/html'));
  assert.ok(lines.some((line) => line.startsWith('CONTROL_API_RESPONSE_LENGTH=')));
  assert.ok(lines.some((line) => line.startsWith('CONTROL_API_RESPONSE_PREVIEW=')));
});

test('Google login HTML is classified as authorization required', async () => {
  global.fetch = async () => response('<html><a href="https://accounts.google.com/ServiceLogin">Sign in</a></html>', 200, 'text/html');
  await captureErrors(() => assert.rejects(
    () => callApi({ action: 'check', mode: 'due' }),
    { message: 'CONTROL_API_GOOGLE_AUTH_REQUIRED' }
  ));
});

test('HTTP 200 invalid JSON is classified explicitly', async () => {
  global.fetch = async () => response('not-json');
  await captureErrors(() => assert.rejects(
    () => callApi({ action: 'check', mode: 'due' }),
    { message: 'CONTROL_API_INVALID_JSON' }
  ));
});

test('HTTP 200 invalid JSON schema is classified explicitly', async () => {
  global.fetch = async () => response(JSON.stringify({ ok: true, tasks: [] }));
  await captureErrors(() => assert.rejects(
    () => callApi({ action: 'check', mode: 'due' }),
    { message: 'CONTROL_API_SCHEMA_INVALID' }
  ));
});

test('HTTP 401 and 403 retain their status codes', async (context) => {
  for (const status of [401, 403]) {
    await context.test(String(status), async () => {
      global.fetch = async () => response(JSON.stringify({ ok: false, error: 'UNAUTHORIZED' }), status);
      await captureErrors(() => assert.rejects(
        () => callApi({ action: 'check', mode: 'due' }),
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
