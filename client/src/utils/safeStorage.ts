/**
 * Безопасная обёртка для работы с localStorage
 * Защита от ошибок парсинга и переполнения квоты
 */

interface StorageError {
  key: string;
  error: unknown;
  timestamp: number;
}

const storageErrors: StorageError[] = [];

/**
 * Логирование ошибок localStorage (для debugging)
 */
const logStorageError = (key: string, error: unknown, operation: 'get' | 'set') => {
  const errorInfo: StorageError = {
    key,
    error,
    timestamp: Date.now()
  };
  
  storageErrors.push(errorInfo);
  
  // Оставляем только последние 10 ошибок
  if (storageErrors.length > 10) {
    storageErrors.shift();
  }
  
  console.warn(`[SafeStorage] ${operation.toUpperCase()} error for key "${key}":`, error);
};

/**
 * Безопасное получение данных из localStorage
 * @param key - ключ в localStorage
 * @param fallback - значение по умолчанию при ошибке
 * @returns распарсенные данные или fallback
 */
export const getItem = <T = any>(key: string, fallback: T): T => {
  try {
    const item = localStorage.getItem(key);
    
    if (item === null) {
      return fallback;
    }
    
    // Попытка парсинга JSON
    const parsed = JSON.parse(item);
    
    // Базовая валидация типа
    if (typeof parsed === typeof fallback || fallback === null) {
      return parsed as T;
    }
    
    console.warn(`[SafeStorage] Type mismatch for key "${key}", using fallback`);
    return fallback;
    
  } catch (error) {
    logStorageError(key, error, 'get');
    return fallback;
  }
};

/**
 * Безопасное сохранение данных в localStorage
 * @param key - ключ в localStorage
 * @param value - значение для сохранения
 * @returns true при успехе, false при ошибке
 */
export const setItem = <T = any>(key: string, value: T): boolean => {
  try {
    const serialized = JSON.stringify(value);
    localStorage.setItem(key, serialized);
    return true;
    
  } catch (error) {
    // Обработка QuotaExceededError
    if (error instanceof DOMException && error.name === 'QuotaExceededError') {
      console.error(`[SafeStorage] localStorage quota exceeded for key "${key}"`);
      
      // Попытка освободить место (удаляем старые данные)
      try {
        clearOldData();
        localStorage.setItem(key, JSON.stringify(value));
        return true;
      } catch (retryError) {
        logStorageError(key, retryError, 'set');
        return false;
      }
    }
    
    logStorageError(key, error, 'set');
    return false;
  }
};

/**
 * Безопасное удаление данных из localStorage
 * @param key - ключ для удаления
 * @returns true при успехе
 */
export const removeItem = (key: string): boolean => {
  try {
    localStorage.removeItem(key);
    return true;
  } catch (error) {
    console.warn(`[SafeStorage] Error removing key "${key}":`, error);
    return false;
  }
};

/**
 * Проверка существования ключа
 * @param key - ключ для проверки
 * @returns true если ключ существует
 */
export const hasItem = (key: string): boolean => {
  try {
    return localStorage.getItem(key) !== null;
  } catch (error) {
    return false;
  }
};

/**
 * Очистка старых данных для освобождения места
 * Удаляет временные и устаревшие ключи
 */
const clearOldData = () => {
  const keysToRemove = ['temp_', 'cache_', 'old_'];
  
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key && keysToRemove.some(prefix => key.startsWith(prefix))) {
      localStorage.removeItem(key);
    }
  }
};

/**
 * Получение размера данных в localStorage (приблизительно)
 * @returns размер в байтах
 */
export const getStorageSize = (): number => {
  let total = 0;
  
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key) {
      const value = localStorage.getItem(key);
      total += key.length + (value?.length || 0);
    }
  }
  
  return total;
};

/**
 * Получение истории ошибок (для debugging)
 */
export const getStorageErrors = (): readonly StorageError[] => {
  return Object.freeze([...storageErrors]);
};

/**
 * Экспорт всех методов как объект
 */
export const safeLocalStorage = {
  getItem,
  setItem,
  removeItem,
  hasItem,
  getStorageSize,
  getStorageErrors
};

export default safeLocalStorage;
