/**
 * Единый API-клиент. Все запросы идут с credentials:'include' —
 * браузер прокидывает HttpOnly cookie сессии автоматически.
 *
 * Контракт ошибок:
 *   - 401 → logout() + reload (пользователь увидит LoginScreen)
 *   - 402 → подписка истекла (бэк возвращает middleware/requireActiveStudio).
 *           handleResponse кидает Error с .code='subscription_expired',
 *           компонент-обёртка может это поймать и показать кнопку «оплатить».
 *   - 4xx остальные → Error(data.error || 'Request failed')
 */

import { logout } from './auth';
import type { ProfileResponse, Studio, StudioUser, ActivityLogEntry } from './types';

const API_BASE = '/api';

const baseInit: RequestInit = { credentials: 'include' };
const jsonHeaders = { 'Content-Type': 'application/json' };

class ApiError extends Error {
  status: number;
  code?: string;
  constructor(message: string, status: number, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function handleResponse<T>(response: Response): Promise<T> {
  if (response.status === 401) {
    await logout();
    // Перезагрузка — самый дешёвый и надёжный способ сбросить in-memory state.
    // Альтернатива (event-bus до App.tsx) усложняет код ради экономии 200мс.
    window.location.reload();
    throw new ApiError('Сессия истекла', 401, 'session_expired');
  }
  if (response.status === 402) {
    const body = await response.json().catch(() => ({}));
    throw new ApiError(body.error || 'Подписка истекла', 402, 'subscription_expired');
  }
  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: 'Request failed' }));
    throw new ApiError(body.error || 'Request failed', response.status, body.code);
  }
  // 204 No Content на DELETE/PUT может прилететь — отдаём undefined
  if (response.status === 204) return undefined as unknown as T;
  return response.json();
}

function get<T>(path: string): Promise<T> {
  return fetch(`${API_BASE}${path}`, baseInit).then(handleResponse<T>);
}

function send<T>(method: 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, body?: unknown): Promise<T> {
  return fetch(`${API_BASE}${path}`, {
    ...baseInit,
    method,
    headers: jsonHeaders,
    body: body === undefined ? undefined : JSON.stringify(body),
  }).then(handleResponse<T>);
}

function qs(params: Record<string, unknown> | undefined): string {
  if (!params) return '';
  const parts: string[] = [];
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  }
  return parts.length ? '?' + parts.join('&') : '';
}

export { ApiError };

export const api = {
  // ────── auth ──────
  signup(payload: {
    studioName: string;
    email: string;
    password: string;
    // name — legacy-поле для обратной совместимости. Если передан, бэк
    // разрежет его по первому пробелу. Новые формы шлют firstName/lastName.
    name?: string;
    firstName?: string;
    lastName?: string;
    consents: { personal_data: boolean; terms: boolean; marketing?: boolean };
  }) {
    return send<{ user: any; studio: Studio }>('POST', '/auth/signup', payload);
  },
  login(payload: { email: string; password: string }) {
    return send<{ user: any; studio: Studio }>('POST', '/auth/login', payload);
  },
  logout() {
    return send<void>('POST', '/auth/logout');
  },
  getMe() {
    return get<{ user: any; studio: Studio }>('/auth/me');
  },
  changePassword(oldPassword: string, newPassword: string) {
    return send<{ ok: true }>('POST', '/auth/password', { oldPassword, newPassword });
  },

  // ────── профиль (личный кабинет) ──────
  // Доступен и при просроченной подписке: /api/profile сидит ПОД requireAuth,
  // но НЕ под requireActiveStudio (см. server/app.cjs).
  getProfile() {
    return get<ProfileResponse>('/profile');
  },
  updateProfile(patch: { firstName?: string | null; lastName?: string | null; phone?: string | null }) {
    return send<{ ok: true; user: ProfileResponse['user'] }>('PATCH', '/profile', patch);
  },
  uploadAvatar(file: File) {
    // multipart/form-data — заголовок Content-Type выставит браузер сам.
    const fd = new FormData();
    fd.append('avatar', file);
    return fetch(`${API_BASE}/profile/avatar`, {
      ...baseInit,
      method: 'POST',
      body: fd,
    }).then(handleResponse<{ avatarPath: string }>);
  },
  deleteAvatar() {
    return send<{ ok: true }>('DELETE', '/profile/avatar');
  },
  // Отмена подписки (owner only). Не списывает деньги обратно — просто
  // отключает автопродление, доступ остаётся до accessUntil.
  cancelSubscription() {
    return send<{ ok: true; alreadyCancelled?: boolean }>('POST', '/profile/subscription/cancel');
  },
  resumeSubscription() {
    return send<{ ok: true }>('POST', '/profile/subscription/resume');
  },

  // ────── админка студии (role=owner) ──────
  getAdminUsers(params?: { search?: string; role?: string; is_active?: string }) {
    return get<StudioUser[]>(`/admin/users${qs(params)}`);
  },
  // На создании сотрудника owner может (опционально) сразу выставить
  // can_view_finance — для master это поле игнорируется бэком (всегда false).
  createAdminUser(user: {
    email: string;
    password: string;
    name: string;
    role: string;
    can_view_finance?: boolean;
  }) {
    return send<StudioUser>('POST', '/admin/users', user);
  },
  // Расширенный patch: помимо имени/роли/активности теперь поддерживается
  // can_view_finance (для роли manager). Бэк защищает: для master флаг
  // принудительно false, последний owner не может быть демоутнут.
  updateAdminUser(id: string, patch: {
    email?: string;
    name?: string;
    role?: string;
    is_active?: boolean;
    can_view_finance?: boolean;
  }) {
    return send<StudioUser>('PUT', `/admin/users/${id}`, patch);
  },
  deleteUser(id: string) {
    return send<void>('DELETE', `/admin/users/${id}`);
  },
  blockUser(id: string, isActive: boolean) {
    return send<StudioUser>('PUT', `/admin/users/${id}/block`, { is_active: isActive });
  },
  // Сброс пароля сотрудника. Бэк генерирует временный пароль (~12 символов
  // base64url) и возвращает его ОДИН РАЗ — UI показывает его в модалке
  // с кнопкой «Скопировать». При следующем запросе пароль уже не получить.
  // Все активные сессии сотрудника инвалидируются.
  resetUserPassword(id: string) {
    return send<{ ok: true; tempPassword: string }>('POST', `/admin/users/${id}/reset-password`);
  },
  // Активити-лог. Параметры:
  //   limit/offset — пагинация (UI грузит по 50)
  //   user_id      — фильтр по сотруднику
  //   action       — фильтр по типу события (см. ACTION_LABELS)
  //   from/to      — ISO-границы по created_at, включительно
  getActivityLogs(params?: {
    limit?: number;
    offset?: number;
    user_id?: string;
    action?: string;
    from?: string;
    to?: string;
  }) {
    return get<ActivityLogEntry[]>(`/activity-logs${qs(params)}`);
  },

  // ────── список членов студии (для дропдаунов «мастер») ──────
  getUsers() {
    return get<StudioUser[]>('/users');
  },

  // ────── clients ──────
  getClients() {
    return get<any[]>('/clients');
  },
  createClient(client: any) {
    return send<any>('POST', '/clients', client);
  },
  updateClient(id: number | string, client: any) {
    return send<any>('PUT', `/clients/${id}`, client);
  },
  updateClientAvatar(id: number | string, avatar: string | null) {
    return send<any>('PUT', `/clients/${id}/avatar`, { avatar });
  },
  deleteClient(id: number | string) {
    return send<void>('DELETE', `/clients/${id}`);
  },

  // ────── vehicles ──────
  getVehicles() {
    return get<any[]>('/vehicles');
  },
  createVehicle(v: any) {
    return send<any>('POST', '/vehicles', v);
  },
  updateVehicle(id: number | string, v: any) {
    return send<any>('PUT', `/vehicles/${id}`, v);
  },
  deleteVehicle(id: number | string) {
    return send<void>('DELETE', `/vehicles/${id}`);
  },

  // ────── services ──────
  getServices() {
    return get<any[]>('/services');
  },
  createService(s: any) {
    return send<any>('POST', '/services', s);
  },
  updateService(id: number | string, s: any) {
    return send<any>('PUT', `/services/${id}`, s);
  },
  deleteService(id: number | string) {
    return send<void>('DELETE', `/services/${id}`);
  },

  // ────── bookings (записи в календаре) ──────
  getBookings() {
    return get<any[]>('/bookings');
  },
  createBooking(b: any) {
    return send<any>('POST', '/bookings', b);
  },
  updateBooking(id: number | string, b: any) {
    return send<any>('PUT', `/bookings/${id}`, b);
  },
  deleteBooking(id: number | string) {
    return send<void>('DELETE', `/bookings/${id}`);
  },

  // ────── transactions ──────
  getTransactions() {
    return get<any[]>('/transactions');
  },
  createTransaction(t: any) {
    return send<any>('POST', '/transactions', t);
  },
  updateTransaction(id: number | string, t: any) {
    return send<any>('PUT', `/transactions/${id}`, t);
  },
  deleteTransaction(id: number | string) {
    return send<void>('DELETE', `/transactions/${id}`);
  },

  // ────── tasks ──────
  getTasks() {
    return get<any[]>('/tasks');
  },
  createTask(t: any) {
    return send<any>('POST', '/tasks', t);
  },
  updateTask(id: number | string, t: any) {
    return send<any>('PUT', `/tasks/${id}`, t);
  },
  deleteTask(id: number | string) {
    return send<void>('DELETE', `/tasks/${id}`);
  },

  // ────── client-records ──────
  getClientRecords(clientId?: number | string) {
    const path = clientId ? `/client-records?client_id=${clientId}` : '/client-records';
    return get<any[]>(path);
  },
  createClientRecord(r: any) {
    return send<any>('POST', '/client-records', r);
  },
  updateClientRecord(id: number | string, r: any) {
    return send<any>('PUT', `/client-records/${id}`, r);
  },
  deleteClientRecord(id: number | string) {
    return send<void>('DELETE', `/client-records/${id}`);
  },

  // ────── categories ──────
  getCategories() {
    return get<any[]>('/categories');
  },
  createCategory(c: any) {
    return send<any>('POST', '/categories', c);
  },
  updateCategory(id: number | string, c: any) {
    return send<any>('PUT', `/categories/${id}`, c);
  },
  deleteCategory(id: number | string) {
    return send<void>('DELETE', `/categories/${id}`);
  },

  // ────── tags ──────
  getTags() {
    return get<any[]>('/tags');
  },
  createTag(t: any) {
    return send<any>('POST', '/tags', t);
  },
  deleteTag(id: number | string) {
    return send<void>('DELETE', `/tags/${id}`);
  },

  // ────── entity-tags (связь тег ↔ сущность) ──────
  getEntityTags(params?: { entity_type?: string; entity_id?: number | string }) {
    return get<any[]>(`/entity-tags${qs(params)}`);
  },
  createEntityTag(payload: { entity_type: string; entity_id: number | string; tag_id: number | string }) {
    return send<any>('POST', '/entity-tags', payload);
  },
  deleteEntityTag(id: number | string) {
    return send<void>('DELETE', `/entity-tags/${id}`);
  },

  // ────── app-data (key-value стор) ──────
  getAppData(key: string) {
    return get<any>(`/app-data/${encodeURIComponent(key)}`);
  },
  setAppData(key: string, value: any) {
    return send<any>('POST', `/app-data/${encodeURIComponent(key)}`, value);
  },
};
