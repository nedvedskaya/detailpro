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

module.exports = {
  EMAIL_REGEX,
  PASSWORD_MIN_LENGTH,
  PG_INT4_MAX,
  isValidEmail,
  isValidPassword,
  isCommonPassword,
  isRepeatingChar,
  isSequential,
  assertStrongPassword,
  parseId,
};
