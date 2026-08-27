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

const baseInit: RequestInit = { credentials: 'include', cache: 'no-store' };
const jsonHeaders = { 'Content-Type': 'application/json' };

class ApiError extends Error {
  status: number;
  code?: string;
  constructor(message: string, status: number, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
  // Для error: 'field_invalid' с бэкенда — конкретное поле и причина.
  // Заполняется в handleResponse при разборе body. translateApiError умеет
  // строить из этого читаемое сообщение «Поле X слишком длинное».
  field?: string;
  reason?: string;
}

// Whitelist путей, которые работают БЕЗ requireActiveStudio (т.е. 200 от
// них не означает «подписка активна»). Совпадает с whitelist'ом в app.cjs.
function isWhitelistedPath(url: string): boolean {
  try {
    const path = new URL(url, 'http://x').pathname;
    return path.startsWith('/api/auth')
      || path.startsWith('/api/profile')
      || path.startsWith('/api/webhooks')
      || path.startsWith('/api/telegram');
  } catch (_) { return true; }
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
    // Бэк отдаёт 402 с любого защищённого роута, если access_until истёк.
    // Поднимаем глобальный flag — App.tsx слушает событие и поверх UI
    // показывает LockScreen с CTA «Перейти к тарифам». Сам ApiError всё
    // равно бросаем — компонент, который сделал запрос, должен корректно
    // отлипнуть от спиннера/состояния.
    try {
      window.dispatchEvent(new CustomEvent('app:subscription-lock', { detail: body }));
    } catch (_) { /* SSR/older browsers — best-effort */ }
    throw new ApiError(body.error || 'Подписка истекла', 402, 'subscription_expired');
  }
  // Если защищённый роут вернул 200 — подписка точно активна. Снимаем
  // LockScreen, если он висел (актуально после оплаты: webhook обновил
  // access_until, юзер обновил страницу или сделал любой запрос — UI
  // должен сам разлочиться, не требуя нашего ручного сброса).
  if (response.ok && response.url && !isWhitelistedPath(response.url)) {
    try {
      window.dispatchEvent(new CustomEvent('app:subscription-active'));
    } catch (_) { /* best-effort */ }
  }
  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: 'Request failed' }));
    const err = new ApiError(body.error || 'Request failed', response.status, body.code);
    // field_invalid: бэк прикладывает { field, reason } — пробрасываем,
    // чтобы UI мог показать «Поле X: слишком длинное» через translateApiError.
    if (body && typeof body === 'object') {
      if (typeof body.field === 'string') err.field = body.field;
      if (typeof body.reason === 'string') err.reason = body.reason;
    }
    throw err;
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
  }).then(handleResponse<T>).then((data) => {
    const crmPrefixes = ['/clients', '/tasks', '/client-records', '/transactions', '/categories', '/tags', '/services', '/service-categories', '/bookings', '/vehicles'];
    if (crmPrefixes.some(prefix => path === prefix || path.startsWith(`${prefix}/`))) {
      try { window.dispatchEvent(new CustomEvent('app:crm-mutated')); } catch (_) {}
    }
    return data;
  });
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
    // Реферальный код приглашающего (если регистрация через ?ref=CODE).
    // Невалидный код не блокирует signup — бэк игнорирует.
    referralCode?: string | null;
    // Сценарий «бот → сайт»: одноразовый токен из saas_meta.tg_signup_tokens.
    // Если валиден — бэк автоматически привяжет TG-аккаунт к новому юзеру
    // и пришлёт welcome + онбординг в TG. Если протух — signup пройдёт
    // без линка, фронт ничего не покажет (а позже юзер сможет привязать
    // через Профиль → Telegram).
    tgSignupToken?: string | null;
  }) {
    return send<{ user: any; studio: Studio; tgLinked?: boolean }>('POST', '/auth/signup', payload);
  },
  // Валидатор TG-токена для signup-формы. Дёргается при заходе на сайт с
  // ?tg=<token> — чтобы показать бейдж «Telegram @username будет подключён».
  // НЕ списывает токен (consume происходит в createStudio при /auth/signup).
  getTgSignupToken(token: string) {
    return get<
      | { valid: true; tg_username: string | null }
      | { valid: false; reason: 'expired' | 'used' | 'unknown' }
    >(`/auth/tg-signup-token?token=${encodeURIComponent(token)}`);
  },
  // Реферальная программа (только owner). Возвращает код, баланс,
  // статистику и журнал событий — всё, что нужно для блока «Мои рефералы»
  // в профиле.
  getReferral() {
    return get<{
      referralCode: string;
      bonusBalanceKop: number;
      referralsCount: number;
      paidReferralsCount: number;
      totalEarnedKop: number;
      totalSpentKop: number;
      bonusPerReferralKop: number;
      referrals: Array<{ id: string; displayName: string; createdAt: string; hasPaid: boolean }>;
      events: Array<{ id: number; kind: 'credit' | 'debit'; amountKop: number; sourceStudioId: string | null; paymentOrderId: string | null; createdAt: string }>;
    }>('/profile/referral');
  },
  login(payload: { email: string; password: string; rememberMe?: boolean }) {
    return send<{ user: any; studio: Studio }>('POST', '/auth/login', payload);
  },
  markWelcomeShown() {
    return send<{ ok: boolean }>('POST', '/auth/welcome-shown');
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
  // Реквизиты студии для PDF (только owner). Возвращает обновлённые поля
  // студии — мерджим в data.studio локально, чтобы не дёргать /profile целиком.
  updateStudio(patch: {
    displayName?: string | null;
    inn?: string | null;
    ogrn?: string | null;
    legalAddress?: string | null;
    actualAddress?: string | null;
    contactPhone?: string | null;
    contactEmail?: string | null;
    guaranteeText?: string | null;
    // 'HH:MM' или null (= «не присылать сводку»). Когда owner меняет это
    // поле, бэк ставит daily_summary_time_set = TRUE — бот в Telegram
    // больше не переспрашивает время после следующего входа.
    dailySummaryTime?: string | null;
  }) {
    return send<{
      ok: true;
      studio: {
        id: string;
        displayName: string;
        inn: string | null;
        ogrn: string | null;
        legalAddress: string | null;
        actualAddress: string | null;
        contactPhone: string | null;
        contactEmail: string | null;
        guaranteeText: string | null;
        dailySummaryTime: string | null;
        dailySummaryTimeSet: boolean;
      };
    }>('PATCH', '/profile/studio', patch);
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

  // ────── Payment intent ──────
  // Серверно-выпущенный токен, привязывающий платёжный URL Prodamus к
  // authenticated студии. Без него webhook берёт studio_id из payload — что
  // позволяло атакующему через подмену `_param_studio_id` манипулировать
  // чужой подпиской. После получения intent фронт вшивает token как
  // `_param_intent` в payform-URL → webhook верифицирует и берёт studio_id
  // из сервера, а не из payload (см. server/sql/011_payment_intents.sql).
  createPaymentIntent(plan: 'solo_month' | 'solo_year' | 'studio_month' | 'studio_year', extraUsers = 0) {
    return send<{
      token: string;
      expiresAt: string;
      expectedAmountKop: number;
      bonusKopApplied: number;
      finalAmountRub: number;
      // Готовый URL платёжной страницы Prodamus (бэк собирает целиком).
      // Фронт делает window.location.href = payformUrl. Опциональный для
      // обратной совместимости со старыми билдами клиента — фронт
      // обработает отсутствие явной ошибкой.
      payformUrl?: string;
    }>('POST', '/profile/payment/intent', { plan, ...(extraUsers > 0 ? { extraUsers } : {}) });
  },

  // ────── Telegram-привязка (Фаза 1 TG-интеграции) ──────
  // Создаёт одноразовый deep-link `https://t.me/<bot>?start=link_<token>`
  // для текущего пользователя. UI открывает window.open(url) → бот в TG
  // подтверждает привязку → next /api/profile вернёт tgLinked=true.
  // crossBorderConsent ОБЯЗАТЕЛЕН — без него бэк отдаст 400. ФЗ-152 ч. 4
  // ст. 12: трансграничная передача требует отдельного согласия. Запись
  // в consents идёт в этом же endpoint'е.
  linkTelegram(crossBorderConsent: boolean) {
    return send<{
      url: string;
      botUsername: string;
      expiresInHours: number;
    }>('POST', '/profile/telegram/link', { crossBorderConsent });
  },
  unlinkTelegram() {
    return send<{ ok: true }>('DELETE', '/profile/telegram');
  },

  // Запрос на удаление аккаунта по 152-ФЗ. Toggle: первый вызов выставляет
  // дату; повторный (или с cancel:true) — отменяет. Реальное удаление —
  // через 30 дней по cron'у.
  requestAccountDeletion(cancel = false) {
    return send<{
      ok: true;
      deletionRequestedAt: string | null;
      deletionEffectiveAt: string | null;
    }>('POST', '/profile/account/request-deletion', { cancel });
  },

  // ────── Сброс пароля через Telegram-бот ──────
  // request: всегда возвращает 200 (не выдаём существование email).
  //   delivery='tg'           → ссылка отправлена в TG
  //   delivery='no_channel'   → юзер найден, но TG не привязан (фронт показывает
  //                              «привяжите TG или напишите в поддержку»)
  //   delivery='tg_if_linked' → юзер не найден ИЛИ ссылка отправлена; UI всё
  //                              равно показывает «если у вас был привязан TG —
  //                              проверьте сообщения».
  requestPasswordReset(email: string) {
    return send<{
      ok: true;
      delivery: 'tg' | 'no_channel' | 'tg_if_linked';
    }>('POST', '/auth/password-reset/request', { email });
  },
  confirmPasswordReset(token: string, newPassword: string, rememberMe = true) {
    return send<{ ok: true }>('POST', '/auth/password-reset/confirm', { token, newPassword, rememberMe });
  },

  // ────── админка студии (role=owner) ──────
  getAdminUsers(params?: { search?: string; role?: string; is_active?: string }) {
    return get<StudioUser[]>(`/admin/users${qs(params)}`);
  },
  createAdminUser(user: {
    email: string;
    password: string;
    name: string;
    firstName?: string;
    lastName?: string;
    phone?: string;
    role: string;
    permissions?: { clients: string; tasks: string; calendar: string; finance: string } | null;
  }) {
    return send<StudioUser>('POST', '/admin/users', user);
  },
  updateAdminUser(id: string, patch: {
    email?: string;
    name?: string;
    firstName?: string | null;
    lastName?: string | null;
    phone?: string | null;
    role?: string;
    is_active?: boolean;
    can_view_finance?: boolean;
    permissions?: { clients: string; tasks: string; calendar: string; finance: string } | null;
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

  // ────── analytics dashboard (only owner + plan=studio) ──────
  // period: '3m' | '6m' | 'year' (12 мес). По умолчанию 6m.
  // На solo/trial бэк отдаёт 402 plan_required — UI показывает плашку «доступно на тарифе Студия».
  getAnalytics(period: '3m' | '6m' | 'year' = '6m') {
    return get<AnalyticsResponse>(`/admin/analytics?period=${period}`);
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
  bulkImportClients(payload: {
    rows: Array<{
      client: {
        name: string;
        phone?: string | null;
        email?: string | null;
        notes?: string | null;
        city?: string | null;
        source?: string | null;
        birth_date?: string | null;
      };
      vehicle?: {
        brand?: string | null;
        model?: string | null;
        license_plate?: string | null;
        color?: string | null;
        year?: number | null;
      } | null;
    }>;
    strategy: 'skip' | 'overwrite' | 'create_new';
  }) {
    return send<{
      ok: true;
      strategy: 'skip' | 'overwrite' | 'create_new';
      created: number;
      updated: number;
      skipped: number;
      errors: Array<{ row: number; reason: string }>;
    }>('POST', '/clients/bulk', payload);
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

  // ────── service categories ──────
  getServiceCategories() {
    return get<any[]>('/service-categories');
  },
  createServiceCategory(data: { name: string; color?: string }) {
    return send<any>('POST', '/service-categories', data);
  },
  updateServiceCategory(id: number, data: { name: string; color?: string }) {
    return send<any>('PUT', `/service-categories/${id}`, data);
  },
  deleteServiceCategory(id: number) {
    return send<void>('DELETE', `/service-categories/${id}`);
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
  updateTag(id: number | string, t: any) {
    return send<any>('PUT', `/tags/${id}`, t);
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

  // ────── документы по броням: заказ-наряд ──────
  // PUT — upsert: первый раз создаст, дальше обновит (UNIQUE booking_id на бэке).
  // PDF-эндпоинты возвращают inline application/pdf — открываем через
  // window.open(`${API_BASE}/work-orders/${id}/pdf`) с credentials:include.
  getWorkOrder(bookingId: number | string) {
    return get<WorkOrder>(`/work-orders/${bookingId}`);
  },
  saveWorkOrder(bookingId: number | string, payload: WorkOrderUpsert) {
    return send<WorkOrder>('PUT', `/work-orders/${bookingId}`, payload);
  },
  workOrderPdfUrl(bookingId: number | string) {
    return `${API_BASE}/work-orders/${bookingId}/pdf`;
  },

  // ────── документы по броням: акт приёмки ──────
  getAcceptanceAct(bookingId: number | string) {
    return get<AcceptanceAct>(`/acceptance-acts/${bookingId}`);
  },
  saveAcceptanceAct(bookingId: number | string, payload: AcceptanceActUpsert) {
    return send<AcceptanceAct>('PUT', `/acceptance-acts/${bookingId}`, payload);
  },
  acceptanceActPdfUrl(bookingId: number | string) {
    return `${API_BASE}/acceptance-acts/${bookingId}/pdf`;
  },

  // Контекст для пред-заполнения форм документов (клиент + автомобиль из карточки).
  getDocumentContext(bookingId: number | string) {
    return get<DocumentContext>(`/document-context/${bookingId}`);
  },

  // ────── фото к броням ──────
  // limit 30/бронь, лимит 10 MB на upload, на бэке sharp ужимает до 1920px webp.
  listOrderPhotos(bookingId: number | string) {
    return get<OrderPhoto[]>(`/order-photos${qs({ bookingId })}`);
  },
  uploadOrderPhoto(bookingId: number | string, file: File, photoType: OrderPhotoType = 'acceptance') {
    const fd = new FormData();
    fd.append('file', file);
    fd.append('bookingId', String(bookingId));
    fd.append('photoType', photoType);
    return fetch(`${API_BASE}/order-photos`, {
      ...baseInit, method: 'POST', body: fd,
    }).then(handleResponse<OrderPhoto>);
  },
  deleteOrderPhoto(id: number | string) {
    return send<{ ok: true }>('DELETE', `/order-photos/${id}`);
  },
  // URL для <img src=...> — отдаёт стрим под auth-cookie (credentials: include
  // в браузере по умолчанию для same-origin, у нас фронт и бэк на одном
  // домене → работает без дополнительной настройки).
  orderPhotoFileUrl(id: number | string) {
    return `${API_BASE}/order-photos/${id}/file`;
  },
  orderPhotoThumbUrl(id: number | string) {
    return `${API_BASE}/order-photos/${id}/thumb`;
  },
};

// ──────────────────────────────────────────────────────────────────────
// Типы документов (оставлены тут, чтобы не плодить файлы — все document-
// специфичные DTO в одном месте).
// ──────────────────────────────────────────────────────────────────────
// Snapshot-данные клиента и автомобиля, сохраняются прямо в документе.
// Используются в форме акта/наряда, чтобы дать возможность вписать данные
// вручную, если в карточке клиента/авто их нет, и зафиксировать состояние
// на момент оформления документа.
export interface ClientSnapshot {
  name: string | null;
  phone: string | null;
  email: string | null;
}
export interface VehicleSnapshot {
  brand: string | null;
  model: string | null;
  color: string | null;
  license_plate: string | null;
  vin: string | null;
  year: number | null;
}

export interface DocumentContext {
  client: { id: number; name: string; phone: string | null; email: string | null } | null;
  vehicle: { id: number; brand: string | null; model: string | null; license_plate: string | null; vin: string | null; color?: string | null; year?: number | null } | null;
  record: { id: number; service_name: string };
}

export type PaymentMethod = 'cash' | 'card' | 'transfer' | 'invoice';

export interface WorkOrderItem {
  name: string;
  quantity: number;
  price: number;
}

export interface WorkOrder {
  id: number;
  booking_id: number;
  master_id: string | null;
  delivery_date: string | null;
  delivery_time: string | null;
  payment_method: PaymentMethod | null;
  discount: string | number;        // pg numeric → строка; парсим Number() на UI
  total: string | number;
  items: WorkOrderItem[];
  guarantee_text: string | null;
  notes: string | null;
  client_snapshot: Partial<ClientSnapshot>;
  vehicle_snapshot: Partial<VehicleSnapshot>;
  signature_data: string | null;     // data:image/png;base64,…
  is_signed: boolean;
  pdf_path: string | null;
  created_at: string;
  updated_at: string;
  created_by: string | null;
}

export interface WorkOrderUpsert {
  master_id?: string | null;
  delivery_date?: string | null;
  delivery_time?: string | null;
  payment_method?: PaymentMethod | null;
  discount?: number;
  total?: number | null;
  items?: WorkOrderItem[];
  guarantee_text?: string | null;
  notes?: string | null;
  client_snapshot?: Partial<ClientSnapshot>;
  vehicle_snapshot?: Partial<VehicleSnapshot>;
  signature_data?: string | null;
}

export type ZoneCondition = 'ok' | 'minor' | 'damaged';

export interface AcceptanceZone {
  zone_name: string;
  scratches: boolean;
  dents: boolean;
  condition: ZoneCondition;
}

export interface AcceptanceAct {
  id: number;
  booking_id: number;
  master_id: string | null;
  mileage: number | null;
  zones: AcceptanceZone[];
  damage_description: string | null;
  valuables: string | null;
  client_snapshot: Partial<ClientSnapshot>;
  vehicle_snapshot: Partial<VehicleSnapshot>;
  photos_count: number;
  signature_data: string | null;
  is_signed: boolean;
  pdf_path: string | null;
  created_at: string;
  updated_at: string;
  created_by: string | null;
}

export interface AcceptanceActUpsert {
  master_id?: string | null;
  mileage?: number | null;
  zones?: AcceptanceZone[];
  damage_description?: string | null;
  valuables?: string | null;
  client_snapshot?: Partial<ClientSnapshot>;
  vehicle_snapshot?: Partial<VehicleSnapshot>;
  signature_data?: string | null;
}

export type OrderPhotoType = 'acceptance' | 'progress' | 'result';

export interface OrderPhoto {
  id: number;
  booking_id: number;
  photo_type: OrderPhotoType;
  file_size: number | null;
  mime_type: string | null;
  created_at: string;
  created_by: string | null;
}

// ════════════════════════════════════════════════════════════════════════
// Аналитика студии (GET /api/admin/analytics).
// Эндпоинт доступен только role=owner на тарифе «Студия».
// ════════════════════════════════════════════════════════════════════════
export interface AnalyticsCurrentMonth {
  revenue: number;
  revenue_delta_pct: number;
  orders: number;
  orders_delta: number;
  new_clients: number;
  new_clients_delta: number;
  avg_check: number;
  avg_check_delta_pct: number;
}
export interface AnalyticsByMonth {
  label: string;       // «Апр» — короткий русский месяц
  month_key: string;   // ISO date «2026-04-01» — для ключей
  revenue: number;
  expense: number;
  balance: number;
  orders: number;
  new_clients: number;
  avg_check: number;
}
export interface AnalyticsCategory { name: string; revenue: number; pct: number; }
export interface AnalyticsTopService { name: string; revenue: number; }
export interface AnalyticsRetention {
  total_clients: number;
  repeat_pct: number;
  inactive_3m: number;
  upcoming_next_month: number;
  avg_interval_months: number;
  conversion_30d_pct: number;
}
export interface AnalyticsResponse {
  period: '3m' | '6m' | 'year';
  current_month: AnalyticsCurrentMonth;
  by_month: AnalyticsByMonth[];
  categories: AnalyticsCategory[];
  top_services: AnalyticsTopService[];
  retention: AnalyticsRetention;
}

// 16 зон кузова по умолчанию (см. document_templates.md). Используется
// формой акта приёмки как стартовое заполнение.
export const DEFAULT_ZONES: string[] = [
  'Бампер передний', 'Капот', 'Крыло переднее левое', 'Крыло переднее правое',
  'Дверь передняя левая', 'Дверь передняя правая', 'Дверь задняя левая',
  'Дверь задняя правая', 'Крыша', 'Крыло заднее левое', 'Крыло заднее правое',
  'Бампер задний', 'Крышка багажника', 'Стёкла', 'Диски (комплект)', 'Салон',
];
