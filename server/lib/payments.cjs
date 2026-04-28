'use strict';

/**
 * Общая логика выпуска payment_intent'ов и сборки payform-URL'ов.
 *
 * Используется из:
 *   • POST /api/profile/payment/intent — фронт ProfilePage сам строит URL,
 *     ему хватает только { token, bonus, finalAmount }.
 *   • GET  /api/profile/payment/from-tg — переход из бота. Эндпоинт сам
 *     создаёт intent + собирает полный payform-URL и делает 302-редирект.
 *
 * До этого всё лежало в profile.cjs одной кучей. Вынесли, чтобы бот мог
 * пройти ровно ту же intent-аутентификацию, что и SPA — без дублирования
 * SQL-кода и без legacy-path с непроверенным studio_id в URL.
 */

const crypto = require('node:crypto');
const { pool } = require('./db.cjs');

// План → форма Prodamus + цена. Должны совпадать с TARIFF_GROUPS на фронте
// (ProfilePage.tsx). Если разойдутся — webhook увидит discrepancy в
// expected_amount_kop и залогирует.
const PLAN_PRICES_KOP = {
  solo_month:   490000,
  solo_year:   4990000,
  studio_month: 890000,
  studio_year: 8990000,
};

// Базовый URL платёжной страницы Prodamus (dynamic-режим).
// До 28.04.2026 использовали статичные paylink-формы (payform.ru/<slug>/),
// но они НЕ принимают discount_value. Поддержка Prodamus подтвердила:
// «запрос формировать не к уже сформированной ссылке, а к платежной
// странице — https://yalokontent.payform.ru/». Товар (имя, цена,
// скидка) описывается динамически через products[0][...] и discount_value.
const PAYFORM_BASE_URL = 'https://yalokontent.payform.ru/';

const PLAN_LABELS_RU = {
  solo_month:   { tariff: 'Соло',   period: '1\u00a0мес',  priceRub: 4900, productName: 'Детейл Про CRM — Соло (1 месяц)' },
  solo_year:    { tariff: 'Соло',   period: '12\u00a0мес', priceRub: 49900, productName: 'Детейл Про CRM — Соло (12 месяцев)' },
  studio_month: { tariff: 'Студия', period: '1\u00a0мес',  priceRub: 8900, productName: 'Детейл Про CRM — Студия (1 месяц)' },
  studio_year:  { tariff: 'Студия', period: '12\u00a0мес', priceRub: 89900, productName: 'Детейл Про CRM — Студия (12 месяцев)' },
};

const VALID_PLAN_IDS = Object.keys(PLAN_PRICES_KOP);

const PAYMENT_INTENT_TTL_MS = 60 * 60 * 1000; // 60 минут

/**
 * Создаёт payment_intent под указанную студию + план + пользователя.
 * Возвращает { token, expiresAt, expectedKop, bonusKop, finalAmountKop }.
 *
 * Бонусы считаются автоматически из bonus_balance_kop студии (min с
 * `price − 1₽`, чтобы Prodamus не упёрся в нулевую сумму). Если у студии
 * нет баланса — bonusKop=0, finalAmountKop = expectedKop.
 *
 * Throws:
 *   • Error('plan_invalid') — неизвестный planId.
 *   • Error('studio_not_found') — нет такой студии.
 */
async function createPaymentIntent({ studioId, userId, planId, ip = null, userAgent = null }) {
  if (!VALID_PLAN_IDS.includes(planId)) {
    const e = new Error('plan_invalid');
    e.code = 'plan_invalid';
    throw e;
  }
  const sRes = await pool.query(
    `SELECT bonus_balance_kop FROM saas_meta.studios WHERE id = $1`,
    [studioId]
  );
  if (sRes.rowCount === 0) {
    const e = new Error('studio_not_found');
    e.code = 'studio_not_found';
    throw e;
  }
  const bonusAvailable = Number(sRes.rows[0].bonus_balance_kop) || 0;
  const expectedKop = PLAN_PRICES_KOP[planId];
  // -1 ₽ = 100 коп. См. profile.cjs#calcBonusUsage и комментарий там же.
  const maxBonusUse = Math.max(0, expectedKop - 100);
  const bonusKopRaw = Math.min(bonusAvailable, maxBonusUse);
  // Prodamus принимает discount_value в ЦЕЛЫХ рублях (по их инструкции:
  // https://help.prodamus.ru/payform/integracii/rest-api/...). Чтобы наш
  // внутренний учёт (bonusKop в копейках, см. webhook bonus_kop debit)
  // совпадал ровно с тем, что мы заявили Prodamus как скидку — округляем
  // bonusKop ВНИЗ до ближайшего рубля. Без этого юзер с бонусом 4899,50 ₽
  // получил бы скидку 4899 ₽ на payform, но при списании мы бы дебетнули
  // 4899,50 ₽ — копеечный mismatch в логах. Floor вместо ceil — чтобы
  // никогда не пытаться списать больше, чем фактическая скидка на чеке.
  const bonusKop = Math.floor(bonusKopRaw / 100) * 100;
  const finalAmountKop = expectedKop - bonusKop;

  const token = crypto.randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + PAYMENT_INTENT_TTL_MS);

  await pool.query(
    `INSERT INTO saas_meta.payment_intents
       (token, studio_id, user_id, plan_id, expected_amount_kop, bonus_kop,
        expires_at, created_ip, user_agent)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [token, studioId, userId, planId, expectedKop, bonusKop, expiresAt, ip, userAgent]
  );

  return { token, expiresAt, expectedKop, bonusKop, finalAmountKop };
}

/**
 * Собирает полный URL Prodamus payform-а в DYNAMIC-режиме (платёжная
 * страница вместо paylink-формы). Параметры:
 *
 *   products[0][name|price|quantity] — товар описывается в URL целиком
 *                                       (раньше был зашит в paylink-форме)
 *   discount_value                   — размер скидки в ЦЕЛЫХ рублях
 *   _param_intent / _param_plan      — наши custom-поля для webhook'а
 *   _param_bonus_kop                 — наш counter в копейках для debit
 *   customer_email                   — префилл email-а
 *   order_id                         — наш уникальный id заказа
 *
 * Источник изменения: 28.04.2026 поддержка Prodamus подтвердила что
 * paylink-формы не принимают discount_value, нужно использовать
 * базовый URL https://yalokontent.payform.ru/ и описывать товар в
 * параметрах. До этого юзер видел полную цену независимо от скидки.
 */
function buildPayformUrl({ planId, intentToken, bonusKop, finalAmountKop, customerEmail }) {
  const expectedKop = PLAN_PRICES_KOP[planId];
  const label = PLAN_LABELS_RU[planId];
  if (!expectedKop || !label) throw new Error('plan_invalid');
  const u = new URL(PAYFORM_BASE_URL);

  // sys — обязательный параметр Prodamus, идентифицирует витрину/
  // интеграцию. Без него платёжная страница открывается пустой
  // (товар не привязан к магазину). Согласован с поддержкой Prodamus
  // 28.04.2026: для нашего аккаунта sys = 'yalokontent'.
  u.searchParams.set('sys', 'yalokontent');

  // Описываем товар в URL. Цена в рублях, как требует Prodamus.
  // products[0][...] — синтаксис, который Express/PHP-style парсеры
  // на стороне Prodamus распарсят как массив объектов.
  u.searchParams.set('products[0][name]',     label.productName);
  u.searchParams.set('products[0][price]',    String(expectedKop / 100));
  u.searchParams.set('products[0][quantity]', '1');

  // Наш сквозной order_id — производный от intent-token: уникальный, но
  // компактный. Webhook возвращает его обратно, мы сверяем по
  // payment_intents.token (через _param_intent — он несёт полный токен).
  u.searchParams.set('order_id', `dpro-${intentToken.slice(0, 16)}`);

  // Наши custom-поля для webhook-аудита.
  u.searchParams.set('_param_intent', intentToken);
  u.searchParams.set('_param_plan',   planId);
  if (customerEmail) u.searchParams.set('customer_email', customerEmail);

  if (bonusKop > 0) {
    u.searchParams.set('_param_bonus_kop', String(bonusKop));
    // bonusKop гарантированно кратен 100 (createPaymentIntent делает floor),
    // деление целочисленное → точная сумма скидки в рублях.
    u.searchParams.set('discount_value', String(bonusKop / 100));
  }

  return u.toString();
}

module.exports = {
  PLAN_PRICES_KOP,
  PAYFORM_BASE_URL,
  PLAN_LABELS_RU,
  VALID_PLAN_IDS,
  PAYMENT_INTENT_TTL_MS,
  createPaymentIntent,
  buildPayformUrl,
};
