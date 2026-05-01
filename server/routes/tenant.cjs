'use strict';
/**
 * Per-tenant CRUD routes (порт из Crm-new-main/server/index.cjs:1460-2186).
 *
 * Все хендлеры:
 *   1. Защищены requireAuth + requireActiveStudio (применяется в app.cjs).
 *   2. Используют queryInSchema(req.session.schemaName, ...) — имя схемы
 *      проходит safeIdent внутри db.cjs. Никогда не конкатенируем напрямую.
 *   3. Отбрасывают branch_id (single-tenant baggage).
 *   4. JOINы на пользователей идут на saas_meta.users (master_name, assigned_to_name).
 *
 * Логирование activity:
 *   logAction(req, action, entityType, entityId, entityName, details) пишет
 *   в studio_xxx.activity_logs. Не блокирует ответ — fire-and-forget.
 *
 * Что НЕ портируем:
 *   - /api/branches/*       — мульти-точек больше нет
 *   - /api/subscriptions/*  — биллинг живёт в saas_meta + Продамус
 *   - /api/payments/*       — saas_meta.payments + webhooks
 *   - /api/user-subscriptions/* — то же
 *   - GET /api/recaptcha-site-key — captcha убрана
 *
 * Порт хендлеров /api/admin/users (управление пользователями студии)
 * вынесен в routes/admin.cjs.
 */

const express = require('express');
const { queryInSchema, query, withTx } = require('../lib/db.cjs');
const { requireRole, sectionGuard } = require('../lib/middleware.cjs');
const { logFromReq: logAction } = require('../lib/audit.cjs');
const { parseId, assertString, assertOptionalString, assertArrayOfStrings, parsePagination, handleFieldError } = require('../lib/validation.cjs');
const { assertUserInStudio } = require('../lib/tenant_security.cjs');
const birthdays = require('../lib/birthdays.cjs');
const { resolveServices } = require('../lib/services_resolver.cjs');
const { markFirstEvent } = require('../lib/funnel.cjs');

const router = express.Router();

// logAction(req, action, entityType, entityId, entityName, details) →
// тонкая обёртка над audit.logAction, см. server/lib/audit.cjs#logFromReq.
// Импортируется как алиас выше — сигнатура исторически зовётся logAction
// и менять все 30+ вызовов в этом файле смысла нет.

// Секционные гарды — заменяют старый canWrite/canWriteTasks.
// Уровни: 'edit' (полный доступ), 'view' (только чтение), 'none' (скрыто).
// Для пользователей без JSON permissions используется фолбэк на роль.
const canWriteClients  = sectionGuard('clients',  'edit');
const canWriteCalendar = sectionGuard('calendar', 'edit');
const canWriteFinance  = sectionGuard('finance',  'edit');
const canViewFinanceGrd = sectionGuard('finance', 'view');
const canWriteTasks    = sectionGuard('tasks',    'edit');

// Алиас на parseId() из lib/validation.cjs — оставлен под старым именем,
// чтобы не править все вызовы в этом файле (~50+). Семантика та же:
// возвращает null для невалидных id, иначе int4.
const badId = parseId;
function nonEmptyString(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

// Лимиты для tags (теги транзакций / бронирований).
// 20 тегов на запись хватает с запасом — UI больше не покажет, и это
// ограничивает payload размером ~1KB (max 20 × 50 chars).
// Раньше tags принимался как `JSON.stringify(tags || [])` без проверки —
// атакующий мог прислать `{foo: 1}`, объект, массив объектов; UI/PDF на
// этом ломался. assertArrayOfStrings гарантирует flat array<string>.
const TAGS_MAX_ITEMS = 20;
const TAGS_MAX_LEN = 50;
function normalizeTags(raw, fieldName = 'tags') {
  return assertArrayOfStrings(raw, fieldName, TAGS_MAX_ITEMS, TAGS_MAX_LEN);
}

// ══════════════════════════════════════════════════════════════════════
// CLIENTS
// ══════════════════════════════════════════════════════════════════════

router.get('/clients', async (req, res, next) => {
  const r = await queryInSchema(
    req.session.schemaName,
    `SELECT id, name, phone, email, city, source, notes, birth_date, avatar, created_at, updated_at
       FROM {{schema}}.clients ORDER BY created_at DESC`
  );
  res.json(r.rows);
});

// Лимиты длин для clients-полей. Раньше длины не проверялись — атакующий
// мог через UI отправить 100MB-строку в `notes`, упереться в DB-лимит и
// получить 500 (плюс сожжённую память на сериализацию). Жёстко режем
// здесь, на роуте, до похода в БД.
const CLIENT_NAME_MAX = 200;
const CLIENT_PHONE_MAX = 40;
const CLIENT_EMAIL_MAX = 254;       // RFC 5321
const CLIENT_CITY_MAX = 100;
const CLIENT_SOURCE_MAX = 100;
const CLIENT_NOTES_MAX = 5000;

router.post('/clients', canWriteClients, async (req, res, next) => {
  const { name, phone, email, notes, source, city, birth_date, avatar } = req.body || {};
  let nameC, phoneC, emailC, notesC, sourceC, cityC;
  try {
    nameC   = assertString(name, 'name', CLIENT_NAME_MAX);
    phoneC  = assertOptionalString(phone, 'phone', CLIENT_PHONE_MAX);
    emailC  = assertOptionalString(email, 'email', CLIENT_EMAIL_MAX);
    notesC  = assertOptionalString(notes, 'notes', CLIENT_NOTES_MAX);
    sourceC = assertOptionalString(source, 'source', CLIENT_SOURCE_MAX);
    cityC   = assertOptionalString(city, 'city', CLIENT_CITY_MAX);
  } catch (err) { if (handleFieldError(err, res)) return; throw err; }

  const r = await queryInSchema(
    req.session.schemaName,
    `INSERT INTO {{schema}}.clients (name, phone, email, notes, source, city, birth_date, avatar)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
    [nameC, phoneC, emailC, notesC, sourceC, cityC, birth_date || null, avatar || null]
  );
  logAction(req, 'create', 'client', r.rows[0].id, r.rows[0].name);
  // Помечаем первое создание клиента для воронки прогрева (no-op для повторных).
  void markFirstEvent(req.session.studioId, 'first_client_at');

  // Если у клиента указан ДР=сегодня — сразу создаём задачу-напоминание,
  // чтобы юзер не ждал cron'а до следующих суток (best-effort, ошибка
  // создания задачи не должна валить создание клиента).
  if (birthdays.isBirthdayToday(r.rows[0].birth_date)) {
    try {
      await birthdays.ensureBirthdayTaskForClient(null, req.session.schemaName, r.rows[0]);
    } catch (err) {
      console.error(`[clients] ensureBirthdayTask failed for ${r.rows[0].id}:`, err.message);
    }
  }

  res.status(201).json(r.rows[0]);
});

router.put('/clients/:id', canWriteClients, async (req, res, next) => {
  const id = badId(req.params.id);
  if (!id) return res.status(400).json({ error: 'invalid_id' });
  const { name, phone, email, notes, source, city, birth_date, avatar } = req.body || {};
  let nameC, phoneC, emailC, notesC, sourceC, cityC;
  try {
    nameC   = assertString(name, 'name', CLIENT_NAME_MAX);
    phoneC  = assertOptionalString(phone, 'phone', CLIENT_PHONE_MAX);
    emailC  = assertOptionalString(email, 'email', CLIENT_EMAIL_MAX);
    notesC  = assertOptionalString(notes, 'notes', CLIENT_NOTES_MAX);
    sourceC = assertOptionalString(source, 'source', CLIENT_SOURCE_MAX);
    cityC   = assertOptionalString(city, 'city', CLIENT_CITY_MAX);
  } catch (err) { if (handleFieldError(err, res)) return; throw err; }

  const r = await queryInSchema(
    req.session.schemaName,
    `UPDATE {{schema}}.clients
        SET name=$1, phone=$2, email=$3, notes=$4, source=$5, city=$6, birth_date=$7,
            avatar = COALESCE($8, avatar), updated_at = now()
      WHERE id=$9 RETURNING *`,
    [nameC, phoneC, emailC, notesC, sourceC, cityC, birth_date || null,
     avatar !== undefined ? avatar : null, id]
  );
  if (!r.rows[0]) return res.status(404).json({ error: 'client_not_found' });
  logAction(req, 'update', 'client', id, r.rows[0].name);

  // Аналогично POST: если юзер только что выставил ДР=сегодня, не ждём
  // cron. Идемпотентность ensureBirthdayTaskForClient гарантирует, что
  // задача не задвоится, даже если уже была создана раньше.
  if (birthdays.isBirthdayToday(r.rows[0].birth_date)) {
    try {
      await birthdays.ensureBirthdayTaskForClient(null, req.session.schemaName, r.rows[0]);
    } catch (err) {
      console.error(`[clients] ensureBirthdayTask failed for ${id}:`, err.message);
    }
  }

  res.json(r.rows[0]);
});

router.put('/clients/:id/avatar', canWriteClients, async (req, res, next) => {
  const id = badId(req.params.id);
  if (!id) return res.status(400).json({ error: 'invalid_id' });
  const { avatar } = req.body || {};
  const r = await queryInSchema(
    req.session.schemaName,
    `UPDATE {{schema}}.clients SET avatar=$1, updated_at=now() WHERE id=$2 RETURNING id, avatar`,
    [avatar || null, id]
  );
  if (!r.rows[0]) return res.status(404).json({ error: 'client_not_found' });
  res.json(r.rows[0]);
});

router.delete('/clients/:id', canWriteClients, async (req, res, next) => {
  const id = badId(req.params.id);
  if (!id) return res.status(400).json({ error: 'invalid_id' });
  await queryInSchema(req.session.schemaName, `DELETE FROM {{schema}}.clients WHERE id=$1`, [id]);
  logAction(req, 'delete', 'client', id);
  res.json({ ok: true });
});

/**
 * POST /api/clients/bulk
 *
 * Массовый импорт клиентской базы (Профиль → Студия → «Импорт клиентов»).
 * Тело: { rows: [{ client: {...}, vehicle?: {...} }, ...], strategy }
 *   strategy ∈ 'skip' | 'overwrite' | 'create_new' — что делать при
 *   совпадении нормализованного телефона с существующим клиентом.
 *
 * Идёт ОДНОЙ транзакцией: либо все строки применяются, либо ничего —
 * иначе на 4000-й строке падает по сети, а у пользователя в БД остаются
 * полузагруженные клиенты, и непонятно, с какой строки продолжать.
 *
 * Лимит 5000 строк — защита от случайной заливки 100k. Если кому-то нужно
 * больше — пусть бьёт на куски руками; за раз импортировать гигантскую
 * базу всё равно неудобно (нет UI для долгого прогресса).
 *
 * Доступ: только owner/manager. Master не импортирует — у него и так
 * read-only по клиентам.
 */
router.post('/clients/bulk', canWriteClients, async (req, res, next) => {
  try {
    const { rows, strategy } = req.body || {};
    if (!Array.isArray(rows) || rows.length === 0) {
      return res.status(400).json({ error: 'empty_payload' });
    }
    if (rows.length > 5000) {
      return res.status(413).json({ error: 'too_many_rows', limit: 5000 });
    }
    const STRATEGIES = new Set(['skip', 'overwrite', 'create_new']);
    const strat = STRATEGIES.has(strategy) ? strategy : 'skip';

    const schemaName = req.session.schemaName;

    // Нормализованный телефон → только цифры, ведущая 8 → 7. Точно так же
    // как фронт парсит из шаблона — иначе дубликаты искались бы по строке
    // «+7 (920) 610-18-41» != «8 920 610 18 41», что бессмысленно.
    const normalizePhone = (raw) => {
      if (!raw || typeof raw !== 'string') return null;
      let digits = raw.replace(/\D/g, '');
      if (!digits) return null;
      if (digits.startsWith('8')) digits = '7' + digits.slice(1);
      if (!digits.startsWith('7')) digits = '7' + digits;
      return digits.slice(0, 11);
    };

    // UI клиентов исторически хранит carBrand/carModel/vin/licensePlate
    // в ОДНОМ JSON-поле `notes` (см. helpers.ts → normalizeClient/buildClientPayload
    // и documents.cjs → JSON.parse(client.notes)). Если из импорта мы кладём
    // в `notes` сырой текст пользователя ("Любит кварц"), а в `vehicles` —
    // отдельную строку, то в карточке клиента поле «Автомобиль» останется
    // пустым: парсер не найдёт carBrand в JSON. Чтобы импорт согласовывался
    // с тем, что показывает UI, упаковываем notes в тот же JSON-формат.
    const buildNotesJson = ({ comment, vehicle }) => {
      const carBrand = vehicle && typeof vehicle.brand === 'string' ? vehicle.brand.trim() : '';
      const carModel = vehicle && typeof vehicle.model === 'string' ? vehicle.model.trim() : '';
      const licensePlate = vehicle && typeof vehicle.license_plate === 'string' ? vehicle.license_plate.trim() : '';
      const cleanComment = typeof comment === 'string' ? comment.trim() : '';
      // Если совсем ничего нет — пишем NULL, не пустой JSON,
      // чтобы старые карточки без машин не получали лишний шум.
      if (!carBrand && !carModel && !licensePlate && !cleanComment) return null;
      return JSON.stringify({
        carBrand,
        carModel,
        vin: '',
        licensePlate,
        comment: cleanComment,
      });
    };

    const result = await withTx(async (client) => {
      // Загружаем существующие телефоны студии один раз — далее in-memory.
      // На 50к клиентов это всё ещё <5 МБ, не проблема.
      const existing = await queryInSchema(
        schemaName,
        `SELECT id, name, phone FROM {{schema}}.clients WHERE phone IS NOT NULL`,
        [],
        client
      );
      const phoneToId = new Map();
      for (const r of existing.rows) {
        const norm = normalizePhone(r.phone);
        if (norm) phoneToId.set(norm, r.id);
      }

      const stats = { created: 0, updated: 0, skipped: 0 };
      const errors = [];

      for (let i = 0; i < rows.length; i++) {
        const row = rows[i] || {};
        const c = row.client || {};
        const v = row.vehicle || null;
        const rowNum = i + 1;

        const name = typeof c.name === 'string' ? c.name.trim() : '';
        if (!name) {
          errors.push({ row: rowNum, reason: 'name_required' });
          continue;
        }

        const phoneNorm = normalizePhone(c.phone);
        const existingId = phoneNorm ? phoneToId.get(phoneNorm) : null;

        const notesJson = buildNotesJson({ comment: c.notes, vehicle: v });

        let clientId = null;

        if (existingId && strat === 'skip') {
          stats.skipped += 1;
          continue;
        }

        if (existingId && strat === 'overwrite') {
          const upd = await queryInSchema(
            schemaName,
            `UPDATE {{schema}}.clients
                SET name=$1, phone=$2, email=$3, notes=$4, source=$5, city=$6,
                    birth_date=$7, updated_at=now()
              WHERE id=$8 RETURNING id`,
            [name, c.phone || null, c.email || null, notesJson,
             c.source || null, c.city || null, c.birth_date || null, existingId],
            client
          );
          clientId = upd.rows[0]?.id || null;
          if (clientId) stats.updated += 1;
        } else {
          // create_new или совпадений нет — INSERT
          const ins = await queryInSchema(
            schemaName,
            `INSERT INTO {{schema}}.clients (name, phone, email, notes, source, city, birth_date)
               VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
            [name, c.phone || null, c.email || null, notesJson,
             c.source || null, c.city || null, c.birth_date || null],
            client
          );
          clientId = ins.rows[0]?.id || null;
          if (clientId) {
            stats.created += 1;
            // Чтобы повторный INSERT с тем же телефоном в той же пачке
            // не задвоился (например, в шаблоне дважды Иван +7920...) —
            // подмешиваем созданный id в карту существующих.
            if (phoneNorm) phoneToId.set(phoneNorm, clientId);
          }
        }

        // Машина (опционально). Только если client заведён/обновлён И есть
        // хоть бренд. В дополнение к JSON в `clients.notes` (откуда читает UI
        // карточки) кладём отдельную запись в `vehicles` — оттуда читают
        // документы (наряд-заказ, акт приёмки). Стратегия overwrite НЕ
        // удаляет старые машины клиента, а просто докидывает ещё одну —
        // пусть пользователь решает руками, что лишнее.
        if (clientId && v && typeof v.brand === 'string' && v.brand.trim()) {
          await queryInSchema(
            schemaName,
            `INSERT INTO {{schema}}.vehicles (client_id, brand, model, license_plate, color, year)
               VALUES ($1, $2, $3, $4, $5, $6)`,
            [clientId, v.brand.trim(), v.model || null, v.license_plate || null,
             v.color || null, v.year || null],
            client
          );
        }
      }

      return { stats, errors };
    });

    logAction(
      req, 'bulk_import', 'client', null, null,
      { strategy: strat, ...result.stats, errors: result.errors.length }
    );
    // Если хоть один клиент реально создан/обновлён — для воронки прогрева
    // это засчитываем как «первый клиент». Импорт через Excel — частый
    // первый шаг новичка, без этого воронка решит «нет клиентов».
    if (result.stats.created > 0 || result.stats.updated > 0) {
      void markFirstEvent(req.session.studioId, 'first_client_at');
    }
    res.json({ ok: true, strategy: strat, ...result.stats, errors: result.errors });
  } catch (err) {
    next(err);
  }
});

// ══════════════════════════════════════════════════════════════════════
// VEHICLES
// ══════════════════════════════════════════════════════════════════════

router.get('/vehicles', async (req, res, next) => {
  const params = [];
  let where = '';
  if (req.query.client_id) {
    const cid = badId(req.query.client_id);
    if (cid) { params.push(cid); where = ` WHERE v.client_id = $${params.length}`; }
  }
  const r = await queryInSchema(
    req.session.schemaName,
    `SELECT v.*, c.name AS client_name
       FROM {{schema}}.vehicles v
       LEFT JOIN {{schema}}.clients c ON c.id = v.client_id
       ${where}
       ORDER BY v.created_at DESC`,
    params
  );
  res.json(r.rows);
});

router.post('/vehicles', canWriteClients, async (req, res, next) => {
  const { client_id, brand, model, year, vin, license_plate, color, mileage, notes } = req.body || {};
  const cid = badId(client_id);
  if (!cid) return res.status(400).json({ error: 'client_id_required' });
  if (!nonEmptyString(brand)) return res.status(400).json({ error: 'brand_required' });
  const r = await queryInSchema(
    req.session.schemaName,
    `INSERT INTO {{schema}}.vehicles (client_id, brand, model, year, vin, license_plate, color, mileage, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
    [cid, brand.trim(), model || null, year || null, vin || null, license_plate || null, color || null, mileage || null, notes || null]
  );
  logAction(req, 'create', 'vehicle', r.rows[0].id, `${r.rows[0].brand} ${r.rows[0].model || ''}`.trim());
  res.status(201).json(r.rows[0]);
});

router.put('/vehicles/:id', canWriteClients, async (req, res, next) => {
  const id = badId(req.params.id);
  if (!id) return res.status(400).json({ error: 'invalid_id' });
  const { brand, model, year, vin, license_plate, color, mileage, notes } = req.body || {};
  const r = await queryInSchema(
    req.session.schemaName,
    `UPDATE {{schema}}.vehicles
        SET brand=$1, model=$2, year=$3, vin=$4, license_plate=$5, color=$6, mileage=$7, notes=$8, updated_at=now()
      WHERE id=$9 RETURNING *`,
    [brand, model || null, year || null, vin || null, license_plate || null, color || null, mileage || null, notes || null, id]
  );
  if (!r.rows[0]) return res.status(404).json({ error: 'vehicle_not_found' });
  logAction(req, 'update', 'vehicle', id, `${r.rows[0].brand} ${r.rows[0].model || ''}`.trim());
  res.json(r.rows[0]);
});

router.delete('/vehicles/:id', canWriteClients, async (req, res, next) => {
  const id = badId(req.params.id);
  if (!id) return res.status(400).json({ error: 'invalid_id' });
  await queryInSchema(req.session.schemaName, `DELETE FROM {{schema}}.vehicles WHERE id=$1`, [id]);
  logAction(req, 'delete', 'vehicle', id);
  res.json({ ok: true });
});

// ══════════════════════════════════════════════════════════════════════
// SERVICES
// ══════════════════════════════════════════════════════════════════════

router.get('/services', async (req, res, next) => {
  const r = await queryInSchema(
    req.session.schemaName,
    `SELECT s.*, c.name AS category_name, c.color AS category_color
       FROM {{schema}}.services s
       LEFT JOIN {{schema}}.categories c ON c.id = s.category_id AND c.type = 'service'
      ORDER BY c.name NULLS LAST, s.name`
  );
  res.json(r.rows);
});

router.post('/services', canWriteCalendar, async (req, res, next) => {
  const { name, price, duration, description, category_id, is_active } = req.body || {};
  if (!nonEmptyString(name)) return res.status(400).json({ error: 'name_required' });
  const r = await queryInSchema(
    req.session.schemaName,
    `INSERT INTO {{schema}}.services (name, price, duration, description, category_id, is_active)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [name.trim(), price || 0, duration || 60, description || null, badId(category_id), is_active !== false]
  );
  res.status(201).json(r.rows[0]);
});

router.put('/services/:id', canWriteCalendar, async (req, res, next) => {
  const id = badId(req.params.id);
  if (!id) return res.status(400).json({ error: 'invalid_id' });
  const { name, price, duration, description, category_id, is_active } = req.body || {};
  const r = await queryInSchema(
    req.session.schemaName,
    `UPDATE {{schema}}.services
        SET name=$1, price=$2, duration=$3, description=$4, category_id=$5, is_active=$6
      WHERE id=$7 RETURNING *`,
    [name, price || 0, duration || 60, description || null, badId(category_id), is_active !== false, id]
  );
  if (!r.rows[0]) return res.status(404).json({ error: 'service_not_found' });
  res.json(r.rows[0]);
});

router.delete('/services/:id', canWriteCalendar, async (req, res, next) => {
  const id = badId(req.params.id);
  if (!id) return res.status(400).json({ error: 'invalid_id' });
  await queryInSchema(req.session.schemaName, `DELETE FROM {{schema}}.services WHERE id=$1`, [id]);
  res.json({ ok: true });
});

// ══════════════════════════════════════════════════════════════════════

// SERVICE CATEGORIES
router.get('/service-categories', async (req, res, next) => {
  const r = await queryInSchema(req.session.schemaName,
    `SELECT * FROM {{schema}}.categories WHERE type = 'service' ORDER BY name`);
  res.json(r.rows);
});
router.post('/service-categories', canWriteCalendar, async (req, res, next) => {
  const { name, color } = req.body || {};
  if (!nonEmptyString(name)) return res.status(400).json({ error: 'name_required' });
  const r = await queryInSchema(req.session.schemaName,
    `INSERT INTO {{schema}}.categories (name, type, color) VALUES ($1, 'service', $2) RETURNING *`,
    [name.trim(), color || null]);
  res.status(201).json(r.rows[0]);
});
router.put('/service-categories/:id', canWriteCalendar, async (req, res, next) => {
  const id = badId(req.params.id);
  if (!id) return res.status(400).json({ error: 'invalid_id' });
  const { name, color } = req.body || {};
  const r = await queryInSchema(req.session.schemaName,
    `UPDATE {{schema}}.categories SET name=$1, color=$2 WHERE id=$3 AND type='service' RETURNING *`,
    [name, color || null, id]);
  if (!r.rows[0]) return res.status(404).json({ error: 'category_not_found' });
  res.json(r.rows[0]);
});
router.delete('/service-categories/:id', canWriteCalendar, async (req, res, next) => {
  const id = badId(req.params.id);
  if (!id) return res.status(400).json({ error: 'invalid_id' });
  await queryInSchema(req.session.schemaName,
    `DELETE FROM {{schema}}.categories WHERE id=$1 AND type='service'`, [id]);
  res.json({ ok: true });
});

// BOOKINGS  (master_id JOIN на saas_meta.users)
// ══════════════════════════════════════════════════════════════════════

router.get('/bookings', async (req, res, next) => {
  const r = await queryInSchema(
    req.session.schemaName,
    `SELECT b.*,
            c.name AS client_name,
            v.brand AS vehicle_brand, v.model AS vehicle_model, v.license_plate,
            s.name AS service_name,
            u.name AS master_name, u.email AS master_email
       FROM {{schema}}.bookings b
       LEFT JOIN {{schema}}.clients  c ON c.id = b.client_id
       LEFT JOIN {{schema}}.vehicles v ON v.id = b.vehicle_id
       LEFT JOIN {{schema}}.services s ON s.id = b.service_id
       LEFT JOIN saas_meta.users    u ON u.id = b.master_id
      ORDER BY b.date DESC, b.time DESC`
  );
  res.json(r.rows);
});

router.post('/bookings', canWriteCalendar, async (req, res, next) => {
  const { client_id, vehicle_id, service_id, master_id, date, time, end_time, status, payment_status, amount, notes } = req.body || {};
  if (!date || !time) return res.status(400).json({ error: 'date_time_required' });

  // Cross-tenant guard: master_id может быть UUID юзера из ЛЮБОЙ студии
  // (FK на saas_meta.users общий). Без этой проверки атакующий-owner
  // через devtools мог бы назначить мастером кого-то из чужой студии.
  let safeMasterId;
  try {
    safeMasterId = await assertUserInStudio(master_id, req.session.studioId, 'master_id');
  } catch (err) { if (handleFieldError(err, res)) return; throw err; }

  const r = await queryInSchema(
    req.session.schemaName,
    `INSERT INTO {{schema}}.bookings
       (client_id, vehicle_id, service_id, master_id, date, time, end_time, status, payment_status, amount, notes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
    [
      badId(client_id), badId(vehicle_id), badId(service_id),
      safeMasterId,
      date, time, end_time || null,
      status || 'pending',
      payment_status || 'unpaid',
      amount ?? null,
      notes || null,
    ]
  );
  logAction(req, 'create', 'booking', r.rows[0].id);
  res.status(201).json(r.rows[0]);
});

router.put('/bookings/:id', canWriteCalendar, async (req, res, next) => {
  const id = badId(req.params.id);
  if (!id) return res.status(400).json({ error: 'invalid_id' });
  const { client_id, vehicle_id, service_id, master_id, date, time, end_time, status, payment_status, amount, notes } = req.body || {};
  let safeMasterId;
  try {
    safeMasterId = await assertUserInStudio(master_id, req.session.studioId, 'master_id');
  } catch (err) { if (handleFieldError(err, res)) return; throw err; }
  const r = await queryInSchema(
    req.session.schemaName,
    `UPDATE {{schema}}.bookings
        SET client_id=$1, vehicle_id=$2, service_id=$3, master_id=$4,
            date=$5, time=$6, end_time=$7, status=$8, payment_status=$9, amount=$10, notes=$11,
            updated_at=now()
      WHERE id=$12 RETURNING *`,
    [
      badId(client_id), badId(vehicle_id), badId(service_id), safeMasterId,
      date, time, end_time || null,
      status || 'pending', payment_status || 'unpaid', amount ?? null, notes || null,
      id,
    ]
  );
  if (!r.rows[0]) return res.status(404).json({ error: 'booking_not_found' });
  logAction(req, 'update', 'booking', id);
  res.json(r.rows[0]);
});

router.delete('/bookings/:id', canWriteCalendar, async (req, res, next) => {
  const id = badId(req.params.id);
  if (!id) return res.status(400).json({ error: 'invalid_id' });
  await queryInSchema(req.session.schemaName, `DELETE FROM {{schema}}.bookings WHERE id=$1`, [id]);
  logAction(req, 'delete', 'booking', id);
  res.json({ ok: true });
});

// ══════════════════════════════════════════════════════════════════════
// TRANSACTIONS
//
// Доступ управляется через permissions.finance:
//   'edit' → полный доступ (GET + POST + PUT + DELETE)
//   'view' → только чтение (GET)
//   'none' → нет доступа
// ══════════════════════════════════════════════════════════════════════

router.get('/transactions', canViewFinanceGrd, async (req, res, next) => {
  const r = await queryInSchema(
    req.session.schemaName,
    `SELECT id, type, amount, category_id, category, description, date, time,
            booking_id, client_record_id, client_id, client_name,
            created_by, tags, created_at
       FROM {{schema}}.transactions
      ORDER BY date DESC, created_at DESC`
  );
  res.json(r.rows);
});

router.post('/transactions', canWriteFinance, async (req, res, next) => {
  const { type, amount, category, category_id, description, date, time, booking_id, client_record_id, client_id, tags } = req.body || {};
  if (!type || (type !== 'income' && type !== 'expense')) return res.status(400).json({ error: 'type_invalid' });
  if (typeof amount !== 'number' && typeof amount !== 'string') return res.status(400).json({ error: 'amount_required' });
  let normalizedTags;
  try { normalizedTags = normalizeTags(tags); }
  catch (err) { if (handleFieldError(err, res)) return; throw err; }

  // Денормализация имени клиента (см. transactions.client_name): если
  // привязка к клиенту есть — копируем его имя на момент платежа,
  // чтобы аналитика финансов не теряла контекст после удаления клиента.
  // Один лишний SELECT, ~5 мс — приемлемо для редкой операции (создание
  // транзакции, не hot-path).
  let clientNameSnapshot = null;
  const safeClientId = badId(client_id);
  if (safeClientId) {
    const cr = await queryInSchema(
      req.session.schemaName,
      `SELECT name FROM {{schema}}.clients WHERE id = $1`,
      [safeClientId]
    );
    clientNameSnapshot = cr.rows[0]?.name || null;
  }

  const r = await queryInSchema(
    req.session.schemaName,
    `INSERT INTO {{schema}}.transactions
       (type, amount, category_id, category, description, date, time, booking_id, client_record_id, client_id, client_name, created_by, tags)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb) RETURNING *`,
    [
      type, amount,
      badId(category_id), category || null,
      description || null,
      date || new Date().toISOString().slice(0, 10), time || null,
      badId(booking_id), badId(client_record_id), safeClientId, clientNameSnapshot,
      req.session.userId,
      JSON.stringify(normalizedTags),
    ]
  );
  // Лог на русском: entity_name = «Доход»/«Расход», details = «5000 ₽».
  const TX_TYPE_RU = { income: 'Доход', expense: 'Расход' };
  logAction(req, 'create', 'transaction', r.rows[0].id, TX_TYPE_RU[type] || type, `${amount} ₽`);
  void markFirstEvent(req.session.studioId, 'first_transaction_at');
  res.status(201).json(r.rows[0]);
});

// Утилита: для 'linked'-скоупа подгружает транзакцию и проверяет
// client_record_id. Возвращает true/false; при false уже отвечает на res.
async function ensureLinkedScope(req, res, txId) {
  if (req.txScope !== 'linked') return true;
  const r = await queryInSchema(
    req.session.schemaName,
    `SELECT client_record_id FROM {{schema}}.transactions WHERE id=$1`,
    [txId]
  );
  if (!r.rows[0]) { res.status(404).json({ error: 'transaction_not_found' }); return false; }
  if (!badId(r.rows[0].client_record_id)) { res.status(403).json({ error: 'finance_forbidden' }); return false; }
  return true;
}

router.put('/transactions/:id', canWriteFinance, async (req, res, next) => {
  const id = badId(req.params.id);
  if (!id) return res.status(400).json({ error: 'invalid_id' });
  const { type, amount, category, category_id, description, date, time, tags } = req.body || {};
  let normalizedTags;
  try { normalizedTags = normalizeTags(tags); }
  catch (err) { if (handleFieldError(err, res)) return; throw err; }
  const r = await queryInSchema(
    req.session.schemaName,
    `UPDATE {{schema}}.transactions
        SET type=$1, amount=$2, category_id=$3, category=$4, description=$5, date=$6, time=$7, tags=$8::jsonb
      WHERE id=$9 RETURNING *`,
    [type, amount, badId(category_id), category || null, description || '', date || new Date().toISOString().slice(0,10), time || null, JSON.stringify(normalizedTags), id]
  );
  if (!r.rows[0]) return res.status(404).json({ error: 'transaction_not_found' });
  const TX_TYPE_RU = { income: 'Доход', expense: 'Расход' };
  logAction(req, 'update', 'transaction', id, TX_TYPE_RU[type] || type, `${amount} ₽`);
  res.json(r.rows[0]);
});

router.delete('/transactions/:id', canWriteFinance, async (req, res, next) => {
  const id = badId(req.params.id);
  if (!id) return res.status(400).json({ error: 'invalid_id' });
  await queryInSchema(req.session.schemaName, `DELETE FROM {{schema}}.transactions WHERE id=$1`, [id]);
  logAction(req, 'delete', 'transaction', id);
  res.json({ ok: true });
});

// ══════════════════════════════════════════════════════════════════════
// TASKS
// ══════════════════════════════════════════════════════════════════════

router.get('/tasks', async (req, res, next) => {
  const r = await queryInSchema(
    req.session.schemaName,
    `SELECT t.*, c.name AS client_name, u.name AS assigned_to_name
       FROM {{schema}}.tasks t
       LEFT JOIN {{schema}}.clients c ON c.id = t.client_id
       LEFT JOIN saas_meta.users    u ON u.id = t.assigned_to
      ORDER BY t.due_date ASC NULLS LAST, t.created_at DESC`
  );
  res.json(r.rows);
});

router.post('/tasks', canWriteTasks, async (req, res, next) => {
  const { title, description, status, priority, due_date, due_time, client_id, vehicle_id, assigned_to } = req.body || {};
  if (!nonEmptyString(title)) return res.status(400).json({ error: 'title_required' });
  let safeAssignedTo;
  try {
    safeAssignedTo = await assertUserInStudio(assigned_to, req.session.studioId, 'assigned_to');
  } catch (err) { if (handleFieldError(err, res)) return; throw err; }
  const r = await queryInSchema(
    req.session.schemaName,
    `INSERT INTO {{schema}}.tasks
       (title, description, status, priority, due_date, due_time, client_id, vehicle_id, assigned_to)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [title.trim(), description || null, status || 'pending', priority || 'medium',
     due_date || null, due_time || null, badId(client_id), badId(vehicle_id), safeAssignedTo]
  );
  logAction(req, 'create', 'task', r.rows[0].id, r.rows[0].title);
  res.status(201).json(r.rows[0]);
});

router.put('/tasks/:id', canWriteTasks, async (req, res, next) => {
  const id = badId(req.params.id);
  if (!id) return res.status(400).json({ error: 'invalid_id' });
  const { title, description, status, priority, due_date, due_time, client_id, vehicle_id, assigned_to, completed_at } = req.body || {};
  let safeAssignedTo;
  try {
    safeAssignedTo = await assertUserInStudio(assigned_to, req.session.studioId, 'assigned_to');
  } catch (err) { if (handleFieldError(err, res)) return; throw err; }
  const r = await queryInSchema(
    req.session.schemaName,
    `UPDATE {{schema}}.tasks
        SET title=$1, description=$2, status=$3, priority=$4,
            due_date=$5, due_time=$6,
            client_id=$7, vehicle_id=$8, assigned_to=$9,
            completed_at=$10, updated_at=now()
      WHERE id=$11 RETURNING *`,
    [title, description || null, status || 'pending', priority || 'medium',
     due_date || null, due_time || null,
     badId(client_id), badId(vehicle_id), safeAssignedTo,
     completed_at || (status === 'done' ? new Date() : null),
     id]
  );
  if (!r.rows[0]) return res.status(404).json({ error: 'task_not_found' });
  logAction(req, 'update', 'task', id, r.rows[0].title);
  res.json(r.rows[0]);
});

router.delete('/tasks/:id', canWriteTasks, async (req, res, next) => {
  const id = badId(req.params.id);
  if (!id) return res.status(400).json({ error: 'invalid_id' });
  await queryInSchema(req.session.schemaName, `DELETE FROM {{schema}}.tasks WHERE id=$1`, [id]);
  logAction(req, 'delete', 'task', id);
  res.json({ ok: true });
});

// ══════════════════════════════════════════════════════════════════════
// CLIENT_RECORDS  (история работ)
// ══════════════════════════════════════════════════════════════════════

router.get('/client-records', async (req, res, next) => {
  const params = [];
  let where = '';
  if (req.query.client_id) {
    const cid = badId(req.query.client_id);
    if (cid) { params.push(cid); where = ` WHERE cr.client_id = $${params.length}`; }
  }
  const r = await queryInSchema(
    req.session.schemaName,
    `SELECT cr.*, c.name AS client_name,
            v.brand AS vehicle_brand, v.model AS vehicle_model, v.license_plate,
            u.name AS master_name
       FROM {{schema}}.client_records cr
       LEFT JOIN {{schema}}.clients  c ON c.id = cr.client_id
       LEFT JOIN {{schema}}.vehicles v ON v.id = cr.vehicle_id
       LEFT JOIN saas_meta.users    u ON u.id = cr.master_id
       ${where}
       ORDER BY cr.date DESC, cr.time DESC NULLS LAST`,
    params
  );
  res.json(r.rows);
});

router.post('/client-records', canWriteCalendar, async (req, res, next) => {
  const {
    client_id, vehicle_id, booking_id, service_name, description, amount,
    date, time, master_id, is_paid, is_completed,
    advance, advance_date, end_date, category_id, payment_status, tags,
    services: rawServices,
  } = req.body || {};
  const cid = badId(client_id);
  if (!cid) return res.status(400).json({ error: 'client_id_required' });
  if (!date) return res.status(400).json({ error: 'date_required' });

  // Multi-service: если фронт прислал массив services — он рулит. Бэк
  // перезапросит actual цены из прайса (защита от подмены), сложит amount,
  // соберёт service_name через ', ' для legacy-поля. Если массив пустой
  // или не передан — используем legacy путь (service_name + amount из body).
  let resolved = null;
  try {
    if (Array.isArray(rawServices) && rawServices.length > 0) {
      resolved = await resolveServices(req.session.schemaName, rawServices);
    }
  } catch (err) { if (handleFieldError(err, res)) return; throw err; }

  const finalServiceName = resolved ? resolved.serviceName : (service_name || '').trim();
  const finalAmount      = resolved ? resolved.amount : (amount || 0);
  const finalServices    = resolved ? resolved.services : [];

  if (!nonEmptyString(finalServiceName)) {
    return res.status(400).json({ error: 'service_name_required' });
  }

  let normalizedTags, safeMasterId;
  try {
    normalizedTags = normalizeTags(tags);
    safeMasterId = await assertUserInStudio(master_id, req.session.studioId, 'master_id');
  } catch (err) { if (handleFieldError(err, res)) return; throw err; }

  const r = await queryInSchema(
    req.session.schemaName,
    `INSERT INTO {{schema}}.client_records
       (client_id, vehicle_id, booking_id, service_name, description, amount,
        date, time, master_id, is_paid, is_completed,
        advance, advance_date, end_date, category_id, payment_status, tags, services)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb,$18::jsonb)
     RETURNING *`,
    [
      cid, badId(vehicle_id), badId(booking_id),
      finalServiceName, description || null, finalAmount,
      date, time || null, safeMasterId,
      Boolean(is_paid), Boolean(is_completed),
      advance || 0, advance_date || null, end_date || null,
      badId(category_id),
      payment_status || 'none',
      JSON.stringify(normalizedTags),
      JSON.stringify(finalServices),
    ]
  );
  logAction(req, 'create', 'client_record', r.rows[0].id, finalServiceName);
  void markFirstEvent(req.session.studioId, 'first_record_at');
  res.status(201).json(r.rows[0]);
});

// PUT с whitelist полей — как в исходном index.cjs:2125
router.put('/client-records/:id', canWriteCalendar, async (req, res, next) => {
  const id = badId(req.params.id);
  if (!id) return res.status(400).json({ error: 'invalid_id' });
  const fields = req.body || {};

  // Multi-service: если в body пришёл services-массив, бэк перезапишет
  // service_name и amount из расчёта (защита от подмены). Соответствующие
  // поля в body игнорируем (даже если фронт их прислал — например, по
  // ошибке). Если services не передан — стандартный whitelist-путь, юзер
  // правит legacy-поля по одному.
  let resolved = null;
  if (Array.isArray(fields.services) && fields.services.length > 0) {
    try {
      resolved = await resolveServices(req.session.schemaName, fields.services);
    } catch (err) { if (handleFieldError(err, res)) return; throw err; }
  }

  const allowed = {
    service_name: 'service_name',
    description: 'description',
    amount: 'amount',
    date: 'date',
    time: 'time',
    is_paid: 'is_paid',
    is_completed: 'is_completed',
    advance: 'advance',
    advance_date: 'advance_date',
    end_date: 'end_date',
    category_id: 'category_id',
    payment_status: 'payment_status',
    tags: 'tags',
    master_id: 'master_id',
  };
  const set = [];
  const values = [];
  let pi = 1;
  for (const [key, col] of Object.entries(allowed)) {
    if (fields[key] === undefined) continue;
    // Если массив services сработал — service_name и amount определяет
    // resolveServices, не body. Игнорируем их явные значения.
    if (resolved && (key === 'service_name' || key === 'amount')) continue;
    let val = fields[key];
    if (key === 'category_id') val = badId(val);
    if (key === 'tags') {
      try { val = JSON.stringify(normalizeTags(val)); }
      catch (err) { if (handleFieldError(err, res)) return; throw err; }
    }
    if (key === 'master_id') {
      try { val = await assertUserInStudio(val, req.session.studioId, 'master_id'); }
      catch (err) { if (handleFieldError(err, res)) return; throw err; }
    }
    set.push(`${col} = $${pi++}`);
    values.push(val);
  }

  // Добавляем поля из resolveServices, если оно отработало.
  if (resolved) {
    set.push(`service_name = $${pi++}`); values.push(resolved.serviceName);
    set.push(`amount = $${pi++}`);       values.push(resolved.amount);
    set.push(`services = $${pi++}::jsonb`); values.push(JSON.stringify(resolved.services));
  }

  if (set.length === 0) return res.status(400).json({ error: 'no_fields_to_update' });
  set.push(`updated_at = now()`);
  values.push(id);
  const r = await queryInSchema(
    req.session.schemaName,
    `UPDATE {{schema}}.client_records SET ${set.join(', ')} WHERE id = $${pi} RETURNING *`,
    values
  );
  if (!r.rows[0]) return res.status(404).json({ error: 'client_record_not_found' });
  logAction(req, 'update', 'client_record', id, r.rows[0].service_name);
  res.json(r.rows[0]);
});

router.delete('/client-records/:id', canWriteCalendar, async (req, res, next) => {
  const id = badId(req.params.id);
  if (!id) return res.status(400).json({ error: 'invalid_id' });
  await queryInSchema(req.session.schemaName, `DELETE FROM {{schema}}.client_records WHERE id=$1`, [id]);
  logAction(req, 'delete', 'client_record', id);
  res.json({ ok: true });
});

// ══════════════════════════════════════════════════════════════════════
// CATEGORIES
// ══════════════════════════════════════════════════════════════════════

router.get('/categories', async (req, res, next) => {
  const r = await queryInSchema(
    req.session.schemaName,
    `SELECT * FROM {{schema}}.categories ORDER BY name`
  );
  res.json(r.rows);
});

router.post('/categories', canWriteFinance, async (req, res, next) => {
  const { name, type, color, icon } = req.body || {};
  if (!nonEmptyString(name)) return res.status(400).json({ error: 'name_required' });
  const t = type === 'income' || type === 'expense' ? type : 'expense';
  const r = await queryInSchema(
    req.session.schemaName,
    `INSERT INTO {{schema}}.categories (name, type, color, icon) VALUES ($1, $2, $3, $4) RETURNING *`,
    [name.trim(), t, color || null, icon || null]
  );
  res.status(201).json(r.rows[0]);
});

router.put('/categories/:id', canWriteFinance, async (req, res, next) => {
  const id = badId(req.params.id);
  if (!id) return res.status(400).json({ error: 'invalid_id' });
  const { name, type, color, icon } = req.body || {};
  const t = type === 'income' || type === 'expense' ? type : 'expense';
  const r = await queryInSchema(
    req.session.schemaName,
    `UPDATE {{schema}}.categories SET name=$1, type=$2, color=$3, icon=$4 WHERE id=$5 RETURNING *`,
    [name, t, color || null, icon || null, id]
  );
  if (!r.rows[0]) return res.status(404).json({ error: 'category_not_found' });
  res.json(r.rows[0]);
});

router.delete('/categories/:id', canWriteFinance, async (req, res, next) => {
  const id = badId(req.params.id);
  if (!id) return res.status(400).json({ error: 'invalid_id' });
  await queryInSchema(req.session.schemaName, `DELETE FROM {{schema}}.categories WHERE id=$1`, [id]);
  res.json({ ok: true });
});

// ══════════════════════════════════════════════════════════════════════
// TAGS
// ══════════════════════════════════════════════════════════════════════

// type: 'all' | 'income' | 'expense'. Невалидные значения → 'all'
// (мягко, без 400, чтобы не ломать legacy-клиентов).
const ALLOWED_TAG_TYPES = ['all', 'income', 'expense'];
const normalizeTagType = (v) => ALLOWED_TAG_TYPES.includes(v) ? v : 'all';

router.get('/tags', async (req, res, next) => {
  const r = await queryInSchema(
    req.session.schemaName,
    `SELECT id, name, color, type, created_at FROM {{schema}}.tags ORDER BY name`
  );
  res.json(r.rows);
});

router.post('/tags', canWriteFinance, async (req, res, next) => {
  const { name, color, type } = req.body || {};
  if (!nonEmptyString(name)) return res.status(400).json({ error: 'name_required' });
  const r = await queryInSchema(
    req.session.schemaName,
    `INSERT INTO {{schema}}.tags (name, color, type) VALUES ($1, $2, $3) RETURNING *`,
    [name.trim(), color || null, normalizeTagType(type)]
  );
  res.status(201).json(r.rows[0]);
});

router.put('/tags/:id', canWriteFinance, async (req, res, next) => {
  const id = badId(req.params.id);
  if (!id) return res.status(400).json({ error: 'invalid_id' });
  const { name, color, type } = req.body || {};
  if (!nonEmptyString(name)) return res.status(400).json({ error: 'name_required' });
  const r = await queryInSchema(
    req.session.schemaName,
    `UPDATE {{schema}}.tags SET name=$1, color=$2, type=$3 WHERE id=$4 RETURNING *`,
    [name.trim(), color || null, normalizeTagType(type), id]
  );
  if (r.rowCount === 0) return res.status(404).json({ error: 'not_found' });
  res.json(r.rows[0]);
});

router.delete('/tags/:id', canWriteFinance, async (req, res, next) => {
  const id = badId(req.params.id);
  if (!id) return res.status(400).json({ error: 'invalid_id' });
  await queryInSchema(req.session.schemaName, `DELETE FROM {{schema}}.tags WHERE id=$1`, [id]);
  res.json({ ok: true });
});

// ══════════════════════════════════════════════════════════════════════
// ENTITY_TAGS  (n:m связь tag → произвольная сущность)
// ══════════════════════════════════════════════════════════════════════

router.get('/entity-tags', async (req, res, next) => {
  const params = [];
  const conds = [];
  if (req.query.entity_type) { params.push(req.query.entity_type); conds.push(`et.entity_type = $${params.length}`); }
  if (req.query.entity_id) {
    const eid = badId(req.query.entity_id);
    if (eid) { params.push(eid); conds.push(`et.entity_id = $${params.length}`); }
  }
  const where = conds.length ? ` WHERE ${conds.join(' AND ')}` : '';
  const r = await queryInSchema(
    req.session.schemaName,
    `SELECT et.*, t.name AS tag_name, t.color
       FROM {{schema}}.entity_tags et
       LEFT JOIN {{schema}}.tags t ON t.id = et.tag_id
       ${where}
       ORDER BY et.created_at DESC`,
    params
  );
  res.json(r.rows);
});

router.post('/entity-tags', canWriteClients, async (req, res, next) => {
  const { tag_id, entity_type, entity_id } = req.body || {};
  const tid = badId(tag_id), eid = badId(entity_id);
  if (!tid || !nonEmptyString(entity_type) || !eid) {
    return res.status(400).json({ error: 'tag_entity_required' });
  }
  const r = await queryInSchema(
    req.session.schemaName,
    `INSERT INTO {{schema}}.entity_tags (tag_id, entity_type, entity_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (tag_id, entity_type, entity_id) DO NOTHING
       RETURNING *`,
    [tid, entity_type, eid]
  );
  if (!r.rows[0]) return res.status(200).json({ ok: true, alreadyExists: true });
  res.status(201).json(r.rows[0]);
});

router.delete('/entity-tags/:id', canWriteClients, async (req, res, next) => {
  const id = badId(req.params.id);
  if (!id) return res.status(400).json({ error: 'invalid_id' });
  await queryInSchema(req.session.schemaName, `DELETE FROM {{schema}}.entity_tags WHERE id=$1`, [id]);
  res.json({ ok: true });
});

// ══════════════════════════════════════════════════════════════════════
// APP_DATA (kv-настройки)
// ══════════════════════════════════════════════════════════════════════

router.get('/data/:key', async (req, res, next) => {
  const r = await queryInSchema(
    req.session.schemaName,
    `SELECT value FROM {{schema}}.app_data WHERE key = $1`,
    [req.params.key]
  );
  res.json(r.rows[0]?.value ?? null);
});

// Generic key/value store — UI кладёт сюда настройки (фильтры, layout-state).
// Структура by-design свободная, но размер ограничиваем 64KB на ключ —
// иначе через эту ручку можно залить мегабайты JSON в studio_xxx.app_data
// и устроить DoS на дисковое место + замедлить чтения.
const MAX_DATA_VALUE_BYTES = 64 * 1024;

router.post('/data/:key', canWriteClients, async (req, res, next) => {
  const { value } = req.body || {};
  // Ключ — тоже user input. Ограничиваем длиной 100 + регексп
  // [a-zA-Z0-9_.-] чтобы избежать сюрпризов с UNIQUE и сортировкой.
  const key = String(req.params.key || '');
  if (!key || key.length > 100 || !/^[a-zA-Z0-9_.-]+$/.test(key)) {
    return res.status(400).json({ error: 'key_invalid' });
  }
  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch (_) {
    return res.status(400).json({ error: 'value_not_serializable' });
  }
  // Длина строки в UTF-16 ≈ длине в UTF-8 для ASCII; для русского × 2-3.
  // Грубо: Buffer.byteLength для точности.
  if (Buffer.byteLength(serialized, 'utf8') > MAX_DATA_VALUE_BYTES) {
    return res.status(400).json({ error: 'value_too_large', max_bytes: MAX_DATA_VALUE_BYTES });
  }
  await queryInSchema(
    req.session.schemaName,
    `INSERT INTO {{schema}}.app_data (key, value, updated_at)
       VALUES ($1, $2::jsonb, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [key, serialized]
  );
  res.json({ ok: true });
});

// ══════════════════════════════════════════════════════════════════════
// ACTIVITY LOGS  (только для admin)
// ══════════════════════════════════════════════════════════════════════

router.get('/activity-logs', requireRole('owner'), async (req, res, next) => {
  let limit, offset;
  try {
    ({ limit, offset } = parsePagination(req.query.limit, req.query.offset, {
      defaultLimit: 100, maxLimit: 500,
    }));
  } catch (err) { if (handleFieldError(err, res)) return; throw err; }
  const params = [];
  const conds = [];
  if (req.query.user_id) { params.push(req.query.user_id); conds.push(`user_id = $${params.length}`); }
  if (req.query.action)  { params.push(req.query.action);  conds.push(`action = $${params.length}`); }
  const where = conds.length ? ` WHERE ${conds.join(' AND ')}` : '';
  params.push(limit); params.push(offset);
  const r = await queryInSchema(
    req.session.schemaName,
    `SELECT * FROM {{schema}}.activity_logs ${where}
       ORDER BY created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  res.json(r.rows);
});

// ══════════════════════════════════════════════════════════════════════
// USERS LIST — все пользователи студии (для UI выбора мастера и т.п.)
// ══════════════════════════════════════════════════════════════════════

router.get('/users', async (req, res, next) => {
  const r = await query(
    `SELECT id, email, name, role, is_active, created_at
       FROM saas_meta.users
      WHERE studio_id = $1
      ORDER BY name NULLS LAST, email`,
    [req.session.studioId]
  );
  // Поля snake_case — фронт-тип StudioUser в client/src/utils/types.ts
  // ожидает is_active и created_at в snake_case (исторически совместимо
  // с /api/admin/users, который тоже шлёт snake_case).
  res.json(r.rows.map((u) => ({
    id: u.id,
    email: u.email,
    name: u.name,
    role: u.role,
    is_active: u.is_active,
    created_at: u.created_at,
  })));
});

module.exports = router;
