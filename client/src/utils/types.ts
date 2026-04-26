// Роль:
//   admin   — владелец/админ студии. Создаёт пользователей, видит активити-логи.
//             Заменяет старое 'owner'.
//   manager — менеджер: видит всё кроме админки.
//   master  — мастер: видит свои бронирования/задачи (бэк сейчас не фильтрует
//             по master — это поведенческий слой клиента, бэк отдаёт всё студии).
export type Role = 'admin' | 'manager' | 'master';

export type PaymentStatus = 'none' | 'advance' | 'paid';

export type TransactionType = 'income' | 'expense';

// UserData приходит из /api/auth/me и /api/auth/login. На бэке id — UUID
// (saas_meta.users.id). isOwner оставлен как удобный derived-флаг для UI:
// проще писать `if (user.isOwner)`, чем `if (user.role === 'admin')`,
// и на этот флаг уже завязаны AdminPanel/ProfilePage/ClientDetails.
export interface UserData {
  id: string;            // UUID
  name: string;
  email: string;
  role: Role;
  isOwner: boolean;      // === (role === 'admin'); ставится в auth.normalizeUser
  loginDate: string;     // ISO; для отображения «вошёл такого-то»
}

// Studio — отдельный объект из /api/auth/me. Хранит подписочные данные;
// фронт показывает access_until в шапке/профиле для предупреждения о просрочке.
export interface Studio {
  id: string;            // UUID
  name: string;          // display_name из saas_meta.studios
  plan: string;          // 'trial' | 'starter' | ... — пока строкой, тарифы потом
  access_until: string;  // ISO timestamp; null/прошлое → подписка истекла
  is_active: boolean;
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
