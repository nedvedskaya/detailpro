'use strict';
/**
 * resolveServices — превращает «массив строк услуг от фронта» в каноничный
 * snapshot для записи в client_records.services (JSONB).
 *
 * Каждая входная строка — либо «из прайса», либо «ручная»:
 *   • Из прайса:    { service_id: 12 }                         → fetch имя+цену из {{schema}}.services
 *   • Ручная (custom): { name: 'Снять плёнку', price: 1500 }   → service_id=null
 *
 * Возвращает:
 *   • services    — массив snapshot'ов [{service_id, name, price}, ...]
 *   • amount      — сумма всех price (DECIMAL-совместимое число)
 *   • serviceName — все имена через ', ' (для legacy-поля service_name)
 *
 * Защита от подмены: для строк с service_id берём актуальные имя+цену
 * из БД, игнорируем то что фронт прислал в name/price для них. Это значит
 * клиент не может «купить полировку за 1 рубль» отправив подмененный
 * price — мы перезапросим из таблицы services.
 *
 * Throws Error со status=400 если:
 *   • один из service_id не найден в текущей схеме (service_not_found)
 *   • кастомная строка без name или с пустым name (service_name_required)
 *   • кастомная строка без валидной price (service_price_invalid)
 */

const { queryInSchema } = require('./db.cjs');

const NAME_MAX_LEN = 255;

async function resolveServices(schemaName, rawServices, pgClient = null) {
  if (!Array.isArray(rawServices) || rawServices.length === 0) {
    return { services: [], amount: 0, serviceName: '' };
  }

  // Делим на 2 группы. Сохраняем индекс, чтобы потом восстановить порядок.
  const fromPrice = []; // { idx, service_id }
  const custom    = []; // { idx, name, price }

  rawServices.forEach((row, idx) => {
    if (!row || typeof row !== 'object') {
      const e = new Error('service_row_invalid'); e.status = 400; throw e;
    }
    const sid = Number(row.service_id);
    if (Number.isInteger(sid) && sid > 0) {
      fromPrice.push({ idx, service_id: sid });
      return;
    }
    // Ручная строка
    const name = typeof row.name === 'string' ? row.name.trim() : '';
    if (!name) {
      const e = new Error('service_name_required'); e.status = 400; throw e;
    }
    if (name.length > NAME_MAX_LEN) {
      const e = new Error('service_name_too_long'); e.status = 400; throw e;
    }
    const price = Number(row.price);
    if (!Number.isFinite(price) || price < 0) {
      const e = new Error('service_price_invalid'); e.status = 400; throw e;
    }
    custom.push({ idx, name, price });
  });

  // Запрашиваем актуальные данные из прайс-листа одной query.
  let priceMap = new Map();
  if (fromPrice.length > 0) {
    const ids = fromPrice.map((r) => r.service_id);
    const r = await queryInSchema(
      schemaName,
      `SELECT id, name, price FROM {{schema}}.services WHERE id = ANY($1::int[])`,
      [ids],
      pgClient
    );
    priceMap = new Map(r.rows.map((row) => [row.id, row]));
    // Проверяем что все запрошенные id найдены — иначе кто-то прислал
    // удалённую/чужую услугу.
    for (const { service_id } of fromPrice) {
      if (!priceMap.has(service_id)) {
        const e = new Error('service_not_found');
        e.status = 400;
        e.detail = `service_id=${service_id}`;
        throw e;
      }
    }
  }

  // Восстанавливаем порядок строк как в body.
  const services = new Array(rawServices.length);
  for (const { idx, service_id } of fromPrice) {
    const row = priceMap.get(service_id);
    services[idx] = {
      service_id,
      name: row.name,
      price: Number(row.price),
    };
  }
  for (const { idx, name, price } of custom) {
    services[idx] = { service_id: null, name, price };
  }

  const amount = services.reduce((s, x) => s + Number(x.price || 0), 0);
  const serviceName = services.map((x) => x.name).join(', ');

  return { services, amount, serviceName };
}

module.exports = { resolveServices };
