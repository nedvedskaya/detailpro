'use strict';
/**
 * Демо-данные для новой студии.
 *
 * Пустая CRM на старте отпугивает: новый юзер видит «Клиентов нет», «Задач
 * нет», «Транзакций нет» — и не понимает, что куда. Чтобы дать ощущение
 * рабочей системы, после регистрации сразу подкладываем 2 демо-клиента
 * с полным циклом:
 *   • карточка клиента + авто
 *   • запись в календаре (одна выполненная в прошлом, одна в работе сегодня)
 *   • задачи (с привязкой к клиенту и без)
 *   • транзакции (доход от выполненной работы + аванс по текущей)
 *
 * Каждая seed-строка помечается is_demo = TRUE. Это нужно для:
 *   1) чтобы кнопка «Очистить демо» в Профиле могла снести ровно
 *      демо-данные, не трогая реальные карточки, которые юзер уже создал;
 *   2) идемпотентности: повторный запуск seedDemo сначала зачищает
 *      прошлый набор по is_demo, потом сидит заново.
 *
 * Все INSERT-ы идут в одной транзакции (callee передаёт client).
 *
 * @param {object}  client      — pg-клиент внутри транзакции (см. db.cjs withTx)
 * @param {string}  schemaName  — имя per-tenant схемы (studio_xxx)
 * @param {string}  ownerId     — UUID owner-а (saas_meta.users.id)
 * @returns {Promise<{clients:number, tasks:number, records:number, transactions:number}>}
 */

const { queryInSchema } = require('./db.cjs');

async function clearDemo(client, schemaName) {
  // Порядок важен: сначала зависимые (transactions, tasks, client_records,
  // bookings), потом vehicles, потом clients, потом services. Хотя на
  // clients.id висит ON DELETE CASCADE для vehicles/client_records,
  // explicit-удаление безопаснее: если в будущем кто-то поменяет CASCADE
  // на SET NULL, demo-уборка всё равно отработает чисто.
  const tables = [
    'transactions',
    'tasks',
    'client_records',
    'bookings',
    'vehicles',
    'clients',
    'services',
  ];
  let total = 0;
  for (const t of tables) {
    const r = await queryInSchema(
      schemaName,
      `DELETE FROM {{schema}}.${t} WHERE is_demo = TRUE`,
      [],
      client
    );
    total += r.rowCount || 0;
  }
  return { deleted: total };
}

async function seedDemo(client, schemaName, ownerId) {
  // Сначала зачищаем прошлый seed (если был), чтобы повторный вызов
  // «Заполнить демо» не плодил дубликатов.
  await clearDemo(client, schemaName);

  // ── Услуги ────────────────────────────────────────────────────────
  const svc = await queryInSchema(
    schemaName,
    `INSERT INTO {{schema}}.services (name, price, duration, description, is_active, is_demo) VALUES
       ('Полировка кузова', 8000, 180, 'Полная полировка с защитным составом, гарантия 6 мес.', true, TRUE),
       ('Химчистка салона', 5500, 120, 'Глубокая химчистка ткани и пластика',                     true, TRUE)
     RETURNING id`,
    [],
    client
  );
  const serviceIds = svc.rows.map((r) => r.id);

  // ── Клиенты ───────────────────────────────────────────────────────
  // ВАЖНО: UI клиентов хранит марку/модель/VIN/номер в clients.notes
  // как JSON (см. client/src/utils/helpers.ts → normalizeClient,
  // buildClientPayload). Таблица vehicles используется для bookings/
  // client_records (через vehicle_id), но карточка клиента в Клиентах
  // показывает carBrand/carModel из notes-JSON. Если положить в notes
  // обычный текст — поле «Автомобиль» на карточке будет пустым.
  // Заполняем оба места: и notes-JSON (для карточки), и vehicles
  // (для документов / привязки к записям).
  const ivanNotes = JSON.stringify({
    carBrand: 'BMW',
    carModel: 'X5',
    vin: '',
    licensePlate: 'А123ВС777',
    comment: 'Постоянный клиент. Любит полировку каждые 3 месяца.',
  });
  const annaNotes = JSON.stringify({
    carBrand: 'Toyota',
    carModel: 'Camry',
    vin: '',
    licensePlate: 'В456ОР77',
    comment: 'Новый клиент, первое посещение.',
  });
  const cli = await queryInSchema(
    schemaName,
    `INSERT INTO {{schema}}.clients (name, phone, email, source, city, notes, is_demo) VALUES
       ('Иван Петров',    '+7 (999) 123-45-67', 'ivan.petrov@example.com',  'Знакомые',  'Москва',          $1, TRUE),
       ('Анна Смирнова',  '+7 (999) 987-65-43', 'anna.smirnova@example.com','Instagram', 'Санкт-Петербург', $2, TRUE)
     RETURNING id, name`,
    [ivanNotes, annaNotes],
    client
  );
  const clientIvanId = cli.rows.find((r) => r.name === 'Иван Петров').id;
  const clientAnnaId = cli.rows.find((r) => r.name === 'Анна Смирнова').id;

  // ── Авто (привязаны к клиентам) ───────────────────────────────────
  const veh = await queryInSchema(
    schemaName,
    `INSERT INTO {{schema}}.vehicles (client_id, brand, model, year, license_plate, color, mileage, is_demo) VALUES
       ($1, 'BMW',    'X5',    2021, 'А123ВС777', 'Белый', 45000, TRUE),
       ($2, 'Toyota', 'Camry', 2019, 'В456ОР77',  'Серый', 78000, TRUE)
     RETURNING id, client_id`,
    [clientIvanId, clientAnnaId],
    client
  );
  const vehicleIvanId = veh.rows.find((r) => r.client_id === clientIvanId).id;
  const vehicleAnnaId = veh.rows.find((r) => r.client_id === clientAnnaId).id;

  // ── client_records (история работ) ───────────────────────────────
  // Запись 1: выполнена 3 дня назад, оплачена полностью.
  // Запись 2: сегодня, в работе, оплачен аванс.
  const records = await queryInSchema(
    schemaName,
    `INSERT INTO {{schema}}.client_records
        (client_id, vehicle_id, master_id, service_name, description, amount, advance, advance_date,
         date, end_date, time, payment_status, is_paid, is_completed, is_demo) VALUES
       ($1, $2, $3, 'Полировка кузова', 'Полная полировка, защитный состав',
        8000, 0, NULL,
        CURRENT_DATE - INTERVAL '3 days', CURRENT_DATE - INTERVAL '3 days', '14:00',
        'paid',    TRUE,  TRUE,  TRUE),
       ($4, $5, $3, 'Химчистка салона', 'Химчистка ткани сидений + пластик',
        5500, 2000, CURRENT_DATE,
        CURRENT_DATE, NULL, '11:00',
        'advance', FALSE, FALSE, TRUE)
     RETURNING id, client_id`,
    [clientIvanId, vehicleIvanId, ownerId, clientAnnaId, vehicleAnnaId],
    client
  );
  const recordIvanId = records.rows.find((r) => r.client_id === clientIvanId).id;
  const recordAnnaId = records.rows.find((r) => r.client_id === clientAnnaId).id;

  // ── Транзакции (финансы) ─────────────────────────────────────────
  // 8000₽ доход от выполненной работы + 2000₽ аванс от текущей.
  await queryInSchema(
    schemaName,
    `INSERT INTO {{schema}}.transactions
        (type, amount, category, description, date, time, client_id, client_record_id, created_by, is_demo) VALUES
       ('income', 8000, 'Услуги', 'Полировка кузова — Иван Петров (BMW X5)',
        CURRENT_DATE - INTERVAL '3 days', '16:00', $1, $2, $3, TRUE),
       ('income', 2000, 'Услуги', 'Аванс — Анна Смирнова (Toyota Camry, химчистка)',
        CURRENT_DATE, '11:00', $4, $5, $3, TRUE)`,
    [clientIvanId, recordIvanId, ownerId, clientAnnaId, recordAnnaId],
    client
  );

  // ── Задачи ────────────────────────────────────────────────────────
  // 1. Сегодня, привязана к Ивану — «Позвонить» с контекстом клиента
  //    (как раз и работает с улучшением tg-сводки: имя+телефон под title).
  // 2. Завтра, привязана к Анне — согласование.
  // 3. Завтра, без привязки — общая задача студии.
  await queryInSchema(
    schemaName,
    `INSERT INTO {{schema}}.tasks
        (title, description, status, priority, due_date, due_time, client_id, vehicle_id, assigned_to, is_demo) VALUES
       ('Перезвонить и подтвердить запись',
        'Уточнить время приезда на пятницу',
        'pending', 'high', CURRENT_DATE, '12:00',
        $1, $2, $3, TRUE),
       ('Согласовать тип покрытия',
        'Керамика или жидкое стекло — обсудить с клиентом',
        'pending', 'medium', CURRENT_DATE + INTERVAL '1 day', NULL,
        $4, $5, $3, TRUE),
       ('Заказать химию для полировки',
        'Заканчивается полироль и микрофибра',
        'pending', 'medium', CURRENT_DATE + INTERVAL '1 day', NULL,
        NULL, NULL, $3, TRUE)`,
    [clientIvanId, vehicleIvanId, ownerId, clientAnnaId, vehicleAnnaId],
    client
  );

  return {
    clients: 2,
    services: serviceIds.length,
    records: 2,
    transactions: 2,
    tasks: 3,
  };
}

module.exports = {
  seedDemo,
  clearDemo,
};
