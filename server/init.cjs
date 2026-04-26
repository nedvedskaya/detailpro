'use strict';
/**
 * Bootstrap: применяет SQL-миграции из server/sql/ в порядке имени файла.
 *
 * На текущем этапе там только `000_saas_meta.sql` — служебная схема.
 * Когда появятся клиентские (per-tenant) миграции, они будут лежать в
 * server/sql/tenant/ и применяться отдельно (при создании студии).
 *
 * Идемпотентность: каждая SQL-миграция сама по себе идемпотентна
 * (CREATE ... IF NOT EXISTS). Нет таблицы schema_migrations и нет версионирования —
 * на этом этапе хватает «накатить ещё раз, ничего не сломается».
 *
 * Когда нужна будет полноценная миграционная система (ALTER, DROP COLUMN и т.д.) —
 * добавим schema_migrations(filename, applied_at) и проверку перед каждым файлом.
 *
 * Запуск:
 *   npm run init
 *   ↓
 *   node server/init.cjs
 */

require('dotenv').config();

const fs = require('node:fs');
const path = require('node:path');
const { pool, close } = require('./lib/db.cjs');

const SQL_DIR = path.join(__dirname, 'sql');

async function main() {
  if (!process.env.DB_NAME) {
    console.error('Не задан DB_NAME в окружении. Скопируй .env.example в .env.');
    process.exit(1);
  }

  const files = fs.readdirSync(SQL_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  if (files.length === 0) {
    console.log('Нет SQL-файлов в', SQL_DIR);
    return;
  }

  console.log('Применяем миграции в БД', process.env.DB_NAME, 'на', process.env.DB_HOST);

  for (const file of files) {
    const fullPath = path.join(SQL_DIR, file);
    const sql = fs.readFileSync(fullPath, 'utf8');
    // Файлы с плейсхолдером {{schema}} — это per-tenant шаблоны, они применяются
    // только на конкретную studio_xxx через tenant_provisioning.cjs, а не глобально.
    if (sql.includes('{{schema}}')) {
      console.log('  ↷ ' + file + ' (per-tenant template — skipped, applied on studio create)');
      continue;
    }
    process.stdout.write('  → ' + file + ' ... ');
    try {
      await pool.query(sql);
      console.log('ok');
    } catch (err) {
      console.log('FAILED');
      console.error('     ' + err.message);
      throw err;
    }
  }

  // Краткий отчёт о состоянии saas_meta
  const tables = await pool.query(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'saas_meta' ORDER BY table_name`
  );
  console.log('\nТаблицы в saas_meta:');
  for (const row of tables.rows) {
    console.log('  •', row.table_name);
  }

  const studios = await pool.query('SELECT count(*)::int AS n FROM saas_meta.studios');
  console.log('\nЗарегистрированных студий:', studios.rows[0].n);
}

main()
  .then(() => close())
  .then(() => {
    console.log('\nГотово.');
    process.exit(0);
  })
  .catch(async (err) => {
    console.error('\nИнициализация не удалась:', err.message);
    try { await close(); } catch (_) { /* ignore */ }
    process.exit(1);
  });
