-- 020_ai_support.sql
--
-- Таблицы для AI-мозга Telegram-бота.
--
--   1. ai_conversations — треды AI-диалогов (support + sales режимы).
--   2. ai_messages      — история сообщений каждого треда.
--   3. ai_faq           — база знаний / FAQ (наполняется вручную).
--
-- Связи:
--   ai_conversations.support_request_id → saas_meta.support_requests(id)
--   ai_messages.conversation_id         → saas_meta.ai_conversations(id)
--
-- Идемпотентно — IF NOT EXISTS.

-- ── 1. Треды AI-диалогов ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS saas_meta.ai_conversations (
  id                 BIGSERIAL PRIMARY KEY,
  tg_user_id         BIGINT NOT NULL,
  tg_chat_id         BIGINT NOT NULL,
  user_id            UUID REFERENCES saas_meta.users(id)   ON DELETE SET NULL,
  studio_id          UUID REFERENCES saas_meta.studios(id) ON DELETE SET NULL,
  -- Режим: 'support' — клиент CRM, 'sales' — незарегистрированный.
  mode               VARCHAR(10) NOT NULL DEFAULT 'support',
  -- Статус: 'active' | 'resolved' | 'escalated'.
  status             VARCHAR(12) NOT NULL DEFAULT 'active',
  -- Кто ответил в итоге: 'ai' | 'human' | NULL (незакрыт).
  answered_by        VARCHAR(10),
  -- Ссылка на первичное обращение в support_requests (сохраняется всегда).
  support_request_id BIGINT REFERENCES saas_meta.support_requests(id) ON DELETE SET NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at          TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_ai_conv_tg_user
  ON saas_meta.ai_conversations (tg_user_id, status);

CREATE INDEX IF NOT EXISTS idx_ai_conv_studio
  ON saas_meta.ai_conversations (studio_id, created_at DESC)
  WHERE studio_id IS NOT NULL;

-- ── 2. История сообщений тредов ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS saas_meta.ai_messages (
  id              BIGSERIAL PRIMARY KEY,
  conversation_id BIGINT NOT NULL REFERENCES saas_meta.ai_conversations(id) ON DELETE CASCADE,
  -- 'user' | 'assistant'
  role            VARCHAR(10) NOT NULL,
  content         TEXT NOT NULL,
  -- Количество токенов (только для assistant-сообщений, остальное NULL).
  tokens_used     INT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ai_messages_conv
  ON saas_meta.ai_messages (conversation_id, created_at ASC);

-- ── 3. FAQ / База знаний ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS saas_meta.ai_faq (
  id          BIGSERIAL PRIMARY KEY,
  -- Категория: 'pricing' | 'features' | 'technical' | 'billing' | 'general'
  category    VARCHAR(50) NOT NULL DEFAULT 'general',
  question    TEXT NOT NULL,
  answer      TEXT NOT NULL,
  -- Отключить запись без удаления.
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ai_faq_active
  ON saas_meta.ai_faq (category)
  WHERE is_active;

-- ── Начальные записи FAQ ──────────────────────────────────────────────
INSERT INTO saas_meta.ai_faq (category, question, answer) VALUES
('pricing',   'Сколько стоит Detail Pro CRM?',
 'Тарифы: Соло (1 пользователь) — 3 900 ₽/мес или 39 000 ₽/год (экономия −16%). Студия (3 пользователя) — 5 900 ₽/мес или 59 000 ₽/год (экономия −16%). Дополнительный пользователь на тарифе Студия — +1 000 ₽/мес.'),

('pricing',   'Есть ли пробный период?',
 'Да, 7 дней бесплатно с доступом ко всем функциям. Без привязки карты. Регистрация на detailprocrm.ru'),

('pricing',   'Что будет, когда закончится пробный период?',
 'Доступ к CRM будет заблокирован. Все данные сохраняются. Чтобы продолжить — нужно выбрать тариф и оплатить. Принимаем карты и СБП.'),

('features',  'Что умеет Detail Pro CRM?',
 'Запись клиентов и управление расписанием, электронная приёмка авто (фото кузова по зонам + подпись клиента на экране), заказ-наряды по прайсу студии, финансы и аналитика выручки, задачи сотрудникам, Telegram-уведомления о записях, реферальная программа.'),

('features',  'Сколько пользователей можно добавить?',
 'На тарифе Соло — 1 пользователь (владелец). На тарифе Студия — 3 пользователя (владелец + менеджер + мастер). Дополнительные пользователи на Студии — +1 000 ₽/мес за каждого.'),

('technical', 'Как подключить Telegram-бота?',
 'В CRM зайди в Профиль → раздел Telegram → нажми «Подключить». Откроется ссылка — перейди по ней в Telegram и нажми Start. Всё, аккаунт привязан.'),

('technical', 'Как добавить сотрудника?',
 'В CRM зайди в раздел Студия (иконка здания) → вкладка Персонал → кнопка «Добавить пользователя». Укажи email — сотруднику придёт письмо с приглашением. Лимит зависит от тарифа.'),

('billing',   'Какие способы оплаты?',
 'Банковская карта и СБП (Система быстрых платежей). Оплата через сервис Prodamus — безопасно, без сохранения данных карты на нашем сервере.'),

('billing',   'Как оплатить через Telegram-бота?',
 'Нажми кнопку «Тарифы» в боте — выбери нужный тариф и период. Откроется страница оплаты. После успешной оплаты доступ активируется автоматически.')

ON CONFLICT DO NOTHING;
