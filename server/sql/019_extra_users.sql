-- Дополнительные пользователи на тарифе Студия.
-- +1 000 ₽/мес за каждого пользователя сверх базовых 3.
-- extra_users_count = кол-во ДОПОЛНИТЕЛЬНЫХ слотов (0 = только базовые 3).

ALTER TABLE saas_meta.studios
  ADD COLUMN IF NOT EXISTS extra_users_count INTEGER NOT NULL DEFAULT 0;

-- Храним extra_users_count в intent, чтобы webhook знал сколько слотов активировать.
ALTER TABLE saas_meta.payment_intents
  ADD COLUMN IF NOT EXISTS extra_users_count INTEGER NOT NULL DEFAULT 0;
