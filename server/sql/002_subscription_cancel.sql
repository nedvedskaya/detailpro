-- 002_subscription_cancel.sql
--
-- Флаг "пользователь нажал «Отменить подписку»".
--   true  → автопродления больше не будет, доступ остаётся до access_until,
--           UI показывает «Подписка отменена, доступ до DD.MM».
--           После истечения webhook от Prodamus НЕ должен продлевать (reject в коде).
--   false → обычное состояние, либо «отменили отмену» через resume.
--
-- Идемпотентно — IF NOT EXISTS, можно прогонять повторно.

ALTER TABLE saas_meta.studios
  ADD COLUMN IF NOT EXISTS cancel_pending BOOLEAN NOT NULL DEFAULT false;

-- Индекс не нужен: read только в одной точке (GET /api/profile)
-- и очень редко — при сверке webhook-а от Prodamus.
