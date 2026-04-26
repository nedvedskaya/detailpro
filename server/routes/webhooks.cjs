'use strict';
/**
 * Webhook Продамуса: подтверждения оплаты подписки студии.
 *
 * Контракт:
 *   POST /api/webhooks/prodamus
 *   Body: form-urlencoded или JSON (Продамус шлёт urlencoded)
 *   Header: Sign — HMAC-SHA256(secret, rawBody) в hex
 *
 * Критические свойства:
 *   1. Подпись считается по СЫРЫМ байтам тела. Поэтому здесь используется
 *      express.raw(), а НЕ express.json/urlencoded — те уже попортили бы
 *      исходную строку (порядок ключей, кодирование).
 *   2. Идемпотентность через UNIQUE(order_id) в saas_meta.payments.
 *      Тот же webhook второй раз → ON CONFLICT DO NOTHING → 200, no-op.
 *      Продамус ретраит при не-200, поэтому возвращаем 200 даже на дубликат.
 *   3. Лог в saas_meta.webhook_log — ВСЕГДА, включая невалидную подпись.
 *      Это даёт аудит атак (кто-то пытается подобрать секрет → видим в логе).
 *   4. Невалидная подпись → 401 (не 200), но запись в лог уже есть.
 *      Возврат 401 нужен, чтобы:
 *        - в логах кабинета Продамуса видно «webhook не доставлен»
 *        - админ заметил misconfig (поменялся ключ)
 *
 * Источники:
 *   https://help.prodamus.ru/payform/integracii/webhooks (общее описание)
 *
 * ВАЖНО: Продамус использует свою спецификацию подписи — порядок параметров,
 * исключение поля `signature`. На практике секрет применяется к стабильно
 * сериализованному телу. Здесь используется упрощённая версия (HMAC-SHA256
 * по сырому body) — её надо подтвердить смоук-тестом из реального кабинета,
 * перед прод-запуском. См. блок TODO ниже.
 */

const express = require('express');
const crypto = require('node:crypto');
const { pool, withTx } = require('../lib/db.cjs');

const router = express.Router();

// ──────────────────────────────────────────────────────────────────────
// raw-парсер: оставляем тело как Buffer, чтобы можно было считать HMAC
// до того, как express попытается распарсить его как JSON или urlencoded.
// ──────────────────────────────────────────────────────────────────────
const rawParser = express.raw({ type: '*/*', limit: '256kb' });

// ──────────────────────────────────────────────────────────────────────
// Парсинг form-urlencoded из Buffer без полной зависимости.
// Возвращает плоский { key: value } (повторяющиеся ключи берём последние).
// ──────────────────────────────────────────────────────────────────────
function parseUrlencoded(bodyStr) {
  const out = {};
  if (!bodyStr) return out;
  const params = new URLSearchParams(bodyStr);
  for (const [k, v] of params) out[k] = v;
  return out;
}

function parseBody(buf, contentType) {
  const str = buf ? buf.toString('utf8') : '';
  if (!str) return {};
  const ct = (contentType || '').toLowerCase();
  if (ct.includes('application/json')) {
    try { return JSON.parse(str); } catch (_) { return {}; }
  }
  // По умолчанию — Продамус шлёт application/x-www-form-urlencoded
  return parseUrlencoded(str);
}

// ──────────────────────────────────────────────────────────────────────
// Проверка подписи. Возвращает boolean, не throw — чтобы лог писался даже
// при битых заголовках.
// ──────────────────────────────────────────────────────────────────────
function verifySignature(rawBodyBuf, headerSign, secret) {
  if (!secret) return false;
  if (typeof headerSign !== 'string' || !headerSign) return false;
  if (!Buffer.isBuffer(rawBodyBuf)) return false;

  const expected = crypto.createHmac('sha256', secret).update(rawBodyBuf).digest('hex');
  // Сравниваем строки одинаковой длины через timingSafeEqual.
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
// Длительность подписки по плану.
// Solo / Studio — оба продаются помесячно (30 дней); если появятся годовые
// тарифы, плюсуется по amount_kop.
// ──────────────────────────────────────────────────────────────────────
function planDurationDays(plan) {
  if (plan === 'solo' || plan === 'studio') return 30;
  return 30;
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
    // лог самого лога — в stderr, не валим запрос
    console.error('[webhooks] failed to write webhook_log:', err.message);
  }
}

// ──────────────────────────────────────────────────────────────────────
// POST /api/webhooks/prodamus
// ──────────────────────────────────────────────────────────────────────
router.post('/prodamus', rawParser, async (req, res) => {
  const ip = req.ip;
  const rawBuf = req.body; // Buffer от express.raw
  const rawStr = rawBuf ? rawBuf.toString('utf8') : '';
  const secret = process.env.PRODAMUS_SECRET_KEY;

  // Sign бывает в разном регистре — берём всё, что есть
  const headerSign =
    req.headers['sign'] ||
    req.headers['x-sign'] ||
    req.headers['signature'] ||
    '';

  const signatureValid = verifySignature(rawBuf, headerSign, secret);

  // Если подпись не валидна — пишем лог и отвечаем 401, не обрабатывая.
  if (!signatureValid) {
    await logWebhook({
      source: 'prodamus',
      ip,
      signatureValid: false,
      rawBody: rawStr,
      status: 401,
      errorMessage: 'invalid_signature',
    });
    return res.status(401).send('invalid signature');
  }

  // Подпись ок — парсим тело и продолжаем.
  let payload;
  try {
    payload = parseBody(rawBuf, req.headers['content-type']);
  } catch (err) {
    await logWebhook({
      source: 'prodamus',
      ip,
      signatureValid: true,
      rawBody: rawStr,
      status: 400,
      errorMessage: 'bad_body: ' + err.message,
    });
    return res.status(400).send('bad body');
  }

  // Извлекаем поля. Имена соответствуют типичным от Продамуса; при подключении
  // реального кабинета может потребоваться корректировка.
  const orderId = String(payload.order_id || payload.order_num || payload.id || '').trim();
  const sumStr = String(payload.sum || payload.amount || '0').replace(',', '.');
  const sum = Number(sumStr); // в рублях
  const currency = String(payload.currency || 'RUB').toUpperCase();
  const status = mapStatus(payload.payment_status || payload.status);
  const customFields = payload.custom_field || {};
  const studioId = payload.studio_id || customFields.studio_id || null;
  const plan = payload.plan || customFields.plan || null;

  if (!orderId) {
    await logWebhook({
      source: 'prodamus',
      ip,
      signatureValid: true,
      rawBody: rawStr,
      status: 400,
      errorMessage: 'missing_order_id',
    });
    return res.status(400).send('missing order_id');
  }

  if (!Number.isFinite(sum) || sum < 0) {
    await logWebhook({
      source: 'prodamus',
      ip,
      signatureValid: true,
      rawBody: rawStr,
      status: 400,
      errorMessage: 'bad_sum',
    });
    return res.status(400).send('bad sum');
  }

  const amountKop = Math.round(sum * 100);

  // ──────────────────────────────────────────────────────────────────
  // Идемпотентность: INSERT ... ON CONFLICT DO NOTHING.
  // Если RETURNING пуст — этот order_id уже обработан, выходим с 200.
  // Если новый — продолжаем в транзакции до апдейта studios.
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
          plan,
          JSON.stringify(payload),
        ]
      );

      if (ins.rowCount === 0) {
        return { duplicate: true };
      }

      // Только при status=paid и наличии studio_id двигаем подписку.
      if (status === 'paid' && studioId) {
        const days = planDurationDays(plan);
        await client.query(
          `UPDATE saas_meta.studios
              SET access_until = GREATEST(access_until, now()) + ($1 || ' days')::interval,
                  plan         = COALESCE($2, plan),
                  is_active    = TRUE,
                  updated_at   = now()
            WHERE id = $3`,
          [String(days), plan, studioId]
        );
      } else if (status === 'refunded' && studioId) {
        // Возврат — отрубаем доступ. Сессии не трогаем здесь, чтобы юзер
        // увидел сообщение «подписка отменена» при следующем запросе через
        // requireActiveStudio. Если нужна жёсткая инвалидация — отдельным
        // вызовом в админке.
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
      source: 'prodamus',
      ip,
      signatureValid: true,
      rawBody: rawStr,
      status: 200,
      errorMessage: result.duplicate ? 'duplicate_idempotent' : null,
    });

    return res.status(200).send('ok');
  } catch (err) {
    console.error('[webhooks] prodamus processing failed:', err);
    await logWebhook({
      source: 'prodamus',
      ip,
      signatureValid: true,
      rawBody: rawStr,
      status: 500,
      errorMessage: err.message,
    });
    // 500 → Продамус ретраит. Это правильное поведение при транзиентной ошибке.
    return res.status(500).send('processing error');
  }
});

module.exports = router;
