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

const crypto = require('node:crypto');

const { pool } = require('../lib/db.cjs');
const { requireAuth } = require('../lib/middleware.cjs');
const { planMeta, maxUsersForPlan, planHasDailySummary } = require('../lib/plans.cjs');
const { isValidEmail } = require('../lib/validation.cjs');
const { deactivateSubscription } = require('../lib/prodamus.cjs');
const tgClient = require('../lib/telegram.cjs');
const payments = require('../lib/payments.cjs');
const { withTx } = require('../lib/db.cjs');
const { seedDemo, clearDemo } = require('../lib/demo_seed.cjs');

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
    // Defense in depth (3 слоя):
    //   1) MIME-prefix `image/*` — отрезает .exe/.zip с правильным заголовком,
    //      но MIME клиент-контролируемый, не доверяем как единственному.
    //   2) Расширение в whitelist — отсекает файлы с .php/.html, маскирующимися
    //      под image/jpeg в MIME (если в будущем мы перестанем re-encode'ить).
    //   3) sharp().webp() ниже re-encode'ит файл в memory — это убивает
    //      embedded EXIF/SVG-script/поломанные изображения. Это финальная
    //      гарантия что в storage уйдёт валидный WebP, а не PNG-bomb.
    if (!file.mimetype || !file.mimetype.startsWith('image/')) {
      return cb(new Error('not_an_image'));
    }
    const ext = (file.originalname || '').toLowerCase().match(/\.[a-z0-9]+$/);
    const ALLOWED_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.heic', '.heif']);
    if (ext && !ALLOWED_EXT.has(ext[0])) {
      return cb(new Error('extension_not_allowed'));
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

function computeCanViewFinance(role, flag) {
  // master никогда не видит финансы (хардкод; toggle для master в админке скрыт);
  // owner всегда видит; manager — по флагу (default true для не-мигрированных БД).
  if (role === 'master') return false;
  if (role === 'owner') return true;
  return flag !== false;
}

/**
 * PG TIME → 'HH:MM' (или null). Драйвер pg отдаёт TIME без TZ как строку
 * 'HH:MM:SS' (а у нас иногда 'HH:MM:SS.ffffff'). Для UI и <input type="time">
 * нужен формат 'HH:MM' — отрезаем секунды и микросекунды.
 *
 * NULL → null (UI покажет «Не присылать», бот молчит для этой студии).
 */
function formatDailySummaryTime(value) {
  if (value == null) return null;
  const str = String(value);
  const m = str.match(/^(\d{2}):(\d{2})/);
  return m ? `${m[1]}:${m[2]}` : null;
}

/**
 * 'HH:MM' / 'H:MM' / 'HH:MM:SS' → 'HH:MM:SS' для записи в PG TIME.
 * Возвращает null, если строка невалидна — вызывающий бросит 400.
 */
function parseDailySummaryTime(raw) {
  if (typeof raw !== 'string') return null;
  const m = raw.trim().match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) return null;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return null;
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00`;
}

function shapeProfileResponse({ userRow, studioRow, currentUsers }) {
  const meta = planMeta(studioRow.plan);
  const maxUsers = maxUsersForPlan(studioRow.plan);

  // Приватные поля студии — это персональные данные владельца как ИП/юрлица:
  //   • реквизиты для документов (ИНН, ОГРН, адреса, телефон, email студии,
  //     текст гарантии) — должны быть видны только владельцу. Менеджер и
  //     мастер их не используют в UI: они не редактируют профиль студии и
  //     не работают с её юридическими данными. PDF-документы рендерятся на
  //     сервере и читают эти поля напрямую из БД, минуя API.
  //   • реферальный код и бонусный баланс — личный кабинет владельца, чужие
  //     сотрудники не должны видеть промокод и сумму бонусов.
  // До этой проверки бэк отдавал все эти поля любому авторизованному юзеру
  // студии — manager/master заходили в /profile и видели реквизиты владельца.
  const isOwner = userRow.role === 'owner';

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
      canViewFinance: computeCanViewFinance(userRow.role, userRow.can_view_finance),
      lastLoginAt: userRow.last_login_at || null,
      // Telegram-привязка: если tg_user_id NULL — кнопка «Подключить»,
      // иначе показываем username и кнопку «Отвязать».
      tgLinked: !!userRow.tg_user_id,
      tgUsername: userRow.tg_username || null,
      tgLinkedAt: userRow.tg_linked_at || null,
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
      // cancel_pending=true → пользователь нажал «Отменить подписку».
      // UI показывает badge «Подписка отменена, доступ до …» и кнопку «Восстановить».
      cancelPending: studioRow.cancel_pending === true,
      // Запрос на удаление по 152-ФЗ. NULL — нет запроса; ISO-строка —
      // юзер нажал «Удалить аккаунт», реальное удаление через 30 дней.
      // Видят все юзеры студии (manager / master), чтобы понимать, что
      // owner запросил снос.
      deletionRequestedAt: studioRow.deletion_requested_at || null,
      // Реквизиты для шапки PDF-документов. Видны ТОЛЬКО owner-у —
      // см. комментарий выше. Для не-owner отдаём null, как будто не заполнены.
      inn:           isOwner ? (studioRow.inn           || null) : null,
      ogrn:          isOwner ? (studioRow.ogrn          || null) : null,
      legalAddress:  isOwner ? (studioRow.legal_address || null) : null,
      actualAddress: isOwner ? (studioRow.actual_address || null) : null,
      contactPhone:  isOwner ? (studioRow.contact_phone || null) : null,
      contactEmail:  isOwner ? (studioRow.contact_email || null) : null,
      guaranteeText: isOwner ? (studioRow.guarantee_text || null) : null,
      // Время утренней Telegram-сводки (миграция 011). PG отдаёт TIME как
      // 'HH:MM:SS' — урезаем до 'HH:MM' для UI (чтобы <input type="time">
      // принял без переформатирования). NULL = «не присылать студии».
      // Это поле менять может только owner, но видеть могут все —
      // не секретное (общая настройка студии).
      dailySummaryTime:    formatDailySummaryTime(studioRow.daily_summary_time),
      dailySummaryTimeSet: studioRow.daily_summary_time_set === true,
      // Реферальная программа: личное владельца. Не-owner получает null/0.
      referralCode:   isOwner ? (studioRow.referral_code || null) : null,
      bonusBalanceKop: isOwner
        ? (typeof studioRow.bonus_balance_kop === 'number'
            ? studioRow.bonus_balance_kop
            : Number(studioRow.bonus_balance_kop || 0))
        : 0,
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
  // iOS Safari (особенно in-app браузер Telegram) иногда кэширует JSON-ответы
  // GET-эндпоинтов даже с cookie. Из-за этого после signup-через-TG юзер
  // открывал профиль и видел tgLinked=false — реально TG уже привязан в БД,
  // но Safari отдавал старый ответ. Принудительно запрещаем кэш.
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.setHeader('Pragma', 'no-cache');

  const { rows } = await pool.query(
    `SELECT
        u.id, u.email, u.role, u.name,
        u.first_name, u.last_name, u.phone, u.avatar_path,
        u.is_active, u.created_at, u.can_view_finance, u.last_login_at,
        u.tg_user_id, u.tg_username, u.tg_linked_at,
        s.id AS studio_id, s.display_name, s.plan,
        s.is_active AS studio_active, s.access_until,
        s.created_at AS studio_created_at,
        s.cancel_pending AS studio_cancel_pending,
        s.deletion_requested_at,
        s.inn, s.ogrn, s.legal_address, s.actual_address,
        s.contact_phone, s.contact_email, s.guarantee_text,
        s.daily_summary_time, s.daily_summary_time_set,
        s.referral_code, s.bonus_balance_kop,
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
    tg_user_id: row.tg_user_id, tg_username: row.tg_username, tg_linked_at: row.tg_linked_at,
  };
  const studioRow = {
    id: row.studio_id, display_name: row.display_name, plan: row.plan,
    is_active: row.studio_active, access_until: row.access_until,
    created_at: row.studio_created_at,
    cancel_pending: row.studio_cancel_pending,
    deletion_requested_at: row.deletion_requested_at,
    inn: row.inn, ogrn: row.ogrn,
    legal_address: row.legal_address, actual_address: row.actual_address,
    contact_phone: row.contact_phone, contact_email: row.contact_email,
    guarantee_text: row.guarantee_text,
    daily_summary_time: row.daily_summary_time,
    daily_summary_time_set: row.daily_summary_time_set,
    referral_code: row.referral_code,
    bonus_balance_kop: row.bonus_balance_kop,
  };

  res.json(shapeProfileResponse({
    userRow, studioRow, currentUsers: row.current_users,
  }));
});

// ──────────────────────────────────────────────────────────────────────
// PATCH /api/profile
// Body: { firstName?, lastName?, phone? }
// ──────────────────────────────────────────────────────────────────────
router.patch('/', requireAuth, async (req, res, next) => {
  try {
    // Master — read-only по своему профилю: данные мастера правит owner
    // через админ-панель. Без этой проверки UI на /profile у мастера показывал
    // форму, бэк молча принимал апдейт, но иногда падал на других гардах —
    // пользователь видел красную ошибку и не понимал, что именно не так.
    if (req.session && req.session.role === 'master') {
      return res.status(403).json({ error: 'master_cannot_edit' });
    }

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
    //
    // Логика fallback:
    //   1. firstName + ' ' + lastName (если хоть что-то непустое)
    //   2. иначе split_part(email, '@', 1) — email-prefix как читаемый
    //      идентификатор. UserMenu покажет первую букву prefix-а, а форма
    //      «Личные данные» останется пустой — это синхронно: пользователь
    //      сам очистил поля, шапка профиля показывает «Без имени» / email,
    //      а не залипшую старую фамилию.
    //
    // Раньше тут стоял `... , name)` (старое значение). Это создавало баг
    // десинка: пользователь стирал поля, но в шапке оставалось «Недведская».
    if ('first_name' in fields || 'last_name' in fields) {
      const fnSql = ('first_name' in fields)
        ? `$${keys.indexOf('first_name') + 1}`
        : 'first_name';
      const lnSql = ('last_name' in fields)
        ? `$${keys.indexOf('last_name') + 1}`
        : 'last_name';
      setClauses.push(
        `name = COALESCE(NULLIF(TRIM(COALESCE(${fnSql}, '') || ' ' || COALESCE(${lnSql}, '')), ''), split_part(email, '@', 1))`
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
// PATCH /api/profile/studio
// Body: { displayName?, inn?, ogrn?, legalAddress?, actualAddress?,
//         contactPhone?, contactEmail?, guaranteeText? }
//
// Только owner: реквизиты студии (для шапки PDF-документов).
// Каждое поле опционально, '' / null → стирает значение.
// Лимиты длин: ИНН/ОГРН ≤ 20 (цифры), email ≤ 100,
// адрес/гарантия ≤ 500, displayName ≤ 100, телефон ≤ 40.
// ──────────────────────────────────────────────────────────────────────
router.patch('/studio', requireAuth, async (req, res, next) => {
  try {
    // Проверяем, что owner — только он может править реквизиты студии.
    // Заодно тянем plan, чтобы гейтить фичи тарифа Студия (утренняя сводка).
    const u = await pool.query(
      `SELECT u.role, u.studio_id, s.plan
         FROM saas_meta.users u
         JOIN saas_meta.studios s ON s.id = u.studio_id
        WHERE u.id = $1`,
      [req.session.userId]
    );
    const userRow = u.rows[0];
    if (!userRow) return res.status(404).json({ error: 'user_not_found' });
    if (userRow.role !== 'owner') {
      return res.status(403).json({ error: 'only_owner_can_edit_studio' });
    }

    const body = req.body || {};
    const fields = {};

    function takeOptionalString(key, dbField, maxLen) {
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

    takeOptionalString('displayName',   'display_name',   100);
    takeOptionalString('inn',           'inn',            20);
    takeOptionalString('ogrn',          'ogrn',           20);
    takeOptionalString('legalAddress',  'legal_address',  500);
    takeOptionalString('actualAddress', 'actual_address', 500);
    takeOptionalString('contactPhone',  'contact_phone',  40);
    takeOptionalString('contactEmail',  'contact_email',  100);
    takeOptionalString('guaranteeText', 'guarantee_text', 500);

    // dailySummaryTime — особый случай: НЕ строка-как-другие, а время.
    //   • '' / null  → daily_summary_time = NULL ⇒ «не присылать сводку»
    //   • 'HH:MM'    → парсим в 'HH:MM:SS' для PG TIME
    //   • невалид    → 400, UI покажет ошибку
    // Когда owner явно меняет время через UI, ставим _set = TRUE,
    // чтобы бот при следующем входе не переспрашивал «во сколько?».
    if (Object.prototype.hasOwnProperty.call(body, 'dailySummaryTime')) {
      // Гейтинг по тарифу: фича доступна ТОЛЬКО на «Студия». На trial/solo
      // даже выставление в null (отключение сводки) бессмысленно — её
      // и так не шлют. UI секцию прячет, но защита нужна и здесь, иначе
      // обходимо через прямой запрос к API.
      if (!planHasDailySummary(userRow.plan)) {
        const e = new Error('daily_summary_requires_studio_plan');
        e.status = 403;
        throw e;
      }
      const raw = body.dailySummaryTime;
      if (raw === null || raw === '') {
        fields.daily_summary_time = null;
        fields.daily_summary_time_set = true;
      } else {
        const parsed = parseDailySummaryTime(raw);
        if (!parsed) {
          const e = new Error('daily_summary_time_invalid'); e.status = 400; throw e;
        }
        fields.daily_summary_time = parsed;
        fields.daily_summary_time_set = true;
      }
    }

    // Дополнительная валидация ИНН/ОГРН/email — только цифры и нужная длина.
    // Передний край (UI) валидирует то же самое, но клиент мог быть обойдён.
    if (fields.inn != null) {
      if (!/^\d+$/.test(fields.inn) || (fields.inn.length !== 10 && fields.inn.length !== 12)) {
        const e = new Error('inn_invalid'); e.status = 400; throw e;
      }
    }
    if (fields.ogrn != null) {
      if (!/^\d+$/.test(fields.ogrn) || (fields.ogrn.length !== 13 && fields.ogrn.length !== 15)) {
        const e = new Error('ogrn_invalid'); e.status = 400; throw e;
      }
    }
    if (fields.contact_email != null) {
      if (!isValidEmail(fields.contact_email)) {
        const e = new Error('contact_email_invalid'); e.status = 400; throw e;
      }
    }

    // displayName не может быть NULL (NOT NULL в схеме). Раньше пустую
    // строку молча игнорировали — это создавало баг «не могу очистить
    // название студии»: пользователь стирал поле, ничего не происходило,
    // оно возвращалось к старому значению. Теперь явно отдаём 400 — UI
    // покажет понятное сообщение, что поле нельзя оставить пустым.
    if ('display_name' in fields && fields.display_name === null) {
      const e = new Error('display_name_required'); e.status = 400; throw e;
    }

    const keys = Object.keys(fields);
    if (keys.length === 0) {
      return res.status(400).json({ error: 'no_fields_to_update' });
    }

    const setClauses = [];
    const values = [];
    let i = 1;
    for (const k of keys) {
      setClauses.push(`${k} = $${i++}`);
      values.push(fields[k]);
    }
    setClauses.push(`updated_at = now()`);
    values.push(userRow.studio_id);

    const r = await pool.query(
      `UPDATE saas_meta.studios
          SET ${setClauses.join(', ')}
        WHERE id = $${values.length}
        RETURNING id, display_name, inn, ogrn, legal_address, actual_address,
                  contact_phone, contact_email, guarantee_text,
                  daily_summary_time, daily_summary_time_set`,
      values
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'studio_not_found' });

    const s = r.rows[0];
    res.json({
      ok: true,
      studio: {
        id:            s.id,
        displayName:   s.display_name,
        inn:           s.inn           || null,
        ogrn:          s.ogrn          || null,
        legalAddress:  s.legal_address || null,
        actualAddress: s.actual_address || null,
        contactPhone:  s.contact_phone || null,
        contactEmail:  s.contact_email || null,
        guaranteeText: s.guarantee_text || null,
        dailySummaryTime:    formatDailySummaryTime(s.daily_summary_time),
        dailySummaryTimeSet: s.daily_summary_time_set === true,
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
  // Master не правит свой профиль — аватар тоже.
  if (req.session && req.session.role === 'master') {
    return res.status(403).json({ error: 'master_cannot_edit' });
  }
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
  if (req.session && req.session.role === 'master') {
    return res.status(403).json({ error: 'master_cannot_edit' });
  }
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
});

// ──────────────────────────────────────────────────────────────────────
// POST /api/profile/subscription/cancel
// Помечаем подписку как отменённую: автопродления НЕ будет, доступ
// сохраняется до access_until. Доступно только владельцу студии и только
// для платных тарифов (solo/studio) — на пробном отменять нечего.
//
// Двухслойная остановка списаний:
//   1) Сначала пытаемся дёрнуть Prodamus REST setActivity (active_manager=0)
//      — это реально отключает рекуррент на стороне платёжки.
//   2) Затем выставляем локальный cancel_pending=true. Этот флаг работает
//      и как контракт UI («отменена, доступ до …»), и как защита webhook-а:
//      если Prodamus всё равно пришлёт списание, оно уйдёт в bonus_balance,
//      а не продлит access_until.
//
// Шаг 1 tolerant к ошибкам — если PRODAMUS_API_BASE не задан или сеть упала,
// шаг 2 всё равно отрабатывает, и пользователь финансово защищён.
// ──────────────────────────────────────────────────────────────────────
router.post('/subscription/cancel', requireAuth, async (req, res, next) => {
  const userId = req.session.userId;

  // Проверяем, что пользователь — owner своей студии. Заодно достаём реквизиты
  // подписки Prodamus, чтобы вызвать setActivity и реально остановить рекуррент
  // на стороне платёжки (а не только локальный флаг).
  const u = await pool.query(
    `SELECT u.role, u.studio_id, s.plan, s.cancel_pending,
            s.prodamus_subscription_id,
            s.prodamus_subscription_phone,
            s.prodamus_subscription_email
       FROM saas_meta.users u
       JOIN saas_meta.studios s ON s.id = u.studio_id
      WHERE u.id = $1`,
    [userId]
  );
  const row = u.rows[0];
  if (!row) return res.status(404).json({ error: 'user_not_found' });
  if (row.role !== 'owner') {
    return res.status(403).json({ error: 'only_owner_can_cancel' });
  }
  if (row.plan !== 'solo' && row.plan !== 'studio') {
    // на trial/cancelled отменять нечего
    return res.status(400).json({ error: 'no_active_subscription' });
  }
  if (row.cancel_pending === true) {
    return res.json({ ok: true, alreadyCancelled: true });
  }

  // ── 1. Дёргаем Prodamus REST setActivity, чтобы остановить рекуррент.
  // Тоlerant к ошибкам: если API не сконфигурен / упал / таймаут — всё равно
  // ставим локальный флаг cancel_pending. Защита от «призрачных» списаний в
  // webhook'е (paid_after_cancel → бонусы) гарантирует, что деньги не пропадут
  // даже если рекуррент не успел отключиться на стороне Prodamus.
  let prodamusResult = null;
  try {
    prodamusResult = await deactivateSubscription({
      subscriptionId: row.prodamus_subscription_id,
      userPhone:      row.prodamus_subscription_phone,
    });
    if (!prodamusResult.ok) {
      console.warn('[profile] prodamus setActivity not applied:', {
        studioId: row.studio_id,
        skipped: prodamusResult.skipped,
        error:   prodamusResult.error,
        status:  prodamusResult.status,
      });
    }
  } catch (e) {
    // На всякий случай — deactivateSubscription сам не должен throw'ить, но
    // если что-то нештатное (например, fetch не задефинен на старой Node) —
    // не роняем cancel.
    console.error('[profile] prodamus setActivity threw:', e.message);
  }

  // ── 2. Локальный флаг — ставим всегда. Это контракт UI и подсказка webhook'у.
  await pool.query(
    `UPDATE saas_meta.studios SET cancel_pending = true WHERE id = $1`,
    [row.studio_id]
  );

  res.json({
    ok: true,
    // В прод-UI это поле не используется, но оно полезно для админ-диагностики
    // через DevTools, если пользователь жалуется «не отменилось на Prodamus».
    prodamus: prodamusResult ? {
      ok: prodamusResult.ok === true,
      skipped: prodamusResult.skipped || null,
    } : null,
  });
});

// ──────────────────────────────────────────────────────────────────────
// POST /api/profile/subscription/resume
// «Передумал отменять» — снимаем флаг. Бесплатно, доступно владельцу.
// ──────────────────────────────────────────────────────────────────────
router.post('/subscription/resume', requireAuth, async (req, res, next) => {
  const userId = req.session.userId;

  const u = await pool.query(
    `SELECT u.role, u.studio_id
       FROM saas_meta.users u
      WHERE u.id = $1`,
    [userId]
  );
  const row = u.rows[0];
  if (!row) return res.status(404).json({ error: 'user_not_found' });
  if (row.role !== 'owner') {
    return res.status(403).json({ error: 'only_owner_can_resume' });
  }

  await pool.query(
    `UPDATE saas_meta.studios SET cancel_pending = false WHERE id = $1`,
    [row.studio_id]
  );
  res.json({ ok: true });
});

// ──────────────────────────────────────────────────────────────────────
// POST /api/profile/account/request-deletion
// Запрос на удаление аккаунта по 152-ФЗ. Выставляем deletion_requested_at
// на текущей студии. Реальное удаление — через 30 дней (см. cron в
// server/sql/013_studio_retention.sql / studio retention job). До этого
// юзер может отменить, нажав кнопку повторно (toggle).
//
// Owner-only — manager / master не могут удалять чужой бизнес.
// При отмене — поле обнуляется, доступ остаётся.
// ──────────────────────────────────────────────────────────────────────
router.post('/account/request-deletion', requireAuth, async (req, res, next) => {
  try {
    const u = await pool.query(
      `SELECT u.role, u.studio_id, s.deletion_requested_at
         FROM saas_meta.users u
         JOIN saas_meta.studios s ON s.id = u.studio_id
        WHERE u.id = $1`,
      [req.session.userId]
    );
    const row = u.rows[0];
    if (!row) return res.status(404).json({ error: 'user_not_found' });
    if (row.role !== 'owner') {
      return res.status(403).json({ error: 'only_owner_can_delete_account' });
    }

    // Toggle: если уже запрошено — отменяем; если нет — выставляем now().
    const cancel = req.body?.cancel === true;
    const newValue = (cancel || row.deletion_requested_at) ? null : new Date();

    await pool.query(
      `UPDATE saas_meta.studios SET deletion_requested_at = $1 WHERE id = $2`,
      [newValue, row.studio_id]
    );

    res.json({
      ok: true,
      deletionRequestedAt: newValue ? newValue.toISOString() : null,
      // 30 дней — окно отмены, согласовано с разделом 10 оферты
      // и cron studio_retention. До этой даты юзер может передумать.
      deletionEffectiveAt: newValue
        ? new Date(newValue.getTime() + 30 * 24 * 3600 * 1000).toISOString()
        : null,
    });
  } catch (err) {
    next(err);
  }
});

// ──────────────────────────────────────────────────────────────────────
// POST /api/profile/demo/seed
// Заливает в студию 2 демо-клиента с полным циклом (карточка → авто →
// записи → задачи → транзакции). Owner-only. Идемпотентно: повторный
// вызов сначала чистит старый demo по is_demo=TRUE, потом сидит заново.
// При регистрации новой студии этот же seedDemo вызывается автоматически
// (см. tenant_provisioning.cjs).
// ──────────────────────────────────────────────────────────────────────
router.post('/demo/seed', requireAuth, async (req, res, next) => {
  try {
    const u = await pool.query(
      `SELECT u.role, u.id AS user_id, s.schema_name
         FROM saas_meta.users u
         JOIN saas_meta.studios s ON s.id = u.studio_id
        WHERE u.id = $1`,
      [req.session.userId]
    );
    const row = u.rows[0];
    if (!row) return res.status(404).json({ error: 'user_not_found' });
    if (row.role !== 'owner') {
      return res.status(403).json({ error: 'only_owner_can_seed_demo' });
    }
    const stats = await withTx((client) => seedDemo(client, row.schema_name, row.user_id));
    res.json({ ok: true, ...stats });
  } catch (err) {
    next(err);
  }
});

// ──────────────────────────────────────────────────────────────────────
// POST /api/profile/demo/clear
// Удаляет всё с is_demo=TRUE. Owner-only. Безопасно — не трогает
// реальные карточки клиентов, которые юзер уже создал сам.
// ──────────────────────────────────────────────────────────────────────
router.post('/demo/clear', requireAuth, async (req, res, next) => {
  try {
    const u = await pool.query(
      `SELECT u.role, s.schema_name
         FROM saas_meta.users u
         JOIN saas_meta.studios s ON s.id = u.studio_id
        WHERE u.id = $1`,
      [req.session.userId]
    );
    const row = u.rows[0];
    if (!row) return res.status(404).json({ error: 'user_not_found' });
    if (row.role !== 'owner') {
      return res.status(403).json({ error: 'only_owner_can_clear_demo' });
    }
    const result = await withTx((client) => clearDemo(client, row.schema_name));
    res.json({ ok: true, ...result });
  } catch (err) {
    next(err);
  }
});

// ──────────────────────────────────────────────────────────────────────
// POST /api/profile/payment/intent
//
// Body: { plan: 'solo_month' | 'solo_year' | 'studio_month' | 'studio_year' }
//
// Зачем: выпускаем серверно-подписанный токен, привязанный к authenticated
// студии, чтобы фронт подсунул его в URL Prodamus как `_param_intent`.
// Webhook возьмёт studio_id ИЗ ИНТЕНТА (доверенный источник из сессии),
// игнорируя `_param_studio_id` из payload.
//
// Зачем не делать это на фронте через подпись JWT: JWT_SECRET был бы доступен
// только бэку → фронт всё равно ходил бы за токеном. Проще сразу хранить
// intent в БД с TTL — заодно одноразовость через `consumed_at`.
//
// Что отдаём:
//   { token, expiresAt, expectedAmountKop, bonusKopAvailable }
// Фронт сам конструирует payform-URL — мы только даём токен и подсказку
// «сколько бонусов можно списать», чтобы UI показал правильную итоговую сумму.
//
// SECURITY:
//   • token — 32 байта randomBytes (256 бит). Угадать нереально.
//   • Привязан к req.session.studioId — нельзя выпустить на чужую студию.
//   • TTL 60 минут — пользователь должен успеть оплатить.
//   • Возможна race: юзер кликает «Оплатить», но не доходит до Prodamus →
//     intent протухает через час, cron подчистит.
// ──────────────────────────────────────────────────────────────────────
router.post('/payment/intent', requireAuth, async (req, res, next) => {
  try {
    const planId = String(req.body?.plan || '').trim();
    let result;
    try {
      result = await payments.createPaymentIntent({
        studioId:  req.session.studioId,
        userId:    req.session.userId,
        planId,
        ip:        req.ip || null,
        userAgent: req.headers['user-agent'] || null,
      });
    } catch (e) {
      if (e.code === 'plan_invalid')      return res.status(400).json({ error: 'plan_invalid' });
      if (e.code === 'studio_not_found')  return res.status(404).json({ error: 'studio_not_found' });
      throw e;
    }

    res.json({
      token:             result.token,
      expiresAt:         result.expiresAt.toISOString(),
      expectedAmountKop: result.expectedKop,
      bonusKopApplied:   result.bonusKop,
      // finalAmountRub — сколько фронт должен подставить в `customer_price`.
      // Округляем вверх до целого рубля (Prodamus принимает целые ₽).
      finalAmountRub: Math.ceil(result.finalAmountKop / 100),
    });
  } catch (err) {
    next(err);
  }
});

// ──────────────────────────────────────────────────────────────────────
// GET /api/profile/payment/from-tg
//
// Однокликовый переход из Telegram-бота на оплату Prodamus. Bot строит
// inline-кнопки с подписанной HMAC-ссылкой; этот эндпоинт:
//   1. Верифицирует HMAC (исключает подделку URL'а атакующим).
//   2. По tg_user_id находит привязанного owner-а и его studio_id —
//      это и есть «доверенный» источник studio_id, эквивалент session
//      в SPA-флоу POST /payment/intent.
//   3. Создаёт payment_intent (тот же helper, что использует SPA).
//   4. Делает 302 redirect на payform.ru с готовым URL.
//
// SECURITY:
//   • HMAC-secret — PRODAMUS_SECRET_KEY (уже есть в env, semantic match).
//   • exp в URL — 7 дней; после — кнопка перестаёт работать (404), пусть
//     юзер заново откроет /tariffs в боте.
//   • Если найденный пользователь не owner — 403; платить может только он.
//   • Никаких body-параметров: всё в URL и подписано → CSRF-устойчиво.
// ──────────────────────────────────────────────────────────────────────
function timingSafeEqualStr(a, b) {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

router.get('/payment/from-tg', async (req, res, next) => {
  try {
    const plan  = String(req.query.plan || '').trim();
    const tgRaw = String(req.query.u    || '').trim();
    const expS  = String(req.query.exp  || '').trim();
    const sig   = String(req.query.sig  || '').trim();

    if (!payments.VALID_PLAN_IDS.includes(plan) || !tgRaw || !expS || !sig) {
      return res.status(400).type('text/html; charset=utf-8').send(
        '<h1>Ссылка не валидна</h1><p>Откройте «Тарифы» в боте ещё раз.</p>'
      );
    }

    const exp = Number(expS);
    if (!Number.isFinite(exp) || exp * 1000 < Date.now()) {
      return res.status(410).type('text/html; charset=utf-8').send(
        '<h1>Ссылка устарела</h1><p>Откройте «Тарифы» в боте ещё раз — сделаем свежую.</p>'
      );
    }

    const secret = process.env.PRODAMUS_SECRET_KEY || '';
    if (!secret) {
      console.error('[profile] from-tg: PRODAMUS_SECRET_KEY missing — refusing');
      return res.status(500).type('text/html; charset=utf-8').send(
        '<h1>Ошибка конфигурации</h1><p>Свяжитесь с поддержкой.</p>'
      );
    }
    const expectedSig = crypto
      .createHmac('sha256', secret)
      .update(`tgpay:${tgRaw}:${plan}:${exp}`)
      .digest('hex');
    if (!timingSafeEqualStr(sig, expectedSig)) {
      return res.status(401).type('text/html; charset=utf-8').send(
        '<h1>Подпись ссылки невалидна</h1><p>Откройте «Тарифы» в боте ещё раз.</p>'
      );
    }

    const tgUserId = Number(tgRaw);
    if (!Number.isFinite(tgUserId)) {
      return res.status(400).type('text/html; charset=utf-8').send(
        '<h1>Ссылка не валидна</h1>'
      );
    }

    const ur = await pool.query(
      `SELECT u.id, u.email, u.role, u.studio_id
         FROM saas_meta.users u
        WHERE u.tg_user_id = $1`,
      [tgUserId]
    );
    const user = ur.rows[0];
    if (!user) {
      return res.status(404).type('text/html; charset=utf-8').send(
        '<h1>Аккаунт не найден</h1><p>Telegram не привязан к СРМ. Привяжите аккаунт в Профиле и попробуйте снова.</p>'
      );
    }
    if (user.role !== 'owner') {
      return res.status(403).type('text/html; charset=utf-8').send(
        '<h1>Менять тариф может только владелец студии</h1>'
      );
    }

    const intent = await payments.createPaymentIntent({
      studioId:  user.studio_id,
      userId:    user.id,
      planId:    plan,
      ip:        req.ip || null,
      userAgent: req.headers['user-agent'] || null,
    });

    const url = payments.buildPayformUrl({
      planId:        plan,
      intentToken:   intent.token,
      bonusKop:      intent.bonusKop,
      finalAmountKop: intent.finalAmountKop,
      customerEmail: user.email,
    });

    return res.redirect(302, url);
  } catch (err) {
    next(err);
  }
});

// ──────────────────────────────────────────────────────────────────────
// GET /api/profile/referral
// Только для owner. Возвращает код, ссылку, текущий баланс бонусов и статистику:
//   • referralsCount — сколько студий привёл (всех, не только оплативших)
//   • paidReferralsCount — сколько из них оплатило хоть что-то
//   • totalEarnedKop — сумма всех когда-либо начисленных credit-событий
//   • totalSpentKop  — сумма всех debit-событий (применённых при оплате)
//   • events[] — последние N операций для журнала: что и когда
//   • referrals[] — список приведённых студий: имя, дата регистрации, заплатили ли
// ──────────────────────────────────────────────────────────────────────
router.get('/referral', requireAuth, async (req, res, next) => {
  try {
    if (req.session.role !== 'owner') {
      return res.status(403).json({ error: 'only_owner' });
    }
    const studioId = req.session.studioId;

    // Один JOIN-запрос с подзапросами — экономнее, чем 4 отдельных round-trip
    // в N+1 стиле. statistics-агрегаты считаются на стороне БД.
    const summary = await pool.query(
      `SELECT
          s.referral_code,
          s.bonus_balance_kop,
          (SELECT count(*)::int FROM saas_meta.studios c
            WHERE c.referred_by = s.id) AS referrals_count,
          (SELECT count(DISTINCT c.id)::int FROM saas_meta.studios c
             JOIN saas_meta.payments p ON p.studio_id = c.id AND p.status = 'paid'
            WHERE c.referred_by = s.id) AS paid_referrals_count,
          (SELECT COALESCE(sum(amount_kop), 0)::int FROM saas_meta.referral_events
            WHERE studio_id = s.id AND kind = 'credit') AS total_earned_kop,
          (SELECT COALESCE(sum(amount_kop), 0)::int FROM saas_meta.referral_events
            WHERE studio_id = s.id AND kind = 'debit') AS total_spent_kop
         FROM saas_meta.studios s
        WHERE s.id = $1`,
      [studioId]
    );
    const row = summary.rows[0];
    if (!row) return res.status(404).json({ error: 'studio_not_found' });

    // Список приведённых студий (последние 50). display_name + дата регистрации
    // + признак оплаты. Без раскрытия чужого email — только публичное имя.
    const referrals = await pool.query(
      `SELECT c.id, c.display_name, c.created_at,
              EXISTS(SELECT 1 FROM saas_meta.payments p
                      WHERE p.studio_id = c.id AND p.status = 'paid') AS has_paid
         FROM saas_meta.studios c
        WHERE c.referred_by = $1
        ORDER BY c.created_at DESC
        LIMIT 50`,
      [studioId]
    );

    // Журнал операций: последние 50 для UI.
    const events = await pool.query(
      `SELECT id, kind, amount_kop, source_studio_id, payment_order_id, created_at
         FROM saas_meta.referral_events
        WHERE studio_id = $1
        ORDER BY created_at DESC, id DESC
        LIMIT 50`,
      [studioId]
    );

    res.json({
      referralCode: row.referral_code,
      bonusBalanceKop: row.bonus_balance_kop || 0,
      referralsCount: row.referrals_count || 0,
      paidReferralsCount: row.paid_referrals_count || 0,
      totalEarnedKop: row.total_earned_kop || 0,
      totalSpentKop: row.total_spent_kop || 0,
      // Сумма за приведённого клиента — пока константа в коде. Если когда-то
      // захотим A/B или повышенный бонус для отдельных студий — переедет в БД.
      bonusPerReferralKop: 125000,
      referrals: referrals.rows.map(r => ({
        id: r.id,
        displayName: r.display_name,
        createdAt: r.created_at,
        hasPaid: r.has_paid === true,
      })),
      events: events.rows.map(e => ({
        id: e.id,
        kind: e.kind,
        amountKop: e.amount_kop,
        sourceStudioId: e.source_studio_id,
        paymentOrderId: e.payment_order_id,
        createdAt: e.created_at,
      })),
    });
  } catch (err) {
    next(err);
  }
});

// ──────────────────────────────────────────────────────────────────────
// POST /api/profile/telegram/link
//
// Возвращает одноразовую ссылку на бота:
//   { url: 'https://t.me/<username>?start=link_<token>' }
// Токен живёт 24 часа, сжигается при /start от бота.
//
// Если у пользователя уже привязан TG — UI должен сначала вызывать
// DELETE telegram → потом link. Этот роут сам не отвязывает, чтобы
// случайный клик «Подключить» не сбрасывал текущую привязку.
// ──────────────────────────────────────────────────────────────────────
router.post('/telegram/link', requireAuth, async (req, res, next) => {
  try {
    const username = tgClient.botUsername();
    if (!username) {
      return res.status(503).json({ error: 'telegram_not_configured' });
    }

    // Гейтинг по согласию на трансграничную передачу (ч. 4 ст. 12 ФЗ-152).
    // Привязка Telegram = передача данных юзера на серверы Telegram Messenger
    // Inc. за пределами РФ. Без отдельного информированного согласия —
    // незаконно. Фронт ставит чекбокс перед кнопкой; этот гейт защищает
    // от прямого вызова API в обход UI.
    if (req.body?.crossBorderConsent !== true) {
      return res.status(400).json({ error: 'cross_border_consent_required' });
    }

    // Проверяем, не привязан ли уже. Если да — возвращаем «уже привязан»
    // с username, фронт просто перерисует блок.
    const u = await pool.query(
      `SELECT tg_user_id, tg_username, email FROM saas_meta.users WHERE id = $1`,
      [req.session.userId]
    );
    const cur = u.rows[0];
    if (!cur) return res.status(404).json({ error: 'user_not_found' });
    if (cur.tg_user_id) {
      return res.status(409).json({
        error: 'already_linked',
        tgUsername: cur.tg_username || null,
      });
    }

    // Записываем согласие на трансграничную передачу. Отдельная строка
    // в consents — единственное доказательство при проверке РКН.
    // policy_url = адрес Согласия на момент клика (там раздел 6 про
    // трансграничную передачу).
    await pool.query(
      `INSERT INTO saas_meta.consents
         (user_id, email, consent_type, policy_version, policy_url, ip, user_agent)
       VALUES ($1, $2, 'telegram_cross_border', '28.04.2026',
               '/legal/personal-data-consent', $3, $4)`,
      [
        req.session.userId,
        cur.email,
        req.ip || null,
        req.headers['user-agent'] || null,
      ]
    );

    // Старые незаюзанные токены чистим — у одного user не должно быть
    // нескольких живых deep-link'ов одновременно.
    await pool.query(
      `DELETE FROM saas_meta.tg_link_tokens
        WHERE user_id = $1 AND consumed_at IS NULL`,
      [req.session.userId]
    );

    // 32 байта random → base64url. URL-safe, без padding.
    const token = crypto.randomBytes(32).toString('base64url');
    await pool.query(
      `INSERT INTO saas_meta.tg_link_tokens (token, user_id, expires_at)
       VALUES ($1, $2, now() + interval '24 hours')`,
      [token, req.session.userId]
    );

    res.json({
      url: `https://t.me/${username}?start=link_${token}`,
      botUsername: username,
      expiresInHours: 24,
    });
  } catch (err) {
    next(err);
  }
});

// ──────────────────────────────────────────────────────────────────────
// DELETE /api/profile/telegram
// Отвязать TG. Уведомляем бота — пишем в чат «Telegram отвязан»,
// чтобы пользователь видел действие в самом боте, а не только в CRM.
// ──────────────────────────────────────────────────────────────────────
router.delete('/telegram', requireAuth, async (req, res, next) => {
  try {
    const u = await pool.query(
      `SELECT tg_chat_id FROM saas_meta.users WHERE id = $1`,
      [req.session.userId]
    );
    const chatId = u.rows[0]?.tg_chat_id || null;

    await pool.query(
      `UPDATE saas_meta.users
          SET tg_user_id   = NULL,
              tg_username  = NULL,
              tg_chat_id   = NULL,
              tg_linked_at = NULL
        WHERE id = $1`,
      [req.session.userId]
    );

    // Уведомление в TG — best-effort. Если бот не настроен или TG лёг —
    // отвязка в CRM всё равно прошла.
    if (chatId) {
      tgClient.sendMessage({
        chatId, userId: req.session.userId, kind: 'unlink_via_crm',
        text:
          'Отвязка прошла успешно (прямо из профиля СРМ).\n' +
          'Сюда больше не будут приходить уведомления.\n\n' +
          'Если захочешь вернуть коннект — ты знаешь, где меня искать: Профиль → Telegram → «Подключить».',
      }).catch(() => {});
    }

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
