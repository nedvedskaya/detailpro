'use strict';
/**
 * Миграция: добавляет client_snapshot/vehicle_snapshot в work_orders и
 * acceptance_acts. Идемпотентна (ADD COLUMN IF NOT EXISTS).
 *
 * Зачем: позволяем заполнять данные клиента и авто прямо из формы документа,
 * если карточки vehicles нет или поля пустые. Snapshot сохраняется в самом
 * документе и используется PDF-генератором поверх данных из БД.
 *
 * Запуск:
 *   node server/migrate_doc_snapshots.cjs
 */

require('dotenv').config();

const { pool, close } = require('./lib/db.cjs');
const { safeIdent } = require('./lib/tenant.cjs');

const TABLES = ['work_orders', 'acceptance_acts'];
const COLS = ['client_snapshot', 'vehicle_snapshot'];

async function migrateOne(schemaName) {
  const ident = safeIdent(schemaName);
  for (const table of TABLES) {
    for (const col of COLS) {
      await pool.query(
        `ALTER TABLE ${ident}.${table}
           ADD COLUMN IF NOT EXISTS ${col} JSONB NOT NULL DEFAULT '{}'::jsonb`
      );
    }
  }
}

async function main() {
  if (!process.env.DB_NAME) {
    console.error('DB_NAME не задан в .env');
    process.exit(1);
  }
  const list = await pool.query(
    `SELECT schema_name FROM saas_meta.studios ORDER BY created_at`
  );
  console.log(`Найдено студий: ${list.rows.length}\n`);

  let ok = 0, fail = 0;
  for (const row of list.rows) {
    try {
      await migrateOne(row.schema_name);
      console.log('  ✓', row.schema_name);
      ok++;
    } catch (err) {
      console.log('  ✗', row.schema_name, '—', err.message);
      fail++;
    }
  }
  console.log(`\nИтого: ${ok} ok, ${fail} ошибок.`);
  if (fail > 0) process.exitCode = 1;
}

main()
  .then(() => close())
  .then(() => process.exit())
  .catch(async (err) => {
    console.error('Миграция упала:', err.message);
    try { await close(); } catch (_) { /* ignore */ }
    process.exit(1);
  });
