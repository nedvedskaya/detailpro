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
const crypto = require('node:crypto');
const { pool, withTx } = require('../lib/db.cjs');

const router = express.Router();

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
    if (cur[k] == null || typeof cur[k] !== 'object') cur[k] = {};
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

// ──────────────────────────────────────────────────────────────────────
// Алгоритм подписи Продамуса (port из их PHP Hmac::create).
//
// Рекурсивно сортируем ключи объекта. Для массивов сортировки нет — порядок
// сохраняется как пришёл. На листьях — приводим к строке (Продамус делает то же
// в JSON-сериализации).
// ──────────────────────────────────────────────────────────────────────
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

function prodamusHmac(payload, secret) {
  // 1. Убираем подпись (на случай если она лежит в теле)
  const cleaned = { ...payload };
  delete cleaned.signature;
  delete cleaned.sign;

  // 2. Рекурсивная сортировка ключей
  const sorted = deepSort(cleaned);

  // 3. JSON.stringify. JS по-умолчанию НЕ escape-ит юникод и слеши — это и есть
  //    эквивалент JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES в PHP.
  const json = JSON.stringify(sorted);

  // 4. HMAC-SHA256 в hex
  return crypto.createHmac('sha256', secret).update(json, 'utf8').digest('hex');
}

function verifySignatureProdamus(payload, headerSign, secret) {
  if (!secret) return false;
  if (typeof headerSign !== 'string' || !headerSign) return false;

  const expected = prodamusHmac(payload, secret);
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
  const studioId = (payload.studio_id || customFields.studio_id || '').toString().trim() || null;
  const planId   = (payload.plan      || customFields.plan      || '').toString().trim() || null;

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

      if (status === 'paid' && studioId) {
        // Двигаем access_until: max(текущий, now()) + длительность
        // → если оплата пришла до окончания текущего периода, продлеваем поверх,
        //   а не «срезаем» до now()+30. Это безопасно для overlap-биллинга.
        await client.query(
          `UPDATE saas_meta.studios
              SET access_until   = GREATEST(access_until, now()) + ($1 || ' days')::interval,
                  plan           = COALESCE($2, plan),
                  is_active      = TRUE,
                  cancel_pending = FALSE,
                  updated_at     = now()
            WHERE id = $3`,
          [String(durationDays), dbPlan, studioId]
        );
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
      }

      await client.query(
        `UPDATE saas_meta.payments SET processed_at = now() WHERE order_id = $1`,
        [orderId]
      );

      return { duplicate: false };
    });

    await logWebhook({
      source: 'prodamus', ip, signatureValid: true, rawBody: rawStr,
      status: 200, errorMessage: result.duplicate ? 'duplicate_idempotent' : null,
    });

    return res.status(200).send('ok');
  } catch (err) {
    console.error('[webhooks] prodamus processing failed:', err);
    await logWebhook({
      source: 'prodamus', ip, signatureValid: true, rawBody: rawStr,
      status: 500, errorMessage: err.message,
    });
    return res.status(500).send('processing error');
  }
});

module.exports = router;
