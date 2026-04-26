'use strict';
/**
 * Auth routes.
 *
 *   POST /api/auth/signup   — создание студии + первого админа + auto-login.
 *   POST /api/auth/login    — логин по email+password, выдаёт sid-cookie.
 *   POST /api/auth/logout   — инвалидация текущей сессии.
 *   GET  /api/auth/me       — данные текущего пользователя + студии.
 *   POST /api/auth/password — смена пароля (требует старого), invalidates все сессии.
 *
 * Cookie:
 *   - HttpOnly (нельзя прочитать из JS — защита от XSS-кражи токена)
 *   - SameSite=Lax (CSRF-защита для GET; webhook на POST использует HMAC, не cookie)
 *   - Secure в production (только HTTPS)
 *   - Domain — из SESSION_COOKIE_DOMAIN, чтобы один cookie работал на всех
 *     путях SaaS-инстанса.
 *
 * Rate-limiting login:
 *   Делаем по email (а не по IP) — IP-ограничение легко обходится через
 *   мобильную сеть. После 5 неудач за 15 минут блокируем email на 15 минут.
 *   Считаем in-memory Map; для мульти-инстанс деплоя позже переедем на Redis
 *   или saas_meta.login_attempts. На 1 инстансе достаточно.
 */

const express = require('express');
const { pool } = require('../lib/db.cjs');
const {
  verifyPassword,
  hashPassword,
  createSession,
  invalidateSession,
  invalidateAllUserSessions,
} = require('../lib/auth.cjs');
const { requireAuth } = require('../lib/middleware.cjs');
const {
  createStudio,
  suggestSchemaName,
} = require('../lib/tenant_provisioning.cjs');
const { validateSchemaName } = require('../lib/tenant.cjs');

const router = express.Router();

const SESSION_COOKIE_NAME = process.env.SESSION_COOKIE_NAME || 'sid';
const SESSION_COOKIE_DOMAIN = process.env.SESSION_COOKIE_DOMAIN || undefined;
const SESSION_COOKIE_SECURE = (process.env.SESSION_COOKIE_SECURE || 'true').toLowerCase() === 'true';

// ──────────────────────────────────────────────────────────────────────
// Rate-limiting login: in-memory.
// Map<email, { attempts, blockedUntil }>. Перед входом смотрим blockedUntil.
// При 5+ неудачах за окно — блок на 15 минут.
// ──────────────────────────────────────────────────────────────────────
const LOGIN_ATTEMPTS = new Map();
const LOGIN_MAX_ATTEMPTS = 5;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_BLOCK_MS = 15 * 60 * 1000;

function isLoginBlocked(emailKey) {
  const rec = LOGIN_ATTEMPTS.get(emailKey);
  if (!rec) return false;
  if (rec.blockedUntil && rec.blockedUntil > Date.now()) return true;
  // окно прошло — обнулим
  if (rec.firstAttempt && Date.now() - rec.firstAttempt > LOGIN_WINDOW_MS) {
    LOGIN_ATTEMPTS.delete(emailKey);
  }
  return false;
}
function recordLoginFailure(emailKey) {
  let rec = LOGIN_ATTEMPTS.get(emailKey);
  const now = Date.now();
  if (!rec || (rec.firstAttempt && now - rec.firstAttempt > LOGIN_WINDOW_MS)) {
    rec = { firstAttempt: now, attempts: 0, blockedUntil: 0 };
  }
  rec.attempts += 1;
  if (rec.attempts >= LOGIN_MAX_ATTEMPTS) {
    rec.blockedUntil = now + LOGIN_BLOCK_MS;
  }
  LOGIN_ATTEMPTS.set(emailKey, rec);
}
function recordLoginSuccess(emailKey) {
  LOGIN_ATTEMPTS.delete(emailKey);
}

// Периодическая чистка карты — раз в час, без unref чтобы не держать процесс.
const cleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [k, rec] of LOGIN_ATTEMPTS) {
    if ((rec.blockedUntil || 0) < now && (now - (rec.firstAttempt || now)) > LOGIN_WINDOW_MS) {
      LOGIN_ATTEMPTS.delete(k);
    }
  }
}, 60 * 60 * 1000);
cleanupTimer.unref();

// ──────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────
function clientIp(req) {
  // express trust proxy уже распарсил X-Forwarded-For в req.ip
  return req.ip || req.socket?.remoteAddress || null;
}

function setSessionCookie(res, token, expiresAt) {
  const opts = {
    httpOnly: true,
    sameSite: 'lax',
    secure: SESSION_COOKIE_SECURE,
    expires: expiresAt,
    path: '/',
  };
  if (SESSION_COOKIE_DOMAIN) opts.domain = SESSION_COOKIE_DOMAIN;
  res.cookie(SESSION_COOKIE_NAME, token, opts);
}

function clearSessionCookie(res) {
  const opts = {
    httpOnly: true,
    sameSite: 'lax',
    secure: SESSION_COOKIE_SECURE,
    path: '/',
    expires: new Date(0),
  };
  if (SESSION_COOKIE_DOMAIN) opts.domain = SESSION_COOKIE_DOMAIN;
  res.clearCookie(SESSION_COOKIE_NAME, opts);
}

async function recordConsent(client, { userId, email, types, policyVersion, policyUrl, ip, userAgent }) {
  // types — массив строк: ['personal_data', 'terms', ...]
  for (const t of types) {
    await client.query(
      `INSERT INTO saas_meta.consents
         (user_id, email, consent_type, policy_version, policy_url, ip, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [userId, email, t, policyVersion, policyUrl, ip, userAgent]
    );
  }
}

// ──────────────────────────────────────────────────────────────────────
// POST /api/auth/signup
//
// Body: {
//   email, password,
//   displayName,         // имя студии
//   schemaName?,         // если не передано — генерируется из displayName
//   ownerName?,
//   acceptedPolicy: true,
//   acceptedTerms: true,
//   policyVersion?      // напр. '2026-04-26'
// }
// ──────────────────────────────────────────────────────────────────────
router.post('/signup', async (req, res, next) => {
  try {
    const {
      email,
      password,
      displayName,
      schemaName: rawSchemaName,
      ownerName,
      acceptedPolicy,
      acceptedTerms,
      acceptedMarketing,
      policyVersion,
    } = req.body || {};

    if (!acceptedPolicy || !acceptedTerms) {
      return res.status(400).json({ error: 'consent_required' });
    }

    // Schema name: либо явно указано, либо генерируем из displayName.
    let schemaName = rawSchemaName;
    if (!schemaName) {
      schemaName = suggestSchemaName(displayName || '');
      if (!schemaName) {
        return res.status(400).json({ error: 'schema_name_invalid', hint: 'передайте schemaName явно' });
      }
      // если кандидат не начинается на studio_, добавим — для удобства просмотра
      if (!schemaName.startsWith('studio_')) schemaName = ('studio_' + schemaName).slice(0, 32);
    }
    try { validateSchemaName(schemaName); } catch (err) {
      return res.status(400).json({ error: err.code || 'schema_name_invalid', message: err.message });
    }

    // Уникальность schemaName (FK даст 23505, но дадим понятное 409 заранее).
    const existing = await pool.query(
      'SELECT 1 FROM saas_meta.studios WHERE schema_name = $1',
      [schemaName]
    );
    if (existing.rowCount > 0) {
      return res.status(409).json({ error: 'schema_name_taken' });
    }

    // Создаём студию + админа.
    let result;
    try {
      result = await createStudio({
        schemaName,
        displayName: displayName || schemaName,
        ownerEmail: email,
        ownerPassword: password,
        ownerName,
      });
    } catch (err) {
      const code = err.code || '';
      if (['EMAIL_INVALID', 'PASSWORD_TOO_SHORT', 'EMAIL_ALREADY_USED', 'DISPLAY_NAME_REQUIRED', 'SCHEMA_NAME_INVALID', 'SCHEMA_NAME_RESERVED'].includes(code)) {
        return res.status(400).json({ error: code.toLowerCase(), message: err.message });
      }
      throw err;
    }

    // Записываем согласия.
    const consentTypes = ['personal_data', 'terms'];
    if (acceptedMarketing) consentTypes.push('marketing');
    await pool.connect().then(async (client) => {
      try {
        await recordConsent(client, {
          userId: result.userId,
          email: email.toLowerCase(),
          types: consentTypes,
          policyVersion: policyVersion || '1.0',
          policyUrl: '/legal/privacy-policy',
          ip: clientIp(req),
          userAgent: req.headers['user-agent'] || null,
        });
      } finally {
        client.release();
      }
    });

    // Auto-login.
    const session = await createSession({
      userId: result.userId,
      studioId: result.studioId,
      schemaName: result.schemaName,
      userAgent: req.headers['user-agent'] || null,
      ip: clientIp(req),
    });
    setSessionCookie(res, session.token, session.expiresAt);

    res.status(201).json({
      ok: true,
      studio: { id: result.studioId, schemaName: result.schemaName, displayName: displayName || schemaName },
      user: { id: result.userId, email: email.toLowerCase(), role: 'admin' },
    });
  } catch (err) {
    next(err);
  }
});

// ──────────────────────────────────────────────────────────────────────
// POST /api/auth/login
// Body: { email, password }
// ──────────────────────────────────────────────────────────────────────
router.post('/login', async (req, res, next) => {
  try {
    const { email, password } = req.body || {};
    if (typeof email !== 'string' || typeof password !== 'string') {
      return res.status(400).json({ error: 'email_password_required' });
    }
    const emailKey = email.toLowerCase();

    if (isLoginBlocked(emailKey)) {
      return res.status(429).json({ error: 'too_many_attempts' });
    }

    const { rows } = await pool.query(
      `SELECT u.id, u.email, u.password_hash, u.role, u.is_active, u.studio_id,
              s.schema_name, s.is_active AS studio_active, s.access_until
         FROM saas_meta.users u
         JOIN saas_meta.studios s ON s.id = u.studio_id
        WHERE u.email = $1`,
      [emailKey]
    );
    const user = rows[0];

    // Constant-time-ish: всегда выполняем verifyPassword даже если пользователя нет,
    // чтобы не палить enum через тайминги. Но без БД-fetch это compromise — ок.
    if (!user) {
      // фейковая проверка для приближения тайминга к успешному пути
      await verifyPassword(password, '0000.0000');
      recordLoginFailure(emailKey);
      return res.status(401).json({ error: 'invalid_credentials' });
    }

    const ok = await verifyPassword(password, user.password_hash);
    if (!ok) {
      recordLoginFailure(emailKey);
      return res.status(401).json({ error: 'invalid_credentials' });
    }

    if (!user.is_active) {
      return res.status(403).json({ error: 'user_disabled' });
    }
    if (!user.studio_active) {
      return res.status(403).json({ error: 'studio_disabled' });
    }
    // Если access_until истёк — всё равно даём логин (чтобы юзер мог доплатить),
    // но дадим знать клиенту. requireActiveStudio сам блокнёт CRM-роуты.

    recordLoginSuccess(emailKey);

    const session = await createSession({
      userId: user.id,
      studioId: user.studio_id,
      schemaName: user.schema_name,
      userAgent: req.headers['user-agent'] || null,
      ip: clientIp(req),
    });
    setSessionCookie(res, session.token, session.expiresAt);

    res.json({
      ok: true,
      user: { id: user.id, email: user.email, role: user.role },
      studio: { id: user.studio_id, schemaName: user.schema_name, accessUntil: user.access_until },
    });
  } catch (err) {
    next(err);
  }
});

// ──────────────────────────────────────────────────────────────────────
// POST /api/auth/logout
// ──────────────────────────────────────────────────────────────────────
router.post('/logout', async (req, res, next) => {
  try {
    // requireAuth НЕ применяем — logout должен работать даже если cookie
    // невалиден (просто чистим cookie). Но если cookie есть — снесём из БД.
    const cookies = req.headers.cookie || '';
    const m = cookies.match(new RegExp('(?:^|;\\s*)' + SESSION_COOKIE_NAME + '=([^;]+)'));
    if (m) {
      try { await invalidateSession(decodeURIComponent(m[1])); } catch (_) {}
    }
    clearSessionCookie(res);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ──────────────────────────────────────────────────────────────────────
// GET /api/auth/me
// ──────────────────────────────────────────────────────────────────────
router.get('/me', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT u.id, u.email, u.role, u.name, u.is_active,
              s.id AS studio_id, s.schema_name, s.display_name, s.plan, s.is_active AS studio_active,
              s.access_until
         FROM saas_meta.users u
         JOIN saas_meta.studios s ON s.id = u.studio_id
        WHERE u.id = $1`,
      [req.session.userId]
    );
    const row = rows[0];
    if (!row) return res.status(404).json({ error: 'user_not_found' });

    res.json({
      user: { id: row.id, email: row.email, role: row.role, name: row.name, isActive: row.is_active },
      studio: {
        id: row.studio_id,
        schemaName: row.schema_name,
        displayName: row.display_name,
        plan: row.plan,
        isActive: row.studio_active,
        accessUntil: row.access_until,
      },
    });
  } catch (err) {
    next(err);
  }
});

// ──────────────────────────────────────────────────────────────────────
// POST /api/auth/password
// Body: { oldPassword, newPassword }
// Меняет пароль и вырубает все остальные сессии пользователя.
// ──────────────────────────────────────────────────────────────────────
router.post('/password', requireAuth, async (req, res, next) => {
  try {
    const { oldPassword, newPassword } = req.body || {};
    if (typeof oldPassword !== 'string' || typeof newPassword !== 'string') {
      return res.status(400).json({ error: 'old_and_new_password_required' });
    }
    if (newPassword.length < 8) {
      return res.status(400).json({ error: 'password_too_short' });
    }
    const { rows } = await pool.query(
      'SELECT password_hash FROM saas_meta.users WHERE id = $1',
      [req.session.userId]
    );
    if (!rows[0]) return res.status(404).json({ error: 'user_not_found' });

    const ok = await verifyPassword(oldPassword, rows[0].password_hash);
    if (!ok) return res.status(401).json({ error: 'invalid_old_password' });

    const newHash = await hashPassword(newPassword);
    await pool.query(
      'UPDATE saas_meta.users SET password_hash = $1 WHERE id = $2',
      [newHash, req.session.userId]
    );

    // Снести все сессии пользователя (в т.ч. текущую). Затем дадим свежую,
    // чтобы клиент не оказался залогинен не-тем-паролем.
    await invalidateAllUserSessions(req.session.userId);
    const session = await createSession({
      userId: req.session.userId,
      studioId: req.session.studioId,
      schemaName: req.session.schemaName,
      userAgent: req.headers['user-agent'] || null,
      ip: clientIp(req),
    });
    setSessionCookie(res, session.token, session.expiresAt);

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
