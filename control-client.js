const { appendFile } = require('node:fs/promises');

const API_URL = process.env.CONTROL_API_URL;
const API_SECRET = process.env.CONTROL_API_SECRET;

function required(value, code) {
  if (!value) throw new Error(code);
  return value;
}

function safePreview(text, isHtml = false) {
  let value = String(text || '');
  const secretValues = [API_SECRET, encodeURIComponent(API_SECRET || '')].filter(Boolean);
  for (const secret of secretValues) value = value.split(secret).join('[REDACTED]');
  value = value
    .replace(/\bBearer\s+[^\s"'<>]+/gi, 'Bearer [REDACTED]')
    .replace(/([?&](?:secret|token|session|cookie|authorization)=)[^&\s"'<>]+/gi, '$1[REDACTED]')
    .replace(/((?:CONTROL_API_SECRET|GITHUB_TOKEN|FEISHU_AUTH_KEY|Authorization|Cookie|session|token)\s*["']?\s*[:=]\s*["']?)[^\s,"'<>}]+/gi, '$1[REDACTED]');
  if (isHtml) {
    value = value.replace(/(\b(?:value|href|src|action|nonce|data-[\w-]+)=)(["'])[^"']*\2/gi, '$1$2[REDACTED]$2');
  }
  return value.replace(/\s+/g, ' ').trim().slice(0, 200);
}

function logResponseDiagnostics(response, contentType, text, isHtml = false) {
  console.error(`CONTROL_API_STATUS=${response.status}`);
  console.error(`CONTROL_API_CONTENT_TYPE=${contentType || 'unknown'}`);
  console.error(`CONTROL_API_RESPONSE_LENGTH=${text.length}`);
  console.error(`CONTROL_API_RESPONSE_PREVIEW=${safePreview(text, isHtml)}`);
}

function responseError(code, response, contentType, text, isHtml = false) {
  logResponseDiagnostics(response, contentType, text, isHtml);
  return new Error(code);
}

async function callApi(payload) {
  required(API_URL, 'CONTROL_API_URL_MISSING');
  required(API_SECRET, 'CONTROL_API_SECRET_MISSING');
  const isCheck = payload.action === 'check';
  let requestUrl = API_URL;
  const options = { method: isCheck ? 'GET' : 'POST', redirect: 'follow' };
  if (isCheck) {
    const url = new URL(API_URL);
    Object.entries({ ...payload, secret: API_SECRET }).forEach(([key, value]) => {
      if (value !== '' && value !== undefined && value !== null) url.searchParams.set(key, String(value));
    });
    requestUrl = url.toString();
  } else {
    options.headers = { 'content-type': 'application/json' };
    options.body = JSON.stringify({ ...payload, secret: API_SECRET });
  }
  const response = await fetch(requestUrl, options);
  const text = await response.text();
  const contentType = response.headers?.get?.('content-type') || '';
  const isHtml = /text\/html/i.test(contentType) || /^\s*(?:<!doctype\s+html|<html)\b/i.test(text);
  if (isHtml) {
    const googleAuth = /accounts\.google\.com|ServiceLogin|Google Accounts|identifierId|signin\/v2/i.test(text);
    throw responseError(
      googleAuth ? 'CONTROL_API_GOOGLE_AUTH_REQUIRED' : 'CONTROL_API_HTML_RESPONSE',
      response,
      contentType,
      text,
      true
    );
  }

  let body;
  try { body = JSON.parse(text); }
  catch { throw responseError('CONTROL_API_INVALID_JSON', response, contentType, text); }

  if (!response.ok) throw responseError(`CONTROL_API_HTTP_${response.status}`, response, contentType, text);
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw responseError('CONTROL_API_SCHEMA_INVALID', response, contentType, text);
  }
  if (body.ok === false) {
    if (typeof body.error !== 'string' || !body.error) {
      throw responseError('CONTROL_API_SCHEMA_INVALID', response, contentType, text);
    }
    throw responseError(body.error, response, contentType, text);
  }
  if (body.ok !== true || body.action !== payload.action) {
    throw responseError('CONTROL_API_SCHEMA_INVALID', response, contentType, text);
  }
  if (isCheck && !Array.isArray(body.tasks)) {
    throw responseError('CONTROL_API_SCHEMA_INVALID', response, contentType, text);
  }
  return body;
}

async function writeOutput(key, value) {
  const output = process.env.GITHUB_OUTPUT;
  if (!output) {
    console.log(`${key}=${value}`);
    return;
  }
  await appendFile(output, `${key}=${value}\n`, 'utf8');
}

async function check(mode = 'due', row = '') {
  const body = await callApi({ action: 'check', mode, row });
  const tasks = body.tasks;
  await writeOutput('has_tasks', tasks.length ? 'true' : 'false');
  await writeOutput('tasks', JSON.stringify(tasks));
  console.log(`DUE_TASKS=${tasks.length}`);
  if (!tasks.length) console.log('NO_DUE_TASKS');
  return tasks;
}

async function complete(status) {
  const row = Number(required(process.env.CONTROL_ROW, 'CONTROL_ROW_MISSING'));
  const durationMs = Number(process.env.SYNC_DURATION_MS || 0);
  const error = process.env.SYNC_ERROR || '';
  await callApi({ action: 'complete', row, status, durationMs, error });
  console.log(`CONTROL_WRITEBACK=${status}`);
}

async function main() {
  const [command, argument] = process.argv.slice(2);
  if (command === 'check') return check(argument || process.env.CHECK_MODE || 'due', process.argv[4] || process.env.CHECK_ROW || '');
  if (command === 'complete') return complete(argument || process.env.SYNC_STATUS || '失败');
  throw new Error('CONTROL_COMMAND_INVALID');
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message || error);
    process.exitCode = 1;
  });
}

module.exports = { callApi, check, complete, safePreview };
