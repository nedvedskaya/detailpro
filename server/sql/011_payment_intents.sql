-- 011_payment_intents.sql
--
-- Что добавляем:
--   • saas_meta.payment_intents — серверно-выпущенный токен, привязывающий
--     платёжную ссылку Prodamus к конкретной authenticated студии.
--
-- Зачем:
--   До этой миграции webhook принимал studio_id напрямую из payload (поле
--   `_param_studio_id` в payform-URL). Поскольку фронт сам ставит этот
--   параметр в URL Prodamus, атакующий мог поменять его в devtools на
--   UUID чужой студии. После своей оплаты у Prodamus webhook приходил с
--   валидной HMAC-подписью, но studio_id в нём указывал на жертву —
--   сервер UPDATE-нул чужую запись (затирал prodamus_subscription_*,
--   сбрасывал cancel_pending, списывал бонусы жертвы).
--
--   Решение: при инициации платежа фронт зовёт POST /api/profile/payment/intent,
--   получает одноразовый token и подставляет его в URL Prodamus как
--   `_param_intent`. Webhook читает intent → берёт studio_id ИЗ ИНТЕНТА
--   (доверенный источник, привязан к req.session при выдаче), а
--   `_param_studio_id` из payload ИГНОРИРУЕТ.
--
--   Атакующий не может выпустить intent на чужую студию: эндпоинт
--   intent-выдачи стоит за requireAuth и берёт studio_id из сессии.
--
-- Безопасность:
--   • token — 32 байта crypto.randomBytes → base64url. Брутфорс 2^256 нереален.
--   • Один intent = одна оплата: consumed_at заполняется в той же транзакции
--     обработки webhook'а, что и INSERT в payments. Повторный webhook с тем
--     же intent → отказ (token_already_consumed).
--   • TTL 1 час: пользователь должен успеть оплатить за 60 минут с момента
--     клика «Оплатить». Прохолостивший intent протухает; cron подчищает.
--   • expected_amount_kop хранится для контроля: если на чекауте Prodamus
--     юзер каким-то образом изменил customer_price ниже минимума — webhook
--     может это задетектить (warning в лог; не отказ — пусть деньги пройдут,
--     но событие зафиксируется).
--
-- Идемпотентно (IF NOT EXISTS).

CREATE TABLE IF NOT EXISTS saas_meta.payment_intents (
  token                TEXT        PRIMARY KEY,
  studio_id            UUID        NOT NULL REFERENCES saas_meta.studios(id) ON DELETE CASCADE,
  user_id              UUID        REFERENCES saas_meta.users(id) ON DELETE SET NULL,
  plan_id              TEXT        NOT NULL,        -- 'solo_month' | 'solo_year' | 'studio_month' | 'studio_year'
  expected_amount_kop  BIGINT      NOT NULL,        -- сумма по тарифу до бонусов (для аудита)
  bonus_kop            BIGINT      NOT NULL DEFAULT 0,  -- сколько бонусов планируется списать
  expires_at           TIMESTAMPTZ NOT NULL,
  consumed_at          TIMESTAMPTZ,
  consumed_order_id    TEXT,
  created_ip           TEXT,
  user_agent           TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Поиск активных intent'ов по студии (для UI «у вас есть незавершённый платёж»).
CREATE INDEX IF NOT EXISTS idx_payment_intents_studio
  ON saas_meta.payment_intents (studio_id)
  WHERE consumed_at IS NULL;

-- Cron-чистка протухших.
CREATE INDEX IF NOT EXISTS idx_payment_intents_expires
  ON saas_meta.payment_intents (expires_at)
  WHERE consumed_at IS NULL;
