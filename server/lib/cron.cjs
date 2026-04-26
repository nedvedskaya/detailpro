'use strict';
/**
 * Фоновые периодические задачи SaaS-CRM.
 *
 * На старте сервера (server.cjs → require) ставится setInterval-таймер.
 * Зависимостей вроде node-cron не тянем — нам нужен один-два simpl-job'а в сутки,
 * а unref-нутый setInterval решает это без drift-проблем при коротких аптаймах.
 *
 * JOBS:
 *   1. cleanupActivityLogs   — снос строк activity_logs старше N дней
 *      во всех схемах вида studio_*. Период по умолчанию: 90 дней
 *      (см. план «Админ-панель», вопрос ретенции).
 *   2. cleanupExpiredSessions — обёртка над auth.cjs#cleanupExpiredSessions
 *      (saas_meta.sessions). Полезно даже без UI: чем меньше мёртвых строк,
 *      тем быстрее verifySession.
 *
 * Как запускать:
 *   require('./lib/cron.cjs').start();      // в server.cjs после listen()
 *   require('./lib/cron.cjs').stop();       // в graceful shutdown (опц.)
 *
 * Тестирование «вручную»:
 *   node -e "require('./server/lib/cron.cjs').runOnce().then(console.log)"
 */

const { pool } = require('./db.cjs');
const { cleanupExpiredSessions } = require('./auth.cjs');

const ACTIVITY_RETENTION_DAYS = Number(process.env.ACTIVITY_RETENTION_DAYS) || 90;
const CRON_INTERVAL_MS = Number(process.env.CRON_INTERVAL_MS) || 24 * 60 * 60 * 1000;

let timer = null;

/**
 * Сносит строки activity_logs старше N дней во всех studio_* схемах.
 * Возвращает суммарное количество удалённых строк.
 *
 * Используем динамический список схем (а не saas_meta.studios), чтобы
 * не упасть, если запись про студию удалили, а схема осталась.
 */
async function cleanupActivityLogs(retentionDays = ACTIVITY_RETENTION_DAYS) {
  // information_schema читать дешевле, чем pg_namespace (виден через любого
  // юзера; pg_namespace требует прав на read system catalog).
  const { rows: schemas } = await pool.query(
    `SELECT schema_name
       FROM information_schema.schemata
      WHERE schema_name LIKE 'studio_%'
      ORDER BY schema_name`
  );

  let totalDeleted = 0;
  for (const { schema_name: schema } of schemas) {
    // Имя схемы прошло LIKE 'studio_%' и взято напрямую из information_schema —
    // SQL-инъекция через format() невозможна. Тем не менее экранируем %I
    // как идентификатор для дополнительной защиты.
    try {
      const r = await pool.query(
        `DELETE FROM ${quoteIdent(schema)}.activity_logs
          WHERE created_at < now() - ($1 || ' days')::interval`,
        [String(retentionDays)]
      );
      if (r.rowCount > 0) {
        console.log(`[cron] activity_logs: deleted ${r.rowCount} rows in ${schema}`);
      }
      totalDeleted += r.rowCount;
    } catch (err) {
      // Если в студийной схеме нет таблицы activity_logs (партнёрская схема
      // с тем же префиксом? старая схема без миграции 100?) — просто скипаем.
      console.error(`[cron] activity_logs cleanup failed for ${schema}:`, err.message);
    }
  }
  return totalDeleted;
}

/**
 * Минимальный quote_ident для безопасной интерполяции имени схемы.
 * Postgres-аналог: SELECT quote_ident('studio_x'). Здесь делаем без round-trip.
 */
function quoteIdent(name) {
  return '"' + String(name).replace(/"/g, '""') + '"';
}

/**
 * Прогон всех jobs «один раз». Используется и таймером, и для ручного запуска.
 */
async function runOnce() {
  const startedAt = Date.now();
  const result = { activityLogs: 0, sessions: 0, errors: [] };

  try {
    result.activityLogs = await cleanupActivityLogs();
  } catch (err) {
    console.error('[cron] cleanupActivityLogs failed:', err.message);
    result.errors.push({ job: 'activityLogs', message: err.message });
  }

  try {
    result.sessions = await cleanupExpiredSessions();
    if (result.sessions > 0) {
      console.log(`[cron] sessions: deleted ${result.sessions} expired rows`);
    }
  } catch (err) {
    console.error('[cron] cleanupExpiredSessions failed:', err.message);
    result.errors.push({ job: 'sessions', message: err.message });
  }

  console.log(`[cron] runOnce finished in ${Date.now() - startedAt}ms`);
  return result;
}

/**
 * Запуск планировщика. Идемпотентно: повторный start() не плодит таймеры.
 * Первый прогон — через CRON_INTERVAL_MS, не сразу: на старте сервера
 * Postgres может ещё прогреваться, и DELETE по большим таблицам не лучшее
 * первое действие.
 */
function start() {
  if (timer) return;
  timer = setInterval(() => {
    runOnce().catch((err) => console.error('[cron] runOnce uncaught:', err.message));
  }, CRON_INTERVAL_MS);
  // unref: НЕ держим event loop живым — пусть процесс сможет нормально выйти
  // на SIGTERM, не дожидаясь следующего тика.
  if (typeof timer.unref === 'function') timer.unref();
  console.log(`[cron] scheduled every ${Math.round(CRON_INTERVAL_MS / 60000)} min, retention ${ACTIVITY_RETENTION_DAYS} days`);
}

function stop() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

module.exports = {
  start,
  stop,
  runOnce,
  cleanupActivityLogs,
};
