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

require('dotenv').config();

const app = require('./app.cjs');
const { close: closePool } = require('./lib/db.cjs');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';

const server = app.listen(PORT, HOST, () => {
  console.log(`[saas-crm] listening on http://${HOST}:${PORT}`);
});

server.on('error', (err) => {
  console.error('[saas-crm] server error:', err.message);
  process.exit(1);
});

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[saas-crm] received ${signal}, shutting down...`);

  const forceTimer = setTimeout(() => {
    console.error('[saas-crm] forced shutdown after 15s');
    process.exit(1);
  }, 15_000);
  forceTimer.unref();

  server.close(async () => {
    try {
      await closePool();
      console.log('[saas-crm] graceful shutdown complete');
      process.exit(0);
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
  // не валим процесс — пусть pm2/systemd рестартит при необходимости
});
