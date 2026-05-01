/**
 * validation.ts — единая точка правды для базовых проверок на клиенте.
 * Зеркало server/lib/validation.cjs: важно, чтобы клиент-валидация и
 * сервер-валидация совпадали (иначе UI может пропустить значение, которое
 * сервер потом отвергнет, и пользователь увидит непонятный 400).
 *
 * Раньше регексп `/^[^\s@]+@[^\s@]+\.[^\s@]+$/` копировался в LoginScreen,
 * ProfilePage и в трёх роутах — теперь правится в одном месте.
 */

// Должен побайтно совпадать с EMAIL_REGEX в server/lib/validation.cjs.
export const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Минимум 8 символов — синхронно с PASSWORD_MIN_LENGTH на сервере.
export const PASSWORD_MIN_LENGTH = 8;

export const isValidEmail = (v: unknown): v is string =>
  typeof v === 'string' && EMAIL_REGEX.test(v);

export const isValidPassword = (v: unknown): v is string =>
  typeof v === 'string' && v.length >= PASSWORD_MIN_LENGTH;


// Типы для результатов валидации
export type ValidationErrors = Record<string, string>;

// Клиент — имя и телефон обязательны
export function validateClient(data: { name?: string; phone?: string }): ValidationErrors {
  const errors: ValidationErrors = {};
  if (!data.name?.trim()) errors.name = "Укажите имя клиента";
  if (!data.phone?.trim()) errors.phone = "Укажите номер телефона";
  return errors;
}

// Задача — название обязательно
export function validateTask(data: { title?: string }): ValidationErrors {
  const errors: ValidationErrors = {};
  if (!data.title?.trim()) errors.title = "Укажите название задачи";
  return errors;
}

// Транзакция — сумма обязательна и должна быть > 0
export function validateTransaction(data: { amount?: number | string }): ValidationErrors {
  const errors: ValidationErrors = {};
  const amount = Number(data.amount);
  if (!amount || amount <= 0) errors.amount = "Укажите сумму";
  return errors;
}

// Запись (client-record) — дата обязательна
export function validateClientRecord(data: { date?: string }): ValidationErrors {
  const errors: ValidationErrors = {};
  if (!data.date?.trim()) errors.date = "Укажите дату записи";
  return errors;
}

// Бронирование — дата обязательна
export function validateBooking(data: { date?: string }): ValidationErrors {
  const errors: ValidationErrors = {};
  if (!data.date?.trim()) errors.date = "Укажите дату записи";
  return errors;
}

// Общая проверка: есть ли ошибки
export function hasErrors(errors: ValidationErrors): boolean {
  return Object.keys(errors).length > 0;
}
