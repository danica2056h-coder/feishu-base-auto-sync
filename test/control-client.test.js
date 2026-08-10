const test = require('node:test');
const assert = require('node:assert/strict');

process.env.CONTROL_API_URL = 'https://example.invalid/exec';
process.env.CONTROL_API_SECRET = 'test-secret';

const { callApi } = require('../control-client');

test('claim reads tasks with GET', async () => {
  let request;
  global.fetch = async (url, options) => {
    request = { url: new URL(url), options };
    return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, tasks: [] }) };
  };

  await callApi({ action: 'claim', mode: 'due', row: '' });

  assert.equal(request.options.method, 'GET');
  assert.equal(request.options.body, undefined);
  assert.equal(request.url.searchParams.get('action'), 'claim');
  assert.equal(request.url.searchParams.get('mode'), 'due');
  assert.equal(request.url.searchParams.get('secret'), 'test-secret');
});

test('completion writes status with POST', async () => {
  let request;
  global.fetch = async (url, options) => {
    request = { url, options };
    return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true }) };
  };

  await callApi({ action: 'complete', row: 2, status: '成功', durationMs: 1000 });

  assert.equal(request.options.method, 'POST');
  assert.equal(request.options.headers['content-type'], 'application/json');
  const payload = JSON.parse(request.options.body);
  assert.equal(payload.action, 'complete');
  assert.equal(payload.secret, 'test-secret');
});
