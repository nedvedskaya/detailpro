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
