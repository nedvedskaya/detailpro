/**
 * ProfilePage — единый кабинет пользователя.
 *
 * Источник данных — GET /api/profile (см. server/routes/profile.cjs):
 *   { user, studio, limits } — JOIN saas_meta.users + saas_meta.studios + count.
 *
 * Секции (сверху вниз):
 *   1. Шапка: аватар (клик — загрузить), ФИО крупно, role-chip
 *   2. Личные данные: имя, фамилия, телефон, email (read-only)
 *   3. Студия: название, дата регистрации
 *   4. Тариф: текущий план + цена + прогресс «N из M», CTA «Повысить тариф»
 *   5. Подписка: countdown до access_until, кнопка «Отменить подписку» (mailto)
 *   6. Реферальная программа — заглушка «Скоро»
 *
 * Сохранение полей:
 *   onBlur поля → api.updateProfile({...}) → toast «Сохранено» + обновление кэша.
 *   Email через этот эндпоинт не меняется (отдельный flow с подтверждением — позже).
 *
 * Аватар:
 *   <input type="file" accept="image/*"> спрятан, клик по большому аватару
 *   открывает диалог. После api.uploadAvatar(file) — отдаём URL `/avatars/<uid>.webp`,
 *   nginx их кеширует 1 день, поэтому добавляем ?v=<timestamp> для cache-bust.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError } from '@/utils/api';
import { formatDate } from '@/utils/helpers';
import { getRoleName } from '@/utils/constants';
import { patchCachedUser } from '@/utils/auth';
import type { ProfileResponse, Role } from '@/utils/types';

// CTA «Повысить тариф» ведёт на ссылку из env.
// Пока в прод-конфиге — плейсхолдер; webhook-флоу подцепим в Phase 5.
const UPGRADE_URL = import.meta.env.VITE_PRODAMUS_UPGRADE_URL || '';

// Кому пишет пользователь, чтобы отменить подписку (на старте — mailto).
const SUPPORT_EMAIL = 'nedwedskaya@yandex.ru';

interface ProfilePageProps {
  onBack: () => void;
}

// ──────────────────────────────────────────────────────────────────────
// Иконки (без зависимостей — inline SVG, как в остальном UI)
// ──────────────────────────────────────────────────────────────────────
const ArrowLeftIcon = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M19 12H5M12 19l-7-7 7-7" />
  </svg>
);

const UserSilhouette = () => (
  <svg width="56" height="56" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
    <circle cx="12" cy="7" r="4" />
  </svg>
);

const CameraIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
    <circle cx="12" cy="13" r="4" />
  </svg>
);

const TrashIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6h14z" />
  </svg>
);

// ──────────────────────────────────────────────────────────────────────
// Цвет role-chip — owner чёрный (главный), manager синий, master серый
// ──────────────────────────────────────────────────────────────────────
const ROLE_CHIP_STYLES: Record<Role, string> = {
  owner: 'bg-zinc-900 text-white',
  manager: 'bg-blue-100 text-blue-800',
  master: 'bg-zinc-100 text-zinc-700',
};

// ──────────────────────────────────────────────────────────────────────
// Маска телефона +7 (XXX) XXX-XX-XX (не блокирующая, только подсказка ввода)
// ──────────────────────────────────────────────────────────────────────
function formatPhone(raw: string): string {
  const digits = raw.replace(/\D/g, '').replace(/^8/, '7'); // 8XXX → 7XXX
  if (!digits) return '';
  const d = digits.startsWith('7') ? digits.slice(0, 11) : ('7' + digits).slice(0, 11);
  const a = d.slice(1, 4);
  const b = d.slice(4, 7);
  const c = d.slice(7, 9);
  const e = d.slice(9, 11);
  let out = '+7';
  if (a) out += ` (${a}`;
  if (a.length === 3) out += ')';
  if (b) out += ` ${b}`;
  if (c) out += `-${c}`;
  if (e) out += `-${e}`;
  return out;
}

// ──────────────────────────────────────────────────────────────────────
// Countdown до access_until: «осталось 12 дней» / «истекает сегодня» / «истёк N дней назад»
// ──────────────────────────────────────────────────────────────────────
function pluralizeDays(n: number): string {
  const abs = Math.abs(n) % 100;
  const last = abs % 10;
  if (abs > 10 && abs < 20) return 'дней';
  if (last === 1) return 'день';
  if (last >= 2 && last <= 4) return 'дня';
  return 'дней';
}

function describeAccessUntil(accessUntil: string | null | undefined): { text: string; tone: 'ok' | 'warn' | 'expired' } {
  if (!accessUntil) return { text: 'дата не указана', tone: 'warn' };
  const target = new Date(accessUntil);
  if (isNaN(target.getTime())) return { text: 'дата некорректна', tone: 'warn' };
  const now = new Date();
  // считаем по календарным дням, а не по миллисекундам
  const ms = target.getTime() - now.getTime();
  const days = Math.ceil(ms / (24 * 60 * 60 * 1000));
  if (days < 0) {
    const n = Math.abs(days);
    return { text: `истёк ${n} ${pluralizeDays(n)} назад`, tone: 'expired' };
  }
  if (days === 0) return { text: 'истекает сегодня', tone: 'warn' };
  if (days <= 3) return { text: `осталось ${days} ${pluralizeDays(days)}`, tone: 'warn' };
  return { text: `осталось ${days} ${pluralizeDays(days)}`, tone: 'ok' };
}

// ──────────────────────────────────────────────────────────────────────
// Типизированное поле формы (имя/фамилия/телефон) с inline-сохранением
// ──────────────────────────────────────────────────────────────────────
type EditableKey = 'firstName' | 'lastName' | 'phone';

interface EditableFieldProps {
  label: string;
  fieldKey: EditableKey;
  value: string;
  placeholder?: string;
  format?: (raw: string) => string;
  onSave: (key: EditableKey, value: string) => Promise<void>;
}

const EditableField = ({ label, fieldKey, value, placeholder, format, onSave }: EditableFieldProps) => {
  const [draft, setDraft] = useState(value);
  const [savingState, setSavingState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [errorMsg, setErrorMsg] = useState('');

  // Если value (из props) поменялось снаружи — синкаем draft
  useEffect(() => { setDraft(value); }, [value]);

  const handleChange = (raw: string) => {
    const v = format ? format(raw) : raw;
    setDraft(v);
    if (savingState !== 'idle') setSavingState('idle');
  };

  const handleBlur = async () => {
    const trimmed = draft.trim();
    if (trimmed === (value || '').trim()) return; // ничего не поменялось
    setSavingState('saving');
    setErrorMsg('');
    try {
      await onSave(fieldKey, trimmed);
      setSavingState('saved');
      // через 2 секунды убираем галочку
      setTimeout(() => setSavingState('idle'), 2000);
    } catch (e: any) {
      setSavingState('error');
      setErrorMsg(e?.message || 'Не удалось сохранить');
    }
  };

  return (
    <div className="px-6 py-4">
      <label className="text-xs text-zinc-400 block mb-1">{label}</label>
      <div className="flex items-center gap-2">
        <input
          type="text"
          value={draft}
          placeholder={placeholder}
          onChange={(e) => handleChange(e.target.value)}
          onBlur={handleBlur}
          className="flex-1 bg-transparent text-zinc-900 outline-none border-b border-transparent focus:border-zinc-300 transition-colors"
        />
        {savingState === 'saving' && (
          <span className="text-xs text-zinc-400">сохраняем…</span>
        )}
        {savingState === 'saved' && (
          <span className="text-xs text-emerald-600">сохранено</span>
        )}
      </div>
      {savingState === 'error' && (
        <p className="mt-1 text-xs text-red-500">{errorMsg}</p>
      )}
    </div>
  );
};

// ──────────────────────────────────────────────────────────────────────
// Главный компонент
// ──────────────────────────────────────────────────────────────────────
export const ProfilePage = ({ onBack }: ProfilePageProps) => {
  const [data, setData] = useState<ProfileResponse | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');
  const [avatarBusy, setAvatarBusy] = useState(false);
  const [avatarVersion, setAvatarVersion] = useState<number>(() => Date.now());
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void loadProfile();
  }, []);

  const loadProfile = async () => {
    try {
      setIsLoading(true);
      setError('');
      const res = await api.getProfile();
      setData(res);
    } catch (err: any) {
      const msg = err instanceof ApiError ? err.message : (err?.message || 'Ошибка при загрузке профиля');
      setError(msg);
    } finally {
      setIsLoading(false);
    }
  };

  const handleSaveField = async (key: EditableKey, value: string) => {
    const patch: Record<string, string | null> = { [key]: value === '' ? null : value };
    const res = await api.updateProfile(patch);
    setData((prev) => prev ? { ...prev, user: res.user } : prev);
    // обновим in-memory кэш auth.ts → UserMenu сразу подхватит изменения
    patchCachedUser({
      firstName: res.user.firstName ?? null,
      lastName: res.user.lastName ?? null,
      phone: res.user.phone ?? null,
      name: res.user.name,
    });
  };

  const handleAvatarPick = () => {
    if (avatarBusy) return;
    fileInputRef.current?.click();
  };

  const handleAvatarChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // чтобы повторный выбор того же файла снова сработал
    if (!file) return;
    setAvatarBusy(true);
    try {
      const { avatarPath } = await api.uploadAvatar(file);
      setData((prev) => prev ? {
        ...prev,
        user: { ...prev.user, avatarPath },
      } : prev);
      setAvatarVersion(Date.now());
      patchCachedUser({ avatarPath });
    } catch (err: any) {
      const msg = err instanceof ApiError ? err.message : (err?.message || 'Не удалось загрузить аватар');
      alert(`Ошибка: ${msg}`);
    } finally {
      setAvatarBusy(false);
    }
  };

  const handleAvatarDelete = async () => {
    if (avatarBusy || !data?.user.avatarPath) return;
    if (!window.confirm('Удалить фото профиля?')) return;
    setAvatarBusy(true);
    try {
      await api.deleteAvatar();
      setData((prev) => prev ? { ...prev, user: { ...prev.user, avatarPath: null } } : prev);
      patchCachedUser({ avatarPath: null });
    } catch (err: any) {
      const msg = err instanceof ApiError ? err.message : (err?.message || 'Не удалось удалить аватар');
      alert(`Ошибка: ${msg}`);
    } finally {
      setAvatarBusy(false);
    }
  };

  const cancelMailto = useMemo(() => {
    if (!data) return `mailto:${SUPPORT_EMAIL}`;
    const subject = encodeURIComponent('Отмена подписки detailprocrm');
    const body = encodeURIComponent(
      `Здравствуйте! Прошу отменить подписку.\n\n` +
      `Студия: ${data.studio.displayName}\n` +
      `ID студии: ${data.studio.id}\n` +
      `Email: ${data.user.email}`
    );
    return `mailto:${SUPPORT_EMAIL}?subject=${subject}&body=${body}`;
  }, [data]);

  // ── Loading / error ─────────────────────────────────────────────────
  if (isLoading) {
    return (
      <div className="min-h-screen bg-zinc-50 flex items-center justify-center">
        <div className="animate-spin h-8 w-8 border-2 border-zinc-300 border-t-zinc-900 rounded-full" />
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="min-h-screen bg-zinc-50 flex items-center justify-center p-6">
        <div className="text-center">
          <p className="text-red-500 mb-4">{error || 'Не удалось загрузить профиль'}</p>
          <button onClick={loadProfile} className="text-zinc-900 underline">
            Попробовать снова
          </button>
        </div>
      </div>
    );
  }

  const { user, studio, limits } = data;
  const role = (user.role as Role) || 'master';
  const fullName = (`${user.firstName || ''} ${user.lastName || ''}`).trim() || user.name || 'Без имени';

  // Аватар: добавляем ?v=<ts> чтобы nginx-кеш (1 день) не показывал старое фото после загрузки
  const avatarSrc = user.avatarPath ? `${user.avatarPath}?v=${avatarVersion}` : null;

  // Прогресс по слотам тарифа: для UI показываем процент (никогда не >100)
  const slotsPct = limits.maxUsers > 0
    ? Math.min(100, Math.round((limits.currentUsers / limits.maxUsers) * 100))
    : 0;

  const access = describeAccessUntil(studio.accessUntil);

  return (
    <div className="min-h-screen bg-zinc-50">
      <div className="max-w-2xl mx-auto p-4 sm:p-6">
        {/* Верхняя кнопка «Назад» */}
        <button
          onClick={onBack}
          className="flex items-center gap-2 text-zinc-500 hover:text-zinc-900 transition-colors mb-6"
        >
          <ArrowLeftIcon />
          <span>Назад</span>
        </button>

        {/* ── 1. Шапка: аватар + ФИО + роль ───────────────────────── */}
        <div className="bg-white rounded-2xl shadow-sm border border-zinc-100 p-6 mb-4">
          <div className="flex flex-col items-center">
            <div className="relative">
              <button
                type="button"
                onClick={handleAvatarPick}
                disabled={avatarBusy}
                className="w-28 h-28 rounded-full bg-zinc-100 flex items-center justify-center overflow-hidden border-2 border-white shadow-sm hover:opacity-90 transition-opacity disabled:opacity-50"
                title="Загрузить фото"
              >
                {avatarSrc ? (
                  <img src={avatarSrc} alt="Аватар" className="w-full h-full object-cover" />
                ) : (
                  <div className="text-zinc-400"><UserSilhouette /></div>
                )}
              </button>
              <span className="absolute bottom-0 right-0 bg-zinc-900 text-white rounded-full p-2 shadow-md">
                <CameraIcon />
              </span>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={handleAvatarChange}
              />
            </div>

            <h1 className="mt-4 text-xl font-semibold text-zinc-900">{fullName}</h1>

            <span className={`mt-2 inline-flex items-center px-3 py-1 rounded-full text-xs font-medium ${ROLE_CHIP_STYLES[role]}`}>
              {getRoleName(role)}
            </span>

            <div className="mt-4 flex items-center gap-3 text-xs">
              <button
                type="button"
                onClick={handleAvatarPick}
                disabled={avatarBusy}
                className="text-zinc-500 hover:text-zinc-900 disabled:opacity-50"
              >
                {user.avatarPath ? 'Заменить фото' : 'Загрузить фото'}
              </button>
              {user.avatarPath && (
                <>
                  <span className="text-zinc-300">·</span>
                  <button
                    type="button"
                    onClick={handleAvatarDelete}
                    disabled={avatarBusy}
                    className="text-zinc-400 hover:text-red-500 inline-flex items-center gap-1 disabled:opacity-50"
                  >
                    <TrashIcon /> Удалить
                  </button>
                </>
              )}
            </div>
          </div>
        </div>

        {/* ── 2. Личные данные ──────────────────────────────────── */}
        <div className="bg-white rounded-2xl shadow-sm border border-zinc-100 mb-4">
          <div className="px-6 pt-5 pb-2 text-sm font-medium text-zinc-700">Личные данные</div>
          <div className="divide-y divide-zinc-100">
            <EditableField
              label="Имя"
              fieldKey="firstName"
              value={user.firstName || ''}
              placeholder="Например, Ольга"
              onSave={handleSaveField}
            />
            <EditableField
              label="Фамилия"
              fieldKey="lastName"
              value={user.lastName || ''}
              placeholder="Например, Недведская"
              onSave={handleSaveField}
            />
            <EditableField
              label="Телефон"
              fieldKey="phone"
              value={user.phone || ''}
              placeholder="+7 (___) ___-__-__"
              format={formatPhone}
              onSave={handleSaveField}
            />
            <div className="px-6 py-4">
              <span className="text-xs text-zinc-400 block mb-1">Email</span>
              <span className="text-zinc-900">{user.email}</span>
              <p className="text-xs text-zinc-400 mt-1">
                Чтобы изменить email, напишите на{' '}
                <a className="underline" href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>
              </p>
            </div>
          </div>
        </div>

        {/* ── 3. Студия ──────────────────────────────────────────── */}
        <div className="bg-white rounded-2xl shadow-sm border border-zinc-100 mb-4">
          <div className="px-6 pt-5 pb-2 text-sm font-medium text-zinc-700">Студия</div>
          <div className="divide-y divide-zinc-100">
            <div className="px-6 py-4">
              <span className="text-xs text-zinc-400 block mb-1">Название</span>
              <span className="text-zinc-900">{studio.displayName}</span>
            </div>
            <div className="px-6 py-4">
              <span className="text-xs text-zinc-400 block mb-1">Дата регистрации</span>
              <span className="text-zinc-900">{formatDate(studio.createdAt) || '—'}</span>
            </div>
          </div>
        </div>

        {/* ── 4. Тариф ───────────────────────────────────────────── */}
        <div className="bg-white rounded-2xl shadow-sm border border-zinc-100 mb-4">
          <div className="px-6 pt-5 pb-2 flex items-center justify-between">
            <span className="text-sm font-medium text-zinc-700">Тариф</span>
            <span className="text-xs text-zinc-400">{studio.planLabel}</span>
          </div>
          <div className="px-6 pb-5">
            <div className="flex items-baseline gap-2">
              <span className="text-2xl font-semibold text-zinc-900">«{studio.planLabel}»</span>
              {studio.planPriceRub > 0 ? (
                <span className="text-sm text-zinc-500">
                  {studio.planPriceRub.toLocaleString('ru-RU')} ₽/мес
                </span>
              ) : (
                <span className="text-sm text-zinc-500">бесплатно</span>
              )}
            </div>

            <div className="mt-4">
              <div className="flex items-center justify-between text-xs text-zinc-500 mb-1">
                <span>Сотрудников</span>
                <span>{limits.currentUsers} из {limits.maxUsers}</span>
              </div>
              <div className="h-2 bg-zinc-100 rounded-full overflow-hidden">
                <div
                  className="h-full bg-zinc-900 transition-[width] duration-500"
                  style={{ width: `${slotsPct}%` }}
                />
              </div>
              {!limits.canAddUsers && limits.maxUsers > 0 && (
                <p className="mt-2 text-xs text-amber-600">
                  Лимит достигнут. Чтобы добавить ещё сотрудника — повысьте тариф.
                </p>
              )}
            </div>

            {studio.planUpgradeable && (
              <a
                href={UPGRADE_URL || '#'}
                onClick={(e) => {
                  if (!UPGRADE_URL) {
                    e.preventDefault();
                    alert('Ссылка на повышение тарифа появится скоро. Пока напишите на ' + SUPPORT_EMAIL);
                  }
                }}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-4 inline-flex items-center justify-center w-full px-4 py-2.5 rounded-lg bg-zinc-900 text-white text-sm font-medium hover:bg-zinc-800 transition-colors"
              >
                Повысить тариф
              </a>
            )}
          </div>
        </div>

        {/* ── 5. Подписка ────────────────────────────────────────── */}
        <div className="bg-white rounded-2xl shadow-sm border border-zinc-100 mb-4">
          <div className="px-6 pt-5 pb-2 text-sm font-medium text-zinc-700">Подписка</div>
          <div className="px-6 pb-5">
            <div className="flex items-baseline justify-between">
              <span className="text-xs text-zinc-400">Доступ до</span>
              <span className="text-zinc-900">{formatDate(studio.accessUntil) || '—'}</span>
            </div>
            <p className={
              'mt-2 text-sm ' +
              (access.tone === 'expired' ? 'text-red-500'
                : access.tone === 'warn' ? 'text-amber-600'
                : 'text-zinc-500')
            }>
              {access.text}
            </p>

            <a
              href={cancelMailto}
              className="mt-4 inline-flex items-center justify-center w-full px-4 py-2.5 rounded-lg border border-zinc-200 text-zinc-600 text-sm hover:bg-zinc-50 transition-colors"
            >
              Отменить подписку
            </a>
            <p className="mt-2 text-xs text-zinc-400">
              Чтобы отменить — напишите на {SUPPORT_EMAIL}. Доступ сохраняется до конца оплаченного периода.
            </p>
          </div>
        </div>

        {/* ── 6. Реферальная программа — заглушка ────────────────── */}
        <div className="bg-white rounded-2xl shadow-sm border border-zinc-100 mb-4 opacity-70">
          <div className="px-6 py-5">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium text-zinc-700">Реферальная программа</span>
              <span className="text-xs text-zinc-400">Скоро</span>
            </div>
            <p className="mt-2 text-xs text-zinc-500">
              Будете получать вознаграждение за каждую студию, пришедшую по вашей ссылке.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
};
