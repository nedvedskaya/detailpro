# saas-crm — фундамент SaaS-CRM для детейлинг-студий

Это **не работающее приложение целиком**, а фундамент, в который заложены 5 запуск-блокеров из аудита. Любая фича CRM (Phase 1+) строится поверх этих инвариантов и не имеет права их обойти.

## Что здесь зашито с нулевого коммита

| # | Пункт | Файлы | Без чего нельзя запускаться |
|---|---|---|---|
| 1 | Sessions-based auth (не JWT) со схемой в строке сессии | `server/sql/000_saas_meta.sql`, `server/lib/auth.cjs` | Архитектурно: позволяет мгновенно разлогинивать студию при отмене подписки |
| 2 | Daily pg_dump с проверкой целостности и ротацией | `scripts/backup.sh`, `scripts/backup-cron.txt` | Один отказ диска без бэкапов = конец бизнеса |
| 3 | Webhook Продамуса с HMAC-подписью и идемпотентностью | `server/routes/webhooks.cjs` | Иначе любой POST'ит «оплачено» и получает подписку |
| 4 | Валидация и safe-quoting имени схемы | `server/lib/tenant.cjs` | SQL-injection через имя студии = слив всех клиентов |
| 9 | ФЗ-152: согласие на ОПД + privacy policy + аудит-таблица | `legal/`, `server/sql/000_saas_meta.sql` (`consents`) | Продамус не примет без политики, РКН штраф 500K-6M ₽ |

## Структура

```
saas-crm/
├── README.md                       — этот файл
├── .env.example                    — шаблон переменных окружения
├── .gitignore
├── package.json                    — минимум зависимостей
│
├── server/
│   ├── init.cjs                    — bootstrap: применяет 000_saas_meta.sql
│   ├── lib/
│   │   ├── tenant.cjs              — #4 валидация имени схемы + safeIdent
│   │   ├── auth.cjs                — #1 sessions create/verify/invalidate
│   │   ├── db.cjs                  — pg pool + safeQueryInSchema
│   │   └── middleware.cjs          — requireAuth, requireActiveStudio
│   ├── routes/
│   │   └── webhooks.cjs            — #3 Продамус webhook
│   └── sql/
│       └── 000_saas_meta.sql       — служебная схема (studios, sessions, payments, consents)
│
├── scripts/
│   ├── backup.sh                   — #2 daily pg_dump
│   └── backup-cron.txt             — пример crontab
│
└── legal/
    ├── privacy-policy.md           — #9 политика обработки ПД (текст для сайта)
    └── consent-text.md             — #9 текст чекбокса согласия в UI
```

## Как использовать

1. Скопировать `.env.example` → `.env`, заполнить
2. Создать БД и пользователя в Postgres (см. ниже)
3. `npm install`
4. `node server/init.cjs` — применит `000_saas_meta.sql`
5. Подключать модули из `server/lib/*` в Phase 1 кода

## Phase 1+ — что строится поверх этого фундамента

- Schema-per-tenant: при signup студии backend вызывает `tenant.createSchema(name)` (валидирует имя → `CREATE SCHEMA "studio_xxx"` → запускает скрипт инициализации таблиц CRM в этой схеме)
- Все запросы к данным студии идут через `db.queryInSchema(req.session.schema_name, sql, params)` — функция использует `safeIdent` и не позволяет передать невалидное имя
- Логин: `auth.createSession(userId, schemaName)` → token в HttpOnly cookie. Logout / cancel подписки → `auth.invalidateAllStudioSessions(schemaName)`

## Что в фундаменте НЕТ (намеренно отложено)

- React-фронтенд (берём из `~/Desktop/Crm-new-main/src/`)
- Telegram-бот (Phase 4-5)
- S3 для фото (Phase 8)
- Excel импорт (Phase 7)
- Реферальная программа (Phase 9)
- Мониторинг (Sentry/uptime — добавить в первую неделю production)
- Тенантные таблицы CRM (берём `initDatabase` из существующего `Crm-new-main/server/index.cjs:506-880` и применяем к каждой новой схеме)

## Почему именно эти 5 пунктов

Из panel-аудита (6 экспертов) выделены пункты, без которых проект **не имеет права принимать первый платёж**:
- финансовая безопасность (#3),
- безопасность данных (#4),
- сохранность данных (#2),
- юридическая допустимость (#9),
- архитектурный принцип ауt­а, который дороже менять потом (#1).

Остальные пункты аудита (мониторинг, бот, длинный trial, support-канал, retention policy, migration tooling) важны, но добавляются итеративно после старта.
