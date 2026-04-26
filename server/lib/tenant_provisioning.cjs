'use strict';
/**
 * Tenant provisioning: создание новой студии (тенанта).
 *
 * Что делает createStudio({ schemaName, displayName, ownerEmail, ownerPassword }):
 *   1. INSERT в saas_meta.studios (с trial-доступом 14 дней).
 *   2. CREATE SCHEMA "studio_xxx".
 *   3. Применение server/sql/100_tenant_template.sql к этой схеме
 *      (с подменой {{schema}} → имя схемы через safeIdent).
 *   4. INSERT в saas_meta.users (роль 'admin', is_owner-эквивалент).
 *   5. INSERT seed-данных в studio_xxx (демо-категории).
 * Всё в одной транзакции — если хоть что-то упало, откат до пустого состояния.
 *
 * Почему DDL внутри транзакции:
 *   Postgres поддерживает транзакционный DDL (CREATE SCHEMA, CREATE TABLE).
 *   Это означает, что rollback откатывает создание схемы — критично, иначе
 *   при ошибке посередине останутся «полу-созданные» студии.
 *
 * НЕ использовать прямую конкатенацию schemaName в SQL — только safeIdent().
 *
 * Удаление студии (deleteStudio): ON DELETE CASCADE в saas_meta.studios
 * убивает users/sessions/payments автоматом, а DROP SCHEMA CASCADE — данные.
 * Делаем ОБА явно: вначале DROP SCHEMA (чтобы не остались orphaned cross-schema FK),
 * потом DELETE FROM studios.
 */

const fs = require('node:fs');
const path = require('node:path');
const { pool, withTx } = require('./db.cjs');
const { safeIdent, validateSchemaName, suggestSchemaName } = require('./tenant.cjs');
const { hashPassword } = require('./auth.cjs');

const TENANT_TEMPLATE_PATH = path.join(__dirname, '..', 'sql', '100_tenant_template.sql');
// Триал — 3 дня для всех новых студий. Существующие не трогаем.
const TRIAL_DAYS = Number(process.env.TRIAL_DAYS) || 3;

// Загружаем шаблон один раз при старте — это крошечный файл, кешируется.
let TEMPLATE_SQL_CACHE = null;
function loadTemplateSql() {
  if (TEMPLATE_SQL_CACHE === null) {
    if (!fs.existsSync(TENANT_TEMPLATE_PATH)) {
      throw new Error('tenant_template.sql not found at ' + TENANT_TEMPLATE_PATH);
    }
    TEMPLATE_SQL_CACHE = fs.readFileSync(TENANT_TEMPLATE_PATH, 'utf8');
    if (!TEMPLATE_SQL_CACHE.includes('{{schema}}')) {
      throw new Error('tenant_template.sql не содержит плейсхолдера {{schema}}');
    }
  }
  return TEMPLATE_SQL_CACHE;
}

/**
 * Применяет шаблон per-tenant таблиц к указанной схеме.
 * Используется client из транзакции (см. createStudio).
 * Можно вызвать отдельно — для миграций существующих студий (при добавлении
 * новых таблиц в template нужно гонять на каждой studio_xxx).
 *
 * @param {import('pg').PoolClient | typeof pool} executor — client или pool
 * @param {string} schemaName
 */
async function applyTenantTemplate(executor, schemaName) {
  const ident = safeIdent(schemaName); // бросит, если невалидно
  const tmpl = loadTemplateSql();
  const sql = tmpl.split('{{schema}}').join(ident);
  await executor.query(sql);
}

/**
 * Создаёт новую студию в одной транзакции.
 *
 * @param {object} args
 * @param {string} args.schemaName     — например, 'studio_demo'. Должен пройти validateSchemaName.
 * @param {string} args.displayName    — отображаемое имя студии (для UI).
 * @param {string} args.ownerEmail     — email первого админа (логин).
 * @param {string} args.ownerPassword  — plain-пароль (≥8 символов).
 * @param {string} [args.ownerName]    — имя для отображения (legacy).
 * @param {string} [args.ownerFirstName] — имя для users.first_name.
 * @param {string} [args.ownerLastName]  — фамилия для users.last_name.
 * @param {string} [args.plan='trial'] — стартовый план.
 * @returns {Promise<{ studioId: string, userId: string, schemaName: string }>}
 */
async function createStudio({ schemaName, displayName, ownerEmail, ownerPassword, ownerName, ownerFirstName, ownerLastName, plan }) {
  // Валидация на входе — до открытия транзакции.
  validateSchemaName(schemaName);
  if (!displayName || typeof displayName !== 'string') {
    const e = new Error('display_name_required'); e.code = 'DISPLAY_NAME_REQUIRED'; throw e;
  }
  if (!ownerEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(ownerEmail)) {
    const e = new Error('email_invalid'); e.code = 'EMAIL_INVALID'; throw e;
  }
  if (typeof ownerPassword !== 'string' || ownerPassword.length < 8) {
    const e = new Error('password_too_short'); e.code = 'PASSWORD_TOO_SHORT'; throw e;
  }

  const passwordHash = await hashPassword(ownerPassword); // вне транзакции — scrypt медленный
  const startPlan = plan && ['trial', 'solo', 'studio'].includes(plan) ? plan : 'trial';
  const ident = safeIdent(schemaName);

  return withTx(async (client) => {
    // 1. Регистрируем студию.
    const studioRes = await client.query(
      `INSERT INTO saas_meta.studios (schema_name, display_name, plan, access_until, is_active)
         VALUES ($1, $2, $3, now() + ($4 || ' days')::interval, true)
         RETURNING id`,
      [schemaName, displayName, startPlan, String(TRIAL_DAYS)]
    );
    const studioId = studioRes.rows[0].id;

    // 2. Создаём схему. CREATE SCHEMA не принимает $-параметры → ident.
    await client.query(`CREATE SCHEMA ${ident}`);

    // 3. Применяем шаблон таблиц.
    await applyTenantTemplate(client, schemaName);

    // 4. Создаём первого пользователя — Собственника.
    // Если ownerName был передан как «Имя Фамилия», делим по первому пробелу
    // в first_name/last_name (для совместимости со старым signup-флоу).
    let firstName = ownerFirstName || null;
    let lastName  = ownerLastName  || null;
    if (!firstName && !lastName && ownerName) {
      const parts = ownerName.trim().split(/\s+/);
      firstName = parts[0] || null;
      lastName  = parts.slice(1).join(' ') || null;
    }
    const computedName = ownerName
      || [firstName, lastName].filter(Boolean).join(' ').trim()
      || null;

    let userRes;
    try {
      userRes = await client.query(
        `INSERT INTO saas_meta.users
           (studio_id, email, password_hash, role, name, first_name, last_name, is_active)
           VALUES ($1, $2, $3, 'owner', $4, $5, $6, true)
           RETURNING id`,
        [studioId, ownerEmail.toLowerCase(), passwordHash, computedName, firstName, lastName]
      );
    } catch (err) {
      // unique_violation на email → понятная ошибка
      if (err.code === '23505') {
        const e = new Error('email_already_used'); e.code = 'EMAIL_ALREADY_USED'; throw e;
      }
      throw err;
    }
    const userId = userRes.rows[0].id;

    // 5. Seed: дефолтные категории расходов/доходов.
    await client.query(
      `INSERT INTO ${ident}.categories (name, type, color) VALUES
         ('Услуги', 'income', '#22c55e'),
         ('Аренда', 'expense', '#ef4444'),
         ('Зарплата', 'expense', '#f59e0b'),
         ('Расходники', 'expense', '#3b82f6')`
    );

    return { studioId, userId, schemaName };
  });
}

/**
 * Полное удаление студии: DROP SCHEMA + DELETE FROM studios.
 * Используется только для админских операций (отмена аккаунта по запросу
 * субъекта ПД, GDPR/ФЗ-152 «право на забвение»).
 *
 * ВНИМАНИЕ: это безвозвратное удаление всех данных студии.
 * Перед вызовом убедитесь, что бэкап актуален.
 *
 * @param {string} schemaName
 */
async function deleteStudio(schemaName) {
  validateSchemaName(schemaName);
  const ident = safeIdent(schemaName);

  return withTx(async (client) => {
    // Сначала проверяем, что студия вообще зарегистрирована — иначе риск
    // случайно дропнуть служебную схему (хотя validateSchemaName уже банит saas_meta).
    const studio = await client.query(
      `SELECT id FROM saas_meta.studios WHERE schema_name = $1`,
      [schemaName]
    );
    if (studio.rowCount === 0) {
      const e = new Error('studio_not_found'); e.code = 'STUDIO_NOT_FOUND'; throw e;
    }

    // DROP SCHEMA CASCADE подчищает все таблицы внутри. Cross-schema FK на
    // saas_meta.users внутри этой схемы исчезнут вместе с таблицами.
    await client.query(`DROP SCHEMA IF EXISTS ${ident} CASCADE`);

    // CASCADE на studios → users/sessions/payments автоматически.
    await client.query(`DELETE FROM saas_meta.studios WHERE id = $1`, [studio.rows[0].id]);

    return { schemaName, deletedStudioId: studio.rows[0].id };
  });
}

/**
 * Применяет шаблон ко всем существующим студиям. Полезно при добавлении
 * новых таблиц/индексов в 100_tenant_template.sql — пробежаться по всем
 * studio_xxx и докатить миграцию.
 *
 * Идемпотентно (template — IF NOT EXISTS). Не транзакционно между студиями
 * (каждая в своей короткой транзакции), чтобы одна сломанная студия не
 * блокировала остальные. Возвращает массив результатов.
 */
async function migrateAllStudios() {
  const list = await pool.query(
    `SELECT id, schema_name, display_name FROM saas_meta.studios ORDER BY created_at`
  );
  const results = [];
  for (const studio of list.rows) {
    try {
      await applyTenantTemplate(pool, studio.schema_name);
      results.push({ schemaName: studio.schema_name, ok: true });
    } catch (err) {
      results.push({ schemaName: studio.schema_name, ok: false, error: err.message });
    }
  }
  return results;
}

module.exports = {
  createStudio,
  deleteStudio,
  applyTenantTemplate,
  migrateAllStudios,
  suggestSchemaName, // re-export для удобства роутов signup
};
