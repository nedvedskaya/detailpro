'use strict';
/**
 * #4 Anti-SQLi: валидация и safe-quoting имени схемы клиента.
 *
 * Schema-per-tenant модель означает, что имя схемы вставляется в SQL
 * как идентификатор (НЕ как значение, НЕ через $1). Параметризация
 * Postgres не работает для идентификаторов — поэтому единственная
 * защита — строгая валидация + явное двойное цитирование.
 *
 * Контракт:
 *   - Имя должно быть [a-z][a-z0-9_]{2,31} (от 3 до 32 символов).
 *   - Не пересекается с системными и зарезервированными именами.
 *   - Не начинается с pg_ (системные схемы).
 *   - Не равно saas_meta (служебная схема SaaS-уровня).
 *
 * Использование:
 *   const { safeIdent } = require('./tenant');
 *   const schema = safeIdent(req.session.schema_name);
 *   await pg.query(`SELECT * FROM ${schema}.clients WHERE id = $1`, [id]);
 *
 * НИКОГДА не делайте: `SELECT * FROM ${rawSchemaName}.clients`.
 * ВСЕГДА: `SELECT * FROM ${safeIdent(schemaName)}.clients`.
 */

const SCHEMA_NAME_REGEX = /^[a-z][a-z0-9_]{2,31}$/;

const RESERVED_SCHEMAS = new Set([
  'public',
  'information_schema',
  'pg_catalog',
  'pg_toast',
  'pg_temp',
  'saas_meta',     // наша служебная — клиентские схемы не могут так называться
]);

/**
 * Проверяет имя схемы. Бросает Error с кодом, если невалидно.
 * @param {string} name
 * @returns {string} оригинальное (валидированное) имя
 */
function validateSchemaName(name) {
  if (typeof name !== 'string' || !name) {
    const err = new Error('schema_name_required');
    err.code = 'SCHEMA_NAME_REQUIRED';
    throw err;
  }
  if (!SCHEMA_NAME_REGEX.test(name)) {
    const err = new Error(
      'schema_name_invalid: must match [a-z][a-z0-9_]{2,31}, got ' + JSON.stringify(name)
    );
    err.code = 'SCHEMA_NAME_INVALID';
    throw err;
  }
  if (RESERVED_SCHEMAS.has(name) || name.startsWith('pg_')) {
    const err = new Error('schema_name_reserved: ' + name);
    err.code = 'SCHEMA_NAME_RESERVED';
    throw err;
  }
  return name;
}

/**
 * Возвращает безопасный quoted-identifier для интерполяции в SQL.
 * Делает двойное цитирование (на всякий случай — после валидации внутри `"` нет).
 * @param {string} name
 * @returns {string} `"studio_42"`
 */
function safeIdent(name) {
  const v = validateSchemaName(name);
  // Дополнительная защита: даже если регекс вдруг изменится, экранируем кавычки.
  return '"' + v.replace(/"/g, '""') + '"';
}

/**
 * Транслитерация русской кириллицы в латиницу для имён схем.
 * Имя схемы должно быть `[a-z][a-z0-9_]{2,31}` — кириллица напрямую не подходит,
 * без транслита все русские названия схлопывались в одну заглушку `studio_`,
 * что вызывало 409 schema_name_taken на втором signup.
 *
 * Стандарт — упрощённый «GOST R 7.0.34-2014» (наиболее частый для имён файлов
 * и URL-слугов): «ё»→`yo`, «ж»→`zh`, «ю»→`yu`, «я»→`ya`, «щ»→`shch`, и т.д.
 */
const CYRILLIC_MAP = {
  а: 'a',  б: 'b',  в: 'v',  г: 'g',  д: 'd',  е: 'e',  ё: 'yo',
  ж: 'zh', з: 'z',  и: 'i',  й: 'i',  к: 'k',  л: 'l',  м: 'm',
  н: 'n',  о: 'o',  п: 'p',  р: 'r',  с: 's',  т: 't',  у: 'u',
  ф: 'f',  х: 'h',  ц: 'c',  ч: 'ch', ш: 'sh', щ: 'shch',
  ъ: '',   ы: 'y',  ь: '',   э: 'e',  ю: 'yu', я: 'ya',
};

function transliterate(input) {
  return input.toLowerCase().split('').map((ch) => CYRILLIC_MAP[ch] ?? ch).join('');
}

/**
 * Генерирует кандидатное имя схемы из произвольной строки (например, названия студии).
 * НЕ использовать напрямую как имя — пропустить через validateSchemaName и проверить
 * уникальность через `saas_meta.studios.schema_name`.
 *
 * Алгоритм:
 *   1. Кириллица → латиница (транслит).
 *   2. Не-ASCII символы → `_`.
 *   3. Если итог не начинается с буквы — префикс `studio_`.
 *   4. Если после всех чисток слаг пустой/слишком короткий — добавляем
 *      случайный суффикс из 8 hex-символов. Это страхует от коллизий имён
 *      на чисто символьных названиях вроде «❤️ My Studio».
 *
 * @param {string} input
 * @returns {string|null} кандидат или null если совсем не получилось
 */
function suggestSchemaName(input) {
  if (typeof input !== 'string') return null;
  let s = transliterate(input)
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '');

  // После транслита и чистки остался пустой слаг или меньше 2 alphanum
  // символов — значит, исходное имя состояло почти полностью из эмоджи/символов.
  // Подставляем случайный суффикс, чтобы schema_name был валиден и уникален.
  const alnumCount = (s.match(/[a-z0-9]/g) || []).length;
  if (alnumCount < 2) {
    const rnd = Math.random().toString(16).slice(2, 10); // 8 hex-символов
    s = s ? (s + '_' + rnd) : rnd;
  }

  if (!/^[a-z]/.test(s)) s = 'studio_' + s;
  s = s.slice(0, 32);
  if (!SCHEMA_NAME_REGEX.test(s)) return null;
  if (RESERVED_SCHEMAS.has(s)) return null;
  return s;
}

module.exports = {
  SCHEMA_NAME_REGEX,
  RESERVED_SCHEMAS,
  validateSchemaName,
  safeIdent,
  suggestSchemaName,
};
