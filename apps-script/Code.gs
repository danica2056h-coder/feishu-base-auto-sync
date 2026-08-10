const CONTROL_SHEET_NAME = '同步配置';
const CONTROL_TIME_ZONE = 'Asia/Shanghai';
const CONTROL_COLUMNS = 6;

function doGet(e) {
  return handleRequest_(e && e.parameter ? e.parameter : {});
}

function doPost(e) {
  let payload = {};
  try { payload = JSON.parse((e && e.postData && e.postData.contents) || '{}'); }
  catch (error) { return json_({ ok: false, error: 'INVALID_JSON' }); }
  return handleRequest_(payload);
}

function handleRequest_(payload) {
  try {
    verifySecret_(payload.secret);
    if (payload.action === 'claim') return json_({ ok: true, tasks: claimTasks_(payload.mode || 'due', payload.row) });
    if (payload.action === 'complete') {
      completeTask_(payload);
      return json_({ ok: true });
    }
    if (payload.action === 'health') return json_({ ok: true, timeZone: CONTROL_TIME_ZONE });
    throw new Error('INVALID_ACTION');
  } catch (error) {
    return json_({ ok: false, error: String(error.message || error).slice(0, 120) });
  }
}

function verifySecret_(provided) {
  const expected = PropertiesService.getScriptProperties().getProperty('CONTROL_API_SECRET');
  if (!expected || !provided || String(provided) !== String(expected)) throw new Error('UNAUTHORIZED');
}

function getControlSheet_() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONTROL_SHEET_NAME);
  if (!sheet) throw new Error('CONTROL_SHEET_NOT_FOUND');
  return sheet;
}

function parseRule_(value) {
  const match = String(value || '').trim().match(/^(工作日|每天)\s+([01]\d|2[0-3]):([0-5]\d)$/);
  if (!match) return null;
  return { type: match[1], hour: Number(match[2]), minute: Number(match[3]) };
}

function localNowParts_(now) {
  const date = Utilities.formatDate(now, CONTROL_TIME_ZONE, 'yyyy-MM-dd');
  return {
    date,
    weekday: Number(Utilities.formatDate(now, CONTROL_TIME_ZONE, 'u')),
    hour: Number(Utilities.formatDate(now, CONTROL_TIME_ZONE, 'HH')),
    minute: Number(Utilities.formatDate(now, CONTROL_TIME_ZONE, 'mm'))
  };
}

function isDue_(ruleText, now, lastAutoDate) {
  const rule = parseRule_(ruleText);
  if (!rule) return false;
  const parts = localNowParts_(now);
  if (rule.type === '工作日' && parts.weekday > 5) return false;
  if (lastAutoDate === parts.date) return false;
  const currentMinute = parts.hour * 60 + parts.minute;
  const scheduledMinute = rule.hour * 60 + rule.minute;
  return currentMinute >= scheduledMinute && currentMinute < scheduledMinute + 10;
}

function truthyCheckbox_(value) {
  return value === true || String(value).toUpperCase() === 'TRUE';
}

function lockKey_(url) {
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(url));
  return bytes.slice(0, 10).map(function(value) {
    const normalized = value < 0 ? value + 256 : value;
    return ('0' + normalized.toString(16)).slice(-2);
  }).join('');
}

function claimTasks_(mode, requestedRow) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20 * 1000);
  try {
    const sheet = getControlSheet_();
    const lastRow = sheet.getLastRow();
    if (lastRow < 2) return [];
    const values = sheet.getRange(2, 1, lastRow - 1, CONTROL_COLUMNS).getValues();
    const now = new Date();
    const parts = localNowParts_(now);
    const props = PropertiesService.getScriptProperties();
    const tasks = [];

    values.forEach(function(row, index) {
      const sheetRow = index + 2;
      const baseUrl = String(row[0] || '').trim();
      const rule = String(row[1] || '').trim();
      const manual = truthyCheckbox_(row[2]);
      const status = String(row[3] || '').trim();
      if (!baseUrl) return;
      if (status === '同步中') {
        const claimedAt = Number(props.getProperty(`CLAIM_MS_${sheetRow}`) || 0);
        if (claimedAt && now.getTime() - claimedAt < 30 * 60 * 1000) return;
      }

      let selected = false;
      const lastAuto = props.getProperty(`LAST_AUTO_DATE_${sheetRow}`);
      const autoDue = isDue_(rule, now, lastAuto);
      if (mode === 'all') selected = true;
      else if (mode === 'row') selected = Number(requestedRow) === sheetRow && manual;
      else {
        selected = manual || autoDue;
      }
      if (!selected) return;

      if (autoDue) props.setProperty(`LAST_AUTO_DATE_${sheetRow}`, parts.date);
      props.setProperty(`CLAIM_MS_${sheetRow}`, String(now.getTime()));
      sheet.getRange(sheetRow, 4).setValue('同步中');
      tasks.push({ row: sheetRow, baseUrl, rule, lockKey: lockKey_(baseUrl) });
    });
    SpreadsheetApp.flush();
    return tasks;
  } finally {
    lock.releaseLock();
  }
}

function completeTask_(payload) {
  const row = Number(payload.row);
  if (!Number.isInteger(row) || row < 2) throw new Error('INVALID_ROW');
  const status = payload.status === '成功' ? '成功' : '失败';
  const durationMs = Math.max(0, Number(payload.durationMs) || 0);
  const sheet = getControlSheet_();
  const lock = LockService.getScriptLock();
  lock.waitLock(20 * 1000);
  try {
    sheet.getRange(row, 3).setValue(false);
    sheet.getRange(row, 4).setValue(status);
    sheet.getRange(row, 5).setValue(Utilities.formatDate(new Date(), CONTROL_TIME_ZONE, 'yyyy-MM-dd HH:mm:ss'));
    sheet.getRange(row, 6).setValue(formatDuration_(durationMs));
    PropertiesService.getScriptProperties().deleteProperty(`CLAIM_MS_${row}`);
    SpreadsheetApp.flush();
  } finally {
    lock.releaseLock();
  }
}

function formatDuration_(durationMs) {
  const seconds = Math.round(durationMs / 1000);
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return minutes ? `${minutes}分${remainder}秒` : `${remainder}秒`;
}

function onControlEdit(e) {
  if (!e || !e.range) return;
  const range = e.range;
  if (range.getSheet().getName() !== CONTROL_SHEET_NAME || range.getColumn() !== 3 || range.getRow() < 2) return;
  if (!truthyCheckbox_(e.value)) return;
  const row = range.getRow();
  if (String(range.getSheet().getRange(row, 4).getValue()) === '同步中') {
    range.setValue(false);
    return;
  }
  range.getSheet().getRange(row, 4).setValue('等待触发');
  try {
    const result = dispatchGithub_(row);
    if (!result.ok) range.getSheet().getRange(row, 4).setValue(result.authMissing ? '等待轮询' : '触发失败');
  } catch (error) {
    range.getSheet().getRange(row, 4).setValue('等待轮询');
  }
}

function dispatchGithub_(row) {
  const props = PropertiesService.getScriptProperties();
  const token = props.getProperty('GITHUB_TOKEN');
  const owner = props.getProperty('GITHUB_OWNER') || 'danica2056h-coder';
  const repo = props.getProperty('GITHUB_REPO') || 'feishu-base-auto-sync';
  const workflow = props.getProperty('GITHUB_WORKFLOW') || 'feishu-sync.yml';
  if (!token) return { ok: false, authMissing: true };
  const url = `https://api.github.com/repos/${owner}/${repo}/actions/workflows/${workflow}/dispatches`;
  const response = UrlFetchApp.fetch(url, {
    method: 'post',
    muteHttpExceptions: true,
    contentType: 'application/json',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28'
    },
    payload: JSON.stringify({ ref: 'main', inputs: { mode: 'row', row: String(row) } })
  });
  return { ok: response.getResponseCode() === 204, authMissing: false };
}

function installOnEditTrigger() {
  ScriptApp.getProjectTriggers().forEach(function(trigger) {
    if (trigger.getHandlerFunction() === 'onControlEdit') ScriptApp.deleteTrigger(trigger);
  });
  ScriptApp.newTrigger('onControlEdit').forSpreadsheet(SpreadsheetApp.getActive()).onEdit().create();
}

function initializeControlSheet() {
  const sheet = getControlSheet_();
  sheet.getRange(1, 1, 1, CONTROL_COLUMNS).setValues([[
    '飞书Base链接', '自动同步规则', '立即同步', '状态', '最后同步时间', '同步时长'
  ]]);
  const rowCount = Math.max(sheet.getMaxRows() - 1, 1);
  sheet.getRange(2, 3, rowCount, 1).insertCheckboxes();
  sheet.getRange(2, 5, rowCount, 1).setNumberFormat('@');
  SpreadsheetApp.getActive().setSpreadsheetTimeZone(CONTROL_TIME_ZONE);
}

function json_(value) {
  return ContentService.createTextOutput(JSON.stringify(value)).setMimeType(ContentService.MimeType.JSON);
}
