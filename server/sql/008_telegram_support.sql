-- 008_telegram_support.sql
--
-- Поддержка через TG-бот (план A — личка с ботом для admin-чата).
--
-- Что делаем:
--   1. tg_user_states — конечный автомат для сценариев бота (сейчас только
--      'awaiting_support_message'). Ключ — tg_user_id, чтобы работало и для
--      незалинкованных пользователей.
--   2. support_requests — все обращения клиентов из бота. Сохраняем сырой
--      текст + метаданные + связь с user/studio (если привязан).
--   3. forwarded_message_id — id сообщения в админ-чате, в которое пришло
--      обращение. Когда админ делает Reply на это сообщение, бот по reply_to
--      находит обращение и пересылает ответ клиенту.
--
-- Идемпотентно — IF NOT EXISTS.

-- ── 1. Состояния TG-юзеров (FSM, TTL 15 мин на стороне приложения) ────
CREATE TABLE IF NOT EXISTS saas_meta.tg_user_states (
  tg_user_id BIGINT PRIMARY KEY,
  state      TEXT   NOT NULL,
  set_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── 2. Журнал обращений в поддержку ──────────────────────────────────
CREATE TABLE IF NOT EXISTS saas_meta.support_requests (
  id                    BIGSERIAL PRIMARY KEY,
  user_id               UUID REFERENCES saas_meta.users(id) ON DELETE SET NULL,
  tg_user_id            BIGINT,
  tg_chat_id            BIGINT NOT NULL,
  tg_username           TEXT,
  message               TEXT NOT NULL,
  -- Куда переслали в админ-чат и под каким message_id (для Reply-маршрутизации).
  forwarded_to_chat_id  BIGINT,
  forwarded_message_id  BIGINT,
  -- Ответ админа (Reply на пересланное сообщение).
  reply_text            TEXT,
  replied_at            TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_support_requests_created
  ON saas_meta.support_requests (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_support_requests_user
  ON saas_meta.support_requests (user_id, created_at DESC);

-- Reply-lookup: «найти обращение по id пересланного сообщения в админ-чате».
CREATE INDEX IF NOT EXISTS idx_support_requests_forwarded
  ON saas_meta.support_requests (forwarded_to_chat_id, forwarded_message_id)
  WHERE forwarded_message_id IS NOT NULL;
