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
            AND table_name = 'clients'
       )
  LOOP
    EXECUTE format(
      'ALTER TABLE %I.clients ADD COLUMN IF NOT EXISTS card_color TEXT NOT NULL DEFAULT ''none''',
      s
    );
  END LOOP;
END
$$;
