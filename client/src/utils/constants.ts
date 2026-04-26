import type { Role, PaymentStatus } from './types';

// === РОЛИ ===
// admin — владелец/админ студии (бывший 'owner').
export const ROLE_NAMES: Record<Role, string> = {
  admin: 'Администратор',
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
