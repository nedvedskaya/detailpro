export type { Role } from './types';
import type { Role } from './types';

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

const rolePermissions: Record<Role, Permission[]> = {
  owner: [
    'view_clients',
    'create_clients',
    'edit_clients',
    'delete_clients',
    'view_tasks',
    'create_tasks',
    'edit_tasks',
    'delete_tasks',
    'view_calendar',
    'create_bookings',
    'edit_bookings',
    'delete_bookings',
    'view_finance',
    'create_transactions',
    'edit_transactions',
    'delete_transactions',
    'manage_categories',
    'manage_users',
    'view_analytics',
    'view_admin',
    'view_logs',
    'delete_database'
  ],
  
  manager: [
    'view_clients',
    'create_clients',
    'edit_clients',
    'view_calendar',
    'create_bookings',
    'edit_bookings'
  ],
  
  master: [
    'view_clients',
    'view_calendar'
  ]
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

export const getAvailableTabs = (role: Role): string[] => {
  const tabs: string[] = [];
  
  if (hasPermission(role, 'view_clients')) {
    tabs.push('clients');
  }
  
  if (hasPermission(role, 'view_tasks')) {
    tabs.push('tasks');
  }
  
  if (hasPermission(role, 'view_calendar')) {
    tabs.push('calendar');
  }
  
  if (hasPermission(role, 'view_finance')) {
    tabs.push('finance');
  }

  if (hasPermission(role, 'view_admin')) {
    tabs.push('admin');
  }
  
  return tabs;
};

export const canAccessTab = (role: Role, tab: string): boolean => {
  const tabPermissions: Record<string, Permission> = {
    clients: 'view_clients',
    tasks: 'view_tasks',
    calendar: 'view_calendar',
    finance: 'view_finance',
    admin: 'view_admin'
  };
  
  const requiredPermission = tabPermissions[tab];
  return requiredPermission ? hasPermission(role, requiredPermission) : false;
};

export { getRoleName } from './constants';
