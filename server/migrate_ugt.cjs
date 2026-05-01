'use strict';
/**
 * Одноразовая миграция данных из ЮГТ СРМ → Detail Pro.
 *
 *   источник: ugt_tuners (ugtsrm.ru, Postgres TimeWeb 91.222.237.123)
 *   цель:     studio_ugt_tuners (наша saas-crm)
 *
 * Переносит:
 *   • categories (с merge by name+type — не дублирует дефолтный seed целевой студии)
 *   • clients   (32 шт — основное)
 *   • client_records (34 шт — история работ)
 *   • transactions (7 шт — финансы)
 *   • tasks (4 шт — задачи)
 *
 * НЕ переносит (по решению владельца):
 *   • branches, vehicles, services, bookings, tags, entity_tags — пусто или нерелевантно
 *   • users, sessions, login_attempts, password_reset_tokens, payments, subscriptions
 *   • activity_logs (145 строк) — остаются в архиве источника
 *   • app_data — настройки старого CRM, не совпадают с Detail Pro
 *
 * Адаптации:
 *   • branch_id, branch — отбрасываем (Detail Pro single-branch; локация уже в clients.city)
 *   • master_id, assigned_to, created_by — INTEGER в источнике, UUID у нас → NULL
 *   • client_records.tags / transactions.tags — обнуляем `[]` (теги МСК/РНД дублируют city,
 *     не создаём новые сущности в целевой БД)
 *   • client_records.services (новое JSONB поле) — собираем `[{service_id:null, name, price}]`
 *     из service_name+amount источника (формат как в server/lib/services_resolver.cjs)
 *   • transactions.client_name — денормализация имени клиента на момент INSERT
 *   • is_demo = false для всех мигрированных строк
 *
 * Конфиг через .env.migration (gitignored):
 *   SRC_DB_HOST, SRC_DB_PORT, SRC_DB_USER, SRC_DB_PASSWORD, SRC_DB_NAME,
 *   SRC_SCHEMA=ugt_tuners, TARGET_SCHEMA=studio_ugt_tuners
 *
 * Запуск:
 *   node server/migrate_ugt.cjs            # dry-run: считает, печатает план, ROLLBACK
 *   node server/migrate_ugt.cjs --apply    # пишет в целевую БД, COMMIT
 *
 * Идемпотентен через pre-flight check: целевая студия должна быть «пустая»
 * (только дефолтный seed в categories+tags, 0 в clients/records/transactions/tasks).
 * После успешного --apply повторный запуск упрётся в pre-flight.
 */

const path = require('node:path');
const fs = require('node:fs');

// .env.migration — отдельный файл, чтобы не смешивать с прод-credentials.
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env.migration') });
// Параллельно подгружаем основной .env для DB_* (целевая БД).
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const { Pool } = require('pg');
const { pool: targetPool, withTx, close: closeTarget } = require('./lib/db.cjs');

const APPLY = process.argv.includes('--apply');

// ──────────────────────────────────────────────────────────────────────
// Конфиг и валидация окружения.
// ──────────────────────────────────────────────────────────────────────
function requireEnv(key) {
  const v = process.env[key];
  if (!v) {
    console.error(`FAIL: переменная ${key} не задана в .env.migration`);
    process.exit(1);
  }
  return v;
}

const SRC_HOST = requireEnv('SRC_DB_HOST');
const SRC_PORT = Number(requireEnv('SRC_DB_PORT'));
const SRC_USER = requireEnv('SRC_DB_USER');
const SRC_PASSWORD = requireEnv('SRC_DB_PASSWORD');
const SRC_DB_NAME = requireEnv('SRC_DB_NAME');
const SRC_SCHEMA = requireEnv('SRC_SCHEMA');         // ugt_tuners
const TARGET_SCHEMA = requireEnv('TARGET_SCHEMA');   // studio_ugt_tuners

// Хардкоженный whitelist целевой схемы — защита от случайного перезаписывания
// чужой студии через подкрученный .env.migration. Скрипт ОДНОРАЗОВЫЙ.
if (TARGET_SCHEMA !== 'studio_ugt_tuners') {
  console.error(`FAIL: TARGET_SCHEMA='${TARGET_SCHEMA}' не совпадает с whitelist 'studio_ugt_tuners'.`);
  console.error('Это одноразовый скрипт под перенос ЮГТ. Если нужно мигрировать в другую студию — пиши новый скрипт.');
  process.exit(1);
}

// ──────────────────────────────────────────────────────────────────────
// Source pool — отдельный, прямой коннект к Postgres TimeWeb.
// SSL: TimeWeb требует sslmode=require, серт самоподписной → rejectUnauthorized=false.
// Это ок для одноразового read-only коннекта; для прод-аппа нужен CA.
// ──────────────────────────────────────────────────────────────────────
const sourcePool = new Pool({
  host: SRC_HOST,
  port: SRC_PORT,
  user: SRC_USER,
  password: SRC_PASSWORD,
  database: SRC_DB_NAME,
  ssl: { rejectUnauthorized: false },
  max: 4,
  connectionTimeoutMillis: 10_000,
});

// ──────────────────────────────────────────────────────────────────────
// Хелперы.
// ──────────────────────────────────────────────────────────────────────

// Безопасная вставка identifier-а схемы в SQL: только из whitelist.
const SRC_IDENT = SRC_SCHEMA === 'ugt_tuners' ? '"ugt_tuners"' : null;
const TGT_IDENT = TARGET_SCHEMA === 'studio_ugt_tuners' ? '"studio_ugt_tuners"' : null;
if (!SRC_IDENT || !TGT_IDENT) {
  console.error('FAIL: SRC_SCHEMA или TARGET_SCHEMA не из whitelist.');
  process.exit(1);
}

function srcQuery(text, params = []) {
  return sourcePool.query(text.replaceAll('{{src}}', SRC_IDENT), params);
}

function tgtQuery(client, text, params = []) {
  return client.query(text.replaceAll('{{tgt}}', TGT_IDENT), params);
}

async function countSourceTables() {
  const r = await srcQuery(`
    SELECT 'categories'     AS t, COUNT(*)::int AS n FROM {{src}}.categories
    UNION ALL SELECT 'clients',        COUNT(*)::int FROM {{src}}.clients
    UNION ALL SELECT 'client_records', COUNT(*)::int FROM {{src}}.client_records
    UNION ALL SELECT 'transactions',   COUNT(*)::int FROM {{src}}.transactions
    UNION ALL SELECT 'tasks',          COUNT(*)::int FROM {{src}}.tasks
    ORDER BY t
  `);
  return Object.fromEntries(r.rows.map((row) => [row.t, row.n]));
}

async function countTargetTables(client) {
  const r = await tgtQuery(client, `
    SELECT 'categories'     AS t, COUNT(*)::int AS n FROM {{tgt}}.categories
    UNION ALL SELECT 'clients',        COUNT(*)::int FROM {{tgt}}.clients
    UNION ALL SELECT 'client_records', COUNT(*)::int FROM {{tgt}}.client_records
    UNION ALL SELECT 'transactions',   COUNT(*)::int FROM {{tgt}}.transactions
    UNION ALL SELECT 'tasks',          COUNT(*)::int FROM {{tgt}}.tasks
    ORDER BY t
  `);
  return Object.fromEntries(r.rows.map((row) => [row.t, row.n]));
}

// ──────────────────────────────────────────────────────────────────────
// Миграционные шаги.
//
// Каждый шаг работает в одной целевой транзакции (client). Возвращает
// мапу old_id → new_id для следующих шагов.
// ──────────────────────────────────────────────────────────────────────

/**
 * Categories: merge by (name, type). Если категория с таким именем+типом уже
 * есть в целевой студии (дефолтный seed «Услуги», «Аренда», «Расходники»…),
 * используем существующий id. Иначе INSERT.
 */
async function migrateCategories(client) {
  const map = new Map(); // old_id → new_id
  const src = await srcQuery(`SELECT id, name, type, color FROM {{src}}.categories ORDER BY id`);

  for (const row of src.rows) {
    // Type должен быть из whitelist цели; источник имеет 'income'/'expense'.
    const type = ['income', 'expense', 'service'].includes(row.type) ? row.type : 'expense';

    // Ищем существующую с тем же name+type.
    const existing = await tgtQuery(client,
      `SELECT id FROM {{tgt}}.categories WHERE name = $1 AND type = $2 LIMIT 1`,
      [row.name, type]
    );
    if (existing.rowCount > 0) {
      map.set(row.id, existing.rows[0].id);
      continue;
    }

    const ins = await tgtQuery(client,
      `INSERT INTO {{tgt}}.categories (name, type, color)
       VALUES ($1, $2, $3)
       RETURNING id`,
      [row.name, type, row.color || null]
    );
    map.set(row.id, ins.rows[0].id);
  }
  return map;
}

/**
 * Clients: переносим имя/телефон/email/notes/city/source/birth_date/avatar.
 * Дропаем branch_id, branch (single-tenant у Detail Pro). is_demo=false.
 */
async function migrateClients(client) {
  const map = new Map();
  const src = await srcQuery(`
    SELECT id, name, phone, email, notes, city, source, birth_date, avatar, created_at
      FROM {{src}}.clients
     ORDER BY id
  `);
  for (const row of src.rows) {
    const ins = await tgtQuery(client,
      `INSERT INTO {{tgt}}.clients
         (name, phone, email, notes, city, source, birth_date, avatar, is_demo, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, false, $9, $9)
       RETURNING id`,
      [
        row.name,
        row.phone || null,
        row.email || null,
        row.notes || null,
        row.city || null,
        row.source || null,
        row.birth_date || null,
        row.avatar || null,
        row.created_at || new Date(),
      ]
    );
    map.set(row.id, ins.rows[0].id);
  }
  return map;
}

/**
 * client_records: маппим client_id, category_id (через свежие маппинги).
 * vehicle_id, booking_id, master_id → NULL (нет источника).
 * services JSONB собираем из service_name + amount (одна строка-снапшот).
 * tags обнуляем (`[]`).
 */
async function migrateRecords(client, clientMap, categoryMap) {
  const map = new Map();
  const src = await srcQuery(`
    SELECT id, client_id, service_name, description, amount, advance, advance_date,
           date, end_date, time, payment_status, is_paid, is_completed,
           category_id, created_at
      FROM {{src}}.client_records
     ORDER BY id
  `);
  for (const row of src.rows) {
    const newClientId = clientMap.get(row.client_id);
    if (!newClientId) {
      throw new Error(`client_record.id=${row.id}: client_id=${row.client_id} не найден в clientMap`);
    }
    const newCategoryId = row.category_id ? (categoryMap.get(row.category_id) ?? null) : null;

    // Snapshot услуг записи: одна custom-строка (service_id=null) — формат как
    // в server/lib/services_resolver.cjs. amount пересчитан на бэке как сумма
    // services[].price; здесь у нас одна строка, так что совпадает.
    const services = [{
      service_id: null,
      name: row.service_name,
      price: Number(row.amount) || 0,
    }];

    // payment_status: source может быть 'none'|'advance'|'paid' — совпадает с целью.
    const paymentStatus = ['none', 'advance', 'paid'].includes(row.payment_status)
      ? row.payment_status : 'none';

    const ins = await tgtQuery(client,
      `INSERT INTO {{tgt}}.client_records
         (client_id, vehicle_id, booking_id, category_id, master_id, service_name,
          description, amount, advance, advance_date, date, end_date, time,
          payment_status, is_paid, is_completed, tags, services, is_demo,
          created_at, updated_at)
       VALUES ($1, NULL, NULL, $2, NULL, $3, $4, $5, $6, $7, $8, $9, $10,
               $11, $12, $13, '[]'::jsonb, $14::jsonb, false, $15, $15)
       RETURNING id`,
      [
        newClientId,
        newCategoryId,
        row.service_name,
        row.description || null,
        Number(row.amount) || 0,
        Number(row.advance) || 0,
        row.advance_date || null,
        row.date,
        row.end_date || null,
        row.time || null,
        paymentStatus,
        Boolean(row.is_paid),
        Boolean(row.is_completed),
        JSON.stringify(services),
        row.created_at || new Date(),
      ]
    );
    map.set(row.id, ins.rows[0].id);
  }
  return map;
}

/**
 * Transactions: маппим client_id, category_id, client_record_id.
 * client_name берём из источника clients.name на момент миграции.
 * tags='[]', created_by=NULL, booking_id=NULL.
 */
async function migrateTransactions(client, clientMap, categoryMap, recordMap) {
  let inserted = 0;
  const src = await srcQuery(`
    SELECT t.id, t.type, t.amount, t.category, t.description, t.date, t.time,
           t.category_id, t.client_id, t.client_record_id, t.created_at,
           c.name AS client_name_snapshot
      FROM {{src}}.transactions t
      LEFT JOIN {{src}}.clients c ON c.id = t.client_id
     ORDER BY t.id
  `);
  for (const row of src.rows) {
    // type: source 'income'/'expense'; цель допускает 'service' тоже — оставляем что было.
    const type = ['income', 'expense', 'service'].includes(row.type) ? row.type : 'income';

    const newClientId = row.client_id ? (clientMap.get(row.client_id) ?? null) : null;
    const newCategoryId = row.category_id ? (categoryMap.get(row.category_id) ?? null) : null;
    const newRecordId = row.client_record_id ? (recordMap.get(row.client_record_id) ?? null) : null;

    await tgtQuery(client,
      `INSERT INTO {{tgt}}.transactions
         (type, amount, category_id, category, description, date, time,
          booking_id, client_record_id, client_id, client_name, created_by,
          tags, is_demo, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NULL, $8, $9, $10, NULL,
               '[]'::jsonb, false, $11)`,
      [
        type,
        Number(row.amount) || 0,
        newCategoryId,
        row.category || null,         // денорм-строка (как было в источнике)
        row.description || null,
        row.date,
        row.time || null,
        newRecordId,
        newClientId,
        row.client_name_snapshot || null,
        row.created_at || new Date(),
      ]
    );
    inserted++;
  }
  return inserted;
}

/**
 * Tasks: маппим client_id, vehicle_id всегда NULL, assigned_to NULL.
 * Status и priority в source совпадают с whitelist цели.
 */
async function migrateTasks(client, clientMap) {
  let inserted = 0;
  const src = await srcQuery(`
    SELECT id, title, description, status, priority, due_date, due_time,
           client_id, completed_at, created_at
      FROM {{src}}.tasks
     ORDER BY id
  `);
  for (const row of src.rows) {
    const newClientId = row.client_id ? (clientMap.get(row.client_id) ?? null) : null;

    const status = ['pending', 'in_progress', 'done', 'cancelled'].includes(row.status)
      ? row.status : 'pending';
    const priority = ['low', 'medium', 'high', 'urgent'].includes(row.priority)
      ? row.priority : 'medium';

    await tgtQuery(client,
      `INSERT INTO {{tgt}}.tasks
         (title, description, status, priority, due_date, due_time,
          client_id, vehicle_id, assigned_to, completed_at, is_demo,
          created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NULL, NULL, $8, false, $9, $9)`,
      [
        row.title,
        row.description || null,
        status,
        priority,
        row.due_date || null,
        row.due_time || null,
        newClientId,
        row.completed_at || null,
        row.created_at || new Date(),
      ]
    );
    inserted++;
  }
  return inserted;
}

// ──────────────────────────────────────────────────────────────────────
// Pre-flight: проверяем что целевая студия «пустая» (только дефолтный seed).
// ──────────────────────────────────────────────────────────────────────
async function preflight(client) {
  // Студия должна существовать и принадлежать ugt.tuners@yandex.ru.
  const studio = await client.query(
    `SELECT s.id, s.display_name, u.email
       FROM saas_meta.studios s
       JOIN saas_meta.users u ON u.studio_id = s.id AND u.role = 'owner'
      WHERE s.schema_name = $1`,
    [TARGET_SCHEMA]
  );
  if (studio.rowCount === 0) {
    throw new Error(`студия ${TARGET_SCHEMA} не найдена в saas_meta.studios`);
  }
  const expectedEmail = 'ugt.tuners@yandex.ru';
  if (studio.rows[0].email !== expectedEmail) {
    throw new Error(
      `владелец ${TARGET_SCHEMA} = ${studio.rows[0].email}, ожидался ${expectedEmail}. ` +
      'Не лью данные в чужую студию.'
    );
  }

  const counts = await countTargetTables(client);
  // Допустимо: дефолтный seed категорий и тегов (создаётся при регистрации).
  // Но clients/records/transactions/tasks должны быть строго 0 — иначе риск дублей.
  const mustBeZero = ['clients', 'client_records', 'transactions', 'tasks'];
  for (const t of mustBeZero) {
    if (counts[t] !== 0) {
      throw new Error(
        `${TARGET_SCHEMA}.${t} = ${counts[t]} (ожидалось 0). ` +
        'Студия не пустая — миграция отменена. Очисти таблицу или выбери другую студию.'
      );
    }
  }
  console.log(`pre-flight ok: студия "${studio.rows[0].display_name}" (${studio.rows[0].email}) пуста`);
}

// ──────────────────────────────────────────────────────────────────────
// Main.
// ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n${APPLY ? '🚀 WET-RUN (--apply)' : '🔍 DRY-RUN (no changes)'}`);
  console.log(`source: ${SRC_USER}@${SRC_HOST}:${SRC_PORT}/${SRC_DB_NAME}.${SRC_SCHEMA}`);
  console.log(`target: ${process.env.DB_USER}@${process.env.DB_HOST}/${process.env.DB_NAME}.${TARGET_SCHEMA}\n`);

  // Ping обеих БД до тяжёлой работы.
  await sourcePool.query('SELECT 1');
  console.log('✓ source connection ok');
  await targetPool.query('SELECT 1');
  console.log('✓ target connection ok');

  const srcCounts = await countSourceTables();
  console.log('source counts:', srcCounts);

  // Вся миграция в одной транзакции — ROLLBACK при любой ошибке или dry-run.
  await withTx(async (client) => {
    await preflight(client);

    console.log('\n─── categories ───');
    const categoryMap = await migrateCategories(client);
    console.log(`  ✓ categories: ${categoryMap.size} мапнуто (часть merged с дефолтными)`);

    console.log('─── clients ───');
    const clientMap = await migrateClients(client);
    console.log(`  ✓ clients: ${clientMap.size} перенесено`);

    console.log('─── client_records ───');
    const recordMap = await migrateRecords(client, clientMap, categoryMap);
    console.log(`  ✓ client_records: ${recordMap.size} перенесено`);

    console.log('─── transactions ───');
    const txCount = await migrateTransactions(client, clientMap, categoryMap, recordMap);
    console.log(`  ✓ transactions: ${txCount} перенесено`);

    console.log('─── tasks ───');
    const taskCount = await migrateTasks(client, clientMap);
    console.log(`  ✓ tasks: ${taskCount} перенесено`);

    const tgtCounts = await countTargetTables(client);
    console.log('\ntarget counts AFTER (внутри транзакции):', tgtCounts);

    // Sanity-check: source counts должны быть ≤ target counts (target ещё имеет
    // дефолтный seed для categories).
    if (tgtCounts.clients !== srcCounts.clients) {
      throw new Error(`mismatch clients: src=${srcCounts.clients}, tgt=${tgtCounts.clients}`);
    }
    if (tgtCounts.client_records !== srcCounts.client_records) {
      throw new Error(`mismatch client_records: src=${srcCounts.client_records}, tgt=${tgtCounts.client_records}`);
    }
    if (tgtCounts.transactions !== srcCounts.transactions) {
      throw new Error(`mismatch transactions: src=${srcCounts.transactions}, tgt=${tgtCounts.transactions}`);
    }
    if (tgtCounts.tasks !== srcCounts.tasks) {
      throw new Error(`mismatch tasks: src=${srcCounts.tasks}, tgt=${tgtCounts.tasks}`);
    }

    if (!APPLY) {
      console.log('\n⛔ DRY-RUN: ROLLBACK. Запусти с --apply для записи.');
      throw new Error('__DRY_RUN_ROLLBACK__');
    }

    console.log('\n✅ COMMIT. Все вставки залиты.');
  }).catch((err) => {
    if (err.message === '__DRY_RUN_ROLLBACK__') return; // нормальный exit dry-run
    throw err;
  });

  // Финальный счёт ПОСЛЕ COMMIT (или после ROLLBACK для dry-run).
  console.log('\n─── итоговые counts в целевой БД ───');
  const final = await countTargetTables({ query: (...args) => targetPool.query(...args) });
  console.log(final);
}

main()
  .then(async () => {
    await sourcePool.end();
    await closeTarget();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error('\n❌ FAIL:', err.message);
    if (err.stack) console.error(err.stack);
    try { await sourcePool.end(); } catch (_) {}
    try { await closeTarget(); } catch (_) {}
    process.exit(1);
  });
