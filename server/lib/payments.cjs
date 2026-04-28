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
    `SELECT bonus_balance_kop, plan, access_until, cancel_pending
       FROM saas_meta.studios WHERE id = $1`,
    [studioId]
  );
  if (sRes.rowCount === 0) {
    const e = new Error('studio_not_found');
    e.code = 'studio_not_found';
    throw e;
  }
  const studio = sRes.rows[0];
  const bonusAvailable = Number(studio.bonus_balance_kop) || 0;
  const expectedKop = PLAN_PRICES_KOP[planId];

  // ── Pro-rata upgrade Соло → Студия (в рамках одного периода) ──
  // Если у студии активен Соло и она хочет купить Студия того же периода,
  // зачитываем стоимость неиспользованных дней Соло. Зачёт уходит в
  // Prodamus как часть discount_value (вместе с bonus_kop).
  //
  // Кросс-period (solo_month → studio_year или solo_year → studio_month) —
  // НЕ зачитываем, потому что период разный и пересчёт сложен. Фронт
  // в этом случае не должен показывать кнопку upgrade.
  //
  // Direction: только Соло → Студия. Студия → Соло (downgrade) не
  // поддерживается — фронт прячет кнопки Соло для studio-плательщиков.
  let proratedCreditKop = 0;
  let isUpgrade = false;
  const newPeriod = planId.endsWith('_year') ? 'year' : 'month';
  const newTier = planId.startsWith('studio') ? 'studio' : 'solo';
  if (
    studio.plan === 'solo' &&
    newTier === 'studio' &&
    !studio.cancel_pending &&
    studio.access_until &&
    new Date(studio.access_until).getTime() > Date.now()
  ) {
    // Определяем точный текущий план (solo_month vs solo_year) из последней
    // успешной оплаты — нужен и для цены, и для проверки совпадения периода.
    const lastPayRes = await pool.query(
      `SELECT plan FROM saas_meta.payments
        WHERE studio_id = $1 AND status = 'paid' AND plan IS NOT NULL
        ORDER BY processed_at DESC NULLS LAST, received_at DESC
        LIMIT 1`,
      [studioId]
    );
    const currentPlanId = lastPayRes.rows[0]?.plan;
    const currentPeriod = currentPlanId && currentPlanId.endsWith('_year') ? 'year' : 'month';
    // Зачёт делаем ТОЛЬКО при совпадении периода (solo_month → studio_month
    // или solo_year → studio_year). Кросс-period апгрейды требуют отдельной
    // бизнес-логики (что делать с длинным остатком при коротком новом периоде).
    if (currentPlanId && PLAN_PRICES_KOP[currentPlanId] && currentPeriod === newPeriod) {
      const currentPriceKop = PLAN_PRICES_KOP[currentPlanId];
      const totalDays = currentPeriod === 'year' ? 365 : 30;
      const remainingMs = new Date(studio.access_until).getTime() - Date.now();
      const remainingDays = Math.max(0, Math.ceil(remainingMs / (24 * 3600 * 1000)));
      const cappedDays = Math.min(remainingDays, totalDays);
      // Зачёт в копейках, округляем ВНИЗ до целого рубля — та же логика, что
      // и для bonus_kop: discount_value в Prodamus передаётся в целых рублях,
      // а наш внутренний учёт должен ровно сходиться с тем, что заявлено.
      const raw = Math.floor((currentPriceKop * cappedDays) / totalDays);
      proratedCreditKop = Math.floor(raw / 100) * 100;
      isUpgrade = proratedCreditKop > 0;
    }
  }

  // Минимальная сумма к оплате — 50 ₽ (5000 коп). Жёсткое ограничение
  // Prodamus: при сумме < 50 ₽ платёжная страница отвечает «Сумма не может
  // быть меньше 50.00 ₽». Скидку (бонус + pro-rated) обрезаем сверху так,
  // чтобы итог был не ниже 50 ₽. Остаток бонуса остаётся на балансе.
  const MIN_PAYABLE_KOP = 5000;
  const maxDiscountKop = Math.max(0, expectedKop - MIN_PAYABLE_KOP);
  // Pro-rated credit имеет приоритет: его нельзя «потерять», т.к. он
  // отражает уже оплаченный пользователем период. Бонус — то, чем мы
  // готовы пожертвовать для соблюдения min 50 ₽.
  const proratedFinal = Math.min(proratedCreditKop, maxDiscountKop);
  const remainingDiscountRoom = maxDiscountKop - proratedFinal;
  const bonusKopRaw = Math.min(bonusAvailable, remainingDiscountRoom);
  const bonusKop = Math.floor(bonusKopRaw / 100) * 100;

  const totalDiscountKop = bonusKop + proratedFinal;
  const finalAmountKop = expectedKop - totalDiscountKop;

  const token = crypto.randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + PAYMENT_INTENT_TTL_MS);

  await pool.query(
    `INSERT INTO saas_meta.payment_intents
       (token, studio_id, user_id, plan_id, expected_amount_kop, bonus_kop,
        is_upgrade, prorated_credit_kop,
        expires_at, created_ip, user_agent)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [token, studioId, userId, planId, expectedKop, bonusKop,
     isUpgrade, proratedFinal,
     expiresAt, ip, userAgent]
  );

  return {
    token, expiresAt, expectedKop, bonusKop, finalAmountKop,
    proratedCreditKop: proratedFinal, isUpgrade,
  };
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
function buildPayformUrl({ planId, intentToken, bonusKop, finalAmountKop, customerEmail, proratedCreditKop = 0 }) {
  const expectedKop = PLAN_PRICES_KOP[planId];
  const label = PLAN_LABELS_RU[planId];
  if (!expectedKop || !label) throw new Error('plan_invalid');
  const u = new URL(PAYFORM_BASE_URL);

  // sys — обязательный параметр Prodamus, идентифицирует витрину/
  // интеграцию. Без него платёжная страница открывается пустой
  // (товар не привязан к магазину). Согласован с поддержкой Prodamus
  // 28.04.2026: для нашего аккаунта sys = 'yalokontent'.
  u.searchParams.set('sys', 'yalokontent');

  // do=pay — обязательный параметр для прямого открытия платёжной
  // страницы. Без него Prodamus показывает витрину с дефолтным товаром
  // из настроек, игнорируя products[0][...] из URL. По их инструкции:
  // do = 'link' (вернуть ссылку через REST) | 'pay' (открыть форму).
  u.searchParams.set('do', 'pay');

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

  // discount_value передаётся в Prodamus как СУММА бонусов и pro-rated
  // зачёта от Соло (если это апгрейд). _param_bonus_kop несёт ТОЛЬКО
  // бонусы — webhook по нему дебетует bonus_balance_kop. _param_prorated_kop
  // отдельно — он не должен быть зачислен куда-то обратно как реферал-бонус
  // при возврате (это деньги пользователя, уже оплаченные за Соло).
  const totalDiscountKop = bonusKop + proratedCreditKop;
  if (bonusKop > 0) {
    u.searchParams.set('_param_bonus_kop', String(bonusKop));
  }
  if (proratedCreditKop > 0) {
    u.searchParams.set('_param_prorated_kop', String(proratedCreditKop));
  }
  if (totalDiscountKop > 0) {
    // Кратность 100 (целые рубли) гарантирована createPaymentIntent через
    // Math.floor(.../100)*100 для обеих компонент.
    u.searchParams.set('discount_value', String(totalDiscountKop / 100));
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
