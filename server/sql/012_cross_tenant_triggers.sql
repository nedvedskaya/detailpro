-- 012_cross_tenant_triggers.sql
--
-- Defense-in-depth для cross-tenant изоляции.
--
-- Контекст:
--   В studio_*-схемах есть FK на saas_meta.users (master_id, assigned_to,
--   created_by, user_id и т.п.). Postgres-FK гарантирует что user.id
--   существует, но НЕ что user принадлежит этой же студии.
--
--   На app-уровне это закрыто helper'ом assertUserInStudio() (см.
--   server/lib/tenant_security.cjs). Эта миграция дублирует ту же
--   проверку на уровне БД через триггер — на случай если кто-то
--   добавит новый роут и забудет вызвать helper. Postgres сам бросит
--   `check_violation`, INSERT/UPDATE не пройдёт.
--
-- Что делает функция:
--   1. Достаёт значение проверяемой колонки из NEW (имя колонки —
--      первый аргумент триггера, TG_ARGV[0]).
--   2. Если значение NULL — пропускает (поле опциональное).
--   3. Находит studio_id текущей schema (TG_TABLE_SCHEMA → saas_meta.studios).
--   4. Сверяет с user.studio_id. Mismatch → RAISE EXCEPTION.
--
-- Идемпотентно: CREATE OR REPLACE FUNCTION + DROP TRIGGER IF EXISTS.
--
-- Производительность:
--   На каждый INSERT/UPDATE OF master_id и т.п. — один SELECT на
--   saas_meta.users (по PK, индексирован) + один на saas_meta.studios
--   (по UNIQUE schema_name, индексирован). Итого +2 точечных лукапа
--   на write-операцию. Для CRM-нагрузки незаметно.
--
-- ROLLBACK:
--   DROP FUNCTION saas_meta.check_user_belongs_to_studio() CASCADE;
--   (CASCADE автоматически снимет все триггеры, использующие функцию.)

CREATE OR REPLACE FUNCTION saas_meta.check_user_belongs_to_studio()
RETURNS TRIGGER AS $$
DECLARE
  -- Имя колонки передаётся первым аргументом в CREATE TRIGGER
  -- (`EXECUTE FUNCTION saas_meta.check_user_belongs_to_studio('master_id')`)
  user_col            TEXT := TG_ARGV[0];
  user_id_val         UUID;
  expected_studio_id  UUID;
  user_studio_id      UUID;
BEGIN
  -- Достаём значение динамической колонки из NEW. row_to_json быстрее
  -- EXECUTE format() и работает с любой структурой row.
  user_id_val := (row_to_json(NEW)->>user_col)::uuid;
  IF user_id_val IS NULL THEN
    RETURN NEW;
  END IF;

  -- К какой студии принадлежит текущая schema (по имени).
  -- TG_TABLE_SCHEMA — встроенная переменная триггера, имя schema на
  -- которой стоит триггер. Никаких user-input'ов — безопасно.
  SELECT id INTO expected_studio_id
    FROM saas_meta.studios
   WHERE schema_name = TG_TABLE_SCHEMA;

  IF expected_studio_id IS NULL THEN
    -- Schema не зарегистрирована в saas_meta.studios. Это либо
    -- сценарий тестирования (создали schema руками), либо аномалия.
    -- Не блокируем — пусть FK сделает свою работу. Логировать нечем
    -- из триггера (RAISE NOTICE есть, но не идёт в structured log).
    RETURN NEW;
  END IF;

  -- К какой студии принадлежит user.
  SELECT studio_id INTO user_studio_id
    FROM saas_meta.users
   WHERE id = user_id_val;

  IF user_studio_id IS NULL THEN
    -- Юзера нет — пусть Postgres-FK бросит свой foreign_key_violation.
    -- Не наша работа дублировать.
    RETURN NEW;
  END IF;

  IF user_studio_id <> expected_studio_id THEN
    RAISE EXCEPTION
      'cross_tenant_user_reference: column %.% value % belongs to studio %, expected schema studio %',
      TG_TABLE_NAME, user_col, user_id_val, user_studio_id, expected_studio_id
      USING ERRCODE = 'check_violation', -- 23514, маппится в наш err handler как 400
            HINT    = 'user должен принадлежать студии этой schema';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Комментарий к функции — для DBA, кто заглянет в pg_proc.
COMMENT ON FUNCTION saas_meta.check_user_belongs_to_studio()
  IS 'Defense-in-depth: блокирует cross-tenant FK на saas_meta.users в studio_*-схемах. Имя проверяемой колонки передавать как TG_ARGV[0] при CREATE TRIGGER.';
