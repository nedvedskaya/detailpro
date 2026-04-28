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
const { planHasDailySummary } = require('./plans.cjs');

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

// Проверяет, попадает ли «локальное сейчас» в 10-минутное окно от
// studio.daily_summary_time (TIME 'HH:MM:SS' или null).
//   • null      → сводка отключена явно, окно никогда не активно
//   • '09:00'   → окно 09:00..09:09 (включительно нижнюю границу)
// 10 минут — потому что cron-тик 5 мин: гарантированно попадаем
// хотя бы одним тиком, идемпотентность (ON CONFLICT) защищает от дублей.
function isInDailyWindow(local, dailyTimeStr) {
  if (!dailyTimeStr) return false;
  const target = timeToMinutes(dailyTimeStr);
  const now = local.hh * 60 + local.mm;
  return now >= target && now < target + 10;
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
  // Шлём всем активным студиям, включая trial и solo: hour-before работает
  // на любом тарифе (это базовый функционал). А вот daily_summary —
  // фича только тарифа Студия; гейтинг по plan живёт в processStudio
  // ниже, чтобы выборка студий не дублировалась.
  //
  // daily_summary_time может быть NULL — тогда сводка по этой студии
  // отключена явно (owner выбрал «Не присылать»). hour-before остаётся.
  const r = await pool.query(
    `SELECT id, schema_name, timezone, plan, daily_summary_time
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

// Активные задачи на сегодня + просроченные (только pending/in_progress).
//   • urgent сверху, потом high, medium, low (DESC по приоритету)
//   • внутри приоритета — по due_time NULLS LAST, затем по id
//
// assigned_to IS NULL означает «общая задача студии» — попадает к owner/manager,
// но не к конкретному мастеру (мастер видит только то, что назначено лично).
//
// LEFT JOIN clients: если задача привязана к карточке клиента (t.client_id),
// тянем имя и телефон — иначе строка вида «Позвонить» в сводке непонятна
// (фидбек пользователя: «позвонить кому?»). Клиент мог быть удалён
// (ON DELETE SET NULL в DDL) — тогда client_name/phone придут NULL,
// formatTaskLine просто не приклеит хвост.
async function getTasksForDate(schema, dateStr) {
  const r = await queryInSchema(schema,
    `SELECT t.id,
            t.title,
            t.priority,
            t.due_date,
            t.due_time,
            t.assigned_to,
            (t.due_date < $1) AS is_overdue,
            c.name  AS client_name,
            c.phone AS client_phone
       FROM {{schema}}.tasks t
       LEFT JOIN {{schema}}.clients c ON c.id = t.client_id
      WHERE t.status IN ('pending', 'in_progress')
        AND t.due_date IS NOT NULL
        AND t.due_date <= $1
      ORDER BY (t.due_date < $1) DESC,        -- просроченные сверху
               CASE t.priority
                 WHEN 'urgent' THEN 0
                 WHEN 'high'   THEN 1
                 WHEN 'medium' THEN 2
                 WHEN 'low'    THEN 3
                 ELSE 4
               END,
               t.due_time ASC NULLS LAST,
               t.id ASC`,
    [dateStr]
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

// Текстовая метка приоритета. Без эмодзи (минимализм).
function priorityLabel(priority) {
  switch (priority) {
    case 'urgent': return 'срочно';
    case 'high':   return 'важно';
    default:       return null; // medium / low — без метки
  }
}

// Строка задачи в дневной сводке. Без эмодзи — фидбек владельца: «сами
// задачи пиши без смайликов».
//
// Если задача привязана к клиенту (client_id, см. getTasksForDate), к
// заголовку приклеиваем имя и телефон — иначе «Позвонить» в сводке
// непонятна. Имя и телефон даём отдельной строкой ниже заголовка, чтобы
// Telegram распознал телефон как tel:-ссылку и сделал тапом-звонком.
// Клиент без телефона (старые карточки) — приклеиваем только имя.
// Без имени и без телефона (задача не привязана) — никаких хвостов.
function formatTaskLine(t) {
  const title = tg.escapeHtml(t.title || 'без названия');
  const tag   = priorityLabel(t.priority);
  const tagPart = tag ? ` <i>· ${tag}</i>` : '';

  let clientLine = '';
  if (t.client_name || t.client_phone) {
    const parts = [];
    if (t.client_name)  parts.push(tg.escapeHtml(t.client_name));
    if (t.client_phone) parts.push(tg.escapeHtml(t.client_phone));
    clientLine = `\n  ${parts.join(' · ')}`;
  }

  return `• ${title}${tagPart}${clientLine}`;
}

// Форматирует блок задач для дневной сводки. Возвращает '' если задач нет.
// Заголовки секций без эмодзи — минимализм, как и сами строки задач.
function formatTasksSection(tasks) {
  if (!tasks.length) return '';
  const overdue = tasks.filter((t) => t.is_overdue);
  const today   = tasks.filter((t) => !t.is_overdue);

  let out = '';
  if (today.length) {
    const word = pluralize(today.length, 'задача', 'задачи', 'задач');
    out += `\n\nНа сегодня (${today.length} ${word}):\n` +
           today.map(formatTaskLine).join('\n');
  }
  if (overdue.length) {
    const word = pluralize(overdue.length, 'задача', 'задачи', 'задач');
    out += `\n\nПросрочено (${overdue.length} ${word}):\n` +
           overdue.map(formatTaskLine).join('\n');
  }
  return out;
}

// ──────────────────────────────────────────────────────────────────────
// Отправители — каждый с claim'ом, чтобы не дублировать.
// ──────────────────────────────────────────────────────────────────────

async function sendDailySummary(user, dateStr, bookings, tasks, isMasterOwn) {
  // Сначала «забронировали» — потом шлём. Если БД уже видела отправку,
  // вторая попытка из соседнего тика просто получит false и тихо выйдет.
  if (!(await claimDaily(user.id, dateStr))) return;

  // Только имя, без фамилии — фидбек владельца: «обращаться только по
  // имени». users.name в нашей системе хранится в формате «Имя Фамилия»
  // (или просто «Имя», если фамилия не заполнена). Берём первое слово.
  // \s — любой пробельный, на случай неразрывных пробелов из вставки.
  const firstName = user.name ? String(user.name).trim().split(/\s+/)[0] : '';
  const greetName = firstName ? tg.escapeHtml(firstName) : '';
  const greetWith = greetName ? `, ${greetName}` : '';
  const tasksSection = formatTasksSection(tasks);

  let text;
  if (!bookings.length) {
    if (user.role === 'master' && !tasks.length) {
      // Master без записей и без задач — не дёргаем (нет смысла).
      // Claim уже сделан — это ок, дубля точно не будет, а пустой шум не уйдёт.
      return;
    }
    if (!tasks.length) {
      text = applyGender(
        `☀️ Доброе утро${greetWith}\n\n` +
        `Сегодня записей в студии нет, можно выдохнуть и закрыть накопленные дела.`,
        user.gender
      );
    } else {
      // Записей нет, но есть задачи — короткий интро + блок задач.
      const intro = isMasterOwn
        ? `☀️ Доброе утро${greetWith}\nЗаписей сегодня нет, но есть дела:`
        : `☀️ Доброе утро${greetWith}\nЗаписей в студии нет, но есть задачи:`;
      text = `${intro}${tasksSection}`;
    }
  } else {
    const n = bookings.length;
    const word = pluralize(n, 'запись', 'записи', 'записей');
    const lines = bookings.map(formatBookingLine).join('\n');
    const intro = isMasterOwn
      ? `☀️ Доброе утро${greetWith}\nСегодня у тебя ${n} ${word}:`
      : `☀️ Доброе утро${greetWith}\nСегодня в студии ${n} ${word}:`;
    text = `${intro}\n\n${lines}${tasksSection}\n\nХорошего дня 🔥`;
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

  const nowMin = local.hh * 60 + local.mm;
  // Утренняя сводка — фича тарифа Студия. Если студия на trial/solo —
  // ни в каком окне не шлём, даже если в БД остался ранее выставленный
  // daily_summary_time (например, тариф понизился со studio до solo).
  const inDailyWindow = planHasDailySummary(studio.plan)
    && isInDailyWindow(local, studio.daily_summary_time);

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

  // ── 1) Daily summary в выбранное owner-ом время (окно 10 мин) ──────
  // Если studio.daily_summary_time === NULL → owner отключил сводку,
  // inDailyWindow = false, секцию пропускаем.
  if (inDailyWindow) {
    let allTasks;
    try {
      allTasks = await getTasksForDate(studio.schema_name, local.dateStr);
    } catch (e) {
      console.error(`[reminders] getTasks failed for ${studio.schema_name}:`, e.message);
      allTasks = []; // fail-soft: сводка пойдёт без задач
    }

    for (const u of users) {
      const userBookings = (u.role === 'master')
        ? bookings.filter((b) => b.master_id === u.id)
        : bookings; // owner / manager — все
      // master видит только задачи, назначенные лично; owner/manager — все
      // активные задачи студии (включая «без исполнителя»).
      const userTasks = (u.role === 'master')
        ? allTasks.filter((t) => t.assigned_to === u.id)
        : allTasks;
      try {
        await sendDailySummary(u, local.dateStr, userBookings, userTasks, u.role === 'master');
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
  formatTaskLine,
  formatTasksSection,
  isInDailyWindow,
};
