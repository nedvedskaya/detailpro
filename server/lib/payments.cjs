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

const PLAN_PAYFORM_URL = {
  solo_month:   'https://payform.ru/dablmR1/',
  solo_year:    'https://payform.ru/goblmSQ/',
  studio_month: 'https://payform.ru/jqblmUt/',
  studio_year:  'https://payform.ru/moblmW2/',
};

const PLAN_LABELS_RU = {
  solo_month:   { tariff: 'Соло',   period: '1\u00a0мес',  priceRub: 4900 },
  solo_year:    { tariff: 'Соло',   period: '12\u00a0мес', priceRub: 49900 },
  studio_month: { tariff: 'Студия', period: '1\u00a0мес',  priceRub: 8900 },
  studio_year:  { tariff: 'Студия', period: '12\u00a0мес', priceRub: 89900 },
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
  const bonusKop = Math.min(bonusAvailable, maxBonusUse);
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
 * Собирает полный URL payform.ru с подставленными параметрами.
 *   `_param_intent` — токен из createPaymentIntent
 *   `_param_plan`   — id плана (для аудита и резолва в webhook'е)
 *   `customer_email` — заполнит чекаут (UX), на security не влияет
 *   `_param_bonus_kop` + `customer_price` — если бонусы > 0
 */
function buildPayformUrl({ planId, intentToken, bonusKop, finalAmountKop, customerEmail }) {
  const base = PLAN_PAYFORM_URL[planId];
  if (!base) throw new Error('plan_invalid');
  const u = new URL(base);
  u.searchParams.set('_param_intent', intentToken);
  u.searchParams.set('_param_plan', planId);
  if (customerEmail) u.searchParams.set('customer_email', customerEmail);
  if (bonusKop > 0) {
    u.searchParams.set('_param_bonus_kop', String(bonusKop));
    // Prodamus принимает целые ₽ — округляем вверх, чтобы не уйти в минус
    // от копеечного остатка после применения бонусов.
    u.searchParams.set('customer_price', String(Math.ceil(finalAmountKop / 100)));
  }
  return u.toString();
}

module.exports = {
  PLAN_PRICES_KOP,
  PLAN_PAYFORM_URL,
  PLAN_LABELS_RU,
  VALID_PLAN_IDS,
  PAYMENT_INTENT_TTL_MS,
  createPaymentIntent,
  buildPayformUrl,
};
