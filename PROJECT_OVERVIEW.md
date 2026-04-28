# ДЕТЕЙЛ ПРО CRM — обзор проекта

Документ для онбординга в проект (новый чат, новый разработчик, аудит).
Кратко: что это, на чём, как работает, где что лежит, как деплоить.

---

## 1. Что это

**SaaS-CRM для автодетейлинг-студий** на домене https://detailprocrm.ru.
Multi-tenant: каждая студия — отдельная Postgres-схема `studio_<slug>`,
изолированная от других. Управляется самозанятой Недведской Ольгой
Алексеевной (ИНН 401110148860).

Закрывает рабочий цикл студии:
- Клиенты + автомобили + история работ
- Календарь записей + задачи
- Приёмка авто (PDF-акты) + заказ-наряды (PDF)
- Финансы (доходы/расходы по категориям и тегам, аналитика)
- Telegram-бот (уведомления о записях, утренняя сводка, поддержка)
- Подписки + рекуррентные платежи через Prodamus
- Реферальная программа с бонусным балансом

### Тарифы (см. `server/lib/plans.cjs`)
| ID | Название | Цена | Кол-во юзеров | Утренняя сводка |
|---|---|---|---|---|
| `trial` | Пробный | 0 ₽ × 7 дней | 3 | ✅ (даём максимум фич) |
| `solo` | Соло | 4 900 ₽/мес или 49 900 ₽/год | 1 | ❌ (апсельный gap) |
| `studio` | Студия | 8 900 ₽/мес или 89 900 ₽/год | 3 | ✅ |
| `cancelled` | Отменён | — | 0 | ❌ |

Trial — 7 дней (`TRIAL_DAYS=7` в env). Есть кнопка «Удалить аккаунт»
с 30-дневным окном по 152-ФЗ (cron потом удаляет полностью).

---

## 2. Технологический стек

### Frontend (`client/`)
- **React 18 + TypeScript**
- **Vite 6** — сборка, dev-server, build → `client/dist/`
- **Tailwind CSS 4 (@tailwindcss/vite)** — утилитарные классы, без отдельного config-файла
- **lucide-react** — иконки
- **recharts** — графики в финансовой аналитике
- **exceljs** — экспорт в xlsx
- Build target: ES2022 (Chrome 109 / Safari 16 / Firefox 109+)
- Cookie-сессии (HttpOnly, SameSite=Lax)

### Backend (`server/`)
- **Node.js ≥22** + **Express**
- **PostgreSQL** (managed-кластер TimeWeb, через CA-cert)
- **node-postgres (pg)** напрямую, без ORM — параметризированные запросы
- **bcrypt** для паролей, **crypto** для токенов
- Cron — встроенный `setInterval` (`server/lib/cron.cjs`), без node-cron
- Telegram Bot API + опционально long-polling (`server/lib/telegram_polling.cjs`)
- PDF генерация — `pdfkit` в `server/lib/pdf/`

### Инфраструктура
- **VPS Ubuntu 24.04** на TimeWeb (IP 83.217.200.79)
- **nginx** на 443 (TLS через Let's Encrypt + certbot auto-renew)
- **systemd** unit `saas-crm.service` (Node app на порту 3001)
- **MTU 1400** на eth0 (см. `/etc/netplan/99-mtu-override.yaml`) — иначе большие assets виснут на ру-ISP

### Внешние сервисы
- **Prodamus** (https://payform.ru) — платежи + рекуррент + 54-ФЗ чеки через «Мой налог»
- **Telegram Bot API** — уведомления, восстановление пароля, поддержка, бот-онбординг
- **TimeWeb DB cloud** — managed PostgreSQL (хост, порт, CA-cert в `.env`)

---

## 3. Архитектура multi-tenant

### Database
- **`saas_meta` schema** (общая):
  - `studios` — все студии: id, schema_name, plan, access_until, bonus_balance_kop, daily_summary_time, deletion_requested_at, prodamus_subscription_id...
  - `users` — все юзеры всех студий (UUID PK), role ∈ {owner, manager, master}, tg_user_id, tg_chat_id
  - `sessions` — серверные сессии (cookie sid → запись в БД)
  - `payments` — все успешные платежи (UNIQUE order_id)
  - `payment_intents` — токены оплаты с TTL 60 мин
  - `consents` — согласия на ПДн/оферту/трансгран TG (для РКН-аудита)
  - `referral_events` — credit/debit бонусов (UNIQUE по order_id+kind)
  - `tg_link_tokens`, `tg_signup_tokens`, `tg_user_states`, `tg_messages_log`, `tg_processed_updates`, `tg_sent_reminders`, `webhook_log`, `support_requests`, `password_reset_tokens`

- **`studio_<slug>` schemas** (одна на студию, шаблон в `server/sql/100_tenant_template.sql`):
  - `clients` (с `is_demo`, `birth_date`, `notes` JSON для legacy car-полей)
  - `vehicles` (FK на clients ON DELETE CASCADE)
  - `services` (прайс-лист)
  - `bookings` (календарные слоты)
  - `client_records` (записи на услуги — основная сущность учёта)
  - `transactions` (финансы; есть денормализованный `client_name` для аналитики после удаления клиента)
  - `tasks` (задачи; авто-создаются в день рождения клиента)
  - `tags`, `categories`, `entity_tags`
  - `work_orders`, `acceptance_acts`, `order_photos` (документы)
  - `activity_logs` (audit)

### Защита изоляции
1. `safeIdent()` в `server/lib/db.cjs` — валидирует имя схемы regex'ом перед интерполяцией
2. `queryInSchema(schemaName, sql, params)` — единственная точка SQL с `{{schema}}`-плейсхолдером
3. Cross-tenant FK триггеры в `100_tenant_template.sql` (DO-блок на 9 таблиц) — БД-уровень defense-in-depth
4. `assertUserInStudio()` в `server/lib/tenant_security.cjs` — app-уровень проверка для FK на `saas_meta.users`
5. `requireAuth` + `requireActiveStudio` middleware в `server/lib/middleware.cjs`

---

## 4. Структура папок

```
saas-crm/
├── client/                          # React + Vite фронт
│   ├── public/
│   │   ├── favicon.svg              # оранжевый «ДП»
│   │   ├── fonts/                   # Inter (русский + латиница)
│   │   ├── manifest.json            # PWA
│   │   └── legal/                   # 5 юридических документов
│   │       ├── offer.html           # Договор-оферта
│   │       ├── privacy-policy/index.html
│   │       ├── personal-data-consent/index.html
│   │       ├── data-processing-agreement/index.html
│   │       └── referral-program/index.html
│   ├── src/
│   │   ├── app/
│   │   │   ├── App.tsx              # роутинг через pathname (без react-router)
│   │   │   ├── components/          # 20+ компонентов
│   │   │   │   ├── LoginScreen.tsx       # вход/регистрация + футер
│   │   │   │   ├── ProfilePage.tsx       # профиль + подписка + рефералка + удаление аккаунта
│   │   │   │   ├── AdminPanel.tsx        # owner-only админ
│   │   │   │   ├── MaterialsPage.tsx     # заглушка «в разработке»
│   │   │   │   ├── CalendarView.tsx
│   │   │   │   ├── ClientDetails.tsx     # карточка клиента
│   │   │   │   ├── ClientsView.tsx
│   │   │   │   ├── TasksView.tsx
│   │   │   │   ├── FinanceView.tsx       # операции + аналитика
│   │   │   │   ├── UserMenu.tsx          # выпадашка вверху (Профиль, Админ, Материалы, Выход)
│   │   │   │   ├── documents/
│   │   │   │   │   ├── AcceptanceActForm.tsx
│   │   │   │   │   └── WorkOrderForm.tsx
│   │   │   │   └── ui/                   # Modal, Button, Badge и т.п.
│   │   │   └── hooks/
│   │   ├── utils/
│   │   │   ├── api.ts               # все вызовы /api (типизированные)
│   │   │   ├── auth.ts              # localStorage user/studio
│   │   │   ├── helpers.ts           # форматтеры, normalizers, isBirthdayToday
│   │   │   ├── errorMessages.ts     # ERROR_TRANSLATIONS словарь (RU)
│   │   │   ├── permissions.ts       # canEdit, canManageReferrals и т.п.
│   │   │   ├── types.ts             # Studio, User, Role и т.п.
│   │   │   └── validation.ts
│   │   ├── styles/                  # tailwind.css, mobile.css, theme.css, fonts.css
│   │   └── main.tsx
│   ├── index.html
│   ├── vite.config.ts
│   └── tsconfig.json
│
├── server/
│   ├── server.cjs                   # entrypoint: app.listen + cron.start
│   ├── app.cjs                      # express app: middleware, mounts, /legal/, SPA-fallback
│   ├── init.cjs                     # `npm run init` — миграции при деплое
│   ├── migrate_tenants.cjs          # отдельный скрипт для переката tenant template
│   ├── lib/
│   │   ├── db.cjs                   # pool, queryInSchema, withTx, safeIdent
│   │   ├── auth.cjs                 # сессии, пароли, bcrypt
│   │   ├── middleware.cjs           # requireAuth, requireActiveStudio, requireRole, requireNotMaster
│   │   ├── tenant.cjs               # safeIdent, suggestSchemaName
│   │   ├── tenant_provisioning.cjs  # createStudio: schema, seed-categories, seed-demo
│   │   ├── tenant_security.cjs      # assertUserInStudio + cross-tenant FK guard
│   │   ├── plans.cjs                # PLANS, planMeta, planHasDailySummary
│   │   ├── payments.cjs             # createPaymentIntent, buildPayformUrl (discount_value)
│   │   ├── prodamus.cjs             # REST setActivity (отключение рекуррента)
│   │   ├── webhook_signing.cjs      # HMAC-SHA256 подпись Prodamus
│   │   ├── telegram.cjs             # call, sendMessage, через known-good IPv4
│   │   ├── telegram_polling.cjs     # long-polling fallback
│   │   ├── reminders.cjs            # daily_summary + hour_before
│   │   ├── birthdays.cjs            # авто-задача на ДР клиентов
│   │   ├── cron.cjs                 # setInterval: cleanup + reminders + birthdays
│   │   ├── cleanup.cjs              # retention: warning + delete по access_until/deletion_requested_at
│   │   ├── demo_seed.cjs            # 2 клиента + полный цикл при регистрации
│   │   ├── audit.cjs                # logAction в activity_logs
│   │   ├── security_log.cjs         # securityLog (warnings/critical в saas_meta)
│   │   ├── rate_limit.cjs           # in-memory rate-limit для login/signup
│   │   ├── one_time_token.cjs       # consumeOneTimeToken для TG-link
│   │   ├── gender.cjs               # applyGender для русских окончаний
│   │   ├── validation.cjs           # assertString, assertOptionalString, parseId
│   │   ├── formatting.cjs           # formatRub, formatDateRu (DRY-helpers)
│   │   ├── field_parser.cjs         # takeOptionalString
│   │   ├── queries.cjs              # getCurrentUser
│   │   └── pdf/                     # pdfkit-генераторы для актов и нарядов
│   ├── routes/
│   │   ├── auth.cjs                 # /api/auth: login, signup, logout, me, password-reset
│   │   ├── profile.cjs              # /api/profile/*: профиль, студия, аватар, demo, подписка, удаление
│   │   ├── admin.cjs                # /api/admin/*: пользователи студии (owner-only)
│   │   ├── tenant.cjs               # /api/{clients,vehicles,bookings,tasks,transactions,...} мульти-tenant
│   │   ├── documents.cjs            # /api/{work-orders,acceptance-acts,photos}/*
│   │   ├── webhooks.cjs             # POST /api/webhooks/prodamus (HMAC verify, idempotent)
│   │   └── telegram.cjs             # POST /api/tg/webhook (от Telegram) + бот-команды
│   └── sql/
│       ├── 000_saas_meta.sql        # studios, users, sessions, payments, consents, ...
│       ├── 001..015_*.sql           # инкрементальные миграции saas_meta
│       └── 100_tenant_template.sql  # шаблон per-tenant схемы (применяется при createStudio + при init.cjs)
│
├── scripts/
│   ├── deploy.sh                    # rsync + npm ci + npm run init + systemctl restart
│   ├── backup.sh                    # pg_dump
│   ├── nginx-saas-crm.conf          # сайт-конфиг nginx (с rate-limit, MIME, proxy)
│   ├── saas-crm.service             # systemd unit
│   ├── set-bot-description.cjs      # одноразово: BotFather description
│   └── set-bot-commands.cjs         # одноразово: меню бота (default + admin scope)
│
├── PROJECT_OVERVIEW.md              # этот файл
├── README.md                        # быстрый старт
└── package.json                     # scripts: init, dev, build, start
```

---

## 5. Ключевые потоки

### Регистрация (signup)
1. Юзер на `/` (LoginScreen) заполняет: studioName, firstName, lastName, email, password + 2 чекбокса (политика+согласие, оферта)
2. POST `/api/auth/signup` → `tenant_provisioning.createStudio`:
   - INSERT в `saas_meta.studios` с `access_until = now() + 7 days`
   - CREATE SCHEMA `studio_<slug>`
   - Apply `100_tenant_template.sql` к новой схеме
   - INSERT owner в `saas_meta.users`
   - Seed категорий + Seed демо-данных (`demo_seed.cjs`: 2 клиента с полным циклом, is_demo=TRUE)
   - Запись согласий в `saas_meta.consents`
3. Сервер ставит cookie `sid=...` (HttpOnly, SameSite=Lax)
4. Фронт переключается на главный экран

### Оплата подписки
1. Юзер в Профиле выбирает тариф → POST `/api/profile/payment/intent`
2. Сервер создаёт `payment_intents` (token + studio_id + plan + bonus_kop)
3. Фронт собирает URL: `payform.ru/<form-id>/?_param_intent=...&_param_plan=...&_param_bonus_kop=...&discount_value=<рубли>`
4. Юзер платит на Prodamus → webhook на `/api/webhooks/prodamus`
5. `webhooks.cjs`:
   - Verify HMAC-SHA256 (через `webhook_signing.cjs`)
   - INSERT payment ON CONFLICT DO NOTHING (идемпотентно)
   - Если `_param_intent` валидный → продлить `access_until`, активировать `plan`, debit бонусов, credit рефереру (1 раз)
   - Если `status='refunded'` → set access_until=now(), reverse рефер. бонусa если не потрачен
6. Бот шлёт TG-уведомление owner'у
7. Фронт через `usePaymentReturn` определяет успех и обновляет UI

### Утренняя сводка в Telegram
1. Owner (на trial или studio) выставляет время в Профиле → `daily_summary_time` в studios
2. Cron `reminders.cjs` каждые 5 минут:
   - Для каждой активной студии (где `planHasDailySummary` = true) проверяет окно [time, time+10min] в её часовом поясе
   - Достаёт все booked-записи на сегодня + все pending-задачи
   - Для каждого юзера студии шлёт сводку: записи + задачи (с именем+телефоном клиента, если задача привязана)
   - Идемпотентно: UNIQUE (user_id, kind, ref_date) в `tg_sent_reminders`

### Дни рождения клиентов
1. Owner заполняет `birth_date` клиента → если ДР сегодня, задача создаётся СРАЗУ (POST/PUT /clients)
2. Cron `birthdays.cjs` раз в сутки проходит по всем клиентам всех студий → создаёт задачу «Поздравить с ДР» на сегодня (priority=high, привязана к клиенту)
3. Идемпотентно: проверка по `client_id + due_date + LIKE 'Поздравить%'`

### Удаление аккаунта (152-ФЗ)
1. Owner в Профиле жмёт «Удалить аккаунт» с двойным confirm
2. POST `/api/profile/account/request-deletion` → set `deletion_requested_at = now()`
3. Юзер видит «Аккаунт будет удалён <через 30 дней>», может отменить
4. Cron `cleanup.cjs` раз в сутки:
   - `findExpiredStudios`: либо `access_until + 30d < now`, либо `deletion_requested_at + 30d < now`
   - `deleteStudio`: DROP SCHEMA + DELETE FROM studios + cleanup payments/consents

### Telegram-бот
- Webhook на `/api/tg/webhook` либо long-polling fallback
- Команды (см. `scripts/set-bot-commands.cjs`):
  - **Все**: /start, /open_crm, /referral, /tariffs, /time, /help, /unlink
  - **Только Olga (TG-id 472538427)**: /admin, /registrations, /payments
- Onboarding: при первом /start — спрашивает gender, timezone, время сводки (если applicable)
- Поддержка: state-машина `awaiting_support_message` → INSERT в `support_requests` → reply от админа в support-чате

---

## 6. Деплой и эксплуатация

### Быстрый деплой
```bash
bash scripts/deploy.sh
```
Этот скрипт:
1. Локально: `npm ci && npm run build` в `client/`
2. rsync репо на VPS (исключая node_modules, .env, var/, *.log)
3. На VPS: `npm ci --omit=dev` в server/, `npm run init` (миграции)
4. `ssh -tt sudo systemctl restart saas-crm` (-tt нужен для PTY)
5. curl `/api/health` → ожидаем 200

### ENV переменные (`.env` на VPS, не в git)
- `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`, `DB_CA_CERT_PATH`
- `SESSION_SECRET`, `SESSION_TTL_HOURS=720`, `SESSION_IDLE_HOURS=72`
- `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_USERNAME`, `SUPPORT_TG_CHAT_ID`
- `PRODAMUS_SECRET_KEY`, `PRODAMUS_API_BASE`
- `APP_ORIGIN=https://detailprocrm.ru`
- `TRIAL_DAYS=7`, `CRON_INTERVAL_MS=86400000`, `REMINDERS_INTERVAL_MS=300000`

### Бэкапы
`scripts/backup.sh` — pg_dump в `var/backups/`, ротация 14 дней. По cron на VPS.

### Логи
- App: `journalctl -u saas-crm` (нет structured-log файла, всё в systemd)
- Webhook: `saas_meta.webhook_log` (для аудита)
- Audit пользователей: `studio_<slug>.activity_logs`
- Security: `saas_meta.security_log` (через `securityLog` helper)

---

## 7. Текущие открытые вопросы

1. **Скидка через `discount_value`** на Prodamus paylink-формах не применяется. Ждём ответ поддержки Prodamus о механизме переопределения цены для статичных paylink (или придётся переходить на dynamic URL `?do=pay&sys=yalokontent&products[0][...]=...&signature=...`).

2. **Платежи / реферальная программа** работают на серверной стороне корректно (webhook верифицирует подпись, начисляет/списывает бонусы), но фактически юзер пока не может применить накопленную скидку до решения вопроса (1).

3. **Раздел «Материалы»** — заглушка. Будущий магазин допматериалов (тех. карты, чек-листы).

---

## 8. Что недавно делалось

См. `git log --oneline` за последние 50 коммитов — там есть feat/fix/refactor с подробными RU-описаниями.

Главные вехи последних 2 дней:
- Юр. документы (5 шт), чекбоксы регистрации, согласие на трансгран TG, удаление аккаунта по 152-ФЗ, footer
- Telegram-бот: утренняя сводка с временем, контактами клиента в задачах, дни рождения
- Демо-данные: 2 клиента с полным циклом при регистрации + кнопки seed/clear в Профиле
- Аудит безопасности: cleanup учитывает deletion_requested_at, refund реверсит реф. бонус, session TTL 14d → 3d, Esc для модалок
- DRY-рефакторинг: formatRub/formatDateRu, requireNotMaster, takeOptionalString, getCurrentUser
- Денормализация `transactions.client_name` для аналитики после удаления клиента
- Утренняя сводка теперь и на trial-плане (раньше — только studio)
- Админ-панель в TG-боте для Olga (/admin /registrations /payments)
