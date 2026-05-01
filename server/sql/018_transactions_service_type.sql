-- 018_transactions_service_type.sql
--
-- Выравнивает CHECK-constraint на transactions.type для всех существующих
-- студий. Шаблон 100_tenant_template.sql разрешает type='service' (для
-- категорий услуг как отдельной сущности), но это касается только новых
-- студий — у существующих 10+ студий старый CHECK на (income, expense).
--
-- Миграция идемпотентна (DROP IF EXISTS + ADD), безопасно перезапускается.
-- Бежим по каждой studio_xxx схеме отдельно, чтобы сломанная одна не
-- блокировала остальные.

DO $$
DECLARE
  sch text;
BEGIN
  FOR sch IN
    SELECT schema_name
      FROM information_schema.schemata
     WHERE schema_name LIKE 'studio_%'
  LOOP
    -- transactions.type: разрешаем 'service' наравне с 'income'/'expense'
    EXECUTE format(
      'ALTER TABLE %I.transactions DROP CONSTRAINT IF EXISTS transactions_type_check',
      sch
    );
    EXECUTE format(
      'ALTER TABLE %I.transactions ADD CONSTRAINT transactions_type_check '
      || 'CHECK (type IN (''income'', ''expense'', ''service''))',
      sch
    );

    -- categories.type: тот же набор. На большинстве студий уже выравнено
    -- ботом, но для надёжности повторяем — DROP IF EXISTS не упадёт.
    EXECUTE format(
      'ALTER TABLE %I.categories DROP CONSTRAINT IF EXISTS categories_type_check',
      sch
    );
    EXECUTE format(
      'ALTER TABLE %I.categories ADD CONSTRAINT categories_type_check '
      || 'CHECK (type IN (''income'', ''expense'', ''service''))',
      sch
    );

    RAISE NOTICE 'migrated %', sch;
  END LOOP;
END $$;
