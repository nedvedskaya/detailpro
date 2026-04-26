'use strict';
/**
 * Profile routes — единый источник правды для UI-блока «Профиль».
 *
 *   GET    /api/profile           — данные текущего пользователя + студии + лимиты тарифа.
 *   PATCH  /api/profile           — редактирование first_name / last_name / phone.
 *   POST   /api/profile/avatar    — загрузка аватара (multipart, ресайз 512×512 webp).
 *   DELETE /api/profile/avatar    — удалить аватар.
 *
 * Все роуты под requireAuth (но НЕ под requireActiveStudio — пользователь
 * с просроченной подпиской должен видеть свой профиль, чтобы повысить тариф).
 *
 * Аватары хранятся как файлы:
 *   /var/www/saas-crm/var/avatars/<user_id>.webp
 *   В БД: avatar_path = '/avatars/<user_id>.webp' (URL для nginx).
 *   nginx обслуживает /avatars/ через alias на /var/www/saas-crm/var/avatars/.
 *
 * SECURITY:
 *   - Один файл на пользователя (по user_id) — нельзя залить чужой аватар.
 *   - Лимит 5 MB на upload, ресайз до 512×512 → итог обычно <50 KB.
 *   - sharp валидирует, что байты — реальная картинка, иначе кидает ошибку.
 *   - На signup → файл ещё не существует, avatar_path = null. UI показывает заглушку.
 */

const path = require('node:path');
const fs = require('node:fs/promises');
const express = require('express');
const multer = require('multer');
const sharp = require('sharp');

const { pool } = require('../lib/db.cjs');
const { requireAuth } = require('../lib/middleware.cjs');
const { planMeta, maxUsersForPlan } = require('../lib/plans.cjs');

const router = express.Router();

// ──────────────────────────────────────────────────────────────────────
// Конфигурация хранилища аватаров
// ──────────────────────────────────────────────────────────────────────
const AVATARS_DIR = process.env.AVATARS_DIR
  || path.join(__dirname, '..', '..', 'var', 'avatars');

// 5 MB — клиент сам жмёт перед отправкой (compressImage), но даём запас.
const AVATAR_UPLOAD_LIMIT_BYTES = 5 * 1024 * 1024;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: AVATAR_UPLOAD_LIMIT_BYTES, files: 1 },
  fileFilter(req, file, cb) {
    // Принимаем только image/*. Дополнительная проверка sharp ниже.
    if (!file.mimetype || !file.mimetype.startsWith('image/')) {
      return cb(new Error('not_an_image'));
    }
    cb(null, true);
  },
});

async function ensureAvatarsDir() {
  await fs.mkdir(AVATARS_DIR, { recursive: true });
}

// ──────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────
function buildDisplayName(row) {
  const fn = (row.first_name || '').trim();
  const ln = (row.last_name  || '').trim();
  const combined = `${fn} ${ln}`.trim();
  return combined || row.name || '';
}

function shapeProfileResponse({ userRow, studioRow, currentUsers }) {
  const meta = planMeta(studioRow.plan);
  const maxUsers = maxUsersForPlan(studioRow.plan);

  return {
    user: {
      id: userRow.id,
      email: userRow.email,
      role: userRow.role,
      firstName: userRow.first_name,
      lastName: userRow.last_name,
      name: buildDisplayName(userRow),
      phone: userRow.phone,
      avatarPath: userRow.avatar_path,
      isActive: userRow.is_active,
      createdAt: userRow.created_at,
    },
    studio: {
      id: studioRow.id,
      displayName: studioRow.display_name,
      plan: studioRow.plan,
      planLabel: meta.label,
      planPriceRub: meta.priceRub,
      planUpgradeable: meta.upgradeable,
      accessUntil: studioRow.access_until,
      isActive: studioRow.is_active,
      createdAt: studioRow.created_at,
    },
    limits: {
      currentUsers,
      maxUsers,
      canAddUsers: currentUsers < maxUsers,
    },
  };
}

// ──────────────────────────────────────────────────────────────────────
// GET /api/profile
// ──────────────────────────────────────────────────────────────────────
router.get('/', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT
          u.id, u.email, u.role, u.name,
          u.first_name, u.last_name, u.phone, u.avatar_path,
          u.is_active, u.created_at,
          s.id AS studio_id, s.display_name, s.plan,
          s.is_active AS studio_active, s.access_until,
          s.created_at AS studio_created_at,
          (SELECT count(*)::int FROM saas_meta.users
            WHERE studio_id = s.id AND is_active = true) AS current_users
         FROM saas_meta.users u
         JOIN saas_meta.studios s ON s.id = u.studio_id
        WHERE u.id = $1`,
      [req.session.userId]
    );
    const row = rows[0];
    if (!row) return res.status(404).json({ error: 'user_not_found' });

    const userRow = {
      id: row.id, email: row.email, role: row.role, name: row.name,
      first_name: row.first_name, last_name: row.last_name, phone: row.phone,
      avatar_path: row.avatar_path, is_active: row.is_active, created_at: row.created_at,
    };
    const studioRow = {
      id: row.studio_id, display_name: row.display_name, plan: row.plan,
      is_active: row.studio_active, access_until: row.access_until,
      created_at: row.studio_created_at,
    };

    res.json(shapeProfileResponse({
      userRow, studioRow, currentUsers: row.current_users,
    }));
  } catch (err) { next(err); }
});

// ──────────────────────────────────────────────────────────────────────
// PATCH /api/profile
// Body: { firstName?, lastName?, phone? }
// ──────────────────────────────────────────────────────────────────────
router.patch('/', requireAuth, async (req, res, next) => {
  try {
    const body = req.body || {};
    const fields = {};

    function takeOptionalString(key, dbField, maxLen = 100) {
      if (!Object.prototype.hasOwnProperty.call(body, key)) return;
      const raw = body[key];
      if (raw === null || raw === '') {
        fields[dbField] = null;
        return;
      }
      if (typeof raw !== 'string') {
        const e = new Error(`${key}_must_be_string`); e.status = 400; throw e;
      }
      const trimmed = raw.trim();
      if (trimmed.length > maxLen) {
        const e = new Error(`${key}_too_long`); e.status = 400; throw e;
      }
      fields[dbField] = trimmed;
    }

    takeOptionalString('firstName', 'first_name', 100);
    takeOptionalString('lastName',  'last_name',  100);
    takeOptionalString('phone',     'phone',      40);

    const keys = Object.keys(fields);
    if (keys.length === 0) {
      return res.status(400).json({ error: 'no_fields_to_update' });
    }

    // Также обновим computed name для UserMenu, если оба first/last_name заданы.
    // Логика: если меняется first_name или last_name, name = trim(first + ' ' + last)
    //          но ТОЛЬКО если оба не null после апдейта.
    let setClauses = [];
    let values = [];
    let i = 1;
    for (const k of keys) {
      setClauses.push(`${k} = $${i++}`);
      values.push(fields[k]);
    }

    // Если меняем имя/фамилию — пересоберём `name` в БД (для совместимости
    // с местами кода, где ещё читают users.name напрямую).
    if ('first_name' in fields || 'last_name' in fields) {
      // подзапрос: COALESCE с уже обновлёнными значениями
      const fnSql = ('first_name' in fields)
        ? `$${keys.indexOf('first_name') + 1}`
        : 'first_name';
      const lnSql = ('last_name' in fields)
        ? `$${keys.indexOf('last_name') + 1}`
        : 'last_name';
      setClauses.push(
        `name = NULLIF(TRIM(COALESCE(${fnSql}, '') || ' ' || COALESCE(${lnSql}, '')), '')`
      );
    }

    values.push(req.session.userId);

    const r = await pool.query(
      `UPDATE saas_meta.users
          SET ${setClauses.join(', ')}
        WHERE id = $${values.length}
        RETURNING id, email, role, name, first_name, last_name, phone, avatar_path, is_active, created_at`,
      values
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'user_not_found' });

    res.json({
      ok: true,
      user: {
        id: r.rows[0].id, email: r.rows[0].email, role: r.rows[0].role,
        firstName: r.rows[0].first_name, lastName: r.rows[0].last_name,
        name: buildDisplayName(r.rows[0]),
        phone: r.rows[0].phone, avatarPath: r.rows[0].avatar_path,
        isActive: r.rows[0].is_active, createdAt: r.rows[0].created_at,
      },
    });
  } catch (err) {
    if (err.status === 400) return res.status(400).json({ error: err.message });
    next(err);
  }
});

// ──────────────────────────────────────────────────────────────────────
// POST /api/profile/avatar
// multipart/form-data: avatar=<file>
// ──────────────────────────────────────────────────────────────────────
router.post('/avatar', requireAuth, (req, res, next) => {
  upload.single('avatar')(req, res, async (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ error: 'file_too_large', limitBytes: AVATAR_UPLOAD_LIMIT_BYTES });
      }
      if (err.message === 'not_an_image') {
        return res.status(400).json({ error: 'not_an_image' });
      }
      return next(err);
    }
    if (!req.file) {
      return res.status(400).json({ error: 'avatar_required' });
    }

    try {
      await ensureAvatarsDir();

      const userId = req.session.userId;
      const fileName = `${userId}.webp`;
      const fullPath = path.join(AVATARS_DIR, fileName);
      const urlPath  = `/avatars/${fileName}`;

      // sharp: ресайз + жёсткий формат webp. Это же — валидация (не картинка → throw).
      await sharp(req.file.buffer)
        .rotate()                              // учесть EXIF orientation
        .resize(512, 512, { fit: 'cover', position: 'attention' })
        .webp({ quality: 85 })
        .toFile(fullPath);

      await pool.query(
        `UPDATE saas_meta.users SET avatar_path = $1 WHERE id = $2`,
        [urlPath, userId]
      );

      // Cache-buster: фронт может добавить ?v=timestamp, но nginx /avatars/ кеширует 1 день.
      // Чтобы пользователь сразу увидел новое фото — отдаём новый URL без query.
      res.json({ ok: true, avatarPath: urlPath });
    } catch (e) {
      // sharp кидает «Input buffer contains unsupported image format» если файл — не картинка.
      if (/unsupported image format|Input buffer/i.test(e.message || '')) {
        return res.status(400).json({ error: 'not_an_image' });
      }
      next(e);
    }
  });
});

// ──────────────────────────────────────────────────────────────────────
// DELETE /api/profile/avatar
// ──────────────────────────────────────────────────────────────────────
router.delete('/avatar', requireAuth, async (req, res, next) => {
  try {
    const userId = req.session.userId;
    const fullPath = path.join(AVATARS_DIR, `${userId}.webp`);

    await fs.unlink(fullPath).catch((e) => {
      // нет файла — ok, всё равно почистим БД
      if (e.code !== 'ENOENT') throw e;
    });

    await pool.query(
      `UPDATE saas_meta.users SET avatar_path = NULL WHERE id = $1`,
      [userId]
    );

    res.json({ ok: true });
  } catch (err) { next(err); }
});

module.exports = router;
