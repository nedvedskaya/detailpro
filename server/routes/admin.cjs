'use strict';
/**
 * Admin routes: управление пользователями студии (manager/master).
 *
 *   GET    /api/admin/users          — список пользователей студии
 *   POST   /api/admin/users          — создать пользователя (с проверкой лимита тарифа)
 *   PUT    /api/admin/users/:id      — обновить (role, name, is_active)
 *   PUT    /api/admin/users/:id/block — выключить (is_active=false) + invalidate sessions
 *   DELETE /api/admin/users/:id      — удалить (CASCADE снимет сессии)
 *
 * Все роуты доступны только role='owner' и только в рамках своей студии:
 * проверка studio_id = req.session.studioId внутри каждого хендлера.
 *
 * Тарифные лимиты на сотрудников:
 *   - solo:      1 пользователь  → только Собственник, никаких сотрудников
 *   - studio:    3 пользователя  → Собственник + 2
 *   - trial:     3 пользователя  → даём пощупать команду на пробном
 *   - cancelled: 0               → подписка отменена
 *   maxUsersForPlan() в server/lib/plans.cjs.
 *
 * Защита от self-lockout:
 *   - owner не может удалить сам себя
 *   - owner не может снять себе роль owner (downgrade на manager/master)
 *   - owner не может заблокировать сам себя
 *
 * Защита от orphan studio:
 *   - нельзя снять последнего owner студии (иначе никто не сможет управлять)
 */

const crypto = require('node:crypto');
const express = require('express');
const { pool } = require('../lib/db.cjs');
const {
  hashPassword,
  invalidateAllUserSessions,
} = require('../lib/auth.cjs');
const { requireRole } = require('../lib/middleware.cjs');
const { planMeta, maxUsersForPlan } = require('../lib/plans.cjs');
const { logFromReq } = require('../lib/audit.cjs');
const { isValidEmail, assertStrongPassword, assertString, assertOptionalString, assertEnum, handleFieldError } = require('../lib/validation.cjs');

// Лимиты для admin user-полей. Значения совпадают с тем, что использует
// /api/profile (PATCH /me) — 100/40 — чтобы оба пути дали одинаковую ошибку
// на длинных строках, а не один прошёл, а другой упал на DB-constraint.
const USER_NAME_MAX = 100;
const USER_PHONE_MAX = 40;
const VALID_ROLES_FOR_INPUT = ['manager', 'master']; // owner создаётся ТОЛЬКО при signup

const router = express.Router();

// Sugar поверх logFromReq для admin-роутов: entityType всегда 'user',
// entityId/Name удобно вытаскивать из объекта target (StudioUser-like).
// Раньше был свой logAction-вызов с ручной распаковкой req.session — теперь
// эта работа делается в lib/audit.cjs#logFromReq, мы добавляем только
// admin-специфичную часть (entityType + извлечение из target).
function audit(req, action, target, extra = {}) {
  const entityId   = target?.id   || extra.entityId   || null;
  const entityName = target?.name || target?.email    || extra.entityName || null;
  return logFromReq(req, action, 'user', entityId, entityName, extra.details || null);
}

// Генератор временного пароля (для admin-reset). 12 символов base64url —
// ~72 бит энтропии, безопасно для одноразового пароля. Показывается в UI
// один раз и не хранится в открытом виде нигде.
function generateTempPassword() {
  return crypto.randomBytes(9).toString('base64url'); // 12 chars
}

// На все админские роуты — только Собственник.
router.use(requireRole('owner'));

const VALID_ROLES = ['owner', 'manager', 'master'];
// Через POST /users можно создавать ТОЛЬКО manager/master. Owner создаётся
// один раз при signup студии — повышение прав до owner недопустимо через UI.
const CREATABLE_ROLES = ['manager', 'master'];

// Подсчёт активных Собственников студии — для защиты от orphan.
async function countActiveOwners(studioId, excludeUserId) {
  const args = [studioId];
  let sql = `SELECT COUNT(*)::int AS c FROM saas_meta.users
              WHERE studio_id = $1 AND role = 'owner' AND is_active = true`;
  if (excludeUserId) {
    sql += ' AND id <> $2';
    args.push(excludeUserId);
  }
  const r = await pool.query(sql, args);
  return r.rows[0].c;
}

// Сколько активных юзеров в студии сейчас (для лимита тарифа).
async function countActiveUsers(studioId) {
  const r = await pool.query(
    `SELECT COUNT(*)::int AS c FROM saas_meta.users
       WHERE studio_id = $1 AND is_active = true`,
    [studioId]
  );
  return r.rows[0].c;
}

async function fetchOwnUserOfStudio(userId, studioId) {
  const r = await pool.query(
    `SELECT id, email, name, first_name, last_name, phone, avatar_path,
            role, is_active, created_at, can_view_finance, permissions, last_login_at
       FROM saas_meta.users
      WHERE id = $1 AND studio_id = $2`,
    [userId, studioId]
  );
  return r.rows[0] || null;
}

// Валидирует и нормализует permissions JSONB: принимает объект {clients,tasks,calendar,finance},
// каждое поле — 'edit'|'view'|'none'. Неизвестные значения → 'none'. Если null — возвращает null.
function sanitizePermissions(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const VALID = ['edit', 'view', 'none'];
  const result = {};
  for (const key of ['clients', 'tasks', 'calendar', 'finance']) {
    result[key] = VALID.includes(raw[key]) ? raw[key] : 'none';
  }
  return result;
}

async function fetchStudioPlan(studioId) {
  const r = await pool.query(
    `SELECT plan FROM saas_meta.studios WHERE id = $1`,
    [studioId]
  );
  return r.rows[0]?.plan || 'cancelled';
}

// ──────────────────────────────────────────────────────────────────────
// GET /api/admin/users
// ──────────────────────────────────────────────────────────────────────
router.get('/users', async (req, res, next) => {
  const r = await pool.query(
    `SELECT id, email, name, first_name, last_name, phone, avatar_path,
            role, is_active, created_at, can_view_finance, permissions, last_login_at
       FROM saas_meta.users
      WHERE studio_id = $1
      ORDER BY created_at`,
    [req.session.studioId]
  );
  res.json(r.rows);
});

// ──────────────────────────────────────────────────────────────────────
// POST /api/admin/users
// Body: { email, password, name?, firstName?, lastName?, phone?, role? }
// ──────────────────────────────────────────────────────────────────────
router.post('/users', async (req, res, next) => {
  const { email, password, name, firstName, lastName, phone, role, can_view_finance, permissions } = req.body || {};
  if (!isValidEmail(email)) {
    return res.status(400).json({ error: 'email_invalid' });
  }
  // Раннее отклонение: слабый пароль или слишком короткий → 400 со специфическим
  // кодом, чтобы фронт мог показать «придумайте надёжнее» вместо generic ошибки.
  try {
    assertStrongPassword(password);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  // Длины и формат опциональных полей. До этого фикса принимались строки
  // любой длины — атакующий мог положить 1MB в name/phone и упереться в
  // DB-constraint (либо переполнить лог).
  let nameC, firstNameC, lastNameC, phoneC;
  try {
    nameC      = assertOptionalString(name,      'name',       USER_NAME_MAX);
    firstNameC = assertOptionalString(firstName, 'firstName',  USER_NAME_MAX);
    lastNameC  = assertOptionalString(lastName,  'lastName',   USER_NAME_MAX);
    phoneC     = assertOptionalString(phone,     'phone',      USER_PHONE_MAX);
  } catch (err) { if (handleFieldError(err, res)) return; throw err; }

  // Через эту ручку owner создавать нельзя — он один на студию (см. signup).
  const finalRole = CREATABLE_ROLES.includes(role) ? role : 'master';

  // can_view_finance имеет смысл только для manager. Master по ТЗ
  // никогда не видит финансы; в БД пишем false для master в любом случае.
  const finalFinance = finalRole === 'master'
    ? false
    : (can_view_finance === undefined ? true : Boolean(can_view_finance));

  // permissions — опциональный объект тонкой настройки доступа по разделам.
  // null = используются дефолты роли на клиенте. sanitizePermissions отбрасывает
  // невалидные значения, чтобы не положить мусор в JSONB.
  const finalPermissions = permissions ? sanitizePermissions(permissions) : null;

  // Проверка лимита тарифа: solo=1, studio/trial=3, cancelled=0.
  const plan = await fetchStudioPlan(req.session.studioId);
  const currentUsers = await countActiveUsers(req.session.studioId);
  const maxUsers = maxUsersForPlan(plan);
  if (currentUsers >= maxUsers) {
    const meta = planMeta(plan);
    return res.status(402).json({
      error: 'plan_limit_reached',
      plan,
      planLabel: meta.label,
      currentUsers,
      maxUsers,
      message: `На тарифе «${meta.label}» доступно сотрудников: ${maxUsers}. Повысьте тариф, чтобы добавить ещё.`,
    });
  }

  const passwordHash = await hashPassword(password);
  // Computed legacy `name` — для совместимости со старым кодом, читающим users.name.
  const composedName = nameC
    || [firstNameC, lastNameC].filter(Boolean).join(' ').trim()
    || null;

  let r;
  try {
    r = await pool.query(
      `INSERT INTO saas_meta.users
         (studio_id, email, password_hash, role, name, first_name, last_name, phone, is_active, can_view_finance, permissions)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true, $9, $10)
         RETURNING id, email, name, first_name, last_name, phone, avatar_path,
                   role, is_active, created_at, can_view_finance, permissions, last_login_at`,
      [
        req.session.studioId, email.toLowerCase(), passwordHash, finalRole,
        composedName, firstNameC, lastNameC, phoneC,
        finalFinance, finalPermissions ? JSON.stringify(finalPermissions) : null,
      ]
    );
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'email_already_used' });
    throw err;
  }
  // Пишем details на русском, чтобы UI не пришлось расшифровывать машинные коды.
  const ROLE_RU = { owner: 'Собственник', manager: 'Менеджер', master: 'Мастер' };
  audit(req, 'create', r.rows[0], {
    details: `роль: ${ROLE_RU[finalRole] || finalRole}, финансы: ${finalFinance ? 'да' : 'нет'}`,
  });
  res.status(201).json(r.rows[0]);
});

// ──────────────────────────────────────────────────────────────────────
// PUT /api/admin/users/:id
// Body: { name?, role?, is_active? }
// ──────────────────────────────────────────────────────────────────────
router.put('/users/:id', async (req, res, next) => {
  const { id } = req.params;
  const target = await fetchOwnUserOfStudio(id, req.session.studioId);
  if (!target) return res.status(404).json({ error: 'user_not_found' });

  const { name, role, is_active, can_view_finance, permissions } = req.body || {};

  // Длина name. Раньше принималась строка любого размера → DB-constraint
  // или silent truncation. Если name НЕ передан — оставляем текущее
  // значение (обработка ниже через `name !== undefined`), так что null
  // корректно сериализуется.
  let nameC;
  try {
    nameC = name === undefined
      ? undefined
      : (assertOptionalString(name, 'name', USER_NAME_MAX));
  } catch (err) { if (handleFieldError(err, res)) return; throw err; }

  // self-protection: нельзя себя downgrade или дезактивировать
  if (id === req.session.userId) {
    if (role && role !== 'owner') return res.status(400).json({ error: 'cannot_demote_self' });
    if (is_active === false) return res.status(400).json({ error: 'cannot_disable_self' });
  }

  // нельзя снять последнего Собственника студии
  if (target.role === 'owner' && target.is_active) {
    if ((role && role !== 'owner') || is_active === false) {
      const remaining = await countActiveOwners(req.session.studioId, id);
      if (remaining < 1) return res.status(400).json({ error: 'last_owner_protected' });
    }
  }

  // Через PUT нельзя ПОВЫСИТЬ кого-либо до owner (single-owner-per-studio
  // инвариант). Понижение owner→manager/master разрешено выше при наличии
  // другого активного owner — но саму роль 'owner' НЕ принимаем как input.
  if (role && role === 'owner' && target.role !== 'owner') {
    return res.status(400).json({ error: 'cannot_promote_to_owner' });
  }

  const newRole = role && VALID_ROLES.includes(role) ? role : target.role;
  const newActive = typeof is_active === 'boolean' ? is_active : target.is_active;
  const newName = nameC !== undefined ? nameC : target.name;

  // Видимость финансов:
  //   - master никогда не видит → принудительно false
  //   - иначе берём то, что прислали; если не прислали — оставляем текущее
  let newFinance;
  if (newRole === 'master') {
    newFinance = false;
  } else if (typeof can_view_finance === 'boolean') {
    newFinance = can_view_finance;
  } else {
    newFinance = target.can_view_finance !== false;
  }

  // permissions: если прислали — санируем и сохраняем. null явный → сброс к дефолтам роли.
  // undefined (не прислали) → оставляем текущее значение из БД.
  let newPermissions;
  if (permissions === null) {
    newPermissions = null;
  } else if (permissions !== undefined) {
    newPermissions = sanitizePermissions(permissions);
  } else {
    newPermissions = target.permissions || null;
  }

  const r = await pool.query(
    `UPDATE saas_meta.users
        SET name = $1, role = $2, is_active = $3, can_view_finance = $4, permissions = $5
      WHERE id = $6 AND studio_id = $7
      RETURNING id, email, name, first_name, last_name, phone, avatar_path,
                role, is_active, created_at, can_view_finance, permissions, last_login_at`,
    [newName, newRole, newActive, newFinance, newPermissions ? JSON.stringify(newPermissions) : null, id, req.session.studioId]
  );

  // Diff для аудита: что реально поменялось. Все строки сразу на русском —
  // чтобы UI выводил их as-is, без машинных значений.
  const ROLE_RU = { owner: 'Собственник', manager: 'Менеджер', master: 'Мастер' };
  const yn = (b) => (b ? 'да' : 'нет');
  const changes = [];
  if (newName !== target.name) changes.push(`имя: «${target.name}» → «${newName}»`);
  if (newRole !== target.role) changes.push(`роль: ${ROLE_RU[target.role] || target.role} → ${ROLE_RU[newRole] || newRole}`);
  if (newActive !== target.is_active) changes.push(`активен: ${yn(target.is_active)} → ${yn(newActive)}`);
  if (newFinance !== (target.can_view_finance !== false)) {
    changes.push(`финансы: ${yn(target.can_view_finance !== false)} → ${yn(newFinance)}`);
  }
  if (JSON.stringify(newPermissions) !== JSON.stringify(target.permissions || null)) {
    changes.push('права: обновлены');
  }
  if (changes.length > 0) {
    audit(req, 'update', r.rows[0], { details: changes.join('; ') });
  }

  // если выключили — снести все сессии этого юзера
  if (target.is_active && !newActive) {
    await invalidateAllUserSessions(id);
  }

  res.json(r.rows[0]);
});

// ──────────────────────────────────────────────────────────────────────
// POST /api/admin/users/:id/reset-password
// Возвращает временный пароль ОДИН РАЗ (в открытом виде в JSON).
// В БД хранится только хеш. Сбрасывает все сессии target-пользователя.
// ──────────────────────────────────────────────────────────────────────
router.post('/users/:id/reset-password', async (req, res, next) => {
  const { id } = req.params;
  const target = await fetchOwnUserOfStudio(id, req.session.studioId);
  if (!target) return res.status(404).json({ error: 'user_not_found' });

  // Для self-reset есть отдельный flow (POST /auth/password со старым паролем).
  // Через админку owner может сбросить пароль СОБСТВЕННОМУ аккаунту, если
  // забыл — но тогда сессии текущей вкладки тоже отвалятся, что ок.

  const tempPassword = generateTempPassword();
  const passwordHash = await hashPassword(tempPassword);

  await pool.query(
    `UPDATE saas_meta.users SET password_hash = $1 WHERE id = $2 AND studio_id = $3`,
    [passwordHash, id, req.session.studioId]
  );
  await invalidateAllUserSessions(id);

  audit(req, 'password_reset', target);

  res.json({ ok: true, tempPassword });
});

// ──────────────────────────────────────────────────────────────────────
// PUT /api/admin/users/:id/block — быстрый kill-switch
// ──────────────────────────────────────────────────────────────────────
router.put('/users/:id/block', async (req, res, next) => {
  const { id } = req.params;
  // Тело может содержать { is_active: true|false }. Если поле не передано,
  // считаем это «заблокировать» (обратная совместимость с фронтом, который
  // вызывает /block без тела). Для разблокировки фронт передаёт is_active=true.
  const desiredActive = typeof req.body?.is_active === 'boolean'
    ? req.body.is_active
    : false;

  if (id === req.session.userId && desiredActive === false) {
    return res.status(400).json({ error: 'cannot_disable_self' });
  }

  const target = await fetchOwnUserOfStudio(id, req.session.studioId);
  if (!target) return res.status(404).json({ error: 'user_not_found' });

  // Защита последнего owner: нельзя выключить, если он один.
  if (desiredActive === false && target.role === 'owner' && target.is_active) {
    const remaining = await countActiveOwners(req.session.studioId, id);
    if (remaining < 1) return res.status(400).json({ error: 'last_owner_protected' });
  }

  await pool.query(
    `UPDATE saas_meta.users SET is_active = $1 WHERE id = $2 AND studio_id = $3`,
    [desiredActive, id, req.session.studioId]
  );
  if (desiredActive === false) {
    await invalidateAllUserSessions(id);
  }
  audit(req, desiredActive ? 'unblock' : 'block', target);
  res.json({ ok: true, is_active: desiredActive });
});

// ──────────────────────────────────────────────────────────────────────
// DELETE /api/admin/users/:id
// ──────────────────────────────────────────────────────────────────────
router.delete('/users/:id', async (req, res, next) => {
  const { id } = req.params;
  if (id === req.session.userId) return res.status(400).json({ error: 'cannot_delete_self' });

  const target = await fetchOwnUserOfStudio(id, req.session.studioId);
  if (!target) return res.status(404).json({ error: 'user_not_found' });

  if (target.role === 'owner') {
    const remaining = await countActiveOwners(req.session.studioId, id);
    if (remaining < 1) return res.status(400).json({ error: 'last_owner_protected' });
  }

  await pool.query(
    `DELETE FROM saas_meta.users WHERE id = $1 AND studio_id = $2`,
    [id, req.session.studioId]
  );
  // CASCADE на sessions подчистит автоматом.
  // Логируем ДО фактической записи в FK-таблицу: user_id в activity_logs
  // ON DELETE SET NULL, поэтому потеряем соответствие, но user_name
  // (денормализация) останется. entity_id="<deleted-uuid>" сохранит ID.
  audit(req, 'delete', target);
  res.json({ ok: true });
});

// ══════════════════════════════════════════════════════════════════════
// GET /api/admin/analytics?period=3m|6m|year
//
// Дашборд аналитики студии. Доступен только role=owner (стоит на routerе)
// И ТОЛЬКО на тарифе «Студия» — на solo/trial/cancelled возвращаем 402,
// чтобы фронт показал плашку «доступно на тарифе Студия».
//
// Все цифры считаем по client_records (фактические записи о работе) — это
// первичная сущность учёта; bookings — лишь слот в календаре. Ср. чек =
// revenue / orders. Categories тянем через cr.category_id → categories.name;
// если client_records.category_id NULL — попадает в «Без категории».
//
// «Новые клиенты» — clients.created_at в текущем месяце. Дельты — к
// предыдущему месяцу (для процентов: round((cur−prev)/max(prev,1)·100)).
//
// Период определяет глубину истории на графиках (3/6/12 месяцев), но
// «Выручка за месяц» в карточках — всегда календарный текущий месяц.
// ══════════════════════════════════════════════════════════════════════
router.get('/analytics', async (req, res, next) => {
  try {
    // Аналитика отдаётся всем тарифам (trial / solo / studio). Раньше
    // здесь стоял 402 plan_required для не-Studio — это было маркетинговым
    // гейтом, такая же история, как с напоминаниями бота: в продукте
    // фича доступна всем, на лендинге выделяем как «у Студии».

    // 2. Период: 3m | 6m | year (12 мес). По умолчанию 6m.
    // Whitelist через assertEnum: раньше любое значение `period` молча
    // фолбэчилось на 6m — UI не понимал, что параметр ему не уважают.
    // Теперь любое неизвестное → 400 с понятным reason.
    const periodInput = String(req.query.period || '6m').toLowerCase();
    const ALLOWED_PERIODS = ['3m', '6m', 'year', '12m'];
    if (!ALLOWED_PERIODS.includes(periodInput)) {
      return res.status(400).json({
        error: 'period_invalid',
        allowed: ['3m', '6m', 'year'],
      });
    }
    const months = periodInput === '3m' ? 3 : (periodInput === 'year' || periodInput === '12m') ? 12 : 6;

    const schema = req.session.schemaName;
    const { queryInSchema } = require('../lib/db.cjs');

    // ── Карточки: текущий vs предыдущий календарный месяц ──
    // Источник денежных метрик (revenue) — таблица `transactions` с
    // type='income'. В неё попадают:
    //   • авто-операции от заказов (advance/full payment, привязка
    //     client_record_id) — генерятся при сохранении client_records;
    //   • ручные income-операции из раздела «Финансы».
    // Дублей нет: каждая авто-операция вставляется один раз. Раньше
    // источник был client_records.amount → ручные «Финансы» в аналитику не
    // попадали, что и было багом.
    //
    // Количество заказов (orders) и средний чек считаем по client_records:
    // это про работу студии, а не про деньги — отдельная семантика.
    const cardsRes = await queryInSchema(schema, `
      WITH bounds AS (
        SELECT date_trunc('month', CURRENT_DATE)::date AS this_start,
               (date_trunc('month', CURRENT_DATE) + interval '1 month')::date AS next_start,
               (date_trunc('month', CURRENT_DATE) - interval '1 month')::date AS prev_start
      ),
      rev AS (
        SELECT
          COALESCE(SUM(t.amount) FILTER (WHERE t.date >= b.this_start AND t.date < b.next_start), 0)::numeric AS revenue_cur,
          COALESCE(SUM(t.amount) FILTER (WHERE t.date >= b.prev_start AND t.date < b.this_start), 0)::numeric AS revenue_prev
        FROM bounds b
        LEFT JOIN {{schema}}.transactions t
               ON t.type = 'income'
              AND t.date >= b.prev_start AND t.date < b.next_start
      ),
      ord AS (
        SELECT
          COUNT(*) FILTER (WHERE cr.date >= b.this_start AND cr.date < b.next_start)::int AS orders_cur,
          COUNT(*) FILTER (WHERE cr.date >= b.prev_start AND cr.date < b.this_start)::int AS orders_prev
        FROM bounds b
        LEFT JOIN {{schema}}.client_records cr ON cr.date >= b.prev_start AND cr.date < b.next_start
      )
      SELECT rev.revenue_cur, rev.revenue_prev, ord.orders_cur, ord.orders_prev
        FROM rev, ord
    `);
    const card = cardsRes.rows[0];

    // Новые клиенты по created_at — отдельный запрос, чтобы не плодить JOIN.
    const newClientsRes = await queryInSchema(schema, `
      SELECT
        COUNT(*) FILTER (WHERE created_at >= date_trunc('month', CURRENT_DATE))::int AS new_cur,
        COUNT(*) FILTER (
          WHERE created_at >= date_trunc('month', CURRENT_DATE) - interval '1 month'
            AND created_at <  date_trunc('month', CURRENT_DATE)
        )::int AS new_prev
        FROM {{schema}}.clients
    `);
    const nc = newClientsRes.rows[0];

    const revenueCur  = Number(card.revenue_cur);
    const revenuePrev = Number(card.revenue_prev);
    const ordersCur   = Number(card.orders_cur);
    const ordersPrev  = Number(card.orders_prev);
    const avgCur      = ordersCur  > 0 ? revenueCur  / ordersCur  : 0;
    const avgPrev     = ordersPrev > 0 ? revenuePrev / ordersPrev : 0;

    const pctDelta = (cur, prev) => {
      if (!prev) return cur > 0 ? 100 : 0;
      return Math.round(((cur - prev) / prev) * 100);
    };

    // ── По месяцам: revenue/orders/avg_check/new_clients за last N месяцев ──
    // Генерим ось месяцев через generate_series, чтобы не было дыр в графике.
    // revenue — из transactions(income), orders — из client_records (см.
    // комментарий к карточкам выше).
    const byMonthRes = await queryInSchema(schema, `
      WITH months AS (
        SELECT generate_series(
          date_trunc('month', CURRENT_DATE) - ($1::int - 1) * interval '1 month',
          date_trunc('month', CURRENT_DATE),
          interval '1 month'
        )::date AS m
      ),
      rev AS (
        SELECT date_trunc('month', t.date)::date AS m,
               COALESCE(SUM(t.amount), 0)::numeric AS revenue
        FROM {{schema}}.transactions t
        WHERE t.type = 'income'
          AND t.date >= (date_trunc('month', CURRENT_DATE) - ($1::int - 1) * interval '1 month')::date
        GROUP BY 1
      ),
      exp AS (
        SELECT date_trunc('month', t.date)::date AS m,
               COALESCE(SUM(t.amount), 0)::numeric AS expense
        FROM {{schema}}.transactions t
        WHERE t.type = 'expense'
          AND t.date >= (date_trunc('month', CURRENT_DATE) - ($1::int - 1) * interval '1 month')::date
        GROUP BY 1
      ),
      orders AS (
        SELECT date_trunc('month', cr.date)::date AS m,
               COUNT(*)::int AS orders
        FROM {{schema}}.client_records cr
        WHERE cr.date >= (date_trunc('month', CURRENT_DATE) - ($1::int - 1) * interval '1 month')::date
        GROUP BY 1
      ),
      newc AS (
        SELECT date_trunc('month', c.created_at)::date AS m,
               COUNT(*)::int AS new_clients
        FROM {{schema}}.clients c
        WHERE c.created_at >= (date_trunc('month', CURRENT_DATE) - ($1::int - 1) * interval '1 month')
        GROUP BY 1
      )
      SELECT m.m AS month_date,
             COALESCE(r.revenue, 0)::numeric AS revenue,
             COALESCE(e.expense, 0)::numeric AS expense,
             COALESCE(o.orders, 0)::int AS orders,
             COALESCE(n.new_clients, 0)::int AS new_clients
      FROM months m
      LEFT JOIN rev    r ON r.m = m.m
      LEFT JOIN exp    e ON e.m = m.m
      LEFT JOIN orders o ON o.m = m.m
      LEFT JOIN newc   n ON n.m = m.m
      ORDER BY m.m ASC
    `, [months]);

    const monthLabelsRu = ['Янв','Фев','Мар','Апр','Май','Июн','Июл','Авг','Сен','Окт','Ноя','Дек'];
    const byMonth = byMonthRes.rows.map((r) => {
      const d = new Date(r.month_date);
      const revenue = Number(r.revenue);
      const expense = Number(r.expense || 0);
      const orders  = Number(r.orders);
      return {
        label: monthLabelsRu[d.getMonth()],
        month_key: r.month_date,
        revenue,
        expense,
        balance: revenue - expense,
        orders,
        new_clients: Number(r.new_clients),
        avg_check: orders > 0 ? Math.round(revenue / orders) : 0,
      };
    });

    // ── Структура выручки по категориям (за период) ──
    // По transactions(income): category_id у авто-операций приходит из
    // client_records.category_id (см. App.tsx#addTransaction), у ручных —
    // из формы. category_id может быть NULL → группа «Без категории».
    const categoriesRes = await queryInSchema(schema, `
      SELECT COALESCE(c.name, t.category, 'Без категории') AS name,
             COALESCE(SUM(t.amount), 0)::numeric AS revenue
        FROM {{schema}}.transactions t
        LEFT JOIN {{schema}}.categories c ON c.id = t.category_id
        WHERE t.type = 'income'
          AND t.date >= (date_trunc('month', CURRENT_DATE) - ($1::int - 1) * interval '1 month')::date
        GROUP BY COALESCE(c.name, t.category, 'Без категории')
        HAVING SUM(t.amount) > 0
        ORDER BY revenue DESC
        LIMIT 10
    `, [months]);
    const categoriesRaw = categoriesRes.rows.map((r) => ({ name: r.name, revenue: Number(r.revenue) }));
    const categoriesTotal = categoriesRaw.reduce((s, c) => s + c.revenue, 0) || 1;
    const categories = categoriesRaw.map((c) => ({
      ...c,
      pct: Math.round((c.revenue / categoriesTotal) * 100),
    }));

    // ── Топ-5 услуг по выручке ──
    // Источник правды — client_records.services (JSONB-массив snapshot'ов
    // {service_id, name, price}). Раньше группировка шла по service_name
    // (текстовое legacy-поле «Полировка, Перешив, Тонировка» через запятую),
    // и multi-service бронь попадала одной длинной строкой, что
    // искажало статистику. Теперь jsonb_array_elements разворачивает
    // массив, GROUP BY по name даёт реальный топ.
    //
    // Для записей без массива services (старые брони до feature) —
    // fallback на legacy service_name через UNION.
    const topRes = await queryInSchema(schema, `
      WITH expanded AS (
        -- Multi-service записи: каждая услуга отдельной строкой со своей ценой
        SELECT (s->>'name')::text AS name,
               (s->>'price')::numeric AS price
          FROM {{schema}}.client_records cr,
               LATERAL jsonb_array_elements(cr.services) s
         WHERE cr.date >= (date_trunc('month', CURRENT_DATE) - ($1::int - 1) * interval '1 month')::date
           AND jsonb_array_length(cr.services) > 0
           AND s->>'name' IS NOT NULL AND s->>'name' <> ''

        UNION ALL

        -- Legacy записи (services пустой): целиком service_name + amount
        SELECT cr.service_name AS name, cr.amount AS price
          FROM {{schema}}.client_records cr
         WHERE cr.date >= (date_trunc('month', CURRENT_DATE) - ($1::int - 1) * interval '1 month')::date
           AND (cr.services IS NULL OR jsonb_array_length(cr.services) = 0)
           AND cr.service_name IS NOT NULL AND cr.service_name <> ''
      )
      SELECT name, COALESCE(SUM(price), 0)::numeric AS revenue
        FROM expanded
       GROUP BY name
      HAVING SUM(price) > 0
       ORDER BY revenue DESC
       LIMIT 5
    `, [months]);
    const topServices = topRes.rows.map((r) => ({ name: r.name, revenue: Number(r.revenue) }));

    // ── Клиентская база: total / repeat / inactive / avg_interval ──
    const retentionRes = await queryInSchema(schema, `
      WITH stats AS (
        SELECT c.id,
               COUNT(cr.id)::int AS order_count,
               MAX(cr.date)      AS last_visit
        FROM {{schema}}.clients c
        LEFT JOIN {{schema}}.client_records cr ON cr.client_id = c.id
        GROUP BY c.id
      )
      SELECT
        COUNT(*)::int                                                           AS total_clients,
        COUNT(*) FILTER (WHERE order_count >= 2)::int                           AS repeat_clients,
        COUNT(*) FILTER (WHERE last_visit IS NOT NULL
                          AND last_visit < CURRENT_DATE - INTERVAL '90 days')::int
                                                                                AS inactive_3m
      FROM stats
    `);
    const retRow = retentionRes.rows[0] || { total_clients: 0, repeat_clients: 0, inactive_3m: 0 };

    // Средний интервал между заказами (среди клиентов с 2+) — в месяцах.
    const intervalRes = await queryInSchema(schema, `
      WITH ordered AS (
        SELECT client_id, date,
               LEAD(date) OVER (PARTITION BY client_id ORDER BY date) AS next_date
        FROM {{schema}}.client_records
      )
      SELECT COALESCE(AVG((next_date - date))::numeric, 0) AS avg_days
      FROM ordered
      WHERE next_date IS NOT NULL
    `);
    const avgDays = Number(intervalRes.rows[0]?.avg_days || 0);
    const avgIntervalMonths = avgDays > 0 ? Math.round((avgDays / 30.4375) * 10) / 10 : 0;

    // Записей на следующий календарный месяц (bookings — будущие слоты).
    const upcomingRes = await queryInSchema(schema, `
      SELECT COUNT(*)::int AS upcoming
        FROM {{schema}}.bookings
        WHERE date >= (date_trunc('month', CURRENT_DATE) + interval '1 month')::date
          AND date <  (date_trunc('month', CURRENT_DATE) + interval '2 months')::date
    `);
    const upcomingNextMonth = Number(upcomingRes.rows[0]?.upcoming || 0);

    // Конверсия в повторный визит за 30 дней (клиенты, у которых второй заказ
    // случился в течение 30 дней после первого, среди когорты с >= 1 заказом).
    const convRes = await queryInSchema(schema, `
      WITH first_visits AS (
        SELECT client_id, MIN(date) AS first_date
        FROM {{schema}}.client_records GROUP BY client_id
      ),
      pairs AS (
        SELECT fv.client_id, fv.first_date,
               (SELECT MIN(date) FROM {{schema}}.client_records cr2
                  WHERE cr2.client_id = fv.client_id AND cr2.date > fv.first_date) AS second_date
        FROM first_visits fv
      )
      SELECT
        COUNT(*)::int AS first_count,
        COUNT(*) FILTER (
          WHERE second_date IS NOT NULL AND (second_date - first_date) <= 30
        )::int AS converted
      FROM pairs
    `);
    const convRow = convRes.rows[0] || { first_count: 0, converted: 0 };
    const conversion30dPct = convRow.first_count > 0
      ? Math.round((convRow.converted / convRow.first_count) * 100)
      : 0;

    res.json({
      period: months === 3 ? '3m' : months === 12 ? 'year' : '6m',
      current_month: {
        revenue: Math.round(revenueCur),
        revenue_delta_pct: pctDelta(revenueCur, revenuePrev),
        orders: ordersCur,
        orders_delta: ordersCur - ordersPrev,
        new_clients: Number(nc.new_cur),
        new_clients_delta: Number(nc.new_cur) - Number(nc.new_prev),
        avg_check: Math.round(avgCur),
        avg_check_delta_pct: pctDelta(avgCur, avgPrev),
      },
      by_month: byMonth,
      categories,
      top_services: topServices,
      retention: {
        total_clients: Number(retRow.total_clients),
        repeat_pct: retRow.total_clients > 0
          ? Math.round((Number(retRow.repeat_clients) / Number(retRow.total_clients)) * 100)
          : 0,
        inactive_3m: Number(retRow.inactive_3m),
        upcoming_next_month: upcomingNextMonth,
        avg_interval_months: avgIntervalMonths,
        conversion_30d_pct: conversion30dPct,
      },
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
