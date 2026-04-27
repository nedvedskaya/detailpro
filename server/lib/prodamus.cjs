'use strict';
/**
 * Prodamus REST helpers — пока единственный вызов: setActivity (отключение
 * рекуррента на стороне платёжки).
 *
 * Зачем:
 *   До этого «Отменить подписку» только выставляло локальный флаг cancel_pending,
 *   а реальный рекуррент в Prodamus продолжал жить. Защита была после факта:
 *   webhook видел «уже отменён» и зачислял случайное списание в бонусы. Это
 *   корректно, но пугает пользователя в UI и оставляет ощущение «вдруг спишут».
 *
 *   setActivity делает нормальную вещь: говорит Prodamus, что данный рекуррент
 *   у данного плательщика больше не активен. Списания прекратятся.
 *
 * Контракт API (по их документации):
 *   POST {PRODAMUS_API_BASE}/rest/setActivity/
 *   Body (form-urlencoded):
 *     subscription     — ID подписки (приходил в webhook'е как `subscription`)
 *     tg_user_id       — ИЛИ tg_user_id плательщика
 *     user_phone       — ИЛИ телефон плательщика (хотя бы один из идентификаторов)
 *     active_manager   — 0 (выключить), 1 (включить)
 *     signature        — HMAC-SHA256 от deepSort+JSON.stringify (тот же алгоритм,
 *                        что и для verify в webhooks.cjs)
 *
 * Конфигурация:
 *   PRODAMUS_API_BASE  — базовый URL магазина, например `https://detailprocrm.payform.ru`.
 *                        Если не задан → setActivity молча скипается, остаётся
 *                        webhook-защита. Это ОК на старте, до получения API-доступа.
 *   PRODAMUS_SECRET_KEY — тот же ключ, что используется для verify webhook'а.
 *
 * Ошибки:
 *   Все ошибки сети/HTTP/Prodamus возвращаются как { ok: false, error, ... }.
 *   Caller должен сам решать, ронять операцию или продолжать с локальным флагом.
 *   В нашем cancel-роуте мы выбираем «продолжать»: даже если setActivity упал,
 *   локальный cancel_pending+webhook-защита покрывают пользователя финансово.
 */

const crypto = require('node:crypto');

// ──────────────────────────────────────────────────────────────────────
// HMAC: алгоритм 1-в-1 как в webhooks.cjs (deepSort → JSON.stringify → sha256 hex).
// Дублируем, а не share'им через общий модуль, потому что webhooks.cjs — это вход
// (verify), а это — выход (sign), и обнулять одинаковость гарантирует только тест.
// ──────────────────────────────────────────────────────────────────────
function deepSort(value) {
  if (Array.isArray(value)) return value.map(deepSort);
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    const out = {};
    for (const k of keys) out[k] = deepSort(value[k]);
    return out;
  }
  return value;
}

function prodamusHmac(payload, secret) {
  const cleaned = { ...payload };
  delete cleaned.signature;
  delete cleaned.sign;
  const sorted = deepSort(cleaned);
  const json = JSON.stringify(sorted);
  return crypto.createHmac('sha256', secret).update(json, 'utf8').digest('hex');
}

// ──────────────────────────────────────────────────────────────────────
// Сериализация в form-urlencoded со скобочной нотацией для вложенностей
// (Prodamus так же парсит на своей стороне).
//   { a: 1, b: { c: 2 } } → 'a=1&b[c]=2'
// ──────────────────────────────────────────────────────────────────────
function toFormUrlencoded(obj, prefix) {
  const parts = [];
  for (const key of Object.keys(obj)) {
    const v = obj[key];
    const k = prefix ? `${prefix}[${key}]` : key;
    if (v === null || v === undefined) continue;
    if (typeof v === 'object' && !Array.isArray(v)) {
      parts.push(toFormUrlencoded(v, k));
    } else {
      parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(String(v)));
    }
  }
  return parts.join('&');
}

// ──────────────────────────────────────────────────────────────────────
// deactivateSubscription — выключить рекуррент в Prodamus.
//
// Args:
//   subscriptionId — обязателен (мы сохраняем его из webhook payload в
//                    saas_meta.studios.prodamus_subscription_id).
//   userPhone      — телефон плательщика (E.164 или как пришёл в webhook'е).
//   tgUserId       — ИЛИ Telegram user id (если оплачивали через TG).
//                    Хотя бы один из (userPhone, tgUserId) должен быть передан.
//
// Returns:
//   { ok: true }                                — успех
//   { ok: false, skipped: 'no_api_base' }        — env не сконфигурен (мягкий скип)
//   { ok: false, skipped: 'no_subscription_id' } — нет ID подписки в БД
//   { ok: false, error: '...', status?, body? }  — ошибка сети/HTTP/Prodamus
// ──────────────────────────────────────────────────────────────────────
async function deactivateSubscription({ subscriptionId, userPhone, tgUserId } = {}) {
  const apiBase = process.env.PRODAMUS_API_BASE;
  const secret = process.env.PRODAMUS_SECRET_KEY;

  if (!apiBase) {
    return { ok: false, skipped: 'no_api_base' };
  }
  if (!secret) {
    return { ok: false, skipped: 'no_secret' };
  }
  if (!subscriptionId) {
    return { ok: false, skipped: 'no_subscription_id' };
  }
  if (!userPhone && !tgUserId) {
    return { ok: false, skipped: 'no_user_identifier' };
  }

  // Тело запроса — то, что подписываем И отправляем.
  const payload = {
    subscription: String(subscriptionId),
    active_manager: 0,
  };
  if (tgUserId)  payload.tg_user_id = String(tgUserId);
  if (userPhone) payload.user_phone = String(userPhone);

  const signature = prodamusHmac(payload, secret);
  const body = toFormUrlencoded({ ...payload, signature });

  const url = apiBase.replace(/\/+$/, '') + '/rest/setActivity/';

  try {
    // AbortController на 10 сек, чтобы cancel-роут не висел при сетевых тормозах.
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10_000);

    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json, text/plain, */*',
      },
      body,
      signal: ctrl.signal,
    });
    clearTimeout(timer);

    const text = await resp.text();

    if (!resp.ok) {
      return {
        ok: false,
        error: 'http_' + resp.status,
        status: resp.status,
        body: text.slice(0, 500),
      };
    }

    // Prodamus может отдавать как JSON, так и plain text. Считаем успехом любой 2xx,
    // если нет явного признака ошибки в теле.
    let parsed = null;
    try { parsed = JSON.parse(text); } catch (_) { /* not json — ok */ }

    if (parsed && parsed.error) {
      return { ok: false, error: 'prodamus_error', status: resp.status, body: text.slice(0, 500) };
    }

    return { ok: true, status: resp.status, body: text.slice(0, 500) };
  } catch (err) {
    return {
      ok: false,
      error: err.name === 'AbortError' ? 'timeout' : 'network',
      message: err.message,
    };
  }
}

module.exports = {
  deactivateSubscription,
  // Экспортируем helper'ы для тестов
  _internal: { prodamusHmac, toFormUrlencoded, deepSort },
};
