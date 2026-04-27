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
const telegramRouter = require('./routes/telegram.cjs');
const authRouter = require('./routes/auth.cjs');
const profileRouter = require('./routes/profile.cjs');
const tenantRouter = require('./routes/tenant.cjs');
const adminRouter = require('./routes/admin.cjs');
const documentsRouter = require('./routes/documents.cjs');

const { requireAuth, requireActiveStudio } = require('./lib/middleware.cjs');
const { trackErrorResponse } = require('./lib/security_log.cjs');

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
// Security headers (без helmet — чтобы не тянуть зависимость).
//
// Дублирование с nginx (он же шлёт X-Content-Type-Options/X-Frame-Options):
// это ОК. Если завтра кто-то поднимет saas-crm без nginx (например, локально
// для отладки или временно через прямой Node-listen), заголовки всё равно
// будут стоять.
//
// HSTS: max-age=2 года + includeSubDomains. Включается только когда
// X-Forwarded-Proto=https (или secure-cookie стоит) — иначе при работе
// dev-сервера на http://localhost браузер закеширует HSTS и пойдёт ломать
// разработчиков. Production: APP_ORIGIN всегда https, NODE_ENV=production.
//
// CSP: default-src 'self' плюс несколько whitelist'ов под наш стек:
//   - script-src 'self' — только наш код, никаких inline-скриптов
//     (Vite-build удаляет inline-script в HTML, fingerprint-хеши в путях)
//   - style-src 'self' 'unsafe-inline' — Tailwind/Vite inject inline-styles
//     при HMR; в проде после vite build они в файлах, но defense-in-depth
//     оставляем (плюс компоненты используют style={{...}} в JSX)
//   - img-src — поддерживаем blob: для аватара (FileReader.readAsDataURL)
//     и data: для base64-подписей
//   - connect-src 'self' — XHR только к собственному origin
//   - frame-ancestors 'none' — никто не может встроить нас в iframe
//     (более строгий аналог X-Frame-Options=DENY; современный браузер
//     уважает CSP frame-ancestors поверх XFO)
// ──────────────────────────────────────────────────────────────────────
const IS_PRODUCTION = (process.env.NODE_ENV || '').toLowerCase() === 'production';

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');

  // HSTS только в production и только когда запрос пришёл через HTTPS
  // (определяем по X-Forwarded-Proto, который выставляет nginx).
  if (IS_PRODUCTION && req.headers['x-forwarded-proto'] === 'https') {
    res.setHeader(
      'Strict-Transport-Security',
      'max-age=63072000; includeSubDomains'
    );
  }

  // CSP. Если в будущем добавятся внешние ресурсы (analytics, sentry и т.п.),
  // расширять здесь — иначе они будут блокированы CSP.
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob: https:",
      "font-src 'self' data:",
      "connect-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self' https://*.payform.ru",
    ].join('; ')
  );

  next();
});

// ──────────────────────────────────────────────────────────────────────
// IP-burst monitoring: пишет [SEC] event если с одного IP идёт >50 4xx
// за 5 минут. Сам по себе ничего не блокирует — rate_limit.cjs делает
// блокировку на конкретных эндпоинтах. Это глобальное наблюдение.
// ──────────────────────────────────────────────────────────────────────
app.use(trackErrorResponse);

// ──────────────────────────────────────────────────────────────────────
// 1. Webhooks (raw body — ДО express.json!)
// ──────────────────────────────────────────────────────────────────────
app.use('/api/webhooks', webhooksRouter);

// ──────────────────────────────────────────────────────────────────────
// 1b. Telegram webhook — без auth, без requireActiveStudio.
//      Безопасность: проверяем X-Telegram-Bot-Api-Secret-Token внутри роута.
//      Свой express.json внутри роута (256 KB), чтобы не зависеть от глобального.
// ──────────────────────────────────────────────────────────────────────
app.use('/api/telegram', telegramRouter);

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
// 6b. Документы по броням (work_orders, acceptance_acts, order_photos, PDF).
//     Под теми же гейтами, что tenantRouter.
// ──────────────────────────────────────────────────────────────────────
app.use('/api', requireAuth, requireActiveStudio, documentsRouter);

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

  // pg-ошибки логируются полностью с detail/constraint — нужно для дебага.
  // А ВОТ пользователю detail НЕ возвращаем, иначе через 23505 (unique
  // violation) утечёт значение колонки. Конкретный сценарий:
  //   - signup с email='victim@gmail.com'
  //   - если email существует → 409 + detail: 'Key (email)=(victim@gmail.com)
  //     already exists' → это email-enumeration вектор (OWASP A05).
  // Конкретные роуты (auth.cjs#signup, admin.cjs) сами обрабатывают
  // 23505 раньше с понятным сообщением 'email_already_used' — пользователь
  // получает осмысленный 409 без leakage.
  console.error('[error]',
    req.method, req.originalUrl,
    err.code || '',
    err.message,
    err.detail ? '| detail=' + err.detail : '',
    err.constraint ? '| constraint=' + err.constraint : ''
  );

  // schema-name validation ошибки → 400. err.message здесь — наш собственный
  // текст из validateSchemaName, никаких leak'ов.
  if (['SCHEMA_NAME_INVALID', 'SCHEMA_NAME_RESERVED', 'SCHEMA_NAME_REQUIRED'].includes(err.code)) {
    return res.status(400).json({ error: err.code.toLowerCase(), message: err.message });
  }

  // pg unique_violation — НЕ отдаём detail клиенту. constraint по сути
  // говорит «есть конфликт, на каком-то UNIQUE-ключе» без значений.
  if (err.code === '23505') {
    return res.status(409).json({ error: 'conflict', constraint: err.constraint || null });
  }
  // pg foreign_key_violation
  if (err.code === '23503') {
    return res.status(400).json({ error: 'fk_violation', constraint: err.constraint || null });
  }
  // pg check_violation — наш cross-tenant trigger тоже бросает с этим
  // кодом. Не leak'аем сообщение от триггера (там есть UUID'ы) —
  // вызывающие роуты сами должны были это поймать assertUserInStudio.
  if (err.code === '23514') {
    return res.status(400).json({ error: 'check_violation', constraint: err.constraint || null });
  }

  res.status(500).json({ error: 'internal_error' });
});

module.exports = app;
