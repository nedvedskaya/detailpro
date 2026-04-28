'use strict';
/**
 * Одноразовый CLI-скрипт: применяет к Telegram-боту меню команд
 * (то, что показывается по нажатию «Меню» / «/» в чате с ботом).
 *
 * Зачем скрипт, а не @BotFather:
 *   - Текст хранится в коде → версионирование, ревью, история правок.
 *   - У нас два scope'а: default (для всех юзеров) и отдельный для
 *     админа (Оли) с дополнительными админ-командами. BotFather
 *     с такой задачей не справится в один клик.
 *
 * Запуск (на сервере, где доступен .env с TELEGRAM_BOT_TOKEN):
 *   node scripts/set-bot-commands.cjs
 *
 * Telegram API:
 *   https://core.telegram.org/bots/api#setmycommands
 *   • Имена команд — ТОЛЬКО латиница [a-z0-9_], 1–32 символа.
 *     Поэтому в меню /time / /admin / /registrations / /payments
 *     (а не /время / /админ / …). В коде боте dispatchCommand
 *     ловит и латиницу, и кириллицу — юзер может писать как угодно.
 *   • Description — до 256 символов. Кириллица допустима.
 */

try { require('dotenv').config(); } catch (_) { /* */ }

// Используем существующий tg-клиент (server/lib/telegram.cjs):
// он умеет ходить через known-good IPv4 api.telegram.org с правильным
// SNI и Host-заголовком. Без него generic fetch к api.telegram.org
// с нашего VPS таймаутит — DNS не всегда резолвит хост, MTU 1400 даёт
// фрагментацию TLS handshake.
const tg = require('../server/lib/telegram.cjs');
if (!tg.isConfigured()) {
  console.error('FATAL: TELEGRAM_BOT_TOKEN не задан');
  process.exit(1);
}

// Tg-id Оли — единственный «админ» этого SaaS. Должен совпадать с
// ADMIN_TG_USER_ID в server/routes/telegram.cjs (там константа
// захардкожена). Если когда-то их будет несколько — переходим на
// массив и циклом setMyCommands для каждого chat.
const ADMIN_TG_USER_ID = 472538427;

// Список команд для всех юзеров. Порядок в массиве = порядок в меню TG.
// /referral и /tariffs — рабочие команды, не «(скоро)»: реферальная
// программа задеплоена, бонусы работают, после ответа Prodamus заработает
// и автоприменение скидки.
const PUBLIC_COMMANDS = [
  { command: 'start',    description: 'Главное меню' },
  { command: 'open_crm', description: 'Открыть СРМ в браузере' },
  { command: 'referral', description: 'Реферальная ссылка и бонусы' },
  { command: 'tariffs',  description: 'Тарифы и оплата подписки' },
  { command: 'time',     description: 'Время утренней сводки (для owner Студии)' },
  { command: 'help',     description: 'Список команд' },
  { command: 'unlink',   description: 'Отвязать Telegram от СРМ' },
];

// Дополнительные команды только для админа (Оли).
// Должны идти СВЕРХУ списка, чтобы было удобно — самое нужное
// первым в выдаче меню Telegram.
const ADMIN_EXTRA_COMMANDS = [
  { command: 'admin',         description: '📊 Админ-панель: обзор по студиям' },
  { command: 'registrations', description: 'Последние 20 регистраций' },
  { command: 'payments',      description: 'Последние 20 платежей' },
];

// Тонкая обёртка — дублирует имя функции, но через готовый клиент
// (с retry на known-good IPv4 и правильным SNI).
async function tgRequest(method, body) {
  return await tg.call(method, body);
}

async function main() {
  console.log('1. Удаляю старое default-меню (на случай если в нём были устаревшие команды)…');
  await tgRequest('deleteMyCommands', { scope: { type: 'default' } });

  console.log('2. Устанавливаю default-меню (для всех юзеров):');
  for (const c of PUBLIC_COMMANDS) console.log(`   /${c.command} — ${c.description}`);
  await tgRequest('setMyCommands', {
    commands: PUBLIC_COMMANDS,
    scope: { type: 'default' },
  });

  console.log(`3. Устанавливаю расширенное меню для админа (chat ${ADMIN_TG_USER_ID}):`);
  const adminCommands = [...ADMIN_EXTRA_COMMANDS, ...PUBLIC_COMMANDS];
  for (const c of adminCommands) console.log(`   /${c.command} — ${c.description}`);
  await tgRequest('setMyCommands', {
    commands: adminCommands,
    scope: { type: 'chat', chat_id: ADMIN_TG_USER_ID },
  });

  console.log('\nГотово. В Telegram меню обновится в течение пары минут.');
}

main().catch((err) => {
  console.error('FAIL:', err.message);
  process.exit(1);
});
