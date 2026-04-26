'use strict';
/**
 * Audit-helper: запись в {schema}.activity_logs.
 *
 * Раньше функция жила локально в routes/tenant.cjs и принимала Express-объект
 * `req`. Когда логирование понадобилось в admin.cjs и auth.cjs (а login/logout
 * вообще работают ДО middleware, у которой есть req.session), помощник
 * пришлось вынести в lib и сделать сигнатуру явной — без зависимости от req.
 *
 * Использование:
 *   const { logAction } = require('../lib/audit.cjs');
 *   logAction({
 *     schemaName: req.session.schemaName,
 *     userId:     req.session.userId,
 *     userName:   req.session.userName,
 *     action:     'create',     // create | update | delete | login | logout
 *                               // | block | unblock | password_reset
 *     entityType: 'client',     // client | vehicle | booking | task |
 *                               // transaction | client_record | user | session
 *     entityId:   123,          // SERIAL или UUID — entity_id уже TEXT
 *     entityName: 'Иванов И.И.',
 *     details:    'optional',
 *     ip:         req.ip,
 *   }).catch(...);  // fire-and-forget, ловим в catch чтобы не сваливать процесс
 *
 * 90-дневная ретенция чистится cron-ом — см. server/lib/cron.cjs.
 */

const { queryInSchema } = require('./db.cjs');

/**
 * @param {object} p
 * @param {string} p.schemaName
 * @param {string} [p.userId]
 * @param {string} [p.userName]
 * @param {string} p.action
 * @param {string} [p.entityType]
 * @param {string|number} [p.entityId]
 * @param {string} [p.entityName]
 * @param {string} [p.details]
 * @param {string} [p.ip]
 * @returns {Promise<void>}
 */
function logAction({
  schemaName,
  userId,
  userName,
  action,
  entityType,
  entityId,
  entityName,
  details,
  ip,
}) {
  if (!schemaName || !action) {
    return Promise.resolve();
  }
  return queryInSchema(
    schemaName,
    `INSERT INTO {{schema}}.activity_logs
       (user_id, user_name, action, entity_type, entity_id, entity_name, details, ip_address)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      userId || null,
      userName || null,
      action,
      entityType || null,
      entityId !== undefined && entityId !== null ? String(entityId) : null,
      entityName || null,
      details || null,
      ip || null,
    ]
  ).then(() => undefined)
   .catch((err) => {
      // Логирование — не критичная операция. Пишем в stderr и продолжаем.
      console.error('[audit]', action, entityType || '', err.message);
   });
}

module.exports = { logAction };
