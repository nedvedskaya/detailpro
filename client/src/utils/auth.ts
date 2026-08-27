/**
 * Cookie-based auth для SaaS-CRM.
 *
 * Зачем переписано:
 *   Старая версия хранила токен в localStorage и слала его в заголовке
 *   `Authorization: Bearer ...`. Новый бэк (server/lib/auth.cjs) выдаёт
 *   HttpOnly-cookie, недоступный JS — XSS не сможет токен украсть.
 *
 * Что хранится в localStorage сейчас:
 *   - Только UI-предпочтения: ugt_saved_email, ugt_remember_me. Это не auth.
 *   - userData кэшируется только в памяти модуля (`cachedUser`/`cachedStudio`),
 *     чтобы не делать /api/auth/me на каждый рендер. Перезагрузка страницы
 *     → fetchMe() заново.
 *
 * Контракт `bootstrap()`:
 *   Вызывается из App.tsx один раз при старте. Делает GET /api/auth/me.
 *   - 200 → user/studio в кэш, возвращаем оба объекта
 *   - 401 → null (не авторизован, показываем LoginScreen)
 *   - сетевая ошибка → throw (App покажет «нет связи с сервером»)
 */

import type { UserData, Studio, Role } from './types';

export type { UserData, Studio, Role } from './types';
export { getRoleName } from './constants';

interface MeResponse {
  user: {
    id: string;
    name: string;
    email: string;
    role: Role;
    // Profile-поля (после миграции 001). Бэк уже отдаёт их через /api/auth/me.
    firstName?: string | null;
    lastName?: string | null;
    phone?: string | null;
    avatarPath?: string | null;
    createdAt?: string | null;
    // Поля админ-блока (после миграции 003).
    canViewFinance?: boolean;
    permissions?: {
      clients?: string;
      tasks?: string;
      calendar?: string;
      finance?: string;
      welcome_shown?: boolean;
      [key: string]: unknown;
    } | null;
    lastLoginAt?: string | null;
  };
  studio: Studio;
}

let cachedUser: UserData | null = null;
let cachedStudio: Studio | null = null;

function normalizeUser(raw: MeResponse['user']): UserData {
  return {
    id: raw.id,
    name: raw.name,
    email: raw.email,
    role: raw.role,
    // isOwner — удобный derived-флаг, чтобы UI не писал везде role === 'owner'
    isOwner: raw.role === 'owner',
    loginDate: new Date().toISOString(),
    firstName: raw.firstName ?? null,
    lastName: raw.lastName ?? null,
    phone: raw.phone ?? null,
    avatarPath: raw.avatarPath ?? null,
    createdAt: raw.createdAt ?? null,
    // canViewFinance: бэк уже учитывает роль (master → false всегда,
    // owner → true всегда, manager → по флагу). Если миграция 003 ещё не
    // накатилась — поле undefined, и canViewFinance() в permissions.ts
    // фолбекнет на true.
    canViewFinance: raw.canViewFinance,
    permissions: raw.permissions ?? null,
    lastLoginAt: raw.lastLoginAt ?? null,
  };
}

/**
 * Обновить кэшированного пользователя после изменений в /profile.
 * ProfilePage и UserMenu могут показывать новые данные без перезагрузки.
 */
export function patchCachedUser(patch: Partial<UserData>): UserData | null {
  if (!cachedUser) return null;
  cachedUser = { ...cachedUser, ...patch };
  return cachedUser;
}

/**
 * Подгружаем сессию через /api/auth/me. Cookie прокидывается браузером сам
 * благодаря credentials:'include'.
 *
 * Таймаут 15 сек: на проблемной сети (плохой Wi-Fi, VPN-провайдер режет
 * запросы) дефолтный fetch может «висеть» в pending бесконечно. Таймаут
 * через AbortController даёт детерминированное поведение: либо ответ за
 * 15 сек, либо AbortError → App покажет LoginScreen, юзер сам тыкнет
 * «Войти» и тогда либо успешно залогинится, либо увидит понятную ошибку.
 */
const BOOTSTRAP_TIMEOUT_MS = 15000;

export async function bootstrap(): Promise<{ user: UserData; studio: Studio } | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), BOOTSTRAP_TIMEOUT_MS);
  try {
    const response = await fetch('/api/auth/me', {
      credentials: 'include',
      cache: 'no-store',
      signal: ctrl.signal,
    });
    if (response.status === 401) {
      cachedUser = null;
      cachedStudio = null;
      return null;
    }
    if (!response.ok) {
      // 5xx, 502 от прокси и т.п. — не считаем «не авторизован», бросаем
      throw new Error(`auth/me failed: ${response.status}`);
    }
    const data = (await response.json()) as MeResponse;
    cachedUser = normalizeUser(data.user);
    cachedStudio = data.studio;
    // Предзагружаем аватарку сразу как только получили путь.
    if (cachedUser.avatarPath) {
      const img = new Image();
      img.src = cachedUser.avatarPath;
    }
    return { user: cachedUser, studio: cachedStudio };
  } catch (err) {
    // сетевые ошибки (включая AbortError по таймауту) — пробрасываем,
    // чтобы App показал индикатор offline / LoginScreen
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** Кэшированный пользователь (после bootstrap). null если не залогинен. */
export function getUser(): UserData | null {
  return cachedUser;
}

/** Кэшированная студия. null если не залогинен. */
export function getStudio(): Studio | null {
  return cachedStudio;
}

/**
 * Записать в кэш пользователя/студию (вызывается после успешного login/signup,
 * чтобы App не делал лишний /api/auth/me).
 */
export function setSession(user: MeResponse['user'], studio: Studio): UserData {
  cachedUser = normalizeUser(user);
  cachedStudio = studio;
  return cachedUser;
}

/**
 * Logout: бэк удалит сессию из БД и сотрёт cookie. Локальный кэш чистим
 * вручную, чтобы guard в App.tsx сразу увидел null.
 */
export async function logout(): Promise<void> {
  try {
    await fetch('/api/auth/logout', {
      method: 'POST',
      credentials: 'include',
      cache: 'no-store',
    }).catch(() => {});
  } finally {
    cachedUser = null;
    cachedStudio = null;
  }
}

/**
 * Признак «вошёл». true только после успешного bootstrap/login.
 */
export function isAuthenticated(): boolean {
  return cachedUser !== null;
}
