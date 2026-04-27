'use strict';
/**
 * Низкоуровневый клиент к Telegram Bot API.
 *
 * Не знает ничего про студии/users/шаблоны — только умеет дёргать TG методы
 * и логировать результат в saas_meta.tg_messages_log. Высокоуровневые
 * функции (notifyOwner, sendResetLink) живут в lib/notifications.cjs.
 *
 * Конфигурация (.env):
 *   TELEGRAM_BOT_TOKEN          — обязателен; от @BotFather
 *   TELEGRAM_BOT_USERNAME       — без @, например 'crmdetailpro_bot'.
 *                                  Используется для генерации deep-link на фронте.
 *   TELEGRAM_WEBHOOK_SECRET     — random-строка, проверяется в заголовке
 *                                  X-Telegram-Bot-Api-Secret-Token.
 *
 * Если TELEGRAM_BOT_TOKEN не задан — все методы возвращают
 * { ok: false, skipped: 'no_token' }, ничего не падает. Это позволяет
 * крутить сервер без подключённого бота на dev.
 */

const { pool } = require('./db.cjs');
const https = require('node:https');

const API_HOST = 'api.telegram.org';

// Известно-рабочие IPv4 api.telegram.org для нашего RU-хостинга.
// На Timeweb (Москва) часть подсетей TG блокируется по маршруту:
// 149.154.166.* и 91.108.* — Connection timed out, а вот эти открыты.
// Если список протухнет (TG сменит IP), при ошибке пробуем следующий.
//
// Источник: ручной TCP-probe + https://core.telegram.org/resources/cidr.txt
// (там общий пул TG-адресов, выбираем подсети, которые видны от нас).
const KNOWN_GOOD_IPS = [
  '149.154.167.220',  // DC2 main, проверено reachable
  '149.154.175.50',   // DC4, проверено reachable
];
let preferredIpIndex = 0;

// Возвращает текущий known-good IP api.telegram.org. Используется ниже
// напрямую как `host:` в https.request — обходит DNS-резолв (который вернул бы
// заблокированный TG IP) и servername сохраняет правильное имя для SNI/TLS.
function preferredApiIp() {
  return KNOWN_GOOD_IPS[preferredIpIndex] || KNOWN_GOOD_IPS[0];
}

function token() {
  return process.env.TELEGRAM_BOT_TOKEN || null;
}

function botUsername() {
  return process.env.TELEGRAM_BOT_USERNAME || null;
}

// ──────────────────────────────────────────────────────────────────────
// Низкоуровневый вызов method-а Bot API.
//   call('sendMessage', { chat_id, text, parse_mode })
// Возвращает { ok, result?, error?, status? }.
// ──────────────────────────────────────────────────────────────────────
async function call(method, body, opts = {}) {
  const t = token();
  if (!t) return { ok: false, skipped: 'no_token' };

  // По умолчанию короткий таймаут. Для long-polling getUpdates нужно
  // подождать дольше (timeout=30s на стороне TG → клиенту ставим ≥35s).
  const timeoutMs = opts.timeoutMs || 10_000;

  // Делаем до 2 попыток: если первая упала по timeout/socket — переключаемся
  // на следующий IP из KNOWN_GOOD_IPS (вдруг тот, что использовали, вылетел).
  let lastErr = null;
  for (let attempt = 0; attempt < KNOWN_GOOD_IPS.length; attempt++) {
    const r = await callOnce(t, method, body, timeoutMs);
    if (r.ok) return r;
    lastErr = r;
    // Сетевые ошибки → ротируем IP. Логические ошибки (status 4xx) — нет смысла.
    if (r.error !== 'network' && r.error !== 'timeout') return r;
    preferredIpIndex = (preferredIpIndex + 1) % KNOWN_GOOD_IPS.length;
  }
  return lastErr || { ok: false, error: 'unknown' };
}

function callOnce(t, method, body, timeoutMs) {
  return new Promise((resolve) => {
    const payload = JSON.stringify(body || {});
    const req = https.request({
      host: preferredApiIp(),     // напрямую IP, минуя DNS (заблокирован)
      port: 443,
      path: `/bot${t}/${method}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        Host: API_HOST,           // правильный Host для TG (и virtual hosting)
      },
      servername: API_HOST,       // правильный SNI для TLS-сертификата
      timeout: timeoutMs,
    }, (resp) => {
      const chunks = [];
      resp.on('data', (c) => chunks.push(c));
      resp.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let parsed = null;
        try { parsed = JSON.parse(text); } catch (_) { /* not json */ }
        if (resp.statusCode < 200 || resp.statusCode >= 300 || !parsed || parsed.ok !== true) {
          return resolve({
            ok: false,
            status: resp.statusCode,
            error: parsed && parsed.description ? parsed.description : ('http_' + resp.statusCode),
            body: text.slice(0, 500),
          });
        }
        resolve({ ok: true, result: parsed.result });
      });
    });

    req.on('error', (err) => {
      resolve({ ok: false, error: 'network', message: err.message });
    });
    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, error: 'timeout', message: `request timeout after ${timeoutMs}ms` });
    });

    req.write(payload);
    req.end();
  });
}

// ──────────────────────────────────────────────────────────────────────
// sendMessage с автоматическим логированием в БД.
//   sendMessage({ chatId, text, kind, userId?, parseMode? })
//
// kind — короткий идентификатор события для лога (link_success,
// password_reset, payment_success, new_booking, ...).
// Без kind не пишем — иначе лог нечитаемый.
// ──────────────────────────────────────────────────────────────────────
async function sendMessage({ chatId, text, kind, userId = null, parseMode = 'HTML', replyMarkup = null }) {
  if (!chatId) return { ok: false, error: 'no_chat_id' };
  if (!text)   return { ok: false, error: 'no_text' };
  if (!kind)   return { ok: false, error: 'no_kind' };

  const body = {
    chat_id: chatId,
    text,
    parse_mode: parseMode,
    // disable_web_page_preview: ссылка на /reset не должна разворачиваться превью
    // в стиле «логотип CRM» — пока нет красивой OG-картинки, пусть будет голая.
    disable_web_page_preview: true,
  };
  if (replyMarkup) body.reply_markup = replyMarkup;

  const r = await call('sendMessage', body);

  // Лог — best-effort. Если БД упала, не должны ронять отправку (она прошла).
  try {
    await pool.query(
      `INSERT INTO saas_meta.tg_messages_log (user_id, tg_chat_id, kind, ok, error)
       VALUES ($1, $2, $3, $4, $5)`,
      [userId, chatId, kind, r.ok === true, r.ok ? null : (r.error || r.skipped || 'unknown')]
    );
  } catch (e) {
    console.error('[telegram] failed to write tg_messages_log:', e.message);
  }

  return r;
}

// ──────────────────────────────────────────────────────────────────────
// HTML escape для safe вставки данных пользователя в сообщение
// (parse_mode=HTML). НИКОГДА не передавать сырой текст пользователя в
// шаблон без escapeHtml — иначе TG отрендерит чужие <b>/<a>/<script>.
// ──────────────────────────────────────────────────────────────────────
function escapeHtml(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// ──────────────────────────────────────────────────────────────────────
// setWebhook — вызывается админом из CLI/скрипта при первой настройке
// или после смены домена. Не нужно дёргать на каждый старт сервера.
// ──────────────────────────────────────────────────────────────────────
async function setWebhook(url) {
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!secret) return { ok: false, error: 'no_webhook_secret' };
  return call('setWebhook', {
    url,
    secret_token: secret,
    // Только нужные апдейты — экономим BW и фильтруем шум.
    allowed_updates: ['message', 'callback_query'],
    // drop_pending_updates: при первой настройке полезно очистить очередь,
    // если бот тестировался в чате — не получим лавину старых /start'ов.
    drop_pending_updates: false,
  });
}

async function deleteWebhook() {
  return call('deleteWebhook', { drop_pending_updates: false });
}

async function getWebhookInfo() {
  return call('getWebhookInfo', {});
}

async function getMe() {
  return call('getMe', {});
}

// ──────────────────────────────────────────────────────────────────────
// getUpdates для long-polling. Вызывается из lib/telegram_polling.cjs.
//   offset  — последний обработанный update_id + 1
//   timeout — секунд держать соединение если нет апдейтов (рекомендуется 25-30)
// Клиентский AbortController должен ждать > timeout, иначе мы зарежем
// соединение раньше TG → потеря long-poll. Ставим 5 секунд буфера.
// ──────────────────────────────────────────────────────────────────────
async function getUpdates({ offset, timeout = 25 }) {
  return call('getUpdates', {
    offset: offset || 0,
    timeout,
    allowed_updates: ['message', 'callback_query'],
  }, { timeoutMs: (timeout + 10) * 1000 });
}

// ──────────────────────────────────────────────────────────────────────
// answerCallbackQuery — обязательный ACK на нажатие inline-кнопки.
// Без вызова в TG-клиенте крутится «загрузка». text — короткий тост (опц.).
// ──────────────────────────────────────────────────────────────────────
async function answerCallbackQuery(callbackQueryId, text = '', { showAlert = false } = {}) {
  return call('answerCallbackQuery', {
    callback_query_id: callbackQueryId,
    text: text || undefined,
    show_alert: showAlert,
  });
}

// ──────────────────────────────────────────────────────────────────────
// editMessageReplyMarkup — обновить inline-клавиатуру под сообщением.
// Передать null/undefined в replyMarkup, чтобы убрать кнопки (после нажатия).
// ──────────────────────────────────────────────────────────────────────
async function editMessageReplyMarkup(chatId, messageId, replyMarkup) {
  return call('editMessageReplyMarkup', {
    chat_id: chatId,
    message_id: messageId,
    reply_markup: replyMarkup || { inline_keyboard: [] },
  });
}

module.exports = {
  call,
  sendMessage,
  setWebhook,
  deleteWebhook,
  getWebhookInfo,
  getMe,
  getUpdates,
  answerCallbackQuery,
  editMessageReplyMarkup,
  escapeHtml,
  botUsername,
  isConfigured: () => !!token(),
};
