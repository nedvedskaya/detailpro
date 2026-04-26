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
const { queryInSchema, query } = require('../lib/db.cjs');
const { requireRole } = require('../lib/middleware.cjs');
const { logAction: auditLog } = require('../lib/audit.cjs');

const router = express.Router();

// ──────────────────────────────────────────────────────────────────────
// Audit log helper.
//
// Тонкая обёртка над server/lib/audit.cjs. Раньше функция была private
// этому файлу, но теперь ту же запись делают auth.cjs (login/logout) и
// admin.cjs (CRUD пользователей), поэтому реализация вынесена в общий
// lib/audit.cjs. Здесь — sugar для вызова из роутов с готовым req.
// ──────────────────────────────────────────────────────────────────────
function logAction(req, action, entityType, entityId, entityName, details) {
  auditLog({
    schemaName: req.session.schemaName,
    userId:     req.session.userId,
    userName:   req.session.userName,
    action,
    entityType,
    entityId,
    entityName,
    details,
    ip:         req.ip,
  });
}

// Кто имеет право писать в БД. Master — read-only по всем CRM-сущностям.
const canWrite = requireRole('owner', 'manager');

function badId(id) {
  const n = parseInt(id, 10);
  if (Number.isNaN(n) || n <= 0 || n > 2147483647) return null;
  return n;
}
function nonEmptyString(v) {
  return typeof v === 'string' && v.trim().length > 0;
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

router.post('/clients', canWrite, async (req, res, next) => {
  const { name, phone, email, notes, source, city, birth_date, avatar } = req.body || {};
  if (!nonEmptyString(name)) return res.status(400).json({ error: 'name_required' });
  const r = await queryInSchema(
    req.session.schemaName,
    `INSERT INTO {{schema}}.clients (name, phone, email, notes, source, city, birth_date, avatar)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
    [name.trim(), phone || null, email || null, notes || null, source || null, city || null, birth_date || null, avatar || null]
  );
  logAction(req, 'create', 'client', r.rows[0].id, r.rows[0].name);
  res.status(201).json(r.rows[0]);
});

router.put('/clients/:id', canWrite, async (req, res, next) => {
  const id = badId(req.params.id);
  if (!id) return res.status(400).json({ error: 'invalid_id' });
  const { name, phone, email, notes, source, city, birth_date, avatar } = req.body || {};
  if (!nonEmptyString(name)) return res.status(400).json({ error: 'name_required' });
  const r = await queryInSchema(
    req.session.schemaName,
    `UPDATE {{schema}}.clients
        SET name=$1, phone=$2, email=$3, notes=$4, source=$5, city=$6, birth_date=$7,
            avatar = COALESCE($8, avatar), updated_at = now()
      WHERE id=$9 RETURNING *`,
    [name.trim(), phone || null, email || null, notes || null, source || null, city || null, birth_date || null,
     avatar !== undefined ? avatar : null, id]
  );
  if (!r.rows[0]) return res.status(404).json({ error: 'client_not_found' });
  logAction(req, 'update', 'client', id, r.rows[0].name);
  res.json(r.rows[0]);
});

router.put('/clients/:id/avatar', requireRole('owner', 'manager'), async (req, res, next) => {
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

router.delete('/clients/:id', requireRole('owner', 'manager'), async (req, res, next) => {
  const id = badId(req.params.id);
  if (!id) return res.status(400).json({ error: 'invalid_id' });
  await queryInSchema(req.session.schemaName, `DELETE FROM {{schema}}.clients WHERE id=$1`, [id]);
  logAction(req, 'delete', 'client', id);
  res.json({ ok: true });
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

router.post('/vehicles', canWrite, async (req, res, next) => {
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

router.put('/vehicles/:id', canWrite, async (req, res, next) => {
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

router.delete('/vehicles/:id', canWrite, async (req, res, next) => {
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
    `SELECT * FROM {{schema}}.services ORDER BY name`
  );
  res.json(r.rows);
});

router.post('/services', canWrite, async (req, res, next) => {
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

router.put('/services/:id', canWrite, async (req, res, next) => {
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

router.delete('/services/:id', canWrite, async (req, res, next) => {
  const id = badId(req.params.id);
  if (!id) return res.status(400).json({ error: 'invalid_id' });
  await queryInSchema(req.session.schemaName, `DELETE FROM {{schema}}.services WHERE id=$1`, [id]);
  res.json({ ok: true });
});

// ══════════════════════════════════════════════════════════════════════
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

router.post('/bookings', canWrite, async (req, res, next) => {
  const { client_id, vehicle_id, service_id, master_id, date, time, end_time, status, payment_status, amount, notes } = req.body || {};
  if (!date || !time) return res.status(400).json({ error: 'date_time_required' });
  const r = await queryInSchema(
    req.session.schemaName,
    `INSERT INTO {{schema}}.bookings
       (client_id, vehicle_id, service_id, master_id, date, time, end_time, status, payment_status, amount, notes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
    [
      badId(client_id), badId(vehicle_id), badId(service_id),
      master_id || null,                 // UUID на saas_meta.users — передаём как есть
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

router.put('/bookings/:id', canWrite, async (req, res, next) => {
  const id = badId(req.params.id);
  if (!id) return res.status(400).json({ error: 'invalid_id' });
  const { client_id, vehicle_id, service_id, master_id, date, time, end_time, status, payment_status, amount, notes } = req.body || {};
  const r = await queryInSchema(
    req.session.schemaName,
    `UPDATE {{schema}}.bookings
        SET client_id=$1, vehicle_id=$2, service_id=$3, master_id=$4,
            date=$5, time=$6, end_time=$7, status=$8, payment_status=$9, amount=$10, notes=$11,
            updated_at=now()
      WHERE id=$12 RETURNING *`,
    [
      badId(client_id), badId(vehicle_id), badId(service_id), master_id || null,
      date, time, end_time || null,
      status || 'pending', payment_status || 'unpaid', amount ?? null, notes || null,
      id,
    ]
  );
  if (!r.rows[0]) return res.status(404).json({ error: 'booking_not_found' });
  logAction(req, 'update', 'booking', id);
  res.json(r.rows[0]);
});

router.delete('/bookings/:id', canWrite, async (req, res, next) => {
  const id = badId(req.params.id);
  if (!id) return res.status(400).json({ error: 'invalid_id' });
  await queryInSchema(req.session.schemaName, `DELETE FROM {{schema}}.bookings WHERE id=$1`, [id]);
  logAction(req, 'delete', 'booking', id);
  res.json({ ok: true });
});

// ══════════════════════════════════════════════════════════════════════
// TRANSACTIONS
//
// Гейты роли:
//   - Master никогда не имеет доступа к финансам (вкладка скрыта на UI,
//     но и API закрываем — middleware `canSeeFinance` ниже).
//   - Manager имеет доступ только если can_view_finance=true (по умолчанию
//     true; собственник в админ-панели может снять галочку).
//   - Owner всегда видит финансы.
// Отдельный middleware вместо if-в-каждом-хендлере, чтобы не забыть.
// ══════════════════════════════════════════════════════════════════════

function canSeeFinance(req, res, next) {
  const role = req.session?.role;
  if (role === 'owner') return next();
  if (role === 'manager' && req.session.canViewFinance !== false) return next();
  return res.status(403).json({ error: 'finance_forbidden' });
}

router.get('/transactions', canSeeFinance, async (req, res, next) => {
  const r = await queryInSchema(
    req.session.schemaName,
    `SELECT id, type, amount, category_id, category, description, date, time,
            booking_id, client_record_id, client_id, created_by, tags, created_at
       FROM {{schema}}.transactions
      ORDER BY date DESC, created_at DESC`
  );
  res.json(r.rows);
});

router.post('/transactions', canWrite, canSeeFinance, async (req, res, next) => {
  const { type, amount, category, category_id, description, date, time, booking_id, client_record_id, client_id, tags } = req.body || {};
  if (!type || (type !== 'income' && type !== 'expense')) return res.status(400).json({ error: 'type_invalid' });
  if (typeof amount !== 'number' && typeof amount !== 'string') return res.status(400).json({ error: 'amount_required' });
  const r = await queryInSchema(
    req.session.schemaName,
    `INSERT INTO {{schema}}.transactions
       (type, amount, category_id, category, description, date, time, booking_id, client_record_id, client_id, created_by, tags)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb) RETURNING *`,
    [
      type, amount,
      badId(category_id), category || null,
      description || null,
      date || new Date().toISOString().slice(0, 10), time || null,
      badId(booking_id), badId(client_record_id), badId(client_id),
      req.session.userId,
      JSON.stringify(tags || []),
    ]
  );
  logAction(req, 'create', 'transaction', r.rows[0].id, type, `${amount}`);
  res.status(201).json(r.rows[0]);
});

router.put('/transactions/:id', canWrite, canSeeFinance, async (req, res, next) => {
  const id = badId(req.params.id);
  if (!id) return res.status(400).json({ error: 'invalid_id' });
  const { type, amount, category, category_id, description, date, time, tags } = req.body || {};
  const r = await queryInSchema(
    req.session.schemaName,
    `UPDATE {{schema}}.transactions
        SET type=$1, amount=$2, category_id=$3, category=$4, description=$5, date=$6, time=$7, tags=$8::jsonb
      WHERE id=$9 RETURNING *`,
    [type, amount, badId(category_id), category || null, description || '', date || new Date().toISOString().slice(0,10), time || null, JSON.stringify(tags || []), id]
  );
  if (!r.rows[0]) return res.status(404).json({ error: 'transaction_not_found' });
  logAction(req, 'update', 'transaction', id, type, `${amount}`);
  res.json(r.rows[0]);
});

router.delete('/transactions/:id', canWrite, canSeeFinance, async (req, res, next) => {
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

router.post('/tasks', canWrite, async (req, res, next) => {
  const { title, description, status, priority, due_date, due_time, client_id, vehicle_id, assigned_to } = req.body || {};
  if (!nonEmptyString(title)) return res.status(400).json({ error: 'title_required' });
  const r = await queryInSchema(
    req.session.schemaName,
    `INSERT INTO {{schema}}.tasks
       (title, description, status, priority, due_date, due_time, client_id, vehicle_id, assigned_to)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [title.trim(), description || null, status || 'pending', priority || 'medium',
     due_date || null, due_time || null, badId(client_id), badId(vehicle_id), assigned_to || null]
  );
  logAction(req, 'create', 'task', r.rows[0].id, r.rows[0].title);
  res.status(201).json(r.rows[0]);
});

router.put('/tasks/:id', canWrite, async (req, res, next) => {
  const id = badId(req.params.id);
  if (!id) return res.status(400).json({ error: 'invalid_id' });
  const { title, description, status, priority, due_date, due_time, client_id, vehicle_id, assigned_to, completed_at } = req.body || {};
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
     badId(client_id), badId(vehicle_id), assigned_to || null,
     completed_at || (status === 'done' ? new Date() : null),
     id]
  );
  if (!r.rows[0]) return res.status(404).json({ error: 'task_not_found' });
  logAction(req, 'update', 'task', id, r.rows[0].title);
  res.json(r.rows[0]);
});

router.delete('/tasks/:id', canWrite, async (req, res, next) => {
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

router.post('/client-records', canWrite, async (req, res, next) => {
  const {
    client_id, vehicle_id, booking_id, service_name, description, amount,
    date, time, master_id, is_paid, is_completed,
    advance, advance_date, end_date, category_id, payment_status, tags,
  } = req.body || {};
  const cid = badId(client_id);
  if (!cid) return res.status(400).json({ error: 'client_id_required' });
  if (!nonEmptyString(service_name)) return res.status(400).json({ error: 'service_name_required' });
  if (!date) return res.status(400).json({ error: 'date_required' });

  const r = await queryInSchema(
    req.session.schemaName,
    `INSERT INTO {{schema}}.client_records
       (client_id, vehicle_id, booking_id, service_name, description, amount,
        date, time, master_id, is_paid, is_completed,
        advance, advance_date, end_date, category_id, payment_status, tags)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb)
     RETURNING *`,
    [
      cid, badId(vehicle_id), badId(booking_id),
      service_name.trim(), description || null, amount || 0,
      date, time || null, master_id || null,
      Boolean(is_paid), Boolean(is_completed),
      advance || 0, advance_date || null, end_date || null,
      badId(category_id),
      payment_status || 'none',
      JSON.stringify(tags || []),
    ]
  );
  logAction(req, 'create', 'client_record', r.rows[0].id, service_name);
  res.status(201).json(r.rows[0]);
});

// PUT с whitelist полей — как в исходном index.cjs:2125
router.put('/client-records/:id', canWrite, async (req, res, next) => {
  const id = badId(req.params.id);
  if (!id) return res.status(400).json({ error: 'invalid_id' });
  const fields = req.body || {};
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
    let val = fields[key];
    if (key === 'category_id') val = badId(val);
    if (key === 'tags') val = JSON.stringify(val || []);
    set.push(`${col} = $${pi++}`);
    values.push(val);
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

router.delete('/client-records/:id', canWrite, async (req, res, next) => {
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

router.post('/categories', canWrite, async (req, res, next) => {
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

router.put('/categories/:id', canWrite, async (req, res, next) => {
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

router.delete('/categories/:id', canWrite, async (req, res, next) => {
  const id = badId(req.params.id);
  if (!id) return res.status(400).json({ error: 'invalid_id' });
  await queryInSchema(req.session.schemaName, `DELETE FROM {{schema}}.categories WHERE id=$1`, [id]);
  res.json({ ok: true });
});

// ══════════════════════════════════════════════════════════════════════
// TAGS
// ══════════════════════════════════════════════════════════════════════

router.get('/tags', async (req, res, next) => {
  const r = await queryInSchema(
    req.session.schemaName,
    `SELECT * FROM {{schema}}.tags ORDER BY name`
  );
  res.json(r.rows);
});

router.post('/tags', canWrite, async (req, res, next) => {
  const { name, color } = req.body || {};
  if (!nonEmptyString(name)) return res.status(400).json({ error: 'name_required' });
  const r = await queryInSchema(
    req.session.schemaName,
    `INSERT INTO {{schema}}.tags (name, color) VALUES ($1, $2) RETURNING *`,
    [name.trim(), color || null]
  );
  res.status(201).json(r.rows[0]);
});

router.delete('/tags/:id', canWrite, async (req, res, next) => {
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

router.post('/entity-tags', canWrite, async (req, res, next) => {
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

router.delete('/entity-tags/:id', canWrite, async (req, res, next) => {
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

router.post('/data/:key', canWrite, async (req, res, next) => {
  const { value } = req.body || {};
  await queryInSchema(
    req.session.schemaName,
    `INSERT INTO {{schema}}.app_data (key, value, updated_at)
       VALUES ($1, $2::jsonb, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [req.params.key, JSON.stringify(value)]
  );
  res.json({ ok: true });
});

// ══════════════════════════════════════════════════════════════════════
// ACTIVITY LOGS  (только для admin)
// ══════════════════════════════════════════════════════════════════════

router.get('/activity-logs', requireRole('owner'), async (req, res, next) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
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
  res.json(r.rows.map((u) => ({
    id: u.id,
    email: u.email,
    name: u.name,
    role: u.role,
    isActive: u.is_active,
    createdAt: u.created_at,
  })));
});

module.exports = router;
