-- ════════════════════════════════════════════════════════════════════════
-- Per-tenant schema template (saas-crm).
--
-- Применяется один раз на каждую студию через tenant_provisioning.cjs.
-- Плейсхолдер {{schema}} заменяется на безопасно-валидированное имя схемы
-- (напр. "studio_demo") через db.queryInSchema(...).
--
-- Источник: portировано из Crm-new-main/server/index.cjs:448-880 со снятием
-- single-tenant baggage:
--   ── branches, branch_id (всех таблиц)        — мульти-точек больше нет
--   ── subscriptions, user_subscriptions        — биллинг живёт в saas_meta
--   ── payments (старая)                        — saas_meta.payments
--   ── login_attempts                           — будет в saas_meta или app-layer
--   ── sessions                                 — saas_meta.sessions
--   ── password_reset_tokens                    — перенесём в saas_meta позже
--   ── users (per-tenant копия)                 — saas_meta.users (UUID)
--
-- ID-типы:
--   per-tenant таблицы оставляют SERIAL/INTEGER PK для совместимости с
--   фронтендом и упрощения миграции. Cross-schema ссылки на saas_meta.users
--   используют UUID (через FK с ON DELETE SET NULL).
--
-- Cross-schema FK работают в Postgres. Удаление студии (DROP SCHEMA CASCADE)
-- ломает их в одну сторону — это ок, потому что вся per-tenant БД уезжает.
-- Удаление user из saas_meta.users → SET NULL во всех его per-tenant ссылках.
--
-- Идемпотентен (IF NOT EXISTS везде). Можно гонять повторно для миграции.
-- ════════════════════════════════════════════════════════════════════════

-- ─── Категории расходов/доходов ───
CREATE TABLE IF NOT EXISTS {{schema}}.categories (
    id           SERIAL PRIMARY KEY,
    name         VARCHAR(255) NOT NULL,
    type         VARCHAR(50) NOT NULL DEFAULT 'expense'
                 CHECK (type IN ('income', 'expense')),
    color        VARCHAR(20),
    icon         VARCHAR(50),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─── Теги (общий пул для clients, vehicles, bookings, …) ───
CREATE TABLE IF NOT EXISTS {{schema}}.tags (
    id           SERIAL PRIMARY KEY,
    name         VARCHAR(255) NOT NULL,
    color        VARCHAR(20),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─── Клиенты ───
CREATE TABLE IF NOT EXISTS {{schema}}.clients (
    id           SERIAL PRIMARY KEY,
    name         VARCHAR(255) NOT NULL,
    phone        VARCHAR(50),
    email        VARCHAR(255),
    notes        TEXT,
    city         VARCHAR(255),
    source       VARCHAR(100),         -- откуда пришёл клиент
    birth_date   VARCHAR(20),          -- свободный формат (как в исходном CRM)
    avatar       TEXT,                 -- base64-картинка (как в исходном; на S3 — позже)
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_clients_phone   ON {{schema}}.clients(phone);
CREATE INDEX IF NOT EXISTS idx_clients_name    ON {{schema}}.clients(name);
CREATE INDEX IF NOT EXISTS idx_clients_created ON {{schema}}.clients(created_at DESC);

-- ─── Транспортные средства ───
CREATE TABLE IF NOT EXISTS {{schema}}.vehicles (
    id            SERIAL PRIMARY KEY,
    client_id     INTEGER NOT NULL REFERENCES {{schema}}.clients(id) ON DELETE CASCADE,
    brand         VARCHAR(100) NOT NULL,
    model         VARCHAR(100),
    year          INTEGER,
    vin           VARCHAR(50),
    license_plate VARCHAR(20),
    color         VARCHAR(50),
    mileage       INTEGER,
    notes         TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_vehicles_client ON {{schema}}.vehicles(client_id);
CREATE INDEX IF NOT EXISTS idx_vehicles_plate  ON {{schema}}.vehicles(license_plate)
    WHERE license_plate IS NOT NULL;

-- ─── Услуги ───
CREATE TABLE IF NOT EXISTS {{schema}}.services (
    id           SERIAL PRIMARY KEY,
    name         VARCHAR(255) NOT NULL,
    price        DECIMAL(10,2) NOT NULL DEFAULT 0,
    duration     INTEGER NOT NULL DEFAULT 60,    -- минуты
    description  TEXT,
    category_id  INTEGER REFERENCES {{schema}}.categories(id) ON DELETE SET NULL,
    is_active    BOOLEAN NOT NULL DEFAULT true,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_services_active ON {{schema}}.services(is_active) WHERE is_active;

-- ─── Брони (записи в календаре) ───
-- master_id — UUID на saas_meta.users (cross-schema FK).
CREATE TABLE IF NOT EXISTS {{schema}}.bookings (
    id              SERIAL PRIMARY KEY,
    client_id       INTEGER REFERENCES {{schema}}.clients(id) ON DELETE SET NULL,
    vehicle_id      INTEGER REFERENCES {{schema}}.vehicles(id) ON DELETE SET NULL,
    service_id      INTEGER REFERENCES {{schema}}.services(id) ON DELETE SET NULL,
    master_id       UUID    REFERENCES saas_meta.users(id) ON DELETE SET NULL,
    date            DATE NOT NULL,
    time            TIME NOT NULL,
    end_time        TIME,
    status          VARCHAR(50) NOT NULL DEFAULT 'pending',
    payment_status  VARCHAR(50) NOT NULL DEFAULT 'unpaid',
    amount          DECIMAL(10,2),
    notes           TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_bookings_date    ON {{schema}}.bookings(date);
CREATE INDEX IF NOT EXISTS idx_bookings_client  ON {{schema}}.bookings(client_id);
CREATE INDEX IF NOT EXISTS idx_bookings_master  ON {{schema}}.bookings(master_id);
CREATE INDEX IF NOT EXISTS idx_bookings_status  ON {{schema}}.bookings(status);

-- ─── История работ клиента (детализация поверх booking) ───
-- В исходном CRM после миграций обзавелась полями advance/advance_date/end_date/
-- category_id/payment_status/tags. Включаем сразу.
CREATE TABLE IF NOT EXISTS {{schema}}.client_records (
    id              SERIAL PRIMARY KEY,
    client_id       INTEGER NOT NULL REFERENCES {{schema}}.clients(id) ON DELETE CASCADE,
    vehicle_id      INTEGER REFERENCES {{schema}}.vehicles(id) ON DELETE SET NULL,
    booking_id      INTEGER REFERENCES {{schema}}.bookings(id) ON DELETE SET NULL,
    category_id     INTEGER REFERENCES {{schema}}.categories(id) ON DELETE SET NULL,
    master_id       UUID    REFERENCES saas_meta.users(id) ON DELETE SET NULL,
    service_name    VARCHAR(255) NOT NULL,
    description     TEXT,
    amount          DECIMAL(10,2) NOT NULL DEFAULT 0,
    advance         DECIMAL(10,2) NOT NULL DEFAULT 0,
    advance_date    DATE,
    date            DATE NOT NULL,
    end_date        DATE,
    time            TIME,
    payment_status  VARCHAR(20) NOT NULL DEFAULT 'none'
                    CHECK (payment_status IN ('none', 'partial', 'paid', 'refunded')),
    is_paid         BOOLEAN NOT NULL DEFAULT false,
    is_completed    BOOLEAN NOT NULL DEFAULT false,
    tags            JSONB NOT NULL DEFAULT '[]'::jsonb,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_client_records_client  ON {{schema}}.client_records(client_id);
CREATE INDEX IF NOT EXISTS idx_client_records_vehicle ON {{schema}}.client_records(vehicle_id);
CREATE INDEX IF NOT EXISTS idx_client_records_date    ON {{schema}}.client_records(date DESC);
CREATE INDEX IF NOT EXISTS idx_client_records_booking ON {{schema}}.client_records(booking_id);

-- ─── Финансовые транзакции ───
CREATE TABLE IF NOT EXISTS {{schema}}.transactions (
    id                SERIAL PRIMARY KEY,
    type              VARCHAR(50) NOT NULL CHECK (type IN ('income', 'expense')),
    amount            DECIMAL(10,2) NOT NULL,
    category_id       INTEGER REFERENCES {{schema}}.categories(id) ON DELETE SET NULL,
    category          VARCHAR(255),         -- денормализация на момент создания
    description       TEXT,
    date              DATE NOT NULL DEFAULT CURRENT_DATE,
    time              TIME,
    booking_id        INTEGER REFERENCES {{schema}}.bookings(id) ON DELETE SET NULL,
    client_record_id  INTEGER REFERENCES {{schema}}.client_records(id) ON DELETE SET NULL,
    client_id         INTEGER REFERENCES {{schema}}.clients(id) ON DELETE SET NULL,
    created_by        UUID    REFERENCES saas_meta.users(id) ON DELETE SET NULL,
    tags              JSONB NOT NULL DEFAULT '[]'::jsonb,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_transactions_date    ON {{schema}}.transactions(date DESC);
CREATE INDEX IF NOT EXISTS idx_transactions_type    ON {{schema}}.transactions(type);
CREATE INDEX IF NOT EXISTS idx_transactions_client  ON {{schema}}.transactions(client_id);
CREATE INDEX IF NOT EXISTS idx_transactions_booking ON {{schema}}.transactions(booking_id);

-- ─── Задачи ───
CREATE TABLE IF NOT EXISTS {{schema}}.tasks (
    id            SERIAL PRIMARY KEY,
    title         VARCHAR(255) NOT NULL,
    description   TEXT,
    status        VARCHAR(50) NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'in_progress', 'done', 'cancelled')),
    priority      VARCHAR(50) NOT NULL DEFAULT 'medium'
                  CHECK (priority IN ('low', 'medium', 'high', 'urgent')),
    due_date      DATE,
    due_time      TIME,
    client_id     INTEGER REFERENCES {{schema}}.clients(id) ON DELETE SET NULL,
    vehicle_id    INTEGER REFERENCES {{schema}}.vehicles(id) ON DELETE SET NULL,
    assigned_to   UUID    REFERENCES saas_meta.users(id) ON DELETE SET NULL,
    completed_at  TIMESTAMPTZ,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_tasks_status   ON {{schema}}.tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_assigned ON {{schema}}.tasks(assigned_to);
CREATE INDEX IF NOT EXISTS idx_tasks_due      ON {{schema}}.tasks(due_date)
    WHERE status IN ('pending', 'in_progress');

-- ─── Связь тегов с произвольными сущностями ───
CREATE TABLE IF NOT EXISTS {{schema}}.entity_tags (
    id           SERIAL PRIMARY KEY,
    tag_id       INTEGER NOT NULL REFERENCES {{schema}}.tags(id) ON DELETE CASCADE,
    entity_type  VARCHAR(50) NOT NULL,
    entity_id    INTEGER NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (tag_id, entity_type, entity_id)
);
CREATE INDEX IF NOT EXISTS idx_entity_tags_entity ON {{schema}}.entity_tags(entity_type, entity_id);

-- ─── Пользовательские настройки приложения (kv) ───
CREATE TABLE IF NOT EXISTS {{schema}}.app_data (
    id          SERIAL PRIMARY KEY,
    key         VARCHAR(255) UNIQUE NOT NULL,
    value       JSONB,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─── Лог действий (audit) ───
-- user_id UUID на saas_meta.users; ON DELETE SET NULL чтобы не терять историю.
CREATE TABLE IF NOT EXISTS {{schema}}.activity_logs (
    id           BIGSERIAL PRIMARY KEY,
    user_id      UUID REFERENCES saas_meta.users(id) ON DELETE SET NULL,
    user_name    VARCHAR(255),                -- денормализация на момент действия
    action       VARCHAR(100) NOT NULL,
    entity_type  VARCHAR(100),
    entity_id    INTEGER,
    entity_name  VARCHAR(255),
    details      TEXT,
    ip_address   INET,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_activity_logs_created ON {{schema}}.activity_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_activity_logs_user    ON {{schema}}.activity_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_activity_logs_entity  ON {{schema}}.activity_logs(entity_type, entity_id);
