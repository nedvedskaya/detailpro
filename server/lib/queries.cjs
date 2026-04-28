'use strict';
/**
 * Shared SQL helpers — общие запросы, которые повторялись inline
 * в нескольких routes. Вытаскиваем сюда только те, у которых
 * SELECT-list фиксирован и не зависит от контекста вызова.
 *
 * Если в endpoint'е нужны дополнительные поля (например, studios.plan
 * + cancel_pending + prodamus-реквизиты для отмены подписки) — пишите
 * ad-hoc запрос, а не пытайтесь раздуть этот helper. Over-fetching
 * чужих полей хуже DRY-нарушения.
 */

const { pool } = require('./db.cjs');

/**
 * Базовый контекст текущего юзера: role + studio_id. Используется
 * для проверок «кто это и какой студии он принадлежит» — без
 * привязки к таблице studios. Один SELECT, один индекс по PK.
 *
 * @param {string} userId — UUID из saas_meta.users.id (= req.session.userId)
 * @returns {Promise<{role: string, studio_id: string} | null>}
 */
async function getCurrentUser(userId) {
  const r = await pool.query(
    `SELECT role, studio_id FROM saas_meta.users WHERE id = $1`,
    [userId]
  );
  return r.rows[0] || null;
}

module.exports = { getCurrentUser };
