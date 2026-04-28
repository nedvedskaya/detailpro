'use strict';
/**
 * Express-middleware для SaaS-CRM.
 *
 *   requireAuth          — есть валидная сессия → req.session = { userId, studioId, schemaName, role }
 *   requireActiveStudio  — у студии не истёк access_until И is_active=true
 *   requireRole(...)     — у юзера одна из перечисленных ролей
 *
 * Порядок применения в роутах:
 *   router.get('/api/clients', requireAuth, requireActiveStudio, handler)
 *
 * requireActiveStudio отдельный middleware (а не часть requireAuth), чтобы
 * можно было оставить /api/billing/* и /api/auth/logout доступными даже
 * при просроченной подписке (юзер должен иметь возможность доплатить или
 * выйти).
 */

const { pool } = require('./db.cjs');
const { verifySession } = require('./auth.cjs');

const SESSION_COOKIE_NAME = process.env.SESSION_COOKIE_NAME || 'sid';

// ──────────────────────────────────────────────────────────────────────
// Парсер cookies — без зависимости от cookie-parser, чтобы не тянуть лишнее.
// Достаём только наш sid; этого хватает.
// ──────────────────────────────────────────────────────────────────────
function readSessionCookie(req) {
  const header = req.headers.cookie;
  if (!header) return null;
  const parts = header.split(';');
  for (const part of parts) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    if (name !== SESSION_COOKIE_NAME) continue;
    const val = part.slice(eq + 1).trim();
    // base64url не содержит спецсимволов, decodeURIComponent безопасен
    try { return decodeURIComponent(val); } catch (_) { return val; }
  }
  return null;
}

// ──────────────────────────────────────────────────────────────────────
// requireAuth
// ──────────────────────────────────────────────────────────────────────
async function requireAuth(req, res, next) {
  try {
    const token = readSessionCookie(req);
    if (!token) {
      return res.status(401).json({ error: 'unauthenticated' });
    }
    const session = await verifySession(token);
    if (!session) {
      return res.status(401).json({ error: 'session_invalid_or_expired' });
    }
    req.session = session;
    req.sessionToken = token;
    next();
  } catch (err) {
    next(err);
  }
}

// ──────────────────────────────────────────────────────────────────────
// requireActiveStudio
//   - is_active=false → 403 (студия отключена админом)
//   - access_until истёк → НЕ блокируем (мягкий режим, см. ниже)
//
// Мягкий режим по подписке: 402 за просрочку убран, чтобы менеджер/мастер
// и собственник видели одно и то же состояние. Раньше API отдавал 402
// для не-owner, а UI показывал lock-страницу — менеджер не мог работать,
// пока owner шёл оплачивать. Бизнес-логика «истёк → отключим» решается
// админом вручную через is_active=false (это всё ещё 403).
// ──────────────────────────────────────────────────────────────────────
async function requireActiveStudio(req, res, next) {
  try {
    if (!req.session) {
      return res.status(401).json({ error: 'unauthenticated' });
    }
    const { rows } = await pool.query(
      `SELECT is_active, access_until, plan
         FROM saas_meta.studios WHERE id = $1`,
      [req.session.studioId]
    );
    const studio = rows[0];
    if (!studio) {
      // студия удалена, а сессия осталась — на всякий случай инвалидация
      return res.status(403).json({ error: 'studio_not_found' });
    }
    if (!studio.is_active) {
      return res.status(403).json({ error: 'studio_disabled' });
    }
    req.studio = studio;
    next();
  } catch (err) {
    next(err);
  }
}

// ──────────────────────────────────────────────────────────────────────
// requireRole('admin') / requireRole('admin', 'manager')
// ──────────────────────────────────────────────────────────────────────
function requireRole(...allowedRoles) {
  if (allowedRoles.length === 0) {
    throw new Error('requireRole: список ролей пуст');
  }
  return function (req, res, next) {
    if (!req.session) {
      return res.status(401).json({ error: 'unauthenticated' });
    }
    if (!allowedRoles.includes(req.session.role)) {
      return res.status(403).json({ error: 'forbidden_role' });
    }
    next();
  };
}

// ──────────────────────────────────────────────────────────────────────
// requireNotMaster
//   Запрещает любые мутации профиля / аватара для роли 'master' —
//   мастер видит только свои бронирования и не может менять данные
//   студии. Используется в profile.cjs PATCH /api/profile, POST/DELETE
//   /api/profile/avatar и т.п. Раньше эта проверка повторялась
//   inline в трёх endpoint'ах, теперь — один middleware.
// ──────────────────────────────────────────────────────────────────────
function requireNotMaster(req, res, next) {
  if (!req.session) {
    return res.status(401).json({ error: 'unauthenticated' });
  }
  if (req.session.role === 'master') {
    return res.status(403).json({ error: 'master_cannot_edit' });
  }
  next();
}

module.exports = {
  requireAuth,
  requireActiveStudio,
  requireRole,
  requireNotMaster,
  readSessionCookie, // экспортируем для тестов
  SESSION_COOKIE_NAME,
};
