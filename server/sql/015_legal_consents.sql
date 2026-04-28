-- ════════════════════════════════════════════════════════════════════════
-- 015: расширения для юридических документов 28.04.2026
--
-- 1. consents.consent_type: добавляем тип 'telegram_cross_border' для
--    отдельного согласия на трансграничную передачу при привязке бота.
--    Без отдельного согласия привязка незаконна (ч. 4 ст. 12 ФЗ-152).
--
-- 2. studios.deletion_requested_at: запрос на удаление аккаунта по 152-ФЗ.
--    Юзер жмёт «Удалить аккаунт» → ставится дата + флаг. Через 30 дней
--    cron реально удаляет (см. server/sql/013_studio_retention.sql);
--    до этого юзер может отменить через тот же эндпоинт.
--
-- Идемпотентно: ADD COLUMN IF NOT EXISTS, DROP/ADD CONSTRAINT через DO-блок.
-- ════════════════════════════════════════════════════════════════════════

-- ── 1. consents.consent_type CHECK ──────────────────────────────────────
DO $$
BEGIN
  -- Снимаем старый CHECK (если есть). Имя из 000_saas_meta.sql — Postgres
  -- по умолчанию даёт constraint имя <table>_<col>_check.
  ALTER TABLE saas_meta.consents
    DROP CONSTRAINT IF EXISTS consents_consent_type_check;
  -- Добавляем новый с расширенным набором.
  ALTER TABLE saas_meta.consents
    ADD CONSTRAINT consents_consent_type_check
    CHECK (consent_type IN (
      'personal_data',
      'marketing',
      'terms',
      'telegram_cross_border'
    ));
END
$$;

-- ── 2. studios.deletion_requested_at ────────────────────────────────────
ALTER TABLE saas_meta.studios
  ADD COLUMN IF NOT EXISTS deletion_requested_at TIMESTAMPTZ;

-- Индекс для cron-задачи, которая раз в сутки находит студии «к удалению»
-- (deletion_requested_at IS NOT NULL AND deletion_requested_at < now() - 30 days).
-- Partial index — потому что у 99% студий это поле NULL и в индексе им делать нечего.
CREATE INDEX IF NOT EXISTS idx_studios_pending_deletion
  ON saas_meta.studios(deletion_requested_at)
  WHERE deletion_requested_at IS NOT NULL;
