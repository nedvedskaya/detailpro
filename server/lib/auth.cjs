'use strict';
/**
 * Аутентификация: scrypt-пароли + sessions-таблица.
 *
 * Почему sessions, а не JWT:
 *   JWT нельзя инвалидировать до истечения срока без отдельной denylist-таблицы
 *   (что превращает JWT в те же sessions, только сложнее). Для SaaS критично:
 *     - logout пользователя
 *     - смена пароля → разлогинить везде
 *     - отмена подписки → мгновенно отрубить все сессии студии
 *     - админский kill-switch на скомпрометированную студию
 *   Sessions-таблица даёт это одним DELETE.
 *
 * Формат пароля: '<scryptHashHex>.<saltHex>' (64 hex hash + 32 hex salt).
 *   Совпадает с алгоритмом из существующего CRM (Crm-new-main/server/index.cjs:265),
 *   что позволит позже мигрировать пользователей напрямую без сброса пароля.
 *
 * Token сессии: 32 байта crypto.randomBytes → base64url. 256 бит энтропии,
 *   неугадываемо. Хранится в БД как plain — брутфорс 2^256 нереалистичен,
 *   а сравнение по PRIMARY KEY быстрее, чем по hash. Альтернатива — sha256(token),
 *   но это даст защиту только от утечки полной БД, а от такой утечки
 *   сильнее помогает шифрование на уровне диска / encrypted backups.
 */

const crypto = require('node:crypto');
const { pool } = require('./db.cjs');
const { assertStrongPassword } = require('./validation.cjs');

const SCRYPT_KEY_LEN = 64;        // 64 байта = 128 hex-символов на выходе
const SALT_LEN = 16;              // 16 байт = 32 hex-символа
const SESSION_TOKEN_BYTES = 32;   // 256 бит энтропии

// SESSION_TTL берём из env при каждом createSession, чтобы можно было
// поменять без рестарта (для security-инцидентов).
function sessionTtlMs() {
  const hours = Number(process.env.SESSION_TTL_HOURS) || 720; // 30 дней по умолчанию
  return hours * 60 * 60 * 1000;
}

// Idle-timeout: сессия мертва, если ей не пользовались дольше N часов,
// даже если absolute TTL ещё не истёк. Защита от украденной cookie:
// злоумышленник без активного юзера всё равно потеряет сессию через 14 дней.
// Активный юзер своё last_used_at двигает каждым запросом — для него
// эффективного ограничения нет.
function sessionIdleMs() {
  const hours = Number(process.env.SESSION_IDLE_HOURS) || 14 * 24; // 14 дней
  return hours * 60 * 60 * 1000;
}

// ──────────────────────────────────────────────────────────────────────
// Пароли
// ──────────────────────────────────────────────────────────────────────

function scryptAsync(plain, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(plain, salt, SCRYPT_KEY_LEN, (err, derivedKey) => {
      if (err) reject(err);
      else resolve(derivedKey);
    });
  });
}

/**
 * Хэширует пароль. Возвращает строку '<hashHex>.<saltHex>'.
 * @param {string} plain
 * @returns {Promise<string>}
 */
async function hashPassword(plain) {
  // Единая точка проверки силы пароля. Кидает PASSWORD_TOO_SHORT (длина <8)
  // или PASSWORD_TOO_COMMON (blocklist / repeating / sequential). Все ветки,
  // где пароль реально сохраняется в БД (signup, change, reset, admin-create
  // user), идут через эту функцию — поэтому проверка здесь = единая точка.
  assertStrongPassword(plain);
  // ВАЖНО: соль передаётся в scrypt как HEX-СТРОКА, а не как Buffer.
  // Crm-new-main делает именно так (server/index.cjs:266-268), и нам нужна
  // бинарная совместимость для миграции существующих хешей. Если передать
  // Buffer (decode hex) — scrypt получит другие байты → другой хеш → пароль
  // не пройдёт verify. Тест на совместимость см. в verifyPassword().
  const saltHex = crypto.randomBytes(SALT_LEN).toString('hex');
  const hash = await scryptAsync(plain, saltHex);
  return hash.toString('hex') + '.' + saltHex;
}

/**
 * Проверяет пароль. Использует timingSafeEqual (постоянное время сравнения).
 * @param {string} plain
 * @param {string} stored — формат '<hashHex>.<saltHex>'
 * @returns {Promise<boolean>}
 */
async function verifyPassword(plain, stored) {
  if (typeof plain !== 'string' || typeof stored !== 'string') return false;
  const dot = stored.indexOf('.');
  if (dot < 1 || dot >= stored.length - 1) return false;

  const hashHex = stored.slice(0, dot);
  const saltHex = stored.slice(dot + 1);

  let storedHash;
  try {
    storedHash = Buffer.from(hashHex, 'hex');
  } catch (_) {
    return false;
  }
  if (storedHash.length !== SCRYPT_KEY_LEN) return false;

  // Соль передаётся в scrypt как HEX-СТРОКА (бинарная совместимость
  // с Crm-new-main/server/index.cjs:271-275). См. комментарий в hashPassword.
  const candidateHash = await scryptAsync(plain, saltHex);
  // timingSafeEqual требует буферов одинаковой длины
  if (candidateHash.length !== storedHash.length) return false;
  return crypto.timingSafeEqual(candidateHash, storedHash);
}

// ──────────────────────────────────────────────────────────────────────
// Сессии
// ──────────────────────────────────────────────────────────────────────

/**
 * Создаёт сессию в saas_meta.sessions.
 * @param {object} ctx
 * @param {string} ctx.userId
 * @param {string} ctx.studioId
 * @param {string} ctx.schemaName
 * @param {string} [ctx.userAgent]
 * @param {string} [ctx.ip]
 * @returns {Promise<{ token: string, expiresAt: Date }>}
 */
async function createSession({ userId, studioId, schemaName, userAgent, ip }) {
  const token = crypto.randomBytes(SESSION_TOKEN_BYTES).toString('base64url');
  const expiresAt = new Date(Date.now() + sessionTtlMs());

  await pool.query(
    `INSERT INTO saas_meta.sessions
       (token, user_id, studio_id, schema_name, expires_at, user_agent, ip)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [token, userId, studioId, schemaName, expiresAt, userAgent || null, ip || null]
  );

  return { token, expiresAt };
}

/**
 * Проверяет сессию. Если живая — возвращает контекст и обновляет last_used_at.
 * Если истекла — удаляет и возвращает null.
 * @param {string} token
 * @returns {Promise<null | { userId, studioId, schemaName, role, userName, canViewFinance }>}
 */
async function verifySession(token) {
  if (typeof token !== 'string' || !token) return null;

  // JOIN с users, чтобы взять role/name/can_view_finance одной поездкой в БД.
  // userName и canViewFinance пробрасываем дальше: первое — в audit-лог
  // (entity user_name), второе — в гейт «manager без финансов» в tenant.cjs.
  const { rows } = await pool.query(
    `SELECT s.user_id, s.studio_id, s.schema_name, s.expires_at, s.last_used_at,
            u.role, u.is_active, u.name, u.can_view_finance
       FROM saas_meta.sessions s
       JOIN saas_meta.users u ON u.id = s.user_id
      WHERE s.token = $1`,
    [token]
  );
  const row = rows[0];
  if (!row) return null;

  if (!row.is_active) {
    // юзер отключён — снести сессию для чистоты
    await pool.query('DELETE FROM saas_meta.sessions WHERE token = $1', [token]);
    return null;
  }

  // Absolute TTL (expires_at) — жёсткий потолок.
  if (new Date(row.expires_at).getTime() <= Date.now()) {
    await pool.query('DELETE FROM saas_meta.sessions WHERE token = $1', [token]);
    return null;
  }

  // Idle TTL: если last_used_at старше idle-окна — считаем сессию мёртвой.
  // Защита от давно украденной/забытой cookie: даже если absolute TTL = 30 дней,
  // неактивная сессия живёт максимум sessionIdleMs (по дефолту 14 дней).
  const lastUsedMs = row.last_used_at ? new Date(row.last_used_at).getTime() : 0;
  if (lastUsedMs && Date.now() - lastUsedMs > sessionIdleMs()) {
    await pool.query('DELETE FROM saas_meta.sessions WHERE token = $1', [token]);
    return null;
  }

  // обновляем last_used_at без await на ответ — не блокируем запрос пользователя
  pool.query(
    'UPDATE saas_meta.sessions SET last_used_at = now() WHERE token = $1',
    [token]
  ).catch((err) => console.error('[auth] last_used_at update failed:', err.message));

  return {
    userId: row.user_id,
    studioId: row.studio_id,
    schemaName: row.schema_name,
    role: row.role,
    userName: row.name || null,
    // Если миграция 003 ещё не накатилась — поле undefined: тогда трактуем
    // как «по умолчанию видит» (true), чтобы не блокнуть существующих юзеров.
    canViewFinance: row.can_view_finance !== false,
  };
}

/**
 * Удаляет одну сессию (logout).
 */
async function invalidateSession(token) {
  if (!token) return;
  await pool.query('DELETE FROM saas_meta.sessions WHERE token = $1', [token]);
}

/**
 * Удаляет все сессии конкретного пользователя (смена пароля).
 */
async function invalidateAllUserSessions(userId) {
  await pool.query('DELETE FROM saas_meta.sessions WHERE user_id = $1', [userId]);
}

/**
 * Удаляет все сессии всех пользователей студии (отмена подписки, kill-switch).
 */
async function invalidateAllStudioSessions(studioId) {
  await pool.query('DELETE FROM saas_meta.sessions WHERE studio_id = $1', [studioId]);
}

/**
 * Чистка протухших сессий. Запускать по cron раз в сутки.
 * Дропает: (а) absolute-TTL истёкшие, (б) idle-TTL истёкшие.
 */
async function cleanupExpiredSessions() {
  const idleHours = Number(process.env.SESSION_IDLE_HOURS) || 14 * 24;
  const { rowCount } = await pool.query(
    `DELETE FROM saas_meta.sessions
       WHERE expires_at <= now()
          OR last_used_at < now() - ($1::int || ' hours')::interval`,
    [idleHours]
  );
  return rowCount;
}

module.exports = {
  hashPassword,
  verifyPassword,
  createSession,
  verifySession,
  invalidateSession,
  invalidateAllUserSessions,
  invalidateAllStudioSessions,
  cleanupExpiredSessions,
};
