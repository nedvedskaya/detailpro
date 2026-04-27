-- 009_gender_timezone_reminders.sql
--
-- Что добавляем:
--   • users.gender             — 'm' | 'f' | NULL. Спрашиваем у пользователя
--                                 после привязки TG (inline-кнопки в боте).
--                                 Используем для правильного склонения форм
--                                 в текстах ("забыл/забыла").
--   • studios.timezone          — IANA timezone (default 'Europe/Moscow').
--                                 Для cron-напоминаний: «9:00 локального времени
--                                 студии». Один TZ на студию.
--   • studios.timezone_set      — TRUE после явного выбора owner-ом, чтобы
--                                 не переспрашивать каждый раз.
--   • tg_sent_reminders         — журнал отправленных напоминаний для
--                                 идемпотентности cron-job'ов. Партиально
--                                 уникальные индексы на (user, day) для
--                                 daily_summary и (user, studio, booking) для
--                                 hour_before гарантируют ровно одну отправку.
--
-- Идемпотентно — IF NOT EXISTS.

-- ── 1. Пол пользователя ──────────────────────────────────────────────
ALTER TABLE saas_meta.users
  ADD COLUMN IF NOT EXISTS gender TEXT
    CHECK (gender IS NULL OR gender IN ('m', 'f'));

-- ── 2. Часовой пояс студии ───────────────────────────────────────────
ALTER TABLE saas_meta.studios
  ADD COLUMN IF NOT EXISTS timezone     TEXT NOT NULL DEFAULT 'Europe/Moscow',
  ADD COLUMN IF NOT EXISTS timezone_set BOOLEAN NOT NULL DEFAULT FALSE;

-- ── 3. Журнал отправленных напоминаний (идемпотентность cron-job'ов) ──
CREATE TABLE IF NOT EXISTS saas_meta.tg_sent_reminders (
  id              BIGSERIAL PRIMARY KEY,
  user_id         UUID NOT NULL REFERENCES saas_meta.users(id) ON DELETE CASCADE,
  kind            TEXT NOT NULL,                                    -- 'daily_summary' | 'hour_before'
  ref_date        DATE,                                             -- для daily_summary: дата (локальная студии)
                                                                    -- для hour_before:   дата брони
  ref_time        TIME,                                             -- для hour_before: время брони
  ref_studio_id   UUID REFERENCES saas_meta.studios(id) ON DELETE CASCADE,
  ref_booking_id  INTEGER,                                          -- id брони в studio_xxx.bookings
  sent_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Партиальный UNIQUE: одна daily_summary на (user, день).
CREATE UNIQUE INDEX IF NOT EXISTS uq_tg_reminders_daily
  ON saas_meta.tg_sent_reminders (user_id, ref_date)
  WHERE kind = 'daily_summary';

-- Партиальный UNIQUE: одна hour_before на (user, студия, бронь, дата+время брони).
-- Включаем (ref_date, ref_time) в ключ — если бронь перенесли на другое время,
-- получится новая комбинация и напоминание уйдёт повторно за час до нового времени.
-- Если время не менялось — повторно не уйдёт.
CREATE UNIQUE INDEX IF NOT EXISTS uq_tg_reminders_hour_before
  ON saas_meta.tg_sent_reminders (user_id, ref_studio_id, ref_booking_id, ref_date, ref_time)
  WHERE kind = 'hour_before';

-- Для cleanup: можно периодически чистить старые (>90 дней) записи.
CREATE INDEX IF NOT EXISTS idx_tg_reminders_sent_at
  ON saas_meta.tg_sent_reminders (sent_at);
