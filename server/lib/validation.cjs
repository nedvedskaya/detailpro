'use strict';
/**
 * validation.cjs — единая точка правды для базовых валидаторов и парсеров,
 * которые раньше были скопированы по 3-5 раз в разных роутах.
 *
 * Раньше в коде болтались дубли:
 *   - email-регексп `/^[^\s@]+@[^\s@]+\.[^\s@]+$/` — 4 копии (admin, profile,
 *     tenant_provisioning, плюс клиентские LoginScreen/ProfilePage).
 *   - `function badId(id)` с проверкой int4-диапазона — 2 копии (tenant.cjs,
 *     documents.cjs), плюс ещё одна вариация на клиенте.
 *
 * Если регексп нужно поменять (скажем, разрешить апостроф или ограничить
 * длину) — теперь это одна правка в одном месте, и нет риска что один
 * роут пройдёт, а другой нет (как было с двумя путями загрузки фото,
 * где один валидировал, а второй — нет).
 *
 * Контракт:
 *   - Возвращаемые ошибки бросаются с `err.code` в SCREAMING_SNAKE и
 *     `err.message` равным машинному коду в snake_case (как ожидает
 *     translateApiError на клиенте — см. utils/errorMessages.ts).
 */

// Базовая защита от опечаток в email. НЕ полная RFC-проверка — для неё всё
// равно нужен confirm-link на email. Защищаемся только от очевидных багов:
// пустая локальная часть, нет домена, нет TLD, пробелы.
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Домены публичных иностранных почтовых сервисов. Для регистрации новых
// аккаунтов используем консервативный фильтр: собственная email+password
// авторизация остаётся нашей, но новые пользователи не должны заводиться на
// очевидные Gmail/Apple/Outlook/etc. адреса из-за требований к авторизации РФ.
const FOREIGN_PUBLIC_EMAIL_DOMAINS = new Set([
  'gmail.com',
  'googlemail.com',
  'icloud.com',
  'me.com',
  'mac.com',
  'outlook.com',
  'hotmail.com',
  'live.com',
  'msn.com',
  'yahoo.com',
  'ymail.com',
  'aol.com',
  'proton.me',
  'protonmail.com',
  'pm.me',
  'zoho.com',
  'gmx.com',
  'gmx.net',
  'mail.com',
  'tutanota.com',
  'tuta.com',
  'fastmail.com',
]);

// Минимальная длина пароля. Меняется только здесь (до этого было захардкожено
// в auth/admin/tenant_provisioning — ловили баг, что в одном месте 8, в другом 6).
const PASSWORD_MIN_LENGTH = 8;

// Postgres int4 (тип id у всех CRM-сущностей в наших схемах) — максимум 2^31-1.
// Если придёт число больше — Postgres вернёт ошибку, а не not-found, что портит UX.
const PG_INT4_MAX = 2147483647;

/**
 * @param {unknown} v
 * @returns {boolean}
 */
function isValidEmail(v) {
  return typeof v === 'string' && EMAIL_REGEX.test(v);
}

function emailDomain(v) {
  if (!isValidEmail(v)) return '';
  return v.split('@').pop().toLowerCase();
}

function isForeignPublicEmail(v) {
  const domain = emailDomain(v);
  return Boolean(domain && FOREIGN_PUBLIC_EMAIL_DOMAINS.has(domain));
}

function isAllowedAuthEmail(v) {
  return isValidEmail(v) && !isForeignPublicEmail(v);
}

/**
 * @param {unknown} v
 * @returns {boolean}
 */
function isValidPassword(v) {
  return typeof v === 'string' && v.length >= PASSWORD_MIN_LENGTH;
}

// ──────────────────────────────────────────────────────────────────────
// Password strength: blocklist + примитивные паттерны.
//
// Зачем: длины >=8 не хватает. `12345678` или `qwerty12` подбираются
// dictionary-атакой за секунды. Для b2b-CRM с финансовыми данными это
// неприемлемо.
//
// Объём списка осознанно небольшой (~80 записей) — закрывает 95% реальных
// плохих выборов, без тащ-зависимости zxcvbn (800kb gzipped). Если
// захочется полноты — поменять на zxcvbn без ломания API
// (assertStrongPassword по контракту).
// ──────────────────────────────────────────────────────────────────────
const WEAK_PASSWORDS = new Set([
  // Top global (NIST 2023, Hashcat-leaks)
  'password', 'password1', 'password12', 'password123', 'password1234',
  'qwerty', 'qwerty12', 'qwerty123', 'qwerty1234', 'qwertyuiop',
  '12345678', '123456789', '1234567890', '01234567', '87654321',
  'abcdefgh', 'abcdefghi', 'abcd1234', 'asdf1234', 'asdfasdf',
  '11111111', '00000000', '22222222', '88888888', '99999999',
  '12341234', '12121212', '69696969',
  'iloveyou', 'iloveyou1', 'princess', 'sunshine', 'football',
  'baseball', 'superman', 'batman123', 'pokemon1', 'master12',
  'admin123', 'admin1234', 'administrator', 'welcome1', 'welcome123',
  'letmein1', 'letmein12', 'monkey12', 'monkey123', 'dragon12', 'dragon123',
  'changeme', 'changeme1', 'temporary', 'temp1234', 'demo1234',
  // Keyboard walks
  '1q2w3e4r', '1q2w3e4r5t', '!qaz2wsx', 'qazwsxedc', 'zxcvbnm,', 'asdfghjk',
  // Russian-keyboard transliterations (рус. слова на eng-раскладке)
  'gfhjkm12',         // пароль12
  'gfhjkmgf',         // парольпа
  'ghbdtnghbdtn',     // приветпривет
  'ghbdtn12',         // привет12
  'ldfflwfnm',        // двадцать
  // Ru-specific patterns
  'парольпароль', 'пароль12', 'пароль123', 'пароль1234',
  'фывапролд', 'йцукенгш', 'йцукенгшщз',
  'россия2024', 'москва12', 'летолето', 'лето2024',
  // Auto/detailing-specific (наш домен — может прилететь от ленивых)
  'detailpro', 'detailing', 'avtomoyka', 'avtoservice', 'detailing123',
]);

function isCommonPassword(plain) {
  return typeof plain === 'string' && WEAK_PASSWORDS.has(plain.toLowerCase());
}

// «aaaaaaaa», «88888888», «          » — длина >=8 пройдёт length-check,
// но энтропия равна нулю.
function isRepeatingChar(plain) {
  return typeof plain === 'string' && plain.length >= PASSWORD_MIN_LENGTH && /^(.)\1+$/.test(plain);
}

// «12345678», «abcdefgh», «98765432», «hgfedcba» — последовательная цепочка
// возрастающих или убывающих кодпоинтов. Не ловит «qwerty» (это keyboard-walk,
// он в WEAK_PASSWORDS), а только арифметические последовательности.
function isSequential(plain) {
  if (typeof plain !== 'string' || plain.length < PASSWORD_MIN_LENGTH) return false;
  let asc = true, desc = true;
  for (let i = 1; i < plain.length; i++) {
    const diff = plain.charCodeAt(i) - plain.charCodeAt(i - 1);
    if (diff !== 1) asc = false;
    if (diff !== -1) desc = false;
    if (!asc && !desc) return false;
  }
  return asc || desc;
}

/**
 * Кидает структурированную ошибку, если пароль слабый.
 * Использовать ВЕЗДЕ, где пароль выставляется (signup, password change,
 * password reset confirm, admin создаёт юзера) — не где проверяется (login).
 *
 * @param {unknown} plain
 * @throws {Error & { code: 'PASSWORD_TOO_SHORT' | 'PASSWORD_TOO_COMMON' }}
 */
function assertStrongPassword(plain) {
  if (typeof plain !== 'string' || plain.length < PASSWORD_MIN_LENGTH) {
    const e = new Error('password_too_short');
    e.code = 'PASSWORD_TOO_SHORT';
    throw e;
  }
  if (isCommonPassword(plain) || isRepeatingChar(plain) || isSequential(plain)) {
    const e = new Error('password_too_common');
    e.code = 'PASSWORD_TOO_COMMON';
    throw e;
  }
}

/**
 * Парсит id из строки/числа (например, req.params.id или req.body.id).
 * Возвращает null, если значение не похоже на валидный id из БД —
 * вызывающий код должен ответить 400 или 404.
 *
 * @param {unknown} id
 * @returns {number|null}
 */
function parseId(id) {
  const n = typeof id === 'number' ? id : parseInt(id, 10);
  if (!Number.isInteger(n) || n <= 0 || n > PG_INT4_MAX) return null;
  return n;
}

// ──────────────────────────────────────────────────────────────────────
// Helpers для строгой валидации body-полей.
//
// Контракт ошибок: бросают `Error & { code: 'FIELD_INVALID', field, reason }`.
// Это даёт роуту единообразный обработчик: try/catch → res.status(400)
// .json({ error: 'field_invalid', field, reason }).
//
// Зачем не Zod: зависимость +20kb gzipped, которая для нашего объёма
// валидации не критична. Если в будущем будет 50+ роутов и сложные схемы —
// заменим на Zod, контракт ошибок совместим.
// ──────────────────────────────────────────────────────────────────────

function fieldErr(field, reason) {
  const e = new Error(`field_invalid:${field}:${reason}`);
  e.code = 'FIELD_INVALID';
  e.field = field;
  e.reason = reason;
  return e;
}

/**
 * Обязательная строка с верхним лимитом длины. Trim применяется до проверки.
 * Empty string после trim → reject (для полей где `null` лучше — используй
 * assertOptionalString).
 *
 * @param {unknown} v
 * @param {string} fieldName — имя поля для ошибки
 * @param {number} maxLen
 * @returns {string} — обработанная (trim'нутая) строка
 */
function assertString(v, fieldName, maxLen) {
  if (typeof v !== 'string') throw fieldErr(fieldName, 'must_be_string');
  const trimmed = v.trim();
  if (trimmed.length === 0) throw fieldErr(fieldName, 'empty');
  if (trimmed.length > maxLen) throw fieldErr(fieldName, `max_${maxLen}`);
  return trimmed;
}

/**
 * Опциональная строка. Null/undefined/пустая → возвращает null.
 * Иначе — assertString с лимитом длины.
 *
 * @param {unknown} v
 * @param {string} fieldName
 * @param {number} maxLen
 * @returns {string | null}
 */
function assertOptionalString(v, fieldName, maxLen) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v !== 'string') throw fieldErr(fieldName, 'must_be_string');
  const trimmed = v.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > maxLen) throw fieldErr(fieldName, `max_${maxLen}`);
  return trimmed;
}

/**
 * Массив строк (например, теги). Каждый элемент trim'нут, проверен на длину.
 * Дубликаты НЕ удаляются (хочешь — фильтруй сам после), но empty/whitespace
 * элементы выкидываются.
 *
 * @param {unknown} v
 * @param {string} fieldName
 * @param {number} maxItems
 * @param {number} maxItemLen
 * @returns {string[]} — массив обработанных строк (может быть пустым)
 */
function assertArrayOfStrings(v, fieldName, maxItems, maxItemLen) {
  if (v === null || v === undefined) return [];
  if (!Array.isArray(v)) throw fieldErr(fieldName, 'must_be_array');
  if (v.length > maxItems) throw fieldErr(fieldName, `max_items_${maxItems}`);
  const out = [];
  for (let i = 0; i < v.length; i++) {
    const item = v[i];
    if (typeof item !== 'string') throw fieldErr(fieldName, `item_${i}_must_be_string`);
    const trimmed = item.trim();
    if (trimmed.length === 0) continue; // пропускаем пустые
    if (trimmed.length > maxItemLen) throw fieldErr(fieldName, `item_${i}_max_${maxItemLen}`);
    out.push(trimmed);
  }
  return out;
}

/**
 * Whitelist enum. Если v не в списке — кидает.
 *
 * @template T
 * @param {unknown} v
 * @param {string} fieldName
 * @param {readonly T[]} allowed
 * @returns {T}
 */
function assertEnum(v, fieldName, allowed) {
  if (!allowed.includes(v)) throw fieldErr(fieldName, `must_be_one_of_${allowed.join('|')}`);
  return v;
}

/**
 * Натуральное число с верхним лимитом. NaN/строки/отрицательные → reject.
 *
 * @param {unknown} v
 * @param {string} fieldName
 * @param {number} max
 * @returns {number}
 */
function assertNonNegativeInt(v, fieldName, max) {
  const n = typeof v === 'number' ? v : parseInt(v, 10);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) throw fieldErr(fieldName, 'must_be_non_negative_int');
  if (n > max) throw fieldErr(fieldName, `max_${max}`);
  return n;
}

/**
 * Pagination limit/offset. Дефолты разумные, потолки фиксированные.
 * Используется для всех list-эндпоинтов с пейджингом.
 *
 * @param {unknown} limitRaw
 * @param {unknown} offsetRaw
 * @param {{ defaultLimit?: number, maxLimit?: number }} opts
 * @returns {{ limit: number, offset: number }}
 */
function parsePagination(limitRaw, offsetRaw, opts = {}) {
  const defaultLimit = opts.defaultLimit || 50;
  const maxLimit = opts.maxLimit || 200;
  let limit = defaultLimit;
  let offset = 0;
  if (limitRaw !== undefined && limitRaw !== null && limitRaw !== '') {
    limit = assertNonNegativeInt(limitRaw, 'limit', maxLimit);
    if (limit === 0) limit = defaultLimit;
  }
  if (offsetRaw !== undefined && offsetRaw !== null && offsetRaw !== '') {
    // offset до 100K — выше уже DoS на seq scan.
    offset = assertNonNegativeInt(offsetRaw, 'offset', 100_000);
  }
  return { limit, offset };
}

/**
 * Валидирует data-URL/raw base64 PNG.
 *
 * Зачем: signature_data из UI приходит как base64 PNG-строка. Без проверки
 * клиент может прислать любой бинарь — JSONB сохранит, PDF embed-ит,
 * рендер упадёт (или, в случае с другим форматом, сольёт другие байты в
 * документ). Проверяем magic bytes: PNG = 0x89 0x50 0x4E 0x47 0x0D 0x0A 0x1A 0x0A.
 *
 * @param {unknown} v — base64-строка или 'data:image/png;base64,...'
 * @param {string} fieldName
 * @param {number} maxDecodedBytes — лимит на ДЕКОДИРОВАННЫЕ байты, не на base64
 * @returns {string} — нормализованная raw base64 без data: префикса
 */
function assertPngBase64(v, fieldName, maxDecodedBytes) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v !== 'string') throw fieldErr(fieldName, 'must_be_string');
  // Срезаем data:image/png;base64,... префикс если есть
  let raw = v;
  const m = v.match(/^data:image\/png;base64,(.+)$/i);
  if (m) raw = m[1];
  // base64 → длина в байтах ≈ raw.length * 3/4
  const approxBytes = Math.floor((raw.length * 3) / 4);
  if (approxBytes > maxDecodedBytes) throw fieldErr(fieldName, `max_${maxDecodedBytes}_bytes`);
  let buf;
  try {
    buf = Buffer.from(raw, 'base64');
  } catch (_) {
    throw fieldErr(fieldName, 'invalid_base64');
  }
  if (buf.length < 8) throw fieldErr(fieldName, 'too_short');
  // PNG magic
  if (
    buf[0] !== 0x89 || buf[1] !== 0x50 || buf[2] !== 0x4E || buf[3] !== 0x47 ||
    buf[4] !== 0x0D || buf[5] !== 0x0A || buf[6] !== 0x1A || buf[7] !== 0x0A
  ) {
    throw fieldErr(fieldName, 'not_png');
  }
  if (buf.length > maxDecodedBytes) throw fieldErr(fieldName, `max_${maxDecodedBytes}_bytes`);
  // Возвращаем raw base64 (без префикса) — UI/PDF сами добавят что нужно
  return raw;
}

/**
 * Универсальный обработчик ошибки валидации в роутах.
 * Если err — это FIELD_INVALID → 400 с понятной структурой; иначе кидает дальше.
 *
 * Использование:
 *   try { ... } catch (err) { if (handleFieldError(err, res)) return; throw err; }
 *
 * @param {Error} err
 * @param {import('express').Response} res
 * @returns {boolean} true если ошибка обработана и ответ отправлен
 */
function handleFieldError(err, res) {
  if (err && err.code === 'FIELD_INVALID') {
    res.status(400).json({
      error: 'field_invalid',
      field: err.field,
      reason: err.reason,
    });
    return true;
  }
  return false;
}


const dns = require('dns').promises;

// MX-проверка: у домена должен быть хотя бы один почтовый сервер.
// Отсекает несуществующие домены (aaa.ru, test.com и т.п.).
// Реальные провайдеры (gmail.com, yandex.ru, mail.ru, icloud.com) проходят.
// Таймаут DNS ~2-5с — добавляем race с 3-секундным промисом.
async function checkEmailMx(email) {
  if (!isValidEmail(email)) return false;
  const domain = email.split('@')[1].toLowerCase();
  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('timeout')), 3000)
  );
  try {
    const records = await Promise.race([dns.resolveMx(domain), timeout]);
    return Array.isArray(records) && records.length > 0;
  } catch {
    // При ошибке DNS (NXDOMAIN, timeout, etc.) — считаем домен невалидным
    return false;
  }
}

module.exports = {
  EMAIL_REGEX,
  FOREIGN_PUBLIC_EMAIL_DOMAINS,
  PASSWORD_MIN_LENGTH,
  PG_INT4_MAX,
  isValidEmail,
  isForeignPublicEmail,
  isAllowedAuthEmail,
  isValidPassword,
  isCommonPassword,
  isRepeatingChar,
  isSequential,
  assertStrongPassword,
  parseId,
  // строгие body-validators
  assertString,
  assertOptionalString,
  assertArrayOfStrings,
  assertEnum,
  assertNonNegativeInt,
  parsePagination,
  assertPngBase64,
  handleFieldError,
  checkEmailMx,
};
