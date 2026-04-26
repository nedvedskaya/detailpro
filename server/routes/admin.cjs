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
const { logAction } = require('../lib/audit.cjs');

const router = express.Router();

// Sugar для аудита — параметры берём из req.session.
// userName — приходит из verifySession (lib/auth.cjs).
function audit(req, action, target, extra = {}) {
  return logAction({
    schemaName: req.session.schemaName,
    userId:     req.session.userId,
    userName:   req.session.userName,
    action,
    entityType: 'user',
    entityId:   target?.id || extra.entityId || null,
    entityName: target?.name || target?.email || extra.entityName || null,
    details:    extra.details || null,
    ip:         req.ip,
  });
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
            role, is_active, created_at, can_view_finance, last_login_at
       FROM saas_meta.users
      WHERE id = $1 AND studio_id = $2`,
    [userId, studioId]
  );
  return r.rows[0] || null;
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
            role, is_active, created_at, can_view_finance, last_login_at
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
  const { email, password, name, firstName, lastName, phone, role, can_view_finance } = req.body || {};
  if (typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'email_invalid' });
  }
  if (typeof password !== 'string' || password.length < 8) {
    return res.status(400).json({ error: 'password_too_short' });
  }
  // Через эту ручку owner создавать нельзя — он один на студию (см. signup).
  const finalRole = CREATABLE_ROLES.includes(role) ? role : 'master';

  // can_view_finance имеет смысл только для manager. Master по ТЗ
  // никогда не видит финансы; в БД пишем false для master в любом случае.
  const finalFinance = finalRole === 'master'
    ? false
    : (can_view_finance === undefined ? true : Boolean(can_view_finance));

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
  const composedName = name
    || [firstName, lastName].filter(Boolean).join(' ').trim()
    || null;

  let r;
  try {
    r = await pool.query(
      `INSERT INTO saas_meta.users
         (studio_id, email, password_hash, role, name, first_name, last_name, phone, is_active, can_view_finance)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true, $9)
         RETURNING id, email, name, first_name, last_name, phone, avatar_path,
                   role, is_active, created_at, can_view_finance, last_login_at`,
      [
        req.session.studioId, email.toLowerCase(), passwordHash, finalRole,
        composedName, firstName || null, lastName || null, phone || null,
        finalFinance,
      ]
    );
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'email_already_used' });
    throw err;
  }
  audit(req, 'create', r.rows[0], {
    details: `role=${finalRole}, finance=${finalFinance}`,
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

  const { name, role, is_active, can_view_finance } = req.body || {};

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
  const newName = name !== undefined ? name : target.name;

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

  const r = await pool.query(
    `UPDATE saas_meta.users
        SET name = $1, role = $2, is_active = $3, can_view_finance = $4
      WHERE id = $5 AND studio_id = $6
      RETURNING id, email, name, first_name, last_name, phone, avatar_path,
                role, is_active, created_at, can_view_finance, last_login_at`,
    [newName, newRole, newActive, newFinance, id, req.session.studioId]
  );

  // Diff для аудита: что реально поменялось.
  const changes = [];
  if (newName !== target.name) changes.push(`name: "${target.name}" → "${newName}"`);
  if (newRole !== target.role) changes.push(`role: ${target.role} → ${newRole}`);
  if (newActive !== target.is_active) changes.push(`active: ${target.is_active} → ${newActive}`);
  if (newFinance !== (target.can_view_finance !== false)) {
    changes.push(`finance: ${target.can_view_finance !== false} → ${newFinance}`);
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

module.exports = router;
