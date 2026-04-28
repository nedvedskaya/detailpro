'use strict';
/**
 * Telegram Bot webhook + команды бота.
 *
 *   POST /api/telegram/webhook   — TG шлёт сюда апдейты
 *
 * Безопасность:
 *   В заголовке X-Telegram-Bot-Api-Secret-Token TG передаёт значение,
 *   которое мы зарегистрировали при setWebhook (env TELEGRAM_WEBHOOK_SECRET).
 *   Несовпадение → 401 без обработки.
 *
 * Идемпотентность:
 *   Каждый update имеет уникальный update_id. Перед обработкой пишем его в
 *   saas_meta.tg_processed_updates ON CONFLICT DO NOTHING. Если запись была —
 *   мгновенно отвечаем 200 без повторной обработки.
 *
 * Поддерживаемые команды (входной message.text):
 *   /start link_<token>   — привязка TG-аккаунта к user-у CRM (deep-link)
 *   /start                — приветствие
 *   /unlink               — отвязать TG (выставляет users.tg_user_id = NULL)
 *   /referral             — реферальная ссылка + статистика
 *   /balance              — бонус-баланс + история
 *   /profile              — ссылка на Профиль в СРМ
 *   /help                 — поддержка: бот ловит следующее сообщение и шлёт админу
 *   любой текст           — если установлен state 'awaiting_support_message',
 *                           уходит в поддержку; иначе показываем меню/приветствие.
 *
 * Reply от админа (в чате SUPPORT_TG_CHAT_ID) на пересланное обращение →
 *   ответ клиенту в его чат с ботом.
 */

const express = require('express');
const crypto = require('node:crypto');
const { pool, withTx } = require('../lib/db.cjs');
const { consumeOneTimeToken, OneTimeTokenError } = require('../lib/one_time_token.cjs');
const tg = require('../lib/telegram.cjs');
const { applyGender } = require('../lib/gender.cjs');
const { planHasDailySummary } = require('../lib/plans.cjs');

const router = express.Router();

const APP_ORIGIN = (process.env.APP_ORIGIN || 'https://detailprocrm.ru').replace(/\/+$/, '');
const SUPPORT_CHAT_ID = process.env.SUPPORT_TG_CHAT_ID
  ? Number(process.env.SUPPORT_TG_CHAT_ID)
  : null;

// TTL стейта «жду сообщение в поддержку» — иначе случайный текст недели спустя
// попадёт в support_requests как обращение.
const STATE_TTL_MS = 15 * 60 * 1000;

// ──────────────────────────────────────────────────────────────────────
// Постоянное меню для привязанного пользователя.
//
// Owner видит полное меню: рефералка + тарифы + помощь + СРМ.
// Manager/master — урезанное: только «Помощь» и «Открыть СРМ». Биллинг
// и реферальная программа к ним не относятся (это бизнес-сущности
// студии, рулит ими собственник), поэтому смысла светить эти кнопки
// в их боте нет — раньше тап по ним возвращал «доступно только владельцу»,
// теперь просто не показываем.
//
// Бэк-проверки (handleReferral / handleTariffs → role !== 'owner') остаются:
// если кто-то введёт команду текстом или нажмёт inline-кнопку из старого
// сообщения — сервер всё равно ответит вежливым отказом.
// ──────────────────────────────────────────────────────────────────────
const OWNER_MENU_KEYBOARD = {
  keyboard: [
    [{ text: 'Реферальная ссылка' }, { text: 'Тарифы' }],
    [{ text: 'Помощь' },              { text: 'Открыть СРМ' }],
  ],
  resize_keyboard: true,
  is_persistent: true,
};

const STAFF_MENU_KEYBOARD = {
  keyboard: [
    [{ text: 'Помощь' }, { text: 'Открыть СРМ' }],
  ],
  resize_keyboard: true,
  is_persistent: true,
};

/**
 * Возвращает reply-клавиатуру в зависимости от роли. Owner получает
 * полное меню, manager/master — урезанное без биллинговых кнопок.
 *
 * Принимает либо объект linked (с .role), либо строку 'owner'/'manager'/...
 * Для совместимости со старыми вызовами, где linked мог быть undefined,
 * возвращаем пустое OWNER-меню (на практике этот код вызывается только
 * для linked-юзера).
 */
function menuFor(roleOrLinked) {
  const role = typeof roleOrLinked === 'string'
    ? roleOrLinked
    : roleOrLinked?.role;
  return role === 'owner' ? OWNER_MENU_KEYBOARD : STAFF_MENU_KEYBOARD;
}

// Алиас на старое имя — оставлен на случай вызовов из других мест,
// где роль не известна. Считаем такие места owner-only по умолчанию;
// их обнаружим по логам и поправим точечно.
const MENU_KEYBOARD = OWNER_MENU_KEYBOARD;

// Текст кнопки → название команды. Без эмодзи.
const BUTTON_TO_COMMAND = {
  'Реферальная ссылка': 'referral',
  'Тарифы':             'tariffs',
  'Помощь':             'help',
  'Открыть СРМ':        'open_crm',
};

const HIDE_KEYBOARD = { remove_keyboard: true };

// Inline-меню для незалинкованного пользователя при первом контакте с ботом.
//   • signup_start — бот сгенерит одноразовый ?tg=<token> и пришлёт ссылку
//     на сайт; при регистрации TG-аккаунт линканётся автоматом.
//   • link_help    — короткая инструкция: «зайди в СРМ → Профиль → Telegram
//     → Подключить» (для тех, у кого уже есть аккаунт).
//   • help         — текущий саппорт-флоу.
const UNLINKED_INLINE = {
  inline_keyboard: [
    [{ text: 'Создать аккаунт',         callback_data: 'signup:start' }],
    [{ text: 'У меня уже есть аккаунт', callback_data: 'link:help'   }],
    [{ text: 'Помощь',                  callback_data: 'help:start'  }],
  ],
};

// Алиас на старое имя — оставлен на случай ссылок из других мест файла.
// Кнопки под помощью для незалинкованного — простой URL на главную.
const REGISTER_INLINE = {
  inline_keyboard: [[{ text: 'Зарегистрироваться', url: APP_ORIGIN }]],
};

// Inline-кнопка «Открыть СРМ» — общий шорткат на главную.
const OPEN_CRM_INLINE = {
  inline_keyboard: [[{ text: 'Открыть СРМ', url: APP_ORIGIN }]],
};

// TARIFFS_INLINE строится динамически (см. buildTariffsInline ниже): для
// owner'а возвращаем 4 кнопки с прямыми (HMAC-подписанными) ссылками на
// payform.ru — один тап и юзер в чекауте, без захода в СРМ. Для гостя/
// не-owner'а используем простой fallback на /profile.
const TARIFFS_INLINE_FALLBACK = {
  inline_keyboard: [[{ text: 'Открыть в СРМ', url: `${APP_ORIGIN}/profile` }]],
};

// Срок жизни подписанной ссылки в /tariffs-сообщении. 7 дней — достаточно,
// чтобы юзер успел подумать и оплатить, и в то же время не оставлять
// «вечные» ссылки в истории чата.
const TG_PAY_LINK_TTL_SEC = 7 * 24 * 60 * 60;

/**
 * HMAC-подписанная ссылка на /api/profile/payment/from-tg. Server-side
 * этот эндпоинт верифицирует подпись, по tg_user_id находит owner'a,
 * выпускает intent и 302-редиректит на payform.ru.
 *
 * Зачем подписываем: без HMAC любой, кто увидел URL, мог бы триггернуть
 * issue intent'а на чужой студии (атакующий ничего не получает, но это
 * нагрузка на БД и шум в payment_intents). Подпись закрывает дёшево.
 */
function buildTgPayLink({ tgUserId, plan }) {
  const secret = process.env.PRODAMUS_SECRET_KEY || '';
  if (!secret) return null;
  const exp = Math.floor(Date.now() / 1000) + TG_PAY_LINK_TTL_SEC;
  const sig = crypto
    .createHmac('sha256', secret)
    .update(`tgpay:${tgUserId}:${plan}:${exp}`)
    .digest('hex');
  const u = new URL(`${APP_ORIGIN}/api/profile/payment/from-tg`);
  u.searchParams.set('plan', plan);
  u.searchParams.set('u', String(tgUserId));
  u.searchParams.set('exp', String(exp));
  u.searchParams.set('sig', sig);
  return u.toString();
}

/**
 * Inline-клавиатура с 4 кнопками оплаты для owner'а. Тапает «Соло·мес» —
 * Telegram открывает signed URL на нашем сервере, тот делает 302 на
 * Продамус. Один тап = чекаут, без промежуточного «откройте СРМ».
 *
 * Возвращает null, если не удалось подписать (нет секрета) — caller
 * подсунет TARIFFS_INLINE_FALLBACK.
 */
function buildTariffsInline(tgUserId) {
  const links = {
    solo_month:   buildTgPayLink({ tgUserId, plan: 'solo_month' }),
    solo_year:    buildTgPayLink({ tgUserId, plan: 'solo_year' }),
    studio_month: buildTgPayLink({ tgUserId, plan: 'studio_month' }),
    studio_year:  buildTgPayLink({ tgUserId, plan: 'studio_year' }),
  };
  if (Object.values(links).some((l) => !l)) return null;
  return {
    inline_keyboard: [
      [{ text: 'Соло · 1\u00a0мес — 4\u00a0900\u00a0₽',         url: links.solo_month }],
      [{ text: 'Соло · 12\u00a0мес — 49\u00a0900\u00a0₽ (−15%)', url: links.solo_year }],
      [{ text: 'Студия · 1\u00a0мес — 8\u00a0900\u00a0₽',        url: links.studio_month }],
      [{ text: 'Студия · 12\u00a0мес — 89\u00a0900\u00a0₽ (−16%)', url: links.studio_year }],
    ],
  };
}

// Inline-клавиатура «Парень/Девушка» — вопрос после успешной привязки.
const GENDER_INLINE = {
  inline_keyboard: [[
    { text: '👨 Парень',  callback_data: 'gender:m' },
    { text: '👩 Девушка', callback_data: 'gender:f' },
  ]],
};

// Список IANA-таймзон России. Подписи — крупный город + смещение UTC.
// Покрывает все 11 поясов от Калининграда (UTC+2) до Камчатки (UTC+12).
// Раскладка по 2 кнопки в ряд — компактнее на мобиле.
const TIMEZONES = [
  { tz: 'Europe/Kaliningrad',  label: 'Калининград (UTC+2)'  },
  { tz: 'Europe/Moscow',       label: 'Москва (UTC+3)'       },
  { tz: 'Europe/Samara',       label: 'Самара (UTC+4)'       },
  { tz: 'Asia/Yekaterinburg',  label: 'Екатеринбург (UTC+5)' },
  { tz: 'Asia/Omsk',           label: 'Омск (UTC+6)'         },
  { tz: 'Asia/Krasnoyarsk',    label: 'Красноярск (UTC+7)'   },
  { tz: 'Asia/Irkutsk',        label: 'Иркутск (UTC+8)'      },
  { tz: 'Asia/Yakutsk',        label: 'Якутск (UTC+9)'       },
  { tz: 'Asia/Vladivostok',    label: 'Владивосток (UTC+10)' },
  { tz: 'Asia/Magadan',        label: 'Магадан (UTC+11)'     },
  { tz: 'Asia/Kamchatka',      label: 'Камчатка (UTC+12)'    },
];
const VALID_TIMEZONES = new Set(TIMEZONES.map((t) => t.tz));

function buildTimezoneInline() {
  const rows = [];
  for (let i = 0; i < TIMEZONES.length; i += 2) {
    const row = [{ text: TIMEZONES[i].label, callback_data: `tz:${TIMEZONES[i].tz}` }];
    if (TIMEZONES[i + 1]) {
      row.push({ text: TIMEZONES[i + 1].label, callback_data: `tz:${TIMEZONES[i + 1].tz}` });
    }
    rows.push(row);
  }
  return { inline_keyboard: rows };
}

// Inline-клавиатура выбора времени утренней сводки. Owner-only.
//   dailytime:07:00..10:00 — фиксированные варианты
//   dailytime:custom        — переведёт в state 'awaiting_daily_time',
//                             следующее текстовое сообщение распарсим как HH:MM
//   dailytime:off           — daily_summary_time = NULL, сводка отключена
const DAILY_TIME_INLINE = {
  inline_keyboard: [
    [
      { text: '7:00',  callback_data: 'dailytime:07:00' },
      { text: '8:00',  callback_data: 'dailytime:08:00' },
      { text: '9:00',  callback_data: 'dailytime:09:00' },
      { text: '10:00', callback_data: 'dailytime:10:00' },
    ],
    [{ text: 'Своё время', callback_data: 'dailytime:custom' }],
    [{ text: 'Не присылать', callback_data: 'dailytime:off' }],
  ],
};

// Парсит «8:30» / «08:30» / «8.30» в строку 'HH:MM:SS' для PG TIME.
// Возвращает null если ввод невалидный (вне 00:00–23:59).
function parseHHMM(input) {
  const m = String(input || '').trim().match(/^(\d{1,2})[:.\s](\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (!Number.isFinite(h) || !Number.isFinite(min)) return null;
  if (h < 0 || h > 23) return null;
  if (min < 0 || min > 59) return null;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}:00`;
}

// ──────────────────────────────────────────────────────────────────────
// Тексты приветствия.
// ──────────────────────────────────────────────────────────────────────
function welcomeText() {
  // Стилистические тире заменены на запятые/двоеточия по правилу пользователя:
  // тире использовать ТОЛЬКО там, где этого требуют правила русского языка
  // (тире между подлежащим и сказуемым). Здесь это сохранено в строке про
  // «Клиенты, записи и календарь — всё в одном месте» (подлежащее-сущ. +
  // сказуемое-местоимение «всё»).
  return (
    `Привет, я <b>Детейл</b>, твой бот от Детейл Про СРМ. ` +
    `Беру на себя рутину, чтобы у тебя было время на бизнес 🔥\n\n` +
    `Забирай 3 дня бесплатного тест-драйва. Без привязки карты, ` +
    `тебе доступны все фишки тарифов «Соло» и «Студия».\n\n` +
    `<b>Что умеет СРМ:</b>\n` +
    `🔸 Клиенты, записи и календарь — всё в одном месте\n` +
    `🔸 Электронная приёмка авто: фото, состояние кузова по зонам, подпись клиента прямо на экране\n` +
    `🔸 Заказ-наряды по прайсу студии: скачал, распечатал, готово\n` +
    `🔸 Финансы, выручка, аналитика: видишь все цифры сразу\n` +
    `🔸 До 3 пользователей: собственник + менеджер + мастер, у каждого свои права\n\n` +
    `А я каждый день буду присылать напоминания о записях, задачах, ` +
    `чтобы ты ничего не забыл! Погнали 👇🏻`
  );
}

const jsonParser = express.json({ limit: '256kb' });

function verifyTgSecret(req) {
  const expected = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!expected) return false;
  const got = req.headers['x-telegram-bot-api-secret-token'];
  return typeof got === 'string' && got === expected;
}

async function markUpdateProcessed(updateId) {
  if (!Number.isFinite(updateId)) return true;
  const r = await pool.query(
    `INSERT INTO saas_meta.tg_processed_updates (update_id) VALUES ($1)
     ON CONFLICT (update_id) DO NOTHING RETURNING update_id`,
    [updateId]
  );
  return r.rowCount > 0;
}

// ──────────────────────────────────────────────────────────────────────
// FSM-стейт TG-юзера (для сценария «Помощь → ждём сообщение»).
// ──────────────────────────────────────────────────────────────────────
async function setState(tgUserId, state) {
  if (!tgUserId) return;
  await pool.query(
    `INSERT INTO saas_meta.tg_user_states (tg_user_id, state, set_at)
     VALUES ($1, $2, now())
     ON CONFLICT (tg_user_id) DO UPDATE SET state = $2, set_at = now()`,
    [tgUserId, state]
  );
}

async function getActiveState(tgUserId) {
  if (!tgUserId) return null;
  const r = await pool.query(
    `SELECT state, set_at FROM saas_meta.tg_user_states WHERE tg_user_id = $1`,
    [tgUserId]
  );
  if (!r.rows[0]) return null;
  if (Date.now() - new Date(r.rows[0].set_at).getTime() > STATE_TTL_MS) {
    await clearState(tgUserId);
    return null;
  }
  return r.rows[0].state;
}

async function clearState(tgUserId) {
  if (!tgUserId) return;
  await pool.query(`DELETE FROM saas_meta.tg_user_states WHERE tg_user_id = $1`, [tgUserId]);
}

// ──────────────────────────────────────────────────────────────────────
// Lookup: пользователь по tg_user_id + контекст студии.
// ──────────────────────────────────────────────────────────────────────
async function findLinkedUser(tgUserId) {
  if (!tgUserId) return null;
  const r = await pool.query(
    `SELECT u.id, u.email, u.name, u.role, u.studio_id, u.tg_chat_id, u.gender,
            s.referral_code, s.bonus_balance_kop,
            s.display_name AS studio_name, s.plan, s.access_until,
            s.timezone, s.timezone_set,
            s.daily_summary_time, s.daily_summary_time_set
       FROM saas_meta.users u
       LEFT JOIN saas_meta.studios s ON s.id = u.studio_id
      WHERE u.tg_user_id = $1`,
    [tgUserId]
  );
  return r.rows[0] || null;
}

// ──────────────────────────────────────────────────────────────────────
// Утилиты форматирования.
// ──────────────────────────────────────────────────────────────────────
function formatRub(kop) {
  // Форматируем в рубли. 125000 коп → "1 250 ₽". Без копеек, неразрывный пробел.
  const rub = Math.round((kop || 0) / 100);
  return rub.toLocaleString('ru-RU').replace(/\s/g, '\u00A0') + '\u00A0₽';
}

// ──────────────────────────────────────────────────────────────────────
// /start — приветствие или привязка по link_<token>.
// ──────────────────────────────────────────────────────────────────────
async function handleStart(message, args) {
  const chatId = message.chat.id;
  const tgUser = message.from || {};

  if (args && args.startsWith('link_')) {
    const token = args.slice('link_'.length);
    return consumeLinkToken({ token, tgUser, chatId });
  }

  // Сброс саппорт-стейта если он висит — пользователь явно вышел из «помощи».
  await clearState(tgUser.id);

  const linked = await findLinkedUser(tgUser.id);
  if (linked) {
    await tg.sendMessage({
      chatId, userId: linked.id, kind: 'start_already_linked',
      replyMarkup: menuFor(linked),
      text: applyGender(
        `Привет, ${tg.escapeHtml(linked.name || linked.email)} 👋\n` +
        `Мы уже на коннекте, твой аккаунт СРМ надежно привязан. ` +
        `Я на месте и готов{а} работать)\n\n` +
        `Выбирай нужное действие в меню внизу`,
        linked.gender
      ),
    });
    // Если онбординг не пройден (нет пола / owner без таймзоны) — спросим.
    await runOnboardingChecks(chatId, linked);
    return;
  }

  await tg.sendMessage({
    chatId, kind: 'start_unknown',
    replyMarkup: UNLINKED_INLINE,
    text: welcomeText(),
  });
}

async function consumeLinkToken({ token, tgUser, chatId }) {
  let userId;
  try {
    // Транзакция: проверка токена + проверка дубля tg_user_id + линковка +
    // consume — всё атомарно. withTx сам делает COMMIT/ROLLBACK + release.
    userId = await withTx(async (client) => {
      const tokenRow = await consumeOneTimeToken(
        client, 'saas_meta.tg_link_tokens', token, { columns: ['user_id'] }
      );

      // Дубль: тот же tg_user_id уже привязан к другому юзеру СРМ.
      // Эта проверка специфична для этого роута → бросаем sentinel-ошибку,
      // ловим её ниже и шлём «link_taken» в TG.
      const dupe = await client.query(
        `SELECT id FROM saas_meta.users WHERE tg_user_id = $1 AND id <> $2`,
        [tgUser.id, tokenRow.user_id]
      );
      if (dupe.rows[0]) {
        const e = new Error('tg_link_taken');
        e.code = 'TG_LINK_TAKEN';
        throw e;
      }

      await client.query(
        `UPDATE saas_meta.users
            SET tg_user_id   = $1,
                tg_username  = $2,
                tg_chat_id   = $3,
                tg_linked_at = now()
          WHERE id = $4`,
        [tgUser.id, tgUser.username || null, chatId, tokenRow.user_id]
      );
      await client.query(
        `UPDATE saas_meta.tg_link_tokens SET consumed_at = now() WHERE token = $1`,
        [token]
      );

      return tokenRow.user_id;
    });
  } catch (err) {
    // OneTimeTokenError → reason ∈ {invalid, used, expired}, отвечаем
    // соответствующим текстом боту. ROLLBACK сделан внутри withTx.
    if (err instanceof OneTimeTokenError) {
      const map = {
        invalid: {
          kind: 'link_invalid',
          text:
            'Упс, ссылка для привязки недействительна.\n' +
            'Сгенерируй новую в СРМ (Профиль → Telegram).',
        },
        used: {
          kind: 'link_used',
          text:
            'Эта ссылка уже использована.\n' +
            'Если не ты, сгенерируй новую в СРМ (Профиль → Telegram).',
        },
        expired: {
          kind: 'link_expired',
          text:
            'Ссылка устарела 👵\n' +
            'Сгенерируй новую в СРМ (она действует 24 часа).',
        },
      };
      const m = map[err.reason] || map.invalid;
      await tg.sendMessage({ chatId, kind: m.kind, text: m.text });
      return;
    }
    if (err && err.code === 'TG_LINK_TAKEN') {
      await tg.sendMessage({
        chatId, kind: 'link_taken',
        text:
          'Стоп-мотор 🤚 Этот Telegram уже занят: он привязан к другому аккаунту СРМ. ' +
          'Я бы рад, но не могу работать на два фронта)\n\n' +
          '<b>Как это исправить:</b>\n' +
          'Отправь команду /unlink, чтобы отвязать текущий аккаунт.\n' +
          'Перейди по ссылке из нужного профиля СРМ еще раз.',
      });
      return;
    }
    console.error('[telegram] consumeLinkToken failed:', err);
    await tg.sendMessage({
      chatId, kind: 'link_error',
      text:
        'Кажется, под капотом что-то задымилось 🛠️ ' +
        'Произошла небольшая техническая заминка.\n\n' +
        'Попробуй еще раз через пару минут. Если ошибка останется, ' +
        'смело пиши в поддержку, они быстро всё починят.',
    });
    return;
  }

  // Post-commit: подтягиваем display-имя для приветственного сообщения и
  // запускаем онбординг (gender + timezone). Эти операции вне транзакции —
  // не должны блокировать commit и не критичны для целостности линковки.
  const u = await pool.query(
    `SELECT email, name, role FROM saas_meta.users WHERE id = $1`,
    [userId]
  );
  const display = u.rows[0]?.name || u.rows[0]?.email || '';
  const role = u.rows[0]?.role || 'master';

  await tg.sendMessage({
    chatId, userId, kind: 'link_success',
    replyMarkup: menuFor(role),
    text:
      `✅ Супер${display ? ', ' + tg.escapeHtml(display) : ''}. Коннект установлен.\n\n` +
      `Твой аккаунт СРМ успешно привязан к Telegram. ` +
      `Теперь я буду держать руку на пульсе и присылать сюда:\n\n` +
      `• Инфу записях на день\n` +
      `• Напоминания и задачи\n\n` +
      `Работаем)`,
  });

  // После успешной привязки — спрашиваем пол и (для owner) таймзону.
  // Перезагружаем linked, чтобы знать актуальные gender/timezone_set.
  const linked = await findLinkedUser(tgUser.id);
  await runOnboardingChecks(chatId, linked);
}

async function handleUnlink(message) {
  const chatId = message.chat.id;
  const tgId = message.from?.id;
  await clearState(tgId);
  const r = await pool.query(
    `UPDATE saas_meta.users
        SET tg_user_id = NULL, tg_username = NULL, tg_chat_id = NULL, tg_linked_at = NULL
      WHERE tg_user_id = $1
      RETURNING id`,
    [tgId]
  );
  if (r.rowCount === 0) {
    await tg.sendMessage({
      chatId, kind: 'unlink_not_linked',
      replyMarkup: HIDE_KEYBOARD,
      text:
        'Отвязывать нечего 🤷‍♂️\n' +
        'Мы и так свободны друг от друга, этот Telegram не привязан ни к одному аккаунту СРМ.',
    });
    return;
  }
  await tg.sendMessage({
    chatId, kind: 'unlink_success',
    replyMarkup: HIDE_KEYBOARD,
    text:
      'Готово, Telegram отвязан. Коннект разорван 💔\n' +
      'Сюда больше не будут приходить напоминания.\n\n' +
      'Если передумаешь и захочешь вернуть все как было, ты знаешь, где меня найти: ' +
      'CRM → Профиль → Telegram → «Подключить».',
  });
}

// ──────────────────────────────────────────────────────────────────────
// Сценарий «Создать аккаунт» из welcome-меню (для незалинкованного TG).
//
// Идея: бот выписывает одноразовый ?tg=<token>, который сайт читает в
// /signup, и при создании user-а в той же транзакции пишет
// tg_user_id/tg_chat_id/tg_username из строки токена. Никакого ручного
// «зайти в Профиль и нажать Подключить» — сразу СРМ + привязанный TG.
//
// Безопасность:
//   • token — 32 байта url-safe random
//   • TTL 30 минут
//   • один активный токен на tg_user_id (партиальный UNIQUE,
//     см. миграцию 010): при повторном «Создать аккаунт» старая запись
//     грохается, выпускается новая ссылка
//   • consumed_at ставится в той же транзакции signup-а на бэке
// ──────────────────────────────────────────────────────────────────────
async function issueSignupToken({ tgUser, chatId }) {
  // Если TG-юзер УЖЕ залинкован — выходим, signup ему не нужен.
  // (handleSignupStart всё равно проверяет, но дублирующая проверка дешевле,
  // чем сгенерить токен и потом обнаружить, что он не пригодится.)
  const linked = await findLinkedUser(tgUser.id);
  if (linked) return { alreadyLinked: true };

  // Старые незаюзанные токены этого tg_user_id — выпиливаем, чтобы не
  // словить 23505 на uq_tg_signup_tokens_active_per_user и чтобы старые
  // ссылки протухали мгновенно.
  await pool.query(
    `DELETE FROM saas_meta.tg_signup_tokens
      WHERE tg_user_id = $1 AND consumed_at IS NULL`,
    [tgUser.id]
  );

  const token = crypto.randomBytes(32).toString('base64url');
  await pool.query(
    `INSERT INTO saas_meta.tg_signup_tokens
       (token, tg_user_id, tg_chat_id, tg_username, expires_at)
     VALUES ($1, $2, $3, $4, now() + interval '30 minutes')`,
    [token, tgUser.id, chatId, tgUser.username || null]
  );
  return { token, url: `${APP_ORIGIN}/?tg=${encodeURIComponent(token)}` };
}

async function handleSignupStart(chatId, tgUser) {
  const issued = await issueSignupToken({ tgUser, chatId });
  if (issued.alreadyLinked) {
    // Кто-то нажал «Создать аккаунт», уже будучи залинкован. Дружелюбно
    // показываем меню и говорим, что всё уже на коннекте.
    const linked = await findLinkedUser(tgUser.id);
    await tg.sendMessage({
      chatId, userId: linked.id, kind: 'signup_already_linked',
      replyMarkup: menuFor(linked),
      text: applyGender(
        `У тебя уже есть аккаунт СРМ, и Telegram к нему привязан 👌\n` +
        `Открывай меню внизу, всё на месте.`,
        linked.gender
      ),
    });
    return;
  }

  const inline = {
    inline_keyboard: [[
      { text: 'Открыть регистрацию', url: issued.url },
    ]],
  };
  await tg.sendMessage({
    chatId, kind: 'signup_link',
    replyMarkup: inline,
    text:
      `Погнали 🚀\n\n` +
      `Жми кнопку ниже, откроется страница регистрации, где этот Telegram ` +
      `уже будет в комплекте. Нужно будет только указать название студии, ` +
      `имя и email, и можно работать.\n\n` +
      `Ссылка действует 30 минут. Если не успеешь, просто нажми ` +
      `«Создать аккаунт» ещё раз.`,
  });
}

async function handleLinkHelp(chatId) {
  const inline = {
    inline_keyboard: [[
      { text: 'Открыть СРМ', url: APP_ORIGIN },
    ]],
  };
  await tg.sendMessage({
    chatId, kind: 'link_help',
    replyMarkup: inline,
    text:
      `Окей, привяжем твой аккаунт 👇\n\n` +
      `<b>Что нужно сделать:</b>\n` +
      `1. Открой СРМ кнопкой ниже и войди под своим email/паролем.\n` +
      `2. Зайди в <b>Профиль → Telegram → «Подключить»</b>.\n` +
      `3. Нажми на ссылку, она автоматически откроется здесь, в этом чате.\n\n` +
      `Через 5 секунд после этого мы будем на коннекте, и я начну ` +
      `присылать сюда напоминания о записях.`,
  });
}

// ──────────────────────────────────────────────────────────────────────
// Онбординг: после привязки спрашиваем пол → таймзону (только owner).
// Вызывается:
//   • из consumeLinkToken после link_success
//   • из handleStart, если пользователь уже привязан (на случай, если
//     раньше пропустил вопросы — запросим снова, чтобы система напоминаний
//     работала корректно).
// Идемпотентно: если оба ответа уже есть, ничего не шлёт.
// ──────────────────────────────────────────────────────────────────────
async function runOnboardingChecks(chatId, linked) {
  if (!linked) return;
  // 1) Пол ещё не указан → спрашиваем.
  if (!linked.gender) {
    await askGenderQuestion(chatId, linked.id);
    return;
  }
  // 2) Owner и таймзона не выбрана явно → спрашиваем.
  if (linked.role === 'owner' && linked.timezone_set === false) {
    await askTimezoneQuestion(chatId, linked.id);
    return;
  }
  // 3) Owner и время утренней сводки ещё не выбрано явно → спрашиваем.
  //    Только у owner-а на тарифе «Студия»: на trial/solo функция
  //    недоступна, спрашивать нечего; чтобы не переспрашивать после
  //    апгрейда — флаг _set не трогаем (NULL остаётся NULL).
  if (linked.role === 'owner'
      && linked.daily_summary_time_set === false
      && planHasDailySummary(linked.plan)) {
    await askDailySummaryTimeQuestion(chatId, linked.id);
    return;
  }
  // Иначе — всё ок, ничего не делаем (меню уже показано выше).
}

async function askGenderQuestion(chatId, userId) {
  await tg.sendMessage({
    chatId, userId, kind: 'ask_gender',
    replyMarkup: GENDER_INLINE,
    text:
      `Подскажи, как к тебе обращаться? ` +
      `Я буду писать в нужном роде, «забыл» или «забыла». ` +
      `Поменять можно в любой момент в Профиле СРМ.`,
  });
}

async function askTimezoneQuestion(chatId, userId) {
  await tg.sendMessage({
    chatId, userId, kind: 'ask_timezone',
    replyMarkup: buildTimezoneInline(),
    text:
      `Выбери часовой пояс студии, по нему я буду присылать утреннюю ` +
      `сводку и напоминания за час до записи. Если города нет в списке, ` +
      `выбирай ближайший с тем же смещением.`,
  });
}

async function askDailySummaryTimeQuestion(chatId, userId) {
  await tg.sendMessage({
    chatId, userId, kind: 'ask_daily_time',
    replyMarkup: DAILY_TIME_INLINE,
    text:
      `Во сколько присылать утреннюю сводку с записями и задачами на день? ` +
      `Можно выбрать готовый вариант или задать своё время. ` +
      `Поменять можно командой /время.`,
  });
}

async function sendOnboardingDone(chatId, userId, role = null) {
  await tg.sendMessage({
    chatId, userId, kind: 'onboarding_done',
    replyMarkup: menuFor(role),
    text:
      `Готово, всё настроено 🎯\n` +
      `Жду первой записи в календаре, пришлю напоминание за час, ` +
      `а утром скину сводку на день. Меню внизу.`,
  });
}

// ──────────────────────────────────────────────────────────────────────
// Обработка callback_query (нажатие inline-кнопки).
//   gender:m | gender:f
//   tz:<IANA>
// Все остальные — ack без эффекта.
// После сохранения убираем клавиатуру у исходного сообщения, чтобы
// нельзя было нажать второй раз и схлопотать дубликат.
// ──────────────────────────────────────────────────────────────────────
async function dispatchCallback(cb) {
  const data = String(cb.data || '');
  const tgUser = cb.from || {};
  const msg = cb.message || {};
  const chatId = msg.chat?.id;
  const messageId = msg.message_id;

  // Любое нажатие — сразу ACK (иначе у пользователя крутится «загрузка»).
  // Дальше можем долго работать, ACK уже ушёл.
  await tg.answerCallbackQuery(cb.id).catch(() => {});

  if (!chatId) return;

  // ── Callback'и для НЕзалинкованного пользователя ───────────────────
  // (welcome-меню: «Создать аккаунт» / «У меня есть аккаунт» / «Помощь»).
  // Не требуют linked user — обрабатываем до общей проверки.
  if (data === 'signup:start') {
    await tg.editMessageReplyMarkup(chatId, messageId, null).catch(() => {});
    return handleSignupStart(chatId, tgUser);
  }
  if (data === 'link:help') {
    await tg.editMessageReplyMarkup(chatId, messageId, null).catch(() => {});
    return handleLinkHelp(chatId);
  }
  if (data === 'help:start') {
    await tg.editMessageReplyMarkup(chatId, messageId, null).catch(() => {});
    return handleHelp({ chat: { id: chatId }, from: tgUser });
  }

  // Все остальные наши callback'и требуют привязанного пользователя.
  const linked = await findLinkedUser(tgUser.id);
  if (!linked) {
    await tg.sendMessage({
      chatId, kind: 'callback_unlinked',
      text: 'Сначала привяжи аккаунт СРМ: Профиль → Telegram → «Подключить».',
    });
    return;
  }

  // ── gender:m | gender:f ────────────────────────────────────────────
  if (data === 'gender:m' || data === 'gender:f') {
    const g = data === 'gender:f' ? 'f' : 'm';
    await pool.query(
      `UPDATE saas_meta.users SET gender = $1 WHERE id = $2`,
      [g, linked.id]
    );
    // Снимаем кнопки у исходного сообщения — повторное нажатие не сработает.
    await tg.editMessageReplyMarkup(chatId, messageId, null).catch(() => {});

    // Подтверждаем выбор и идём дальше по онбордингу.
    const ack = g === 'f'
      ? 'Принято, буду писать в женском роде ✨'
      : 'Принято, буду писать в мужском роде ✨';
    await tg.sendMessage({
      chatId, userId: linked.id, kind: 'gender_set',
      text: ack,
    });

    // Если owner и таймзона не выбрана — следующим шагом спросим её.
    const fresh = await findLinkedUser(tgUser.id);
    if (fresh?.role === 'owner' && fresh.timezone_set === false) {
      await askTimezoneQuestion(chatId, linked.id);
    } else {
      await sendOnboardingDone(chatId, linked.id, fresh?.role || linked.role);
    }
    return;
  }

  // ── tz:<IANA> ──────────────────────────────────────────────────────
  if (data.startsWith('tz:')) {
    const tz = data.slice(3);
    if (!VALID_TIMEZONES.has(tz)) {
      // Подделка callback_data — игнорим.
      return;
    }
    if (linked.role !== 'owner') {
      await tg.sendMessage({
        chatId, userId: linked.id, kind: 'tz_not_owner',
        text: 'Часовой пояс студии меняет только владелец.',
      });
      return;
    }
    await pool.query(
      `UPDATE saas_meta.studios
          SET timezone = $1, timezone_set = TRUE
        WHERE id = $2`,
      [tz, linked.studio_id]
    );
    await tg.editMessageReplyMarkup(chatId, messageId, null).catch(() => {});

    const label = TIMEZONES.find((t) => t.tz === tz)?.label || tz;
    await tg.sendMessage({
      chatId, userId: linked.id, kind: 'tz_set',
      text: `Готово, часовой пояс студии: <b>${tg.escapeHtml(label)}</b>.`,
    });
    // Сюда попадаем только если linked.role === 'owner' (см. проверку выше).
    // Следующий шаг онбординга — время утренней сводки.
    const fresh = await findLinkedUser(tgUser.id);
    if (fresh?.daily_summary_time_set === false) {
      await askDailySummaryTimeQuestion(chatId, linked.id);
    } else {
      await sendOnboardingDone(chatId, linked.id, 'owner');
    }
    return;
  }

  // ── dailytime:HH:MM | dailytime:custom | dailytime:off ─────────────
  if (data.startsWith('dailytime:')) {
    if (linked.role !== 'owner') {
      await tg.sendMessage({
        chatId, userId: linked.id, kind: 'dailytime_not_owner',
        text: 'Время утренней сводки настраивает только владелец.',
      });
      return;
    }
    // Гейтинг по тарифу — на случай гонки: тариф мог понизиться, пока
    // у юзера в чате висел inline-кейборд из прошлой сессии. Молча
    // снимаем кейборд (editMessageReplyMarkup), отвечаем причиной.
    if (!planHasDailySummary(linked.plan)) {
      await tg.editMessageReplyMarkup(chatId, messageId, null).catch(() => {});
      await tg.sendMessage({
        chatId, userId: linked.id, kind: 'dailytime_plan_locked',
        text:
          'Утренняя сводка приходит на тарифе «Студия». ' +
          'Оформить можно в Профиле СРМ.',
      });
      return;
    }
    const choice = data.slice('dailytime:'.length);
    await tg.editMessageReplyMarkup(chatId, messageId, null).catch(() => {});

    if (choice === 'custom') {
      // Переводим юзера в state ожидания текстового ввода. Следующее
      // сообщение будет распарсено как HH:MM в dispatchMessage.
      await setState(tgUser.id, 'awaiting_daily_time');
      await tg.sendMessage({
        chatId, userId: linked.id, kind: 'dailytime_custom_prompt',
        text: 'Напиши время в формате <b>ЧЧ:ММ</b>, например 8:30.',
      });
      return;
    }

    if (choice === 'off') {
      await pool.query(
        `UPDATE saas_meta.studios
            SET daily_summary_time = NULL, daily_summary_time_set = TRUE
          WHERE id = $1`,
        [linked.studio_id]
      );
      await tg.sendMessage({
        chatId, userId: linked.id, kind: 'dailytime_off',
        text:
          'Принято, утреннюю сводку присылать не буду. ' +
          'Включить обратно — командой /время.',
      });
      await sendOnboardingDone(chatId, linked.id, 'owner');
      return;
    }

    // Фиксированный вариант '07:00' / '08:00' / '09:00' / '10:00'.
    const parsed = parseHHMM(choice);
    if (!parsed) {
      // Подделка callback_data — игнорим.
      return;
    }
    await pool.query(
      `UPDATE saas_meta.studios
          SET daily_summary_time = $1, daily_summary_time_set = TRUE
        WHERE id = $2`,
      [parsed, linked.studio_id]
    );
    await tg.sendMessage({
      chatId, userId: linked.id, kind: 'dailytime_set',
      text: `Готово, утренняя сводка будет приходить в <b>${tg.escapeHtml(parsed.slice(0, 5))}</b>.`,
    });
    await sendOnboardingDone(chatId, linked.id, 'owner');
    return;
  }
}

// ──────────────────────────────────────────────────────────────────────
// /open_crm — кнопка «Открыть СРМ». Просто шорткат на главную страницу.
// Раньше была «Профиль», но /profile в SPA не всегда корректно открывает
// нужный экран (зависит от состояния роутера). Главная — самое надёжное.
// ──────────────────────────────────────────────────────────────────────
async function handleOpenCrm(message) {
  const tgId = message.from?.id;
  const linked = await findLinkedUser(tgId);
  if (!linked) {
    await tg.sendMessage({
      chatId: message.chat.id, kind: 'open_crm_unlinked',
      replyMarkup: REGISTER_INLINE,
      text:
        `СРМ ждёт тебя по красной дорожке 👇\n` +
        `Если аккаунта ещё нет, забирай 3 дня бесплатно, без карты, ` +
        `без подвохов. Я тут на месте, как привяжешься, начну работать.`,
    });
    return;
  }
  await tg.sendMessage({
    chatId: message.chat.id, userId: linked.id, kind: 'open_crm_link',
    replyMarkup: OPEN_CRM_INLINE,
    text: applyGender(
      `Готов{/а} приступить к работе? Я тоже 💪\n` +
      `Открывай СРМ кнопкой ниже: клиенты, записи, финансы и тарифы там же.`,
      linked.gender
    ),
  });
}

// ──────────────────────────────────────────────────────────────────────
// /referral — реферальная ссылка + статистика.
// Использует ту же БД, что и страница «Реферальная программа» в СРМ:
//   saas_meta.studios.referral_code, bonus_balance_kop
//   saas_meta.studios.referred_by   (счётчики регистраций / оплат)
//   saas_meta.referral_events       (история начислений / списаний)
// Это значит: цифры в боте и в СРМ идентичны, синхронизация автоматическая.
// ──────────────────────────────────────────────────────────────────────
async function handleReferral(message) {
  const tgId = message.from?.id;
  const linked = await findLinkedUser(tgId);
  if (!linked) {
    await tg.sendMessage({
      chatId: message.chat.id, kind: 'referral_unlinked',
      replyMarkup: REGISTER_INLINE,
      text:
        'Реферальная программа доступна только владельцам студий в СРМ.\n\n' +
        'Зарегистрируйся (3 дня бесплатно), после регистрации твоя ссылка ' +
        'появится в Профиле → Реферальная программа.',
    });
    return;
  }
  if (linked.role !== 'owner') {
    await tg.sendMessage({
      chatId: message.chat.id, userId: linked.id, kind: 'referral_not_owner',
      replyMarkup: STAFF_MENU_KEYBOARD,
      text:
        'Реферальная программа доступна только владельцу студии. ' +
        'Если есть вопросы, нажми «❓ Помощь».',
    });
    return;
  }

  const summary = await pool.query(
    `SELECT
        s.referral_code,
        s.bonus_balance_kop,
        (SELECT count(*)::int FROM saas_meta.studios c
          WHERE c.referred_by = s.id) AS regs,
        (SELECT count(DISTINCT c.id)::int FROM saas_meta.studios c
           JOIN saas_meta.payments p ON p.studio_id = c.id AND p.status = 'paid'
          WHERE c.referred_by = s.id) AS paid,
        (SELECT COALESCE(sum(amount_kop), 0)::int FROM saas_meta.referral_events
          WHERE studio_id = s.id AND kind = 'credit') AS earned,
        (SELECT COALESCE(sum(amount_kop), 0)::int FROM saas_meta.referral_events
          WHERE studio_id = s.id AND kind = 'debit') AS spent
       FROM saas_meta.studios s
      WHERE s.id = $1`,
    [linked.studio_id]
  );
  const r = summary.rows[0] || {};
  const link = `${APP_ORIGIN}/?ref=${r.referral_code || ''}`;

  await tg.sendMessage({
    chatId: message.chat.id, userId: linked.id, kind: 'referral_show',
    replyMarkup: {
      inline_keyboard: [
        [{ text: 'Открыть в СРМ', url: `${APP_ORIGIN}/profile` }],
      ],
    },
    text:
      `<b>Реферальная программа</b>\n\n` +
      `Делись ссылкой с коллегами: за каждую студию, которая оплатит тариф, ` +
      `тебе на бонус-баланс падает <b>1 250 ₽</b>. Бонусы автоматически ` +
      `применяются при оплате твоего тарифа: приятный кешбэк, без танцев с бубном.\n\n` +
      `<b>Твоя ссылка:</b>\n<code>${link}</code>\n\n` +
      `<b>Статистика:</b>\n` +
      `• Регистраций: ${r.regs || 0}\n` +
      `• Оплатили: ${r.paid || 0}\n` +
      `• Всего начислено: ${formatRub(r.earned)}\n` +
      `• Потрачено: ${formatRub(r.spent)}\n\n` +
      `Доступно: <b>${formatRub(r.bonus_balance_kop)}</b>`,
  });
}

// ──────────────────────────────────────────────────────────────────────
// /tariffs (кнопка «Тарифы») — текущий план + что можно купить.
// Источник цифр — ProfilePage.tsx (`TARIFF_GROUPS`). Если на сайте поменяешь
// цены — синхронизируй здесь же. Реальные кнопки оплаты Prodamus с подстановкой
// бонусов живут в СРМ → /profile, поэтому ведём пользователя туда.
// ──────────────────────────────────────────────────────────────────────
const TARIFF_LABELS = {
  trial:     'Триал',
  solo:      'Соло',
  studio:    'Студия',
  cancelled: 'Отменён',
};

// Считает «осталось N дней» до access_until. Возвращает {text, expired}.
function describeAccessUntil(accessUntil) {
  if (!accessUntil) return { text: 'дата не указана', expired: false };
  const target = new Date(accessUntil);
  if (Number.isNaN(target.getTime())) return { text: 'дата не указана', expired: false };
  // floor: «осталось N дней» = ПОЛНЫХ суток до access_until. ceil показывал
  // одно и то же значение первые ~24 часа после регистрации (2.3 дня → «3»),
  // юзер обоснованно жаловался: «вчера было 3, сегодня 3 — должен идти отсчёт».
  const days = Math.floor((target.getTime() - Date.now()) / (24 * 60 * 60 * 1000));
  if (days < 0)  return { text: `доступ истёк ${Math.abs(days)} дн. назад`, expired: true };
  if (days === 0) return { text: 'истекает сегодня', expired: false };
  return { text: `осталось ${days} ${pluralizeDays(days)}`, expired: false };
}

function pluralizeDays(n) {
  const abs = Math.abs(n) % 100;
  const last = abs % 10;
  if (abs > 10 && abs < 20) return 'дней';
  if (last === 1) return 'день';
  if (last >= 2 && last <= 4) return 'дня';
  return 'дней';
}

async function handleTariffs(message) {
  const tgId = message.from?.id;
  const linked = await findLinkedUser(tgId);

  if (!linked) {
    await tg.sendMessage({
      chatId: message.chat.id, kind: 'tariffs_unlinked',
      replyMarkup: REGISTER_INLINE,
      text:
        `<b>Тарифы Детейл Про СРМ</b>\n\n` +
        `🟢 <b>Соло</b> — 4 900 ₽/мес или 49 900 ₽/год (−15%)\n` +
        `Один пользователь, всё нужное для работы в одиночку: клиенты, ` +
        `записи, документы по приёмке, заказ-наряды, финансы, аналитика.\n\n` +
        `🟠 <b>Студия</b> — 8 900 ₽/мес или 89 900 ₽/год (−16%)\n` +
        `До 3 пользователей (собственник + менеджер + мастер), роли, ` +
        `всё из «Соло» + приоритетная поддержка.\n\n` +
        `Сначала 3 дня бесплатно, без карты, без подвоха. ` +
        `Регистрируйся и приходи попробовать 👇`,
    });
    return;
  }

  // Только owner — менять тариф может только он. Остальным — сообщение покороче.
  if (linked.role !== 'owner') {
    await tg.sendMessage({
      chatId: message.chat.id, userId: linked.id, kind: 'tariffs_not_owner',
      replyMarkup: STAFF_MENU_KEYBOARD,
      text:
        `Тариф у студии один на всех, рулит им владелец. ` +
        `Если хочешь что-то изменить, скажи ему, пусть зайдёт в СРМ → Профиль.`,
    });
    return;
  }

  // Достаём бонус-баланс — упомянем в сообщении, что он применится при оплате.
  const summary = await pool.query(
    `SELECT bonus_balance_kop FROM saas_meta.studios WHERE id = $1`,
    [linked.studio_id]
  );
  const bonusKop = summary.rows[0]?.bonus_balance_kop || 0;

  const planLabel = TARIFF_LABELS[linked.plan] || linked.plan || '—';
  const access = describeAccessUntil(linked.access_until);
  const accessLine = access.expired
    ? `⚠️ <b>${access.text}</b>`
    : `Доступ: <b>${access.text}</b>`;

  let bonusLine = '';
  if (bonusKop > 0) {
    bonusLine = `\n\n💰 На бонус-балансе <b>${formatRub(bonusKop)}</b>, ` +
                `применятся к оплате автоматически.`;
  }

  // Подписанные ссылки на 4 тарифа — тап → наш сервер → 302 на Prodamus.
  // Если PRODAMUS_SECRET_KEY не задан (dev-окружение), фоллбэкаем на
  // одну кнопку «Открыть в СРМ» — там фронт сделает intent через сессию.
  const tgUserId = message.from?.id;
  const replyMarkup = buildTariffsInline(tgUserId) || TARIFFS_INLINE_FALLBACK;

  await tg.sendMessage({
    chatId: message.chat.id, userId: linked.id, kind: 'tariffs_show',
    replyMarkup,
    text:
      `<b>Твой тариф: ${tg.escapeHtml(planLabel)}</b>\n` +
      `${accessLine}\n\n` +
      `<b>Что есть в линейке:</b>\n\n` +
      `🟢 <b>Соло</b> — 4 900 ₽/мес или 49 900 ₽/год (−15%, 4 158 ₽/мес)\n` +
      `Для тех, кто крутит студию сам:\n` +
      `• 1 пользователь (только собственник)\n` +
      `• Клиенты, задачи, календарь\n` +
      `• Документы по приёмке авто\n` +
      `• Заказ-наряды\n` +
      `• Финансовый учёт и аналитика\n\n` +
      `🟠 <b>Студия</b> — 8 900 ₽/мес или 89 900 ₽/год (−16%, 7 492 ₽/мес)\n` +
      `Для команды:\n` +
      `• До 3 пользователей (собственник + менеджер + мастер)\n` +
      `• Роли «Менеджер» и «Мастер» с разными правами\n` +
      `• Всё из тарифа «Соло»\n` +
      `• Бот в Telegram: напоминания о записях и задачах каждый день\n` +
      `• Полная аналитика по продажам и клиентам\n` +
      `• Приоритетная поддержка` +
      bonusLine +
      `\n\nВыбери тариф и срок — кнопка откроет оплату через Продамус. ` +
      `Чек на email придёт автоматически.`,
  });
}

// ──────────────────────────────────────────────────────────────────────
// /help — переводит пользователя в режим «жду сообщение в поддержку».
// План A: следующее текстовое сообщение копируется админу в SUPPORT_CHAT_ID,
// админ делает Reply → ответ возвращается клиенту.
// ──────────────────────────────────────────────────────────────────────
async function handleHelp(message) {
  const chatId = message.chat.id;
  const tgId = message.from?.id;
  const linked = await findLinkedUser(tgId);

  await setState(tgId, 'awaiting_support_message');

  if (linked) {
    await tg.sendMessage({
      chatId, userId: linked.id, kind: 'help_linked',
      replyMarkup: menuFor(linked),
      text:
        `<b>Помощь по СРМ</b>\n\n` +
        `Что-то отвалилось, пришла идея или просто хочется похвалить? ` +
        `Напиши следующим сообщением прямо сюда, я перешлю в поддержку, ` +
        `а ответ прилетит обратно в этот же чат.\n\n` +
        `Скриншот тоже не помешает, приложи, если есть.`,
    });
    return;
  }

  await tg.sendMessage({
    chatId, kind: 'help_unlinked',
    replyMarkup: REGISTER_INLINE,
    text:
      `На связи Детейл 🤖\n` +
      `Твой Telegram пока не привязан к СРМ, поэтому работаю не на полную.\n\n` +
      `<b>Что можно сделать:</b>\n` +
      `• Нет аккаунта? Забирай 3 дня бесплатно: ${APP_ORIGIN}\n` +
      `• Аккаунт есть? Заходи в СРМ → Профиль → Telegram → «Подключить».\n\n` +
      `Сразу после коннекта посыплются уведомления о записях, и сброс пароля ` +
      `будет работать в один клик.\n\n` +
      `Если вопрос горящий прямо сейчас, пиши следующим сообщением, передам в поддержку.`,
  });
}

// ──────────────────────────────────────────────────────────────────────
// Поддержка: текст пришёл в режиме awaiting_support_message.
// ──────────────────────────────────────────────────────────────────────
async function handleSupportMessage(message, linked) {
  const chatId = message.chat.id;
  const tgUser = message.from || {};
  const text = (message.text || '').trim();

  if (!text || text.length < 2) {
    await tg.sendMessage({
      chatId, kind: 'support_too_short',
      text: 'Опиши проблему чуть подробнее, несколько слов хватит.',
    });
    return;
  }

  // 1. Сохраняем обращение в БД (всегда, даже если переслать некуда).
  const ins = await pool.query(
    `INSERT INTO saas_meta.support_requests
       (user_id, tg_user_id, tg_chat_id, tg_username, message)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [linked?.id || null, tgUser.id || null, chatId, tgUser.username || null, text]
  );
  const requestId = ins.rows[0].id;

  // 2. Пересылаем админу с метаданными (если SUPPORT_TG_CHAT_ID задан).
  if (SUPPORT_CHAT_ID) {
    const fromName = linked?.name || tgUser.first_name || 'Гость';
    const meta =
      `📩 <b>Обращение #${requestId}</b>\n` +
      `<b>От:</b> ${tg.escapeHtml(fromName)}` +
      (tgUser.username ? ` (@${tg.escapeHtml(tgUser.username)})` : '') + `\n` +
      (linked
        ? `<b>Студия:</b> ${tg.escapeHtml(linked.studio_name || '—')}` +
          (linked.plan ? ` (${tg.escapeHtml(linked.plan)})` : '') + `\n` +
          `<b>E-mail:</b> ${tg.escapeHtml(linked.email)}\n`
        : `<b>Аккаунт СРМ:</b> не привязан\n`) +
      `\n${tg.escapeHtml(text)}\n\n` +
      `<i>Ответьте на это сообщение через Reply, клиент получит ваш ответ в чате с ботом.</i>`;

    const fwd = await tg.sendMessage({
      chatId: SUPPORT_CHAT_ID, kind: 'support_forward',
      text: meta,
    });

    if (fwd.ok && fwd.result?.message_id) {
      await pool.query(
        `UPDATE saas_meta.support_requests
            SET forwarded_to_chat_id = $1, forwarded_message_id = $2
          WHERE id = $3`,
        [SUPPORT_CHAT_ID, fwd.result.message_id, requestId]
      );
    } else {
      console.error('[telegram] support forward failed for #' + requestId, fwd.error || fwd.skipped);
    }
  } else {
    console.warn('[telegram] SUPPORT_TG_CHAT_ID не задан — обращение #' + requestId + ' только в БД');
  }

  // 3. Сбрасываем стейт и подтверждаем клиенту.
  await clearState(tgUser.id);
  await tg.sendMessage({
    chatId, userId: linked?.id || null, kind: 'support_received',
    replyMarkup: linked ? menuFor(linked) : undefined,
    text:
      `Спасибо, передали в поддержку 🛟\n` +
      `Ответ придёт в этот чат, обычно в течение нескольких часов.`,
  });
}

// ──────────────────────────────────────────────────────────────────────
// Reply от админа (в чате SUPPORT_TG_CHAT_ID) на пересланное обращение.
// Возвращает true, если сообщение было обработано как support-reply
// (тогда дальше его не маршрутизируем как обычный текст).
// ──────────────────────────────────────────────────────────────────────
async function handleSupportReply(message) {
  if (!SUPPORT_CHAT_ID) return false;
  if (message.chat.id !== SUPPORT_CHAT_ID) return false;
  const replyTo = message.reply_to_message;
  if (!replyTo) return false;

  const r = await pool.query(
    `SELECT id, tg_chat_id, user_id FROM saas_meta.support_requests
      WHERE forwarded_to_chat_id = $1 AND forwarded_message_id = $2`,
    [message.chat.id, replyTo.message_id]
  );
  const row = r.rows[0];
  if (!row) return false; // reply на что-то постороннее в админ-чате — игнорим

  const replyText = (message.text || '').trim();
  if (!replyText) return true; // reply без текста — считаем обработанным

  await tg.sendMessage({
    chatId: row.tg_chat_id, userId: row.user_id, kind: 'support_reply',
    text:
      `📨 <b>Ответ от поддержки</b>\n\n` +
      tg.escapeHtml(replyText),
  });
  await pool.query(
    `UPDATE saas_meta.support_requests
        SET reply_text = $1, replied_at = now()
      WHERE id = $2`,
    [replyText, row.id]
  );

  // Подтверждение админу — что мы доставили ответ.
  await tg.sendMessage({
    chatId: message.chat.id, kind: 'support_reply_ack',
    text: `✅ Ответ доставлен клиенту (обращение #${row.id}).`,
  });
  return true;
}

async function handleUnknown(message) {
  return handleStart(message, '');
}

// ──────────────────────────────────────────────────────────────────────
// Маршрутизация по входящему message.
// ──────────────────────────────────────────────────────────────────────
async function dispatchMessage(message) {
  const tgUser = message.from || {};
  const text = (message.text || '').trim();

  // 1) Reply от админа в support-чате — обрабатывается отдельно (ответ клиенту).
  if (await handleSupportReply(message)) return;

  if (!text) return; // не-text игнорим

  // 2) Кнопки reply-keyboard — приходят как обычный текст с эмодзи.
  const buttonCmd = BUTTON_TO_COMMAND[text];
  if (buttonCmd) {
    await clearState(tgUser.id); // нажатие кнопки выходит из режима «помощь»
    return dispatchCommand(message, buttonCmd, '');
  }

  // 3) /command [args] — \p{L} ловит и кириллицу (/время = /time).
  //    Telegram официально принимает только латиницу, но если юзер сам
  //    наберёт «/время» в чат, мы тоже распарсим его как команду.
  const m = text.match(/^\/([\p{L}_][\p{L}\p{N}_]*)(?:@\w+)?(?:\s+(.+))?$/u);
  if (m) {
    const cmd = m[1].toLowerCase();
    const args = m[2] ? m[2].trim() : '';
    // ВАЖНО: clearState ДО проверки awaiting_daily_time — иначе текстовая
    // команда «/time» внутри ожидания HH:MM никогда не выйдет из state'а.
    await clearState(tgUser.id);
    return dispatchCommand(message, cmd, args);
  }

  // 4) Активные режимы (FSM).
  const state = await getActiveState(tgUser.id);
  if (state === 'awaiting_support_message') {
    const linked = await findLinkedUser(tgUser.id);
    return handleSupportMessage(message, linked);
  }
  if (state === 'awaiting_daily_time') {
    return handleDailyTimeInput(message, text);
  }

  // 5) Иначе — приветствие/меню.
  await handleUnknown(message);
}

async function dispatchCommand(message, cmd, args) {
  switch (cmd) {
    case 'start':    return handleStart(message, args);
    case 'unlink':   return handleUnlink(message);
    case 'help':     return handleHelp(message);
    case 'open_crm': return handleOpenCrm(message);
    case 'profile':  return handleOpenCrm(message); // alias для старых ссылок
    case 'referral': return handleReferral(message);
    case 'tariffs':  return handleTariffs(message);
    case 'balance':  return handleTariffs(message); // alias: бонусы внутри тарифов
    case 'time':                                     // официальная (латиница)
    case 'время':    return handleDailyTimeCommand(message);
    default:         return handleUnknown(message);
  }
}

// ──────────────────────────────────────────────────────────────────────
// /время — настройка времени утренней сводки. Только для owner-а.
// Просто переоткрывает inline-выбор; сама обработка callback'ов общая.
// ──────────────────────────────────────────────────────────────────────
async function handleDailyTimeCommand(message) {
  const tgId = message.from?.id;
  const linked = await findLinkedUser(tgId);
  if (!linked) {
    await tg.sendMessage({
      chatId: message.chat.id, kind: 'dailytime_unlinked',
      replyMarkup: REGISTER_INLINE,
      text:
        'Сначала привяжи аккаунт СРМ: Профиль → Telegram → «Подключить». ' +
        'После этого смогу настроить время утренней сводки.',
    });
    return;
  }
  if (linked.role !== 'owner') {
    await tg.sendMessage({
      chatId: message.chat.id, userId: linked.id, kind: 'dailytime_not_owner',
      text:
        'Время утренней сводки настраивает только владелец студии. ' +
        'Сводка приходит всем сотрудникам в одно и то же время.',
    });
    return;
  }
  // Гейтинг по тарифу: фича только на «Студия». На trial/solo команда
  // /время отвечает понятным сообщением и не открывает inline-выбор.
  if (!planHasDailySummary(linked.plan)) {
    await tg.sendMessage({
      chatId: message.chat.id, userId: linked.id, kind: 'dailytime_plan_locked',
      text:
        'Утренняя сводка приходит на тарифе «Студия». ' +
        'На текущем тарифе функция недоступна — оформить можно в Профиле СРМ.',
    });
    return;
  }
  await askDailySummaryTimeQuestion(message.chat.id, linked.id);
}

// Обработка текстового ввода в state 'awaiting_daily_time'.
// Юзер нажал «Своё время» → бот попросил ввести HH:MM → юзер пишет «8:30».
async function handleDailyTimeInput(message, text) {
  const tgId = message.from?.id;
  const linked = await findLinkedUser(tgId);
  if (!linked || linked.role !== 'owner') {
    await clearState(tgId);
    return;
  }
  // Тариф мог понизиться, пока юзер набирал время — гасим state и
  // объясняем причину, чтобы он не получал «не понял время» и не
  // путался.
  if (!planHasDailySummary(linked.plan)) {
    await clearState(tgId);
    await tg.sendMessage({
      chatId: message.chat.id, userId: linked.id, kind: 'dailytime_plan_locked',
      text:
        'Утренняя сводка приходит на тарифе «Студия». ' +
        'Оформить можно в Профиле СРМ.',
    });
    return;
  }

  const parsed = parseHHMM(text);
  if (!parsed) {
    // Не уходим из state — даём попробовать ещё раз.
    await tg.sendMessage({
      chatId: message.chat.id, userId: linked.id, kind: 'dailytime_invalid',
      text:
        'Не понял время. Напиши в формате <b>ЧЧ:ММ</b>, например <code>8:30</code> или <code>09:00</code>. ' +
        'Или нажми /время чтобы выбрать готовый вариант.',
    });
    return;
  }

  await pool.query(
    `UPDATE saas_meta.studios
        SET daily_summary_time = $1, daily_summary_time_set = TRUE
      WHERE id = $2`,
    [parsed, linked.studio_id]
  );
  await clearState(tgId);

  await tg.sendMessage({
    chatId: message.chat.id, userId: linked.id, kind: 'dailytime_set',
    text: `Готово, утренняя сводка будет приходить в <b>${tg.escapeHtml(parsed.slice(0, 5))}</b>.`,
  });
  await sendOnboardingDone(message.chat.id, linked.id, 'owner');
}

// ──────────────────────────────────────────────────────────────────────
// POST /api/telegram/webhook
// ──────────────────────────────────────────────────────────────────────
router.post('/webhook', jsonParser, async (req, res) => {
  if (!verifyTgSecret(req)) {
    return res.status(401).send('invalid secret');
  }

  // Отвечаем 200 СРАЗУ — TG не любит долгие ответы. Обработка асинхронно.
  res.status(200).send('ok');

  try {
    await dispatchUpdate(req.body || {});
  } catch (err) {
    console.error('[telegram] dispatch failed for update', req.body?.update_id, ':', err);
  }
});

// ──────────────────────────────────────────────────────────────────────
// dispatchUpdate(update) — обработка одного апдейта.
// Используется webhook-роутом и long-polling-режимом (lib/telegram_polling.cjs).
// ──────────────────────────────────────────────────────────────────────
async function dispatchUpdate(update) {
  if (!update) return;

  const updateId = Number(update.update_id);
  let firstSeen = true;
  try {
    firstSeen = await markUpdateProcessed(updateId);
  } catch (e) {
    console.error('[telegram] markUpdateProcessed failed:', e.message);
  }
  if (!firstSeen) return;

  if (update.message) {
    await dispatchMessage(update.message);
  } else if (update.callback_query) {
    await dispatchCallback(update.callback_query);
  }
}

module.exports = router;
module.exports.dispatchUpdate = dispatchUpdate;
// Используется из routes/auth.cjs после signup с tgSignupToken — чтобы
// сразу спросить пол/таймзону у новоиспечённого owner-а в TG.
module.exports.runOnboardingChecks = runOnboardingChecks;
