'use strict';
/**
 * Admin routes: управление пользователями студии (manager/employee).
 *
 *   GET    /api/admin/users          — список пользователей студии
 *   POST   /api/admin/users          — создать пользователя в этой студии
 *   PUT    /api/admin/users/:id      — обновить (role, name, is_active)
 *   PUT    /api/admin/users/:id/block — выключить (is_active=false) + invalidate sessions
 *   DELETE /api/admin/users/:id      — удалить (CASCADE снимет сессии)
 *
 * Все роуты доступны только role='admin' и только в рамках своей студии:
 * проверка studio_id = req.session.studioId внутри каждого хендлера.
 *
 * Защита от self-lockout:
 *   - admin не может удалить сам себя
 *   - admin не может снять себе роль admin (downgrade на manager/employee)
 *   - admin не может заблокировать сам себя
 *
 * Защита от orphan studio:
 *   - нельзя удалить последнего admin студии (иначе никто не сможет управлять)
 */

const express = require('express');
const { pool } = require('../lib/db.cjs');
const {
  hashPassword,
  invalidateAllUserSessions,
} = require('../lib/auth.cjs');
const { requireRole } = require('../lib/middleware.cjs');

const router = express.Router();

// На все админские роуты — только admin.
router.use(requireRole('admin'));

const VALID_ROLES = ['admin', 'manager', 'employee'];

// Подсчёт активных админов студии — для защиты от orphan.
async function countActiveAdmins(studioId, excludeUserId) {
  const args = [studioId];
  let sql = `SELECT COUNT(*)::int AS c FROM saas_meta.users
              WHERE studio_id = $1 AND role = 'admin' AND is_active = true`;
  if (excludeUserId) {
    sql += ' AND id <> $2';
    args.push(excludeUserId);
  }
  const r = await pool.query(sql, args);
  return r.rows[0].c;
}

async function fetchOwnUserOfStudio(userId, studioId) {
  const r = await pool.query(
    `SELECT id, email, name, role, is_active, created_at
       FROM saas_meta.users
      WHERE id = $1 AND studio_id = $2`,
    [userId, studioId]
  );
  return r.rows[0] || null;
}

// ──────────────────────────────────────────────────────────────────────
// GET /api/admin/users
// ──────────────────────────────────────────────────────────────────────
router.get('/users', async (req, res, next) => {
  try {
    const r = await pool.query(
      `SELECT id, email, name, role, is_active, created_at
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
// Body: { email, password, name?, role? }
// ──────────────────────────────────────────────────────────────────────
router.post('/users', async (req, res, next) => {
  try {
    const { email, password, name, role } = req.body || {};
    if (typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'email_invalid' });
    }
    if (typeof password !== 'string' || password.length < 8) {
      return res.status(400).json({ error: 'password_too_short' });
    }
    const finalRole = VALID_ROLES.includes(role) ? role : 'employee';
    const passwordHash = await hashPassword(password);

    let r;
    try {
      r = await pool.query(
        `INSERT INTO saas_meta.users (studio_id, email, password_hash, role, name, is_active)
           VALUES ($1, $2, $3, $4, $5, true)
           RETURNING id, email, name, role, is_active, created_at`,
        [req.session.studioId, email.toLowerCase(), passwordHash, finalRole, name || null]
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
      if (role && role !== 'admin') return res.status(400).json({ error: 'cannot_demote_self' });
      if (is_active === false) return res.status(400).json({ error: 'cannot_disable_self' });
    }

    // нельзя снять последнего admin студии
    if (target.role === 'admin' && target.is_active) {
      if ((role && role !== 'admin') || is_active === false) {
        const remaining = await countActiveAdmins(req.session.studioId, id);
        if (remaining < 1) return res.status(400).json({ error: 'last_admin_protected' });
      }
    }

    const newRole = role && VALID_ROLES.includes(role) ? role : target.role;
    const newActive = typeof is_active === 'boolean' ? is_active : target.is_active;
    const newName = name !== undefined ? name : target.name;

    const r = await pool.query(
      `UPDATE saas_meta.users
          SET name = $1, role = $2, is_active = $3
        WHERE id = $4 AND studio_id = $5
        RETURNING id, email, name, role, is_active, created_at`,
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
    if (target.role === 'admin' && target.is_active) {
      const remaining = await countActiveAdmins(req.session.studioId, id);
      if (remaining < 1) return res.status(400).json({ error: 'last_admin_protected' });
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

    if (target.role === 'admin') {
      const remaining = await countActiveAdmins(req.session.studioId, id);
      if (remaining < 1) return res.status(400).json({ error: 'last_admin_protected' });
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
