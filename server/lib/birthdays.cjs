'use strict';
/**
 * Напоминания о днях рождения клиентов.
 *
 * Каждое утро (через cron, server/lib/cron.cjs) проходим по всем
 * клиентам всех активных студий: если у клиента указан birth_date
 * и сегодня его день рождения — создаём задачу-напоминание
 * «Поздравить с днём рождения {имя}» с приоритетом 'high', датой =
 * сегодня, привязкой к клиенту (client_id).
 *
 * Поле birth_date — VARCHAR(20) свободного формата:
 *   • '15.07.1990' (точечный, dd.mm.yyyy) — основной из UI
 *   • '1990-07-15' (ISO) — мог быть импортирован
 *   • любая хрень → пропускаем без шума
 *
 * Идемпотентность: задача не создаётся повторно, если уже есть
 * задача с таким client_id, due_date=сегодня и title начинается на
 * 'Поздравить'. Это значит можно гонять cron хоть каждый час —
 * дубликатов не будет.
 *
 * Помимо cron-режима, helper ensureBirthdayTaskForClient() вызывается
 * сразу при POST/PUT /clients — на случай если юзер добавил клиента
 * с ДР=сегодня (cron подхватит только завтра).
 */

const { pool, queryInSchema } = require('./db.cjs');

// Парсит birth_date в {day, month}. Возвращает null если формат
// нераспознан или дата невалидна.
function parseBirthDate(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const s = raw.trim();
  if (!s) return null;

  // Формат dd.mm.yyyy / dd.mm.yy / dd.mm — точечный, как в UI.
  const dot = s.split('.');
  if (dot.length >= 2) {
    const d = parseInt(dot[0], 10);
    const m = parseInt(dot[1], 10);
    if (Number.isFinite(d) && Number.isFinite(m) && d >= 1 && d <= 31 && m >= 1 && m <= 12) {
      return { day: d, month: m };
    }
  }

  // Формат ISO: yyyy-mm-dd. Парсится через Date (надёжно), но не
  // используем new Date(s) для точечного формата — там month парсится
  // как нулевой (00), js даёт January.
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
    const dt = new Date(s);
    if (!Number.isNaN(dt.getTime())) {
      return { day: dt.getUTCDate(), month: dt.getUTCMonth() + 1 };
    }
  }

  return null;
}

function isBirthdayToday(raw, now = new Date()) {
  const bd = parseBirthDate(raw);
  if (!bd) return false;
  return bd.day === now.getDate() && bd.month === (now.getMonth() + 1);
}

/**
 * Создаёт задачу-напоминание на сегодня для одного клиента, если её
 * ещё нет. Возвращает true если задача создана, false если уже была.
 *
 * @param {object}  client    pg-клиент в транзакции (опционально)
 * @param {string}  schemaName  per-tenant schema (studio_xxx)
 * @param {object}  clientData { id, name } из {{schema}}.clients
 */
async function ensureBirthdayTaskForClient(pgClient, schemaName, clientData) {
  const { id: clientId, name } = clientData;
  if (!clientId || !name) return false;

  // Проверяем — нет ли уже задачи на сегодня для этого клиента с
  // префиксом «Поздравить». Префикс — наш маркер «это birthday-задача»,
  // отличает от ручной «Поздравить лично, выдал визитку» которую юзер
  // мог создать сам.
  const existing = await queryInSchema(
    schemaName,
    `SELECT id FROM {{schema}}.tasks
      WHERE client_id = $1
        AND due_date = CURRENT_DATE
        AND title LIKE 'Поздравить с днём рождения%'
      LIMIT 1`,
    [clientId],
    pgClient
  );
  if (existing.rowCount > 0) return false;

  // priority=high, без assigned_to (общая задача студии — увидят
  // owner/manager в утренней TG-сводке и в разделе Задачи).
  await queryInSchema(
    schemaName,
    `INSERT INTO {{schema}}.tasks
       (title, description, status, priority, due_date, client_id)
     VALUES ($1, $2, 'pending', 'high', CURRENT_DATE, $3)`,
    [
      `Поздравить с днём рождения ${name}`,
      'Авто-напоминание: сегодня день рождения у клиента. Позвонить, написать в Telegram или подарить скидку.',
      clientId,
    ],
    pgClient
  );
  return true;
}

/**
 * Проходит по всем активным студиям → всем клиентам с указанным
 * birth_date → создаёт задачи на сегодня. Вызывается из cron.runOnce().
 *
 * Возвращает {studios, clientsChecked, tasksCreated, errors}.
 */
async function runBirthdayReminders() {
  const summary = { studios: 0, clientsChecked: 0, tasksCreated: 0, errors: [] };

  const studios = await pool.query(
    `SELECT id, schema_name FROM saas_meta.studios
      WHERE schema_name IS NOT NULL
        AND is_active = TRUE
        AND plan <> 'cancelled'`
  );
  summary.studios = studios.rowCount;

  const now = new Date();

  for (const s of studios.rows) {
    try {
      const clients = await queryInSchema(
        s.schema_name,
        `SELECT id, name, birth_date FROM {{schema}}.clients
          WHERE birth_date IS NOT NULL
            AND birth_date <> ''`
      );
      summary.clientsChecked += clients.rowCount;

      for (const c of clients.rows) {
        if (!isBirthdayToday(c.birth_date, now)) continue;
        try {
          const created = await ensureBirthdayTaskForClient(null, s.schema_name, c);
          if (created) summary.tasksCreated += 1;
        } catch (err) {
          console.error(
            `[birthdays] task create failed for client ${c.id} in ${s.schema_name}:`,
            err.message
          );
          summary.errors.push({ studio: s.id, client: c.id, message: err.message });
        }
      }
    } catch (err) {
      console.error(`[birthdays] studio ${s.id} (${s.schema_name}) failed:`, err.message);
      summary.errors.push({ studio: s.id, message: err.message });
    }
  }

  console.log(`[birthdays] runOnce: studios=${summary.studios}, ` +
    `clients=${summary.clientsChecked}, created=${summary.tasksCreated}`);
  return summary;
}

module.exports = {
  runBirthdayReminders,
  ensureBirthdayTaskForClient,
  isBirthdayToday,
  parseBirthDate,
};
