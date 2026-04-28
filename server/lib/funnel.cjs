'use strict';

/**
 * funnel.cjs — фиксация «первых событий» студии для умной воронки.
 *
 * Каждое из этих полей в saas_meta.studios — таймстемп самого первого
 * события данного типа. Повторные события не сдвигают timestamp
 * (через COALESCE first_X_at, now()).
 *
 * Используется:
 *   • в API-роутах (POST /clients, /client-records, PUT /work-orders, ...)
 *     для отметки прогресса студии по воронке;
 *   • в cron-функции воронки прогрева, которая решает что слать.
 *
 * Правило: вызов markFirstEvent НЕ должен валить основной запрос. Если
 * UPDATE упадёт (FK, network, race) — логируем и идём дальше; пропуск
 * timestamp-а на воронке означает в худшем случае «один лишний пинок
 * от бота», а не порчу данных.
 */

const { pool } = require('./db.cjs');

const ALLOWED_FIELDS = new Set([
  'first_client_at',
  'first_record_at',
  'first_workorder_at',
  'first_acceptance_at',
  'first_transaction_at',
  'first_paid_at',
]);

async function markFirstEvent(studioId, field) {
  if (!studioId) return;
  if (!ALLOWED_FIELDS.has(field)) {
    console.warn('[funnel] unknown field:', field);
    return;
  }
  try {
    // COALESCE гарантирует first-write-wins. ALLOWED_FIELDS-белый список
    // делает интерполяцию безопасной (нельзя пробросить произвольный SQL).
    await pool.query(
      `UPDATE saas_meta.studios SET ${field} = COALESCE(${field}, now()) WHERE id = $1`,
      [studioId]
    );
  } catch (err) {
    console.error(`[funnel] markFirstEvent(${field}) failed for studio ${studioId}:`, err.message);
  }
}

/**
 * Обновляет last_active_at у студии. Вызывается из middleware на каждом
 * authenticated-запросе, но не чаще раза в 5 минут на одну студию,
 * чтобы не нагружать БД на каждый /api/profile или /api/clients.
 */
const lastActiveCache = new Map(); // studioId -> ms
const LAST_ACTIVE_THROTTLE_MS = 5 * 60 * 1000;

async function touchLastActive(studioId) {
  if (!studioId) return;
  const now = Date.now();
  const prev = lastActiveCache.get(studioId) || 0;
  if (now - prev < LAST_ACTIVE_THROTTLE_MS) return;
  lastActiveCache.set(studioId, now);
  try {
    await pool.query(
      `UPDATE saas_meta.studios SET last_active_at = now() WHERE id = $1`,
      [studioId]
    );
  } catch (err) {
    console.error('[funnel] touchLastActive failed:', err.message);
  }
}

module.exports = { markFirstEvent, touchLastActive };
