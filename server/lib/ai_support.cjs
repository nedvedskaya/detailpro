'use strict';
/**
 * AI-мозг Telegram-бота: поддержка (care) и продажи (sales).
 *
 * Архитектура:
 *   - Знания AI хранятся в MD-файлах в server/lib/ai_brain/
 *   - При первом обращении файлы читаются с диска и кэшируются в памяти
 *   - System prompt собирается из MD-файлов в зависимости от режима
 *   - Запросы к OpenAI идут через VPN-прокси (OPENAI_PROXY_URL),
 *     потому что OpenAI блокирует RU IP
 *
 * Режимы:
 *   - sales — общение с НЕзарегистрированным пользователем
 *             (продажи, воронка, отработка возражений)
 *   - care  — общение с действующим клиентом CRM
 *             (отдел заботы, помощь по продукту)
 *
 * Таблицы:
 *   saas_meta.ai_conversations — треды разговора
 *   saas_meta.ai_messages      — история сообщений
 *   saas_meta.ai_faq           — структурированный FAQ (используется
 *                                как доп. контекст к системному промпту)
 */

const fs   = require('node:fs');
const path = require('node:path');
const { pool } = require('./db.cjs');

const MAX_HISTORY = 20;
const BRAIN_DIR   = path.join(__dirname, 'ai_brain');

// ──────────────────────────────────────────────────────────────────────
// Кэш MD-файлов мозга. Читаем один раз при первом запросе, потом из RAM.
// При изменении MD на сервере нужен рестарт сервиса (или ручной кэш-клир).
// ──────────────────────────────────────────────────────────────────────
const _brainCache = {};
function readBrainFile(name) {
  if (_brainCache[name]) return _brainCache[name];
  const filePath = path.join(BRAIN_DIR, `${name}.md`);
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    _brainCache[name] = content;
    return content;
  } catch (err) {
    console.warn(`[ai_support] failed to read brain file ${name}.md:`, err.message);
    _brainCache[name] = '';
    return '';
  }
}

function clearBrainCache() {
  for (const k of Object.keys(_brainCache)) delete _brainCache[k];
}

// ──────────────────────────────────────────────────────────────────────
// OpenAI клиент с VPN-прокси (lazy init).
// ──────────────────────────────────────────────────────────────────────
let _client = null;
function getClient() {
  if (_client) return _client;
  const { OpenAI } = require('openai'); // throws если пакет не установлен
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY is not set');

  // Прокси нужен потому что OpenAI блокирует Россию (geo-block).
  // Локально на сервере поднят Xray (VLESS Reality) → http://127.0.0.1:10809
  const proxyUrl = process.env.OPENAI_PROXY_URL;
  let httpAgent;
  if (proxyUrl) {
    try {
      const { HttpsProxyAgent } = require('https-proxy-agent');
      httpAgent = new HttpsProxyAgent(proxyUrl);
    } catch (err) {
      console.warn('[ai_support] https-proxy-agent not installed:', err.message);
    }
  }

  _client = new OpenAI({ apiKey, httpAgent });
  return _client;
}

// ──────────────────────────────────────────────────────────────────────
// buildStudioContext — данные действующей студии для режима care.
// ──────────────────────────────────────────────────────────────────────
async function buildStudioContext(studioId) {
  if (!studioId) return null;
  try {
    const r = await pool.query(
      `SELECT s.display_name, s.plan, s.created_at, s.access_until,
              s.schema_name, s.extra_users_count
         FROM saas_meta.studios s
        WHERE s.id = $1`,
      [studioId]
    );
    if (!r.rows[0]) return null;
    const row = r.rows[0];

    // Метрики из схемы студии (могут не существовать у только что созданной).
    let clientsCount = 0;
    let recordsCount = 0;
    if (row.schema_name) {
      try {
        const [cl, rc] = await Promise.all([
          pool.query(`SELECT count(*)::int AS n FROM "${row.schema_name}".clients`),
          pool.query(`SELECT count(*)::int AS n FROM "${row.schema_name}".client_records`),
        ]);
        clientsCount = cl.rows[0]?.n || 0;
        recordsCount = rc.rows[0]?.n || 0;
      } catch (_) { /* схема ещё не создана */ }
    }

    const daysActive = Math.max(
      0,
      Math.floor((Date.now() - new Date(row.created_at).getTime()) / 86400000)
    );

    return {
      name:         row.display_name || 'Студия',
      plan:         row.plan         || 'trial',
      daysActive,
      clientsCount,
      recordsCount,
      accessUntil:  row.access_until,
    };
  } catch (err) {
    console.error('[ai_support] buildStudioContext error:', err.message);
    return null;
  }
}

// ──────────────────────────────────────────────────────────────────────
// searchFaq — поиск релевантных записей в saas_meta.ai_faq (PG ILIKE).
// Используется как дополнение к FAQ.md из мозга.
// ──────────────────────────────────────────────────────────────────────
async function searchFaq(text) {
  if (!text || text.length < 3) return [];
  try {
    const words = text
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 3)
      .slice(0, 5);
    if (!words.length) return [];

    const conditions = words.map((_, i) => `(question ILIKE $${i + 1} OR answer ILIKE $${i + 1})`);
    const params = words.map((w) => `%${w.replace(/%/g, '\\%').replace(/_/g, '\\_')}%`);

    const r = await pool.query(
      `SELECT question, answer
         FROM saas_meta.ai_faq
        WHERE is_active = TRUE
          AND (${conditions.join(' OR ')})
        LIMIT 3`,
      params
    );
    return r.rows;
  } catch (err) {
    console.error('[ai_support] searchFaq error:', err.message);
    return [];
  }
}

// ──────────────────────────────────────────────────────────────────────
// buildSystemPrompt — собирает системный промпт из MD-файлов мозга.
//
// Какие файлы куда:
//   sales: AGENTS, IDENTITY, SOUL, PRODUCT, TOOLS, FAQ, KEYSY, VORONKA, VOZRAZHENIYA, DOZHIM, PAMYAT
//   care:  AGENTS, IDENTITY, SOUL, PRODUCT, TOOLS, FAQ, CARE, PAMYAT
// ──────────────────────────────────────────────────────────────────────
function buildSystemPrompt(mode, studioContext, dbFaqItems) {
  const isCare = mode !== 'sales'; // по умолчанию care, sales только если явно

  // Порядок ВАЖЕН: SOUL и SAMPLES идут первыми, чтобы тон был приоритетом.
  // AGENTS (правила) — после, чтобы не задавил голос инструкциями.
  const brainModules = isCare
    ? ['SOUL', 'SAMPLES', 'IDENTITY', 'CARE', 'PRODUCT', 'TOOLS', 'FAQ', 'AGENTS', 'PAMYAT']
    : ['SOUL', 'SAMPLES', 'IDENTITY', 'VORONKA', 'VOZRAZHENIYA', 'DOZHIM',
       'PRODUCT', 'TOOLS', 'FAQ', 'KEYSY', 'AGENTS', 'PAMYAT'];

  const brainContent = brainModules
    .map((m) => readBrainFile(m))
    .filter(Boolean)
    .join('\n\n---\n\n');

  // Контекст студии (только в режиме care)
  const ctxBlock = (isCare && studioContext)
    ? [
        '',
        '## ТЕКУЩИЙ КОНТЕКСТ СТУДИИ',
        `- Название: ${studioContext.name}`,
        `- Тариф: ${studioContext.plan}`,
        `- Дней с регистрации: ${studioContext.daysActive}`,
        `- Клиентов в базе: ${studioContext.clientsCount}`,
        `- Записей сделано: ${studioContext.recordsCount}`,
        '',
      ].join('\n')
    : '';

  // Дополнительные FAQ из БД (ИЗ saas_meta.ai_faq, не путать с FAQ.md)
  const dbFaqBlock = dbFaqItems.length
    ? [
        '',
        '## РЕЛЕВАНТНЫЕ ЗАПИСИ ИЗ FAQ-БАЗЫ',
        ...dbFaqItems.map((f, i) => `${i + 1}. В: ${f.question}\n   О: ${f.answer}`),
        '',
      ].join('\n')
    : '';

  // Финальный промпт: режим + контекст + знания + динамические FAQ
  const modeHeader = isCare
    ? `# РЕЖИМ: CARE (отдел заботы — действующий клиент CRM)`
    : `# РЕЖИМ: SALES (продажа — новый пользователь, не зарегистрирован)`;

  return [
    modeHeader,
    ctxBlock,
    brainContent,
    dbFaqBlock,
    '',
    '## ФИНАЛЬНОЕ НАПОМИНАНИЕ — проверь перед каждым ответом',
    '',
    'СТИЛЬ:',
    '- Ты — живой человек Детейл, а не AI. Никаких пресс-релизов и канцелярита.',
    '- Начинай ответ с эмпатии или живого слова: «Слушай», «Окей», «Понимаю», «Класс», «Так», «Ага», «О, эта тема знакома».',
    '- Конкретные образы вместо общих фраз («чтобы мастера не путали кто куда едет» вместо «общий календарь для координации»).',
    '- 1-2 эмодзи в каждом сообщении. Удачные: 🙂 🤝 👌 🙌 😉 📊 🚗 💡. Не «спам»: 🚀 🔥 ⭐.',
    '- Только «ты», никогда «вы», «вам», «ваш».',
    '',
    'ФОРМАТИРОВАНИЕ — КРИТИЧНО:',
    '- НИКАКОГО markdown. Никаких `**жирный**`, `*курсив*`, `_подчёркивание_`, `# заголовков`.',
    '- НИКАКОГО HTML. Никаких <b>, <i>, <br>.',
    '- Только обычный текст. При перечислении 3+ пунктов — буллит «•» (не дефис, не звёздочка).',
    '- Звёздочки в Telegram отображаются буквально и выглядят как мусор.',
    '',
    'СОДЕРЖАНИЕ:',
    '- Один вопрос за сообщение, не больше.',
    '- Запрещены слова: «Отлично!» в начале, «рассчитан на», «в этом тарифе есть», «обратите внимание», «рекомендую».',
    '- Если факта нет в PRODUCT.md — НЕ ВЫДУМЫВАЙ. Пиши ESCALATE на отдельной строке.',
    '- Если клиент просит человека — пиши ESCALATE на отдельной строке.',
    '',
    'Перед отправкой мысленно посмотри в SAMPLES.md — твой ответ ПОХОЖ по тону на эталоны? Если нет — переписывай.',
  ].join('\n');
}

// ──────────────────────────────────────────────────────────────────────
// История сообщений из БД.
// ──────────────────────────────────────────────────────────────────────
async function getConversationHistory(conversationId) {
  const r = await pool.query(
    `SELECT role, content
       FROM saas_meta.ai_messages
      WHERE conversation_id = $1
      ORDER BY created_at ASC
      LIMIT $2`,
    [conversationId, MAX_HISTORY]
  );
  return r.rows;
}

async function appendMessage(conversationId, role, content, tokensUsed = null) {
  await pool.query(
    `INSERT INTO saas_meta.ai_messages (conversation_id, role, content, tokens_used)
     VALUES ($1, $2, $3, $4)`,
    [conversationId, role, content || '', tokensUsed]
  );
}

// ──────────────────────────────────────────────────────────────────────
// detectEscalation — нужно ли передать живому человеку?
// ──────────────────────────────────────────────────────────────────────
function detectEscalation(aiReply, userText) {
  // AI сам сказал ESCALATE
  if (/ESCALATE/i.test(aiReply || '')) return true;

  // Пользователь явно просит человека
  const triggers = [
    'живого человека', 'живой человек', 'настоящего человека',
    'реального человека', 'оператора', 'с оператором',
    'с человеком', 'хочу человека', 'нужен человек',
    'переключи на', 'позови человека', 'поговорить с человеком',
    'не помогает', 'ничего не понимаешь', 'не понимаешь меня',
  ];
  const lower = (userText || '').toLowerCase();
  return triggers.some((t) => lower.includes(t));
}

// ──────────────────────────────────────────────────────────────────────
// generateReply — основной вызов OpenAI.
// Returns: { reply: string, shouldEscalate: boolean, tokensUsed: number|null }
// ──────────────────────────────────────────────────────────────────────
async function generateReply({ conversationId, userText, mode, studioContext }) {
  const client = getClient();

  const [history, dbFaqItems] = await Promise.all([
    getConversationHistory(conversationId),
    searchFaq(userText),
  ]);

  const systemPrompt = buildSystemPrompt(mode, studioContext, dbFaqItems);

  const messages = [
    { role: 'system', content: systemPrompt },
    ...history.map((m) => ({ role: m.role, content: m.content })),
    { role: 'user', content: userText },
  ];

  const completion = await client.chat.completions.create({
    model:       'gpt-4o-mini',
    messages,
    // 0.75 для большей вариативности и «живости» — слишком низкая температура
    // делает ответы шаблонными и сухими, как пресс-релиз.
    temperature: 0.75,
    max_tokens:  700,
    // Снижаем повторы шаблонных фраз («Отлично!», «В твоём случае подойдёт»).
    frequency_penalty: 0.3,
    presence_penalty:  0.2,
  });

  const raw        = (completion.choices[0]?.message?.content || '').trim();
  const tokensUsed = completion.usage?.total_tokens || null;

  const shouldEscalate = detectEscalation(raw, userText);

  // Убираем служебное слово ESCALATE из видимого текста
  let reply = raw.replace(/^\s*ESCALATE\s*$/gm, '').trim();

  // Подчищаем markdown, если модель сорвалась — в Telegram звёздочки и
  // подчёркивания отображаются буквально и выглядят как мусор.
  reply = stripMarkdown(reply);

  return { reply, shouldEscalate, tokensUsed };
}

// ──────────────────────────────────────────────────────────────────────
// sanitizeReply — снимает markdown, длинные тире и лишние «!», которые
// палят бота. Применяется как защита, если модель сорвалась несмотря на
// промпт.
// ──────────────────────────────────────────────────────────────────────
function stripMarkdown(text) {
  if (!text) return '';
  let t = text
    // **жирный** → жирный
    .replace(/\*\*([^*\n]+)\*\*/g, '$1')
    // __жирный__ → жирный
    .replace(/__([^_\n]+)__/g, '$1')
    // *курсив* / _курсив_ — только если окружено пробелами
    .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s.,!?)]|$)/g, '$1$2')
    .replace(/(^|[\s(])_([^_\n]+)_(?=[\s.,!?)]|$)/g, '$1$2')
    // ### заголовки → обычный текст
    .replace(/^#{1,6}\s+/gm, '')
    // > цитаты → убираем маркер
    .replace(/^>\s+/gm, '')
    // [ссылка](url) → ссылка url
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)');

  // Длинные тире (—) — главный AI-маркер. Заменяем на запятую с пробелом.
  // Сохраняем только в диапазонах между цифрами (но там обычно дефис).
  // « — » → «, », «—» в начале строки → удаляем
  t = t
    .replace(/\s+—\s+/g, ', ')   // «слово — слово» → «слово, слово»
    .replace(/^—\s*/gm, '')       // «— что-то» в начале строки → «что-то»
    .replace(/—/g, '-');          // оставшиеся одиночные — на дефис

  // То же для «–» (n-dash, GPT иногда использует тоже)
  t = t
    .replace(/\s+–\s+/g, ', ')
    .replace(/^–\s*/gm, '')
    .replace(/–/g, '-');

  // Множественные «!!!» → одиночный «.»
  t = t.replace(/!{2,}/g, '.');

  // Чистим возможные двойные запятые от замен
  t = t.replace(/,\s*,/g, ',');

  return t;
}

// ──────────────────────────────────────────────────────────────────────
module.exports = {
  buildStudioContext,
  searchFaq,
  generateReply,
  appendMessage,
  getConversationHistory,
  // Экспорт для возможного hot-reload в админке (не используется сейчас)
  clearBrainCache,
};
