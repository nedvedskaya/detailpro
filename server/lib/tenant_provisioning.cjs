'use strict';
/**
 * Tenant provisioning: создание новой студии (тенанта).
 *
 * Что делает createStudio({ schemaName, displayName, ownerEmail, ownerPassword }):
 *   1. INSERT в saas_meta.studios (с trial-доступом 7 дней).
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
const crypto = require('node:crypto');
const { pool, withTx } = require('./db.cjs');
const { safeIdent, validateSchemaName, suggestSchemaName } = require('./tenant.cjs');
const { hashPassword } = require('./auth.cjs');
const { isValidEmail, assertStrongPassword } = require('./validation.cjs');
const { seedDemo } = require('./demo_seed.cjs');

// 8-символьный URL-safe код. Алфавит без I/O/0/1, чтобы не путать в наборе вручную.
const REFERRAL_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function generateReferralCode() {
  // 8 байт случайности, по 1 байту → индекс в алфавит длиной 32 — равномерно.
  const buf = crypto.randomBytes(8);
  let out = '';
  for (let i = 0; i < 8; i++) out += REFERRAL_ALPHABET[buf[i] % REFERRAL_ALPHABET.length];
  return out;
}

const TENANT_TEMPLATE_PATH = path.join(__dirname, '..', 'sql', '100_tenant_template.sql');
// Триал — 7 дней для всех новых студий. Существующие не трогаем.
// Индивидуальные продления делаем вручную через UPDATE saas_meta.studios.
// Можно переопределить переменной TRIAL_DAYS в .env.
const TRIAL_DAYS = Number(process.env.TRIAL_DAYS) || 7;

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
async function createStudio({ schemaName, displayName, ownerEmail, ownerPassword, ownerName, ownerFirstName, ownerLastName, plan, referredByCode, tgSignupToken }) {
  // Валидация на входе — до открытия транзакции.
  validateSchemaName(schemaName);
  if (!displayName || typeof displayName !== 'string') {
    const e = new Error('display_name_required'); e.code = 'DISPLAY_NAME_REQUIRED'; throw e;
  }
  if (!isValidEmail(ownerEmail)) {
    const e = new Error('email_invalid'); e.code = 'EMAIL_INVALID'; throw e;
  }
  // Раннее отклонение слабого пароля — до scrypt и DDL.
  // hashPassword() ниже тоже бы отклонил, но raw-результат пришёл бы как
  // generic 500 в auth.cjs/signup error handler — а нам нужны коды
  // PASSWORD_TOO_SHORT / PASSWORD_TOO_COMMON для точного сообщения.
  assertStrongPassword(ownerPassword);

  const passwordHash = await hashPassword(ownerPassword); // вне транзакции — scrypt медленный
  const startPlan = plan && ['trial', 'solo', 'studio'].includes(plan) ? plan : 'trial';
  const ident = safeIdent(schemaName);

  return withTx(async (client) => {
    // 0. Если signup пришёл с ?ref=CODE — находим студию-реферера.
    //    Невалидный код не блокирует регистрацию, просто не привязываем —
    //    лучше пустить нового клиента, чем уронить signup из-за опечатки в ref.
    let referredById = null;
    if (referredByCode && typeof referredByCode === 'string') {
      const ref = await client.query(
        'SELECT id FROM saas_meta.studios WHERE referral_code = $1',
        [referredByCode.trim().toUpperCase()]
      );
      if (ref.rows[0]) referredById = ref.rows[0].id;
    }

    // Генерация уникального referral_code. Шанс коллизии 8 символов из 32-букв.
    // алфавита (~10^12) ничтожен, но честно ретраим до 5 раз ради идемпотентности.
    let referralCode = null;
    let studioId = null;
    for (let attempt = 0; attempt < 5; attempt++) {
      const candidate = generateReferralCode();
      try {
        const studioRes = await client.query(
          `INSERT INTO saas_meta.studios
              (schema_name, display_name, plan, access_until, is_active,
               referral_code, referred_by)
             VALUES ($1, $2, $3, now() + ($4 || ' days')::interval, true, $5, $6)
             RETURNING id`,
          [schemaName, displayName, startPlan, String(TRIAL_DAYS), candidate, referredById]
        );
        studioId = studioRes.rows[0].id;
        referralCode = candidate;
        break;
      } catch (err) {
        // 23505 на uq_studios_referral_code → ретраим с новым кодом.
        // Всё остальное (например, schema_name_taken) — пробрасываем.
        if (err.code === '23505' && /referral_code/.test(err.constraint || '')) continue;
        throw err;
      }
    }
    if (!studioId) throw new Error('failed_to_generate_referral_code');

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

    // 4.5. Если signup пришёл с TG-токеном (сценарий «бот → сайт»), гасим
    // токен и линкуем tg_* поля прямо в этой же транзакции. Если токен
    // протух / уже потрачен — НЕ валим signup, просто возвращаем флаг
    // tgLinked=false, чтобы фронт мог показать «бот можно подключить позже».
    let tgLinked = false;
    let tgConflict = false;        // токен ок, но этот tg_user_id уже занят другим аккаунтом
    if (tgSignupToken && typeof tgSignupToken === 'string') {
      const consumed = await client.query(
        `UPDATE saas_meta.tg_signup_tokens
            SET consumed_at = now(), consumed_user_id = $1
          WHERE token = $2
            AND consumed_at IS NULL
            AND expires_at > now()
          RETURNING tg_user_id, tg_chat_id, tg_username`,
        [userId, tgSignupToken]
      );
      if (consumed.rowCount > 0) {
        const tg = consumed.rows[0];
        // На случай гонки (тот же tg_user_id уже привязан где-то) —
        // ловим 23505 на UNIQUE(saas_meta.users.tg_user_id) и помечаем
        // tgConflict=true, чтобы роут signup мог рассказать про /unlink.
        try {
          await client.query(
            `UPDATE saas_meta.users
                SET tg_user_id   = $1,
                    tg_chat_id   = $2,
                    tg_username  = $3,
                    tg_linked_at = now()
              WHERE id = $4`,
            [tg.tg_user_id, tg.tg_chat_id, tg.tg_username, userId]
          );
          tgLinked = true;
        } catch (err) {
          if (err.code === '23505' && /tg_user_id/.test(err.constraint || '')) {
            tgConflict = true;
            // Не валим транзакцию: signup пройдёт без линка TG.
            // Чтобы транзакция продолжила работать после ошибки —
            // придётся бросить и вернуться на новый коннект... но
            // postgres aborts transaction on any error. Поэтому здесь
            // действительно надо бросить дальше — пусть signup упадёт
            // и пользователь увидит понятную ошибку. См. catch выше.
            const e = new Error('tg_already_linked'); e.code = 'TG_ALREADY_LINKED'; throw e;
          }
          throw err;
        }
      }
      // Если consumed.rowCount === 0 — токен невалиден/просрочен.
      // signup идёт дальше без TG-линка.
    }

    // 5. Seed: дефолтные категории расходов/доходов.
    await client.query(
      `INSERT INTO ${ident}.categories (name, type, color) VALUES
         ('Услуги',    'income',  '#22c55e'),
         ('Предоплата','income',  '#f97316'),
         ('Аренда',    'expense', '#ef4444'),
         ('Зарплата',  'expense', '#f59e0b'),
         ('Расходники','expense', '#3b82f6'),
         ('Прочее',    'expense', '#a3a3a3')`
    );

    // 6. Seed: демо-данные (2 клиента + полный цикл) — чтобы новый юзер
    // не упёрся в пустые экраны. is_demo=TRUE на всех строках; в Профиле
    // есть кнопка «Очистить демо», которая снесёт всё одной транзакцией.
    // Падение seed-демо НЕ должно валить регистрацию — оборачиваем в
    // try/catch и логируем, но не пробрасываем.
    try {
      await seedDemo(client, schemaName, userId);
    } catch (err) {
      console.error(`[provisioning] demo seed failed for ${schemaName}:`, err.message);
    }

    return { studioId, userId, schemaName, tgLinked };
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
