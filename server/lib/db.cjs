'use strict';
/**
 * pg-pool обёртка для SaaS-CRM.
 *
 * Назначение:
 *   1. Один общий пул на процесс (pg.Pool под капотом — node-postgres).
 *   2. SSL-конфигурация для managed-кластера TimeWeb (через DB_CA_CERT_PATH).
 *   3. queryInSchema — единственный безопасный способ интерполировать имя
 *      схемы клиента в SQL. Имя схемы — идентификатор, его НЕЛЬЗЯ передавать
 *      через $1; защита — strict-валидация + двойное цитирование (см. ./tenant).
 *   4. withTx — обёртка для транзакций, гарантирующая COMMIT/ROLLBACK и
 *      возвращение клиента в пул.
 *
 * Почему не ORM:
 *   В существующем CRM (Crm-new-main/server/index.cjs) все запросы написаны
 *   через pg raw. Для миграции 1:1 мы остаёмся на raw — иначе пришлось бы
 *   переписывать 60+ запросов.
 */

const fs = require('node:fs');
const { Pool } = require('pg');
const { safeIdent } = require('./tenant.cjs');

// ──────────────────────────────────────────────────────────────────────
// Конфигурация пула.
// max=20 — для 10-50 студий хватит. Если упрёмся — поднимем + поставим pgbouncer.
// idleTimeoutMillis=30s — быстрее освобождать коннекшены к managed-БД.
// connectionTimeoutMillis=5s — не висеть бесконечно при сетевой проблеме.
// ──────────────────────────────────────────────────────────────────────
function buildSslConfig() {
  const ca = process.env.DB_CA_CERT_PATH;
  if (!ca) return false; // локалка без SSL
  if (!fs.existsSync(ca)) {
    throw new Error('DB_CA_CERT_PATH указан, но файл не найден: ' + ca);
  }
  return {
    ca: fs.readFileSync(ca, 'utf8'),
    rejectUnauthorized: true,
    // CA-цепочка проверяется (rejectUnauthorized=true), но hostname-проверку
    // отключаем: TimeWeb выдаёт серт на DNS типа b20c38b...twc1.net, а DB_HOST
    // у нас обычно IP кластера. Проверка identity дублирует CA-проверку в нашем
    // случае, потому что мы явно знаем, к какому IP конектимся (.env).
    checkServerIdentity: () => undefined,
  };
}

const pool = new Pool({
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT) || 5432,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  ssl: buildSslConfig(),
  max: Number(process.env.DB_POOL_MAX) || 20,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

pool.on('error', (err) => {
  // idle-клиент в пуле упал — логируем, но не валим процесс
  console.error('[db] idle pool client error:', err.message);
});

// ──────────────────────────────────────────────────────────────────────
// Базовый query — обычный pg.query.
// ──────────────────────────────────────────────────────────────────────
function query(sql, params) {
  return pool.query(sql, params);
}

// ──────────────────────────────────────────────────────────────────────
// queryInSchema — интерполирует {{schema}} в шаблонной строке через safeIdent.
//
// Использование (вне транзакции):
//   await queryInSchema(req.session.schema_name,
//     'SELECT * FROM {{schema}}.clients WHERE id = $1',
//     [clientId]);
//
// Внутри транзакции (withTx) — передавайте client четвёртым аргументом:
//   await withTx(async (client) => {
//     await queryInSchema(schemaName, 'INSERT INTO {{schema}}...', [...], client);
//   });
//
// Подмена идёт через split/join, а не через template literals, потому что
// рантайм-значение схемы должно пройти валидацию ВНУТРИ этой функции
// (а не на стороне вызывающего, где могут забыть).
// ──────────────────────────────────────────────────────────────────────
function queryInSchema(schemaName, sql, params, client) {
  const ident = safeIdent(schemaName); // бросит, если схема невалидна
  if (typeof sql !== 'string' || !sql.includes('{{schema}}')) {
    throw new Error('queryInSchema: SQL должен содержать плейсхолдер {{schema}}');
  }
  const finalSql = sql.split('{{schema}}').join(ident);
  // Если client передан (внутри транзакции) — выполняем на нём, иначе — на pool.
  return (client || pool).query(finalSql, params);
}

// ──────────────────────────────────────────────────────────────────────
// Транзакция. В callback приходит client с теми же методами .query.
// Внутри callback можно использовать queryInSchema(schema, sql, params, client).
// ──────────────────────────────────────────────────────────────────────
async function withTx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) { /* ignore */ }
    throw err;
  } finally {
    client.release();
  }
}


// ──────────────────────────────────────────────────────────────────────
// Graceful shutdown. Вызывать из server/index.cjs на SIGTERM.
// ──────────────────────────────────────────────────────────────────────
async function close() {
  await pool.end();
}

module.exports = {
  pool,
  query,
  queryInSchema,
  withTx,
  close,
};
