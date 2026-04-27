'use strict';
/**
 * Long-polling клиент Telegram Bot API.
 *
 * Зачем:
 *   У нас RU-хостинг (Timeweb, Москва). TG-серверы не могут входить к нам
 *   (TSPU блокирует/route flap), их POST на /api/telegram/webhook стабильно
 *   отдаёт «Connection timed out». При этом ИСХОДЯЩИЙ TLS на api.telegram.org
 *   с нашего IPv4 ходит без проблем.
 *
 *   Поэтому переключаемся с webhook на polling: сервер сам периодически
 *   стучит в TG getUpdates(timeout=25) и обрабатывает апдейты тем же
 *   диспатчером, что и webhook (см. routes/telegram.cjs:dispatchUpdate).
 *
 * Гарантии:
 *   - Один процесс — один поллер. Запускается при старте сервера, если
 *     TELEGRAM_BOT_TOKEN задан и TELEGRAM_USE_POLLING != '0'. Перед стартом
 *     сносит webhook (TG не даёт совмещать polling+webhook → 409 Conflict).
 *   - offset持ится в памяти (last update_id + 1). При рестарте начинаем с 0
 *     → TG отдаст накопившиеся апдейты за последние 24 часа. Идемпотентность
 *     dispatchUpdate (через saas_meta.tg_processed_updates) гарантирует, что
 *     дважды один и тот же /start мы не отрисуем.
 *   - На сетевые ошибки — backoff (1с → 2 → 4 → 8 → 30, потом удерживаем 30с).
 *     На 401/404 от TG — лог + остановка (бесполезно ретраить).
 *
 * Лайфтайм:
 *   start() — поднимает loop. Идемпотентен: повторный вызов ничего не делает.
 *   stop()  — выставляет stopped=true; текущий getUpdates до-ждётся завершения,
 *             следующая итерация увидит флаг и выйдет. Вызывается из shutdown.
 */

const tg = require('./telegram.cjs');
const { dispatchUpdate } = require('../routes/telegram.cjs');

let running = false;
let stopRequested = false;
let lastOffset = 0;

async function start() {
  if (running) return;
  if (!tg.isConfigured()) {
    console.log('[tg-poll] TELEGRAM_BOT_TOKEN не задан — polling выключен');
    return;
  }
  if (process.env.TELEGRAM_USE_POLLING === '0') {
    console.log('[tg-poll] выключен (TELEGRAM_USE_POLLING=0) — режим webhook');
    return;
  }

  running = true;
  stopRequested = false;
  console.log('[tg-poll] starting long-polling…');

  // Снимаем webhook — иначе getUpdates вернёт 409.
  // drop_pending_updates=false: пусть копятся, обработаем сами через polling.
  try {
    const r = await tg.deleteWebhook();
    if (r.ok) console.log('[tg-poll] webhook удалён, переходим на polling');
  } catch (e) {
    console.error('[tg-poll] deleteWebhook failed:', e.message);
  }

  // Запускаем loop, не блокируя caller.
  loop().catch((err) => {
    console.error('[tg-poll] fatal loop error:', err);
    running = false;
  });
}

function stop() {
  if (!running) return;
  console.log('[tg-poll] stop requested');
  stopRequested = true;
}

async function loop() {
  let backoffMs = 1000;
  const MAX_BACKOFF = 30_000;

  while (!stopRequested) {
    let r;
    try {
      r = await tg.getUpdates({ offset: lastOffset, timeout: 25 });
    } catch (e) {
      console.error('[tg-poll] getUpdates threw:', e.message);
      r = { ok: false, error: 'exception', message: e.message };
    }

    if (!r.ok) {
      // 401 — токен невалидный, polling смысла нет.
      if (r.status === 401) {
        console.error('[tg-poll] 401 Unauthorized: проверьте TELEGRAM_BOT_TOKEN. Останавливаюсь.');
        running = false;
        return;
      }
      // 409 — кто-то ещё держит webhook/polling. Лог и backoff.
      if (r.status === 409) {
        console.error('[tg-poll] 409 Conflict: пытаемся снова через', backoffMs, 'ms');
      } else {
        console.error('[tg-poll] getUpdates failed:', r.error || r.status, r.message || '');
      }
      await sleep(backoffMs);
      backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF);
      continue;
    }

    backoffMs = 1000; // сброс backoff после успеха
    const updates = Array.isArray(r.result) ? r.result : [];

    for (const upd of updates) {
      try {
        await dispatchUpdate(upd);
      } catch (err) {
        console.error('[tg-poll] dispatch failed for update', upd.update_id, ':', err);
        // Не прерываем — двигаем offset дальше, чтобы битый апдейт не зациклил.
      }
      // Сдвигаем offset: TG считает, что мы подтвердили все update_id <= offset-1.
      lastOffset = Math.max(lastOffset, upd.update_id + 1);
    }
  }

  running = false;
  console.log('[tg-poll] stopped');
}

function sleep(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

module.exports = { start, stop };
