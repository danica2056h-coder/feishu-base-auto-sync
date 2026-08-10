const { appendFile } = require('node:fs/promises');

const API_URL = process.env.CONTROL_API_URL;
const API_SECRET = process.env.CONTROL_API_SECRET;

function required(value, code) {
  if (!value) throw new Error(code);
  return value;
}

async function callApi(payload) {
  required(API_URL, 'CONTROL_API_URL_MISSING');
  required(API_SECRET, 'CONTROL_API_SECRET_MISSING');
  const isClaim = payload.action === 'claim';
  let requestUrl = API_URL;
  const options = { method: isClaim ? 'GET' : 'POST', redirect: 'follow' };
  if (isClaim) {
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
  let body;
  try { body = JSON.parse(text); } catch { throw new Error(`CONTROL_API_INVALID_RESPONSE_${response.status}`); }
  if (!response.ok || !body.ok) throw new Error(body.error || `CONTROL_API_HTTP_${response.status}`);
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
  const body = await callApi({ action: 'claim', mode, row });
  const tasks = Array.isArray(body.tasks) ? body.tasks : [];
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

module.exports = { callApi, check, complete };
