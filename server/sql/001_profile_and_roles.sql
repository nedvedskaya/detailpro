-- saas-crm: миграция 001 — поля профиля + переименование ролей.
--
-- Что делает:
--   1. Добавляет в saas_meta.users поля first_name, last_name, phone, avatar_path.
--   2. Переименовывает роли в данных:  admin → owner,  employee → master.
--      Сохраняет manager без изменений.
--   3. Обновляет CHECK-констрейнт и DEFAULT.
--
-- Идемпотентна: ADD COLUMN IF NOT EXISTS, DROP CONSTRAINT IF EXISTS.
-- После UPDATE значения 'admin'/'employee' исчезают, повторный прогон
-- ничего не делает.
--
-- Применить: psql ... -f server/sql/001_profile_and_roles.sql
-- (или через `npm run init` после правки server/init.cjs)

-- ── 1. Поля профиля ──────────────────────────────────────────────────
ALTER TABLE saas_meta.users
    ADD COLUMN IF NOT EXISTS first_name  TEXT,
    ADD COLUMN IF NOT EXISTS last_name   TEXT,
    ADD COLUMN IF NOT EXISTS phone       TEXT,
    ADD COLUMN IF NOT EXISTS avatar_path TEXT;

-- Длины — мягкие лимиты в коде (PATCH /api/profile валидирует ≤100),
-- на уровне БД CHECK не вводим, чтобы не блокировать пограничные кейсы.

-- ── 2. Rename ролей ──────────────────────────────────────────────────
-- Сначала убираем старый CHECK, иначе UPDATE упадёт на 'owner'/'master'.
ALTER TABLE saas_meta.users
    DROP CONSTRAINT IF EXISTS users_role_check;

UPDATE saas_meta.users SET role = 'owner'  WHERE role = 'admin';
UPDATE saas_meta.users SET role = 'master' WHERE role = 'employee';

-- Новый CHECK + новый DEFAULT.
ALTER TABLE saas_meta.users
    ADD CONSTRAINT users_role_check CHECK (role IN ('owner', 'manager', 'master'));

ALTER TABLE saas_meta.users
    ALTER COLUMN role SET DEFAULT 'master';
