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
    // Не блокирующее: помечаем «студия активна сегодня» для воронки прогрева.
    // Throttled внутри funnel.cjs до 1 раза в 5 мин, чтоб не дёргать БД на каждый запрос.
    try {
      const { touchLastActive } = require('./funnel.cjs');
      void touchLastActive(session.studioId);
    } catch (_) { /* funnel-хуки не должны влиять на auth */ }
    next();
  } catch (err) {
    next(err);
  }
}

// ──────────────────────────────────────────────────────────────────────
// requireActiveStudio
//   - is_active=false → 403 (студия отключена админом)
//   - access_until <= now() → 402 (подписка истекла → hard lock)
//
// Whitelist «работает всегда» делается на уровне routing'а в app.cjs:
// /api/auth, /api/profile, /api/webhooks, /api/telegram НЕ используют
// requireActiveStudio. Поэтому юзер с истёкшей подпиской может:
//   • войти/восстановить пароль (auth)
//   • открыть свой профиль и посмотреть тарифы (profile)
//   • заплатить через Prodamus (webhook прилетит → активация)
// Но не может: создать клиента, провести бронь, выписать наряд и т.п.
// (роуты tenant/documents/admin под requireActiveStudio).
//
// Раньше тут был «мягкий режим»: 402 не отдавали никогда. Это создавало
// дыру в воронке прогрева — бот пишет «доступ закрыт», а UI работает
// как ни в чём не бывало, и у юзера нет стимула платить. Возвращён hard lock.
//
// Для роли master/manager результат тот же 402 — раньше переживали,
// что менеджер не сможет работать, пока owner оплачивает; на практике
// «нет подписки = вся студия не работает» — корректное бизнес-поведение.
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
    if (studio.access_until && new Date(studio.access_until).getTime() <= Date.now()) {
      // Подписка/триал истёк. Фронт ловит 402 и показывает LockScreen
      // с CTA «Перейти к тарифам» (см. client/src/utils/api.ts handleResponse).
      return res.status(402).json({
        error: 'subscription_expired',
        plan: studio.plan,
        access_until: studio.access_until,
      });
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
// sectionGuard(section, minLevel)
//   Проверяет доступ к разделу CRM через JSON-поле permissions в сессии.
//   section: 'clients' | 'tasks' | 'calendar' | 'finance'
//   minLevel: 'view' | 'edit'
//
//   Если permissions=null — фолбэк на роль + can_view_finance (обратная
//   совместимость со старыми пользователями без JSON permissions).
// ──────────────────────────────────────────────────────────────────────
const _LEVEL_RANK = { none: 0, view: 1, edit: 2 };

function _resolveSection(session, section) {
  if (session.role === 'owner') return 'edit';
  const perms = session.permissions;
  if (perms && typeof perms[section] === 'string') return perms[section];
  // Фолбэк: роль + can_view_finance
  if (session.role === 'manager') {
    if (section === 'finance') return session.canViewFinance !== false ? 'edit' : 'none';
    return 'edit';
  }
  if (session.role === 'master') {
    if (section === 'finance') return 'none';
    if (section === 'tasks') return 'edit';
    return 'view'; // clients, calendar
  }
  return 'none';
}

function sectionGuard(section, minLevel) {
  return function (req, res, next) {
    if (!req.session) return res.status(401).json({ error: 'unauthenticated' });
    const actual = _resolveSection(req.session, section);
    if ((_LEVEL_RANK[actual] || 0) >= (_LEVEL_RANK[minLevel] || 0)) return next();
    return res.status(403).json({ error: 'forbidden' });
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

// ──────────────────────────────────────────────────────────────────────
// gateOwner(row, res, errorCode)
//   Хелпер для хендлеров, которые сами делают SELECT с ролью + другими
//   полями (план, студия, prodamus_*) и не могут заменить проверку
//   на простой requireRole-middleware.
//
//   Возвращает true, если row существует и row.role === 'owner';
//   иначе пишет 404/403 в res и возвращает false. Вызывающий проверяет
//   результат и делает return.
//
//   Заменяет 6 inline-копий шаблона:
//     if (!row) return res.status(404).json({ error: ERR.USER_NOT_FOUND });
//     if (row.role !== 'owner') {
//       return res.status(403).json({ error: ERR.ONLY_OWNER_CAN_X });
//     }
// ──────────────────────────────────────────────────────────────────────
const { ERR } = require('./errorCodes.cjs');

function gateOwner(row, res, errorCode) {
  if (!row) {
    res.status(404).json({ error: ERR.USER_NOT_FOUND });
    return false;
  }
  if (row.role !== 'owner') {
    res.status(403).json({ error: errorCode });
    return false;
  }
  return true;
}


module.exports = {
  requireAuth,
  gateOwner,
  requireActiveStudio,
  requireRole,
  requireNotMaster,
  sectionGuard,
  readSessionCookie, // экспортируем для тестов
  SESSION_COOKIE_NAME,
};
