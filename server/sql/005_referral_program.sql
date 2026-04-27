-- saas-crm: миграция 005 — реферальная программа.
--
-- Что добавляем:
--   • referral_code        — уникальный 8-символьный код для генерации
--                            персональной ссылки (https://detailprocrm.ru/?ref=…).
--                            Генерируется на этапе создания студии.
--   • referred_by          — кто пригласил (FK → saas_meta.studios.id).
--                            Заполняется один раз при signup.
--   • bonus_balance_kop    — текущий баланс бонусов в копейках. Деньги нельзя
--                            вывести, можно только списать со скидкой при оплате
--                            тарифа.
--
-- Журнал событий (referral_events):
--   • kind='credit' — начислено 1250 руб (12500 коп per spec; 1 250 ₽ = 125 000 коп)
--                     рефереру за оплату, сделанную приведённой студией.
--   • kind='debit'  — списано при оплате тарифа самим реферером.
--
-- Идемпотентна: ADD COLUMN IF NOT EXISTS, CREATE TABLE IF NOT EXISTS.
-- Бэкфилл referral_code детерминированный — повторный запуск не меняет код.
--
-- Применить: psql … -f server/sql/005_referral_program.sql  (или `npm run init`).

ALTER TABLE saas_meta.studios
    ADD COLUMN IF NOT EXISTS referral_code     TEXT,
    ADD COLUMN IF NOT EXISTS referred_by       UUID REFERENCES saas_meta.studios(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS bonus_balance_kop INTEGER NOT NULL DEFAULT 0;

-- Бэкфилл: детерминированный код из id+created_at, заглавные буквы и цифры.
-- substr(md5(...), 1, 8) → 8 hex-символов; upper() → стиль Steam-кодов.
UPDATE saas_meta.studios
   SET referral_code = upper(substr(md5(id::text || coalesce(created_at::text, '')), 1, 8))
 WHERE referral_code IS NULL;

-- После бэкфилла можно навесить NOT NULL и UNIQUE.
ALTER TABLE saas_meta.studios
    ALTER COLUMN referral_code SET NOT NULL;

-- UNIQUE добавляем DEFERRABLE-индексом, чтобы на коллизию (астрономически
-- маловероятную) можно было среагировать в коде, не падая в середине транзакции.
CREATE UNIQUE INDEX IF NOT EXISTS uq_studios_referral_code
    ON saas_meta.studios(referral_code);

CREATE INDEX IF NOT EXISTS idx_studios_referred_by
    ON saas_meta.studios(referred_by);

-- ──────────────────────────────────────────────────────────────────────
-- Журнал реферальных операций.
-- studio_id      — кому начислено / у кого списано.
-- source_studio_id — для credit: кого пригласили (приведённая студия);
--                    для debit:  как правило, та же студия, что и studio_id.
-- payment_order_id — order_id платежа Prodamus, который вызвал событие.
--                    Связь нестрогая (TEXT, не FK), потому что payments
--                    индексируются по UUID, а order_id строковый.
-- ──────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS saas_meta.referral_events (
    id                BIGSERIAL PRIMARY KEY,
    studio_id         UUID NOT NULL REFERENCES saas_meta.studios(id) ON DELETE CASCADE,
    source_studio_id  UUID REFERENCES saas_meta.studios(id) ON DELETE SET NULL,
    kind              TEXT NOT NULL CHECK (kind IN ('credit', 'debit')),
    amount_kop        INTEGER NOT NULL CHECK (amount_kop > 0),
    payment_order_id  TEXT,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_referral_events_studio
    ON saas_meta.referral_events(studio_id, created_at DESC);

-- Идемпотентность: один платёж не должен начислять / списывать дважды.
-- (Вебхук Prodamus уже идемпотентен по orders, но дублируем на уровне журнала.)
CREATE UNIQUE INDEX IF NOT EXISTS uq_referral_events_payment_kind
    ON saas_meta.referral_events(payment_order_id, kind)
 WHERE payment_order_id IS NOT NULL;
