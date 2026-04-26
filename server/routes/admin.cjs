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

const express = require('express');
const { pool } = require('../lib/db.cjs');
const {
  hashPassword,
  invalidateAllUserSessions,
} = require('../lib/auth.cjs');
const { requireRole } = require('../lib/middleware.cjs');
const { planMeta, maxUsersForPlan } = require('../lib/plans.cjs');

const router = express.Router();

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
            role, is_active, created_at
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
  try {
    const r = await pool.query(
      `SELECT id, email, name, first_name, last_name, phone, avatar_path,
              role, is_active, created_at
         FROM saas_meta.users
        WHERE studio_id = $1
        ORDER BY created_at`,
      [req.session.studioId]
    );
    res.json(r.rows);
  } catch (err) { next(err); }
});

// ──────────────────────────────────────────────────────────────────────
// POST /api/admin/users
// Body: { email, password, name?, firstName?, lastName?, phone?, role? }
// ──────────────────────────────────────────────────────────────────────
router.post('/users', async (req, res, next) => {
  try {
    const { email, password, name, firstName, lastName, phone, role } = req.body || {};
    if (typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'email_invalid' });
    }
    if (typeof password !== 'string' || password.length < 8) {
      return res.status(400).json({ error: 'password_too_short' });
    }
    // Через эту ручку owner создавать нельзя — он один на студию (см. signup).
    const finalRole = CREATABLE_ROLES.includes(role) ? role : 'master';

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
           (studio_id, email, password_hash, role, name, first_name, last_name, phone, is_active)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true)
           RETURNING id, email, name, first_name, last_name, phone, avatar_path,
                     role, is_active, created_at`,
        [
          req.session.studioId, email.toLowerCase(), passwordHash, finalRole,
          composedName, firstName || null, lastName || null, phone || null,
        ]
      );
    } catch (err) {
      if (err.code === '23505') return res.status(409).json({ error: 'email_already_used' });
      throw err;
    }
    res.status(201).json(r.rows[0]);
  } catch (err) { next(err); }
});

// ──────────────────────────────────────────────────────────────────────
// PUT /api/admin/users/:id
// Body: { name?, role?, is_active? }
// ──────────────────────────────────────────────────────────────────────
router.put('/users/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    const target = await fetchOwnUserOfStudio(id, req.session.studioId);
    if (!target) return res.status(404).json({ error: 'user_not_found' });

    const { name, role, is_active } = req.body || {};

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

    const newRole = role && VALID_ROLES.includes(role) ? role : target.role;
    const newActive = typeof is_active === 'boolean' ? is_active : target.is_active;
    const newName = name !== undefined ? name : target.name;

    const r = await pool.query(
      `UPDATE saas_meta.users
          SET name = $1, role = $2, is_active = $3
        WHERE id = $4 AND studio_id = $5
        RETURNING id, email, name, first_name, last_name, phone, avatar_path,
                  role, is_active, created_at`,
      [newName, newRole, newActive, id, req.session.studioId]
    );

    // если выключили — снести все сессии этого юзера
    if (target.is_active && !newActive) {
      await invalidateAllUserSessions(id);
    }

    res.json(r.rows[0]);
  } catch (err) { next(err); }
});

// ──────────────────────────────────────────────────────────────────────
// PUT /api/admin/users/:id/block — быстрый kill-switch
// ──────────────────────────────────────────────────────────────────────
router.put('/users/:id/block', async (req, res, next) => {
  try {
    const { id } = req.params;
    if (id === req.session.userId) return res.status(400).json({ error: 'cannot_disable_self' });

    const target = await fetchOwnUserOfStudio(id, req.session.studioId);
    if (!target) return res.status(404).json({ error: 'user_not_found' });
    if (target.role === 'owner' && target.is_active) {
      const remaining = await countActiveOwners(req.session.studioId, id);
      if (remaining < 1) return res.status(400).json({ error: 'last_owner_protected' });
    }

    await pool.query(
      `UPDATE saas_meta.users SET is_active = false WHERE id = $1 AND studio_id = $2`,
      [id, req.session.studioId]
    );
    await invalidateAllUserSessions(id);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ──────────────────────────────────────────────────────────────────────
// DELETE /api/admin/users/:id
// ──────────────────────────────────────────────────────────────────────
router.delete('/users/:id', async (req, res, next) => {
  try {
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
    // CASCADE на sessions подчистит автоматом
    res.json({ ok: true });
  } catch (err) { next(err); }
});

module.exports = router;
