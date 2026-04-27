-- saas-crm: миграция 004 — реквизиты студии для документов (акт приёмки, заказ-наряд).
--
-- Что делает:
--   Добавляет в saas_meta.studios юридические/контактные поля, которые
--   подставляются в шапку PDF-документов (акт приёмки авто, заказ-наряд).
--   Заполняется один раз владельцем в разделе «Профиль → Реквизиты студии»
--   и далее автоматически попадает в каждый сгенерированный документ.
--
-- Все поля nullable: до заполнения студия может пользоваться CRM, но при
-- генерации документа выводится «—» вместо отсутствующих реквизитов.
--
-- Идемпотентна: ADD COLUMN IF NOT EXISTS.
--
-- Применить: psql ... -f server/sql/004_studio_legal_details.sql
-- (или `npm run init`)

ALTER TABLE saas_meta.studios
    ADD COLUMN IF NOT EXISTS inn             TEXT,    -- ИНН (10 для юрлица, 12 для ИП)
    ADD COLUMN IF NOT EXISTS ogrn            TEXT,    -- ОГРН (13) или ОГРНИП (15)
    ADD COLUMN IF NOT EXISTS legal_address   TEXT,    -- юридический адрес
    ADD COLUMN IF NOT EXISTS actual_address  TEXT,    -- фактический адрес студии (для шапки документа)
    ADD COLUMN IF NOT EXISTS contact_phone   TEXT,    -- телефон студии
    ADD COLUMN IF NOT EXISTS contact_email   TEXT,    -- email студии
    ADD COLUMN IF NOT EXISTS guarantee_text  TEXT;    -- текст блока «Гарантия» в заказ-наряде

-- Длины не ограничиваем CHECK на уровне БД — валидация в API
-- (PATCH /api/profile/studio проверяет ≤500 на текстовые, ≤20 на ИНН/ОГРН).
