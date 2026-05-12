-- Разрешает оплату заказ-наряда по счёту для существующих студий.
--
-- UI, серверная валидация и PDF уже поддерживают payment_method='invoice'.
-- У старых tenant-схем оставался CHECK только на cash/card/transfer, поэтому
-- сохранение заказ-наряда со способом «Счёт» падало на уровне БД.

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
      'ALTER TABLE %I.work_orders DROP CONSTRAINT IF EXISTS work_orders_payment_method_check',
      sch
    );
    EXECUTE format(
      'ALTER TABLE %I.work_orders ADD CONSTRAINT work_orders_payment_method_check '
      || 'CHECK (payment_method IN (''cash'', ''card'', ''transfer'', ''invoice'') OR payment_method IS NULL)',
      sch
    );

    RAISE NOTICE 'migrated %', sch;
  END LOOP;
END $$;
