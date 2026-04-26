/**
 * AdminPanel — управление членами студии (только role=owner).
 *
 * Модель ролей (после миграции 001_profile_and_roles.sql):
 *   owner   — Собственник студии. Один на студию, создаётся при signup.
 *             Через UI **НЕ создаётся** (этот компонент не показывает option «owner»).
 *   manager — Менеджер: всё кроме админки и биллинга.
 *   master  — Мастер: свои записи/задачи.
 *
 * Лимит на количество сотрудников зависит от тарифа (см. server/lib/plans.cjs):
 *   solo=1 (только собственник) → нельзя добавлять
 *   studio=3 (собственник + 2)
 *   trial=3
 *   cancelled=0
 *
 * Лимит дублируется на фронте: GET /api/profile.limits — отключаем кнопку
 * «Добавить пользователя» когда currentUsers >= maxUsers, чтобы юзер увидел
 * подсказку до запроса. Бэк всё равно проверяет (POST /api/admin/users → 402).
 */

import { useState, useEffect } from 'react';
import { Users, Activity, UserPlus, Shield, ShieldOff, Clock, ArrowLeft, Trash2 } from 'lucide-react';
import { api } from '@/utils/api';
import { getRoleName } from '@/utils/constants';
import { formatDateTime } from '@/utils/helpers';
import { Modal } from '@/app/components/ui/Modal';
import { showToast } from '@/app/components/ui/Toast';
import { getUser } from '@/utils/auth';
import type { ProfileResponse, Role } from '@/utils/types';

interface ApiUser {
  id: string;
  name: string;
  email: string;
  role: Role;
  is_active: boolean;
  last_login?: string | null;
  created_at?: string;
}

interface ActivityLog {
  id: number | string;
  user_id?: string | null;
  user_name?: string | null;
  action: string;
  entity_type?: string;
  entity_id?: number | string;
  entity_name?: string;
  details?: string;
  created_at: string;
}

interface AdminPanelProps {
  onBack: () => void;
}

type AdminTab = 'users' | 'logs';

export const AdminPanel = ({ onBack }: AdminPanelProps) => {
  const currentUser = getUser();
  const [activeTab, setActiveTab] = useState<AdminTab>('users');
  const [users, setUsers] = useState<ApiUser[]>([]);
  const [logs, setLogs] = useState<ActivityLog[]>([]);
  const [loading, setLoading] = useState(false);
  const [showAddModal, setShowAddModal] = useState(false);
  // лимиты тарифа — для блокировки «Добавить» и счётчика «N из M».
  // Подгружаем тем же эндпоинтом, что и ProfilePage. При ошибке — null,
  // фронт ведёт себя как раньше (бэк всё равно вернёт 402 на POST).
  const [limits, setLimits] = useState<ProfileResponse['limits'] | null>(null);
  const [planLabel, setPlanLabel] = useState<string>('');

  const [newUser, setNewUser] = useState<{
    email: string;
    password: string;
    name: string;
    role: Role;
  }>({
    email: '',
    password: '',
    name: '',
    role: 'manager',
  });

  useEffect(() => {
    loadUsers();
    loadLogs();
    loadLimits();
  }, []);

  const loadUsers = async () => {
    try {
      setLoading(true);
      const data = await api.getAdminUsers();
      setUsers(data || []);
    } catch (error) {
      console.error('Error loading users:', error);
    } finally {
      setLoading(false);
    }
  };

  const loadLimits = async () => {
    try {
      const profile = await api.getProfile();
      setLimits(profile.limits);
      setPlanLabel(profile.studio.planLabel || profile.studio.plan);
    } catch (error) {
      console.error('Error loading limits:', error);
    }
  };

  const loadLogs = async () => {
    try {
      const data = await api.getActivityLogs({ limit: 100 });
      setLogs(data || []);
    } catch (error) {
      console.error('Error loading logs:', error);
    }
  };

  const isSelf = (u: ApiUser) => currentUser?.id === u.id;

  const handleBlockUser = async (user: ApiUser) => {
    if (isSelf(user)) {
      showToast('Нельзя заблокировать себя', 'warning');
      return;
    }
    const action = user.is_active ? 'заблокировать' : 'разблокировать';
    if (!confirm(`Вы уверены, что хотите ${action} пользователя ${user.name}?`)) return;
    try {
      await api.blockUser(user.id, !user.is_active);
      loadUsers();
      loadLogs();
    } catch (error: any) {
      showToast(error?.message || 'Ошибка при изменении статуса', 'error');
    }
  };

  const handleDeleteUser = async (user: ApiUser) => {
    if (isSelf(user)) {
      showToast('Нельзя удалить себя', 'warning');
      return;
    }
    if (!confirm(`Вы уверены, что хотите удалить ${user.name}? Это действие нельзя отменить.`)) return;
    try {
      await api.deleteUser(user.id);
      showToast(`Пользователь ${user.name} удалён`, 'success');
      loadUsers();
      loadLogs();
    } catch (error: any) {
      showToast(error?.message || 'Ошибка при удалении', 'error');
    }
  };

  const handleAddUser = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newUser.email || !newUser.password || !newUser.name) {
      showToast('Заполните все обязательные поля', 'warning');
      return;
    }
    if (newUser.password.length < 8) {
      showToast('Пароль должен быть не менее 8 символов', 'warning');
      return;
    }
    try {
      await api.createAdminUser(newUser);
      setNewUser({ email: '', password: '', name: '', role: 'manager' });
      setShowAddModal(false);
      loadUsers();
      loadLogs();
      loadLimits();
    } catch (error: any) {
      // 402 plan_limit_reached — бэк уже подсчитал, отдадим текст as-is.
      showToast(error?.message || 'Ошибка при создании пользователя', 'error');
    }
  };

  const handleAddClick = () => {
    if (limits && !limits.canAddUsers) {
      showToast(
        `Лимит тарифа «${planLabel}» — ${limits.maxUsers}. Повысьте тариф в Профиле.`,
        'warning'
      );
      return;
    }
    setShowAddModal(true);
  };

  const getActionLabel = (action: string) => {
    const labels: Record<string, string> = {
      login: 'Вход',
      logout: 'Выход',
      user_created: 'Создание пользователя',
      user_updated: 'Обновление пользователя',
      user_deleted: 'Удаление пользователя',
      user_blocked: 'Блокировка',
      user_unblocked: 'Разблокировка',
      client_created: 'Новый клиент',
      client_updated: 'Обновление клиента',
      client_deleted: 'Удаление клиента',
    };
    return labels[action] || action;
  };

  return (
    <div className="flex flex-col h-full bg-zinc-50 overflow-hidden">
      <div className="sticky top-0 z-30 bg-white shadow-sm shrink-0">
        <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-200">
          <div className="flex items-center gap-3">
            <button onClick={onBack} className="w-8 h-8 rounded-full bg-zinc-100 flex items-center justify-center active:scale-95 transition-all">
              <ArrowLeft size={18} className="text-zinc-600" />
            </button>
            <h1 className="text-xl font-black">Админ-панель</h1>
          </div>
          <button
            onClick={handleAddClick}
            disabled={!!limits && !limits.canAddUsers}
            title={limits && !limits.canAddUsers ? `Лимит тарифа «${planLabel}»: ${limits.maxUsers}` : 'Добавить пользователя'}
            className={`w-10 h-10 rounded-full flex items-center justify-center transition-all ${
              limits && !limits.canAddUsers
                ? 'bg-zinc-300 cursor-not-allowed'
                : 'bg-black active:scale-95'
            }`}
          >
            <UserPlus size={18} className="text-white" />
          </button>
        </div>

        <div className="flex border-b border-zinc-200">
          {[
            { id: 'users' as AdminTab, label: 'Пользователи', icon: Users },
            { id: 'logs' as AdminTab, label: 'Логи', icon: Activity },
          ].map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`flex-1 flex items-center justify-center gap-2 py-3 text-sm font-bold transition-all border-b-2 ${
                activeTab === tab.id ? 'border-black text-black' : 'border-transparent text-zinc-400'
              }`}
            >
              <tab.icon size={16} />
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-4 pt-4 pb-32 overscroll-contain">
        {activeTab === 'users' && (
          <div className="space-y-3">
            {limits && (
              <div className="bg-white border border-zinc-200 rounded-2xl p-4">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs font-bold text-zinc-500">
                    Сотрудников на тарифе «{planLabel}»
                  </span>
                  <span className="text-xs font-bold text-zinc-800">
                    {limits.currentUsers} из {limits.maxUsers}
                  </span>
                </div>
                <div className="h-1.5 bg-zinc-100 rounded-full overflow-hidden">
                  <div
                    className={`h-full transition-[width] duration-500 ${
                      limits.canAddUsers ? 'bg-zinc-900' : 'bg-amber-500'
                    }`}
                    style={{
                      width: `${limits.maxUsers > 0
                        ? Math.min(100, Math.round((limits.currentUsers / limits.maxUsers) * 100))
                        : 0}%`,
                    }}
                  />
                </div>
                {!limits.canAddUsers && (
                  <p className="mt-2 text-[11px] text-amber-600 font-medium">
                    Лимит достигнут. Чтобы добавить сотрудника — повысьте тариф в Профиле.
                  </p>
                )}
              </div>
            )}
            {loading ? (
              <div className="text-center py-12 text-zinc-400 font-medium">Загрузка...</div>
            ) : users.length === 0 ? (
              <div className="text-center py-12 text-zinc-400 font-medium">Пользователи не найдены</div>
            ) : (
              users.map((user) => {
                const isOwner = user.role === 'owner';
                const self = isSelf(user);
                return (
                  <div key={user.id} className="bg-white border border-zinc-200 rounded-2xl p-4 space-y-3">
                    <div className="flex items-center gap-3">
                      <div className={`w-11 h-11 rounded-full flex items-center justify-center text-white text-base font-black shrink-0 ${
                        isOwner ? 'bg-gradient-to-br from-amber-400 to-amber-500' : 'bg-gradient-to-br from-zinc-400 to-zinc-500'
                      }`}>
                        {user.name.charAt(0).toUpperCase()}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <h3 className="font-bold text-base text-zinc-900 truncate">{user.name}</h3>
                          <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${
                            user.is_active ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'
                          }`}>
                            {user.is_active ? 'Активен' : 'Заблокирован'}
                          </span>
                          {self && (
                            <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-zinc-100 text-zinc-500">
                              это вы
                            </span>
                          )}
                        </div>
                        <p className="text-xs text-zinc-400 font-medium truncate">{user.email}</p>
                      </div>
                    </div>

                    <div className="grid grid-cols-2 gap-3 text-xs">
                      <div>
                        <span className="text-zinc-400 font-medium">Роль</span>
                        <div className="flex items-center gap-1 mt-0.5">
                          {isOwner && <Shield size={12} className="text-amber-500" />}
                          <p className="font-bold text-zinc-800">{getRoleName(user.role)}</p>
                        </div>
                      </div>
                      <div>
                        <span className="text-zinc-400 font-medium">Email</span>
                        <p className="font-bold text-zinc-800 truncate">{user.email || '—'}</p>
                      </div>
                      <div className="col-span-2">
                        <span className="text-zinc-400 font-medium">Последний вход</span>
                        <div className="flex items-center gap-1 mt-0.5">
                          <Clock size={12} className="text-zinc-400" />
                          <p className="font-bold text-zinc-800">{user.last_login ? formatDateTime(user.last_login) : 'Никогда'}</p>
                        </div>
                      </div>
                    </div>

                    {!self && (
                      <div className="flex gap-2 pt-2 border-t border-zinc-100">
                        <button
                          onClick={() => handleBlockUser(user)}
                          className={`flex-1 flex items-center justify-center gap-1.5 py-2.5 rounded-xl text-xs font-bold transition-all active:scale-[0.97] ${
                            user.is_active ? 'bg-red-50 text-red-600 active:bg-red-100' : 'bg-green-50 text-green-600 active:bg-green-100'
                          }`}
                        >
                          {user.is_active ? <><ShieldOff size={14} /> Заблокировать</> : <><Shield size={14} /> Разблокировать</>}
                        </button>
                        <button
                          onClick={() => handleDeleteUser(user)}
                          className="flex items-center justify-center gap-1.5 px-4 py-2.5 rounded-xl text-xs font-bold bg-red-50 text-red-600 active:bg-red-100 transition-all active:scale-[0.97]"
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>
        )}

        {activeTab === 'logs' && (
          <div className="space-y-2">
            <div className="flex items-center justify-between mb-2">
              <p className="text-xs text-zinc-400 font-medium">{logs.length} записей</p>
              <button
                onClick={loadLogs}
                className="text-xs font-bold text-zinc-500 bg-zinc-100 px-3 py-1.5 rounded-lg active:scale-95 transition-all"
              >
                Обновить
              </button>
            </div>
            {logs.length === 0 ? (
              <div className="text-center py-12 text-zinc-400 font-medium">Логи пока отсутствуют</div>
            ) : (
              logs.map((log) => (
                <div key={log.id} className="bg-white border border-zinc-200 rounded-xl p-3 space-y-1.5">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-bold text-zinc-800">{log.user_name || 'Система'}</span>
                    <span className="text-[10px] text-zinc-400 font-medium whitespace-nowrap">{formatDateTime(log.created_at)}</span>
                  </div>
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-[11px] font-bold px-2 py-0.5 bg-zinc-100 text-zinc-600 rounded-lg">
                      {getActionLabel(log.action)}
                    </span>
                    {log.entity_name && (
                      <span className="text-xs text-zinc-500 truncate">{log.entity_name}</span>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>
        )}
      </div>

      <Modal isOpen={showAddModal} onClose={() => setShowAddModal(false)} title="Добавить пользователя" position="center">
        <form onSubmit={handleAddUser} className="space-y-4">
          <div>
            <label className="block text-sm font-bold text-zinc-700 mb-1.5">Имя *</label>
            <input
              type="text"
              value={newUser.name}
              onChange={(e) => setNewUser({ ...newUser, name: e.target.value })}
              className="w-full px-4 py-3 border border-zinc-200 rounded-xl font-bold outline-none focus:border-black transition-all"
              required
            />
          </div>
          <div>
            <label className="block text-sm font-bold text-zinc-700 mb-1.5">Email *</label>
            <input
              type="email"
              value={newUser.email}
              onChange={(e) => setNewUser({ ...newUser, email: e.target.value })}
              className="w-full px-4 py-3 border border-zinc-200 rounded-xl font-bold outline-none focus:border-black transition-all"
              required
            />
          </div>
          <div>
            <label className="block text-sm font-bold text-zinc-700 mb-1.5">Пароль *</label>
            <input
              type="password"
              value={newUser.password}
              onChange={(e) => setNewUser({ ...newUser, password: e.target.value })}
              className="w-full px-4 py-3 border border-zinc-200 rounded-xl font-bold outline-none focus:border-black transition-all"
              required
              minLength={8}
            />
          </div>
          <div>
            <label className="block text-sm font-bold text-zinc-700 mb-1.5">Роль</label>
            <select
              value={newUser.role}
              onChange={(e) => setNewUser({ ...newUser, role: e.target.value as Role })}
              className="w-full px-4 py-3 border border-zinc-200 rounded-xl font-bold outline-none focus:border-black transition-all bg-white"
            >
              {/* «Собственник» через UI не создаётся (он — единственный, тот, кто завёл студию). */}
              <option value="manager">Менеджер</option>
              <option value="master">Мастер</option>
            </select>
          </div>
          <div className="flex gap-3 pt-2">
            <button
              type="button"
              onClick={() => setShowAddModal(false)}
              className="flex-1 px-4 py-3 border border-zinc-200 text-zinc-700 rounded-xl font-bold active:scale-[0.97] transition-all"
            >
              Отмена
            </button>
            <button
              type="submit"
              className="flex-1 px-4 py-3 bg-black text-white rounded-xl font-bold active:scale-[0.97] transition-all"
            >
              Создать
            </button>
          </div>
        </form>
      </Modal>
    </div>
  );
};
