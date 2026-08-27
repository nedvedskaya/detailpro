'use strict';
/**
 * Точка входа production-сервера.
 * Запуск:  node server/server.cjs
 *
 * Перед запуском должно быть выполнено:
 *   1. .env заполнен (DB_*, SESSION_*, PRODAMUS_SECRET_KEY и т.д.)
 *   2. npm run init  — применил saas_meta + tenant template
 *
 * Graceful shutdown:
 *   На SIGTERM/SIGINT закрываем HTTP-сервер (перестаём принимать новые
 *   соединения), даём текущим запросам 10 секунд, потом гасим pg-pool.
 */

// IPv4-first для DNS-резолва. Причина: api.telegram.org имеет AAAA-запись,
// а IPv6-маршрут от нашего RU-хостинга (Timeweb) до TG — режется
// (Connection timed out). По IPv4 всё ходит за 130мс. Без этой строки
// Node.js предпочтёт IPv6 и любой fetch к TG будет таймаутить.
require('node:dns').setDefaultResultOrder('ipv4first');

require('dotenv').config();

// ──────────────────────────────────────────────────────────────────────
// Fail-fast валидация env. Зачем:
//   Без этой проверки сервер тихо стартует если в .env пропущен
//   критичный секрет — некоторые роуты будут падать в runtime, и хуже —
//   некоторые ветки кода работают «как-то» с пустым секретом
//   (HMAC-проверка вебхука вернёт false на любую валидную подпись →
//   все платежи отвергнутся; password reset не отправит TG; и т.п.).
//
//   Лучше упасть на старте с понятным сообщением, чем поймать «404
//   ничего не работает» через час прода.
//
// Что НЕ проверяем здесь:
//   - PRODAMUS_API_BASE — опциональный (без него работает локальный
//     cancel, но не REST-отмена в Prodamus); см. .env.example.
//   - TELEGRAM_BOT_TOKEN — без него выключается polling, но HTTP сам
//     по себе запустится (чтобы можно было запустить dev/staging без TG).
// ──────────────────────────────────────────────────────────────────────
function validateEnvOrExit() {
  const required = [
    'NODE_ENV',
    'DB_HOST', 'DB_PORT', 'DB_USER', 'DB_PASSWORD', 'DB_NAME',
  ];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    console.error('[saas-crm] FATAL: missing required env vars:', missing.join(', '));
    console.error('[saas-crm] см. .env.example и заполни .env перед стартом.');
    process.exit(1);
  }

  // В production — secure-cookie должен быть включён. Если кто-то
  // деплоит с NODE_ENV=production, но забыл `SESSION_COOKIE_SECURE=true` —
  // routes/auth.cjs форсирует true в проде, но это документируем здесь
  // для прозрачности.
  const isProd = process.env.NODE_ENV === 'production';
  if (isProd) {
    // PRODAMUS_SECRET_KEY критичен для проверки HMAC вебхуков. Без него
    // ВСЕ webhook'и Prodamus будут отвергнуты с invalid_signature →
    // пользователи не получат активацию подписки после оплаты.
    if (!process.env.PRODAMUS_SECRET_KEY) {
      console.warn('[saas-crm] WARNING: PRODAMUS_SECRET_KEY не задан — webhook оплаты не будут проходить HMAC-проверку.');
    }
    // TELEGRAM_WEBHOOK_SECRET защищает /api/telegram от подделки
    // updates от не-Telegram'а (если webhook режим был бы включён).
    // У нас polling-режим, но если кто-то прокинет webhook — без
    // секрета любой POST на /api/telegram будет принят.
    if (!process.env.TELEGRAM_WEBHOOK_SECRET && process.env.TELEGRAM_BOT_TOKEN) {
      console.warn('[saas-crm] WARNING: TELEGRAM_WEBHOOK_SECRET не задан — webhook-режим Telegram незащищён (polling-режим OK).');
    }
  }
}
validateEnvOrExit();

const app = require('./app.cjs');
const { close: closePool } = require('./lib/db.cjs');
const cron = require('./lib/cron.cjs');
const tgPolling = require('./lib/telegram_polling.cjs');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';

const server = app.listen(PORT, HOST, () => {
  console.log(`[saas-crm] listening on http://${HOST}:${PORT}`);
  // Фоновые job'ы (90-дневная чистка activity_logs, expired sessions).
  // start() идемпотентен и сам unref-ает таймер — не мешает graceful shutdown.
  cron.start();
  // Telegram long-polling — наш RU-хостинг блокирован для входящих от TG,
  // поэтому сервер сам стучит в getUpdates. Не падает если токена нет.
  tgPolling.start();
});

server.on('error', (err) => {
  console.error('[saas-crm] server error:', err.message);
  process.exit(1);
});

let shuttingDown = false;
async function shutdown(signal, exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[saas-crm] received ${signal}, shutting down...`);

  const forceTimer = setTimeout(() => {
    console.error('[saas-crm] forced shutdown after 15s');
    process.exit(1);
  }, 15_000);
  forceTimer.unref();

  cron.stop();
  tgPolling.stop();
  server.close(async () => {
    try {
      await closePool();
      console.log('[saas-crm] graceful shutdown complete');
      process.exit(exitCode);
    } catch (err) {
      console.error('[saas-crm] pool close error:', err.message);
      process.exit(1);
    }
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err);
  void shutdown('uncaughtException', 1);
});
