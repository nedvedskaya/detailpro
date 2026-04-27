-- 013_studio_retention.sql
--
-- Retention policy для брошенных студий.
--
-- Политика: студия, чьё access_until истекло > 30 дней назад и за это
-- время не было новых платежей, считается «брошенной» и автоматически
-- удаляется (DROP SCHEMA + DELETE из saas_meta.studios). За 7 дней до
-- удаления (= 23 дня после истечения) шлём warning через TG, чтобы
-- владелец успел оплатить или экспортировать данные.
--
-- Что меняем:
--
-- 1. ALTER FK saas_meta.consents.user_id → ON DELETE SET NULL.
--    По ФЗ-152 запись о согласии должна сохраняться даже после удаления
--    юзера. Раньше FK был без CASCADE/SET NULL — DELETE FROM users
--    блокировался foreign_key_violation.
--
-- 2. ALTER FK saas_meta.payments.studio_id → ON DELETE SET NULL.
--    Платежи — финансовый учёт, нельзя удалять вместе со студией.
--    Сохраняем запись с studio_id = NULL (плюс есть order_id и raw_payload
--    для аудита).
--
-- 3. studios.cleanup_warning_sent_at TIMESTAMPTZ NULL — трекаем что
--    предупреждение уже отправлено, чтобы не спамить каждый день.
--
-- 4. Индекс на (access_until) WHERE plan != 'cancelled' — для эффективного
--    поиска кандидатов на удаление.
--
-- Идемпотентно: проверки IF EXISTS / IF NOT EXISTS.

-- ── 1. ALTER consents FK ──────────────────────────────────────────────
DO $migration_consents_fk$
DECLARE
  cur_action TEXT;
BEGIN
  SELECT confdeltype INTO cur_action
    FROM pg_constraint
   WHERE conrelid = 'saas_meta.consents'::regclass
     AND conname  = 'consents_user_id_fkey';
  -- confdeltype: 'a' = NO ACTION, 'n' = SET NULL, 'c' = CASCADE
  IF cur_action IS NULL OR cur_action <> 'n' THEN
    -- Дропаем старый FK (имя у Postgres-конструкции по умолчанию
    -- '<table>_<col>_fkey').
    ALTER TABLE saas_meta.consents DROP CONSTRAINT IF EXISTS consents_user_id_fkey;
    ALTER TABLE saas_meta.consents
      ADD CONSTRAINT consents_user_id_fkey
      FOREIGN KEY (user_id) REFERENCES saas_meta.users(id) ON DELETE SET NULL;
  END IF;
END
$migration_consents_fk$;

-- ── 2. ALTER payments FK ──────────────────────────────────────────────
DO $migration_payments_fk$
DECLARE
  cur_action TEXT;
BEGIN
  SELECT confdeltype INTO cur_action
    FROM pg_constraint
   WHERE conrelid = 'saas_meta.payments'::regclass
     AND conname  = 'payments_studio_id_fkey';
  IF cur_action IS NULL OR cur_action <> 'n' THEN
    ALTER TABLE saas_meta.payments DROP CONSTRAINT IF EXISTS payments_studio_id_fkey;
    ALTER TABLE saas_meta.payments
      ADD CONSTRAINT payments_studio_id_fkey
      FOREIGN KEY (studio_id) REFERENCES saas_meta.studios(id) ON DELETE SET NULL;
  END IF;
END
$migration_payments_fk$;

-- ── 3. Колонка cleanup_warning_sent_at ────────────────────────────────
ALTER TABLE saas_meta.studios
  ADD COLUMN IF NOT EXISTS cleanup_warning_sent_at TIMESTAMPTZ;

COMMENT ON COLUMN saas_meta.studios.cleanup_warning_sent_at
  IS 'Когда отправлено предупреждение о грядущем удалении (за 7 дней до). NULL если ещё не слали.';

-- ── 4. Индекс для cleanup-job-а ───────────────────────────────────────
-- Партиальный — отсекаем 'cancelled' (там access_until = now() сразу
-- после refund, индекс был бы засорён уже-обработанными студиями) и
-- активные (access_until > now()).
CREATE INDEX IF NOT EXISTS idx_studios_retention_candidates
  ON saas_meta.studios (access_until)
  WHERE plan <> 'cancelled';
