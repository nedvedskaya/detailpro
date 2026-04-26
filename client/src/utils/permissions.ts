export type { Role } from './types';
import type { Role } from './types';

/**
 * Матрица прав в SaaS-CRM.
 *
 *   owner   — полный доступ ко всему, включая админ-панель и удаление БД.
 *   manager — может всё в 4-х CRM-блоках (клиенты, задачи, календарь, финансы),
 *             но БЕЗ админки. Видимость финансов адаптивная: owner может снять
 *             в админ-панели тоггл can_view_finance — тогда вкладки «Финансы»
 *             у конкретного менеджера не будет (см. canViewFinance ниже).
 *   master  — read-only по 3 блокам (клиенты, задачи, календарь). Финансы
 *             НЕ видит никогда — это хардкод (мастер по бизнес-смыслу не должен
 *             видеть деньги студии).
 *
 * Связка с бэкендом:
 *   - Серверные write-руты в server/routes/tenant.cjs дополнительно защищены
 *     requireRole('owner','manager') — даже если фронт пропустит master'a
 *     к кнопке «Сохранить», бэк отдаст 403.
 *   - Финансы: server/routes/tenant.cjs#canSeeFinance закрывает /transactions*
 *     для master всегда и для manager'a без флага can_view_finance.
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

// Мастер — только просмотр клиентов / задач / календаря. Финансы и админка
// исключены полностью (никаких view_finance даже для чтения).
const MASTER_PERMISSIONS: Permission[] = [
  'view_clients',
  'view_tasks',
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
 * Может ли роль вообще вносить изменения (create / edit / delete) в CRM-сущности.
 * Используется как единый булевый флаг во view-компонентах: если canEdit=false,
 * скрываем кнопки «Добавить»/«Редактировать»/«Удалить», открываем модалки в
 * read-only-режиме. master → false, owner/manager → true.
 */
export const canEditEntities = (role: Role): boolean => {
  return role !== 'master';
};

/**
 * Видит ли пользователь финансы.
 *
 * Логика согласована с серверным /api/auth/me и /api/profile (см. шейпер
 * в server/routes/profile.cjs#computeCanViewFinance):
 *   - master    → false ВСЕГДА (хардкод бизнес-правила).
 *   - owner     → true ВСЕГДА.
 *   - manager   → true, если флаг can_view_finance не равен false. Default true,
 *                 чтобы не сломать существующих менеджеров до отдельной
 *                 настройки в админ-панели.
 *
 * @param role           — роль текущего пользователя
 * @param flag           — значение users.can_view_finance из ответа /me (boolean | undefined)
 */
export const canViewFinance = (role: Role, flag?: boolean | null): boolean => {
  if (role === 'master') return false;
  if (role === 'owner') return true;
  return flag !== false;
};

/**
 * Список вкладок основного TabBar.
 * Финансы фильтруются ОТДЕЛЬНО через canViewFinance, потому что это решение
 * зависит не только от роли, но и от per-user флага can_view_finance.
 * Здесь оставляем только тот фильтр, что зависит от роли.
 */
export const getAvailableTabs = (role: Role, financeFlag?: boolean | null): string[] => {
  const tabs: string[] = [];

  if (hasPermission(role, 'view_clients')) tabs.push('clients');
  if (hasPermission(role, 'view_tasks')) tabs.push('tasks');
  if (hasPermission(role, 'view_calendar')) tabs.push('calendar');
  if (hasPermission(role, 'view_finance') && canViewFinance(role, financeFlag)) tabs.push('finance');
  if (hasPermission(role, 'view_admin')) tabs.push('admin');

  return tabs;
};

export const canAccessTab = (role: Role, tab: string, financeFlag?: boolean | null): boolean => {
  const tabPermissions: Record<string, Permission> = {
    clients: 'view_clients',
    tasks: 'view_tasks',
    calendar: 'view_calendar',
    finance: 'view_finance',
    admin: 'view_admin',
  };

  const requiredPermission = tabPermissions[tab];
  if (!requiredPermission) return false;
  if (!hasPermission(role, requiredPermission)) return false;
  if (tab === 'finance') return canViewFinance(role, financeFlag);
  return true;
};

export { getRoleName } from './constants';

/**
 * Возвращает читаемый список разделов, доступных пользователю в этом
 * рабочем пространстве. Используется в AdminPanel для строки «Видит разделы:
 * Клиенты, Задачи, …» — owner сразу понимает, что фактически открыто
 * сотруднику, не догадываясь по чек-боксам.
 *
 *   - owner    : Клиенты, Задачи, Календарь, Финансы, Админ-панель
 *   - manager  : Клиенты, Задачи, Календарь [+ Финансы если canViewFinance]
 *   - master   : Клиенты (просмотр), Задачи (просмотр), Календарь (просмотр)
 */
export const getVisibleSectionLabels = (role: Role, financeFlag?: boolean | null): string[] => {
  if (role === 'master') {
    return ['Клиенты (просмотр)', 'Задачи (просмотр)', 'Календарь (просмотр)'];
  }
  const list = ['Клиенты', 'Задачи', 'Календарь'];
  if (canViewFinance(role, financeFlag)) list.push('Финансы');
  if (role === 'owner') list.push('Админ-панель');
  return list;
};
