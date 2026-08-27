'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { sectionGuard } = require('./middleware.cjs');
const cleanup = require('./cleanup.cjs');

function runGuard(session, section, level) {
  let nextCalled = false;
  let status = 200;
  let body = null;
  const req = { session, method: 'POST', originalUrl: '/api/test' };
  const res = {
    status(code) { status = code; return this; },
    json(value) { body = value; return this; },
  };
  sectionGuard(section, level)(req, res, () => { nextCalled = true; });
  return { nextCalled, status, body };
}

test('granular manager permissions deny edit when section is view', () => {
  const result = runGuard({
    role: 'manager', userId: 'u1', studioId: 's1',
    permissions: { clients: 'view', tasks: 'edit', calendar: 'view', finance: 'none' },
  }, 'clients', 'edit');
  assert.equal(result.nextCalled, false);
  assert.equal(result.status, 403);
  assert.deepEqual(result.body, { error: 'forbidden' });
});

test('granular manager permissions allow matching edit section', () => {
  const result = runGuard({
    role: 'manager', userId: 'u1', studioId: 's1',
    permissions: { clients: 'edit', tasks: 'view', calendar: 'view', finance: 'none' },
  }, 'clients', 'edit');
  assert.equal(result.nextCalled, true);
});

test('destructive retention is disabled unless explicitly opted in', async () => {
  const previous = process.env.RETENTION_DELETE_ENABLED;
  delete process.env.RETENTION_DELETE_ENABLED;
  try {
    const result = await cleanup.runCleanup({ dryRun: false });
    assert.equal(result.disabled, true);
    assert.equal(result.studiosDeleted, 0);
    assert.equal(result.candidatesFound, 0);
  } finally {
    if (previous === undefined) delete process.env.RETENTION_DELETE_ENABLED;
    else process.env.RETENTION_DELETE_ENABLED = previous;
  }
});

test('client create failure cannot claim volatile data was saved locally', () => {
  const appSource = fs.readFileSync(path.join(__dirname, '../../client/src/app/App.tsx'), 'utf8');
  assert.doesNotMatch(appSource, /Данные клиента сохранены локально/);
  assert.doesNotMatch(appSource, /api\.getClients\(\)\.catch\(\(\) => \[\]\)/);
  assert.match(appSource, /Клиент не сохранён\. Проверьте доступ и попробуйте ещё раз\./);
  assert.match(appSource, /Сначала сохраните клиента, затем добавьте запись или задачу/);
});

test('confirmed mutations synchronously invalidate stale GET responses', () => {
  const appSource = fs.readFileSync(path.join(__dirname, '../../client/src/app/App.tsx'), 'utf8');
  assert.match(appSource, /loadGenerationRef\.current \+= 1;/);
  assert.match(appSource, /const loadGeneration = loadGenerationRef\.current;/);
  assert.match(appSource, /loadGenerationRef\.current === loadGeneration/);
  assert.match(appSource, /if \(!isCurrentLoad\(\)\) return;/);
});

test('connectivity indicator checks API and database readiness', () => {
  const hookSource = fs.readFileSync(path.join(__dirname, '../../client/src/app/hooks/useOnlineStatus.ts'), 'utf8');
  const indicatorSource = fs.readFileSync(path.join(__dirname, '../../client/src/app/components/ui/NetworkIndicator.tsx'), 'utf8');
  assert.match(hookSource, /fetch\('\/api\/ready'/);
  assert.match(hookSource, /cache: 'no-store'/);
  assert.match(indicatorSource, /Сервер недоступен/);
  assert.doesNotMatch(indicatorSource, /Офлайн-режим/);
});

test('task forms await API result before clearing the draft', () => {
  const details = fs.readFileSync(path.join(__dirname, '../../client/src/app/components/ClientDetails.tsx'), 'utf8');
  const tasksView = fs.readFileSync(path.join(__dirname, '../../client/src/app/components/TasksView.tsx'), 'utf8');
  assert.match(details, /const handleSaveTask = async/);
  assert.match(details, /if \(result === false\) return/);
  assert.match(tasksView, /const handleSaveTask = async/);
  assert.match(tasksView, /if \(result === false\) return/);
});

test('backup uses lock, partial file and unique timestamped final name', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../scripts/backup.sh'), 'utf8');
  assert.match(source, /flock -n 9/);
  assert.match(source, /DUMP_PARTIAL=.*\.partial/);
  assert.match(source, /saas-\$\{TS\}\.dump/);
  assert.match(source, /mv "\$DUMP_PARTIAL" "\$DUMP_FILE"/);
});

test('ambiguous POST retries are idempotent for clients, records and tasks', () => {
  const template = fs.readFileSync(path.join(__dirname, '../sql/100_tenant_template.sql'), 'utf8');
  const routes = fs.readFileSync(path.join(__dirname, '../routes/tenant.cjs'), 'utf8');
  const helpers = fs.readFileSync(path.join(__dirname, '../../client/src/utils/helpers.ts'), 'utf8');
  for (const table of ['clients', 'client_records', 'tasks']) {
    assert.match(template, new RegExp(`idx_${table}_operation_id`));
  }
  assert.equal((routes.match(/ON CONFLICT \(operation_id\)/g) || []).length, 3);
  assert.equal((helpers.match(/operation_id:/g) || []).length >= 3, true);
});
