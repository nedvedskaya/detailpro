const CACHE_VERSION = 'v3';
const CACHE_PREFIX = `ugt_cache_${CACHE_VERSION}_`;

function scopedKey(scope: string, key: string): string {
  const value = String(scope || '').trim();
  if (!value) throw new Error('offline cache scope is required');
  return `${CACHE_PREFIX}${value}_${key}`;
}

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

export function saveToCache(scope: string, key: string, data: any): void {
  try {
    localStorage.setItem(scopedKey(scope, key), JSON.stringify(data));
    localStorage.setItem(scopedKey(scope, 'timestamp'), new Date().toISOString());
  } catch (e) {
    console.warn('localStorage save failed:', e);
  }
}

export function loadFromCache(scope: string, key: string): any | null {
  try {
    const raw = localStorage.getItem(scopedKey(scope, key));
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function removeFromCache(scope: string, key: string): void {
  try {
    localStorage.removeItem(scopedKey(scope, key));
  } catch {}
}

export function getCacheTimestamp(scope: string): string | null {
  return localStorage.getItem(scopedKey(scope, 'timestamp'));
}

export function saveAllData(scope: string, data: {
  clients: any[];
  tasks: any[];
  transactions: any[];
  categories: any[];
  tags: any[];
}): void {
  saveToCache(scope, 'clients', data.clients);
  saveToCache(scope, 'tasks', data.tasks);
  saveToCache(scope, 'transactions', data.transactions);
  saveToCache(scope, 'categories', data.categories);
  saveToCache(scope, 'tags', data.tags);
}

export function loadAllData(scope: string): {
  clients: any[] | null;
  tasks: any[] | null;
  transactions: any[] | null;
  categories: any[] | null;
  tags: any[] | null;
} {
  return {
    clients: loadFromCache(scope, 'clients'),
    tasks: loadFromCache(scope, 'tasks'),
    transactions: loadFromCache(scope, 'transactions'),
    categories: loadFromCache(scope, 'categories'),
    tags: loadFromCache(scope, 'tags'),
  };
}
