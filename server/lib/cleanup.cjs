'use strict';
/**
 * Retention policy для брошенных студий.
 *
 * Логика:
 *   • Студия считается «брошенной», если access_until истекло > 30 дней
 *     назад И за это время не было новых платежей со статусом 'paid'.
 *   • За 7 дней до удаления (т.е. через 23 дня после истечения)
 *     отправляем владельцу TG-предупреждение, чтобы успел оплатить или
 *     экспортировать данные. Запоминаем в studios.cleanup_warning_sent_at,
 *     чтобы не спамить ежедневно.
 *   • Ровно через 30 дней после истечения — удаляем:
 *       1. UPDATE consents.user_id = NULL для юзеров студии (FK SET NULL,
 *          нужно для ФЗ-152 — лог согласий не уничтожаем).
 *       2. UPDATE payments.studio_id = NULL для платежей этой студии
 *          (финансовый учёт сохраняем).
 *       3. DELETE FROM saas_meta.studios — каскадно снимет users,
 *          sessions, payment_intents, tg_link_tokens, password_reset_
 *          tokens, tg_user_states, referral_events, referred_by станет
 *          NULL у потенциальных детей-студий.
 *       4. DROP SCHEMA studio_xxx CASCADE — все таблицы со внутренними
 *          FK дропаются разом.
 *
 * Защита от bug в скрипте:
 *   • Лимит на batch (DELETE_BATCH_LIMIT) — даже если запрос вдруг
 *     возвратит сотню кандидатов, удалим максимум 10 за прогон. Cron
 *     раз в сутки → разгребём за 10 дней.
 *   • dryRun-режим: сначала прогоним руками с `node scripts/cleanup-
 *     dry-run.cjs`, увидим список — уже потом включаем в cron.
 *   • Каждое удаление логируется в [SEC] с full-метаданными.
 *
 * Что НЕ удаляется:
 *   • Оплачиваемые студии (access_until > now()).
 *   • Студии с paid-платежом за последние RETENTION_AFTER_EXPIRY_DAYS
 *     (защита от race: оплатили после истечения, но webhook опоздал).
 *   • saas_meta.payments — остаются с studio_id = NULL для бухгалтерии.
 *   • saas_meta.consents — остаются с user_id = NULL для ФЗ-152.
 *   • saas_meta.webhook_log — никаких FK, не трогаем.
 */

const { pool, withTx } = require('./db.cjs');
const { safeIdent } = require('./tenant.cjs');
const { securityLog, SEVERITY } = require('./security_log.cjs');
const tg = require('./telegram.cjs');
const { applyGender } = require('./gender.cjs');

// Через сколько дней после истечения access_until удаляем студию.
const RETENTION_AFTER_EXPIRY_DAYS = Number(process.env.RETENTION_AFTER_EXPIRY_DAYS) || 30;
// За сколько дней до удаления шлём предупреждение.
const WARNING_BEFORE_DAYS = Number(process.env.RETENTION_WARNING_DAYS) || 7;
// Максимум студий за один прогон cron-а.
const DELETE_BATCH_LIMIT = Number(process.env.RETENTION_BATCH_LIMIT) || 10;
const WARNING_BATCH_LIMIT = Number(process.env.RETENTION_WARNING_BATCH) || 50;

const APP_ORIGIN = (process.env.APP_ORIGIN || 'https://detailprocrm.ru').replace(/\/$/, '');

// ──────────────────────────────────────────────────────────────────────
// Поиск кандидатов.
// ──────────────────────────────────────────────────────────────────────

/**
 * Студии, которые пора удалить. Два независимых пути:
 *
 *   A. Брошенные: access_until истекло > RETENTION_AFTER_EXPIRY_DAYS дней
 *      назад и нет недавних платежей со статусом paid (юзер не платит,
 *      молчит, бросил аккаунт).
 *
 *   B. Запрошенные на удаление: owner нажал «Удалить аккаунт» в Профиле
 *      (deletion_requested_at) и прошло > RETENTION_AFTER_EXPIRY_DAYS
 *      дней. По 152-ФЗ это право субъекта — удаляем НЕЗАВИСИМО от
 *      того, есть ли активная подписка. Деньги не возвращаются (см.
 *      раздел 3.6 / 10.2 Договора-оферты).
 *
 * Возвращаем максимум DELETE_BATCH_LIMIT записей с метаданными owner-а
 * для логов и финального notification.
 */
async function findExpiredStudios(client = pool) {
  const r = await client.query(
    `SELECT s.id, s.schema_name, s.display_name, s.plan, s.access_until,
            s.created_at, s.deletion_requested_at,
            u.id      AS owner_id,
            u.email   AS owner_email,
            u.tg_chat_id,
            u.gender  AS owner_gender,
            u.name    AS owner_name
       FROM saas_meta.studios s
       LEFT JOIN saas_meta.users u
              ON u.studio_id = s.id AND u.role = 'owner'
      WHERE
        -- A. Брошенный: подписка истекла > N дней назад и нет недавних
        -- paid-платежей (защита от удаления юзера, который только что заплатил
        -- и webhook ещё не обновил access_until).
        ( s.access_until < (now() - ($1 || ' days')::interval)
          AND NOT EXISTS (
            SELECT 1 FROM saas_meta.payments p
             WHERE p.studio_id = s.id
               AND p.status = 'paid'
               AND p.received_at > (now() - ($1 || ' days')::interval)
          )
        )
        OR
        -- B. Юзер запросил удаление > N дней назад (152-ФЗ право субъекта).
        ( s.deletion_requested_at IS NOT NULL
          AND s.deletion_requested_at < (now() - ($1 || ' days')::interval)
        )
      ORDER BY COALESCE(s.deletion_requested_at, s.access_until) ASC
      LIMIT $2`,
    [String(RETENTION_AFTER_EXPIRY_DAYS), DELETE_BATCH_LIMIT]
  );
  return r.rows;
}

/**
 * Студии, которым пора отправить warning: access_until истекло >
 * (RETENTION - WARNING_BEFORE) дней назад, ещё не отправляли warning,
 * нет paid-платежей за RETENTION дней.
 *
 * Окно: [RETENTION-WARNING, RETENTION] дней после истечения. Например
 * при retention=30, warning=7 → 23-30 дней после истечения.
 */
async function findStudiosForWarning(client = pool) {
  const r = await client.query(
    `SELECT s.id, s.display_name, s.access_until,
            u.tg_chat_id, u.id AS owner_id, u.gender AS owner_gender, u.email AS owner_email
       FROM saas_meta.studios s
       LEFT JOIN saas_meta.users u
              ON u.studio_id = s.id AND u.role = 'owner'
      WHERE s.access_until < (now() - ($1 || ' days')::interval)
        AND s.access_until > (now() - ($2 || ' days')::interval)
        AND s.cleanup_warning_sent_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM saas_meta.payments p
           WHERE p.studio_id = s.id
             AND p.status = 'paid'
             AND p.received_at > (now() - ($2 || ' days')::interval)
        )
      ORDER BY s.access_until ASC
      LIMIT $3`,
    [
      String(RETENTION_AFTER_EXPIRY_DAYS - WARNING_BEFORE_DAYS),
      String(RETENTION_AFTER_EXPIRY_DAYS),
      WARNING_BATCH_LIMIT,
    ]
  );
  return r.rows;
}

// ──────────────────────────────────────────────────────────────────────
// Warning.
// ──────────────────────────────────────────────────────────────────────

async function sendWarning(studio, opts = {}) {
  const dryRun = !!opts.dryRun;
  const daysUntilDelete = WARNING_BEFORE_DAYS;

  const text = applyGender(
    `⚠️ <b>Скоро удалим данные студии</b>\n\n` +
    `Доступ к «${tg.escapeHtml(studio.display_name || 'студии')}» истёк, и через ` +
    `${daysUntilDelete} дней мы удалим всю информацию: клиентов, записи, документы, финансы.\n\n` +
    `Это происходит автоматически, чтобы не копились брошенные студии в системе.\n\n` +
    `<b>Что можно сделать:</b>\n` +
    `• Оформить подписку — данные сохранятся, доступ продлится: ${APP_ORIGIN}/profile\n` +
    `• Если студия больше не нужна, можешь ничего не делать. Через ${daysUntilDelete} дней всё снесётся само.\n\n` +
    `Если ты оплатил{а} и видишь это сообщение по ошибке, напиши в поддержку через /help.`,
    studio.owner_gender
  );

  if (dryRun) {
    console.log(`[cleanup] DRY-RUN warning → studio=${studio.id} (${studio.display_name}), tg=${studio.tg_chat_id || 'no-tg'}`);
    return;
  }

  // Шлём warning только если есть TG-чат у владельца. Email-канала пока
  // нет, добавим если будет нужно.
  if (studio.tg_chat_id) {
    await tg.sendMessage({
      chatId: studio.tg_chat_id,
      userId: studio.owner_id,
      kind: 'cleanup_warning',
      text,
    });
  }

  // Помечаем что warning отправили — даже если TG-канала не было,
  // чтобы не пытаться каждый день. Когда канал появится — оставшиеся дни
  // потеряются, это OK.
  await pool.query(
    `UPDATE saas_meta.studios SET cleanup_warning_sent_at = now() WHERE id = $1`,
    [studio.id]
  );

  securityLog({
    severity: SEVERITY.INFO,
    event: 'studio.cleanup_warning_sent',
    studio_id: studio.id,
    owner_email: studio.owner_email,
    has_tg: !!studio.tg_chat_id,
    access_until: studio.access_until,
  });
}

// ──────────────────────────────────────────────────────────────────────
// Удаление.
// ──────────────────────────────────────────────────────────────────────

async function deleteStudio(studio, opts = {}) {
  const dryRun = !!opts.dryRun;

  if (dryRun) {
    console.log(`[cleanup] DRY-RUN delete → studio=${studio.id} schema=${studio.schema_name} ` +
      `expired=${studio.access_until} owner=${studio.owner_email || '(no owner)'}`);
    return { dryRun: true };
  }

  // Лог ДО операции — на случай если что-то упадёт, у нас будет след «начали».
  securityLog({
    severity: SEVERITY.WARNING,
    event: 'studio.cleanup_delete_start',
    studio_id: studio.id,
    schema_name: studio.schema_name,
    owner_email: studio.owner_email,
    access_until: studio.access_until,
    created_at: studio.created_at,
  });

  let droppedSchema = false;
  await withTx(async (client) => {
    // 1. Снимаем consent.user_id (FK ON DELETE SET NULL — но если миграция
    //    013 ещё не накатилась на этом инстансе, явный UPDATE гарантирует
    //    что DELETE FROM users не упадёт).
    await client.query(
      `UPDATE saas_meta.consents
          SET user_id = NULL
        WHERE user_id IN (SELECT id FROM saas_meta.users WHERE studio_id = $1)`,
      [studio.id]
    );

    // 2. Снимаем payments.studio_id — финансовый учёт сохраняем.
    await client.query(
      `UPDATE saas_meta.payments SET studio_id = NULL WHERE studio_id = $1`,
      [studio.id]
    );

    // 3. DELETE FROM studios — каскадно снесёт users, sessions,
    //    payment_intents, tg_link_tokens, password_reset_tokens,
    //    tg_user_states, referral_events, и поставит SET NULL на
    //    studios.referred_by у потенциальных «детей».
    await client.query(`DELETE FROM saas_meta.studios WHERE id = $1`, [studio.id]);

    // 4. DROP SCHEMA — внутри schema живут все клиентские данные
    //    (clients, bookings, work_orders, и т.д.). CASCADE дропает
    //    таблицы и FK между ними, всё за одну DDL.
    //    safeIdent вернёт `"studio_xxx"` с экранированными кавычками,
    //    проверит что имя соответствует regex (никаких SQL-инъекций).
    const escapedSchema = safeIdent(studio.schema_name);
    await client.query(`DROP SCHEMA IF EXISTS ${escapedSchema} CASCADE`);
    droppedSchema = true;
  });

  securityLog({
    severity: SEVERITY.WARNING,
    event: 'studio.cleanup_delete_done',
    studio_id: studio.id,
    schema_name: studio.schema_name,
    owner_email: studio.owner_email,
    access_until: studio.access_until,
    created_at: studio.created_at,
    schema_dropped: droppedSchema,
  });

  return { deleted: true };
}

// ──────────────────────────────────────────────────────────────────────
// Главная точка — вызывается cron-ом (или вручную из dry-run скрипта).
// ──────────────────────────────────────────────────────────────────────

async function runCleanup(opts = {}) {
  const dryRun = !!opts.dryRun;
  const startedAt = Date.now();
  const result = { warningsSent: 0, studiosDeleted: 0, errors: [] };

  // 1. Warnings
  let warnings = [];
  try {
    warnings = await findStudiosForWarning();
  } catch (err) {
    console.error('[cleanup] findStudiosForWarning failed:', err.message);
    result.errors.push({ stage: 'find_warnings', message: err.message });
  }

  for (const s of warnings) {
    try {
      await sendWarning(s, { dryRun });
      result.warningsSent++;
    } catch (err) {
      console.error(`[cleanup] sendWarning failed for studio ${s.id}:`, err.message);
      result.errors.push({ stage: 'send_warning', studio_id: s.id, message: err.message });
    }
  }

  // 2. Deletions
  let candidates = [];
  try {
    candidates = await findExpiredStudios();
  } catch (err) {
    console.error('[cleanup] findExpiredStudios failed:', err.message);
    result.errors.push({ stage: 'find_expired', message: err.message });
  }

  for (const s of candidates) {
    try {
      await deleteStudio(s, { dryRun });
      result.studiosDeleted++;
    } catch (err) {
      console.error(`[cleanup] deleteStudio failed for studio ${s.id}:`, err.message);
      result.errors.push({ stage: 'delete', studio_id: s.id, message: err.message });
      securityLog({
        severity: SEVERITY.ERROR,
        event: 'studio.cleanup_delete_failed',
        studio_id: s.id,
        schema_name: s.schema_name,
        error: err.message,
      });
    }
  }

  const summary = {
    ...result,
    durationMs: Date.now() - startedAt,
    dryRun,
    candidatesFound: candidates.length,
    warningsCandidates: warnings.length,
  };
  console.log(`[cleanup] runCleanup ${dryRun ? '(DRY-RUN) ' : ''}finished:`, JSON.stringify(summary));
  return summary;
}

module.exports = {
  runCleanup,
  // exposed для unit-тестов и dry-run-скрипта:
  findExpiredStudios,
  findStudiosForWarning,
  sendWarning,
  deleteStudio,
  // настройки (read-only, для интроспекции в тестах)
  config: {
    RETENTION_AFTER_EXPIRY_DAYS,
    WARNING_BEFORE_DAYS,
    DELETE_BATCH_LIMIT,
    WARNING_BATCH_LIMIT,
  },
};
