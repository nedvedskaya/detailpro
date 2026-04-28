-- 017_funnel_metrics.sql
--
-- Таймстемпы первых ключевых событий студии — основа умной воронки
-- прогрева в Telegram и продуктовой аналитики.
--
-- Логика заполнения: в обработчиках API при создании клиента/брони/наряда/
-- акта/транзакции делаем `UPDATE saas_meta.studios SET first_X_at =
-- COALESCE(first_X_at, now())`. COALESCE гарантирует, что фиксируется
-- ИМЕННО первое событие — повторные не сдвигают timestamp.
--
-- last_active_at — обновляется на любом auth-roundtrip'е (через middleware).
-- Используется для определения «жив/мёртв» при принятии решения о рассылке.
--
-- trial_extension_used_at — флаг что пользователь уже получил бонусный день
-- через TG-кнопку («Добавь +1 день»). Один раз навсегда.
--
-- tg_blocked_at — если бот получил 403 Forbidden от пользователя (заблочил
-- бота / удалил чат), помечаем и больше никогда не пишем — иначе будем
-- логгировать ошибки до бесконечности.
--
-- Идемпотентно (IF NOT EXISTS).

ALTER TABLE saas_meta.studios
  ADD COLUMN IF NOT EXISTS first_client_at      TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS first_record_at      TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS first_workorder_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS first_acceptance_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS first_transaction_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS first_paid_at        TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_active_at       TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS trial_extension_used_at TIMESTAMPTZ;

-- Бэкфилл first_paid_at для уже-платящих студий из истории payments.
-- Без этого код «если first_paid_at IS NULL — ещё не платил» неверно
-- классифицирует существующих клиентов как тех, кто никогда не платил.
UPDATE saas_meta.studios s
   SET first_paid_at = (
     SELECT MIN(received_at) FROM saas_meta.payments
      WHERE studio_id = s.id AND status = 'paid'
   )
 WHERE first_paid_at IS NULL
   AND EXISTS (SELECT 1 FROM saas_meta.payments
                WHERE studio_id = s.id AND status = 'paid');

-- Флаг «бот заблокирован» — для остановки попыток отправки.
ALTER TABLE saas_meta.users
  ADD COLUMN IF NOT EXISTS tg_blocked_at TIMESTAMPTZ;

-- ──────────────────────────────────────────────────────────────────────
-- Журнал событий воронки. Каждый раз, когда cron или callback что-то
-- делает (отправил сообщение, юзер кликнул кнопку), пишется строка.
--
-- UNIQUE (studio_id, event_kind) — один тип события на студию шлётся ровно
-- один раз. Это и есть идемпотентность: если cron упадёт и перезапустится,
-- INSERT по тому же (studio_id, kind) откатится.
--
-- click_value — JSON с произвольными данными по клику (например, какая
-- из 4 кнопок в касдеве была нажата). Анализируется при подсчёте конверсии.
-- ──────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS saas_meta.funnel_events (
  id           BIGSERIAL PRIMARY KEY,
  studio_id    UUID NOT NULL REFERENCES saas_meta.studios(id) ON DELETE CASCADE,
  user_id      UUID         REFERENCES saas_meta.users(id)    ON DELETE SET NULL,
  event_kind   TEXT NOT NULL,           -- например 'no_purchase.day1', 'no_purchase.day5_pain'
  sent_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  clicked_at   TIMESTAMPTZ,
  click_value  JSONB,
  UNIQUE (studio_id, event_kind)
);

CREATE INDEX IF NOT EXISTS idx_funnel_events_studio
  ON saas_meta.funnel_events (studio_id);

CREATE INDEX IF NOT EXISTS idx_funnel_events_kind_sent
  ON saas_meta.funnel_events (event_kind, sent_at);
