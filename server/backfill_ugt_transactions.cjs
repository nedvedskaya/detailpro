'use strict';
/**
 * Одноразовый backfill транзакций для записей в studio_ugt_tuners.
 *
 * Контекст: миграция из ЮГТ СРМ перенесла client_records и transactions
 * как было в источнике. Но в источнике далеко не для каждой записи с
 * advance/paid была своя транзакция — Илья создавал транзакции ad-hoc.
 *
 * В Detail Pro же логика приложения (App.tsx::createRecordTransactions)
 * всегда создаёт транзакции автоматически при создании записи с авансом
 * или оплатой. Поэтому после прямой SQL-вставки записей в Detail Pro
 * получается несоответствие: записи помечены оплаченными, но транзакций
 * под них нет → в Финансах сумм не видно.
 *
 * Скрипт пробегает по client_records, проверяет какие транзакции уже
 * есть (через client_record_id), и создаёт недостающие по той же логике
 * что App.tsx::createRecordTransactions:
 *   • advance > 0:     income «Аванс: {service_name}»  amount=advance, date=advance_date или date
 *   • payment_status='paid' AND remaining > 0: income «Оплата: {service_name}»  amount=amount-advance, date=record.date
 *
 * Категория: ищет «Услуги» с type=income в studio_ugt_tuners.categories
 * (дефолтный seed). Если не найдена — оставляет NULL.
 *
 * Идемпотентен: повторный запуск ничего не дублирует, потому что
 * проверяет существующие транзакции по client_record_id и описанию.
 *
 * Запуск:
 *   node server/backfill_ugt_transactions.cjs            # dry-run
 *   node server/backfill_ugt_transactions.cjs --apply    # пишет
 */

require('dotenv').config();

const { pool, withTx, close } = require('./lib/db.cjs');

const APPLY = process.argv.includes('--apply');
const TARGET_SCHEMA = 'studio_ugt_tuners';
const TGT = '"studio_ugt_tuners"';

async function main() {
  console.log(`\n${APPLY ? '🚀 WET-RUN (--apply)' : '🔍 DRY-RUN (no changes)'}`);
  console.log(`target: ${TARGET_SCHEMA}\n`);

  // 1. Найти id категории «Услуги» (income) — для авто-категории транзакций.
  const catRes = await pool.query(
    `SELECT id FROM ${TGT}.categories WHERE name = 'Услуги' AND type = 'income' LIMIT 1`
  );
  const servicesCategoryId = catRes.rows[0]?.id ?? null;
  console.log(`категория «Услуги» (income): ${servicesCategoryId ?? 'НЕ НАЙДЕНА (будет NULL)'}`);

  // 2. Записи, которые должны иметь транзакции (advance>0 или paid).
  const recsRes = await pool.query(`
    SELECT cr.id, cr.client_id, c.name AS client_name, cr.service_name,
           cr.amount::float AS amount, cr.advance::float AS advance,
           cr.advance_date, cr.date, cr.payment_status, cr.is_paid
      FROM ${TGT}.client_records cr
      LEFT JOIN ${TGT}.clients c ON c.id = cr.client_id
     WHERE cr.advance > 0 OR cr.payment_status = 'paid' OR cr.is_paid = true
     ORDER BY cr.date, cr.id
  `);

  // 3. Какие транзакции уже привязаны к каким записям (по client_record_id).
  const existingTxRes = await pool.query(`
    SELECT client_record_id, description, amount::float AS amount
      FROM ${TGT}.transactions
     WHERE client_record_id IS NOT NULL
  `);
  const existingByRecord = new Map(); // record_id → Set<descPrefix>
  for (const t of existingTxRes.rows) {
    if (!existingByRecord.has(t.client_record_id)) {
      existingByRecord.set(t.client_record_id, new Set());
    }
    // Префикс «Аванс:» или «Оплата:» — этого достаточно для идемпотентности.
    const prefix = t.description?.startsWith('Аванс:') ? 'advance'
      : t.description?.startsWith('Оплата:') ? 'payment'
      : 'other';
    existingByRecord.get(t.client_record_id).add(prefix);
  }

  // 4. Собираем что надо вставить.
  const toInsert = []; // [{record_id, kind, amount, description, date}]
  for (const r of recsRes.rows) {
    const exists = existingByRecord.get(r.id) ?? new Set();
    const service = r.service_name || 'Услуга';

    // Аванс.
    if (r.advance > 0 && !exists.has('advance')) {
      toInsert.push({
        record_id: r.id,
        client_id: r.client_id,
        client_name: r.client_name,
        kind: 'advance',
        amount: r.advance,
        description: `Аванс: ${service}`,
        date: r.advance_date || r.date,
      });
    }

    // Оплата (остаток).
    if ((r.payment_status === 'paid' || r.is_paid) && r.amount > 0) {
      const remaining = r.amount - (r.advance || 0);
      if (remaining > 0 && !exists.has('payment')) {
        toInsert.push({
          record_id: r.id,
          client_id: r.client_id,
          client_name: r.client_name,
          kind: 'payment',
          amount: remaining,
          description: `Оплата: ${service}`,
          date: r.date,
        });
      }
    }
  }

  console.log(`\nрассмотрено записей: ${recsRes.rows.length}`);
  console.log(`существующих транзакций (с client_record_id): ${existingTxRes.rows.length}`);
  console.log(`будет создано транзакций: ${toInsert.length}`);

  if (toInsert.length === 0) {
    console.log('нечего делать — все авансы/оплаты уже отражены в transactions.');
    return;
  }

  // Печать первых 5 для просмотра.
  console.log('\nпервые 5 кандидатов:');
  for (const t of toInsert.slice(0, 5)) {
    console.log(`  ${t.kind} | record=${t.record_id} | ${t.amount} ₽ | ${t.description} | ${t.date}`);
  }

  // 5. Вставка одной транзакцией.
  await withTx(async (client) => {
    let inserted = 0;
    for (const t of toInsert) {
      await client.query(
        `INSERT INTO ${TGT}.transactions
           (type, amount, category_id, category, description, date,
            booking_id, client_record_id, client_id, client_name, created_by,
            tags, is_demo)
         VALUES ('income', $1, $2, NULL, $3, $4, NULL, $5, $6, $7, NULL,
                 '[]'::jsonb, false)`,
        [t.amount, servicesCategoryId, t.description, t.date, t.record_id, t.client_id, t.client_name]
      );
      inserted++;
    }
    console.log(`\n✓ вставлено транзакций: ${inserted}`);

    if (!APPLY) {
      console.log('⛔ DRY-RUN: ROLLBACK. Запусти с --apply для записи.');
      throw new Error('__DRY_RUN_ROLLBACK__');
    }
    console.log('✅ COMMIT.');
  }).catch((err) => {
    if (err.message === '__DRY_RUN_ROLLBACK__') return;
    throw err;
  });

  // Финальный счёт.
  const finalCount = await pool.query(`SELECT COUNT(*)::int AS n FROM ${TGT}.transactions`);
  console.log(`\nитого transactions в ${TARGET_SCHEMA}: ${finalCount.rows[0].n}`);
}

main()
  .then(() => close())
  .then(() => process.exit(0))
  .catch(async (err) => {
    console.error('\n❌ FAIL:', err.message);
    if (err.stack) console.error(err.stack);
    try { await close(); } catch (_) {}
    process.exit(1);
  });
