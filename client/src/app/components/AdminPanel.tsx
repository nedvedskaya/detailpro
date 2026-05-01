/**
 * AdminPanel — админка студии (только role=owner).
 *
 * Три вкладки:
 *   1) Сотрудники (users) — список сотрудников + добавление/редактирование/
 *      сброс пароля/блокировка/удаление. Лимит «N из M» по тарифу.
 *   2) Активность (activity) — активити-лог с фильтрами (сотрудник/действие/
 *      диапазон дат) и пагинацией load-more по 50. Цветовая кодировка
 *      по getActionTone(action). Хранение 90 дней (cron, server/lib/cron.cjs).
 *   3) Тариф (plan) — read-only карточка-сводка с прогресс-баром и CTA
 *      «Управление тарифом» в /profile (тариф редактируется только там).
 *
 * Роли (после миграции 001_profile_and_roles.sql):
 *   owner   — собственник студии. Через UI не создаётся.
 *   manager — менеджер: всё кроме админки/биллинга. Видимость финансов
 *             регулируется флагом can_view_finance (toggle в edit-модалке).
 *   master  — мастер: только просмотр. Финансы скрыты хардкодом
 *             (computeCanViewFinance в utils/permissions.ts).
 *
 * Лимит сотрудников см. server/lib/plans.cjs (solo=1 / studio=3 / trial=3).
 * UI блокирует «Добавить» на лимите; бэк дублирует проверку → 402.
 *
 * Сброс пароля: бэк генерирует ~12-символьный base64url-пароль и возвращает
 * его в ответе ОДИН РАЗ. UI показывает в модалке с кнопкой «Скопировать»;
 * после закрытия пароль больше не получить — собственник передаёт вручную.
 *
 * При добавлении временный пароль генерируется на клиенте (crypto.getRandomValues),
 * чтобы owner мог скопировать перед отправкой запроса. Регенерация — кнопкой.
 */

import { useState, useEffect, useMemo, useCallback } from 'react';
import {
  Users, Activity, UserPlus, Shield, ShieldOff, Clock,
  ArrowLeft, Trash2, Edit3, KeyRound, Copy, Check, RefreshCw, X, ChevronDown,
  Eye, EyeOff, Lock, BarChart3,
} from 'lucide-react';
import { AnalyticsDashboard } from '@/app/components/admin/AnalyticsDashboard';
import { api } from '@/utils/api';
import { getRoleName, getActionLabel, getActionTone, formatEntityName, formatLogDetails } from '@/utils/constants';
import { getVisibleSectionLabels } from '@/utils/permissions';
import { formatDateTime, formatDateRu } from '@/utils/helpers';
import { Modal } from '@/app/components/ui/Modal';
import { showToast } from '@/app/components/ui/Toast';
import { handleApiError } from '@/utils/stateHelpers';
import { getUser } from '@/utils/auth';
import type { ProfileResponse, Role, StudioUser, ActivityLogEntry } from '@/utils/types';

interface AdminPanelProps {
  onBack: () => void;
  /** kept for backwards compat — Тариф вкладка убрана, кнопка не вызывается. */
  onOpenProfile?: () => void;
  onUsersChange?: () => void;
}

type AdminTab = 'users' | 'activity' | 'analytics';

const PAGE_SIZE = 50;

// Генерация временного пароля на клиенте (для add-модалки).
// Бэк свой генерит точно так же при reset-password.
function generateTempPassword(): string {
  const bytes = new Uint8Array(9);
  crypto.getRandomValues(bytes);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 1) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

const TONE_BADGE: Record<'green' | 'blue' | 'red' | 'gray', string> = {
  green: 'bg-green-50 text-green-700 border-green-200',
  blue: 'bg-blue-50 text-blue-700 border-blue-200',
  red: 'bg-red-50 text-red-700 border-red-200',
  gray: 'bg-zinc-50 text-zinc-600 border-zinc-200',
};

const TONE_DOT: Record<'green' | 'blue' | 'red' | 'gray', string> = {
  green: 'bg-green-500',
  blue: 'bg-blue-500',
  red: 'bg-red-500',
  gray: 'bg-zinc-400',
};

export const AdminPanel = ({ onBack, onUsersChange }: AdminPanelProps) => {
  const currentUser = getUser();
  const [activeTab, setActiveTab] = useState<AdminTab>('users');
  // Per-user busy-индикатор для inline-toggle «Видит финансы».
  // Защищаемся от двойного клика и показываем «…» пока запрос летит.
  const [financeBusyId, setFinanceBusyId] = useState<string | null>(null);

  // ── Сотрудники ──
  const [users, setUsers] = useState<StudioUser[]>([]);
  const [usersLoading, setUsersLoading] = useState(false);

  // ── Тариф / лимиты ──
  const [limits, setLimits] = useState<ProfileResponse['limits'] | null>(null);
  const [planLabel, setPlanLabel] = useState<string>('');
  // Код тарифа («solo» | «studio» | «trial» | «cancelled») — нужен для гейтинга
  // вкладки «Аналитика»: она показывается только на «Студии».
  const [planCode, setPlanCode] = useState<string | null>(null);

  // ── Активность ──
  const [logs, setLogs] = useState<ActivityLogEntry[]>([]);
  const [logsLoading, setLogsLoading] = useState(false);
  const [logsHasMore, setLogsHasMore] = useState(false);
  const [logsOffset, setLogsOffset] = useState(0);
  const [filterUser, setFilterUser] = useState<string>('');
  const [filterAction, setFilterAction] = useState<string>('');
  const [filterFrom, setFilterFrom] = useState<string>('');
  const [filterTo, setFilterTo] = useState<string>('');

  // ── Add-модалка ──
  const [showAddModal, setShowAddModal] = useState(false);
  const [addForm, setAddForm] = useState<{
    email: string; password: string; name: string; role: Role; can_view_finance: boolean;
  }>({ email: '', password: generateTempPassword(), name: '', role: 'manager', can_view_finance: true });
  const [addSubmitting, setAddSubmitting] = useState(false);
  const [copiedAddPwd, setCopiedAddPwd] = useState(false);

  // ── Edit-модалка ──
  const [editTarget, setEditTarget] = useState<StudioUser | null>(null);
  const [editForm, setEditForm] = useState<{
    name: string; role: Role; can_view_finance: boolean;
  }>({ name: '', role: 'manager', can_view_finance: true });
  const [editSubmitting, setEditSubmitting] = useState(false);

  // ── Reset-password модалка (показ временного пароля один раз) ──
  const [resetTarget, setResetTarget] = useState<StudioUser | null>(null);
  const [resetTempPwd, setResetTempPwd] = useState<string>('');
  const [copiedResetPwd, setCopiedResetPwd] = useState(false);

  // ── Change-own-password модалка (владелец меняет свой пароль) ──
  // Используется существующий POST /api/auth/password { oldPassword, newPassword }.
  // Этот же эндпоинт инвалидирует все остальные сессии текущего пользователя.
  const [showOwnPwdModal, setShowOwnPwdModal] = useState(false);
  const [ownPwdForm, setOwnPwdForm] = useState({ oldPassword: '', newPassword: '', confirmPassword: '' });
  const [ownPwdSubmitting, setOwnPwdSubmitting] = useState(false);
  const [ownPwdShow, setOwnPwdShow] = useState(false);

  // ── «Забыли пароль?» прямо из модалки смены пароля ──
  // Если owner забыл текущий пароль — даём ему запустить тот же TG-flow,
  // что и на LoginScreen.tsx (api.requestPasswordReset). Email не спрашиваем —
  // берём из currentUser, чтобы не было путаницы.
  //   'idle' | 'submitting' | 'sent' | 'no_channel' | 'error'
  const [ownPwdResetState, setOwnPwdResetState] = useState<'idle' | 'submitting' | 'sent' | 'no_channel' | 'error'>('idle');
  const [ownPwdResetError, setOwnPwdResetError] = useState('');

  const requestOwnPwdReset = async () => {
    if (!currentUser?.email) {
      setOwnPwdResetError('Не удалось определить ваш email. Перезайдите в систему.');
      setOwnPwdResetState('error');
      return;
    }
    setOwnPwdResetError('');
    setOwnPwdResetState('submitting');
    try {
      const r = await api.requestPasswordReset(currentUser.email);
      if (r.delivery === 'no_channel') setOwnPwdResetState('no_channel');
      else setOwnPwdResetState('sent');
    } catch (err: any) {
      if (err?.status === 429) {
        setOwnPwdResetError('Слишком много попыток. Попробуйте через 15 минут.');
        setOwnPwdResetState('error');
      } else {
        // Любая другая ошибка — не выдаём существование email,
        // показываем нейтральный «sent».
        setOwnPwdResetState('sent');
      }
    }
  };

  // ── Загрузка ──
  const loadUsers = useCallback(async () => {
    try {
      setUsersLoading(true);
      const data = await api.getAdminUsers();
      setUsers(data || []);
      onUsersChange?.();
    } catch (e) {
      console.error('Error loading users:', e);
    } finally {
      setUsersLoading(false);
    }
  }, [onUsersChange]);

  const loadLimits = useCallback(async () => {
    try {
      const profile = await api.getProfile();
      setLimits(profile.limits);
      setPlanLabel(profile.studio.planLabel || profile.studio.plan);
      setPlanCode(profile.studio.plan || null);
    } catch (e) {
      console.error('Error loading limits:', e);
    }
  }, []);

  const loadLogs = useCallback(async (reset: boolean) => {
    try {
      setLogsLoading(true);
      const offset = reset ? 0 : logsOffset;
      const data = await api.getActivityLogs({
        limit: PAGE_SIZE,
        offset,
        user_id: filterUser || undefined,
        action: filterAction || undefined,
        from: filterFrom || undefined,
        to: filterTo || undefined,
      });
      const list = data || [];
      setLogs((prev) => (reset ? list : [...prev, ...list]));
      setLogsHasMore(list.length === PAGE_SIZE);
      setLogsOffset(offset + list.length);
    } catch (e) {
      console.error('Error loading logs:', e);
    } finally {
      setLogsLoading(false);
    }
  }, [logsOffset, filterUser, filterAction, filterFrom, filterTo]);

  useEffect(() => {
    loadUsers();
    loadLimits();
    loadLogs(true);
    // первоначальная загрузка
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // При смене фильтров на вкладке «Активность» — перезагрузка с нуля.
  useEffect(() => {
    if (activeTab !== 'activity') return;
    setLogsOffset(0);
    loadLogs(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterUser, filterAction, filterFrom, filterTo]);

  const isSelf = (u: StudioUser) => currentUser?.id === u.id;

  // ── Уникальные action'ы для селекта-фильтра ──
  const actionOptions = useMemo(() => {
    const set = new Set<string>();
    logs.forEach((l) => set.add(l.action));
    return Array.from(set).sort();
  }, [logs]);

  // ── Действия с сотрудниками ──
  const handleAddClick = () => {
    if (limits && !limits.canAddUsers) {
      showToast(`Лимит тарифа «${planLabel}» — ${limits.maxUsers}. Повысьте тариф в Профиле.`, 'warning');
      return;
    }
    setAddForm({ email: '', password: generateTempPassword(), name: '', role: 'manager', can_view_finance: true });
    setCopiedAddPwd(false);
    setShowAddModal(true);
  };

  const handleAddSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!addForm.email || !addForm.password || !addForm.name) {
      showToast('Заполните все обязательные поля', 'warning');
      return;
    }
    if (addForm.password.length < 8) {
      showToast('Пароль должен быть не менее 8 символов', 'warning');
      return;
    }
    try {
      setAddSubmitting(true);
      // Для master can_view_finance бэк всё равно проигнорирует/перезатрёт false.
      const payload = {
        email: addForm.email.trim(),
        password: addForm.password,
        name: addForm.name.trim(),
        role: addForm.role,
        can_view_finance: addForm.role === 'manager' ? addForm.can_view_finance : false,
      };
      await api.createAdminUser(payload);
      showToast(`Сотрудник ${payload.name} добавлен`, 'success');
      setShowAddModal(false);
      loadUsers();
      loadLimits();
      if (activeTab === 'activity') loadLogs(true);
    } catch (err) {
      handleApiError(err, 'Ошибка при создании сотрудника', 'createAdminUser');
    } finally {
      setAddSubmitting(false);
    }
  };

  const handleEditOpen = (u: StudioUser) => {
    setEditTarget(u);
    setEditForm({
      name: u.name,
      role: u.role === 'owner' ? 'owner' : u.role,
      can_view_finance: u.can_view_finance !== false,
    });
  };

  const handleEditSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editTarget) return;
    try {
      setEditSubmitting(true);
      const patch: Parameters<typeof api.updateAdminUser>[1] = {};
      if (editForm.name.trim() && editForm.name.trim() !== editTarget.name) {
        patch.name = editForm.name.trim();
      }
      if (editTarget.role !== 'owner' && editForm.role !== editTarget.role) {
        patch.role = editForm.role;
      }
      // can_view_finance имеет смысл только для manager; для master бэк всё равно false.
      if (editForm.role === 'manager' && editForm.can_view_finance !== (editTarget.can_view_finance !== false)) {
        patch.can_view_finance = editForm.can_view_finance;
      }
      if (Object.keys(patch).length === 0) {
        setEditTarget(null);
        return;
      }
      await api.updateAdminUser(editTarget.id, patch);
      showToast('Изменения сохранены', 'success');
      setEditTarget(null);
      loadUsers();
      if (activeTab === 'activity') loadLogs(true);
    } catch (err) {
      handleApiError(err, 'Ошибка при сохранении', 'updateAdminUser');
    } finally {
      setEditSubmitting(false);
    }
  };

  const handleBlock = async (u: StudioUser) => {
    if (isSelf(u)) {
      showToast('Нельзя заблокировать себя', 'warning');
      return;
    }
    const action = u.is_active ? 'заблокировать' : 'разблокировать';
    if (!confirm(`Вы уверены, что хотите ${action} ${u.name}?`)) return;
    try {
      await api.blockUser(u.id, !u.is_active);
      loadUsers();
      if (activeTab === 'activity') loadLogs(true);
    } catch (err) {
      handleApiError(err, 'Ошибка при изменении статуса', 'blockUser');
    }
  };

  const handleDelete = async (u: StudioUser) => {
    if (isSelf(u)) {
      showToast('Нельзя удалить себя', 'warning');
      return;
    }
    if (!confirm(`Вы уверены, что хотите удалить ${u.name}? Это действие нельзя отменить.`)) return;
    try {
      await api.deleteUser(u.id);
      showToast(`Сотрудник ${u.name} удалён`, 'success');
      loadUsers();
      loadLimits();
      if (activeTab === 'activity') loadLogs(true);
    } catch (err) {
      handleApiError(err, 'Ошибка при удалении', 'deleteUser');
    }
  };

  const handleResetPassword = async (u: StudioUser) => {
    if (isSelf(u)) {
      showToast('Сбросьте свой пароль через профиль', 'warning');
      return;
    }
    if (!confirm(
      `Сбросить пароль ${u.name}? Будет сгенерирован новый временный пароль, ` +
      `вы увидите его один раз. Активные сессии сотрудника завершатся.`
    )) return;
    try {
      const { tempPassword } = await api.resetUserPassword(u.id);
      setResetTarget(u);
      setResetTempPwd(tempPassword);
      setCopiedResetPwd(false);
      // edit-модалка может быть открыта; закрываем её, чтобы не перекрывать
      setEditTarget(null);
      if (activeTab === 'activity') loadLogs(true);
    } catch (err) {
      handleApiError(err, 'Ошибка при сбросе пароля', 'resetUserPassword');
    }
  };

  const closeResetModal = () => {
    setResetTarget(null);
    setResetTempPwd('');
    setCopiedResetPwd(false);
  };

  // Открыть модалку «Изменить пароль» для текущего пользователя (owner).
  const handleOpenOwnPwd = () => {
    setOwnPwdForm({ oldPassword: '', newPassword: '', confirmPassword: '' });
    setOwnPwdShow(false);
    setShowOwnPwdModal(true);
  };

  const handleSubmitOwnPwd = async (e: React.FormEvent) => {
    e.preventDefault();
    const { oldPassword, newPassword, confirmPassword } = ownPwdForm;
    if (!oldPassword || !newPassword) {
      showToast('Заполните все поля', 'warning');
      return;
    }
    if (newPassword.length < 8) {
      showToast('Новый пароль должен быть не менее 8 символов', 'warning');
      return;
    }
    if (newPassword !== confirmPassword) {
      showToast('Пароли не совпадают', 'warning');
      return;
    }
    if (oldPassword === newPassword) {
      showToast('Новый пароль совпадает с текущим', 'warning');
      return;
    }
    try {
      setOwnPwdSubmitting(true);
      await api.changePassword(oldPassword, newPassword);
      showToast('Пароль изменён. Остальные сессии завершены.', 'success');
      setShowOwnPwdModal(false);
    } catch (err) {
      handleApiError(err, 'Не удалось изменить пароль', 'changePassword');
    } finally {
      setOwnPwdSubmitting(false);
    }
  };

  // ── Рендер шапки ──
  // Вкладка «Аналитика» доступна всем планам. Раньше она была заперта
  // под тариф «Студия», но та же логика, что и с напоминаниями бота:
  // на лендинге выделяем фичу как «у Студии», но фактически показываем
  // её всем — это маркетинг для апсейла, а не реальный гейтинг.
  const tabs: { id: AdminTab; label: string; icon: typeof Users }[] = [
    { id: 'users', label: 'Сотрудники', icon: Users },
    { id: 'activity', label: 'Активность', icon: Activity },
    { id: 'analytics', label: 'Аналитика', icon: BarChart3 },
  ];

  // Inline-toggle «Видит финансы» прямо на карточке (только для manager).
  // Optimistic update + откат при ошибке.
  const handleQuickFinanceToggle = async (u: StudioUser) => {
    if (u.role !== 'manager' || financeBusyId) return;
    const next = !(u.can_view_finance !== false);
    setFinanceBusyId(u.id);
    setUsers((prev) => prev.map((x) => x.id === u.id ? { ...x, can_view_finance: next } : x));
    try {
      await api.updateAdminUser(u.id, { can_view_finance: next });
      if (activeTab === 'activity') loadLogs(true);
    } catch (err) {
      // откат при ошибке
      setUsers((prev) => prev.map((x) => x.id === u.id ? { ...x, can_view_finance: !next } : x));
      handleApiError(err, 'Не удалось изменить доступ к финансам', 'toggleFinanceAccess');
    } finally {
      setFinanceBusyId(null);
    }
  };

  return (
    // position: fixed inset: 0 — приколачиваем шелл к viewport, чтобы
    // не зависеть от height-цепочки html→body→#root. На iPhone Safari
    // h-full тут раньше «не находил» однозначной высоты родителя при
    // открытом адресном баре, и внутренний overflow-y-auto не скроллился.
    // top смещён ниже статусбара iOS PWA, иначе шапка с «← Назад» и
    // «Админ-панель» прячется под индикаторами (часы/LTE).
    <>
      <div
        aria-hidden
        style={{
          position: 'fixed', top: 0, left: 0, right: 0,
          height: 'env(safe-area-inset-top, 0px)',
          background: '#ffffff',
          zIndex: 31,  // выше sticky-шапки (z-30) чтобы перекрыть и её
        }}
      />
    <div
      className="flex flex-col bg-zinc-50 overflow-hidden"
      style={{ position: 'fixed', top: 'env(safe-area-inset-top, 0px)', left: 0, right: 0, bottom: 0 }}
    >
      <div className="sticky top-0 z-30 bg-white shadow-sm shrink-0">
        <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-200">
          <div className="flex items-center gap-3">
            <button onClick={onBack} className="w-8 h-8 rounded-full bg-zinc-100 flex items-center justify-center active:scale-95 transition-all">
              <ArrowLeft size={18} className="text-zinc-600" />
            </button>
            <h1 className="text-xl font-black">Админ-панель</h1>
          </div>
          {activeTab === 'users' && (
            <button
              onClick={handleAddClick}
              disabled={!!limits && !limits.canAddUsers}
              title={limits && !limits.canAddUsers ? `Лимит тарифа «${planLabel}»: ${limits.maxUsers}` : 'Добавить сотрудника'}
              className={`w-10 h-10 rounded-full flex items-center justify-center transition-all ${
                limits && !limits.canAddUsers
                  ? 'bg-zinc-300 cursor-not-allowed'
                  : 'bg-orange-500 active:bg-orange-600 active:scale-95'
              }`}
            >
              <UserPlus size={18} className="text-white" />
            </button>
          )}
        </div>

        <div className="flex border-b border-zinc-200">
          {tabs.map((t) => (
            <button
              key={t.id}
              onClick={() => setActiveTab(t.id)}
              className={`flex-1 flex items-center justify-center gap-2 py-3 text-sm font-bold transition-all border-b-2 ${
                activeTab === t.id ? 'border-orange-500 text-orange-600' : 'border-transparent text-zinc-400'
              }`}
            >
              <t.icon size={16} />
              {t.label}
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto px-4 pt-4 pb-40 overscroll-contain">
        {/* ─────────── Сотрудники ─────────── */}
        {activeTab === 'users' && (
          <div className="space-y-3">
            {/* Блок «N из M» по тарифу удалён по запросу: тариф «Студия» —
                максимальный, повышаться некуда, прогресс-бар только засоряет
                интерфейс. Лимит всё ещё проверяется на бэкенде и в handleAddClick. */}

            {usersLoading ? (
              <div className="text-center py-12 text-zinc-400 font-medium">Загрузка…</div>
            ) : users.length === 0 ? (
              <div className="text-center py-12 text-zinc-400 font-medium">Сотрудники не найдены</div>
            ) : (
              users.map((u) => {
                const isOwner = u.role === 'owner';
                const self = isSelf(u);
                // Display name: предпочитаем first_name + last_name (актуальные
                // профильные поля, которые сотрудник редактирует у себя в /profile),
                // фолбек на legacy `name`, потом email.
                const composed = [u.first_name, u.last_name].filter(Boolean).join(' ').trim();
                const displayName = composed || u.name || u.email;
                const initial = (composed || u.name || u.email || '?').charAt(0).toUpperCase();
                return (
                  <div key={u.id} className="bg-white border border-zinc-200 rounded-2xl p-4 space-y-3">
                    <div className="flex items-center gap-3">
                      {u.avatar_path ? (
                        <img
                          src={u.avatar_path}
                          alt={displayName}
                          className="w-11 h-11 rounded-full object-cover shrink-0 bg-zinc-100"
                          onError={(e) => {
                            // Если файл удалён/недоступен — фолбек на буквенный круг.
                            (e.currentTarget as HTMLImageElement).style.display = 'none';
                          }}
                        />
                      ) : (
                        <div className={`w-11 h-11 rounded-full flex items-center justify-center text-white text-base font-black shrink-0 ${
                          isOwner ? 'bg-gradient-to-br from-amber-400 to-amber-500' : 'bg-gradient-to-br from-zinc-400 to-zinc-500'
                        }`}>
                          {initial}
                        </div>
                      )}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          {/* Статус активности — крошечная точка вместо широкого бейджа,
                              чтобы не разбавлять единый акцент. Полный текст — в title. */}
                          <span
                            className={`w-2 h-2 rounded-full shrink-0 ${u.is_active ? 'bg-emerald-500' : 'bg-zinc-300'}`}
                            title={u.is_active ? 'Активен' : 'Заблокирован'}
                          />
                          <h3 className="font-bold text-base text-zinc-900 truncate">{displayName}</h3>
                          {self && (
                            <span className="text-xs font-bold px-2 py-0.5 rounded-full bg-zinc-100 text-zinc-500">
                              это вы
                            </span>
                          )}
                        </div>
                        <p className="text-xs text-zinc-400 font-medium truncate">{u.email}</p>
                      </div>
                    </div>

                    <div className="grid grid-cols-2 gap-3 text-xs">
                      <div>
                        <span className="text-zinc-400 font-medium">Роль</span>
                        <div className="flex items-center gap-1 mt-0.5">
                          {isOwner && <Shield size={12} className="text-zinc-500" />}
                          <p className="font-bold text-zinc-800">{getRoleName(u.role)}</p>
                        </div>
                      </div>
                      <div>
                        <span className="text-zinc-400 font-medium">Последний вход</span>
                        <div className="flex items-center gap-1 mt-0.5">
                          <Clock size={12} className="text-zinc-400" />
                          <p className="font-bold text-zinc-800">
                            {u.last_login_at ? formatDateTime(u.last_login_at) : 'Никогда'}
                          </p>
                        </div>
                      </div>
                      {!isOwner && (
                      <div className="col-span-2">
                        <span className="text-zinc-400 font-medium">Видит разделы</span>
                        <p className="font-bold text-zinc-800 mt-0.5 leading-snug">
                          {getVisibleSectionLabels(u.role, u.can_view_finance).join(', ')}
                        </p>
                      </div>
                      )}
                      <div className="col-span-2">
                        <span className="text-zinc-400 font-medium">Дата регистрации</span>
                        <p className="font-bold text-zinc-800 mt-0.5">
                          {formatDateRu(u.created_at)}
                        </p>
                      </div>
                    </div>

                    {/* Финансовый доступ. Для manager — inline-toggle (быстрое
                        включение/выключение прямо из списка). Для master —
                        просто текст «скрыты» (хардкод). Для owner — текст
                        «полный доступ». Дублирующая опция в edit-модалке для
                        manager сохраняется. */}
                    {/* Финансовый доступ — нейтральная зинк-плашка, маленькая
                        зелёная/серая точка-индикатор слева. Тогл переключает доступ. */}
                    {u.role === 'manager' && !self ? (
                      <button
                        type="button"
                        onClick={() => handleQuickFinanceToggle(u)}
                        disabled={financeBusyId === u.id}
                        className="w-full flex items-center justify-between gap-3 px-3 py-2.5 rounded-xl border bg-zinc-50 border-zinc-200 text-zinc-700 transition-all active:scale-[0.99] disabled:opacity-60"
                      >
                        <span className="flex items-center gap-2 text-xs font-bold">
                          <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${u.can_view_finance !== false ? 'bg-emerald-500' : 'bg-zinc-300'}`} />
                          {u.can_view_finance !== false
                            ? <><Eye size={14} className="text-zinc-500" /> Видит «Финансы»</>
                            : <><EyeOff size={14} className="text-zinc-500" /> «Финансы» скрыты</>}
                        </span>
                        <span className={`relative inline-flex items-center w-10 h-6 rounded-full transition-colors ${
                          u.can_view_finance !== false ? 'bg-zinc-800' : 'bg-zinc-300'
                        }`}>
                          <span className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow-sm transition-transform ${
                            u.can_view_finance !== false ? 'translate-x-4' : 'translate-x-0'
                          }`} />
                        </span>
                      </button>
                    ) : u.role === 'master' ? (
                      <div className="flex items-center justify-between gap-3 px-3 py-2 rounded-xl bg-zinc-50 border border-zinc-200">
                        <span className="text-xs font-bold text-zinc-600 flex items-center gap-2">
                          <EyeOff size={14} className="text-zinc-500" /> «Финансы» скрыты
                        </span>
                        <span className="text-xs font-medium text-zinc-400">мастер не видит финансы</span>
                      </div>
                    ) : null}

                    {self && isOwner && (
                      <div className="flex flex-wrap gap-2 pt-2 border-t border-zinc-100">
                        <button
                          onClick={handleOpenOwnPwd}
                          className="flex-1 min-w-[120px] flex items-center justify-center gap-1.5 py-2.5 rounded-xl text-xs font-bold bg-zinc-100 text-zinc-700 active:bg-zinc-200 transition-all active:scale-[0.97]"
                        >
                          <Lock size={14} className="text-orange-500" /> Изменить пароль
                        </button>
                      </div>
                    )}

                    {!self && (
                      <div className="flex flex-wrap gap-2 pt-2 border-t border-zinc-100">
                        {!isOwner && (
                          <button
                            onClick={() => handleEditOpen(u)}
                            className="flex-1 min-w-[120px] flex items-center justify-center gap-1.5 py-2.5 rounded-xl text-xs font-bold bg-zinc-100 text-zinc-700 active:bg-zinc-200 transition-all active:scale-[0.97]"
                          >
                            <Edit3 size={14} /> Редактировать
                          </button>
                        )}
                        <button
                          onClick={() => handleResetPassword(u)}
                          className="flex-1 min-w-[120px] flex items-center justify-center gap-1.5 py-2.5 rounded-xl text-xs font-bold bg-zinc-100 text-zinc-700 active:bg-zinc-200 transition-all active:scale-[0.97]"
                        >
                          <KeyRound size={14} /> Сброс пароля
                        </button>
                        {!isOwner && (
                          <>
                            <button
                              onClick={() => handleBlock(u)}
                              className="flex-1 min-w-[120px] flex items-center justify-center gap-1.5 py-2.5 rounded-xl text-xs font-bold bg-zinc-100 text-zinc-700 active:bg-zinc-200 transition-all active:scale-[0.97]"
                            >
                              {u.is_active
                                ? <><ShieldOff size={14} className="text-zinc-500" /> Заблокировать</>
                                : <><Shield size={14} className="text-emerald-500" /> Разблокировать</>}
                            </button>
                            <button
                              onClick={() => handleDelete(u)}
                              className="flex items-center justify-center gap-1.5 px-4 py-2.5 rounded-xl text-xs font-bold bg-red-50 text-red-600 active:bg-red-100 transition-all active:scale-[0.97]"
                              title="Удалить"
                            >
                              <Trash2 size={14} />
                            </button>
                          </>
                        )}
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>
        )}

        {/* ─────────── Активность ─────────── */}
        {activeTab === 'activity' && (
          <div className="space-y-3">
            {/* Фильтры */}
            <div className="bg-white border border-zinc-200 rounded-2xl p-3 space-y-2">
              <div className="grid grid-cols-2 gap-2">
                <div className="relative">
                  <select
                    value={filterUser}
                    onChange={(e) => setFilterUser(e.target.value)}
                    className="w-full appearance-none bg-zinc-50 border border-zinc-200 rounded-xl py-2 px-3 pr-8 text-xs font-bold outline-none focus:border-orange-500"
                  >
                    <option value="">Все сотрудники</option>
                    {users.map((u) => (
                      <option key={u.id} value={u.id}>{u.name}</option>
                    ))}
                  </select>
                  <ChevronDown size={14} className="absolute right-2 top-1/2 -translate-y-1/2 text-zinc-400 pointer-events-none" />
                </div>
                <div className="relative">
                  <select
                    value={filterAction}
                    onChange={(e) => setFilterAction(e.target.value)}
                    className="w-full appearance-none bg-zinc-50 border border-zinc-200 rounded-xl py-2 px-3 pr-8 text-xs font-bold outline-none focus:border-orange-500"
                  >
                    <option value="">Все действия</option>
                    {actionOptions.map((a) => (
                      <option key={a} value={a}>{getActionLabel(a)}</option>
                    ))}
                  </select>
                  <ChevronDown size={14} className="absolute right-2 top-1/2 -translate-y-1/2 text-zinc-400 pointer-events-none" />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <input
                  type="date"
                  value={filterFrom}
                  onChange={(e) => setFilterFrom(e.target.value)}
                  className="w-full bg-zinc-50 border border-zinc-200 rounded-xl py-2 px-3 text-xs font-bold outline-none focus:border-orange-500"
                  placeholder="С"
                />
                <input
                  type="date"
                  value={filterTo}
                  onChange={(e) => setFilterTo(e.target.value)}
                  className="w-full bg-zinc-50 border border-zinc-200 rounded-xl py-2 px-3 text-xs font-bold outline-none focus:border-orange-500"
                  placeholder="По"
                />
              </div>
              {(filterUser || filterAction || filterFrom || filterTo) && (
                <button
                  onClick={() => { setFilterUser(''); setFilterAction(''); setFilterFrom(''); setFilterTo(''); }}
                  className="w-full text-xs font-bold text-zinc-500 bg-zinc-100 px-3 py-2 rounded-lg active:scale-95 transition-all"
                >
                  Сбросить фильтры
                </button>
              )}
            </div>

            <div className="flex items-center justify-between px-1">
              <p className="text-xs text-zinc-400 font-medium">{logs.length} записей</p>
              <button
                onClick={() => loadLogs(true)}
                disabled={logsLoading}
                className="text-xs font-bold text-zinc-500 bg-zinc-100 px-3 py-1.5 rounded-lg active:scale-95 transition-all disabled:opacity-50"
              >
                <RefreshCw size={12} className="inline-block mr-1 -mt-px" />
                Обновить
              </button>
            </div>

            {logsLoading && logs.length === 0 ? (
              <div className="text-center py-12 text-zinc-400 font-medium">Загрузка…</div>
            ) : logs.length === 0 ? (
              <div className="text-center py-12 text-zinc-400 font-medium">Записей нет</div>
            ) : (
              <>
                {/*
                  Компактный однострочный лог: точка-индикатор + бейдж + имя
                  сотрудника + сущность (truncate) слева, время справа.
                  Детали (log.details) — отдельной мелкой строкой только если
                  есть. Высота карточки ≈ 36–48px вместо ~92px ранее.
                */}
                <div className="space-y-1">
                  {logs.map((log) => {
                    const tone = getActionTone(log.action);
                    const label = getActionLabel(log.action, log.entity_type);
                    return (
                      <div key={log.id} className="bg-white border border-zinc-200 rounded-lg px-2.5 py-1.5">
                        <div className="flex items-center gap-2 min-w-0">
                          <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${TONE_DOT[tone]}`} />
                          <span className={`text-xs font-bold px-1.5 py-0.5 rounded border whitespace-nowrap shrink-0 ${TONE_BADGE[tone]}`}>
                            {label}
                          </span>
                          <span className="text-xs font-bold text-zinc-800 truncate shrink-0 max-w-[40%]">
                            {log.user_name || 'Система'}
                          </span>
                          {log.entity_name && (
                            <span className="text-xs text-zinc-500 truncate min-w-0">
                              · {formatEntityName(log.entity_name)}
                            </span>
                          )}
                          <span className="text-xs text-zinc-400 font-medium whitespace-nowrap ml-auto shrink-0">
                            {formatDateTime(log.created_at)}
                          </span>
                        </div>
                        {log.details && (
                          <p className="text-xs text-zinc-500 leading-snug whitespace-pre-line mt-0.5 ml-3.5 truncate">
                            {formatLogDetails(log.details)}
                          </p>
                        )}
                      </div>
                    );
                  })}
                </div>
                {logsHasMore && (
                  <button
                    onClick={() => loadLogs(false)}
                    disabled={logsLoading}
                    className="w-full mt-3 py-3 rounded-xl text-sm font-bold bg-white border border-zinc-200 text-zinc-700 active:bg-zinc-50 transition-all disabled:opacity-50"
                  >
                    {logsLoading ? 'Загрузка…' : 'Загрузить ещё 50'}
                  </button>
                )}
              </>
            )}
          </div>
        )}

        {/* ─────────── Аналитика (только тариф «Студия») ─────────── */}
        {activeTab === 'analytics' && (
          <AnalyticsDashboard plan={planCode} />
        )}

      </div>

      {/* ─────────── Модалка: добавить сотрудника ─────────── */}
      <Modal isOpen={showAddModal} onClose={() => !addSubmitting && setShowAddModal(false)} title="Добавить сотрудника" position="center">
        <form onSubmit={handleAddSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-bold text-zinc-700 mb-1.5">Имя *</label>
            <input
              type="text"
              value={addForm.name}
              onChange={(e) => setAddForm({ ...addForm, name: e.target.value })}
              className="w-full px-4 py-3 border border-zinc-200 rounded-xl font-bold outline-none focus:border-orange-500 transition-all"
              required
            />
          </div>
          <div>
            <label className="block text-sm font-bold text-zinc-700 mb-1.5">Email *</label>
            <input
              type="email"
              value={addForm.email}
              onChange={(e) => setAddForm({ ...addForm, email: e.target.value })}
              className="w-full px-4 py-3 border border-zinc-200 rounded-xl font-bold outline-none focus:border-orange-500 transition-all"
              required
            />
          </div>
          <div>
            <label className="block text-sm font-bold text-zinc-700 mb-1.5">Временный пароль *</label>
            <div className="flex gap-2">
              <input
                type="text"
                value={addForm.password}
                onChange={(e) => setAddForm({ ...addForm, password: e.target.value })}
                className="flex-1 px-4 py-3 border border-zinc-200 rounded-xl font-mono text-sm font-bold outline-none focus:border-orange-500 transition-all"
                required
                minLength={8}
              />
              <button
                type="button"
                onClick={() => { setAddForm({ ...addForm, password: generateTempPassword() }); setCopiedAddPwd(false); }}
                className="px-3 rounded-xl bg-zinc-100 active:bg-zinc-200 transition-all"
                title="Сгенерировать новый"
              >
                <RefreshCw size={16} className="text-zinc-600" />
              </button>
              <button
                type="button"
                onClick={async () => {
                  const ok = await copyToClipboard(addForm.password);
                  setCopiedAddPwd(ok);
                  if (ok) setTimeout(() => setCopiedAddPwd(false), 2000);
                }}
                className="px-3 rounded-xl bg-zinc-100 active:bg-zinc-200 transition-all"
                title="Скопировать"
              >
                {copiedAddPwd ? <Check size={16} className="text-green-600" /> : <Copy size={16} className="text-zinc-600" />}
              </button>
            </div>
            <p className="text-[11px] text-zinc-400 mt-1.5 font-medium">
              Передайте пароль сотруднику. После создания он сможет сменить его в профиле.
            </p>
          </div>
          <div>
            <label className="block text-sm font-bold text-zinc-700 mb-1.5">Роль</label>
            <select
              value={addForm.role}
              onChange={(e) => setAddForm({ ...addForm, role: e.target.value as Role })}
              className="w-full px-4 py-3 border border-zinc-200 rounded-xl font-bold outline-none focus:border-orange-500 transition-all bg-white"
            >
              <option value="manager">Менеджер</option>
              <option value="master">Мастер</option>
            </select>
          </div>
          {addForm.role === 'manager' ? (
            <label className="flex items-center justify-between gap-3 px-4 py-3 bg-zinc-50 border border-zinc-200 rounded-xl cursor-pointer">
              <div>
                <p className="text-sm font-bold text-zinc-800">Видит финансы</p>
                <p className="text-[11px] text-zinc-500 font-medium">Доступ к разделу «Финансы»</p>
              </div>
              <input
                type="checkbox"
                checked={addForm.can_view_finance}
                onChange={(e) => setAddForm({ ...addForm, can_view_finance: e.target.checked })}
                className="w-5 h-5 accent-orange-500"
              />
            </label>
          ) : (
            <p className="text-[11px] text-zinc-500 font-medium px-1">
              Мастер не видит раздел «Финансы».
            </p>
          )}
          <div className="flex gap-3 pt-2">
            <button
              type="button"
              onClick={() => setShowAddModal(false)}
              disabled={addSubmitting}
              className="flex-1 px-4 py-3 border border-zinc-200 text-zinc-700 rounded-xl font-bold active:scale-[0.97] transition-all disabled:opacity-50"
            >
              Отмена
            </button>
            <button
              type="submit"
              disabled={addSubmitting}
              className="flex-1 px-4 py-3 bg-orange-500 text-white rounded-xl font-bold active:bg-orange-600 active:scale-[0.97] transition-all disabled:opacity-50"
            >
              {addSubmitting ? 'Создание…' : 'Создать'}
            </button>
          </div>
        </form>
      </Modal>

      {/* ─────────── Модалка: редактировать сотрудника ─────────── */}
      <Modal
        isOpen={!!editTarget}
        onClose={() => !editSubmitting && setEditTarget(null)}
        title="Редактировать сотрудника"
        position="center"
      >
        {editTarget && (
          <form onSubmit={handleEditSubmit} className="space-y-4">
            <div>
              <label className="block text-sm font-bold text-zinc-700 mb-1.5">Имя *</label>
              <input
                type="text"
                value={editForm.name}
                onChange={(e) => setEditForm({ ...editForm, name: e.target.value })}
                className="w-full px-4 py-3 border border-zinc-200 rounded-xl font-bold outline-none focus:border-orange-500 transition-all"
                required
              />
            </div>
            <div>
              <label className="block text-sm font-bold text-zinc-700 mb-1.5">Email</label>
              <input
                type="email"
                value={editTarget.email}
                disabled
                className="w-full px-4 py-3 border border-zinc-200 rounded-xl font-bold bg-zinc-50 text-zinc-500 outline-none"
              />
              <p className="text-[11px] text-zinc-400 mt-1 font-medium">
                Email меняется только сотрудником в его профиле.
              </p>
            </div>
            <div>
              <label className="block text-sm font-bold text-zinc-700 mb-1.5">Роль</label>
              {editTarget.role === 'owner' ? (
                <input
                  type="text"
                  value={getRoleName('owner')}
                  disabled
                  className="w-full px-4 py-3 border border-zinc-200 rounded-xl font-bold bg-zinc-50 text-zinc-500 outline-none"
                />
              ) : (
                <select
                  value={editForm.role}
                  onChange={(e) => setEditForm({ ...editForm, role: e.target.value as Role })}
                  className="w-full px-4 py-3 border border-zinc-200 rounded-xl font-bold outline-none focus:border-orange-500 transition-all bg-white"
                >
                  <option value="manager">Менеджер</option>
                  <option value="master">Мастер</option>
                </select>
              )}
            </div>
            {editTarget.role !== 'owner' && (
              editForm.role === 'manager' ? (
                <label className="flex items-center justify-between gap-3 px-4 py-3 bg-zinc-50 border border-zinc-200 rounded-xl cursor-pointer">
                  <div>
                    <p className="text-sm font-bold text-zinc-800">Видит финансы</p>
                    <p className="text-[11px] text-zinc-500 font-medium">Доступ к разделу «Финансы»</p>
                  </div>
                  <input
                    type="checkbox"
                    checked={editForm.can_view_finance}
                    onChange={(e) => setEditForm({ ...editForm, can_view_finance: e.target.checked })}
                    className="w-5 h-5 accent-orange-500"
                  />
                </label>
              ) : (
                <p className="text-[11px] text-zinc-500 font-medium px-1">
                  Мастер не видит раздел «Финансы».
                </p>
              )
            )}
            <button
              type="button"
              onClick={() => handleResetPassword(editTarget)}
              className="w-full py-3 rounded-xl text-sm font-bold bg-zinc-100 text-zinc-700 active:bg-zinc-200 transition-all flex items-center justify-center gap-2"
            >
              <KeyRound size={16} /> Сбросить пароль
            </button>
            <div className="flex gap-3 pt-2">
              <button
                type="button"
                onClick={() => setEditTarget(null)}
                disabled={editSubmitting}
                className="flex-1 px-4 py-3 border border-zinc-200 text-zinc-700 rounded-xl font-bold active:scale-[0.97] transition-all disabled:opacity-50"
              >
                Отмена
              </button>
              <button
                type="submit"
                disabled={editSubmitting}
                className="flex-1 px-4 py-3 bg-orange-500 text-white rounded-xl font-bold active:bg-orange-600 active:scale-[0.97] transition-all disabled:opacity-50"
              >
                {editSubmitting ? 'Сохранение…' : 'Сохранить'}
              </button>
            </div>
          </form>
        )}
      </Modal>

      {/* ─────────── Модалка: показ временного пароля после reset ─────────── */}
      <Modal
        isOpen={!!resetTarget}
        onClose={closeResetModal}
        title="Временный пароль"
        position="center"
      >
        {resetTarget && (
          <div className="space-y-4">
            <p className="text-sm text-zinc-600 font-medium">
              Пароль <span className="font-black text-zinc-900">{resetTarget.name}</span> сброшен.
              Скопируйте временный пароль и передайте сотруднику — после закрытия окна
              его уже нельзя будет посмотреть.
            </p>
            <div className="bg-zinc-50 border border-zinc-200 rounded-xl p-3">
              <p className="text-[11px] font-bold text-zinc-500 uppercase tracking-wide mb-2">Временный пароль</p>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={resetTempPwd}
                  readOnly
                  className="flex-1 px-3 py-2 bg-white border border-zinc-200 rounded-lg font-mono text-sm font-bold outline-none"
                />
                <button
                  type="button"
                  onClick={async () => {
                    const ok = await copyToClipboard(resetTempPwd);
                    setCopiedResetPwd(ok);
                    if (ok) {
                      showToast('Пароль скопирован', 'success');
                      setTimeout(() => setCopiedResetPwd(false), 2000);
                    }
                  }}
                  className="px-3 rounded-lg bg-zinc-100 text-zinc-700 active:bg-zinc-200 transition-all"
                >
                  {copiedResetPwd ? <Check size={16} className="text-emerald-500" /> : <Copy size={16} />}
                </button>
              </div>
            </div>
            <p className="text-[11px] text-zinc-500 font-medium">
              Активные сессии сотрудника завершены. После входа с временным паролем
              рекомендуется сразу сменить его в профиле.
            </p>
            <button
              type="button"
              onClick={closeResetModal}
              className="w-full py-3 rounded-xl text-sm font-bold bg-orange-500 text-white active:bg-orange-600 active:scale-[0.97] transition-all flex items-center justify-center gap-2"
            >
              <X size={16} /> Закрыть
            </button>
          </div>
        )}
      </Modal>

      {/* ─────────── Модалка: изменить свой пароль (для owner) ─────────── */}
      <Modal
        isOpen={showOwnPwdModal}
        onClose={() => {
          if (ownPwdSubmitting) return;
          setShowOwnPwdModal(false);
          // При закрытии — чистим состояние «Забыл пароль?»,
          // чтобы при повторном открытии модалка была свежая.
          setOwnPwdResetState('idle');
          setOwnPwdResetError('');
        }}
        title="Изменить пароль"
        position="center"
      >
        <form onSubmit={handleSubmitOwnPwd} className="space-y-4">
          <p className="text-xs text-zinc-500 font-medium leading-snug">
            После смены пароля все активные сессии (на других устройствах)
            будут завершены — этот сеанс остаётся активным.
          </p>
          <div>
            <div className="flex items-baseline justify-between mb-1.5">
              <label className="block text-sm font-bold text-zinc-700">Текущий пароль</label>
              {/* «Забыли пароль?» — запускает TG-сброс на email текущего юзера.
                  Прячем во время отправки/после ответа, чтобы не нажали дважды. */}
              {ownPwdResetState === 'idle' && (
                <button
                  type="button"
                  onClick={requestOwnPwdReset}
                  disabled={ownPwdSubmitting}
                  className="text-xs font-bold text-orange-500 hover:text-orange-600 active:scale-[0.97] transition-all disabled:opacity-50"
                >
                  Забыли пароль?
                </button>
              )}
              {ownPwdResetState === 'submitting' && (
                <span className="text-xs font-bold text-zinc-400">Отправляем…</span>
              )}
            </div>
            <input
              type={ownPwdShow ? 'text' : 'password'}
              value={ownPwdForm.oldPassword}
              onChange={(e) => setOwnPwdForm({ ...ownPwdForm, oldPassword: e.target.value })}
              className="w-full px-4 py-3 border border-zinc-200 rounded-xl font-bold outline-none focus:border-orange-500 transition-all"
              autoComplete="current-password"
              required
            />
            {/* Inline-фидбек по состоянию TG-сброса — внутри модалки, чтобы
                не открывать ещё одну поверх и не ломать фокус. */}
            {ownPwdResetState === 'sent' && (
              <div className="mt-2 px-3 py-2 rounded-lg bg-emerald-50 border border-emerald-200 text-[12px] text-emerald-700 font-medium leading-snug">
                Если у этого аккаунта подключён Telegram-бот, мы прислали туда
                ссылку для сброса пароля. Она действует 30 минут.
              </div>
            )}
            {ownPwdResetState === 'no_channel' && (
              <div className="mt-2 px-3 py-2 rounded-lg bg-amber-50 border border-amber-200 text-[12px] text-amber-800 font-medium leading-snug">
                Telegram-бот не подключён к вашему аккаунту — ссылку отправить
                некуда. Подключите бота через профиль или напишите в поддержку,
                чтобы сбросить пароль вручную.
              </div>
            )}
            {ownPwdResetState === 'error' && ownPwdResetError && (
              <div className="mt-2 px-3 py-2 rounded-lg bg-red-50 border border-red-200 text-[12px] text-red-700 font-medium leading-snug">
                {ownPwdResetError}
              </div>
            )}
          </div>
          <div>
            <label className="block text-sm font-bold text-zinc-700 mb-1.5">Новый пароль</label>
            <input
              type={ownPwdShow ? 'text' : 'password'}
              value={ownPwdForm.newPassword}
              onChange={(e) => setOwnPwdForm({ ...ownPwdForm, newPassword: e.target.value })}
              className="w-full px-4 py-3 border border-zinc-200 rounded-xl font-bold outline-none focus:border-orange-500 transition-all"
              autoComplete="new-password"
              minLength={8}
              required
            />
            <p className="text-[11px] text-zinc-400 mt-1 font-medium">Не менее 8 символов</p>
          </div>
          <div>
            <label className="block text-sm font-bold text-zinc-700 mb-1.5">Повторите новый пароль</label>
            <input
              type={ownPwdShow ? 'text' : 'password'}
              value={ownPwdForm.confirmPassword}
              onChange={(e) => setOwnPwdForm({ ...ownPwdForm, confirmPassword: e.target.value })}
              className="w-full px-4 py-3 border border-zinc-200 rounded-xl font-bold outline-none focus:border-orange-500 transition-all"
              autoComplete="new-password"
              required
            />
          </div>
          <label className="flex items-center gap-2 px-1 text-xs font-medium text-zinc-600 cursor-pointer">
            <input
              type="checkbox"
              checked={ownPwdShow}
              onChange={(e) => setOwnPwdShow(e.target.checked)}
              className="w-4 h-4 accent-orange-500"
            />
            Показать пароли
          </label>
          <div className="flex gap-3 pt-2">
            <button
              type="button"
              onClick={() => {
                setShowOwnPwdModal(false);
                setOwnPwdResetState('idle');
                setOwnPwdResetError('');
              }}
              disabled={ownPwdSubmitting}
              className="flex-1 px-4 py-3 border border-zinc-200 text-zinc-700 rounded-xl font-bold active:scale-[0.97] transition-all disabled:opacity-50"
            >
              Отмена
            </button>
            <button
              type="submit"
              disabled={ownPwdSubmitting}
              className="flex-1 px-4 py-3 bg-orange-500 text-white rounded-xl font-bold active:bg-orange-600 active:scale-[0.97] transition-all disabled:opacity-50"
            >
              {ownPwdSubmitting ? 'Сохранение…' : 'Сохранить'}
            </button>
          </div>
        </form>
      </Modal>
    </div>
    </>
  );
};
