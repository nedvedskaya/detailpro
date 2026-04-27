'use strict';
/**
 * Одноразовая миграция: переводит FK документов с bookings на client_records.
 *
 * Что и зачем:
 *   work_orders.booking_id, acceptance_acts.booking_id, order_photos.booking_id
 *   изначально ссылались на {{schema}}.bookings(id) — но bookings это календарный
 *   слот мастера (его может и не быть для записей извне). Документы по факту нужны
 *   на каждую запись клиента → FK перевешиваем на client_records(id).
 *
 *   Имена колонок (booking_id) и индексы оставляем как есть, чтобы не трогать код.
 *
 * Идемпотентность:
 *   - DROP CONSTRAINT IF EXISTS не упадёт, если FK уже снят
 *   - ADD CONSTRAINT … IF NOT EXISTS в Postgres нет, поэтому защищаемся
 *     try/catch на 42710 (duplicate_object): «такой constraint уже есть».
 *
 * Запуск:
 *   node server/migrate_documents_fk.cjs
 */

require('dotenv').config();

const { pool, close } = require('./lib/db.cjs');
const { safeIdent } = require('./lib/tenant.cjs');

const TABLES = [
  // имя FK по умолчанию у Postgres: <table>_<column>_fkey
  { table: 'work_orders',     constraint: 'work_orders_booking_id_fkey' },
  { table: 'acceptance_acts', constraint: 'acceptance_acts_booking_id_fkey' },
  { table: 'order_photos',    constraint: 'order_photos_booking_id_fkey' },
];

async function migrateOne(schemaName) {
  const ident = safeIdent(schemaName);
  for (const { table, constraint } of TABLES) {
    // 1. Снимаем старый FK (на bookings или на client_records — неважно).
    await pool.query(
      `ALTER TABLE ${ident}.${table} DROP CONSTRAINT IF EXISTS ${constraint}`
    );
    // 2. Ставим новый FK на client_records.
    try {
      await pool.query(
        `ALTER TABLE ${ident}.${table}
           ADD CONSTRAINT ${constraint}
           FOREIGN KEY (booking_id) REFERENCES ${ident}.client_records(id) ON DELETE CASCADE`
      );
    } catch (err) {
      if (err.code === '42710') {
        // уже есть — повторный прогон, всё нормально
        continue;
      }
      throw err;
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
