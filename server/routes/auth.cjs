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
const crypto = require('node:crypto');
const { pool, withTx } = require('../lib/db.cjs');
const { consumeOneTimeToken, OneTimeTokenError } = require('../lib/one_time_token.cjs');
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
const { assertStrongPassword, checkEmailMx } = require('../lib/validation.cjs');
const { logAction } = require('../lib/audit.cjs');
const { securityLog, SEVERITY } = require('../lib/security_log.cjs');
const tgClient = require('../lib/telegram.cjs');
const { applyGender } = require('../lib/gender.cjs');

const router = express.Router();

const SESSION_COOKIE_NAME = process.env.SESSION_COOKIE_NAME || 'sid';
const SESSION_COOKIE_DOMAIN = process.env.SESSION_COOKIE_DOMAIN || undefined;
// secure=true — обязательно в production, в dev можно отключить через env
// (HTTP-локалхост). Раньше env управляла безоговорочно: случайно выставленный
// SESSION_COOKIE_SECURE=false в проде → cookie уходит по HTTP в открытом виде.
const IS_PRODUCTION = (process.env.NODE_ENV || '').toLowerCase() === 'production';
const SESSION_COOKIE_SECURE =
  IS_PRODUCTION
    ? true
    : (process.env.SESSION_COOKIE_SECURE || 'true').toLowerCase() === 'true';

// ──────────────────────────────────────────────────────────────────────
// Rate-limiting: общий хелпер из lib/rate_limit.cjs, с двумя слоями —
// по email (анти-targeted-bruteforce конкретного юзера) и по IP
// (анти-distributed-bruteforce десятков email из одного IP).
//
// Login:
//   • 5 неудач в 15 мин на ОДИН email → блок этого email на 15 мин
//   • 30 неудач в 15 мин с одного IP   → блок этого IP на 15 мин
//
// Password-reset request:
//   • 3 запроса в 15 мин на email → 429
//   • 10 запросов в час с одного IP → 429
//
// Signup:
//   • 5 успешных или попыток signup за час с одного IP → 429
//   • защита от спам-регистрации студий (DDL — дорогая операция,
//     неконтролируемое создание схем может уронить базу)
// ──────────────────────────────────────────────────────────────────────
const { FixedWindowLimiter } = require('../lib/rate_limit.cjs');

const loginByEmail = new FixedWindowLimiter({
  name: 'login.email',
  max: 5, windowMs: 15 * 60 * 1000, blockMs: 15 * 60 * 1000,
});
const loginByIp = new FixedWindowLimiter({
  name: 'login.ip',
  max: 30, windowMs: 15 * 60 * 1000, blockMs: 15 * 60 * 1000,
});
const resetByEmail = new FixedWindowLimiter({
  name: 'reset.email',
  max: 3, windowMs: 15 * 60 * 1000, blockMs: 15 * 60 * 1000,
});
const resetByIp = new FixedWindowLimiter({
  name: 'reset.ip',
  max: 10, windowMs: 60 * 60 * 1000, blockMs: 60 * 60 * 1000,
});
const signupByIp = new FixedWindowLimiter({
  name: 'signup.ip',
  max: 5, windowMs: 60 * 60 * 1000, blockMs: 60 * 60 * 1000,
});

// ──────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────
function clientIp(req) {
  // express trust proxy уже распарсил X-Forwarded-For в req.ip
  return req.ip || req.socket?.remoteAddress || null;
}

// Базовые опции session-cookie. Меняются ТОЛЬКО здесь — иначе set/clear
// разойдутся (clearCookie не сработает если domain/path/sameSite/secure
// отличаются от того, чем cookie ставился).
function sessionCookieOpts() {
  const opts = {
    httpOnly: true,
    sameSite: 'lax',
    secure: SESSION_COOKIE_SECURE,
    path: '/',
  };
  if (SESSION_COOKIE_DOMAIN) opts.domain = SESSION_COOKIE_DOMAIN;
  return opts;
}

function setSessionCookie(res, token, expiresAt) {
  const opts = { ...sessionCookieOpts() };
  if (expiresAt) opts.expires = expiresAt;
  res.cookie(SESSION_COOKIE_NAME, token, opts);
}

function clearSessionCookie(res) {
  // expires: epoch — заставляет браузер удалить cookie сразу
  res.clearCookie(SESSION_COOKIE_NAME, { ...sessionCookieOpts(), expires: new Date(0) });
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
    // Anti-spam: 5 регистраций в час с одного IP. Без этого скрипт может
    // создать сотни студий — каждая = CREATE SCHEMA + кучка таблиц, дорогая
    // блокирующая операция на стороне Postgres.
    const ip = clientIp(req);
    if (ip && !signupByIp.hit(ip)) {
      return res.status(429).json({ error: 'too_many_signups' });
    }

    // Принимаем ДВА формата payload:
    //   (1) фронтовский (текущий клиент):
    //       { studioName, email, password, name, consents: { personal_data, terms, marketing } }
    //   (2) старый camelCase (для curl-смоков и совместимости):
    //       { displayName, schemaName, email, password, ownerName, acceptedPolicy, acceptedTerms, acceptedMarketing, policyVersion }
    // Из обоих собираем единый набор переменных.
    const body = req.body || {};
    const consents = body.consents || {};

    const email = body.email;
    const password = body.password;
    const displayName = body.displayName || body.studioName;
    const ownerFirstName = body.firstName || null;
    const ownerLastName  = body.lastName  || null;
    // Legacy: старый клиент шлёт `name` одной строкой. Если есть first/last —
    // используем их; иначе ownerName сработает как fallback в createStudio.
    const ownerName = body.ownerName
      || body.name
      || [ownerFirstName, ownerLastName].filter(Boolean).join(' ').trim()
      || null;
    const rawSchemaName = body.schemaName;
    const policyVersion = body.policyVersion || consents.policyVersion || '1.0';
    // Реферальный код приходит из ?ref=CODE в URL фронта. Если кода нет или он
    // невалидный — signup проходит обычным образом (createStudio проверит
    // существование кода и просто не привяжет referred_by).
    const referredByCode = (body.referralCode || body.ref || '').toString().trim() || null;
    // Сценарий «бот → сайт»: пользователь начал в TG-боте, нажал «Создать
    // аккаунт», бот сгенерил saas_meta.tg_signup_tokens.token и открыл
    // /?tg=<token>. На фронте токен сохранён в localStorage и отправляется
    // сюда. Если токен валиден — createStudio в той же транзакции линкует
    // tg_user_id/tg_chat_id/tg_username из строки токена.
    const tgSignupToken = (body.tgSignupToken || '').toString().trim() || null;

    const acceptedPolicy = body.acceptedPolicy ?? consents.personal_data;
    const acceptedTerms = body.acceptedTerms ?? consents.terms;
    const acceptedMarketing = body.acceptedMarketing ?? consents.marketing;


    // MX-проверка: отсекаем несуществующие домены (test@aaa.ru и т.п.)
    if (email && !(await checkEmailMx(email))) {
      return res.status(400).json({ error: 'email_domain_invalid' });
    }

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

    // Уникальность schemaName.
    // Раньше при коллизии возвращали 409 schema_name_taken — но т.к. имя схемы
    // генерируется автоматически из displayName (и displayName может повторяться:
    // «Студия Иванова» и ещё одна «Студия Иванова» — это нормально), коллизия
    // имени схемы НЕ должна блокировать signup. Авто-добавляем числовой суффикс
    // _2, _3, …, до 99 — этого хватит. Если всё равно занято (что почти
    // невозможно), фолбэк на 8-hex-суффикс.
    if (!rawSchemaName) {
      const isTaken = async (name) => (await pool.query(
        'SELECT 1 FROM saas_meta.studios WHERE schema_name = $1', [name]
      )).rowCount > 0;
      if (await isTaken(schemaName)) {
        let resolved = null;
        for (let i = 2; i <= 99; i++) {
          const suffix = '_' + i;
          const candidate = (schemaName.slice(0, 32 - suffix.length) + suffix);
          if (!(await isTaken(candidate))) { resolved = candidate; break; }
        }
        if (!resolved) {
          // крайне маловероятный случай — добавляем 8-hex
          const rnd = Math.random().toString(16).slice(2, 10);
          resolved = (schemaName.slice(0, 32 - 9) + '_' + rnd);
        }
        schemaName = resolved;
      }
    } else {
      // Имя пришло явно от пользователя/админа — не подменяем втихую,
      // возвращаем 409, чтобы вызывающий код увидел конфликт.
      const existing = await pool.query(
        'SELECT 1 FROM saas_meta.studios WHERE schema_name = $1',
        [schemaName]
      );
      if (existing.rowCount > 0) {
        return res.status(409).json({ error: 'schema_name_taken' });
      }
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
        ownerFirstName,
        ownerLastName,
        referredByCode,
        tgSignupToken,
      });
    } catch (err) {
      const code = err.code || '';
      if (['EMAIL_INVALID', 'PASSWORD_TOO_SHORT', 'PASSWORD_TOO_COMMON', 'EMAIL_ALREADY_USED', 'DISPLAY_NAME_REQUIRED', 'SCHEMA_NAME_INVALID', 'SCHEMA_NAME_RESERVED'].includes(code)) {
        return res.status(400).json({ error: code.toLowerCase(), message: err.message });
      }
      // TG-токен указывал на tg_user_id, который уже привязан к другому
      // аккаунту. Показываем человеку понятную ошибку — пусть он
      // /unlink-нет старый аккаунт через бота и попробует ещё раз.
      if (code === 'TG_ALREADY_LINKED') {
        return res.status(409).json({
          error: 'tg_already_linked',
          message: 'Этот Telegram уже привязан к другому аккаунту СРМ. Отправь /unlink в бота и нажми «Создать аккаунт» снова.',
        });
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

    // Если signup пришёл из бота (tgSignupToken и линковка прошла) —
    // отправляем welcome-сообщение в TG и запускаем онбординг (пол + tz).
    // НЕ блокируем ответ роута: ошибка отправки в TG не должна валить signup.
    if (result.tgLinked) {
      sendBotWelcomeAfterSignup(result.userId).catch((e) =>
        console.error('[auth] sendBotWelcomeAfterSignup failed:', e.message));
    }

    res.status(201).json({
      ok: true,
      studio: { id: result.studioId, schemaName: result.schemaName, displayName: displayName || schemaName },
      user: { id: result.userId, email: email.toLowerCase(), role: 'owner' },
      tgLinked: !!result.tgLinked,
    });
  } catch (err) {
    next(err);
  }
});

// ──────────────────────────────────────────────────────────────────────
// После успешного signup с TG-токеном — приветствие в TG + онбординг.
// Импорт telegram-роута круговой (telegram.cjs зависит от auth.cjs не-напрямую,
// а через lib/telegram.cjs), поэтому используем lazy require внутри функции.
// ──────────────────────────────────────────────────────────────────────
async function sendBotWelcomeAfterSignup(userId) {
  const { rows } = await pool.query(
    `SELECT u.id, u.email, u.name, u.role, u.studio_id, u.tg_chat_id, u.gender,
            s.timezone, s.timezone_set
       FROM saas_meta.users u
       JOIN saas_meta.studios s ON s.id = u.studio_id
      WHERE u.id = $1`,
    [userId]
  );
  const linked = rows[0];
  if (!linked || !linked.tg_chat_id) return;

  // Welcome — короткое и в тон сообщению link_success в bot'е.
  await tgClient.sendMessage({
    chatId: linked.tg_chat_id,
    userId: linked.id,
    kind: 'signup_success_link',
    text:
      `Поздравляю с регистрацией! Аккаунт СРМ создан, ` +
      `Telegram уже подвязан, мы на коннекте 🤝\n\n` +
      `Меню появится сразу после пары быстрых вопросов ниже, ` +
      `нужно для корректных напоминаний.`,
  });

  // Онбординг (пол → таймзона) — переиспользуем функции из routes/telegram.cjs.
  const { runOnboardingChecks } = require('./telegram.cjs');
  if (typeof runOnboardingChecks === 'function') {
    await runOnboardingChecks(linked.tg_chat_id, linked);
  }
}

// ──────────────────────────────────────────────────────────────────────
// POST /api/auth/login
// Body: { email, password }
// ──────────────────────────────────────────────────────────────────────
router.post('/login', async (req, res, next) => {
  try {
    const { email, password, rememberMe } = req.body || {};
    if (typeof email !== 'string' || typeof password !== 'string') {
      return res.status(400).json({ error: 'email_password_required' });
    }
    const emailKey = email.toLowerCase();
    const ipKey = clientIp(req);

    // Двойной gate: email или IP — что первое сработало.
    // Email-блок защищает конкретного юзера от целенаправленного перебора.
    // IP-блок защищает от distributed-атаки (один IP перебирает много email).
    if (loginByEmail.isBlocked(emailKey) || (ipKey && loginByIp.isBlocked(ipKey))) {
      securityLog({
        event: 'login.rate_limit_block',
        severity: SEVERITY.WARN,
        ip: ipKey,
        email: emailKey,
        route: 'POST /api/auth/login',
      });
      return res.status(429).json({ error: 'too_many_attempts' });
    }

    const { rows } = await pool.query(
      `SELECT u.id, u.email, u.name, u.password_hash, u.role, u.is_active, u.studio_id,
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
      loginByEmail.recordFailure(emailKey);
      if (ipKey) loginByIp.recordFailure(ipKey);
      securityLog({
        event: 'login.failure',
        severity: SEVERITY.WARN,
        ip: ipKey,
        email: emailKey,
        reason: 'unknown_email',
        route: 'POST /api/auth/login',
      });
      return res.status(401).json({ error: 'invalid_credentials' });
    }

    const ok = await verifyPassword(password, user.password_hash);
    if (!ok) {
      loginByEmail.recordFailure(emailKey);
      if (ipKey) loginByIp.recordFailure(ipKey);
      securityLog({
        event: 'login.failure',
        severity: SEVERITY.WARN,
        ip: ipKey,
        email: emailKey,
        userId: user.id,
        reason: 'wrong_password',
        route: 'POST /api/auth/login',
      });
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

    // Успех — сбрасываем счётчик по email. IP не сбрасываем: если с одного
    // IP уже было 25 неудач по разным email и потом пришёл успех — это
    // подозрительно, оставляем счётчик.
    loginByEmail.recordSuccess(emailKey);
    securityLog({
      event: 'login.success',
      severity: SEVERITY.INFO,
      ip: ipKey,
      email: emailKey,
      userId: user.id,
      route: 'POST /api/auth/login',
    });

    // last_login_at — для отображения в админке «когда заходил». Не блокируем
    // логин если запись не удалась (это лишь дата для UI).
    pool.query(
      `UPDATE saas_meta.users SET last_login_at = now() WHERE id = $1`,
      [user.id]
    ).catch((err) => console.error('[auth] last_login_at:', err.message));

    // Аудит-лог входа (для admin-панели «Активность») не должен блокировать
    // выдачу сессии: при проблеме tenant-схемы пользователь всё равно должен
    // попасть в профиль/оплату, а ошибка уйдёт в stderr через audit-helper.
    logAction({
      schemaName: user.schema_name,
      userId:     user.id,
      userName:   user.name || null,
      action:     'login',
      entityType: 'session',
      ip:         clientIp(req),
    });

    const session = await createSession({
      userId: user.id,
      studioId: user.studio_id,
      schemaName: user.schema_name,
      userAgent: req.headers['user-agent'] || null,
      ip: clientIp(req),
    });
    setSessionCookie(res, session.token, rememberMe === false ? null : session.expiresAt);

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
      const token = decodeURIComponent(m[1]);
      // До инвалидации — достаём контекст для аудит-лога.
      try {
        const r = await pool.query(
          `SELECT s.user_id, s.schema_name, u.name
             FROM saas_meta.sessions s
             JOIN saas_meta.users u ON u.id = s.user_id
            WHERE s.token = $1`,
          [token]
        );
        const ctx = r.rows[0];
        if (ctx) {
          logAction({
            schemaName: ctx.schema_name,
            userId:     ctx.user_id,
            userName:   ctx.name,
            action:     'logout',
            entityType: 'session',
            ip:         clientIp(req),
          });
        }
      } catch (_) { /* лог не должен мешать выходу */ }
      try { await invalidateSession(token); } catch (_) {}
    }
    clearSessionCookie(res);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ──────────────────────────────────────────────────────────────────────
// POST /api/auth/welcome-shown  — помечает welcome как показанный
// ──────────────────────────────────────────────────────────────────────
router.post('/welcome-shown', requireAuth, async (req, res, next) => {
  try {
    await pool.query(
      `UPDATE saas_meta.users
          SET permissions = COALESCE(permissions, '{}'::jsonb) || '{"welcome_shown":true}'::jsonb
        WHERE id = $1`,
      [req.session.userId]
    );
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ──────────────────────────────────────────────────────────────────────
// GET /api/auth/me
// ──────────────────────────────────────────────────────────────────────
router.get('/me', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT u.id, u.email, u.role, u.name,
              u.first_name, u.last_name, u.phone, u.avatar_path, u.created_at,
              u.is_active, u.can_view_finance, u.permissions, u.last_login_at,
              s.id AS studio_id, s.schema_name, s.display_name, s.plan, s.is_active AS studio_active,
              s.access_until, s.created_at AS studio_created_at, s.extra_users_count
         FROM saas_meta.users u
         JOIN saas_meta.studios s ON s.id = u.studio_id
        WHERE u.id = $1`,
      [req.session.userId]
    );
    const row = rows[0];
    if (!row) return res.status(404).json({ error: 'user_not_found' });

    // Computed name: предпочтение first+last, иначе legacy users.name.
    const composed = [row.first_name, row.last_name].filter(Boolean).join(' ').trim();
    const displayName = composed || row.name || '';

    // canViewFinance: для master хардкодом false (мастер никогда не видит финансы),
    // для owner всегда true, для manager — по флагу из БД (по умолчанию true,
    // чтобы не сломать студии на которых миграция 003 ещё не накатилась).
    let canViewFinance;
    if (row.role === 'master') canViewFinance = false;
    else if (row.role === 'owner') canViewFinance = true;
    else canViewFinance = row.can_view_finance !== false;

    res.json({
      user: {
        id: row.id,
        email: row.email,
        role: row.role,
        name: displayName,
        firstName: row.first_name,
        lastName: row.last_name,
        phone: row.phone,
        avatarPath: row.avatar_path,
        createdAt: row.created_at,
        isActive: row.is_active,
        canViewFinance,
        permissions: row.permissions || null,
        lastLoginAt: row.last_login_at,
      },
      studio: {
        id: row.studio_id,
        schemaName: row.schema_name,
        displayName: row.display_name,
        plan: row.plan,
        isActive: row.studio_active,
        accessUntil: row.access_until,
        createdAt: row.studio_created_at,
        extraUsersCount: row.extra_users_count || 0,
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
    // Раннее отклонение слабого пароля — до похода в БД и сравнения старого.
    // hashPassword тоже это проверит, но клиенту нужен чёткий код, а не
    // generic 500.
    try {
      assertStrongPassword(newPassword);
    } catch (err) {
      return res.status(400).json({ error: err.message });
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

function appOrigin(req) {
  // Production: detailprocrm.ru. Локально/dev: protocol+host из запроса.
  // Берём из env, чтобы reset-ссылка была всегда на правильный домен,
  // даже если кто-то стучится через IP или alt-домен.
  return process.env.APP_ORIGIN || (req.protocol + '://' + req.get('host'));
}

// ──────────────────────────────────────────────────────────────────────
// POST /api/auth/password-reset/request
// Body: { email }
//
// Если у пользователя привязан Telegram — генерим токен, шлём ссылку
// /reset?token=... в TG. В ответе фронту — НЕ говорим, есть такой
// пользователь или нет (защита от user-enumeration), всегда отвечаем
// одинаково.
//
// Если TG не привязан — фронт получает delivery: 'no_channel' с
// инструкцией написать в поддержку. Не рассказываем имя/email — просто
// говорим, что у этого аккаунта нет канала для сброса.
// ──────────────────────────────────────────────────────────────────────
router.post('/password-reset/request', async (req, res, next) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    if (!email || !email.includes('@')) {
      return res.status(400).json({ error: 'email_required' });
    }

    // Rate limit — двойной слой:
    //   email — анти-спам конкретного TG-юзера (в боте получит 3 ссылки макс
    //           за 15 мин)
    //   IP    — анти-distributed-spam (один IP не может рассылать reset на
    //           произвольные email). Считаем даже для несуществующих email,
    //           чтобы не было тайминг-канала «есть/нет почты».
    const ip = clientIp(req);
    if (!resetByEmail.hit(email) || (ip && !resetByIp.hit(ip))) {
      return res.status(429).json({ error: 'too_many_requests' });
    }

    const u = await pool.query(
      `SELECT id, name, tg_user_id, tg_chat_id, gender
         FROM saas_meta.users
        WHERE lower(email) = $1 AND is_active = true`,
      [email]
    );
    const user = u.rows[0];

    // Защита от enumeration: если юзера нет — отвечаем «delivery: tg_if_linked»
    // как будто отправили (псевдоуспех). Реальной отправки не будет, токен не
    // создаётся. Пользователь, у которого почта правильная, увидит сообщение
    // в TG; чужой — ничего и не должен.
    //
    // ОДНАКО для случая, когда юзер ЕСТЬ, но TG не привязан, мы отдаём
    // отдельный код 'no_channel' — иначе человек бесконечно будет ждать
    // сообщение, которое никогда не придёт. Это ослабляет enumeration-защиту,
    // но в b2b-сегменте детейлинга важнее не залочить пользователя.
    if (!user) {
      return res.json({ ok: true, delivery: 'tg_if_linked' });
    }
    if (!user.tg_user_id || !user.tg_chat_id) {
      return res.json({ ok: true, delivery: 'no_channel' });
    }

    // Старые незаюзанные токены этого юзера — выпиливаем, чтобы один email
    // не мог сгенерить лавину живых токенов.
    await pool.query(
      `DELETE FROM saas_meta.password_reset_tokens
        WHERE user_id = $1 AND consumed_at IS NULL`,
      [user.id]
    );

    const token = crypto.randomBytes(32).toString('base64url');
    await pool.query(
      `INSERT INTO saas_meta.password_reset_tokens
         (token, user_id, expires_at, delivery, request_ip, user_agent)
       VALUES ($1, $2, now() + interval '30 minutes', 'telegram', $3, $4)`,
      [token, user.id, clientIp(req), req.headers['user-agent'] || null]
    );

    const url = `${appOrigin(req)}/reset?token=${encodeURIComponent(token)}`;

    // Сообщение в TG. Шлём с тревожным тоном «если не вы — игнорируйте»,
    // чтобы при попытке злоумышленника человек был предупреждён.
    await tgClient.sendMessage({
      chatId: user.tg_chat_id,
      userId: user.id,
      kind: 'password_reset',
      text: applyGender(
        `🔐 Забыл{а} пароль? Бывает)\n\n` +
        `Держи ссылку, чтобы придумать новый:\n` +
        `${url}\n\n` +
        `Ссылка работает ровно 30 минут, потом «сгорит».\n\n` +
        `Если это был{/а} не ты — просто игнорируй сообщение. ` +
        `Твой текущий пароль в безопасности, без перехода по ссылке ничего не поменяется.`,
        user.gender
      ),
      parseMode: 'HTML',
    });

    res.json({ ok: true, delivery: 'tg' });
  } catch (err) {
    next(err);
  }
});

// ──────────────────────────────────────────────────────────────────────
// POST /api/auth/password-reset/confirm
// Body: { token, newPassword }
//
// Меняет пароль, сжигает токен, инвалидирует все сессии (на случай если
// злоумышленник сидит в активной сессии — пусть выкинет), создаёт новую
// сессию для текущего клиента.
// ──────────────────────────────────────────────────────────────────────
router.post('/password-reset/confirm', async (req, res, next) => {
  try {
    const { token, newPassword } = req.body || {};
    if (typeof token !== 'string' || !token) {
      return res.status(400).json({ error: 'token_required' });
    }
    if (typeof newPassword !== 'string') {
      return res.status(400).json({ error: 'new_password_required' });
    }
    // Слабый пароль — отклоняем ДО открытия транзакции и расхода токена.
    try {
      assertStrongPassword(newPassword);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }

    // Транзакция: проверка токена + смена пароля + consume + чтение user-row
    // под одной блокировкой. Любой throw внутри withTx → автоматический ROLLBACK.
    // OneTimeTokenError ловим ниже и мапим на 400 с конкретным reason.
    const user = await withTx(async (client) => {
      const tokenRow = await consumeOneTimeToken(
        client,
        'saas_meta.password_reset_tokens',
        token,
        { columns: ['user_id'] }
      );

      const newHash = await hashPassword(newPassword);
      await client.query(
        `UPDATE saas_meta.users SET password_hash = $1 WHERE id = $2`,
        [newHash, tokenRow.user_id]
      );
      await client.query(
        `UPDATE saas_meta.password_reset_tokens SET consumed_at = now() WHERE token = $1`,
        [token]
      );

      // studio + schema нужны чтобы создать сессию ниже (post-commit).
      const u = await client.query(
        `SELECT u.id, u.studio_id, s.schema_name, u.tg_chat_id, u.gender
           FROM saas_meta.users u
           JOIN saas_meta.studios s ON s.id = u.studio_id
          WHERE u.id = $1`,
        [tokenRow.user_id]
      );
      return u.rows[0] || null;
    });

    if (!user) return res.status(404).json({ error: 'user_not_found' });

    // Post-commit: снести все сессии (на случай если злоумышленник сидит
    // в активной сессии) и сразу выдать свежую этому браузеру.
    await invalidateAllUserSessions(user.id);
    const session = await createSession({
      userId:     user.id,
      studioId:   user.studio_id,
      schemaName: user.schema_name,
      userAgent:  req.headers['user-agent'] || null,
      ip:         clientIp(req),
    });
    setSessionCookie(res, session.token, session.expiresAt);

    // Уведомление в TG: «пароль изменён». Если не вы — поддержка.
    if (user.tg_chat_id) {
      tgClient.sendMessage({
        chatId: user.tg_chat_id,
        userId: user.id,
        kind: 'password_changed',
        text: applyGender(
          `Пароль от Детейл Про СРМ успешно изменен 🔐\n\n` +
          `Если это твоих рук дело — супер, новый пароль уже работает.\n` +
          `Если ты ничего не менял{а} — бей тревогу и срочно пиши в поддержку, будем защищать аккаунт!`,
          user.gender
        ),
      }).catch(() => {});
    }

    res.json({ ok: true });
  } catch (err) {
    if (err instanceof OneTimeTokenError) {
      // invalid → 'invalid_token', used → 'token_used', expired → 'token_expired'
      const map = { invalid: 'invalid_token', used: 'token_used', expired: 'token_expired' };
      return res.status(400).json({ error: map[err.reason] || 'invalid_token' });
    }
    next(err);
  }
});

// ──────────────────────────────────────────────────────────────────────
// GET /api/auth/tg-signup-token?token=...
//
// Валидатор для фронта: при заходе на /signup?tg=<token> страница дёргает
// этот эндпоинт и показывает бейдж «Telegram @username будет подключён»
// (или скрывает его, если токен протух/невалиден). Сам токен НЕ списывается
// здесь — consume происходит атомарно в createStudio при успешном signup.
//
// Возвращаем:
//   200 { valid: true,  tg_username: 'foo' | null }
//   200 { valid: false, reason: 'expired' | 'used' | 'unknown' }
// Не отдаём 4xx — фронту легче работать с однотипным 200.
// ──────────────────────────────────────────────────────────────────────
router.get('/tg-signup-token', async (req, res, next) => {
  try {
    const token = String(req.query?.token || '').trim();
    if (!token || token.length < 16 || token.length > 200) {
      return res.json({ valid: false, reason: 'unknown' });
    }
    const r = await pool.query(
      `SELECT tg_username, expires_at, consumed_at
         FROM saas_meta.tg_signup_tokens
        WHERE token = $1`,
      [token]
    );
    const row = r.rows[0];
    if (!row) return res.json({ valid: false, reason: 'unknown' });
    if (row.consumed_at) return res.json({ valid: false, reason: 'used' });
    if (new Date(row.expires_at).getTime() < Date.now()) {
      return res.json({ valid: false, reason: 'expired' });
    }
    return res.json({ valid: true, tg_username: row.tg_username || null });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
