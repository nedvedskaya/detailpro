const CACHE_VERSION = 'v2';
const CACHE_PREFIX = `ugt_cache_${CACHE_VERSION}_`;
const CACHE_TIMESTAMP_KEY = `ugt_cache_${CACHE_VERSION}_timestamp`;

function clearOldCache(): void {
  try {
    const keysToDelete: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith('ugt_cache_') && !key.startsWith(CACHE_PREFIX)) {
        keysToDelete.push(key);
      }
    }
    keysToDelete.forEach(k => localStorage.removeItem(k));
  } catch {}
}

clearOldCache();

export function saveToCache(key: string, data: any): void {
  try {
    localStorage.setItem(CACHE_PREFIX + key, JSON.stringify(data));
    localStorage.setItem(CACHE_TIMESTAMP_KEY, new Date().toISOString());
  } catch (e) {
    console.warn('localStorage save failed:', e);
  }
}

export function loadFromCache(key: string): any | null {
  try {
    const raw = localStorage.getItem(CACHE_PREFIX + key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function getCacheTimestamp(): string | null {
  return localStorage.getItem(CACHE_TIMESTAMP_KEY);
}

export function saveAllData(data: {
  clients: any[];
  tasks: any[];
  transactions: any[];
  categories: any[];
  tags: any[];
}): void {
  saveToCache('clients', data.clients);
  saveToCache('tasks', data.tasks);
  saveToCache('transactions', data.transactions);
  saveToCache('categories', data.categories);
  saveToCache('tags', data.tags);
}

export function loadAllData(): {
  clients: any[] | null;
  tasks: any[] | null;
  transactions: any[] | null;
  categories: any[] | null;
  tags: any[] | null;
} {
  return {
    clients: loadFromCache('clients'),
    tasks: loadFromCache('tasks'),
    transactions: loadFromCache('transactions'),
    categories: loadFromCache('categories'),
    tags: loadFromCache('tags'),
  };
}
