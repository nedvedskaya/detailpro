'use strict';
/**
 * Express-приложение SaaS-CRM.
 *
 * Порядок middleware важен:
 *   1. trust proxy + CORS                — должно идти ПЕРВЫМ
 *   2. Webhooks (express.raw)            — ПЕРЕД express.json, иначе подпись сломается
 *   3. express.json для всего остального
 *   4. /api/health                       — без auth
 *   5. /api/auth/*                        — без requireAuth (login/signup сами)
 *   6. /api/admin/*  + requireAuth + requireActiveStudio
 *   7. /api/*  (tenant CRUD) + requireAuth + requireActiveStudio
 *   8. error handler (последний)
 *
 * Почему без csurf/helmet:
 *   - SameSite=Lax cookie + кастомный заголовок (или CORS preflight) даёт
 *     достаточную CSRF-защиту для cookie-based API. Если фронт стоит на
 *     отдельном домене — добавим CSRF-токен.
 *   - helmet тянем без contentSecurityPolicy (как в исходном CRM); CSP
 *     настроим под конкретные домены при деплое.
 */

const path = require('node:path');
const express = require('express');

const webhooksRouter = require('./routes/webhooks.cjs');
const authRouter = require('./routes/auth.cjs');
const profileRouter = require('./routes/profile.cjs');
const tenantRouter = require('./routes/tenant.cjs');
const adminRouter = require('./routes/admin.cjs');

const { requireAuth, requireActiveStudio } = require('./lib/middleware.cjs');

const app = express();

// ──────────────────────────────────────────────────────────────────────
// Базовая конфигурация
// ──────────────────────────────────────────────────────────────────────
app.set('trust proxy', 1);                // X-Forwarded-For для req.ip + secure cookies
app.disable('x-powered-by');

// pg возвращает DATE/TIME/TIMESTAMP как строки, без преобразования в JS Date.
// Это поведение унаследовано из Crm-new-main (фронт ожидает строки).
const pg = require('pg');
const PG_DATE = 1082, PG_TIMESTAMP = 1114, PG_TIMESTAMPTZ = 1184;
pg.types.setTypeParser(PG_DATE, (v) => v);
pg.types.setTypeParser(PG_TIMESTAMP, (v) => v);
pg.types.setTypeParser(PG_TIMESTAMPTZ, (v) => v);

// ──────────────────────────────────────────────────────────────────────
// CORS — простая allowlist через env CORS_ORIGINS (через запятую).
// Если не задано — разрешаем same-origin (CORS не нужен).
// ──────────────────────────────────────────────────────────────────────
const CORS_ORIGINS = (process.env.CORS_ORIGINS || '')
  .split(',').map((s) => s.trim()).filter(Boolean);

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && CORS_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Requested-With');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ──────────────────────────────────────────────────────────────────────
// Минимальные security headers (без helmet — чтобы не тянуть зависимость)
// ──────────────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  next();
});

// ──────────────────────────────────────────────────────────────────────
// 1. Webhooks (raw body — ДО express.json!)
// ──────────────────────────────────────────────────────────────────────
app.use('/api/webhooks', webhooksRouter);

// ──────────────────────────────────────────────────────────────────────
// 2. JSON parser для всего остального API
// ──────────────────────────────────────────────────────────────────────
// limit 2mb — клиентские аватары в base64 могут быть до ~1.5mb (как в исходном CRM).
app.use(express.json({ limit: '2mb' }));

// ──────────────────────────────────────────────────────────────────────
// 3. Health check
// ──────────────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

// ──────────────────────────────────────────────────────────────────────
// 4. Auth (login/signup/logout/me — каждый сам управляет своим auth)
// ──────────────────────────────────────────────────────────────────────
app.use('/api/auth', authRouter);

// ──────────────────────────────────────────────────────────────────────
// 5. Profile (личный кабинет + аватар).
//     ВАЖНО: только requireAuth — БЕЗ requireActiveStudio.
//     Юзер с просроченной подпиской должен видеть профиль, чтобы оплатить.
// ──────────────────────────────────────────────────────────────────────
app.use('/api/profile', requireAuth, profileRouter);

// ──────────────────────────────────────────────────────────────────────
// 6. Admin (управление пользователями студии)
//     requireAuth → requireActiveStudio → router сам делает requireRole('owner')
// ──────────────────────────────────────────────────────────────────────
app.use('/api/admin', requireAuth, requireActiveStudio, adminRouter);

// ──────────────────────────────────────────────────────────────────────
// 6. Tenant CRUD (clients, vehicles, services, bookings, …)
// ──────────────────────────────────────────────────────────────────────
app.use('/api', requireAuth, requireActiveStudio, tenantRouter);

// ──────────────────────────────────────────────────────────────────────
// 7. Static frontend  (Vite-build, если есть; в dev проксирует Vite сам)
// ──────────────────────────────────────────────────────────────────────
// По умолчанию ищем сборку фронта в client/dist (Vite собирает туда).
// В деплое можно переопределить через STATIC_DIR.
const STATIC_DIR = process.env.STATIC_DIR || path.join(__dirname, '..', 'client', 'dist');
app.use(express.static(STATIC_DIR, { maxAge: '1h', index: false }));

// SPA fallback: всё, что НЕ /api/* — отдаём index.html (фронт сам разрулит).
// Используем регексп вместо glob, чтобы не зависеть от особенностей Express 5.
app.get(/^\/(?!api\/).*/, (req, res, next) => {
  res.sendFile(path.join(STATIC_DIR, 'index.html'), (err) => {
    if (err) next(); // нет билда — 404 ниже
  });
});

// ──────────────────────────────────────────────────────────────────────
// 8. Error handler — структурированный JSON
// ──────────────────────────────────────────────────────────────────────
// 404 для API
app.use('/api', (req, res) => {
  res.status(404).json({ error: 'not_found', path: req.originalUrl });
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  // Уже отправили часть ответа? — отдаём дальше Node-у.
  if (res.headersSent) return next(err);

  // pg-ошибки с кодами безопасны логировать как есть (без params).
  console.error('[error]', req.method, req.originalUrl, err.code || '', err.message);

  // schema-name validation ошибки → 400
  if (['SCHEMA_NAME_INVALID', 'SCHEMA_NAME_RESERVED', 'SCHEMA_NAME_REQUIRED'].includes(err.code)) {
    return res.status(400).json({ error: err.code.toLowerCase(), message: err.message });
  }

  // pg unique_violation
  if (err.code === '23505') return res.status(409).json({ error: 'conflict', detail: err.detail });

  // pg foreign_key_violation
  if (err.code === '23503') return res.status(400).json({ error: 'fk_violation', detail: err.detail });

  // pg check_violation
  if (err.code === '23514') return res.status(400).json({ error: 'check_violation', detail: err.detail });

  res.status(500).json({ error: 'internal_error' });
});

module.exports = app;
