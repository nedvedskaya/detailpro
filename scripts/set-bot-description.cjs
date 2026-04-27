'use strict';
/**
 * Одноразовый CLI-скрипт: применяет к Telegram-боту описание (description),
 * которое показывается в карточке бота при первом открытии чата
 * («Что умеет этот бот?»).
 *
 * Зачем скрипт, а не @BotFather:
 *   - Текст хранится в коде → версионирование, ревью, история правок.
 *   - При смене копирайтинга в одно место правится здесь, прогоняем — и
 *     описание в TG обновляется.
 *
 * Запуск (на сервере, где доступен .env с TELEGRAM_BOT_TOKEN):
 *   node scripts/set-bot-description.cjs
 *
 * Или с явным токеном:
 *   TELEGRAM_BOT_TOKEN=... node scripts/set-bot-description.cjs
 *
 * Telegram API:
 *   https://core.telegram.org/bots/api#setmydescription   (≤ 512 chars)
 *   https://core.telegram.org/bots/api#setmyshortdescription (≤ 120 chars,
 *     показывается в карточке профиля бота)
 */

// dotenv не обязателен, но если запускают локально с .env — попробуем подгрузить.
try { require('dotenv').config(); } catch (_) { /* нет dotenv — ок, используем process.env */ }

const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!TG_TOKEN) {
  console.error('FATAL: TELEGRAM_BOT_TOKEN не задан');
  process.exit(1);
}

// Длинное описание («Что умеет этот бот?»).
// Без ссылки на сайт по запросу пользователя.
// Тире не используем (стилистические — против правила, грамматических нет).
const DESCRIPTION =
  'Детейл Про СРМ. Облачная программа для студий детейлинга: ' +
  'клиенты, записи, приёмка авто, заказ-наряды, финансы. ' +
  '3 дня бесплатно, без карты.';

// Короткое описание (показывается в карточке профиля бота).
const SHORT_DESCRIPTION =
  'Бот Детейл Про СРМ: напоминания о записях, приёмка авто, заказ-наряды.';

async function callTg(method, body) {
  const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const j = await r.json();
  if (!j.ok) {
    throw new Error(`${method}: ${j.error_code} ${j.description || 'unknown error'}`);
  }
  return j;
}

(async () => {
  // Сначала валидируем длину, чтобы не получить 400 от TG.
  if (DESCRIPTION.length > 512) {
    console.error(`FATAL: description слишком длинное (${DESCRIPTION.length} > 512)`);
    process.exit(1);
  }
  if (SHORT_DESCRIPTION.length > 120) {
    console.error(`FATAL: short_description слишком длинное (${SHORT_DESCRIPTION.length} > 120)`);
    process.exit(1);
  }

  console.log('[bot-description] устанавливаю description (' + DESCRIPTION.length + ' chars)...');
  await callTg('setMyDescription', { description: DESCRIPTION });
  console.log('[bot-description] ✓ description применено');

  console.log('[bot-description] устанавливаю short_description (' + SHORT_DESCRIPTION.length + ' chars)...');
  await callTg('setMyShortDescription', { short_description: SHORT_DESCRIPTION });
  console.log('[bot-description] ✓ short_description применено');

  // Прочитаем обратно для контроля.
  const back = await callTg('getMyDescription', {});
  const backShort = await callTg('getMyShortDescription', {});
  console.log('---');
  console.log('description:       ', JSON.stringify(back.result.description));
  console.log('short_description: ', JSON.stringify(backShort.result.short_description));
})().catch((err) => {
  console.error('[bot-description] FAIL:', err.message);
  process.exit(1);
});
