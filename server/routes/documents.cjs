'use strict';
/**
 * Routes для документов по броням: заказ-наряд, акт приёмки, фото.
 *
 *   GET    /api/work-orders/:bookingId          — получить наряд (или 404)
 *   PUT    /api/work-orders/:bookingId          — upsert наряда
 *   GET    /api/work-orders/:bookingId/pdf      — PDF (генерируется на лету)
 *
 *   GET    /api/acceptance-acts/:bookingId      — получить акт (или 404)
 *   PUT    /api/acceptance-acts/:bookingId      — upsert акта
 *   GET    /api/acceptance-acts/:bookingId/pdf  — PDF
 *
 *   GET    /api/order-photos?bookingId=N        — список фото к броне
 *   POST   /api/order-photos                    — multipart: file, bookingId, photoType
 *   DELETE /api/order-photos/:id                — удалить фото (файлы + БД)
 *   GET    /api/order-photos/:id/file           — оригинал (под auth)
 *   GET    /api/order-photos/:id/thumb          — миниатюра 300×300
 *
 * Все роуты под requireAuth + requireActiveStudio (см. app.cjs).
 *
 * Хранение фото:
 *   var/documents/<schemaName>/photos/<id>.webp     — оригинал, max 1920×1920
 *   var/documents/<schemaName>/thumbs/<id>.webp     — превью, 300×300
 *   Файлы НЕ отдаются напрямую через nginx — проксируются через эти роуты,
 *   чтобы каждый запрос проходил requireActiveStudio (нельзя смотреть фото
 *   чужой студии даже зная id).
 *
 * Лимиты:
 *   - 30 фото на одну бронь (бэк-валидация перед INSERT)
 *   - 10 MB на upload (sharp дальше ужмёт)
 *   - signature_data ≤ 300 KB base64 (≈220 KB декодированной PNG)
 */

const path = require('node:path');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const express = require('express');
const multer = require('multer');
const sharp = require('sharp');

const { pool, queryInSchema } = require('../lib/db.cjs');
const { requireRole } = require('../lib/middleware.cjs');
const { logFromReq: logAction } = require('../lib/audit.cjs');
const { parseId, assertPngBase64, handleFieldError } = require('../lib/validation.cjs');
const { streamWorkOrderPdf } = require('../lib/pdf/workOrder.cjs');
const { streamAcceptanceActPdf } = require('../lib/pdf/acceptanceAct.cjs');

const router = express.Router();

// ──────────────────────────────────────────────────────────────────────
// Конфигурация
// ──────────────────────────────────────────────────────────────────────
const DOCS_DIR = process.env.DOCS_DIR
  || path.join(__dirname, '..', '..', 'var', 'documents');

const MAX_PHOTOS_PER_BOOKING = 30;
const PHOTO_UPLOAD_LIMIT_BYTES = 10 * 1024 * 1024;     // 10 MB
const SIGNATURE_MAX_LENGTH = 300 * 1024;               // ~300 KB base64

const VALID_PHOTO_TYPES = new Set(['acceptance', 'progress', 'result']);
const VALID_PAYMENT_METHODS = new Set(['cash', 'card', 'transfer']);
const VALID_CONDITIONS = new Set(['ok', 'minor', 'damaged']);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: PHOTO_UPLOAD_LIMIT_BYTES, files: 1 },
  fileFilter(req, file, cb) {
    if (!file.mimetype || !file.mimetype.startsWith('image/')) {
      return cb(new Error('not_an_image'));
    }
    cb(null, true);
  },
});

// Только owner и manager могут править документы; master — read-only.
const canWrite = requireRole('owner', 'manager');

// ──────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────
// logAction(req, action, ...) — обёртка из lib/audit.cjs#logFromReq,
// импортирована как алиас выше. badId — alias parseId.
const badId = parseId;

function ensureDir(dir) {
  return fs.mkdir(dir, { recursive: true });
}

function studioFilesDir(schemaName, sub) {
  // schemaName уже валидируется через queryInSchema, но в путях защитимся ещё
  // раз — берём только [a-z0-9_]+, чтобы исключить любые ../ и т. п.
  const safe = String(schemaName).replace(/[^a-z0-9_]/gi, '');
  return path.join(DOCS_DIR, safe, sub);
}

// Загружает booking + studio + client + vehicle + master для PDF.
// ВАЖНО: документы привязаны к client_records (а не к bookings — это слот в календаре).
// `booking` в возвращаемом объекте — это запись из client_records (id используется как booking_id в FK).
// Возвращает null если запись не найдена в этой студии.
async function loadBookingContext(schemaName, studioId, bookingId) {
  const r = await queryInSchema(
    schemaName,
    `SELECT b.*,
            c.id   AS c_id,   c.name  AS c_name,  c.phone AS c_phone, c.email AS c_email,
            c.notes AS c_notes,
            v.id   AS v_id,   v.brand AS v_brand, v.model AS v_model,
            v.year AS v_year, v.color AS v_color,
            v.license_plate AS v_plate, v.vin AS v_vin
       FROM {{schema}}.client_records b
       LEFT JOIN {{schema}}.clients  c ON c.id = b.client_id
       LEFT JOIN {{schema}}.vehicles v ON v.id = b.vehicle_id
      WHERE b.id = $1`,
    [bookingId]
  );
  if (!r.rows[0]) return null;
  const row = r.rows[0];

  // Авто из vehicles. Если строки нет — фолбэк на legacy-данные из clients.notes
  // (там UI клиентов хранит carBrand/carModel/vin/licensePlate в JSON).
  let vehicle = null;
  if (row.v_id) {
    vehicle = {
      id: row.v_id, brand: row.v_brand, model: row.v_model,
      year: row.v_year, color: row.v_color,
      license_plate: row.v_plate, vin: row.v_vin,
    };
  } else if (row.c_notes) {
    try {
      const n = typeof row.c_notes === 'string' ? JSON.parse(row.c_notes) : row.c_notes;
      if (n && (n.carBrand || n.carModel || n.vin || n.licensePlate)) {
        vehicle = {
          id: null,
          brand: n.carBrand || null,
          model: n.carModel || null,
          year:  null,
          color: null,
          license_plate: n.licensePlate || null,
          vin:   n.vin || null,
        };
      }
    } catch { /* notes — не JSON, игнорируем */ }
  }

  // Студия — из saas_meta для шапки PDF.
  const sRes = await pool.query(
    `SELECT id, display_name, inn, ogrn, legal_address, actual_address,
            contact_phone, contact_email, guarantee_text
       FROM saas_meta.studios WHERE id = $1`,
    [studioId]
  );
  const studio = sRes.rows[0] || null;

  // Мастер — из saas_meta.users (booking.master_id UUID).
  let master = null;
  if (row.master_id) {
    const mRes = await pool.query(
      `SELECT id, name, first_name, last_name FROM saas_meta.users WHERE id = $1`,
      [row.master_id]
    );
    if (mRes.rows[0]) {
      const m = mRes.rows[0];
      const composed = [m.first_name, m.last_name].filter(Boolean).join(' ').trim();
      master = { id: m.id, name: composed || m.name || '' };
    }
  }

  return {
    studio,
    booking: row,
    client:  row.c_id  ? { id: row.c_id,  name: row.c_name,  phone: row.c_phone, email: row.c_email } : null,
    vehicle,
    master,
  };
}

// Накладывает snapshot ПОВЕРХ объекта из БД. Снапшот выигрывает поле,
// если у него непустая строка/число; null/undefined/'' игнорируются.
function mergeSnapshot(base, snap) {
  const safeSnap = (snap && typeof snap === 'object') ? snap : {};
  const out = { ...(base || {}) };
  for (const [k, v] of Object.entries(safeSnap)) {
    if (v !== null && v !== undefined && v !== '') out[k] = v;
  }
  // Возвращаем объект, даже если base был null, при условии что snapshot не пуст.
  return Object.keys(out).length ? out : null;
}

// Бэк-филл данных клиента/авто из снапшота документа.
// Если в карточке клиента/авто соответствующее поле пустое — заполняем
// значением из снапшота. Никогда не перетираем уже введённые данные.
// Если у записи нет vehicle_id, но в снапшоте есть данные авто — создаём
// vehicle и привязываем к client_records и к client. Это позволяет в следующий
// раз подтягивать данные из карточки автоматически.
async function backfillClientAndVehicle(schemaName, bookingId, ctx, clientSnap, vehicleSnap) {
  const cId = ctx?.client?.id || ctx?.booking?.client_id || null;
  const vId = ctx?.vehicle?.id || null;

  if (cId && clientSnap) {
    await queryInSchema(
      schemaName,
      `UPDATE {{schema}}.clients
          SET phone      = COALESCE(NULLIF(phone, ''), $2, phone),
              email      = COALESCE(NULLIF(email, ''), $3, email),
              updated_at = now()
        WHERE id = $1`,
      [cId, clientSnap.phone, clientSnap.email]
    );
  }

  // Параллельно обновляем legacy-хранилище в clients.notes (carBrand/carModel/vin/licensePlate),
  // чтобы карточка клиента в общей таблице тоже отражала новые данные.
  if (cId && vehicleSnap && (vehicleSnap.brand || vehicleSnap.model || vehicleSnap.vin || vehicleSnap.license_plate)) {
    const cur = await queryInSchema(
      schemaName,
      `SELECT notes FROM {{schema}}.clients WHERE id = $1`,
      [cId]
    );
    let parsed = {};
    const raw = cur.rows[0]?.notes;
    if (raw) {
      try { parsed = (typeof raw === 'string') ? JSON.parse(raw) : raw; } catch { parsed = {}; }
      if (parsed === null || typeof parsed !== 'object') parsed = {};
    }
    const merged = {
      ...parsed,
      carBrand:     parsed.carBrand     || vehicleSnap.brand         || parsed.carBrand     || '',
      carModel:     parsed.carModel     || vehicleSnap.model         || parsed.carModel     || '',
      vin:          parsed.vin          || vehicleSnap.vin           || parsed.vin          || '',
      licensePlate: parsed.licensePlate || vehicleSnap.license_plate || parsed.licensePlate || '',
    };
    await queryInSchema(
      schemaName,
      `UPDATE {{schema}}.clients SET notes = $2, updated_at = now() WHERE id = $1`,
      [cId, JSON.stringify(merged)]
    );
  }

  if (vId && vehicleSnap) {
    await queryInSchema(
      schemaName,
      `UPDATE {{schema}}.vehicles
          SET brand         = COALESCE(NULLIF(brand, ''),         $2, brand),
              model         = COALESCE(NULLIF(model, ''),         $3, model),
              color         = COALESCE(NULLIF(color, ''),         $4, color),
              license_plate = COALESCE(NULLIF(license_plate, ''), $5, license_plate),
              vin           = COALESCE(NULLIF(vin, ''),           $6, vin),
              year          = COALESCE(year, $7, year),
              updated_at    = now()
        WHERE id = $1`,
      [vId, vehicleSnap.brand, vehicleSnap.model, vehicleSnap.color,
       vehicleSnap.license_plate, vehicleSnap.vin, vehicleSnap.year]
    );
  } else if (cId && vehicleSnap && (vehicleSnap.brand || vehicleSnap.license_plate || vehicleSnap.vin || vehicleSnap.model)) {
    // Создаём авто. brand NOT NULL — если его нет, ставим прочерк.
    const ins = await queryInSchema(
      schemaName,
      `INSERT INTO {{schema}}.vehicles
         (client_id, brand, model, color, license_plate, vin, year)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id`,
      [cId, vehicleSnap.brand || '—', vehicleSnap.model, vehicleSnap.color,
       vehicleSnap.license_plate, vehicleSnap.vin, vehicleSnap.year]
    );
    const newVehicleId = ins.rows[0].id;
    await queryInSchema(
      schemaName,
      `UPDATE {{schema}}.client_records
          SET vehicle_id = $2
        WHERE id = $1 AND vehicle_id IS NULL`,
      [bookingId, newVehicleId]
    );
  }
}

function sanitizeClientSnapshot(s) {
  if (!s || typeof s !== 'object') return {};
  const pick = (k) => (typeof s[k] === 'string' ? s[k].trim() : '') || null;
  return {
    name:  pick('name'),
    phone: pick('phone'),
    email: pick('email'),
  };
}

function sanitizeVehicleSnapshot(s) {
  if (!s || typeof s !== 'object') return {};
  const pickStr = (k) => (typeof s[k] === 'string' ? s[k].trim() : '') || null;
  let year = null;
  if (s.year != null && s.year !== '') {
    const n = parseInt(s.year, 10);
    if (Number.isFinite(n) && n >= 1900 && n <= 2100) year = n;
  }
  return {
    brand:         pickStr('brand'),
    model:         pickStr('model'),
    color:         pickStr('color'),
    license_plate: pickStr('license_plate'),
    vin:           pickStr('vin'),
    year,
  };
}

function validateSignature(sig) {
  if (sig === null || sig === undefined || sig === '') return null;
  if (typeof sig !== 'string') {
    const e = new Error('signature_invalid'); e.status = 400; throw e;
  }
  if (sig.length > SIGNATURE_MAX_LENGTH) {
    const e = new Error('signature_too_large'); e.status = 400; throw e;
  }
  if (!sig.startsWith('data:image/png;base64,')) {
    const e = new Error('signature_format_invalid'); e.status = 400; throw e;
  }
  // Magic-byte verification: декодируем base64 и проверяем PNG signature
  // (0x89 P N G \r \n 0x1A \n). Раньше принимали любую base64-строку с
  // правильным префиксом — атакующий мог положить туда любой бинарь
  // (например, JPEG или вообще ZIP) и сломать PDF rendering, либо
  // протащить произвольные данные в документ.
  // assertPngBase64 кидает FIELD_INVALID — мапим на наш протокол ошибок.
  try {
    // signature_data приходит как 'data:image/png;base64,XXX' — assertPngBase64
    // снимает префикс и возвращает raw base64. Лимит ~225KB декодированных
    // байт (300KB base64 × 3/4).
    assertPngBase64(sig, 'signature_data', Math.floor(SIGNATURE_MAX_LENGTH * 3 / 4));
  } catch (e2) {
    const e = new Error('signature_format_invalid'); e.status = 400; throw e;
  }
  return sig;
}

function validateItems(items) {
  if (items === null || items === undefined) return [];
  if (!Array.isArray(items)) {
    const e = new Error('items_must_be_array'); e.status = 400; throw e;
  }
  if (items.length > 100) {
    const e = new Error('too_many_items'); e.status = 400; throw e;
  }
  return items.map((it, i) => {
    if (!it || typeof it !== 'object') {
      const e = new Error(`item_${i}_invalid`); e.status = 400; throw e;
    }
    const name = typeof it.name === 'string' ? it.name.trim() : '';
    if (!name) {
      const e = new Error(`item_${i}_name_required`); e.status = 400; throw e;
    }
    const quantity = Number(it.quantity);
    const price    = Number(it.price);
    if (!Number.isFinite(quantity) || quantity < 0 || quantity > 99999) {
      const e = new Error(`item_${i}_quantity_invalid`); e.status = 400; throw e;
    }
    if (!Number.isFinite(price) || price < 0) {
      const e = new Error(`item_${i}_price_invalid`); e.status = 400; throw e;
    }
    return { name, quantity, price };
  });
}

function validateZones(zones) {
  if (zones === null || zones === undefined) return [];
  if (!Array.isArray(zones)) {
    const e = new Error('zones_must_be_array'); e.status = 400; throw e;
  }
  if (zones.length > 100) {
    const e = new Error('too_many_zones'); e.status = 400; throw e;
  }
  return zones.map((z, i) => {
    if (!z || typeof z !== 'object') {
      const e = new Error(`zone_${i}_invalid`); e.status = 400; throw e;
    }
    const name = typeof z.zone_name === 'string' ? z.zone_name.trim() : '';
    if (!name) {
      const e = new Error(`zone_${i}_name_required`); e.status = 400; throw e;
    }
    const condition = z.condition || 'ok';
    if (!VALID_CONDITIONS.has(condition)) {
      const e = new Error(`zone_${i}_condition_invalid`); e.status = 400; throw e;
    }
    return {
      zone_name: name,
      scratches: !!z.scratches,
      dents:     !!z.dents,
      condition,
    };
  });
}

// ══════════════════════════════════════════════════════════════════════
// DOCUMENT CONTEXT (для пред-заполнения форм)
// ══════════════════════════════════════════════════════════════════════
// Возвращает client + vehicle, известные из БД, чтобы фронт мог пред-заполнить
// поля акта/наряда. Если vehicle нет, возвращаем null — фронт оставит поля пустыми.
router.get('/document-context/:bookingId', async (req, res, next) => {
  try {
    const id = badId(req.params.bookingId);
    if (!id) return res.status(400).json({ error: 'invalid_booking_id' });
    const ctx = await loadBookingContext(req.session.schemaName, req.session.studioId, id);
    if (!ctx) return res.status(404).json({ error: 'booking_not_found' });
    res.json({
      client:  ctx.client,
      vehicle: ctx.vehicle,
      record:  { id: ctx.booking.id, service_name: ctx.booking.service_name },
    });
  } catch (err) { next(err); }
});

// ══════════════════════════════════════════════════════════════════════
// WORK ORDERS
// ══════════════════════════════════════════════════════════════════════

router.get('/work-orders/:bookingId', async (req, res, next) => {
  try {
    const id = badId(req.params.bookingId);
    if (!id) return res.status(400).json({ error: 'invalid_booking_id' });
    const r = await queryInSchema(
      req.session.schemaName,
      `SELECT * FROM {{schema}}.work_orders WHERE booking_id = $1`,
      [id]
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'work_order_not_found' });
    res.json(r.rows[0]);
  } catch (err) { next(err); }
});

router.put('/work-orders/:bookingId', canWrite, async (req, res, next) => {
  try {
    const bookingId = badId(req.params.bookingId);
    if (!bookingId) return res.status(400).json({ error: 'invalid_booking_id' });

    // Проверим, что запись принадлежит студии (вне студии queryInSchema не достанет).
    const bk = await queryInSchema(
      req.session.schemaName,
      `SELECT id, master_id FROM {{schema}}.client_records WHERE id = $1`,
      [bookingId]
    );
    if (!bk.rows[0]) return res.status(404).json({ error: 'booking_not_found' });

    const body = req.body || {};
    const items = validateItems(body.items);
    const signature = validateSignature(body.signature_data);

    let paymentMethod = body.payment_method || null;
    if (paymentMethod && !VALID_PAYMENT_METHODS.has(paymentMethod)) {
      return res.status(400).json({ error: 'payment_method_invalid' });
    }

    const discount = Number(body.discount) || 0;
    const total    = body.total != null ? Number(body.total) : null;
    if (!Number.isFinite(discount) || discount < 0) {
      return res.status(400).json({ error: 'discount_invalid' });
    }
    if (total != null && (!Number.isFinite(total) || total < 0)) {
      return res.status(400).json({ error: 'total_invalid' });
    }

    // master_id — UUID. Если не передан, наследуем от booking.master_id.
    const masterId = body.master_id || bk.rows[0].master_id || null;

    const clientSnapshot  = sanitizeClientSnapshot(body.client_snapshot);
    const vehicleSnapshot = sanitizeVehicleSnapshot(body.vehicle_snapshot);

    const r = await queryInSchema(
      req.session.schemaName,
      `INSERT INTO {{schema}}.work_orders
         (booking_id, master_id, delivery_date, delivery_time, payment_method,
          discount, total, items, guarantee_text, notes,
          client_snapshot, vehicle_snapshot,
          signature_data, is_signed, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10,
               $11::jsonb, $12::jsonb,
               $13, $14, $15)
       ON CONFLICT (booking_id) DO UPDATE SET
         master_id        = EXCLUDED.master_id,
         delivery_date    = EXCLUDED.delivery_date,
         delivery_time    = EXCLUDED.delivery_time,
         payment_method   = EXCLUDED.payment_method,
         discount         = EXCLUDED.discount,
         total            = EXCLUDED.total,
         items            = EXCLUDED.items,
         guarantee_text   = EXCLUDED.guarantee_text,
         notes            = EXCLUDED.notes,
         client_snapshot  = EXCLUDED.client_snapshot,
         vehicle_snapshot = EXCLUDED.vehicle_snapshot,
         signature_data   = EXCLUDED.signature_data,
         is_signed        = EXCLUDED.is_signed,
         updated_at       = now()
       RETURNING *`,
      [
        bookingId, masterId,
        body.delivery_date || null,
        body.delivery_time || null,
        paymentMethod,
        discount,
        total,
        JSON.stringify(items),
        body.guarantee_text || null,
        body.notes || null,
        JSON.stringify(clientSnapshot),
        JSON.stringify(vehicleSnapshot),
        signature,
        !!signature,
        req.session.userId,
      ]
    );
    logAction(req, 'update', 'work_order', r.rows[0].id, `Бронь #${bookingId}`);

    // Бэк-филл: данные из формы → карточка клиента/авто, если там пусто.
    // Так при следующем визите всё подтянется автоматически.
    try {
      const ctx = await loadBookingContext(req.session.schemaName, req.session.studioId, bookingId);
      await backfillClientAndVehicle(req.session.schemaName, bookingId, ctx, clientSnapshot, vehicleSnapshot);
    } catch (e) {
      // Бэк-филл не критичен — сам наряд уже сохранён.
      console.warn('[work-orders] backfill skipped:', e?.message || e);
    }

    res.json(r.rows[0]);
  } catch (err) {
    if (err.status === 400) return res.status(400).json({ error: err.message });
    next(err);
  }
});

router.get('/work-orders/:bookingId/pdf', async (req, res, next) => {
  try {
    const id = badId(req.params.bookingId);
    if (!id) return res.status(400).json({ error: 'invalid_booking_id' });

    const woRes = await queryInSchema(
      req.session.schemaName,
      `SELECT * FROM {{schema}}.work_orders WHERE booking_id = $1`,
      [id]
    );
    if (!woRes.rows[0]) return res.status(404).json({ error: 'work_order_not_found' });

    const ctx = await loadBookingContext(req.session.schemaName, req.session.studioId, id);
    if (!ctx) return res.status(404).json({ error: 'booking_not_found' });

    const wo = woRes.rows[0];
    const mergedClient  = mergeSnapshot(ctx.client,  wo.client_snapshot);
    const mergedVehicle = mergeSnapshot(ctx.vehicle, wo.vehicle_snapshot);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition',
      `inline; filename="work_order_${wo.id}.pdf"`);
    streamWorkOrderPdf(res, {
      ...ctx,
      client:  mergedClient,
      vehicle: mergedVehicle,
      workOrder: wo,
    });
  } catch (err) { next(err); }
});

// ══════════════════════════════════════════════════════════════════════
// ACCEPTANCE ACTS
// ══════════════════════════════════════════════════════════════════════

router.get('/acceptance-acts/:bookingId', async (req, res, next) => {
  try {
    const id = badId(req.params.bookingId);
    if (!id) return res.status(400).json({ error: 'invalid_booking_id' });
    const r = await queryInSchema(
      req.session.schemaName,
      `SELECT * FROM {{schema}}.acceptance_acts WHERE booking_id = $1`,
      [id]
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'acceptance_act_not_found' });
    res.json(r.rows[0]);
  } catch (err) { next(err); }
});

router.put('/acceptance-acts/:bookingId', canWrite, async (req, res, next) => {
  try {
    const bookingId = badId(req.params.bookingId);
    if (!bookingId) return res.status(400).json({ error: 'invalid_booking_id' });

    const bk = await queryInSchema(
      req.session.schemaName,
      `SELECT id, master_id FROM {{schema}}.client_records WHERE id = $1`,
      [bookingId]
    );
    if (!bk.rows[0]) return res.status(404).json({ error: 'booking_not_found' });

    const body = req.body || {};
    const zones = validateZones(body.zones);
    const signature = validateSignature(body.signature_data);

    let mileage = null;
    if (body.mileage != null && body.mileage !== '') {
      mileage = parseInt(body.mileage, 10);
      if (!Number.isFinite(mileage) || mileage < 0 || mileage > 9999999) {
        return res.status(400).json({ error: 'mileage_invalid' });
      }
    }

    const masterId = body.master_id || bk.rows[0].master_id || null;
    const clientSnapshot  = sanitizeClientSnapshot(body.client_snapshot);
    const vehicleSnapshot = sanitizeVehicleSnapshot(body.vehicle_snapshot);

    const r = await queryInSchema(
      req.session.schemaName,
      `INSERT INTO {{schema}}.acceptance_acts
         (booking_id, master_id, mileage, zones, damage_description,
          valuables, client_snapshot, vehicle_snapshot,
          signature_data, is_signed, created_by)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7::jsonb, $8::jsonb, $9, $10, $11)
       ON CONFLICT (booking_id) DO UPDATE SET
         master_id          = EXCLUDED.master_id,
         mileage            = EXCLUDED.mileage,
         zones              = EXCLUDED.zones,
         damage_description = EXCLUDED.damage_description,
         valuables          = EXCLUDED.valuables,
         client_snapshot    = EXCLUDED.client_snapshot,
         vehicle_snapshot   = EXCLUDED.vehicle_snapshot,
         signature_data     = EXCLUDED.signature_data,
         is_signed          = EXCLUDED.is_signed,
         updated_at         = now()
       RETURNING *`,
      [
        bookingId, masterId, mileage,
        JSON.stringify(zones),
        body.damage_description || null,
        body.valuables || null,
        JSON.stringify(clientSnapshot),
        JSON.stringify(vehicleSnapshot),
        signature,
        !!signature,
        req.session.userId,
      ]
    );

    // Пересчитываем photos_count из реальных order_photos: фото могли загрузить
    // ДО первого сохранения акта — тогда счётчик в самом акте отстаёт.
    const upd = await queryInSchema(
      req.session.schemaName,
      `UPDATE {{schema}}.acceptance_acts
          SET photos_count = (SELECT count(*) FROM {{schema}}.order_photos WHERE booking_id = $1)
        WHERE booking_id = $1
        RETURNING *`,
      [bookingId]
    );

    logAction(req, 'update', 'acceptance_act', r.rows[0].id, `Бронь #${bookingId}`);

    // Бэк-филл: данные из формы → карточка клиента/авто, если там пусто.
    try {
      const ctx = await loadBookingContext(req.session.schemaName, req.session.studioId, bookingId);
      await backfillClientAndVehicle(req.session.schemaName, bookingId, ctx, clientSnapshot, vehicleSnapshot);
    } catch (e) {
      console.warn('[acceptance-acts] backfill skipped:', e?.message || e);
    }

    res.json(upd.rows[0] || r.rows[0]);
  } catch (err) {
    if (err.status === 400) return res.status(400).json({ error: err.message });
    next(err);
  }
});

router.get('/acceptance-acts/:bookingId/pdf', async (req, res, next) => {
  try {
    const id = badId(req.params.bookingId);
    if (!id) return res.status(400).json({ error: 'invalid_booking_id' });

    const aRes = await queryInSchema(
      req.session.schemaName,
      `SELECT * FROM {{schema}}.acceptance_acts WHERE booking_id = $1`,
      [id]
    );
    if (!aRes.rows[0]) return res.status(404).json({ error: 'acceptance_act_not_found' });

    const ctx = await loadBookingContext(req.session.schemaName, req.session.studioId, id);
    if (!ctx) return res.status(404).json({ error: 'booking_not_found' });

    const act = aRes.rows[0];
    const mergedClient  = mergeSnapshot(ctx.client,  act.client_snapshot);
    const mergedVehicle = mergeSnapshot(ctx.vehicle, act.vehicle_snapshot);

    // Свежий счёт фото на лету — счётчик в акте мог отставать, если фото
    // догружали после save или авто-обновление вообще не отработало.
    const cnt = await queryInSchema(
      req.session.schemaName,
      `SELECT count(*)::int AS n FROM {{schema}}.order_photos WHERE booking_id = $1`,
      [id]
    );
    act.photos_count = cnt.rows[0].n;

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition',
      `inline; filename="acceptance_act_${act.id}.pdf"`);
    streamAcceptanceActPdf(res, {
      ...ctx,
      client:  mergedClient,
      vehicle: mergedVehicle,
      act,
    });
  } catch (err) { next(err); }
});

// ══════════════════════════════════════════════════════════════════════
// ORDER PHOTOS
// ══════════════════════════════════════════════════════════════════════

router.get('/order-photos', async (req, res, next) => {
  try {
    const bookingId = badId(req.query.bookingId);
    if (!bookingId) return res.status(400).json({ error: 'booking_id_required' });
    const r = await queryInSchema(
      req.session.schemaName,
      `SELECT id, booking_id, photo_type, file_size, mime_type, created_at, created_by
         FROM {{schema}}.order_photos
        WHERE booking_id = $1
        ORDER BY created_at ASC`,
      [bookingId]
    );
    res.json(r.rows);
  } catch (err) { next(err); }
});

router.post('/order-photos', canWrite, (req, res, next) => {
  upload.single('file')(req, res, async (err) => {
    try {
      if (err) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          return res.status(413).json({ error: 'file_too_large', limitBytes: PHOTO_UPLOAD_LIMIT_BYTES });
        }
        if (err.message === 'not_an_image') return res.status(400).json({ error: 'not_an_image' });
        return next(err);
      }
      if (!req.file) return res.status(400).json({ error: 'file_required' });

      const bookingId = badId(req.body.bookingId);
      if (!bookingId) return res.status(400).json({ error: 'invalid_booking_id' });

      const photoType = req.body.photoType || 'acceptance';
      if (!VALID_PHOTO_TYPES.has(photoType)) {
        return res.status(400).json({ error: 'photo_type_invalid' });
      }

      // Запись клиента должна существовать в этой студии.
      const bk = await queryInSchema(
        req.session.schemaName,
        `SELECT id FROM {{schema}}.client_records WHERE id = $1`,
        [bookingId]
      );
      if (!bk.rows[0]) return res.status(404).json({ error: 'booking_not_found' });

      // Лимит 30 фото на бронь.
      const cnt = await queryInSchema(
        req.session.schemaName,
        `SELECT count(*)::int AS n FROM {{schema}}.order_photos WHERE booking_id = $1`,
        [bookingId]
      );
      if (cnt.rows[0].n >= MAX_PHOTOS_PER_BOOKING) {
        return res.status(409).json({ error: 'photo_limit_reached', limit: MAX_PHOTOS_PER_BOOKING });
      }

      // Создаём строку в БД ПЕРЕД сохранением файла, чтобы получить SERIAL id
      // и использовать его в имени файла.
      const ins = await queryInSchema(
        req.session.schemaName,
        `INSERT INTO {{schema}}.order_photos
           (booking_id, file_path, photo_type, file_size, mime_type, created_by)
         VALUES ($1, '', $2, $3, $4, $5) RETURNING id`,
        [bookingId, photoType, req.file.size, 'image/webp', req.session.userId]
      );
      const photoId = ins.rows[0].id;

      const photosDir = studioFilesDir(req.session.schemaName, 'photos');
      const thumbsDir = studioFilesDir(req.session.schemaName, 'thumbs');
      await ensureDir(photosDir);
      await ensureDir(thumbsDir);

      const filePath  = path.join(photosDir, `${photoId}.webp`);
      const thumbPath = path.join(thumbsDir, `${photoId}.webp`);

      try {
        // Главное фото — webp до 1920×1920, с rotate() чтобы убрать EXIF-ориентацию.
        await sharp(req.file.buffer)
          .rotate()
          .resize(1920, 1920, { fit: 'inside', withoutEnlargement: true })
          .webp({ quality: 82 })
          .toFile(filePath);
        // Превью 300×300 (cover).
        await sharp(req.file.buffer)
          .rotate()
          .resize(300, 300, { fit: 'cover' })
          .webp({ quality: 75 })
          .toFile(thumbPath);
      } catch (e) {
        // Если sharp не смог обработать (битый файл) — снести строку и вернуть 400.
        await queryInSchema(
          req.session.schemaName,
          `DELETE FROM {{schema}}.order_photos WHERE id = $1`, [photoId]
        );
        return res.status(400).json({ error: 'image_processing_failed' });
      }

      // Сохраняем относительные пути (схема + id) — не абсолютные, для переносимости.
      const relFile  = `photos/${photoId}.webp`;
      const relThumb = `thumbs/${photoId}.webp`;
      const final = await queryInSchema(
        req.session.schemaName,
        `UPDATE {{schema}}.order_photos
            SET file_path = $1, thumbnail_path = $2
          WHERE id = $3
          RETURNING id, booking_id, photo_type, file_size, mime_type, created_at`,
        [relFile, relThumb, photoId]
      );

      // Обновляем счётчик в acceptance_acts (если акт уже есть).
      await queryInSchema(
        req.session.schemaName,
        `UPDATE {{schema}}.acceptance_acts
            SET photos_count = (SELECT count(*) FROM {{schema}}.order_photos WHERE booking_id = $1)
          WHERE booking_id = $1`,
        [bookingId]
      );

      logAction(req, 'create', 'order_photo', photoId, `Бронь #${bookingId}`);
      res.status(201).json(final.rows[0]);
    } catch (e) { next(e); }
  });
});

// Стрим оригинала. requireActiveStudio + проверка, что фото принадлежит этой студии.
router.get('/order-photos/:id/file', async (req, res, next) => {
  try {
    const id = badId(req.params.id);
    if (!id) return res.status(400).json({ error: 'invalid_id' });
    const r = await queryInSchema(
      req.session.schemaName,
      `SELECT id FROM {{schema}}.order_photos WHERE id = $1`,
      [id]
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'photo_not_found' });
    const filePath = path.join(studioFilesDir(req.session.schemaName, 'photos'), `${id}.webp`);
    if (!fsSync.existsSync(filePath)) return res.status(404).json({ error: 'file_missing' });
    res.setHeader('Content-Type', 'image/webp');
    res.setHeader('Cache-Control', 'private, max-age=300');
    fsSync.createReadStream(filePath).pipe(res);
  } catch (err) { next(err); }
});

router.get('/order-photos/:id/thumb', async (req, res, next) => {
  try {
    const id = badId(req.params.id);
    if (!id) return res.status(400).json({ error: 'invalid_id' });
    const r = await queryInSchema(
      req.session.schemaName,
      `SELECT id FROM {{schema}}.order_photos WHERE id = $1`,
      [id]
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'photo_not_found' });
    const filePath = path.join(studioFilesDir(req.session.schemaName, 'thumbs'), `${id}.webp`);
    if (!fsSync.existsSync(filePath)) return res.status(404).json({ error: 'file_missing' });
    res.setHeader('Content-Type', 'image/webp');
    res.setHeader('Cache-Control', 'private, max-age=300');
    fsSync.createReadStream(filePath).pipe(res);
  } catch (err) { next(err); }
});

router.delete('/order-photos/:id', canWrite, async (req, res, next) => {
  try {
    const id = badId(req.params.id);
    if (!id) return res.status(400).json({ error: 'invalid_id' });
    const r = await queryInSchema(
      req.session.schemaName,
      `DELETE FROM {{schema}}.order_photos WHERE id = $1
         RETURNING booking_id`,
      [id]
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'photo_not_found' });

    const bookingId = r.rows[0].booking_id;
    // Удаляем файлы (best-effort — если уже нет, не страшно).
    const fp = path.join(studioFilesDir(req.session.schemaName, 'photos'), `${id}.webp`);
    const tp = path.join(studioFilesDir(req.session.schemaName, 'thumbs'), `${id}.webp`);
    await fs.unlink(fp).catch(() => {});
    await fs.unlink(tp).catch(() => {});

    await queryInSchema(
      req.session.schemaName,
      `UPDATE {{schema}}.acceptance_acts
          SET photos_count = (SELECT count(*) FROM {{schema}}.order_photos WHERE booking_id = $1)
        WHERE booking_id = $1`,
      [bookingId]
    );

    logAction(req, 'delete', 'order_photo', id, `Бронь #${bookingId}`);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

module.exports = router;
