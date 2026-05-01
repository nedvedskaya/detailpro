'use strict';

/**
 * funnel_dispatcher.cjs — cron-функция воронки прогрева.
 *
 * Запускается раз в час. Для каждой студии решает:
 *   1) В какой сегмент попадает (s1 — никогда не платил, s2 — платил, истёк).
 *   2) Сколько дней с момента истечения access_until (для s1 это конец trial,
 *      для s2 — конец последней оплаченной подписки).
 *   3) Подходит ли точка по timing (T+1, +5, +14, +24, +29).
 *   4) Сейчас ли локально 11:00 у студии (одно окно ±60 мин в сутки).
 *   5) Не отправляли ли уже это конкретное событие (UNIQUE funnel_events).
 *   6) Не оплатил ли пользователь свежий тариф (access_until > now()).
 *   7) Не заблокирован ли бот (users.tg_blocked_at IS NULL) и есть ли chat_id.
 *
 * Если все условия true — формируем сообщение через funnel_messages,
 * прогоняем через applyGender, отправляем через tg.sendMessage с
 * reply_markup = inline_keyboard, пишем строку в funnel_events.
 *
 * Идемпотентность: UNIQUE (studio_id, event_kind) на funnel_events.
 * Race-protection: ON CONFLICT DO NOTHING делает повторную отправку
 * безопасной (даже если cron-тики наложатся).
 */

const { pool } = require('./db.cjs');
const tg = require('./telegram.cjs');
const { applyGender } = require('./gender.cjs');
const { S1, S1_PRE, S2, S2_PRE } = require('./funnel_messages.cjs');

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

// Тайминги в днях после истечения access_until → event_kind.
const SCHEDULE = {
  s1: [
    { days: 0,  kind: 's1.day0' },
    { days: 1,  kind: 's1.day1' },
    { days: 5,  kind: 's1.day5_pain' },
    { days: 14, kind: 's1.day14_freedom' },
    { days: 24, kind: 's1.day24_fomo' },
    { days: 29, kind: 's1.day29_final' },
  ],
  s2: [
    { days: 0,  kind: 's2.day0' },
    { days: 1,  kind: 's2.day1_care' },
    { days: 5,  kind: 's2.day5_habit' },
    { days: 14, kind: 's2.day14_referral' },
    { days: 24, kind: 's2.day24_fomo' },
    { days: 29, kind: 's2.day29_final' },
  ],
};

const RENDERERS = {
  's1.trial_last_day':            (ctx) => S1_PRE['trial_last_day'](ctx),
  's2.sub_last_day_no_recurrent': (ctx) => S2_PRE['sub_last_day_no_recurrent'](ctx),
  's1.day0':            (ctx) => S1['day0'](ctx),
  's1.day1':            (ctx) => S1['day1'](ctx),
  's1.day5_pain':       (ctx) => S1['day5_pain'](ctx),
  's1.day14_freedom':   (ctx) => S1['day14_freedom'](ctx),
  's1.day24_fomo':      (ctx) => S1['day24_fomo'](ctx),
  's1.day29_final':     (ctx) => S1['day29_final'](ctx),
  's2.day0':            (ctx) => S2['day0'](ctx),
  's2.day1_care':       (ctx) => S2['day1_care'](ctx),
  's2.day5_habit':      (ctx) => S2['day5_habit'](ctx),
  's2.day14_referral':  (ctx) => S2['day14_referral'](ctx),
  's2.day24_fomo':      (ctx) => S2['day24_fomo'](ctx),
  's2.day29_final':     (ctx) => S2['day29_final'](ctx),
};

function localHour(now, tz) {
  try {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hour: 'numeric', hour12: false,
    });
    return Number(fmt.format(now));
  } catch (_) {
    return Number(new Intl.DateTimeFormat('en-US', {
      timeZone: 'Europe/Moscow', hour: 'numeric', hour12: false,
    }).format(now));
  }
}

/**
 * Окно отправки: 11:00–11:59 локального времени студии. Один час в сутки.
 * Cron-тик каждые 60 минут — попадаем в это окно ровно один раз в день
 * для каждой студии.
 */
function isInSendingWindow(now, tz) {
  return localHour(now, tz) === 11;
}

/**
 * Кандидаты на воронку: студии с истёкшим access_until, не помеченные
 * на удаление, владелец привязан к TG и не блокировал бота.
 *
 * deletion_requested_at IS NULL — если юзер сам нажал «Удалить аккаунт»,
 * никакие воронки не нужны.
 */
async function findCandidates() {
  const r = await pool.query(`
    SELECT s.id, s.schema_name, s.display_name, s.access_until,
           s.first_paid_at, s.referral_code, s.deletion_requested_at,
           s.cancel_pending, s.prodamus_subscription_id,
           u.id           AS user_id,
           u.tg_chat_id,
           u.gender,
           u.first_name,
           u.tg_blocked_at,
           COALESCE(s.timezone, 'Europe/Moscow') AS tz
      FROM saas_meta.studios s
      LEFT JOIN saas_meta.users u
             ON u.studio_id = s.id AND u.role = 'owner'
     WHERE s.access_until IS NOT NULL
       AND (
         -- POST-EXPIRY: подписка истекла, идёт основная воронка (T+1..+29).
         (s.access_until < now() AND (now() - s.access_until) < interval '31 days')
         -- PRE-EXPIRY: подписка/trial вот-вот закончится (последние 24 часа).
         -- Шлём двум сегментам:
         --   • Не платил (first_paid_at IS NULL) → пишем «trial last day»
         --   • Платил, но БЕЗ recurring (prodamus_subscription_id IS NULL)
         --     → пишем «продли вручную, автосписания нет»
         -- Если есть subscription_id — Prodamus спишет сам, не пишем
         -- (по решению владельца: «не уведомлять о автоплатежах»).
         OR (s.access_until > now()
             AND s.access_until < now() + interval '24 hours'
             AND (s.first_paid_at IS NULL OR s.prodamus_subscription_id IS NULL))
       )
       AND s.deletion_requested_at IS NULL
       AND u.tg_chat_id IS NOT NULL
       AND u.tg_blocked_at IS NULL
  `);
  return r.rows;
}

/**
 * Какой event_kind должен сработать для этой студии прямо сейчас?
 * Возвращаем kind или null если никакая точка не подходит.
 */
function pickEventKind(studio) {
  const accessMs = new Date(studio.access_until).getTime();
  const nowMs = Date.now();

  // PRE-EXPIRY: подписка ещё активна, но истечёт в ближайшие 24 часа.
  if (accessMs > nowMs) {
    const hoursUntilExpiry = (accessMs - nowMs) / (60 * 60 * 1000);
    if (hoursUntilExpiry <= 0 || hoursUntilExpiry > 24) return null;

    if (!studio.first_paid_at) {
      // Не платил — заканчивается trial.
      return 's1.trial_last_day';
    }
    // Платил. Если есть recurring (prodamus_subscription_id) — НЕ пингуем,
    // Prodamus сам спишет, юзер про это не должен думать.
    if (!studio.prodamus_subscription_id) {
      return 's2.sub_last_day_no_recurrent';
    }
    return null;
  }

  // POST-EXPIRY: основная воронка по дням после истечения.
  const segment = studio.first_paid_at ? 's2' : 's1';
  const daysSinceExpiry = Math.floor((nowMs - accessMs) / ONE_DAY_MS);
  const schedule = SCHEDULE[segment];
  // Сравниваем с допуском ±0 — мы и так шлём только в часовое окно 11:00.
  // Если cron упал на сутки и пропустил T+5 — в T+6 уже не догоняем
  // (лучше пропустить, чем выдать сразу два сообщения подряд).
  for (const point of schedule) {
    if (point.days === daysSinceExpiry) return point.kind;
  }
  return null;
}

/**
 * Отправка одного сообщения. INSERT в funnel_events ДО tg-запроса —
 * UNIQUE-индекс защитит от дублей при race condition между тиками.
 * Если INSERT упал на конфликт (rowCount=0) — кто-то уже отправил, выходим.
 *
 * При успехе сообщение уходит. Если отправка упала (например бот заблочен) —
 * откатываем INSERT (DELETE) — иначе следующий тик опять попадёт под
 * UNIQUE и не повторит, а нужного сообщения у юзера не будет. Также
 * помечаем tg_blocked_at у юзера, чтобы больше его не трогать.
 */
async function sendOne({ studio, kind, dryRun }) {
  const ctx = {
    name: studio.first_name || studio.display_name || null,
    referralCode: studio.referral_code || null,
  };
  const renderer = RENDERERS[kind];
  if (!renderer) {
    console.warn('[funnel] no renderer for', kind);
    return { sent: false };
  }
  const msg = renderer(ctx);
  const text = applyGender(msg.text, studio.gender);
  // Кнопки тоже могут содержать гендерные маркеры (например в Дне 1).
  const inline = (msg.inline_keyboard || null) && msg.inline_keyboard.map(row =>
    row.map(btn => ({ ...btn, text: applyGender(btn.text, studio.gender) }))
  );

  if (dryRun) {
    console.log(`[funnel] DRY-RUN ${kind} → ${studio.schema_name}`, { len: text.length, btns: inline?.length });
    return { sent: false, dryRun: true };
  }

  // Резервируем event_kind через INSERT — UNIQUE защитит от дублей.
  const ins = await pool.query(
    `INSERT INTO saas_meta.funnel_events (studio_id, user_id, event_kind)
     VALUES ($1, $2, $3)
     ON CONFLICT (studio_id, event_kind) DO NOTHING
     RETURNING id`,
    [studio.id, studio.user_id, kind]
  );
  if (ins.rowCount === 0) {
    return { sent: false, reason: 'already_sent' };
  }

  try {
    await tg.sendMessage({
      chatId: studio.tg_chat_id,
      userId: studio.user_id,
      kind: `funnel.${kind}`,
      text,
      parseMode: 'HTML',
      replyMarkup: inline ? { inline_keyboard: inline } : undefined,
    });
    return { sent: true };
  } catch (err) {
    // 403 Forbidden = пользователь заблокировал бота. Помечаем чтобы
    // не дёргать его в следующих тиках.
    const is403 = /403|forbidden|blocked/i.test(err.message || '');
    if (is403) {
      await pool.query(
        `UPDATE saas_meta.users SET tg_blocked_at = now() WHERE id = $1 AND tg_blocked_at IS NULL`,
        [studio.user_id]
      ).catch(() => {});
      console.warn(`[funnel] tg blocked by user ${studio.user_id}, future messages suppressed`);
    } else {
      console.error('[funnel] tg.sendMessage failed:', err.message);
    }
    // Откатываем резервацию — если ошибка временная, следующий тик повторит.
    // При is403 это не имеет значения (всё равно не пошлём из-за tg_blocked_at).
    await pool.query(
      `DELETE FROM saas_meta.funnel_events WHERE id = $1`, [ins.rows[0].id]
    ).catch(() => {});
    return { sent: false, reason: is403 ? 'tg_blocked' : 'send_failed' };
  }
}

async function runFunnel(opts = {}) {
  const dryRun = opts.dryRun === true;
  const now = opts.now || new Date();
  const startedAt = Date.now();
  const stats = { checked: 0, sent: 0, skipped: 0, errors: 0 };

  let candidates;
  try {
    candidates = await findCandidates();
  } catch (err) {
    console.error('[funnel] findCandidates failed:', err.message);
    return { ...stats, fatal: err.message };
  }

  for (const studio of candidates) {
    stats.checked++;
    try {
      // Окно отправки — 11:00 локалки. dryRun и forceWindow игнорируют окно
      // (forceWindow используется для симуляций/QA).
      const kind = pickEventKind(studio);
      const isDay0 = kind && (kind.endsWith('.day0'));
      if (!dryRun && !opts.forceWindow && !isDay0 && !isInSendingWindow(now, studio.tz)) {
        stats.skipped++;
        continue;
      }
      if (!kind) {
        stats.skipped++;
        continue;
      }
      const out = await sendOne({ studio, kind, dryRun });
      if (out.sent) stats.sent++;
      else stats.skipped++;
    } catch (err) {
      stats.errors++;
      console.error(`[funnel] studio ${studio.id} failed:`, err.message);
    }
  }

  console.log(`[funnel] runFunnel: checked=${stats.checked} sent=${stats.sent} skipped=${stats.skipped} errors=${stats.errors} in ${Date.now() - startedAt}ms`);
  return stats;
}

module.exports = { runFunnel, pickEventKind, isInSendingWindow };
