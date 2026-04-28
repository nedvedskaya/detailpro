'use strict';
/**
 * Webhook Продамуса: подтверждения оплаты подписки студии.
 *
 * Контракт:
 *   POST /api/webhooks/prodamus
 *   Body: application/x-www-form-urlencoded (Продамус по-умолчанию)
 *   Header: Sign — HMAC-SHA256 в hex
 *
 * АЛГОРИТМ ПОДПИСИ ПРОДАМУСА (важно — он специфичный):
 *   1. Парсим тело как form-urlencoded в плоский объект
 *   2. Убираем поле `signature` (если оно лежит в теле, а не в заголовке)
 *   3. РЕКУРСИВНО сортируем ключи (ksort/SORT_STRING в их PHP-SDK)
 *   4. JSON.stringify с флагами JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES
 *      (в Node это значит: НЕ escape-им юникод и слеши вручную)
 *   5. HMAC-SHA256 от этой строки в hex
 *
 *   Источник: их официальный PHP SDK Hmac::create:
 *   https://github.com/Prodamus/Hmac.php
 *
 *   Простой HMAC от raw-байт (как было в первой версии) НЕ работает —
 *   подпись Продамуса собирается на уровне массива, не строки.
 *
 * Идемпотентность:
 *   UNIQUE(order_id) в saas_meta.payments. Тот же webhook второй раз →
 *   ON CONFLICT DO NOTHING → 200, no-op. Продамус ретраит при не-200.
 *
 * Лог:
 *   Каждый запрос — в saas_meta.webhook_log (включая невалидную подпись).
 *
 * Маппинг плана:
 *   В URL платформы передаём `_param_studio_id=<uuid>` и `_param_plan=solo_month|
 *   solo_year|studio_month|studio_year`. Продамус возвращает их в webhook
 *   как обычные поля. Из плана выводим:
 *     - длительность (30 / 365 дней)
 *     - запись в studios.plan: solo / studio (без _month|_year)
 */

const express = require('express');
const { pool, withTx } = require('../lib/db.cjs');
const tg = require('../lib/telegram.cjs');
const { securityLog, SEVERITY } = require('../lib/security_log.cjs');
const { verifySignatureProdamus } = require('../lib/webhook_signing.cjs');
const { formatRub, formatDateRu } = require('../lib/formatting.cjs');

const router = express.Router();

// ──────────────────────────────────────────────────────────────────────
// Подтверждение оплаты в Telegram владельцу студии.
//
// Вызывается ПОСЛЕ коммита транзакции в webhook'е — чтобы в БД уже стоял
// обновлённый access_until/plan и мы могли его прочитать. Best-effort:
// любая ошибка (нет привязки TG, упал API, etc.) логируется, но webhook
// возвращает 200 — иначе Prodamus будет ретраить, мы будем дублировать
// SMS, и в БД из-за UNIQUE(order_id) ничего не изменится.
//
// Какому юзеру шлём:
//   Только owner'у студии. Менеджеры/мастера не должны получать инфу
//   о биллинге — это выходит за их зону ответственности и шумит.
//   Если у owner'а не привязан TG — молча скипаем (kind в логе всё равно
//   запишется через sendMessage, но без chat_id даже не вызовется TG API).
//
// Что пишем:
//   - Бренд + сумма + тариф (на каком плане теперь и до какого числа)
//   - Если был использован бонус — отдельной строкой «применено N ₽ бонусов»
//   - Если оплата «после отмены» (paid_after_cancel) — пишем другой текст:
//     деньги не пропали, но access не продлили; пусть пользователь решает.
//   - Без сухой формулировки «успешно завершен» — нашему юзеру важно сразу
//     видеть «доступ до DD.MM.YYYY», а не «спасибо за покупку».
// ──────────────────────────────────────────────────────────────────────

// Маппинг внутреннего plan'а в человеческое название тарифа для сообщения.
const PLAN_RU = {
  solo: 'Соло',
  studio: 'Студия',
};

// Период тарифа в человеке: solo_year → «12 месяцев», studio_month → «1 месяц».
function planPeriodRu(planId) {
  if (typeof planId !== 'string') return '';
  return planId.toLowerCase().endsWith('_year') ? '12 месяцев' : '1 месяц';
}

// formatRub / formatDateRu вынесены в server/lib/formatting.cjs —
// см. require выше. Локальные определения убраны, чтобы не было двух
// разных версий «правды» в одном проекте.

// Push-уведомление админу платформы (Оле) о любой свежей оплате чужой
// студии. Раньше она знала о платежах только из своей студии (через
// notifyOwnerOnPayment) — приходилось дёргать /платежи в боте. Теперь
// бот сам пингует на каждый paid-платёж. Идемпотентность — на стороне
// caller'а (вызываем только когда result.duplicate === false).
//
// Chat_id админа = его user_id (для приватных чатов TG они совпадают).
// Захардкожен в server/routes/telegram.cjs#ADMIN_TG_USER_ID — важно
// держать одним числом, чтобы при ротации владельца была одна точка правки.
const ADMIN_TG_CHAT_ID = '472538427';

async function notifyAdminOnPayment({ studioId, orderId, amountKop, planId, bonusKopUsed, isPaidAfterCancel }) {
  try {
    // Не дёргаем сами себя: если оплатила Олина студия, она и так
    // получила notifyOwnerOnPayment в качестве owner'а. Дублирующее
    // админ-уведомление не нужно.
    const me = await pool.query(
      `SELECT id FROM saas_meta.users
        WHERE studio_id = $1 AND tg_chat_id = $2 AND role = 'owner' LIMIT 1`,
      [studioId, ADMIN_TG_CHAT_ID]
    );
    if (me.rowCount > 0) return;

    const sRes = await pool.query(
      `SELECT s.display_name, s.schema_name,
              o.first_name, o.last_name, o.email
         FROM saas_meta.studios s
         LEFT JOIN saas_meta.users o
                ON o.studio_id = s.id AND o.role = 'owner'
        WHERE s.id = $1
        LIMIT 1`,
      [studioId]
    );
    const s = sRes.rows[0];
    if (!s) return;

    const ownerName = [s.first_name, s.last_name].filter(Boolean).join(' ').trim() || 'без имени';
    const planRu = PLAN_RU[
      typeof planId === 'string' && planId.toLowerCase().startsWith('solo') ? 'solo' : 'studio'
    ] || 'тарифа';
    const periodRu = planPeriodRu(planId);
    const sumRu = formatRub(amountKop);
    const bonusRu = bonusKopUsed > 0 ? formatRub(bonusKopUsed) : null;

    const lines = isPaidAfterCancel
      ? [
        `⚠️ Платёж после отмены`,
        ``,
        `Студия: <b>${s.display_name || s.schema_name}</b>`,
        `Владелец: ${ownerName} (${s.email || '—'})`,
        `Сумма: <b>${sumRu} ₽</b> → зачислено в бонусы пользователя`,
      ]
      : [
        `💰 Новая оплата`,
        ``,
        `Студия: <b>${s.display_name || s.schema_name}</b>`,
        `Владелец: ${ownerName} (${s.email || '—'})`,
        `Тариф: <b>${planRu}</b> · ${periodRu}`,
        `Сумма: <b>${sumRu} ₽</b>${bonusRu ? ` (бонусом ${bonusRu} ₽)` : ''}`,
      ];

    await tg.sendMessage({
      chatId: ADMIN_TG_CHAT_ID,
      kind: 'admin_payment_notify',
      text: lines.join('\n'),
      parseMode: 'HTML',
    });
  } catch (err) {
    console.error('[webhooks] notifyAdminOnPayment failed:', err.message, { studioId, orderId });
  }
}

async function notifyOwnerOnPayment({ studioId, orderId, amountKop, planId, bonusKopUsed, isPaidAfterCancel }) {
  try {
    // Берём owner'а студии с привязанным TG. Если owner один и без TG —
    // получим 0 строк, тогда просто молча скипаем.
    const ownerRes = await pool.query(
      `SELECT u.id, u.tg_chat_id, s.access_until, s.plan
         FROM saas_meta.users u
         JOIN saas_meta.studios s ON s.id = u.studio_id
        WHERE u.studio_id = $1
          AND u.role = 'owner'
          AND u.tg_chat_id IS NOT NULL
        LIMIT 1`,
      [studioId]
    );
    const owner = ownerRes.rows[0];
    if (!owner) {
      // Owner без TG — это нормально, не ошибка. Просто не шлём.
      return;
    }

    const planRu = PLAN_RU[
      // Парсим из planId: 'solo_month' → 'solo', 'studio_year' → 'studio'
      typeof planId === 'string' && planId.toLowerCase().startsWith('solo')
        ? 'solo'
        : 'studio'
    ] || 'тарифа';
    const periodRu = planPeriodRu(planId);
    const sumRu = formatRub(amountKop);
    const accessUntilRu = formatDateRu(owner.access_until);
    const bonusUsedRu = bonusKopUsed > 0 ? formatRub(bonusKopUsed) : null;

    let text;
    if (isPaidAfterCancel) {
      // Платёж пришёл после нажатия «Отменить подписку» — деньги в бонусы.
      // Здесь же — единственное место, где у нас есть chat_id и вся история,
      // не упустим возможность сразу проинформировать.
      text =
        `⚠️ Платёж пришёл после отмены подписки\n\n` +
        `Сумма ${sumRu} ₽ зачислена вам в бонус-баланс — её можно потратить ` +
        `на следующее продление или попросить возврат у поддержки.\n\n` +
        `Доступ к CRM не продлён.`;
    } else {
      const lines = [
        `✅ Оплата получена — спасибо!`,
        ``,
        `Тариф: <b>${planRu}</b> · ${periodRu}`,
        `Сумма: <b>${sumRu} ₽</b>`,
      ];
      if (bonusUsedRu) {
        lines.push(`Применено бонусов: <b>${bonusUsedRu} ₽</b>`);
      }
      lines.push(``);
      lines.push(`Доступ активен до <b>${accessUntilRu}</b>.`);
      lines.push(`Чек об оплате придёт на вашу электронную почту.`);
      text = lines.join('\n');
    }

    await tg.sendMessage({
      chatId: owner.tg_chat_id,
      userId: owner.id,
      kind: 'payment_success',
      text,
      parseMode: 'HTML',
    });
  } catch (err) {
    // Best-effort: лог в stderr, но webhook должен ответить 200.
    console.error('[webhooks] notifyOwnerOnPayment failed:', err.message, { studioId, orderId });
  }
}

const rawParser = express.raw({ type: '*/*', limit: '256kb' });

// ──────────────────────────────────────────────────────────────────────
// Парсинг form-urlencoded из Buffer.
// Поддержка вложенных ключей вида `customer[email]` (типичный для Продамуса).
// На выходе — иерархия { customer: { email: ... } }.
// ──────────────────────────────────────────────────────────────────────
function parseUrlencoded(bodyStr) {
  const out = {};
  if (!bodyStr) return out;
  const params = new URLSearchParams(bodyStr);
  for (const [rawKey, value] of params) {
    // bracket-нотация: a[b][c] → ['a','b','c']
    const path = parseKeyPath(rawKey);
    setDeep(out, path, value);
  }
  return out;
}

function parseKeyPath(key) {
  // 'a[b][c]' → ['a','b','c']
  const parts = [];
  const m = key.match(/^([^\[]+)((?:\[[^\]]*\])*)$/);
  if (!m) return [key];
  parts.push(m[1]);
  const rest = m[2];
  const re = /\[([^\]]*)\]/g;
  let g;
  while ((g = re.exec(rest)) !== null) parts.push(g[1]);
  return parts;
}

function setDeep(obj, path, value) {
  let cur = obj;
  for (let i = 0; i < path.length - 1; i++) {
    const k = path[i];
    const nextK = path[i + 1];
    // Если следующий сегмент — цифровой индекс ('0', '1', ...), родитель
    // должен быть МАССИВОМ, а не объектом. PHP-парсер у Prodamus
    // (parse_str) делает именно так: products[0][name] → array(0 => array(name=>...)).
    // При последующем json_encode без флагов получается '{"products":[{...}]}'.
    // Если тут оставить объект — JSON будет '{"products":{"0":{...}}}',
    // и HMAC-подпись не сойдётся с тем, что считает Prodamus.
    const nextIsArrayIdx = typeof nextK === 'string' && /^\d+$/.test(nextK);
    if (cur[k] == null || typeof cur[k] !== 'object') {
      cur[k] = nextIsArrayIdx ? [] : {};
    }
    cur = cur[k];
  }
  cur[path[path.length - 1]] = value;
}

function parseBody(buf, contentType) {
  const str = buf ? buf.toString('utf8') : '';
  if (!str) return {};
  const ct = (contentType || '').toLowerCase();
  if (ct.includes('application/json')) {
    try { return JSON.parse(str); } catch (_) { return {}; }
  }
  return parseUrlencoded(str);
}

// HMAC и алгоритм подписи Продамуса (port из их PHP Hmac::create) живут
// в server/lib/webhook_signing.cjs — вынесли туда чтобы было удобно
// тестировать в изоляции и расширять при появлении других провайдеров.

// ──────────────────────────────────────────────────────────────────────
// Маппинг статусов Продамуса → нашему enum в payments.status
// ──────────────────────────────────────────────────────────────────────
function mapStatus(prodamusStatus) {
  const s = (prodamusStatus || '').toLowerCase();
  if (s === 'success' || s === 'paid') return 'paid';
  if (s === 'refund' || s === 'refunded') return 'refunded';
  if (s === 'fail' || s === 'failed') return 'failed';
  return 'pending';
}

// ──────────────────────────────────────────────────────────────────────
// Парсинг идентификатора плана из payform.
//   solo_month / solo_year / studio_month / studio_year
// → { dbPlan: 'solo' | 'studio', durationDays: 30 | 365 }
// Если plan не распознан — возвращаем дефолт (30 дней, plan не меняем).
// ──────────────────────────────────────────────────────────────────────
function resolvePlan(planId) {
  if (typeof planId !== 'string') return { dbPlan: null, durationDays: 30 };
  const lc = planId.toLowerCase();
  const isYear = lc.endsWith('_year');
  const days = isYear ? 365 : 30;
  if (lc.startsWith('solo'))   return { dbPlan: 'solo',   durationDays: days };
  if (lc.startsWith('studio')) return { dbPlan: 'studio', durationDays: days };
  return { dbPlan: null, durationDays: days };
}

// ──────────────────────────────────────────────────────────────────────
// Лог webhook — отдельной транзакцией, чтобы он попал в БД даже если
// основная обработка упадёт.
// ──────────────────────────────────────────────────────────────────────
async function logWebhook({ source, ip, signatureValid, rawBody, status, errorMessage }) {
  try {
    await pool.query(
      `INSERT INTO saas_meta.webhook_log
         (source, ip, signature_valid, raw_body, response_status, error_message)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [source, ip || null, signatureValid, rawBody || '', status || null, errorMessage || null]
    );
  } catch (err) {
    console.error('[webhooks] failed to write webhook_log:', err.message);
  }
}

// ──────────────────────────────────────────────────────────────────────
// POST /api/webhooks/prodamus
// ──────────────────────────────────────────────────────────────────────
router.post('/prodamus', rawParser, async (req, res) => {
  const ip = req.ip;
  const rawBuf = req.body;
  const rawStr = rawBuf ? rawBuf.toString('utf8') : '';
  const secret = process.env.PRODAMUS_SECRET_KEY;

  // Парсим тело — оно нужно и для подписи, и для бизнес-логики
  let payload;
  try {
    payload = parseBody(rawBuf, req.headers['content-type']);
  } catch (err) {
    await logWebhook({
      source: 'prodamus', ip, signatureValid: false, rawBody: rawStr,
      status: 400, errorMessage: 'bad_body: ' + err.message,
    });
    return res.status(400).send('bad body');
  }

  // Sign бывает в разном регистре
  const headerSign =
    req.headers['sign'] ||
    req.headers['x-sign'] ||
    req.headers['signature'] ||
    payload.signature ||  // на случай если положили в тело
    '';

  const signatureValid = verifySignatureProdamus(payload, headerSign, secret);

  if (!signatureValid) {
    await logWebhook({
      source: 'prodamus', ip, signatureValid: false, rawBody: rawStr,
      status: 401, errorMessage: 'invalid_signature',
    });
    // ALERT: попытка прислать webhook с невалидной подписью. Это либо
    // кто-то сканирует за платёжными webhook'ами и пробует подобрать,
    // либо ротировали секрет, но не обновили его в Prodamus-кабинете.
    // В обоих случаях — нужно посмотреть.
    securityLog({
      event: 'webhook.signature_invalid',
      severity: SEVERITY.ALERT,
      ip,
      route: 'POST /api/webhooks/prodamus',
      meta: {
        body_size: rawStr.length,
        has_sign_header: !!headerSign,
      },
    });
    return res.status(401).send('invalid signature');
  }

  // ─── Извлечение полей. Продамус отдаёт _param_* как простые поля без префикса. ───
  // У них есть две конвенции: либо просто `studio_id` если форма передавала
  // `?_param_studio_id=...`, либо вложенно `custom_field[studio_id]`.
  // Парсер выше делает оба варианта плоскими (custom_field остаётся объектом).
  const orderId = String(payload.order_id || payload.order_num || payload.id || '').trim();
  const sumStr = String(payload.sum || payload.amount || '0').replace(',', '.');
  const sum = Number(sumStr);
  const currency = String(payload.currency || 'RUB').toUpperCase();
  const status = mapStatus(payload.payment_status || payload.status);

  // studio_id и plan ищем в трёх местах: top-level, custom_field, вложенный объект
  const customFields = (payload.custom_field && typeof payload.custom_field === 'object')
    ? payload.custom_field
    : {};

  // ─── INTENT-VERIFIED studio_id ─────────────────────────────────────
  // С миграции 011 фронт получает intent через POST /api/profile/payment/intent
  // и подставляет его в URL Prodamus как `_param_intent`. studio_id берём
  // ИЗ INTENT'а (доверенный, выпущен под req.session при оплате), а не из
  // payload — иначе атакующий мог поменять `_param_studio_id` в URL и
  // привязать оплату к чужой студии (см. комментарий миграции 011).
  //
  // Legacy fallback: если intent не пришёл (старый фронт ещё в проде, или
  // первый webhook, выпущенный до миграции) — принимаем payload.studio_id,
  // НО без права трогать чувствительные поля жертвы (см. блок UPDATE ниже).
  // Prodamus сохраняет custom-параметры из URL ровно с тем именем, с которым
  // они переданы (включая префикс `_param_`). До этого мы читали голый
  // `intent`/`plan`/`bonus_kop` — Prodamus такие поля не присылает, поэтому
  // studioId оставался null, тариф не активировался. Берём оба варианта
  // (с префиксом и без) для совместимости со старыми тестовыми webhook'ами.
  const intentToken = (
    payload._param_intent ||
    payload.intent ||
    customFields.intent ||
    ''
  ).toString().trim() || null;

  let studioId = null;
  let intentRow = null;
  let usedIntent = false;
  if (intentToken) {
    const ir = await pool.query(
      `SELECT token, studio_id, plan_id, expected_amount_kop, bonus_kop,
              is_upgrade, prorated_credit_kop,
              expires_at, consumed_at
         FROM saas_meta.payment_intents
        WHERE token = $1`,
      [intentToken]
    );
    intentRow = ir.rows[0] || null;
    if (intentRow && !intentRow.consumed_at && new Date(intentRow.expires_at).getTime() > Date.now()) {
      // Doверенная студия — из intent. payload.studio_id игнорируем.
      studioId = intentRow.studio_id;
      usedIntent = true;
    } else {
      // Intent протух/уже использован/неизвестен. Это либо повтор Prodamus
      // на тот же платёж (idempotency сработает на UNIQUE(order_id)), либо
      // подделка. Логируем и идём дальше — fall through на payload-путь
      // оставляем только для backward-compat. После полного перехода фронта
      // на intent-flow можно вернуть 401 здесь.
      // НЕ логируем полный intentToken — даже невалидный, он одноразовый и
      // мог бы быть переиспользован если попадёт в journald, к которому есть
      // доступ у не-нужных ролей. Префикса 6 символов достаточно для отладки.
      console.warn('[webhooks] intent invalid:', { tokenPrefix: intentToken.slice(0, 6), has: !!intentRow });
    }
  }

  if (!studioId) {
    // LEGACY-PATH: payload.studio_id. Считаем UNTRUSTED — атакующий мог
    // подставить в URL чужой UUID. UPDATE-блок ниже не сбрасывает
    // cancel_pending и не затирает prodamus_subscription_* в этом режиме.
    studioId = (payload.studio_id || customFields.studio_id || '').toString().trim() || null;
  }

  const planId   = (
    payload._param_plan ||
    payload.plan ||
    customFields.plan ||
    ''
  ).toString().trim() || null;
  // Бонусы реферальной программы: сколько копеек списать с баланса плательщика.
  // Передаётся через _param_bonus_kop в payform-URL — Prodamus сохраняет имя
  // как есть, без срезания префикса.
  const bonusKopRaw = payload._param_bonus_kop ?? payload.bonus_kop ?? customFields.bonus_kop ?? 0;
  const bonusKopUsed = Math.max(0, Math.floor(Number(bonusKopRaw) || 0));

  // Реквизиты для отключения рекуррента через Prodamus REST setActivity.
  // Prodamus присылает их в каждом успешном webhook'е по подписке. Мы
  // сохраняем их на студию, чтобы в момент «Отменить подписку» не угадывать
  // ID подписки/телефон, а взять прямо из БД и отдать в setActivity.
  // Имена полей у Prodamus исторически разные — берём первое попавшееся.
  const customer = (payload.customer && typeof payload.customer === 'object') ? payload.customer : {};
  const subscriptionId =
    (payload.subscription || payload.subscription_id || customFields.subscription || '')
      .toString().trim() || null;
  const subscriptionPhone =
    (payload.payer_phone || payload.user_phone || customer.phone || payload.phone || '')
      .toString().trim() || null;
  const subscriptionEmail =
    (payload.payer_email || payload.customer_email || customer.email || payload.email || '')
      .toString().trim() || null;

  if (!orderId) {
    await logWebhook({
      source: 'prodamus', ip, signatureValid: true, rawBody: rawStr,
      status: 400, errorMessage: 'missing_order_id',
    });
    return res.status(400).send('missing order_id');
  }

  if (!Number.isFinite(sum) || sum < 0) {
    await logWebhook({
      source: 'prodamus', ip, signatureValid: true, rawBody: rawStr,
      status: 400, errorMessage: 'bad_sum',
    });
    return res.status(400).send('bad sum');
  }

  const amountKop = Math.round(sum * 100);
  const { dbPlan, durationDays } = resolvePlan(planId);

  // ──────────────────────────────────────────────────────────────────
  // Идемпотентная транзакция
  // ──────────────────────────────────────────────────────────────────
  try {
    const result = await withTx(async (client) => {
      const ins = await client.query(
        `INSERT INTO saas_meta.payments
           (order_id, studio_id, amount_kop, currency, status, plan, raw_payload)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
         ON CONFLICT (order_id) DO NOTHING
         RETURNING id`,
        [
          orderId,
          studioId,
          amountKop,
          currency,
          status,
          planId, // храним как пришло — solo_month/solo_year/etc — для аудита
          JSON.stringify(payload),
        ]
      );

      if (ins.rowCount === 0) return { duplicate: true };

      // Будет проброшен наружу — нужен, чтобы после коммита сообразить:
      // отправить юзеру «оплата получена» или «оплата после отмены».
      let wasCancelled = false;

      if (status === 'paid' && studioId) {
        // ─── Защита от «призрачных» списаний после отмены ──────────────
        // Если пользователь нажал «Отменить подписку» (cancel_pending=true),
        // но на стороне Prodamus рекуррент не успели отключить и платёж
        // всё равно прилетел — мы НЕ имеем права молча продлить доступ и
        // сбросить флаг отмены. Это финансовый риск: пользователь думает,
        // что подписан до access_until и больше с него не возьмут, а тут
        // приходит ещё одно списание + автопродление.
        //
        // Поведение: платёж принимаем (запись в payments уже сделана выше
        // в INSERT idempotent-блоке), но access_until НЕ двигаем и
        // cancel_pending НЕ сбрасываем. Сумму зачисляем в бонус-баланс,
        // чтобы деньги пользователя не «пропали»: он сможет потратить их
        // при следующей подписке или запросить возврат у поддержки.
        const guardRow = await client.query(
          `SELECT cancel_pending FROM saas_meta.studios WHERE id = $1 FOR UPDATE`,
          [studioId]
        );
        wasCancelled = guardRow.rows[0]?.cancel_pending === true;

        if (wasCancelled) {
          // Зачисляем сумму платежа в бонусы и помечаем платёж как
          // «после отмены» — чтобы при разборе можно было найти.
          await client.query(
            `UPDATE saas_meta.studios
                SET bonus_balance_kop = bonus_balance_kop + $1,
                    updated_at        = now()
              WHERE id = $2`,
            [amountKop, studioId]
          );
          await client.query(
            `UPDATE saas_meta.payments
                SET status = 'paid_after_cancel'
              WHERE order_id = $1`,
            [orderId]
          );
          console.warn(
            '[webhooks] paid AFTER cancel — access_until NOT extended;',
            'amount credited to bonus_balance:', { studioId, orderId, amountKop }
          );
          // Идём дальше по транзакции (логирование, processed_at), но access не продлеваем.
        } else {
          // Двигаем access_until: max(текущий, now()) + длительность
          // → если оплата пришла до окончания текущего периода, продлеваем поверх,
          //   а не «срезаем» до now()+30. Это безопасно для overlap-биллинга.
          //
          // ─── РАЗДЕЛЕНИЕ TRUSTED / LEGACY-PATH ─────────────────────────
          // С intent (usedIntent=true) — studio_id доверенный, можно
          // безопасно сбрасывать cancel_pending и затирать
          // prodamus_subscription_* (атакующий не мог выпустить intent на
          // чужую студию — эндпоинт под requireAuth берёт studio_id из
          // session).
          //
          // Без intent (legacy URL-path) — studio_id из payload, который
          // мог быть подменён через devtools на UUID жертвы. Тогда:
          //   - access_until продлеваем (это «благодеяние», атаку через это
          //     не делают — атакующий тратит свои деньги на чужую студию)
          //   - НЕ трогаем cancel_pending (иначе атакующий восстановит
          //     отменённую жертвой подписку → следующее автосписание Prodamus
          //     с её карты)
          //   - НЕ перезаписываем prodamus_subscription_id/phone/email
          //     (иначе атакующий подменит реквизиты жертвы своими, и она
          //     не сможет отменить подписку штатно через нашу UI-кнопку)
          //
          // Когда фронт полностью перейдёт на intent-flow — legacy-ветку
          // удалить и в `if (!intentRow || expired)` выше вернуть 401.
          if (usedIntent) {
            // При upgrade Соло → Студия пользователь УЖЕ получил скидку за
            // неиспользованные дни Соло (proratedCreditKop в discount_value).
            // Поэтому access_until сбрасываем в now()+durationDays — иначе
            // он бы оплатил студию и получил «бонусом» оставшийся хвост Соло
            // плюс полный месяц Студии. Это double-count.
            //
            // При обычном продлении (тот же план, или из trial/cancelled) —
            // GREATEST, чтобы ранняя оплата не «срезала» хвост текущего периода.
            const isUpgrade = intentRow && intentRow.is_upgrade === true;
            const accessExpr = isUpgrade
              ? `now() + ($1 || ' days')::interval`
              : `GREATEST(access_until, now()) + ($1 || ' days')::interval`;
            await client.query(
              `UPDATE saas_meta.studios
                  SET access_until                = ${accessExpr},
                      plan                        = COALESCE($2, plan),
                      is_active                   = TRUE,
                      cancel_pending              = FALSE,
                      prodamus_subscription_id    = COALESCE($4, prodamus_subscription_id),
                      prodamus_subscription_phone = COALESCE($5, prodamus_subscription_phone),
                      prodamus_subscription_email = COALESCE($6, prodamus_subscription_email),
                      updated_at                  = now()
                WHERE id = $3`,
              [String(durationDays), dbPlan, studioId, subscriptionId, subscriptionPhone, subscriptionEmail]
            );
            // Помечаем intent как consumed — повторный webhook с тем же
            // токеном не пройдёт верификацию (фолбэкнется на legacy-path).
            await client.query(
              `UPDATE saas_meta.payment_intents
                  SET consumed_at = now(), consumed_order_id = $2
                WHERE token = $1 AND consumed_at IS NULL`,
              [intentToken, orderId]
            );
          } else {
            // LEGACY-PATH: studio_id из payload не верифицирован.
            // Только продлеваем access; чувствительные поля не трогаем.
            await client.query(
              `UPDATE saas_meta.studios
                  SET access_until = GREATEST(access_until, now()) + ($1 || ' days')::interval,
                      plan         = COALESCE($2, plan),
                      is_active    = TRUE,
                      updated_at   = now()
                WHERE id = $3`,
              [String(durationDays), dbPlan, studioId]
            );
            console.warn(
              '[webhooks] LEGACY studio_id path used (no intent token):',
              { orderId, studioId }
            );
          }
        }

        // ─── Реферальная программа ───────────────────────────────────
        // Реф-логика срабатывает ТОЛЬКО на «нормальный» платёж, который мы
        // зачли как продление подписки. Если платёж пришёл после отмены и
        // мы вернули его в bonus_balance — реф-механика не работает (это
        // не оплата подписки, а ошибочное списание).
        // 1) DEBIT: если плательщик использовал бонусы — списываем с его баланса.
        //    UNIQUE(payment_order_id, kind) на referral_events не даст задвоить
        //    при повторном webhook-е того же order_id.
        //
        //    ВАЖНО: списание бонусов делаем ТОЛЬКО когда usedIntent=true.
        //    В legacy-path атакующий мог поставить `_param_studio_id=<жертва>`
        //    и `_param_bonus_kop=<balance жертвы>` — и Prodamus на чекауте
        //    взял бы с него (атакующего) меньше, а у жертвы списались бы
        //    бонусы. Без intent-проверки доверять studio_id для финансовой
        //    операции нельзя.
        if (!wasCancelled && usedIntent && bonusKopUsed > 0) {
          // Берём фактически доступный баланс под FOR UPDATE, чтобы не уйти в минус
          // при гонках. Списываем min(used, balance) — UI должен был это уже учесть,
          // но на бэке ещё раз ограничиваем.
          const balRow = await client.query(
            `SELECT bonus_balance_kop FROM saas_meta.studios
              WHERE id = $1 FOR UPDATE`,
            [studioId]
          );
          const have = Number(balRow.rows[0]?.bonus_balance_kop || 0);
          const debit = Math.min(bonusKopUsed, have);
          if (debit > 0) {
            await client.query(
              `UPDATE saas_meta.studios
                  SET bonus_balance_kop = bonus_balance_kop - $1
                WHERE id = $2`,
              [debit, studioId]
            );
            await client.query(
              `INSERT INTO saas_meta.referral_events
                 (studio_id, source_studio_id, kind, amount_kop, payment_order_id)
               VALUES ($1, $1, 'debit', $2, $3)
               ON CONFLICT (payment_order_id, kind)
               WHERE payment_order_id IS NOT NULL DO NOTHING`,
              [studioId, debit, orderId]
            );
          }
        }

        // 2) CREDIT: если плательщик пришёл по чьей-то реф-ссылке
        //    (referred_by IS NOT NULL) И это его ПЕРВАЯ оплата —
        //    начисляем 1 250 ₽ рефереру. Скипаем при wasCancelled —
        //    «призрачное» списание не считаем «первой оплатой».
        if (!wasCancelled) {
          const refRow = await client.query(
            `SELECT referred_by FROM saas_meta.studios WHERE id = $1`,
            [studioId]
          );
          const referrerId = refRow.rows[0]?.referred_by || null;
          if (referrerId) {
            const paidCount = await client.query(
              `SELECT count(*)::int AS n FROM saas_meta.payments
                WHERE studio_id = $1 AND status = 'paid'`,
              [studioId]
            );
            if ((paidCount.rows[0]?.n || 0) === 1) {
              const BONUS_KOP = 125000; // 1 250 ₽
              await client.query(
                `UPDATE saas_meta.studios
                    SET bonus_balance_kop = bonus_balance_kop + $1
                  WHERE id = $2`,
                [BONUS_KOP, referrerId]
              );
              await client.query(
                `INSERT INTO saas_meta.referral_events
                   (studio_id, source_studio_id, kind, amount_kop, payment_order_id)
                 VALUES ($1, $2, 'credit', $3, $4)
                 ON CONFLICT (payment_order_id, kind)
                 WHERE payment_order_id IS NOT NULL DO NOTHING`,
                [referrerId, studioId, BONUS_KOP, orderId]
              );
            }
          }
        }
      } else if (status === 'refunded' && studioId) {
        await client.query(
          `UPDATE saas_meta.studios
              SET access_until = now(),
                  plan         = 'cancelled',
                  is_active    = FALSE,
                  updated_at   = now()
            WHERE id = $1`,
          [studioId]
        );

        // Реверс реферального бонуса: если за этот платёж рефереру был
        // начислен credit-event (1 250 ₽ по реф-программе), снимаем его
        // с баланса. Условия 7.3 Реферальной программы прямо это
        // предусматривают: «Если Реферал инициировал возврат… Исполнитель
        // вправе списать соответствующий Бонус».
        //
        // FOR UPDATE — защита от гонки: если параллельно идёт другой webhook
        // или intent, они блокируются на этой строке до COMMIT.
        const credit = await client.query(
          `SELECT studio_id AS referrer_id, amount_kop
             FROM saas_meta.referral_events
            WHERE payment_order_id = $1 AND kind = 'credit'
            FOR UPDATE`,
          [orderId]
        );
        if (credit.rowCount > 0) {
          const { referrer_id: referrerId, amount_kop: amount } = credit.rows[0];
          // Снимаем не больше, чем сейчас на балансе — иначе уйдём в минус.
          // Если реферер уже потратил эти бонусы на свою подписку (полностью
          // или частично) — снимаем сколько есть, остальное «прощаем».
          // Альтернатива: запросить с реферера деньги — но это ломает UX
          // и в Договоре-оферте п. 3.6 сказано «Возврат средств не
          // производится» (для реферера это де-факто чужой возврат, не его).
          const balRow = await client.query(
            `SELECT bonus_balance_kop FROM saas_meta.studios
              WHERE id = $1 FOR UPDATE`,
            [referrerId]
          );
          const have = Number(balRow.rows[0]?.bonus_balance_kop || 0);
          const toReverse = Math.min(have, Number(amount) || 0);
          if (toReverse > 0) {
            await client.query(
              `UPDATE saas_meta.studios
                  SET bonus_balance_kop = bonus_balance_kop - $1
                WHERE id = $2`,
              [toReverse, referrerId]
            );
            // referral_events.kind CHECK содержит ('credit', 'debit') —
            // reverse-операцию пишем как 'debit' с положительной суммой
            // (CHECK amount_kop > 0). UNIQUE(payment_order_id, kind) НЕ
            // помешает: на этот order_id есть credit, а debit ещё нет.
            await client.query(
              `INSERT INTO saas_meta.referral_events
                 (studio_id, source_studio_id, kind, amount_kop, payment_order_id)
               VALUES ($1, $2, 'debit', $3, $4)
               ON CONFLICT (payment_order_id, kind)
               WHERE payment_order_id IS NOT NULL DO NOTHING`,
              [referrerId, studioId, toReverse, orderId]
            );
          } else {
            // Реверс на 0 ₽ — реферер уже потратил всё. Пишем в обычный
            // лог (не в referral_events, т.к. CHECK amount_kop > 0).
            console.warn(
              `[referral] reverse=0 for refunded order ${orderId}: ` +
              `referrer ${referrerId} already spent the credit (${amount} kop).`
            );
          }
        }
      }

      await client.query(
        `UPDATE saas_meta.payments SET processed_at = now() WHERE order_id = $1`,
        [orderId]
      );

      return { duplicate: false, wasCancelled };
    });

    // ─── TG-уведомление владельцу ────────────────────────────────────
    // Только на «свежий» (не дубликат) успешный платёж. На дубликат
    // не шлём — иначе при ретрае Prodamus юзер получит то же сообщение
    // ещё раз. Запускаем ПОСЛЕ коммита транзакции, best-effort: ошибка
    // отправки не должна вернуть 500 → Prodamus ретраить не будет.
    if (!result.duplicate && status === 'paid' && studioId) {
      // Не await: ответ Prodamus'у ждать не надо. Если TG ляжет на 30 сек —
      // не задерживаем webhook-acknowledge.
      void notifyOwnerOnPayment({
        studioId,
        orderId,
        amountKop,
        planId,
        bonusKopUsed,
        isPaidAfterCancel: result.wasCancelled,
      });
      // Параллельно — уведомление админу платформы (если оплата не от
      // его собственной студии). Чтобы Оле не приходилось дёргать
      // /платежи в боте, чтобы узнать о свежих оплатах клиентов.
      void notifyAdminOnPayment({
        studioId,
        orderId,
        amountKop,
        planId,
        bonusKopUsed,
        isPaidAfterCancel: result.wasCancelled,
      });
    }

    await logWebhook({
      source: 'prodamus', ip, signatureValid: true, rawBody: rawStr,
      status: 200, errorMessage: result.duplicate ? 'duplicate_idempotent' : null,
    });

    return res.status(200).send('ok');
  } catch (err) {
    // Логируем только code + message, не весь err-объект. Stack trace может
    // содержать значения переменных из закрытых scope'ов (включая
    // фрагменты payload'а с PII плательщика). raw_payload всё равно
    // попадает в saas_meta.webhook_log для аудита, дублировать в journald
    // нет смысла.
    console.error('[webhooks] prodamus processing failed:', err.code || 'unknown', err.message);
    await logWebhook({
      source: 'prodamus', ip, signatureValid: true, rawBody: rawStr,
      status: 500, errorMessage: err.message,
    });
    return res.status(500).send('processing error');
  }
});

module.exports = router;
