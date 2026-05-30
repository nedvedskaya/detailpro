DO $$
DECLARE
  s text;
BEGIN
  FOR s IN
    SELECT schemata.schema_name
      FROM information_schema.schemata
     WHERE schemata.schema_name LIKE 'studio_%'
       AND EXISTS (
         SELECT 1
           FROM information_schema.tables
          WHERE table_schema = schemata.schema_name
            AND table_name = 'client_records'
       )
  LOOP
    EXECUTE format(
      'ALTER TABLE %I.client_records ADD COLUMN IF NOT EXISTS record_color TEXT NOT NULL DEFAULT ''none''',
      s
    );
    EXECUTE format(
      'UPDATE %I.client_records SET record_color = ''red'' WHERE is_urgent = true AND record_color = ''none''',
      s
    );
  END LOOP;
END
$$;
