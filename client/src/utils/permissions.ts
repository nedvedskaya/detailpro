export type { Role } from './types';
import type { Role } from './types';

// ──────────────────────────────────────────────────────────────────────
// Гранулярные права по разделам (новая система, май 2026)
//
//   SectionLevel: 'edit' — полный доступ, 'view' — только просмотр, 'none' — скрыт
//   SectionPermissions — JSON-объект из users.permissions в БД
//
//   При permissions=null используется фолбэк на роль (обратная совместимость).
//   Пресеты: MANAGER_PRESET / MASTER_PRESET — значения по умолчанию при создании.
// ──────────────────────────────────────────────────────────────────────
export type SectionLevel = 'edit' | 'view' | 'none';
export type SectionKey = 'clients' | 'tasks' | 'calendar' | 'finance';
export type SectionPermissions = Record<SectionKey, SectionLevel>;

export const MANAGER_PRESET: SectionPermissions = {
  clients: 'edit', tasks: 'edit', calendar: 'edit', finance: 'edit',
};
export const MASTER_PRESET: SectionPermissions = {
  clients: 'view', tasks: 'edit', calendar: 'view', finance: 'none',
};

const _LEVEL_RANK: Record<SectionLevel, number> = { none: 0, view: 1, edit: 2 };

export function resolveLevel(
  role: Role,
  permissions: SectionPermissions | null | undefined,
  section: SectionKey,
  canViewFinanceFlag?: boolean | null,
): SectionLevel {
  if (role === 'owner') return 'edit';
  if (permissions && typeof permissions[section] === 'string') return permissions[section];
  // Фолбэк на роль
  if (role === 'manager') {
    if (section === 'finance') return canViewFinanceFlag !== false ? 'edit' : 'none';
    return 'edit';
  }
  if (role === 'master') {
    if (section === 'finance') return 'none';
    if (section === 'tasks') return 'edit';
    return 'view';
  }
  return 'none';
}

export function canViewSection(
  role: Role,
  permissions: SectionPermissions | null | undefined,
  section: SectionKey,
  canViewFinanceFlag?: boolean | null,
): boolean {
  return resolveLevel(role, permissions, section, canViewFinanceFlag) !== 'none';
}

export function canEditSection(
  role: Role,
  permissions: SectionPermissions | null | undefined,
  section: SectionKey,
  canViewFinanceFlag?: boolean | null,
): boolean {
  return resolveLevel(role, permissions, section, canViewFinanceFlag) === 'edit';
}

export function meetsLevel(actual: SectionLevel, required: SectionLevel): boolean {
  return (_LEVEL_RANK[actual] || 0) >= (_LEVEL_RANK[required] || 0);
}

/**
 * Матрица прав в SaaS-CRM.
 *
 *   owner   — полный доступ ко всему, включая админ-панель и удаление БД.
 *   manager — гранулярные права через SectionPermissions (пресет: всё edit).
 *   master  — гранулярные права через SectionPermissions (пресет: clients/calendar view,
 *             tasks edit, finance none).
 *
 * Связка с бэкендом:
 *   - server/routes/tenant.cjs использует sectionGuard(section, minLevel) из middleware.cjs.
 *   - Для пользователей без JSON permissions — фолбэк на роль + can_view_finance.
 */
export type Permission =
  | 'view_clients'
  | 'create_clients'
  | 'edit_clients'
  | 'delete_clients'
  | 'view_tasks'
  | 'create_tasks'
  | 'edit_tasks'
  | 'delete_tasks'
  | 'view_calendar'
  | 'create_bookings'
  | 'edit_bookings'
  | 'delete_bookings'
  | 'view_finance'
  | 'create_transactions'
  | 'edit_transactions'
  | 'delete_transactions'
  | 'manage_categories'
  | 'manage_users'
  | 'view_analytics'
  | 'view_admin'
  | 'view_logs'
  | 'delete_database';

const OWNER_PERMISSIONS: Permission[] = [
  'view_clients', 'create_clients', 'edit_clients', 'delete_clients',
  'view_tasks', 'create_tasks', 'edit_tasks', 'delete_tasks',
  'view_calendar', 'create_bookings', 'edit_bookings', 'delete_bookings',
  'view_finance', 'create_transactions', 'edit_transactions', 'delete_transactions',
  'manage_categories', 'manage_users', 'view_analytics',
  'view_admin', 'view_logs', 'delete_database',
];

// Менеджер = собственник МИНУС админ-блок: ни manage_users / view_admin /
// view_logs / delete_database, ни manage_categories (категории — настройка
// студии, остаётся за owner).
const MANAGER_PERMISSIONS: Permission[] = [
  'view_clients', 'create_clients', 'edit_clients', 'delete_clients',
  'view_tasks', 'create_tasks', 'edit_tasks', 'delete_tasks',
  'view_calendar', 'create_bookings', 'edit_bookings', 'delete_bookings',
  'view_finance', 'create_transactions', 'edit_transactions', 'delete_transactions',
];

// Мастер — read-only по клиентам и календарю. Задачи — единственное, где
// мастер может писать: создавать/править/выполнять. Это его рабочий блок.
// Финансы и админка по-прежнему закрыты полностью.
const MASTER_PERMISSIONS: Permission[] = [
  'view_clients',
  'view_tasks',
  'create_tasks',
  'edit_tasks',
  'delete_tasks',
  'view_calendar',
];

const rolePermissions: Record<Role, Permission[]> = {
  owner: OWNER_PERMISSIONS,
  manager: MANAGER_PERMISSIONS,
  master: MASTER_PERMISSIONS,
};

export const hasPermission = (role: Role, permission: Permission): boolean => {
  return rolePermissions[role]?.includes(permission) || false;
};

// Сохраняем имя isAdmin для обратной совместимости со старыми импортами
// (по семантике это «полные права студии» = собственник).
export const isAdmin = (role: Role): boolean => {
  return role === 'owner';
};

export const isOwner = (role: Role): boolean => {
  return role === 'owner';
};

/**
 * Может ли пользователь вносить изменения в CRM-сущности клиентского раздела.
 * Принимает permissions для гранулярного контроля.
 */
export const canEditEntities = (
  role: Role,
  permissions?: SectionPermissions | null,
  section: SectionKey = 'clients',
): boolean => {
  return resolveLevel(role, permissions, section) === 'edit';
};

/**
 * Может ли пользователь управлять задачами (create / edit / toggle / delete).
 */
export const canEditTasks = (
  role: Role,
  permissions?: SectionPermissions | null,
): boolean => {
  return resolveLevel(role, permissions, 'tasks') === 'edit';
};

/**
 * Может ли пользователь править свой профиль (имя, фамилия, телефон, аватар).
 * Личные данные принадлежат самому пользователю, поэтому это доступно всем
 * ролям; права на CRM-разделы регулируются отдельно через SectionPermissions.
 */
export const canEditOwnProfile = (_role: Role): boolean => true;

// ──────────────────────────────────────────────────────────────────────
// Семантические хелперы для специфичных секций.
//
// Раньше в ProfilePage / AdminPanel / App.tsx по 8+ раз писали
// `role === 'owner'`, что работало, но смешивало «технический факт роли»
// с «бизнес-смыслом действия». Теперь когда меняется правило — например,
// разрешить менеджеру править реквизиты студии — это правится в одной
// точке, а не в 8.
//
// Бэк всё равно перепроверяет — см. server/routes/profile.cjs (only_owner_*),
// поэтому ослабление этих хелперов не открывает дыры.
// ──────────────────────────────────────────────────────────────────────

/** Реквизиты студии для счёта-оферты — правит только собственник. */
export const canEditStudio = (role: Role): boolean => role === 'owner';

/** Управление подпиской (отмена/возобновление) — только собственник. */
export const canManageSubscription = (role: Role): boolean => role === 'owner';

/** Реферальная программа: смотреть и копировать ссылку — только собственник. */
export const canManageReferrals = (role: Role): boolean => role === 'owner';

/** Каталог услуг (ServicesManager) — owner и manager, master read-only. */
export const canManageServices = (
  role: Role,
  permissions?: SectionPermissions | null,
): boolean => resolveLevel(role, permissions, 'calendar') === 'edit';

/**
 * Видит ли пользователь финансы.
 * Для обратной совместимости принимает старый flag; при наличии permissions использует их.
 */
export const canViewFinance = (
  role: Role,
  flagOrPermissions?: boolean | null | SectionPermissions,
  permissions?: SectionPermissions | null,
): boolean => {
  if (role === 'owner') return true;
  const perms = (permissions !== undefined ? permissions : (typeof flagOrPermissions === 'object' && flagOrPermissions !== null ? flagOrPermissions as SectionPermissions : null));
  const flag = typeof flagOrPermissions === 'boolean' ? flagOrPermissions : undefined;
  return resolveLevel(role, perms, 'finance', flag) !== 'none';
};

/**
 * Список вкладок основного TabBar.
 */
export const getAvailableTabs = (
  role: Role,
  financeFlag?: boolean | null,
  permissions?: SectionPermissions | null,
): string[] => {
  const tabs: string[] = [];
  const SECTIONS: SectionKey[] = ['clients', 'tasks', 'calendar', 'finance'];
  for (const section of SECTIONS) {
    const level = resolveLevel(role, permissions, section, section === 'finance' ? financeFlag : undefined);
    if (level !== 'none') tabs.push(section);
  }
  if (role === 'owner') tabs.push('admin');
  return tabs;
};

export const canAccessTab = (
  role: Role,
  tab: string,
  financeFlag?: boolean | null,
  permissions?: SectionPermissions | null,
): boolean => {
  if (tab === 'admin') return role === 'owner';
  const section = tab as SectionKey;
  const validSections: SectionKey[] = ['clients', 'tasks', 'calendar', 'finance'];
  if (!validSections.includes(section)) return false;
  const level = resolveLevel(role, permissions, section, section === 'finance' ? financeFlag : undefined);
  return level !== 'none';
};

export { getRoleName } from './constants';

const SECTION_LABELS: Record<SectionKey, string> = {
  clients: 'Клиенты', tasks: 'Задачи', calendar: 'Календарь', finance: 'Финансы',
};

/**
 * Читаемый список разделов для карточки сотрудника в AdminPanel.
 */
export const getVisibleSectionLabels = (
  role: Role,
  financeFlag?: boolean | null,
  permissions?: SectionPermissions | null,
): string[] => {
  if (role === 'owner') return ['Клиенты', 'Задачи', 'Календарь', 'Финансы', 'Админ-панель'];
  const list: string[] = [];
  const SECTIONS: SectionKey[] = ['clients', 'tasks', 'calendar', 'finance'];
  for (const section of SECTIONS) {
    const level = resolveLevel(role, permissions, section, section === 'finance' ? financeFlag : undefined);
    if (level === 'edit') list.push(SECTION_LABELS[section]);
    else if (level === 'view') list.push(`${SECTION_LABELS[section]} (просмотр)`);
  }
  return list;
};
