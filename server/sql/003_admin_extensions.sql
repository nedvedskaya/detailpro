-- ════════════════════════════════════════════════════════════════════════
-- 003_admin_extensions.sql
--
-- Миграция для блока «Админ-панель»:
--   • Видимость финансов per-user (только для роли manager имеет смысл,
--     master хардкодом не видит финансы вообще — см. permissions.ts)
--   • Запоминать last_login_at, чтобы owner видел, когда сотрудник
--     заходил в систему последний раз (раньше колонки не было — UI рисовал «—»)
--   • Расширить activity_logs.entity_id с INTEGER до TEXT во ВСЕХ
--     tenant-схемах: некоторые сущности имеют UUID-идентификаторы
--     (saas_meta.users, например), и текущая колонка их не вмещает
--
-- Идемпотентна (IF NOT EXISTS / DO $$ EXCEPTION).
-- ════════════════════════════════════════════════════════════════════════

-- 3.1. Видимость финансов и last_login_at в saas_meta.users
ALTER TABLE saas_meta.users
  ADD COLUMN IF NOT EXISTS can_view_finance BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS last_login_at    TIMESTAMPTZ;

-- 3.2. activity_logs.entity_id INTEGER → TEXT во всех существующих
-- студийных схемах. USING entity_id::TEXT гарантированно конвертирует
-- любые числа без потерь.
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT schema_name
    FROM information_schema.schemata
    WHERE schema_name LIKE 'studio_%'
  LOOP
    -- Проверяем, что таблица и колонка ещё в старом типе:
    -- иначе при повторном запуске Postgres ругнётся на TYPE TEXT → TEXT no-op
    -- (на самом деле он не ругнётся, но всё равно проверим).
    IF EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = r.schema_name
        AND table_name = 'activity_logs'
        AND column_name = 'entity_id'
        AND data_type = 'integer'
    ) THEN
      EXECUTE format(
        'ALTER TABLE %I.activity_logs
           ALTER COLUMN entity_id TYPE TEXT USING entity_id::TEXT',
        r.schema_name
      );
      RAISE NOTICE 'activity_logs.entity_id → TEXT in schema %', r.schema_name;
    END IF;
  END LOOP;
END $$;
