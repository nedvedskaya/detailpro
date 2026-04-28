'use strict';
/**
 * Универсальный парсер опциональных строковых полей из request body.
 *
 * Раньше функция `takeOptionalString` была дважды продублирована inline
 * в profile.cjs (PATCH /api/profile и PATCH /api/profile/studio).
 * Логика идентична — выносим в общий helper.
 *
 * Семантика:
 *   • Поле отсутствует в body  → ничего не делаем (PATCH-семантика).
 *   • Поле = null или ''       → устанавливаем DB-поле в NULL.
 *   • Поле — строка        → trim + проверка длины + сохранение.
 *   • Поле — не-строка        → бросает Error с .status = 400 и
 *                                 сообщением `${key}_must_be_string`.
 *   • Слишком длинное поле     → бросает Error с .status = 400 и
 *                                 сообщением `${key}_too_long`.
 *
 * Использование (мутирует переданный fields-объект):
 *   const fields = {};
 *   takeOptionalString(req.body, fields, 'firstName', 'first_name', 100);
 *   takeOptionalString(req.body, fields, 'phone',     'phone',      40);
 *   ...
 *   if (Object.keys(fields).length === 0) return res.status(400).json(...);
 *   const setClauses = Object.keys(fields).map((k, i) => `${k}=$${i+1}`);
 */
function takeOptionalString(body, fields, key, dbField, maxLen = 100) {
  if (!Object.prototype.hasOwnProperty.call(body, key)) return;
  const raw = body[key];
  if (raw === null || raw === '') {
    fields[dbField] = null;
    return;
  }
  if (typeof raw !== 'string') {
    const e = new Error(`${key}_must_be_string`);
    e.status = 400;
    throw e;
  }
  const trimmed = raw.trim();
  if (trimmed.length > maxLen) {
    const e = new Error(`${key}_too_long`);
    e.status = 400;
    throw e;
  }
  fields[dbField] = trimmed;
}

module.exports = { takeOptionalString };
