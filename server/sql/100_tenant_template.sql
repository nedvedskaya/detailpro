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
-- type: 'all' — общий тег (виден везде), 'income' — только в доходных
-- финансовых операциях, 'expense' — только в расходных. Колонка добавлена
-- задним числом — для существующих студий миграция через ALTER ниже.
CREATE TABLE IF NOT EXISTS {{schema}}.tags (
    id           SERIAL PRIMARY KEY,
    name         VARCHAR(255) NOT NULL,
    color        VARCHAR(20),
    type         VARCHAR(20) NOT NULL DEFAULT 'all'
                 CHECK (type IN ('all', 'income', 'expense')),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Идемпотентная миграция для уже созданных студий.
ALTER TABLE {{schema}}.tags
  ADD COLUMN IF NOT EXISTS type VARCHAR(20) NOT NULL DEFAULT 'all';
-- ADD CONSTRAINT не имеет IF NOT EXISTS до PG 16; ловим duplicate_object,
-- чтобы повторный запуск миграции не падал. Имя схемы внутри SQL-литерала
-- не сравниваем — safeIdent заворачивает его в кавычки, и строка не
-- совпала бы с pg_namespace.nspname.
DO $$
BEGIN
  ALTER TABLE {{schema}}.tags
    ADD CONSTRAINT tags_type_check
    CHECK (type IN ('all', 'income', 'expense'));
EXCEPTION WHEN duplicate_object THEN NULL;
END
$$;

-- Дефолтные теги для финансовых операций. Чтобы новый юзер сразу видел
-- готовые подсказки в форме «Новая операция» (а не пустой блок «Теги»),
-- сидим 2 дохода + 2 расхода. Юзер может удалить или переименовать
-- любой тег в админке когда захочет — на свежей студии просто меньше
-- пустых полей.
--
-- WHERE NOT EXISTS вместо ON CONFLICT: уникального индекса по (name,type)
-- нет (юзер может создавать одноимённые теги в разных типах вручную),
-- поэтому проверяем явно. Идемпотентно: повторный прогон template ничего
-- не дублирует.
INSERT INTO {{schema}}.tags (name, type, color)
SELECT 'Полировка', 'income', '#22c55e'
WHERE NOT EXISTS (SELECT 1 FROM {{schema}}.tags WHERE name='Полировка' AND type='income');
INSERT INTO {{schema}}.tags (name, type, color)
SELECT 'Химчистка', 'income', '#06b6d4'
WHERE NOT EXISTS (SELECT 1 FROM {{schema}}.tags WHERE name='Химчистка' AND type='income');
INSERT INTO {{schema}}.tags (name, type, color)
SELECT 'Плёнка', 'expense', '#ef4444'
WHERE NOT EXISTS (SELECT 1 FROM {{schema}}.tags WHERE name='Плёнка' AND type='expense');
INSERT INTO {{schema}}.tags (name, type, color)
SELECT 'ЗП мастера Ивана', 'expense', '#f59e0b'
WHERE NOT EXISTS (SELECT 1 FROM {{schema}}.tags WHERE name='ЗП мастера Ивана' AND type='expense');

-- ─── Клиенты ───
-- is_demo: помечаем seed-данные, которые новый юзер видит при регистрации
-- (см. server/lib/demo_seed.cjs). Кнопка «Очистить демо» в профиле просто
-- удаляет всё с is_demo=true, не трогая реальные карточки.
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
    is_demo      BOOLEAN NOT NULL DEFAULT FALSE,
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
    is_demo       BOOLEAN NOT NULL DEFAULT FALSE,
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
    is_demo      BOOLEAN NOT NULL DEFAULT FALSE,
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
    is_demo         BOOLEAN NOT NULL DEFAULT FALSE,
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
                    CHECK (payment_status IN ('none', 'advance', 'paid')),
    is_paid         BOOLEAN NOT NULL DEFAULT false,
    is_completed    BOOLEAN NOT NULL DEFAULT false,
    tags            JSONB NOT NULL DEFAULT '[]'::jsonb,
    -- Список услуг записи (snapshot имя+цена+id на момент создания).
    -- Каждый элемент: {service_id?: int, name: string, price: number}.
    -- service_id = null → custom-строка (юзер ввёл имя+цену вручную, не из прайса).
    -- amount и service_name пересчитываются из этого массива на бэке.
    services        JSONB NOT NULL DEFAULT '[]'::jsonb,
    is_demo         BOOLEAN NOT NULL DEFAULT FALSE,
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
    -- Денормализованное имя клиента на момент создания транзакции. Нужно
    -- чтобы в финансовой аналитике сохранялся контекст «кому была работа»
    -- даже после удаления клиента (когда client_id уходит в NULL по
    -- ON DELETE SET NULL). Заполняется в POST/PUT /transactions из
    -- clients.name. Если клиент потом переименован — здесь остаётся
    -- старое имя на момент платежа, что корректно для бухгалтерии.
    client_name       VARCHAR(255),
    created_by        UUID    REFERENCES saas_meta.users(id) ON DELETE SET NULL,
    tags              JSONB NOT NULL DEFAULT '[]'::jsonb,
    is_demo           BOOLEAN NOT NULL DEFAULT FALSE,
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
    is_demo       BOOLEAN NOT NULL DEFAULT FALSE,
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

-- ════════════════════════════════════════════════════════════════════════
-- Документы по броням: акт приёмки и заказ-наряд.
--
-- Привязка 1:1 к bookings.id (UNIQUE(booking_id)) — на одну запись один
-- акт и один наряд. Удаление брони → CASCADE: документы и фото уезжают
-- вместе с ней.
--
-- ID-тип SERIAL/INTEGER (как и остальные per-tenant). Номер документа —
-- сам id (изолирован per-tenant SERIAL → автоинкремент внутри студии).
--
-- Подпись хранится как base64 PNG в `signature_data` (TEXT). Это упрощает
-- генерацию PDF (вшиваем data:image/png;base64,... напрямую) и не требует
-- отдельного хранилища. Размер обычно ≤30 KB на подпись.
--
-- pdf_path — путь к сгенерированному PDF на диске (var/documents/...). Может
-- быть NULL, пока документ не создан или подпись не получена.
-- ════════════════════════════════════════════════════════════════════════

-- ─── Заказ-наряд ───
-- ВАЖНО: документы (акт/наряд/фото) привязаны к client_records, а НЕ к bookings.
-- bookings — это слот в календаре (для master, может и не быть для записи извне).
-- client_records — первичная сущность учёта работ. Документ нужен на каждую
-- запись клиента, независимо от того, была ли календарная бронь.
CREATE TABLE IF NOT EXISTS {{schema}}.work_orders (
    id                SERIAL PRIMARY KEY,
    booking_id        INTEGER NOT NULL UNIQUE
                       REFERENCES {{schema}}.client_records(id) ON DELETE CASCADE,
    master_id         UUID REFERENCES saas_meta.users(id) ON DELETE SET NULL,
    delivery_date     DATE,
    delivery_time     TIME,
    payment_method    VARCHAR(20)
                      CHECK (payment_method IN ('cash', 'card', 'transfer') OR payment_method IS NULL),
    discount          DECIMAL(10,2) NOT NULL DEFAULT 0,
    total             DECIMAL(10,2) NOT NULL DEFAULT 0,
    -- items: [{name, quantity, price}]; денормализуем в JSON, потому что услуги
    -- в наряде — это снимок на момент оформления (мастер мог изменить цену).
    items             JSONB NOT NULL DEFAULT '[]'::jsonb,
    guarantee_text    TEXT,
    notes             TEXT,
    -- Snapshot данных клиента и авто на момент оформления документа.
    -- Позволяет вписать данные вручную, если в карточке клиента/авто их нет
    -- (например, разовая запись без vehicles-row), и не «забывает» данные,
    -- если карточка позже отредактирована.
    --   client_snapshot:  { name, phone, email }
    --   vehicle_snapshot: { brand, model, year, color, license_plate, vin }
    -- Поля на стороне приложения мерджатся ПОВЕРХ vehicle/client из БД.
    client_snapshot   JSONB NOT NULL DEFAULT '{}'::jsonb,
    vehicle_snapshot  JSONB NOT NULL DEFAULT '{}'::jsonb,
    signature_data    TEXT,                     -- base64 PNG с canvas-подписи клиента
    is_signed         BOOLEAN NOT NULL DEFAULT false,
    pdf_path          TEXT,                     -- /var/documents/work_orders/<id>.pdf
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by        UUID REFERENCES saas_meta.users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_work_orders_booking ON {{schema}}.work_orders(booking_id);
CREATE INDEX IF NOT EXISTS idx_work_orders_created ON {{schema}}.work_orders(created_at DESC);

-- ─── Акт приёмки ───
CREATE TABLE IF NOT EXISTS {{schema}}.acceptance_acts (
    id                  SERIAL PRIMARY KEY,
    booking_id          INTEGER NOT NULL UNIQUE
                         REFERENCES {{schema}}.client_records(id) ON DELETE CASCADE,
    master_id           UUID REFERENCES saas_meta.users(id) ON DELETE SET NULL,
    mileage             INTEGER,
    -- zones: [{zone_name, scratches, dents, condition: 'ok'|'damaged'|'minor', *_label}]
    -- 16 зон по умолчанию (см. seed в коде); поле всегда полный массив.
    zones               JSONB NOT NULL DEFAULT '[]'::jsonb,
    damage_description  TEXT,
    valuables           TEXT,                   -- ценные вещи в салоне
    -- См. комментарий у work_orders.client_snapshot/vehicle_snapshot —
    -- те же поля для акта приёмки.
    client_snapshot     JSONB NOT NULL DEFAULT '{}'::jsonb,
    vehicle_snapshot    JSONB NOT NULL DEFAULT '{}'::jsonb,
    -- денормализованный счётчик: real source — order_photos. Кешируем
    -- для быстрого вывода в шапке PDF (без подзапроса).
    photos_count        INTEGER NOT NULL DEFAULT 0,
    signature_data      TEXT,                   -- base64 PNG
    is_signed           BOOLEAN NOT NULL DEFAULT false,
    pdf_path            TEXT,                   -- /var/documents/acceptance_acts/<id>.pdf
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by          UUID REFERENCES saas_meta.users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_acceptance_acts_booking ON {{schema}}.acceptance_acts(booking_id);
CREATE INDEX IF NOT EXISTS idx_acceptance_acts_created ON {{schema}}.acceptance_acts(created_at DESC);

-- ─── Фото к броням (общий пул для акта/наряда) ───
-- photo_type разделяет фото приёмки (документально-важные) и
-- результата/прогресса (для портфолио). Хранятся на диске, file_path —
-- путь относительно var/uploads.
CREATE TABLE IF NOT EXISTS {{schema}}.order_photos (
    id              SERIAL PRIMARY KEY,
    booking_id      INTEGER NOT NULL REFERENCES {{schema}}.client_records(id) ON DELETE CASCADE,
    file_path       TEXT NOT NULL,
    thumbnail_path  TEXT,
    photo_type      VARCHAR(20) NOT NULL DEFAULT 'acceptance'
                    CHECK (photo_type IN ('acceptance', 'progress', 'result')),
    file_size       INTEGER,                    -- байты, для отчётов о хранилище
    mime_type       VARCHAR(50),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by      UUID REFERENCES saas_meta.users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_order_photos_booking ON {{schema}}.order_photos(booking_id);
CREATE INDEX IF NOT EXISTS idx_order_photos_type    ON {{schema}}.order_photos(photo_type);

-- ─── Лог действий (audit) ───
-- user_id UUID на saas_meta.users; ON DELETE SET NULL чтобы не терять историю.
CREATE TABLE IF NOT EXISTS {{schema}}.activity_logs (
    id           BIGSERIAL PRIMARY KEY,
    user_id      UUID REFERENCES saas_meta.users(id) ON DELETE SET NULL,
    user_name    VARCHAR(255),                -- денормализация на момент действия
    action       VARCHAR(100) NOT NULL,
    entity_type  VARCHAR(100),
    entity_id    TEXT,                        -- TEXT, чтобы вмещало UUID и SERIAL
    entity_name  VARCHAR(255),
    details      TEXT,
    ip_address   INET,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_activity_logs_created ON {{schema}}.activity_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_activity_logs_user    ON {{schema}}.activity_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_activity_logs_entity  ON {{schema}}.activity_logs(entity_type, entity_id);

-- ──────────────────────────────────────────────────────────────────────
-- Cross-tenant guard на FK-колонки на saas_meta.users.
--
-- Зачем: см. server/sql/012_cross_tenant_triggers.sql и
-- server/lib/tenant_security.cjs. Postgres-FK гарантирует что user
-- существует, но не что он из ТОЙ ЖЕ студии. Триггер вызывает
-- saas_meta.check_user_belongs_to_studio('column_name') и кидает
-- check_violation если user принадлежит чужой студии.
--
-- App-level (assertUserInStudio в роутах) даёт чистую 400-ошибку,
-- БД-уровень — последний рубеж если разработчик добавил новый роут
-- и забыл вызвать helper. Defense-in-depth.
--
-- Идемпотентно: DROP TRIGGER IF EXISTS перед CREATE.
-- ──────────────────────────────────────────────────────────────────────

-- Список (table → колонки-FK на saas_meta.users) лежит ОДИН раз в JSONB.
-- При добавлении новой колонки достаточно вписать строку в spec — DO-блок
-- сам построит DROP IF EXISTS + CREATE TRIGGER. Раньше каждый триггер был
-- 3-строчной копипастой на 9 таблиц = 27 строк boilerplate'а, которые надо
-- было править параллельно при любом изменении.
--
-- Имя триггера фиксированное `check_<col>_in_studio` — то же что было до
-- рефакторинга, чтобы DROP IF EXISTS снёс старые триггеры без residue.
--
-- Безопасность: имена столбцов — литералы из этого файла, не user-input.
-- {{schema}} уже к этому моменту заменён в app-коде через safeIdent
-- (см. server/lib/db.cjs:queryInSchema), на месте подстановки —
-- валидный quoted-identifier вида "studio_xxx".
DO $cross_tenant_triggers$
DECLARE
  spec JSONB := '{
    "bookings":         ["master_id"],
    "tasks":            ["assigned_to"],
    "client_records":   ["master_id"],
    "transactions":     ["created_by"],
    "work_orders":      ["master_id", "created_by"],
    "acceptance_acts":  ["master_id", "created_by"],
    "order_photos":     ["created_by"],
    "activity_logs":    ["user_id"]
  }';
  tbl  TEXT;
  cols JSONB;
  col  TEXT;
BEGIN
  FOR tbl, cols IN SELECT key, value FROM jsonb_each(spec) LOOP
    FOR col IN SELECT jsonb_array_elements_text(cols) LOOP
      EXECUTE format(
        'DROP TRIGGER IF EXISTS check_%I_in_studio ON {{schema}}.%I',
        col, tbl
      );
      EXECUTE format(
        'CREATE TRIGGER check_%I_in_studio
           BEFORE INSERT OR UPDATE OF %I ON {{schema}}.%I
           FOR EACH ROW EXECUTE FUNCTION saas_meta.check_user_belongs_to_studio(%L)',
        col, col, tbl, col
      );
    END LOOP;
  END LOOP;
END
$cross_tenant_triggers$;

-- ──────────────────────────────────────────────────────────────────────
-- Идемпотентные ADD COLUMN — для уже созданных студий, которые были
-- зарегистрированы до появления is_demo. Шаблон гонится через
-- migrateAllStudios() в server/init.cjs при каждом npm run init.
-- Новые студии получают is_demo сразу из CREATE TABLE выше.
-- ──────────────────────────────────────────────────────────────────────
ALTER TABLE {{schema}}.clients         ADD COLUMN IF NOT EXISTS is_demo BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE {{schema}}.vehicles        ADD COLUMN IF NOT EXISTS is_demo BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE {{schema}}.services        ADD COLUMN IF NOT EXISTS is_demo BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE {{schema}}.bookings        ADD COLUMN IF NOT EXISTS is_demo BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE {{schema}}.client_records  ADD COLUMN IF NOT EXISTS is_demo BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE {{schema}}.client_records  ADD COLUMN IF NOT EXISTS services JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE {{schema}}.transactions    ADD COLUMN IF NOT EXISTS is_demo BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE {{schema}}.tasks           ADD COLUMN IF NOT EXISTS is_demo BOOLEAN NOT NULL DEFAULT FALSE;

-- Денормализация client_name в транзакциях. Если клиент удалён —
-- ON DELETE SET NULL на client_id обнулит ссылку, но имя останется
-- здесь и в аналитике юзер увидит «8000₽ — Иван Петров (удалён)»
-- вместо «8000₽ — без клиента».
ALTER TABLE {{schema}}.transactions    ADD COLUMN IF NOT EXISTS client_name VARCHAR(255);

-- Backfill: для уже существующих транзакций, у которых client_id есть,
-- но client_name не заполнен (NULL — добавлено только что или
-- историческая запись), копируем имя из clients. Идемпотентно: при
-- повторном прогоне меняет только NULL-ы. Не трогает строки, где
-- client_name уже зафиксирован (на случай если клиента переименовали).
UPDATE {{schema}}.transactions t
   SET client_name = c.name
  FROM {{schema}}.clients c
 WHERE c.id = t.client_id
   AND t.client_name IS NULL;
