-- 016_upgrade_proration.sql
--
-- Добавляем поля для pro-rata апгрейда тарифа Соло → Студия.
--
-- Что и зачем:
--   • is_upgrade — флаг, что этот intent оформлен как upgrade с действующего
--     тарифа. Webhook читает его, чтобы при активации пересчитать access_until
--     с нуля (now() + durationDays), а не «добавлять сверху» к остатку Соло.
--   • prorated_credit_kop — сколько копеек засчитано за неиспользованные дни
--     текущего Соло. Уходит в Prodamus как часть discount_value
--     (вместе с bonus_kop). Хранится отдельно от bonus_kop, чтобы при возврате
--     платежа не зачислить эту сумму обратно в bonus_balance_kop как реферал-
--     бонус (это не реферал-бонус, а зачёт за уже оплаченный период).
--
-- Бизнес-правило: апгрейд возможен только в рамках одного периода
-- (solo_month → studio_month, solo_year → studio_year). Кросс-period
-- апгрейды и downgrade'ы запрещены — фронт не покажет кнопку.
--
-- Идемпотентно.

ALTER TABLE saas_meta.payment_intents
  ADD COLUMN IF NOT EXISTS is_upgrade BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE saas_meta.payment_intents
  ADD COLUMN IF NOT EXISTS prorated_credit_kop BIGINT NOT NULL DEFAULT 0;
