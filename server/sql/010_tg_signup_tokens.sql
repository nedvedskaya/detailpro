-- 010_tg_signup_tokens.sql
--
-- Что добавляем:
--   • saas_meta.tg_signup_tokens — одноразовые токены для сценария:
--       1) человек впервые пишет боту, у него ещё нет аккаунта в СРМ;
--       2) бот предлагает «Создать аккаунт» → генерит токен и шлёт ссылку
--          ${APP_ORIGIN}/signup?tg=<token>;
--       3) пользователь регистрируется на сайте — мы валидируем токен и в
--          той же транзакции создания user-а пишем tg_user_id/tg_chat_id/
--          tg_username из строки token-а.
--
-- Безопасность:
--   • token уникален, одноразовый (consumed_at), TTL 30 минут.
--   • Партиально-уникальный индекс по tg_user_id WHERE consumed_at IS NULL —
--     один активный токен на TG-юзера, чтобы старые ссылки сами протухали
--     при новом нажатии «Создать аккаунт».
--   • При consume — пометка consumed_at = now() в той же транзакции, что и
--     создание users, чтобы повторный signup тем же токеном падал.
--
-- Идемпотентно (IF NOT EXISTS).

CREATE TABLE IF NOT EXISTS saas_meta.tg_signup_tokens (
  id           BIGSERIAL PRIMARY KEY,
  token        TEXT        NOT NULL,
  tg_user_id   BIGINT      NOT NULL,
  tg_chat_id   BIGINT      NOT NULL,
  tg_username  TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at   TIMESTAMPTZ NOT NULL,
  consumed_at  TIMESTAMPTZ,
  consumed_user_id UUID REFERENCES saas_meta.users(id) ON DELETE SET NULL
);

-- Уникальность токена — основной поиск идёт по нему.
CREATE UNIQUE INDEX IF NOT EXISTS uq_tg_signup_tokens_token
  ON saas_meta.tg_signup_tokens (token);

-- Один активный токен на TG-юзера: при «Создать аккаунт» бот сначала чистит
-- старые незаюзанные токены этого tg_user_id, потом INSERT — чтобы не падать
-- на 23505. Партиальный индекс гарантирует, что одновременно живых ссылок
-- больше одной не будет.
CREATE UNIQUE INDEX IF NOT EXISTS uq_tg_signup_tokens_active_per_user
  ON saas_meta.tg_signup_tokens (tg_user_id)
  WHERE consumed_at IS NULL;

-- Для cron-чистки протухших.
CREATE INDEX IF NOT EXISTS idx_tg_signup_tokens_expires
  ON saas_meta.tg_signup_tokens (expires_at)
  WHERE consumed_at IS NULL;
