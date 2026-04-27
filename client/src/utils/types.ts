// Роль (после миграции 001_profile_and_roles.sql):
//   owner   — Собственник студии. Один на студию, создаётся при signup.
//             Видит админ-панель, активити-логи, биллинг.
//   manager — Менеджер: всё кроме админки и биллинга.
//   master  — Мастер: свои записи/задачи (фильтрация на клиенте).
export type Role = 'owner' | 'manager' | 'master';

export type PaymentStatus = 'none' | 'advance' | 'paid';

export type TransactionType = 'income' | 'expense';

// UserData приходит из /api/auth/me и /api/auth/login. На бэке id — UUID
// (saas_meta.users.id). isOwner оставлен как удобный derived-флаг для UI:
// проще писать `if (user.isOwner)`, чем `if (user.role === 'owner')`,
// и на этот флаг уже завязаны AdminPanel/ProfilePage/ClientDetails.
export interface UserData {
  id: string;            // UUID
  name: string;
  email: string;
  role: Role;
  isOwner: boolean;      // === (role === 'owner'); ставится в auth.normalizeUser
  loginDate: string;     // ISO; для отображения «вошёл такого-то»

  // Profile-поля (после миграции 001). Все опциональны: новый пользователь,
  // зарегистрированный до апдейта, может их не иметь.
  firstName?: string | null;
  lastName?: string | null;
  phone?: string | null;
  avatarPath?: string | null; // URL для <img>, обычно `/avatars/<uuid>.webp`
  createdAt?: string | null;

  // canViewFinance: true — у пользователя видна вкладка «Финансы».
  // Для master ВСЕГДА false (хардкод бэка).
  // Для owner ВСЕГДА true.
  // Для manager — по флагу users.can_view_finance, который собственник
  // переключает в админ-панели. Старые БД без миграции 003 → undefined,
  // тогда трактуем как true (см. canViewFinance() в utils/permissions.ts).
  canViewFinance?: boolean;

  // ISO; null если ни разу не логинился (новый сотрудник).
  lastLoginAt?: string | null;
}

// Studio — отдельный объект из /api/auth/me. Хранит подписочные данные;
// фронт показывает accessUntil в шапке/профиле для предупреждения о просрочке.
//
// ВАЖНО: поля camelCase, чтобы матчить /api/auth/me и /api/profile (оба
// возвращают именно так — см. server/routes/auth.cjs:392-400). Раньше тип
// был snake_case → App.tsx читал undefined и подписочный гейт ложно
// срабатывал.
export interface Studio {
  id: string;            // UUID
  name?: string;         // legacy alias displayName (оставлен для совместимости)
  displayName?: string;  // display_name из saas_meta.studios
  plan: string;          // 'trial' | 'solo' | 'studio' | 'cancelled'
  accessUntil: string;   // ISO timestamp; null/прошлое → подписка истекла
  isActive: boolean;

  createdAt?: string | null;
  schemaName?: string;
}

// ProfileResponse — структура GET /api/profile. Используется ProfilePage
// и AdminPanel (последний берёт limits для блокировки кнопки «Добавить»).
export interface ProfileResponse {
  user: {
    id: string;
    email: string;
    role: Role;
    name: string;
    firstName: string | null;
    lastName: string | null;
    phone: string | null;
    avatarPath: string | null;
    isActive: boolean;
    createdAt: string;
    // см. UserData.canViewFinance — те же правила.
    canViewFinance?: boolean;
    lastLoginAt?: string | null;
    // Telegram-привязка (Фаза 1 интеграции с TG-ботом). Если tgLinked=false —
    // ProfilePage показывает «Подключить Telegram» с deep-link на бота.
    tgLinked?: boolean;
    tgUsername?: string | null;
    tgLinkedAt?: string | null;
  };
  studio: {
    id: string;
    displayName: string;
    plan: string;
    planLabel: string;       // «Соло», «Студия», «Пробный»…
    planPriceRub: number;    // 4900 / 8900 / 0
    planUpgradeable: boolean;// показывать ли CTA «Повысить тариф»
    accessUntil: string;
    isActive: boolean;
    createdAt: string;
    // true → пользователь нажал «Отменить подписку».
    // Доступ сохраняется до accessUntil, но автопродления не будет.
    cancelPending: boolean;
    // Реквизиты для шапки PDF-документов (заполняются owner-ом в Профиле).
    // null до заполнения → в документе будет «—».
    inn: string | null;
    ogrn: string | null;
    legalAddress: string | null;
    actualAddress: string | null;
    contactPhone: string | null;
    contactEmail: string | null;
    guaranteeText: string | null;
    // Реферальная программа: уникальный 8-символьный код студии и текущий
    // баланс бонусов в копейках. Подробности — в saas-crm/server/sql/005.
    referralCode: string | null;
    bonusBalanceKop: number;
  };
  limits: {
    currentUsers: number;
    maxUsers: number;
    canAddUsers: boolean;
  };
}

export interface Booking {
  id: string | number;
  service: string;
  date: string;
  endDate?: string;
  time: string;
  amount: number | string;
  advance: number | string;
  advanceDate?: string;
  category?: string | number;
  paymentStatus: PaymentStatus;
  isPaid?: boolean;
  isCompleted?: boolean;
  saveError?: boolean;
  // master_id — UUID пользователя из /api/users (мастер, ведущий запись).
  // null если ещё не назначен. master_name приходит JOIN-ом с бэка для отображения.
  master_id?: string | null;
  master_name?: string | null;
}

export interface Client {
  id: string | number;
  name: string;
  phone?: string;
  email?: string;
  birthDate?: string;
  city?: string;
  source?: string;
  // поле branch удалено: в SaaS-модели нет филиалов
  carBrand?: string;
  carModel?: string;
  vin?: string;
  licensePlate?: string;
  comment?: string;
  createdDate?: string;
  records?: Booking[];
}

export interface Task {
  id: string | number;
  title: string;
  date: string;
  time?: string;
  completed: boolean;
  urgency: string;
  description?: string;
  clientId?: string | number | null;
  clientName?: string | null;
  // branch удалён.
  // assigned_to — UUID пользователя; assigned_to_name — JOIN с бэка.
  assigned_to?: string | null;
  assigned_to_name?: string | null;
  isOverdue?: boolean;
  saveError?: boolean;
}

export interface Transaction {
  id: string | number;
  description: string;
  amount: number;
  type: TransactionType;
  category?: string;
  tags?: (string | number)[];
  date?: string;
  createdDate?: string;
  created_at?: string;
  client_record_id?: number | null;
}

export interface CalendarEvent {
  id: string;
  clientId: string | number;
  recordId: string | number;
  // branch удалён.
  date: string;
  endDate?: string;
  time?: string;
  service?: string;
  title: string;
  type: string;
}

// Список пользователей студии для дропдаунов «мастер» в формах.
// Приходит из /api/users — без секретов (pwd_hash etc.).
export interface StudioUser {
  id: string;
  name: string;
  email: string;
  role: Role;
  is_active: boolean;
  // Поля, которые отдаёт расширенный /api/admin/users (для админ-панели).
  // На дропдауне «мастер» эти поля не используются, но тип общий — отметим
  // как опциональные.
  can_view_finance?: boolean;
  last_login_at?: string | null;
  avatar_path?: string | null;
  phone?: string | null;
  created_at?: string | null;
  // Расширенные профильные поля (миграция 001). Бэк /api/admin/users отдаёт их,
  // чтобы owner видел в карточках актуальные данные после изменений сотрудником
  // в /profile (имя, фамилия, аватар) без перезагрузки.
  first_name?: string | null;
  last_name?: string | null;
}

/**
 * Запись активити-лога. Приходит из GET /api/activity-logs.
 * action и entity_type — короткие строки в нижнем регистре, словарь см. в
 * utils/constants.ts (ACTION_LABELS, ENTITY_LABELS).
 *
 * entity_id хранится как TEXT (миграция 003) — поддерживает и SERIAL CRM-айди,
 * и UUID пользователей.
 */
export interface ActivityLogEntry {
  id: number;
  user_id: string | null;
  user_name: string | null;
  action: string;
  entity_type: string | null;
  entity_id: string | null;
  entity_name: string | null;
  details: string | null;
  ip_address: string | null;
  created_at: string;       // ISO timestamp
}
