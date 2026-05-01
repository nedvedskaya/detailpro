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
const { FIVE_MINUTES_MS, ONE_DAY_MS } = require('./constants.cjs');
const { cleanupExpiredSessions } = require('./auth.cjs');
const reminders = require('./reminders.cjs');
const funnelDispatcher = require('./funnel_dispatcher.cjs');
const cleanup = require('./cleanup.cjs');
const birthdays = require('./birthdays.cjs');

const ACTIVITY_RETENTION_DAYS = Number(process.env.ACTIVITY_RETENTION_DAYS) || 90;
const CRON_INTERVAL_MS = Number(process.env.CRON_INTERVAL_MS) || ONE_DAY_MS;
// Тикер TG-напоминаний. 5 минут — окна 9:00-9:09 и 55-65 мин его покрывают.
const REMINDERS_INTERVAL_MS = Number(process.env.REMINDERS_INTERVAL_MS) || FIVE_MINUTES_MS;

let timer = null;
let remindersTimer = null;

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
 * Чистка протухших payment_intents — двухпроходная стратегия:
 *   • token живёт 60 минут (см. lib/payments.cjs#PAYMENT_INTENT_TTL_MS)
 *   • после истечения держим ещё 7 дней для аудита (вдруг webhook опоздал
 *     и придёт «после смерти»; тогда лог покажет, что мы его видели и не
 *     консьюмнули)
 *   • по истечении 7 дней — DELETE
 *
 * Использованные intent (consumed_at IS NOT NULL) держим 30 дней — они
 * связаны с конкретным order_id, удобны для расследования.
 */
async function cleanupPaymentIntents() {
  const r = await pool.query(
    `DELETE FROM saas_meta.payment_intents
       WHERE (consumed_at IS NULL AND expires_at < now() - interval '7 days')
          OR (consumed_at IS NOT NULL AND consumed_at < now() - interval '30 days')`
  );
  if (r.rowCount > 0) {
    console.log(`[cron] payment_intents: deleted ${r.rowCount} rows`);
  }
  return r.rowCount;
}

/**
 * Прогон всех jobs «один раз». Используется и таймером, и для ручного запуска.
 */
async function runOnce() {
  const startedAt = Date.now();
  const result = {
    activityLogs: 0, sessions: 0, paymentIntents: 0,
    studiosCleanup: null,
    errors: [],
  };

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

  try {
    result.paymentIntents = await cleanupPaymentIntents();
  } catch (err) {
    console.error('[cron] cleanupPaymentIntents failed:', err.message);
    result.errors.push({ job: 'paymentIntents', message: err.message });
  }

  // Retention брошенных студий — warnings + delete. dryRun-флаг можно
  // включить через ENV для прогона на проде без удалений (RETENTION_DRY_RUN=true).
  try {
    const dryRun = (process.env.RETENTION_DRY_RUN || '').toLowerCase() === 'true';
    result.studiosCleanup = await cleanup.runCleanup({ dryRun });
  } catch (err) {
    console.error('[cron] studio retention cleanup failed:', err.message);
    result.errors.push({ job: 'studioRetention', message: err.message });
  }

  // Дни рождения клиентов: создаём задачу-напоминание в день ДР каждому
  // клиенту, у кого указан birth_date. Запускается раз в сутки (тот же
  // 24-часовой тик); идемпотентно — повторный прогон не плодит дубликатов.
  try {
    result.birthdays = await birthdays.runBirthdayReminders();
  } catch (err) {
    console.error('[cron] birthdays failed:', err.message);
    result.errors.push({ job: 'birthdays', message: err.message });
  }

  // Воронка прогрева в Telegram. Шлёт T+1, +5, +14, +24, +29 после
  // окончания access_until для двух сегментов (никогда не платил vs
  // платил-истёк). Окно отправки — 11:00 локалки студии. Идемпотентно
  // через UNIQUE на funnel_events (studio_id, event_kind).
  try {
    const dryRun = (process.env.FUNNEL_DRY_RUN || '').toLowerCase() === 'true';
    result.funnel = await funnelDispatcher.runFunnel({ dryRun });
  } catch (err) {
    console.error('[cron] funnel dispatcher failed:', err.message);
    result.errors.push({ job: 'funnel', message: err.message });
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

  // Отдельный таймер для напоминаний — частый тик, не смешиваем с тяжёлым
  // cleanup'ом раз в сутки. Идемпотентность гарантирует UNIQUE-индексы
  // в saas_meta.tg_sent_reminders, поэтому случайное двойное срабатывание
  // (e.g. из-за overlap'а тиков) не приведёт к дублям.
  if (!remindersTimer) {
    remindersTimer = setInterval(() => {
      reminders.runOnce().catch((err) =>
        console.error('[cron] reminders.runOnce uncaught:', err.message));
    }, REMINDERS_INTERVAL_MS);
    if (typeof remindersTimer.unref === 'function') remindersTimer.unref();
    console.log(`[cron] reminders scheduled every ${Math.round(REMINDERS_INTERVAL_MS / 60000)} min`);
  }
}

function stop() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  if (remindersTimer) {
    clearInterval(remindersTimer);
    remindersTimer = null;
  }
}

module.exports = {
  start,
  stop,
  runOnce,
  cleanupActivityLogs,
};
