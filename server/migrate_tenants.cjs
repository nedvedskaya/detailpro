'use strict';
/**
 * Миграция per-tenant таблиц на ВСЕХ зарегистрированных студиях.
 *
 * Зачем нужен: 100_tenant_template.sql применяется один раз в момент
 * создания студии. Когда мы добавляем новые таблицы/индексы в шаблон,
 * существующие студии о них не узнают — пока не догнать миграцию.
 *
 * Скрипт запускает applyTenantTemplate() на каждой studio_xxx. Шаблон
 * полностью идемпотентен (CREATE TABLE/INDEX IF NOT EXISTS), поэтому
 * повторный прогон на уже мигрированной студии — нулёвая операция.
 *
 * Не транзакционно между студиями: если одна сломается, остальные всё
 * равно мигрируются. В конце выводится сводка.
 *
 * Запуск:
 *   npm run migrate:tenants
 *   ↓
 *   node server/migrate_tenants.cjs
 */

require('dotenv').config();

const { close } = require('./lib/db.cjs');
const { migrateAllStudios } = require('./lib/tenant_provisioning.cjs');

async function main() {
  if (!process.env.DB_NAME) {
    console.error('Не задан DB_NAME в окружении. Скопируй .env.example в .env.');
    process.exit(1);
  }

  console.log('Применяем 100_tenant_template.sql ко всем студиям…\n');

  const results = await migrateAllStudios();
  let okCount = 0, failCount = 0;
  for (const r of results) {
    if (r.ok) {
      console.log('  ✓', r.schemaName);
      okCount++;
    } else {
      console.log('  ✗', r.schemaName, '—', r.error);
      failCount++;
    }
  }

  console.log(`\nИтого: ${okCount} ok, ${failCount} ошибок.`);
  if (failCount > 0) process.exitCode = 1;
}

main()
  .then(() => close())
  .then(() => process.exit())
  .catch(async (err) => {
    console.error('\nМиграция упала:', err.message);
    try { await close(); } catch (_) { /* ignore */ }
    process.exit(1);
  });
