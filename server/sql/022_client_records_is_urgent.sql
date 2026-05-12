-- Пометка «Важная запись» для клиентских записей.
--
-- Фронт уже отправляет is_urgent и календарь красит такие записи красным.
-- У части существующих studio_* схем колонки не было, из-за чего сохранение
-- записи могло падать на INSERT/UPDATE или флаг терялся.

DO $$
DECLARE
  sch text;
BEGIN
  FOR sch IN
    SELECT schema_name
      FROM information_schema.schemata
     WHERE schema_name LIKE 'studio_%'
  LOOP
    EXECUTE format(
      'ALTER TABLE %I.client_records ADD COLUMN IF NOT EXISTS is_urgent BOOLEAN NOT NULL DEFAULT FALSE',
      sch
    );

    RAISE NOTICE 'migrated %', sch;
  END LOOP;
END $$;
