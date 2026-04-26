/**
 * State-update утилиты — выжимка повторявшихся в App.tsx 14+ раз inline-паттернов
 * `prev.map(x => x.id === id ? {...x, ...patch} : x)`, удаления и проверок temp-ID.
 *
 * Цель:
 *   - один источник правды для сравнения id (учитывая, что id может быть number из БД,
 *     либо string `temp_<random>` для оптимистично созданных, ещё не сохранённых сущностей);
 *   - не дублировать catch-обработку ошибок API + showToast в каждом хендлере.
 *
 * См. также helpers.ts → matchId/safeCategoryId — оставляем там для совместимости,
 * здесь они используются под капотом.
 */
import { showToast } from '@/app/components/ui/Toast';

const PG_INT_MAX = 2147483647;

/**
 * true, если id — оптимистично сгенерированный временный (ещё не сохранён в БД).
 * Совпадает с префиксом, который ставится в handleAddClient/Record/Task в App.tsx.
 */
export const isTempId = (id: any): boolean =>
  typeof id === 'string' && id.startsWith('temp_');

/**
 * true, если id — реальный из Postgres (положительное целое в диапазоне int4).
 * Используется для решения, можно ли слать его в API (для temp-id PATCH/DELETE бессмысленны).
 */
export const isRealId = (id: any): boolean => {
  if (typeof id === 'number') return Number.isInteger(id) && id > 0 && id <= PG_INT_MAX;
  if (typeof id === 'string' && !id.startsWith('temp_')) {
    const n = Number(id);
    return Number.isInteger(n) && n > 0 && n <= PG_INT_MAX;
  }
  return false;
};

/**
 * Сравнение id вне зависимости от типа (string/number). Дубль `matchId` из helpers,
 * оставлено для удобства локального импорта.
 */
const sameId = (a: any, b: any): boolean => {
  if (a == null || b == null) return false;
  return String(a) === String(b);
};

/**
 * Иммутабельно обновить элемент массива по id.
 * `patch` — частичный объект, мерджится через spread (новый объект — новая ссылка).
 *
 * Заменяет:
 *   setClients(prev => prev.map(c => c.id === id ? { ...c, ...changes } : c))
 * на:
 *   setClients(prev => updateById(prev, id, changes))
 *
 * Если id не найден — массив возвращается БЕЗ изменений (та же ссылка).
 */
export const updateById = <T extends { id: any }>(
  items: T[],
  id: any,
  patch: Partial<T>
): T[] => {
  let changed = false;
  const next = items.map((item) => {
    if (sameId(item.id, id)) {
      changed = true;
      return { ...item, ...patch };
    }
    return item;
  });
  return changed ? next : items;
};

/**
 * Иммутабельно удалить элемент по id. Если не найден — та же ссылка.
 */
export const removeById = <T extends { id: any }>(items: T[], id: any): T[] => {
  const next = items.filter((item) => !sameId(item.id, id));
  return next.length === items.length ? items : next;
};

/**
 * Заменить элемент с oldId на новый объект целиком (новый id внутри). Используется
 * при свопе temp-ID на реальный после ответа API: мы не знаем, что вернул бэк
 * (могут поменяться computed-поля), поэтому заменяем целиком.
 */
export const replaceById = <T extends { id: any }>(
  items: T[],
  oldId: any,
  next: T
): T[] => {
  let changed = false;
  const result = items.map((item) => {
    if (sameId(item.id, oldId)) {
      changed = true;
      return next;
    }
    return item;
  });
  return changed ? result : items;
};

/**
 * Универсальная обработка ошибок API. Раньше в App.tsx 12+ раз повторялось:
 *   } catch (e) { console.error('Error ...:', e); showToast('Не удалось ...', 'error'); }
 *
 * Эта функция:
 *   - логирует ошибку в консоль (с контекстом, если передан);
 *   - извлекает человекочитаемое сообщение (e.message либо fallback);
 *   - показывает toast.
 *
 * Возвращает строку, которую показала пользователю — на случай, если хендлер
 * хочет ещё что-то с ней сделать (например, записать в локальный лог).
 *
 * @param err           объект ошибки из catch
 * @param fallbackMsg   текст для toast, если у ошибки нет message (или message — техмусор)
 * @param context       опциональный префикс для console.error (название операции)
 * @param toastType     по умолчанию 'error', можно переопределить на 'warning' для невалидаций
 */
export const handleApiError = (
  err: any,
  fallbackMsg: string,
  context?: string,
  toastType: 'error' | 'warning' = 'error'
): string => {
  if (context) console.error(`[${context}]`, err);
  else console.error(err);
  const message =
    typeof err?.message === 'string' && err.message.trim() && !err.message.startsWith('Failed to fetch')
      ? err.message
      : fallbackMsg;
  showToast(message, toastType);
  return message;
};
