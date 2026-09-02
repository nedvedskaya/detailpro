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
  assert.match(source, /BACKUP_WRITES_QUIESCED/);
  assert.match(source, /BACKUP_COMPLETE=0/);
  assert.match(source, /rm -f "\$DUMP_FILE" "\$DUMP_FILE\.sha256"/);
  assert.ok(source.indexOf('BACKUP_COMPLETE=1') > source.indexOf('mv "$MANIFEST_PARTIAL" "$MANIFEST_FILE"'));
});

test('backup completion requires database and all persistent CRM files', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../scripts/backup.sh'), 'utf8');
  assert.match(source, /PERSISTENT_DATA_DIR=.*\$PROJECT_ROOT\/var/);
  assert.match(source, /files-\$\{TS\}\.tgz/);
  assert.match(source, /fail "tar persistent data failed"/);
  assert.match(source, /database_sha256=/);
  assert.match(source, /files_sha256=/);
  assert.match(source, /database_source_bytes=/);
  assert.match(source, /files_uncompressed_bytes=/);
  assert.match(source, /clients_count=\$CLIENTS_SOURCE_COUNT/);
  assert.match(source, /client_records_count=\$RECORDS_SOURCE_COUNT/);
  assert.match(source, /tasks_count=\$TASKS_SOURCE_COUNT/);
  assert.ok(source.indexOf('mv "$MANIFEST_PARTIAL" "$MANIFEST_FILE"') < source.lastIndexOf('lastrun.timestamp'));
});

test('off-site backup fails closed on stale, incomplete or public recovery targets', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../scripts/offsite-backup.sh'), 'utf8');
  assert.match(source, /recovery-\*\.manifest/);
  assert.match(source, /newest completed recovery point is stale/);
  assert.match(source, /SOURCE_STARTED_EPOCH/);
  assert.match(source, /HOURLY_KEY=.*SOURCE_STARTED_EPOCH/);
  assert.match(source, /database_sha256/);
  assert.match(source, /files_sha256/);
  assert.match(source, /refusing to upload CRM recovery data to a publicly visible GitHub repository/);
  assert.match(source, /remote GitHub commit verification failed/);
  assert.match(source, /unexpected file in off-site repository/);
  assert.match(source, /already uploaded; success marker intentionally unchanged/);
});

test('restore drill cannot target production and restores database plus files', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../scripts/verify-backup-restore.sh'), 'utf8');
  const firstDrop = source.indexOf('dropdb');
  assert.ok(firstDrop > source.indexOf('saas_crm_restore_verify|saas_crm_restore_verify_*'));
  assert.ok(firstDrop > source.indexOf('verification database must never equal the production database'));
  assert.match(source, /pg_restore --no-owner --no-acl --exit-on-error/);
  assert.match(source, /files\.tgz/);
  assert.match(source, /files\/var\/documents/);
  assert.match(source, /DB_SOURCE_BYTES \* 2 \+ FILES_SOURCE_BYTES \* 2/);
  assert.match(source, /runuser -u nobody -- tar/);
  assert.match(source, /restored database references \$MISSING_FILES missing persistent file/);
  assert.match(source, /restored critical counts differ from manifest/);
  assert.match(source, /extracted file inventory differs from manifest/);
  assert.match(source, /could not read avatar references from restored database/);
  assert.match(source, /could not read document references from restored schema/);
  assert.doesNotMatch(source, /done < <\(runuser -u postgres -- psql/);
});

test('backup unit quiesces writes and always brings CRM back', () => {
  const unit = fs.readFileSync(path.join(__dirname, '../../scripts/saas-crm-backup.service'), 'utf8');
  const wrapper = fs.readFileSync(path.join(__dirname, '../../scripts/run-quiesced-backup.sh'), 'utf8');
  const healthcheck = fs.readFileSync(path.join(__dirname, '../../scripts/healthcheck.sh'), 'utf8');
  assert.match(unit, /run-quiesced-backup\.sh/);
  assert.match(unit, /ExecStopPost=-\/bin\/systemctl start saas-crm\.service/);
  assert.match(wrapper, /flock -x 8/);
  assert.match(wrapper, /systemctl stop saas-crm\.service/);
  assert.match(wrapper, /BACKUP_WRITES_QUIESCED=1/);
  assert.match(healthcheck, /saas-crm-backup-quiesced/);
  const lastReadyProbe = healthcheck.lastIndexOf('if is_ready');
  const finalLock = healthcheck.indexOf('flock -n 8');
  const restart = healthcheck.indexOf('systemctl restart saas-crm.service');
  assert.ok(lastReadyProbe < finalLock && finalLock < restart);
  const audit = fs.readFileSync(path.join(__dirname, '../../scripts/reliability-audit.sh'), 'utf8');
  assert.match(audit, /flock -n 8/);
  assert.match(audit, /audit skipped during coordinated maintenance/);
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
