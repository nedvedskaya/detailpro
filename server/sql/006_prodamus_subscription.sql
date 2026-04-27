-- 006_prodamus_subscription.sql
--
-- Реквизиты для управления рекуррентом на стороне Prodamus.
--
-- Контекст:
--   Раньше «Отменить подписку» ставило только локальный флаг cancel_pending=true,
--   а сам рекуррент в Prodamus продолжал работать. Чтобы 100% остановить списания
--   на стороне платёжки, нужно дёрнуть Prodamus REST setActivity → но для этого
--   надо знать ID подписки, который Prodamus присылает в webhook'е.
--
--   prodamus_subscription_id      — `subscription` из webhook payload
--   prodamus_subscription_phone   — `payer_phone` / `customer.phone` (нужно, чтобы
--                                    у Prodamus было чем матчить пользователя при
--                                    вызове setActivity без tg_user_id)
--   prodamus_subscription_email   — `customer_email` / `payer_email` (fallback)
--
-- Все nullable: для старых студий, у которых ещё не приходил webhook с этими
-- полями, мы просто пропускаем вызов setActivity и опираемся на webhook-защиту
-- (paid_after_cancel → бонус-баланс).
--
-- Идемпотентно — IF NOT EXISTS, можно прогонять повторно.

ALTER TABLE saas_meta.studios
  ADD COLUMN IF NOT EXISTS prodamus_subscription_id    TEXT,
  ADD COLUMN IF NOT EXISTS prodamus_subscription_phone TEXT,
  ADD COLUMN IF NOT EXISTS prodamus_subscription_email TEXT;
