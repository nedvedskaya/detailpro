'use strict';
/**
 * Унифицированная проверка одноразовых токенов в saas_meta.*.
 *
 * Контекст: в проекте есть несколько таблиц одноразовых токенов с одинаковой
 * семантикой { token, user_id, expires_at, consumed_at }:
 *   - saas_meta.password_reset_tokens — сброс пароля
 *   - saas_meta.tg_link_tokens — привязка Telegram к существующему аккаунту
 *
 * Раньше каждый роут сам делал SELECT FOR UPDATE → if(!row) → if(consumed_at)
 * → if(expired), копипастя 3 ветки с ROLLBACK перед каждым return.
 * Если новый роут забывал одну из проверок (например консьюм) — токен можно
 * было переиспользовать. Этот helper закрывает класс багов разом.
 *
 * Контракт:
 *   - На invalid/used/expired бросает OneTimeTokenError(reason).
 *     Caller внутри withTx → withTx сам сделает ROLLBACK при throw.
 *   - На успех возвращает row с запрошенными колонками.
 *   - НЕ помечает consumed_at — это делает caller отдельным UPDATE,
 *     потому что между «токен валиден» и «consume» часто стоит
 *     роут-специфичная проверка (типа duplicate tg_user_id), и в случае
 *     её провала consume делать НЕ нужно.
 *
 * Использование:
 *   await withTx(async (client) => {
 *     const row = await consumeOneTimeToken(client, 'saas_meta.tg_link_tokens', token);
 *     // row.user_id, row.expires_at, row.consumed_at
 *     // ... роут-специфичная логика
 *     await client.query(
 *       'UPDATE saas_meta.tg_link_tokens SET consumed_at = now() WHERE token = $1',
 *       [token]
 *     );
 *   });
 */

class OneTimeTokenError extends Error {
  /**
   * @param {'invalid'|'used'|'expired'} reason
   */
  constructor(reason) {
    super(`one_time_token_${reason}`);
    this.code = 'ONE_TIME_TOKEN_ERROR';
    this.reason = reason;
  }
}

// Whitelist таблиц — имя интерполируется в SQL без параметризации (PG не
// позволяет $-placeholder в имени таблицы). Чтобы не открывать SQL-injection
// если кто-то прокинет user-input в `table` — фиксируем разрешённый набор.
const ALLOWED_TABLES = new Set([
  'saas_meta.password_reset_tokens',
  'saas_meta.tg_link_tokens',
]);

/**
 * Атомарно блокирует и проверяет токен. Бросает OneTimeTokenError
 * на любой невалидный кейс. На успех возвращает row.
 *
 * @param {import('pg').PoolClient} client — pg-клиент с открытой транзакцией
 *   (BEGIN сделан caller-ом, обычно через withTx)
 * @param {string} table — fully-qualified имя из ALLOWED_TABLES
 * @param {unknown} token
 * @param {object} [opts]
 * @param {string[]} [opts.columns] — какие колонки выбрать дополнительно
 *   (expires_at и consumed_at добавятся автоматически — нужны для проверок)
 * @returns {Promise<object>}
 */
async function consumeOneTimeToken(client, table, token, opts = {}) {
  if (!ALLOWED_TABLES.has(table)) {
    throw new Error(`one_time_token: unknown table ${table}`);
  }
  if (typeof token !== 'string' || !token) {
    throw new OneTimeTokenError('invalid');
  }

  const requested = Array.isArray(opts.columns) && opts.columns.length > 0
    ? opts.columns
    : ['user_id'];
  // expires_at + consumed_at нужны helper'у самому. Дедуплицируем на случай
  // если caller их тоже запросил.
  const select = Array.from(new Set([...requested, 'expires_at', 'consumed_at'])).join(', ');

  const r = await client.query(
    `SELECT ${select} FROM ${table} WHERE token = $1 FOR UPDATE`,
    [token]
  );
  const row = r.rows[0];
  if (!row) throw new OneTimeTokenError('invalid');
  if (row.consumed_at) throw new OneTimeTokenError('used');
  if (new Date(row.expires_at).getTime() < Date.now()) {
    throw new OneTimeTokenError('expired');
  }
  return row;
}

module.exports = {
  OneTimeTokenError,
  consumeOneTimeToken,
};
