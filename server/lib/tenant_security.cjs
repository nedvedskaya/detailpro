'use strict';
/**
 * tenant_security.cjs — runtime-инварианты cross-tenant изоляции.
 *
 * Защищает поверх двух базовых слоёв:
 *   - schema-isolation: каждая студия в своей Postgres-схеме (studio_*),
 *     все queries префиксованы {{schema}}.tablename через safeIdent →
 *     физически нельзя SELECT из чужой схемы.
 *   - req.session.schemaName/studioId: всегда из verifySession (читает
 *     БД), никогда из URL/body.
 *
 * Что НЕ закрыто базовыми слоями (и закрывается здесь):
 *   FK типа `studio_X.bookings.master_id → saas_meta.users.id` — Postgres
 *   FK не знает что master должен быть из ТОЙ ЖЕ студии. saas_meta.users
 *   — общая таблица для всех студий. Атакующий-owner студии A через
 *   devtools может в PUT /bookings/:id подставить `master_id` мастера
 *   из студии B → INSERT/UPDATE пройдёт (FK валиден, user существует),
 *   и данные студий смешаются: бронь A покажет «мастер из B».
 *
 *   Это не утечка чтения (студия A не получит данных B напрямую — они
 *   приходят в JOIN через master_id, но имя/email чужого мастера
 *   подтянутся), но это коррапция бизнес-логики и личных кабинетов.
 *
 * Применять везде, где user-UUID-поле принимается из request body:
 *   master_id, assigned_to, и подобные. created_by всегда из
 *   req.session.userId — для него helper не нужен (там UUID уже
 *   доверенный).
 *
 * Roadmap (defense-in-depth на DB-уровне):
 *   Trigger в 100_tenant_template.sql, который при INSERT/UPDATE OF
 *   master_id/assigned_to делает SELECT проверку user.studio_id =
 *   schema's studio_id и RAISE EXCEPTION при mismatch. Когда будем
 *   делать — в этот файл добавится комментарий «дублируется DB-уровнем».
 */

const { pool } = require('./db.cjs');

/**
 * Проверяет, что user принадлежит указанной студии и активен.
 *
 * Контракт ошибки совместим с handleFieldError из validation.cjs:
 *   throw err.code='FIELD_INVALID' с err.field/err.reason → 400 с
 *   { error: 'field_invalid', field, reason: 'not_in_studio' }.
 * Фронт через translateApiError превратит в «Поле X: пользователь
 * не из этой студии».
 *
 * @param {unknown} userId — UUID из request body (или null/undefined)
 * @param {string} studioId — req.session.studioId (доверенный)
 * @param {string} fieldName — 'master_id' | 'assigned_to' | etc
 * @returns {Promise<string|null>} userId если ок, null если на входе пусто
 * @throws {Error & { code:'FIELD_INVALID', field, reason }}
 */
async function assertUserInStudio(userId, studioId, fieldName) {
  if (userId === null || userId === undefined || userId === '') return null;
  if (typeof userId !== 'string') {
    throw fieldErr(fieldName, 'must_be_uuid');
  }
  // Лёгкая sanity-проверка формата UUID (32 hex + 4 дефиса = 36).
  // Postgres сам бросит invalid_text_representation если формат битый,
  // но raise здесь даёт более понятную 400 ошибку, не 500 generic.
  if (!/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(userId)) {
    throw fieldErr(fieldName, 'must_be_uuid');
  }

  // is_active=true: нельзя назначить дезактивированного юзера, даже если
  // он формально в той же студии. Это и тип-данных-инвариант (UI должен
  // выбирать только из активных), и страховка от race: если master в
  // момент сохранения брони уже уволен — получим 400 «не в студии»
  // вместо silent-сохранения отзыва увольнения.
  const r = await pool.query(
    `SELECT id FROM saas_meta.users
      WHERE id = $1 AND studio_id = $2 AND is_active = true`,
    [userId, studioId]
  );
  if (r.rowCount === 0) {
    throw fieldErr(fieldName, 'not_in_studio');
  }
  return userId;
}

function fieldErr(field, reason) {
  const e = new Error(`field_invalid:${field}:${reason}`);
  e.code = 'FIELD_INVALID';
  e.field = field;
  e.reason = reason;
  return e;
}

module.exports = { assertUserInStudio };
