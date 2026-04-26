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
}

// Studio — отдельный объект из /api/auth/me. Хранит подписочные данные;
// фронт показывает access_until в шапке/профиле для предупреждения о просрочке.
export interface Studio {
  id: string;            // UUID
  name: string;          // display_name из saas_meta.studios
  plan: string;          // 'trial' | 'solo' | 'studio' | 'cancelled'
  access_until: string;  // ISO timestamp; null/прошлое → подписка истекла
  is_active: boolean;

  // Опциональные поля из /api/auth/me и /api/profile (после wiring-а).
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
}
