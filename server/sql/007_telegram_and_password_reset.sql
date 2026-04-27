-- 007_telegram_and_password_reset.sql
--
-- Telegram-интеграция (Фаза 1) + password reset через TG.
--
-- Архитектура (см. обсуждение в чате):
--   • Один бот (@crmdetailpro_bot) на весь SaaS.
--   • Привязка: пользователь жмёт «Подключить Telegram» в CRM →
--     сервер генерит одноразовый токен → фронт открывает
--     https://t.me/crmdetailpro_bot?start=link_<token> → бот при /start
--     находит токен, выставляет users.tg_user_id, сжигает токен.
--   • Reset пароля: пользователь на login screen жмёт «Забыли пароль?» →
--     вводит email → сервер генерит password_reset_token → отдаёт ссылку
--     /reset?token=... через бота (если у user есть tg_user_id).
--
-- Все таблицы — в saas_meta (cross-tenant, привязка к users а не к studio).
--
-- Идемпотентно — IF NOT EXISTS, можно прогонять повторно.

-- ── 1. Привязка TG к пользователю ─────────────────────────────────────
-- tg_user_id BIGINT — Telegram user.id (целое, до ~2^53).
-- UNIQUE — один TG-аккаунт = один user. Если человек захочет
-- переподвязать на другой TG-аккаунт, сначала /unlink → потом link заново.
ALTER TABLE saas_meta.users
  ADD COLUMN IF NOT EXISTS tg_user_id   BIGINT      UNIQUE,
  ADD COLUMN IF NOT EXISTS tg_username  TEXT,
  ADD COLUMN IF NOT EXISTS tg_chat_id   BIGINT,
  ADD COLUMN IF NOT EXISTS tg_linked_at TIMESTAMPTZ;

-- ── 2. Одноразовые токены для привязки TG ─────────────────────────────
-- 24h TTL. После /start со ссылкой — consumed_at заполняется, повторно
-- такой токен не используется (защита от replay при перехвате ссылки).
CREATE TABLE IF NOT EXISTS saas_meta.tg_link_tokens (
  token       TEXT PRIMARY KEY,
  user_id     UUID NOT NULL REFERENCES saas_meta.users(id) ON DELETE CASCADE,
  expires_at  TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS tg_link_tokens_user_idx ON saas_meta.tg_link_tokens (user_id);

-- ── 3. Идемпотентность TG webhook ─────────────────────────────────────
-- TG ретраит при не-200 в течение часов. Каждый update_id обрабатываем
-- ровно один раз. Старые записи (>30 дней) можно периодически чистить —
-- пока не делаем, объёмы маленькие.
CREATE TABLE IF NOT EXISTS saas_meta.tg_processed_updates (
  update_id    BIGINT PRIMARY KEY,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── 4. Лог исходящих TG-сообщений ─────────────────────────────────────
-- Без него через месяц не отладить «почему не дошло». kind — что отправили
-- (link_success, password_reset, payment_success, new_booking, …),
-- ok — успех HTTP-вызова, error — текст ошибки от TG если был.
CREATE TABLE IF NOT EXISTS saas_meta.tg_messages_log (
  id          BIGSERIAL PRIMARY KEY,
  user_id     UUID REFERENCES saas_meta.users(id) ON DELETE SET NULL,
  tg_chat_id  BIGINT,
  kind        TEXT NOT NULL,
  ok          BOOLEAN NOT NULL,
  error       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS tg_messages_log_user_idx
  ON saas_meta.tg_messages_log (user_id, created_at DESC);

-- ── 5. Password reset токены ──────────────────────────────────────────
-- 30 минут TTL — короткий, чтобы перехват TG-сообщения не открывал окно
-- надолго. consumed_at — токен «сгорает» после успешной смены пароля.
-- Связь с user, а не с email: при смене email старые токены не висят.
CREATE TABLE IF NOT EXISTS saas_meta.password_reset_tokens (
  token       TEXT PRIMARY KEY,
  user_id     UUID NOT NULL REFERENCES saas_meta.users(id) ON DELETE CASCADE,
  expires_at  TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  -- delivery: 'telegram' | 'email' | ... — на будущее, когда добавим email.
  -- Сейчас всегда 'telegram'. Не enum — добавлять каналы будем без миграции.
  delivery    TEXT NOT NULL DEFAULT 'telegram',
  -- request_ip, user_agent — для разбора если кто-то жалуется на ложные reset'ы.
  request_ip  TEXT,
  user_agent  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS password_reset_tokens_user_idx
  ON saas_meta.password_reset_tokens (user_id);
