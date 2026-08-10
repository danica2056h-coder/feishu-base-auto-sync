const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const workflowPath = '.github/workflows/feishu-sync.yml';
const workflow = fs.readFileSync(workflowPath, 'utf8');

test('production workflow is installed only under .github/workflows', () => {
  assert.equal(fs.existsSync('feishu-sync.yml'), false);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /schedule:\s*\n\s*- cron: '\*\/5 \* \* \* \*'/);
});

test('lightweight check cannot install browser dependencies', () => {
  const checkJob = workflow.split(/^  sync:/m)[0];
  assert.doesNotMatch(checkJob, /npm ci|playwright install|decrypt-auth|sync-feishu/);
  assert.match(checkJob, /has_tasks: \$\{\{ steps\.check\.outputs\.has_tasks \}\}/);
  assert.match(checkJob, /tasks: \$\{\{ steps\.check\.outputs\.tasks \}\}/);
  assert.match(checkJob, /node control-client\.js check "\$CHECK_MODE" "\$CHECK_ROW"/);
  assert.match(workflow, /if: needs\.check-control-sheet\.outputs\.has_tasks == 'true'/);
  assert.match(workflow, /task: \$\{\{ fromJSON\(needs\.check-control-sheet\.outputs\.tasks\) \}\}/);
});

test('heavy job is serialized per Base and retains required stages', () => {
  assert.match(workflow, /group: feishu-base-\$\{\{ matrix\.task\.lockKey \}\}/);
  assert.match(workflow, /node decrypt-auth\.js/);
  assert.match(workflow, /npx playwright install --with-deps chromium/);
  assert.match(workflow, /node sync-feishu\.js/);
  assert.match(workflow, /node control-client\.js complete/);
});
