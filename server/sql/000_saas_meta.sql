-- saas-crm: служебная схема (одна на инстанс).
-- Клиентские схемы вида studio_xxx содержат только данные одной студии.
-- Этот файл идемпотентен: можно запускать многократно.

CREATE SCHEMA IF NOT EXISTS saas_meta;

-- ──────────────────────────────────────────────────────────────────────
-- studios: реестр студий (тенантов).
-- schema_name — реальная Postgres-схема, где лежат данные этой студии.
-- access_until — до какой даты у студии есть доступ (trial или подписка).
-- ──────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS saas_meta.studios (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    schema_name     TEXT NOT NULL UNIQUE
                    CHECK (schema_name ~ '^[a-z][a-z0-9_]{2,31}$'
                           AND schema_name <> 'saas_meta'
                           AND schema_name NOT LIKE 'pg\_%'),
    display_name    TEXT NOT NULL,
    plan            TEXT NOT NULL DEFAULT 'trial'
                    CHECK (plan IN ('trial', 'solo', 'studio', 'cancelled')),
    access_until    TIMESTAMPTZ NOT NULL,
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_studios_active ON saas_meta.studios(is_active) WHERE is_active;
CREATE INDEX IF NOT EXISTS idx_studios_access_until ON saas_meta.studios(access_until);

-- ──────────────────────────────────────────────────────────────────────
-- users: пользователи студий (для логина).
-- email уникален в пределах ВСЕЙ системы — один email = одна студия.
-- Если хочется «один человек — две студии», поменяй уникальность на
-- (studio_id, email).
-- ──────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS saas_meta.users (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    studio_id       UUID NOT NULL REFERENCES saas_meta.studios(id) ON DELETE CASCADE,
    email           TEXT NOT NULL UNIQUE,
    password_hash   TEXT NOT NULL,         -- scrypt в формате '<hex>.<saltHex>'
    role            TEXT NOT NULL DEFAULT 'admin'
                    CHECK (role IN ('admin', 'manager', 'employee')),
    name            TEXT,
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_users_studio ON saas_meta.users(studio_id);

-- ──────────────────────────────────────────────────────────────────────
-- sessions: вместо JWT — таблица сессий со схемой студии.
-- Это даёт мгновенную инвалидацию (logout, отмена подписки → DELETE WHERE schema_name = ...).
-- token: 32 байта рандома → base64url. Нельзя восстановить из БД (хранится как plain
-- text, потому что брутфорс 32 байт нереалистичен; альтернатива — sha256).
-- ──────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS saas_meta.sessions (
    token           TEXT PRIMARY KEY,
    user_id         UUID NOT NULL REFERENCES saas_meta.users(id) ON DELETE CASCADE,
    studio_id       UUID NOT NULL REFERENCES saas_meta.studios(id) ON DELETE CASCADE,
    schema_name     TEXT NOT NULL,
    expires_at      TIMESTAMPTZ NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_used_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    remember_me     BOOLEAN NOT NULL DEFAULT FALSE,
    user_agent      TEXT,
    ip              INET
);
ALTER TABLE saas_meta.sessions
    ADD COLUMN IF NOT EXISTS remember_me BOOLEAN NOT NULL DEFAULT FALSE;
CREATE INDEX IF NOT EXISTS idx_sessions_user ON saas_meta.sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_studio ON saas_meta.sessions(studio_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON saas_meta.sessions(expires_at);

-- ──────────────────────────────────────────────────────────────────────
-- payments: журнал платежей от Продамуса.
-- order_id уникален — это и есть idempotency-ключ.
-- raw_payload — оригинальный webhook (jsonb), для аудита и спорных платежей.
-- ──────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS saas_meta.payments (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id        TEXT NOT NULL UNIQUE,
    studio_id       UUID REFERENCES saas_meta.studios(id),
    amount_kop      BIGINT NOT NULL,        -- копейки, целое число — без округления
    currency        TEXT NOT NULL DEFAULT 'RUB',
    status          TEXT NOT NULL
                    CHECK (status IN ('pending', 'paid', 'failed', 'refunded')),
    plan            TEXT,                   -- 'solo' | 'studio'
    raw_payload     JSONB NOT NULL,
    received_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    processed_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_payments_studio ON saas_meta.payments(studio_id);
CREATE INDEX IF NOT EXISTS idx_payments_status ON saas_meta.payments(status);

-- ──────────────────────────────────────────────────────────────────────
-- consents: аудит-таблица согласий на обработку ПД (ФЗ-152, ст.9).
-- Закон требует подтверждаемого согласия. Запись неудаляемая.
-- ──────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS saas_meta.consents (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID REFERENCES saas_meta.users(id),
    email           TEXT NOT NULL,          -- дублируем, т.к. user может быть удалён
    consent_type    TEXT NOT NULL
                    CHECK (consent_type IN ('personal_data', 'marketing', 'terms')),
    policy_version  TEXT NOT NULL,          -- версия документа, на который согласились
    policy_url      TEXT NOT NULL,
    given_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    revoked_at      TIMESTAMPTZ,
    ip              INET,
    user_agent      TEXT
);
CREATE INDEX IF NOT EXISTS idx_consents_user ON saas_meta.consents(user_id);
CREATE INDEX IF NOT EXISTS idx_consents_email ON saas_meta.consents(email);

-- ──────────────────────────────────────────────────────────────────────
-- webhook_log: сырой лог входящих webhook-вызовов для аудита и debugging.
-- Хранит даже невалидные (неверная подпись) — чтобы понимать атаки.
-- ──────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS saas_meta.webhook_log (
    id              BIGSERIAL PRIMARY KEY,
    source          TEXT NOT NULL,          -- 'prodamus' | ...
    received_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    ip              INET,
    signature_valid BOOLEAN NOT NULL,
    raw_body        TEXT NOT NULL,
    response_status INTEGER,
    error_message   TEXT
);
CREATE INDEX IF NOT EXISTS idx_webhook_log_received ON saas_meta.webhook_log(received_at DESC);

-- ──────────────────────────────────────────────────────────────────────
-- Расширения (если ещё не включены)
-- ──────────────────────────────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS "pgcrypto";  -- для gen_random_uuid()
