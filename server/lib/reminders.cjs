'use strict';
/**
 * Telegram-напоминания.
 *
 * Виды:
 *   1. daily_summary — раз в сутки, 9:00 по локальному времени студии.
 *      • master  → видит только свои записи
 *      • owner / manager → видит ВСЕ записи студии
 *      Если у master нет записей — не шлём (не дёргаем понапрасну);
 *      owner-у со «нулевым» днём шлём короткое «выдохни».
 *      Идемпотентно: партиальный UNIQUE (user_id, ref_date) WHERE kind='daily_summary'.
 *
 *   2. hour_before — за 55-65 минут до записи.
 *      • есть master_id → только мастеру
 *      • master_id NULL → owner + все managers
 *      Идемпотентно: партиальный UNIQUE (user, studio, booking, date, time)
 *      WHERE kind='hour_before'. Перенос времени → новый ключ → новое
 *      напоминание; повторно за то же время — нет.
 *
 * Тикает раз в 5 минут (см. cron.cjs). Окно daily 9:00-9:09 (10 мин) и
 * hour_before 55-65 мин (11 мин) гарантированно покрывают любой тик
 * 5-минутной сетки.
 *
 * Поля bookings.date / bookings.time — naive (DATE / TIME без TZ). Они
 * интерпретируются в часовом поясе студии (studios.timezone).
 */

const { pool, queryInSchema } = require('./db.cjs');
const tg = require('./telegram.cjs');
const { applyGender } = require('./gender.cjs');

// ──────────────────────────────────────────────────────────────────────
// Утилиты времени.
// ──────────────────────────────────────────────────────────────────────

// Возвращает {dateStr 'YYYY-MM-DD', hh, mm} «сейчас» в указанной IANA-таймзоне.
function localTimeParts(date, tz) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const parts = {};
  for (const p of fmt.formatToParts(date)) {
    if (p.type !== 'literal') parts[p.type] = p.value;
  }
  return {
    dateStr: `${parts.year}-${parts.month}-${parts.day}`,
    hh: Number(parts.hour),
    mm: Number(parts.minute),
  };
}

function timeToMinutes(t) {
  const [h, m] = String(t).split(':').map(Number);
  return h * 60 + m;
}

function formatTime(t) {
  return String(t).slice(0, 5); // 'HH:MM:SS' → 'HH:MM'
}

// Русская плюрализация числовых форм.
function pluralize(n, one, few, many) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return few;
  return many;
}

// ──────────────────────────────────────────────────────────────────────
// БД-доступ.
// ──────────────────────────────────────────────────────────────────────

async function getActiveStudios() {
  // Шлём всем активным студиям, включая trial и solo. На лендинге Студия
  // выделена как «у них напоминания» — это маркетинг для апсейла, но
  // фактически бот напоминает всем, у кого подключён TG. Оплачен ли
  // тариф — отдельный вопрос; «бесплатной» функцию делает не cron,
  // а наличие tg_chat_id у пользователя.
  const r = await pool.query(
    `SELECT id, schema_name, timezone
       FROM saas_meta.studios
      WHERE schema_name IS NOT NULL
        AND is_active = TRUE
        AND plan <> 'cancelled'`
  );
  return r.rows;
}

async function getStudioUsers(studioId) {
  const r = await pool.query(
    `SELECT id, name, role, gender, tg_chat_id
       FROM saas_meta.users
      WHERE studio_id = $1
        AND tg_chat_id IS NOT NULL
        AND is_active = TRUE`,
    [studioId]
  );
  return r.rows;
}

async function getBookingsForDate(schema, dateStr) {
  // ВАЖНО: фактически бронями владеет таблица client_records, а не bookings.
  // bookings — наследие из исходного порта, в боевом потоке (UI «Бронь»
  // в карточке клиента / календарь) ничего туда не пишется. Если читать
  // bookings — выборка всегда пустая, и за-час-напоминания никогда не
  // улетают (это уже всплывало в фидбеке: «бот не прислал напоминание
  // за час о записи клиента»).
  //
  // Колонки сохранены под старые имена (b.master_id, b.date, b.time,
  // b.notes, b.client_name, …) — formatBookingLine и остальная логика
  // ничего об источнике не знают. is_completed=false аналог
  // status<>'cancelled': снятые/завершённые брони не спамят.
  const r = await queryInSchema(schema,
    `SELECT cr.id,
            cr.master_id,
            cr.date,
            cr.time,
            cr.service_name,
            cr.description AS notes,
            c.name  AS client_name,
            c.phone AS client_phone,
            v.brand AS vehicle_brand,
            v.model AS vehicle_model,
            v.license_plate AS vehicle_plate
       FROM {{schema}}.client_records cr
       LEFT JOIN {{schema}}.clients  c ON c.id = cr.client_id
       LEFT JOIN {{schema}}.vehicles v ON v.id = cr.vehicle_id
      WHERE cr.date = $1
        AND cr.is_completed = false
      ORDER BY cr.time ASC`,
    [dateStr]
  );
  return r.rows;
}

// ON CONFLICT DO NOTHING + RETURNING — атомарный «забронировал отправку».
// Если строка уже была (rowCount=0), значит этот reminder уже отправлен — не шлём.
async function claimDaily(userId, dateStr) {
  const r = await pool.query(
    `INSERT INTO saas_meta.tg_sent_reminders (user_id, kind, ref_date)
     VALUES ($1, 'daily_summary', $2)
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [userId, dateStr]
  );
  return r.rowCount > 0;
}

async function claimHourBefore(userId, studioId, bookingId, dateStr, timeStr) {
  const r = await pool.query(
    `INSERT INTO saas_meta.tg_sent_reminders
       (user_id, kind, ref_studio_id, ref_booking_id, ref_date, ref_time)
     VALUES ($1, 'hour_before', $2, $3, $4, $5)
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [userId, studioId, bookingId, dateStr, timeStr]
  );
  return r.rowCount > 0;
}

// ──────────────────────────────────────────────────────────────────────
// Форматирование сообщений.
// ──────────────────────────────────────────────────────────────────────

function formatBookingLine(b) {
  const time = formatTime(b.time);
  const car  = [b.vehicle_brand, b.vehicle_model].filter(Boolean).join(' ');
  const carPart  = car ? `, ${tg.escapeHtml(car)}` : '';
  const platePart= b.vehicle_plate ? ` (${tg.escapeHtml(b.vehicle_plate)})` : '';
  const client   = b.client_name ? tg.escapeHtml(b.client_name) : 'без клиента';
  // Телефон — отдельной строкой ниже, чтобы Telegram автоматически распарсил
  // как ссылку tel: и сделал тапом-звонком (на одной строке с другим текстом
  // он тоже распознаётся, но кликабельная зона у́же). Если телефона нет
  // (старый клиент, миграция без phone) — строку не добавляем.
  const phoneLine = b.client_phone ? `\n📞 ${tg.escapeHtml(b.client_phone)}` : '';
  // Услуга идёт через тот же разделитель «·», что и между временем и клиентом —
  // визуально единообразно, не нарушает правило «тире только по правилам
  // русского языка» (тире здесь было бы стилистическим разделителем).
  const service  = b.service_name ? ` · ${tg.escapeHtml(b.service_name)}` : '';
  return `<b>${time}</b> · ${client}${carPart}${platePart}${service}${phoneLine}`;
}

// ──────────────────────────────────────────────────────────────────────
// Отправители — каждый с claim'ом, чтобы не дублировать.
// ──────────────────────────────────────────────────────────────────────

async function sendDailySummary(user, dateStr, bookings, isMasterOwn) {
  // Сначала «забронировали» — потом шлём. Если БД уже видела отправку,
  // вторая попытка из соседнего тика просто получит false и тихо выйдет.
  if (!(await claimDaily(user.id, dateStr))) return;

  const greetName = user.name ? tg.escapeHtml(user.name) : '';
  const greetWith = greetName ? `, ${greetName}` : '';

  let text;
  if (!bookings.length) {
    if (user.role === 'master') {
      // Master без записей — не дёргаем (нет смысла).
      // Но claim уже сделан — это ок, дубля точно не будет, а пустой шум не уйдёт.
      return;
    }
    text = applyGender(
      `☀️ Доброе утро${greetWith}\n\n` +
      `Сегодня записей в студии нет, можно выдохнуть и закрыть накопленные дела.`,
      user.gender
    );
  } else {
    const n = bookings.length;
    const word = pluralize(n, 'запись', 'записи', 'записей');
    const lines = bookings.map(formatBookingLine).join('\n');
    const intro = isMasterOwn
      ? `☀️ Доброе утро${greetWith}\nСегодня у тебя ${n} ${word}:`
      : `☀️ Доброе утро${greetWith}\nСегодня в студии ${n} ${word}:`;
    text = `${intro}\n\n${lines}\n\nХорошего дня 🔥`;
  }

  await tg.sendMessage({
    chatId: user.tg_chat_id, userId: user.id, kind: 'daily_summary',
    text,
  });
}

async function sendHourBefore(user, booking, studioId, dateStr) {
  const timeStr = formatTime(booking.time);
  if (!(await claimHourBefore(user.id, studioId, booking.id, dateStr, timeStr))) return;

  const text =
    `⏰ Через час запись\n\n` +
    formatBookingLine(booking) +
    (booking.notes ? `\n\n<i>${tg.escapeHtml(booking.notes)}</i>` : '');

  await tg.sendMessage({
    chatId: user.tg_chat_id, userId: user.id, kind: 'hour_before',
    text,
  });
}

// ──────────────────────────────────────────────────────────────────────
// Основная логика — обработка одной студии.
// ──────────────────────────────────────────────────────────────────────

async function processStudio(studio, now) {
  const tz = studio.timezone || 'Europe/Moscow';
  let local;
  try {
    local = localTimeParts(now, tz);
  } catch (e) {
    console.error(`[reminders] invalid timezone for studio ${studio.id}: ${tz}`);
    return;
  }

  const inDailyWindow = local.hh === 9 && local.mm < 10;
  const nowMin = local.hh * 60 + local.mm;

  // Если ни одно окно не активно — даже не дёргаем БД.
  // Hour-before требует выборки по дате; пропустить можно, если нет записей в
  // ±2 часа, но всё равно дешевле выбрать один SELECT.
  if (!inDailyWindow) {
    // быстрый skip нулевой нагрузки: ночью никого не дёргаем.
    // (всё равно проверяем hour_before — там фильтр по delta).
  }

  const users = await getStudioUsers(studio.id);
  if (!users.length) return;

  const masterMap = new Map(
    users.filter((u) => u.role === 'master').map((u) => [u.id, u])
  );
  const ownersAndMgrs = users.filter((u) => u.role === 'owner' || u.role === 'manager');

  let bookings;
  try {
    bookings = await getBookingsForDate(studio.schema_name, local.dateStr);
  } catch (e) {
    console.error(`[reminders] getBookings failed for ${studio.schema_name}:`, e.message);
    return;
  }

  // ── 1) Daily summary 9:00-9:09 локального ────────────────────────
  if (inDailyWindow) {
    for (const u of users) {
      const userBookings = (u.role === 'master')
        ? bookings.filter((b) => b.master_id === u.id)
        : bookings; // owner / manager — все
      try {
        await sendDailySummary(u, local.dateStr, userBookings, u.role === 'master');
      } catch (e) {
        console.error(`[reminders] daily failed for user ${u.id}:`, e.message);
      }
    }
  }

  // ── 2) Hour-before — Δ 55-65 мин ─────────────────────────────────
  for (const b of bookings) {
    const delta = timeToMinutes(b.time) - nowMin;
    if (delta < 55 || delta > 65) continue;

    let recipients;
    if (b.master_id) {
      const m = masterMap.get(b.master_id);
      recipients = m ? [m] : []; // master без TG — никому не шлём (не наше дело)
    } else {
      recipients = ownersAndMgrs;
    }

    for (const u of recipients) {
      try {
        await sendHourBefore(u, b, studio.id, local.dateStr);
      } catch (e) {
        console.error(`[reminders] hour_before failed for user ${u.id}:`, e.message);
      }
    }
  }
}

// ──────────────────────────────────────────────────────────────────────
// Публичная точка — runOnce(): прогон по всем активным студиям.
// Тестирование вручную:
//   node -e "require('./server/lib/reminders.cjs').runOnce().then(console.log)"
// ──────────────────────────────────────────────────────────────────────
async function runOnce() {
  if (!tg.isConfigured()) return { ok: false, skipped: 'no_token' };

  const startedAt = Date.now();
  const now = new Date();
  const studios = await getActiveStudios();

  for (const s of studios) {
    try {
      await processStudio(s, now);
    } catch (e) {
      console.error(`[reminders] studio ${s.id} failed:`, e.message);
    }
  }

  const ms = Date.now() - startedAt;
  console.log(`[reminders] runOnce: ${studios.length} studios in ${ms}ms`);
  return { ok: true, studios: studios.length, ms };
}

module.exports = {
  runOnce,
  // экспорты для тестов
  localTimeParts,
  pluralize,
  timeToMinutes,
  formatBookingLine,
};
