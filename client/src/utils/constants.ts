import type { Role, PaymentStatus } from './types';

// === РОЛИ ===
// owner   — Собственник (создатель студии, единственный, не создаётся через UI)
// manager — Менеджер: всё кроме админки и биллинга
// master  — Мастер: свои записи/задачи
export const ROLE_NAMES: Record<Role, string> = {
  owner: 'Собственник',
  manager: 'Менеджер',
  master: 'Мастер'
};

export const getRoleName = (role: Role | string): string => {
  return ROLE_NAMES[role as Role] || role;
};

// === СТАТУСЫ ОПЛАТЫ ===
export const PAYMENT_STATUSES: Array<{ value: PaymentStatus; label: string; color: string }> = [
  { value: 'none', label: 'Не оплачено', color: 'gray' },
  { value: 'advance', label: 'Аванс', color: 'orange' },
  { value: 'paid', label: 'Оплачено', color: 'orange' }
];

export const getPaymentStatusLabel = (status: PaymentStatus | string): string => {
  return PAYMENT_STATUSES.find(s => s.value === status)?.label || status;
};

// === ТИПЫ ТРАНЗАКЦИЙ ===
export const TRANSACTION_TYPES = {
  income: { label: 'Доход', labelPlural: 'Доходы' },
  expense: { label: 'Расход', labelPlural: 'Расходы' }
} as const;

export const getTransactionTypeLabel = (type: string): string => {
  return TRANSACTION_TYPES[type as keyof typeof TRANSACTION_TYPES]?.label || type;
};

// BRANCHES удалены — в SaaS multi-tenant модели нет филиалов.

// === ПРИОРИТЕТЫ ЗАДАЧ ===
export const TASK_URGENCY = {
  HIGH: { id: 'high', label: 'Срочно', color: 'bg-red-100 text-red-700 border-red-200' },
  MEDIUM: { id: 'medium', label: 'Важно', color: 'bg-amber-100 text-amber-700 border-amber-200' },
  LOW: { id: 'low', label: 'Норм', color: 'bg-zinc-50 text-zinc-500 border-zinc-200' }
};

// === СТИЛИ КНОПОК И КАРТОЧЕК ===
export const BTN_METAL = "bg-gradient-to-b from-white to-zinc-200 border border-zinc-300 text-zinc-800 shadow-sm active:from-zinc-200 active:to-zinc-300 active:scale-95 transition-all";
export const BTN_METAL_DARK = "bg-gradient-to-b from-zinc-700 via-zinc-800 to-black border border-zinc-900 text-zinc-100 shadow-md active:scale-95 transition-all";
export const CARD_METAL = "bg-gradient-to-br from-white to-zinc-50 border border-zinc-200 shadow-sm";

// === БАЗА ДАННЫХ АВТОМОБИЛЕЙ ===
export const CAR_DATABASE = {
  'BMW': ['M5 F90', 'X5 G05', 'X6 G06', '3 Series G20', '4 Series G22', 'X7 G07', '7 Series G70'],
  'Mercedes': ['GLE Coupe', 'E-Class W213', 'S-Class W223', 'G-Class', 'C-Class W206', 'GLS X167', 'AMG GT'],
  'Toyota': ['Camry 3.5 (70)', 'Land Cruiser 300', 'RAV4', 'Camry (55)', 'Prado 150', 'Hilux'],
  'Audi': ['RS6', 'Q8', 'A6', 'A4', 'A5', 'Q7', 'e-tron'],
  'Tank': ['300', '500'],
  'Lexus': ['LX 570', 'RX 350', 'ES 250', 'GX 460', 'LS 500'],
  'Geely': ['Monjaro', 'Tugella', 'Coolray', 'Atlas Pro', 'Okavango'],
  'LiXiang': ['L7', 'L8', 'L9'],
  'Zeekr': ['001', '009', 'X'],
  'Porsche': ['Panamera', 'Cayenne', 'Macan', '911', 'Taycan'],
  'Hyundai': ['Tucson', 'Santa Fe', 'Palisade', 'Solaris', 'Elantra']
};

export const CAR_ALIASES = {
  'бмв': 'BMW', 'bmw': 'BMW',
  'мерседес': 'Mercedes', 'mercedes': 'Mercedes', 'мерс': 'Mercedes',
  'тойота': 'Toyota', 'toyota': 'Toyota', 'камри': 'Toyota',
  'ауди': 'Audi', 'audi': 'Audi',
  'танк': 'Tank', 'tank': 'Tank',
  'лексус': 'Lexus', 'lexus': 'Lexus',
  'джили': 'Geely', 'geely': 'Geely',
  'лисян': 'LiXiang', 'lixiang': 'LiXiang', 'ли': 'LiXiang',
  'зикр': 'Zeekr', 'zeekr': 'Zeekr',
  'порше': 'Porsche', 'porsche': 'Porsche',
  'хендай': 'Hyundai', 'hyundai': 'Hyundai', 'хендэ': 'Hyundai', 'солярис': 'Hyundai'
};

// === ГОРОДА ===
export const CITIES_DATABASE = [
  'Москва', 
  'Ростов-на-Дону', 
  'Санкт-Петербург', 
  'Краснодар', 
  'Сочи', 
  'Воронеж', 
  'Казань', 
  'Екатеринбург', 
  'Новосибирск', 
  'Нижний Новгород'
];

// === ПАЛИТРА ЦВЕТОВ ===
export const COLORS = [
    '#ef4444', '#f97316', '#f59e0b', '#eab308', '#84cc16', 
    '#22c55e', '#10b981', '#14b8a6', '#06b6d4', '#0ea5e9',
    '#3b82f6', '#6366f1', '#8b5cf6', '#a855f7', '#d946ef',
    '#ec4899', '#f43f5e'
];

// === НАЧАЛЬНЫЕ ДАННЫЕ ===
export const INITIAL_CLIENTS = [];
export const INITIAL_TASKS = [];
export const INITIAL_TRANSACTIONS = [];

// === АКТИВИТИ-ЛОГ ===
// Словарь action → русская подпись для AdminPanel→Активность.
// Сами строки action приходят с бэка как короткие глаголы:
//   create | update | delete | login | logout | block | unblock | password_reset
// Чтобы UI показывал «Сотрудник заблокирован» вместо "user.block",
// строим лейбл через комбинацию entity_type + action в getActionLabel().
export const ACTION_LABELS: Record<string, string> = {
  // session: вход/выход
  'session.login':           'Вход в систему',
  'session.logout':          'Выход',

  // user: админские действия с сотрудниками
  'user.create':             'Сотрудник добавлен',
  'user.update':             'Сотрудник изменён',
  'user.delete':             'Сотрудник удалён',
  'user.block':              'Сотрудник заблокирован',
  'user.unblock':            'Сотрудник разблокирован',
  'user.password_reset':     'Сброшен пароль',

  // CRM-сущности
  'client.create':           'Клиент добавлен',
  'client.update':           'Клиент изменён',
  'client.delete':           'Клиент удалён',

  'vehicle.create':          'Авто добавлено',
  'vehicle.update':          'Авто изменено',
  'vehicle.delete':          'Авто удалено',

  'booking.create':          'Запись создана',
  'booking.update':          'Запись изменена',
  'booking.delete':          'Запись удалена',

  'task.create':             'Задача создана',
  'task.update':             'Задача изменена',
  'task.delete':             'Задача удалена',

  'transaction.create':      'Финоперация добавлена',
  'transaction.update':      'Финоперация изменена',
  'transaction.delete':      'Финоперация удалена',

  'client_record.create':    'История: запись добавлена',
  'client_record.update':    'История: запись изменена',
  'client_record.delete':    'История: запись удалена',
};

// Цветовая группировка для AdminPanel→Активность.
// Чисто визуальная подсказка: создание зелёным, изменение — синим, удаление —
// красным, всё остальное — нейтрально-серым.
export const ACTION_TONES: Record<string, 'green' | 'blue' | 'red' | 'gray'> = {
  create: 'green',
  update: 'blue',
  delete: 'red',
  login: 'gray',
  logout: 'gray',
  block: 'red',
  unblock: 'green',
  password_reset: 'blue',
};

/**
 * Подбирает русскую подпись для строки активити-лога.
 * Сначала пытается матчить по `${entity_type}.${action}` (наиболее точно);
 * если такой ключ не найден — фолбек на сам action и затем на капитализацию.
 */
export function getActionLabel(action: string, entityType?: string | null): string {
  if (entityType) {
    const composite = `${entityType}.${action}`;
    if (ACTION_LABELS[composite]) return ACTION_LABELS[composite];
  }
  if (ACTION_LABELS[action]) return ACTION_LABELS[action];
  return action.charAt(0).toUpperCase() + action.slice(1);
}

/** Цвет для action — см. ACTION_TONES. По умолчанию gray. */
export function getActionTone(action: string): 'green' | 'blue' | 'red' | 'gray' {
  return ACTION_TONES[action] || 'gray';
}
