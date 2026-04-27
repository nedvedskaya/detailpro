'use strict';
/**
 * webhook_signing.cjs — изолированная криптография подписей для входящих
 * webhook'ов от платёжных провайдеров.
 *
 * Зачем отдельный модуль:
 *   1. Тестируемость. Подпись — это чистая функция (payload, secret) → hex.
 *      Когда она лежит в роуте webhooks.cjs, её сложно проверить unit-тестом
 *      без поднятия Express/pool. В отдельном модуле — `node --test` на ней.
 *   2. Множество провайдеров. Сейчас один (Продамус). Когда добавим второй
 *      (ЮKassa, Stripe), будет очевидно куда класть его HMAC — рядом с
 *      verifySignatureProdamus, а не размазывать по роуту.
 *   3. Аудит безопасности. Когда вся крипта в одном месте, easier to verify
 *      что timing-safe-comparison стоит везде, что secret не логируется,
 *      что нигде нет fallback на «без подписи».
 *
 * ВАЖНО: Эти функции НЕ принимают raw-body в качестве payload — они работают
 * с уже распарсенным JS-объектом. Парсинг (urlencoded или JSON) — задача
 * caller-а, потому что зависит от Content-Type входящего запроса.
 */

const crypto = require('node:crypto');

/**
 * Рекурсивная сортировка ключей объекта по алфавиту. Массивы — порядок
 * сохраняется (Продамус не пересортировывает массивы в своём PHP-Hmac).
 *
 * Экспортируется ТОЛЬКО для тестов. В прод-коде использовать готовые
 * verifySignature*-функции, не вызывать deepSort напрямую.
 *
 * @param {unknown} value
 * @returns {unknown}
 */
function deepSort(value) {
  if (Array.isArray(value)) {
    return value.map(deepSort);
  }
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    const out = {};
    for (const k of keys) out[k] = deepSort(value[k]);
    return out;
  }
  return value;
}

/**
 * Подпись Продамуса (порт PHP `Hmac::create`):
 *   1. Удаляем поля signature/sign из тела (если они там)
 *   2. deepSort
 *   3. JSON.stringify (без escape unicode/слешей — JS делает это by default,
 *      аналог JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES в PHP)
 *   4. HMAC-SHA256, hex
 *
 * @param {object} payload — уже распарсенный объект из тела запроса
 * @param {string} secret — PRODAMUS_SECRET_KEY
 * @returns {string} hex-подпись (lowercase, 64 chars)
 */
function prodamusHmac(payload, secret) {
  const cleaned = { ...payload };
  delete cleaned.signature;
  delete cleaned.sign;
  const sorted = deepSort(cleaned);
  const json = JSON.stringify(sorted);
  return crypto.createHmac('sha256', secret).update(json, 'utf8').digest('hex');
}

/**
 * Проверка входящей подписи Продамуса timing-safe-сравнением.
 *
 * Возвращает строго boolean — caller не должен раскрывать, ПОЧЕМУ не сошлось
 * (нет секрета / нет заголовка / mismatch); во всех случаях ответ для
 * атакующего одинаковый — 401 без detail.
 *
 * @param {object} payload — уже распарсенное тело запроса
 * @param {unknown} headerSign — значение заголовка Sign (или поля signature
 *   из тела, если провайдер прислал её inline)
 * @param {string|undefined} secret — PRODAMUS_SECRET_KEY
 * @returns {boolean}
 */
function verifySignatureProdamus(payload, headerSign, secret) {
  if (!secret) return false;
  if (typeof headerSign !== 'string' || !headerSign) return false;

  const expected = prodamusHmac(payload, secret);
  // Длины должны совпадать ДО timingSafeEqual — иначе Buffer-ы разной длины
  // бросят, утечёт early-exit timing.
  if (expected.length !== headerSign.length) return false;
  try {
    return crypto.timingSafeEqual(
      Buffer.from(expected, 'utf8'),
      Buffer.from(headerSign, 'utf8'),
    );
  } catch (_) {
    return false;
  }
}

module.exports = {
  // Public API — используется в роутах
  verifySignatureProdamus,
  // Internals — экспортируются для unit-тестов и на случай если caller хочет
  // вычислить свою же подпись (например для логирования / диагностики).
  prodamusHmac,
  deepSort,
};
