/**
 * ProfilePage — единый кабинет пользователя.
 *
 * Источник данных — GET /api/profile (см. server/routes/profile.cjs):
 *   { user, studio, limits } — JOIN saas_meta.users + saas_meta.studios + count.
 *
 * Секции (сверху вниз):
 *   1. Шапка: аватар (клик — загрузить фото из галереи), ФИО крупно, role-chip
 *   2. Личные данные: имя, фамилия, телефон, email (read-only)
 *   3. Студия: название, дата регистрации
 *   4. Тариф: текущий план + слот-каунтер + 4 карточки (Соло мес/год, Студия мес/год)
 *   5. Подписка: countdown до access_until, кнопка «Отменить подписку» (auto)
 *   6. Реферальная программа — заглушка «Скоро»
 *
 * Сохранение полей:
 *   onBlur поля → api.updateProfile({...}) → toast «Сохранено» + обновление кэша.
 *   Email через этот эндпоинт не меняется (отдельный flow с подтверждением — позже).
 *
 * Аватар:
 *   <input type="file" accept="image/*"> спрятан, клик по аватару (или
 *   камера-бейджу) открывает диалог. После api.uploadAvatar(file) — отдаём URL
 *   `/avatars/<uid>.webp`, nginx их кеширует 1 день, поэтому добавляем
 *   ?v=<timestamp> для cache-bust. Удаление — мелкая ссылка «Удалить» под именем,
 *   видна только если фото уже загружено.
 *
 * Тариф (4 карточки):
 *   Линки на оплату — Prodamus payform.ru. Ценники должны соответствовать тому,
 *   что настроено на стороне Prodamus, иначе пользователь увидит на чекауте
 *   другую сумму. Если меняется на стороне Prodamus — правим TARIFF_PLANS.
 *
 * Отмена подписки:
 *   Кнопка → POST /api/profile/subscription/cancel → выставляет cancel_pending=true
 *   в saas_meta.studios. UI показывает «Подписка отменена, доступ до DD.MM.YYYY»
 *   и кнопку «Восстановить подписку». Фактическое отключение списания на стороне
 *   Prodamus — пока вручную через их кабинет (полная автоматизация — Phase 5).
 */

import { useEffect, useRef, useState } from 'react';
import { api, ApiError } from '@/utils/api';
import { getRoleName } from '@/utils/constants';
import { patchCachedUser } from '@/utils/auth';
import type { ProfileResponse, Role } from '@/utils/types';

// Кому пишет пользователь, чтобы изменить email или связаться по биллингу.
const SUPPORT_EMAIL = 'nedwedskaya@yandex.ru';

interface ProfilePageProps {
  onBack: () => void;
}

// ──────────────────────────────────────────────────────────────────────
// Тарифы для карточек выбора. Цены — что настроено на Prodamus payform.
// Если меняешь там — синхронизируй здесь.
// ──────────────────────────────────────────────────────────────────────
type TariffId = 'solo_month' | 'solo_year' | 'studio_month' | 'studio_year';

interface TariffCard {
  id: TariffId;
  group: 'solo' | 'studio';
  period: 'month' | 'year';
  title: string;
  badge?: string;            // подпись типа «−17%» или «ВЫГОДНЕЕ»
  priceRub: number;          // что снимут на чекауте
  perMonthRub?: number;      // эквивалент в месяц для годовых
  saveRub?: number;          // экономия за год (для годовых)
  features: string[];
  payformUrl: string;
  highlight?: boolean;       // выделить рамкой как «лучшее предложение»
}

const TARIFF_PLANS: TariffCard[] = [
  {
    id: 'solo_month',
    group: 'solo',
    period: 'month',
    title: 'Соло · месяц',
    priceRub: 4900,
    features: [
      '1 пользователь (только собственник)',
      'Клиенты, задачи, календарь, финансы',
      'Аналитика и отчёты',
    ],
    payformUrl: 'https://payform.ru/dablmR1/',
  },
  {
    id: 'solo_year',
    group: 'solo',
    period: 'year',
    title: 'Соло · год',
    badge: '−17%',
    priceRub: 49000,
    perMonthRub: 4083,
    saveRub: 9800,
    features: [
      '1 пользователь (только собственник)',
      'Всё из «Соло · месяц»',
      'Экономия 9 800 ₽ за год',
    ],
    payformUrl: 'https://payform.ru/goblmSQ/',
    highlight: true,
  },
  {
    id: 'studio_month',
    group: 'studio',
    period: 'month',
    title: 'Студия · месяц',
    priceRub: 8900,
    features: [
      'До 3 пользователей (собственник + 2)',
      'Роли «Менеджер» и «Мастер»',
      'Всё из «Соло»',
    ],
    payformUrl: 'https://payform.ru/jqblmUt/',
  },
  {
    id: 'studio_year',
    group: 'studio',
    period: 'year',
    title: 'Студия · год',
    badge: '−17%',
    priceRub: 89000,
    perMonthRub: 7417,
    saveRub: 17800,
    features: [
      'До 3 пользователей (собственник + 2)',
      'Всё из «Студия · месяц»',
      'Экономия 17 800 ₽ за год',
    ],
    payformUrl: 'https://payform.ru/moblmW2/',
    highlight: true,
  },
];

// Какая карточка считается «текущей» для подсветки «ваш план».
// На trial/cancelled — ничего не подсвечиваем (нет активной).
function currentTariffId(plan: string): TariffId | null {
  // У нас в БД хранится только базовый план (solo/studio), без period.
  // Период пока знаем только косвенно — через access_until vs created_at,
  // но для простоты UX подсвечиваем оба варианта группы (solo_month + solo_year).
  // Здесь возвращаем null, а highlight «ваш план» делаем по `group`.
  if (plan === 'solo' || plan === 'studio') return null;
  return null;
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

const CheckIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M20 6L9 17l-5-5" />
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
// formatRub — «4 900 ₽» с неразрывным пробелом перед знаком рубля
// (по правилу типографики: пробел в тысячах, неразрывный перед ₽)
// ──────────────────────────────────────────────────────────────────────
function formatRub(amount: number): string {
  return `${amount.toLocaleString('ru-RU')}\u00A0₽`;
}

// ──────────────────────────────────────────────────────────────────────
// formatDateRu — устойчивый парсер дат:
//   • ISO с «T»:           «2026-04-26T11:28:31.968Z»
//   • Postgres timestamp:  «2026-04-26 11:28:31.968692+00»
//   • date-only:           «2026-04-26»
// → «26 апреля 2026»
// (стандартный helpers.formatDate ломается на postgres-формате с пробелом)
// ──────────────────────────────────────────────────────────────────────
function formatDateRu(value: string | null | undefined): string {
  if (!value) return '—';
  let d: Date;
  if (typeof value === 'string') {
    if (value.includes('T')) {
      d = new Date(value);
    } else if (/^\d{4}-\d{2}-\d{2}\s\d{2}:\d{2}/.test(value)) {
      d = new Date(value.replace(' ', 'T'));
    } else if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      const [y, m, day] = value.split('-').map(Number);
      d = new Date(y, m - 1, day, 12, 0, 0);
    } else {
      d = new Date(value);
    }
  } else {
    return '—';
  }
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('ru-RU', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}

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
// Countdown до access_until: «осталось 12 дней» / «истекает сегодня» / «истёк»
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
  // Тот же устойчивый парсинг, что и в formatDateRu
  let target: Date;
  if (typeof accessUntil === 'string' && /^\d{4}-\d{2}-\d{2}\s\d{2}:\d{2}/.test(accessUntil)) {
    target = new Date(accessUntil.replace(' ', 'T'));
  } else {
    target = new Date(accessUntil);
  }
  if (isNaN(target.getTime())) return { text: 'дата некорректна', tone: 'warn' };
  const now = new Date();
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
// Карточка тарифа (используется внутри сетки 2×2)
// ──────────────────────────────────────────────────────────────────────
interface TariffCardViewProps {
  card: TariffCard;
  isCurrent: boolean;
}

const TariffCardView = ({ card, isCurrent }: TariffCardViewProps) => {
  // Подсветка: highlight=год → зелёная рамка-«рекомендуем», isCurrent → чёрная.
  const borderClass = isCurrent
    ? 'border-zinc-900 shadow-md'
    : card.highlight
    ? 'border-emerald-300 shadow-sm'
    : 'border-zinc-200';

  return (
    <div className={`relative bg-white rounded-xl border ${borderClass} p-5 flex flex-col`}>
      {card.badge && !isCurrent && (
        <span className="absolute -top-2 right-4 px-2 py-0.5 rounded-full bg-emerald-500 text-white text-[11px] font-semibold tracking-wide">
          {card.badge}
        </span>
      )}
      {isCurrent && (
        <span className="absolute -top-2 right-4 px-2 py-0.5 rounded-full bg-zinc-900 text-white text-[11px] font-semibold tracking-wide">
          ваш план
        </span>
      )}

      <div className="text-sm font-semibold text-zinc-900">{card.title}</div>

      <div className="mt-2 flex items-baseline gap-2">
        <span className="text-2xl font-bold text-zinc-900">{formatRub(card.priceRub)}</span>
        <span className="text-xs text-zinc-500">
          {card.period === 'year' ? 'за год' : 'в месяц'}
        </span>
      </div>

      {card.period === 'year' && card.perMonthRub && (
        <div className="mt-1 text-xs text-zinc-500">
          ≈ {formatRub(card.perMonthRub)}/мес · списание раз в год
        </div>
      )}

      <ul className="mt-4 space-y-1.5 flex-1">
        {card.features.map((f, idx) => (
          <li key={idx} className="flex items-start gap-2 text-xs text-zinc-600">
            <span className="mt-0.5 text-emerald-500 shrink-0"><CheckIcon /></span>
            <span>{f}</span>
          </li>
        ))}
      </ul>

      <a
        href={card.payformUrl}
        target="_blank"
        rel="noopener noreferrer"
        className={
          'mt-4 inline-flex items-center justify-center w-full px-4 py-2 rounded-lg text-sm font-medium transition-colors ' +
          (card.highlight
            ? 'bg-emerald-500 text-white hover:bg-emerald-600'
            : 'bg-zinc-900 text-white hover:bg-zinc-800')
        }
      >
        Оформить
      </a>
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
  const [subscriptionBusy, setSubscriptionBusy] = useState(false);
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

  const handleCancelSubscription = async () => {
    if (subscriptionBusy || !data) return;
    const confirmText =
      'Отменить подписку?\n\n' +
      'Доступ к CRM сохранится до ' + formatDateRu(data.studio.accessUntil) + '. ' +
      'После этой даты автопродления не будет.\n\n' +
      'Чек об оплате уже пришёл от Prodamus при покупке — отдельно отменять там ничего не нужно.';
    if (!window.confirm(confirmText)) return;
    setSubscriptionBusy(true);
    try {
      await api.cancelSubscription();
      setData((prev) => prev ? { ...prev, studio: { ...prev.studio, cancelPending: true } } : prev);
    } catch (err: any) {
      const msg = err instanceof ApiError ? err.message : (err?.message || 'Не удалось отменить подписку');
      alert(`Ошибка: ${msg}`);
    } finally {
      setSubscriptionBusy(false);
    }
  };

  const handleResumeSubscription = async () => {
    if (subscriptionBusy) return;
    setSubscriptionBusy(true);
    try {
      await api.resumeSubscription();
      setData((prev) => prev ? { ...prev, studio: { ...prev.studio, cancelPending: false } } : prev);
    } catch (err: any) {
      const msg = err instanceof ApiError ? err.message : (err?.message || 'Не удалось восстановить подписку');
      alert(`Ошибка: ${msg}`);
    } finally {
      setSubscriptionBusy(false);
    }
  };

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

  const avatarSrc = user.avatarPath ? `${user.avatarPath}?v=${avatarVersion}` : null;

  const slotsPct = limits.maxUsers > 0
    ? Math.min(100, Math.round((limits.currentUsers / limits.maxUsers) * 100))
    : 0;

  const access = describeAccessUntil(studio.accessUntil);

  // Подсветка «ваш план» в карточках. Для активного solo/studio подсвечиваем
  // оба варианта группы (period мы пока не различаем в БД).
  const currentTariff = currentTariffId(studio.plan); // null — нет точной карточки
  const currentGroup: 'solo' | 'studio' | null =
    studio.plan === 'solo' ? 'solo'
    : studio.plan === 'studio' ? 'studio'
    : null;

  // Можно ли отменить подписку: только owner на платном тарифе
  const canCancel = role === 'owner' && (studio.plan === 'solo' || studio.plan === 'studio');

  return (
    <div className="min-h-screen bg-zinc-50">
      <div className="max-w-3xl mx-auto p-4 sm:p-6">
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
                title={avatarSrc ? 'Заменить фото' : 'Загрузить фото'}
              >
                {avatarSrc ? (
                  <img src={avatarSrc} alt="Аватар" className="w-full h-full object-cover" />
                ) : (
                  <div className="text-zinc-400"><UserSilhouette /></div>
                )}
              </button>
              {/* Камера-бейдж — кликабельный, открывает тот же диалог */}
              <button
                type="button"
                onClick={handleAvatarPick}
                disabled={avatarBusy}
                className="absolute bottom-0 right-0 bg-zinc-900 text-white rounded-full p-2 shadow-md hover:bg-zinc-800 transition-colors disabled:opacity-50"
                title={avatarSrc ? 'Заменить фото' : 'Загрузить фото'}
              >
                <CameraIcon />
              </button>
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

            {/* Удалить — только если фото уже есть. Не дублируем «Загрузить фото». */}
            {user.avatarPath && (
              <button
                type="button"
                onClick={handleAvatarDelete}
                disabled={avatarBusy}
                className="mt-3 text-xs text-zinc-400 hover:text-red-500 disabled:opacity-50 transition-colors"
              >
                Удалить фото
              </button>
            )}
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
              <span className="text-zinc-900">{formatDateRu(studio.createdAt)}</span>
            </div>
          </div>
        </div>

        {/* ── 4. Тариф: текущий план + слоты + сетка предложений ── */}
        <div className="bg-white rounded-2xl shadow-sm border border-zinc-100 mb-4">
          <div className="px-6 pt-5 pb-3 flex items-center justify-between">
            <span className="text-sm font-medium text-zinc-700">Тариф</span>
            <span className="text-xs text-zinc-400">
              сейчас: {studio.planLabel}
            </span>
          </div>

          {/* Слот-каунтер «Сотрудников: N из M» */}
          <div className="px-6 pb-4">
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

          {/* Сетка 2×2 (на мобиле — стек) */}
          <div className="px-6 pb-5">
            <p className="text-xs text-zinc-500 mb-3">
              Выберите подходящий тариф. Оплата — через Prodamus, чек придёт автоматически на email.
              Годовые тарифы — выгоднее на&nbsp;17%.
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {TARIFF_PLANS.map((card) => (
                <TariffCardView
                  key={card.id}
                  card={card}
                  isCurrent={
                    currentTariff === card.id
                    || (currentGroup !== null && currentGroup === card.group)
                  }
                />
              ))}
            </div>
          </div>
        </div>

        {/* ── 5. Подписка ────────────────────────────────────────── */}
        <div className="bg-white rounded-2xl shadow-sm border border-zinc-100 mb-4">
          <div className="px-6 pt-5 pb-2 text-sm font-medium text-zinc-700">Подписка</div>
          <div className="px-6 pb-5">
            <div className="flex items-baseline justify-between">
              <span className="text-xs text-zinc-400">Доступ до</span>
              <span className="text-zinc-900">{formatDateRu(studio.accessUntil)}</span>
            </div>
            <p className={
              'mt-2 text-sm ' +
              (access.tone === 'expired' ? 'text-red-500'
                : access.tone === 'warn' ? 'text-amber-600'
                : 'text-zinc-500')
            }>
              {access.text}
            </p>

            {/* Состояние «отмена принята» — баннер вместо кнопки «Отменить» */}
            {studio.cancelPending && (
              <div className="mt-4 p-3 rounded-lg bg-amber-50 border border-amber-200">
                <p className="text-sm text-amber-800 font-medium">
                  Подписка отменена
                </p>
                <p className="mt-1 text-xs text-amber-700">
                  Автопродления не будет. Вы пользуетесь CRM до {formatDateRu(studio.accessUntil)},
                  затем доступ закроется.
                </p>
                <button
                  type="button"
                  onClick={handleResumeSubscription}
                  disabled={subscriptionBusy}
                  className="mt-3 inline-flex items-center justify-center px-3 py-1.5 rounded-md bg-white border border-amber-300 text-amber-800 text-xs font-medium hover:bg-amber-100 transition-colors disabled:opacity-50"
                >
                  {subscriptionBusy ? 'Восстанавливаем…' : 'Восстановить подписку'}
                </button>
              </div>
            )}

            {/* Обычное состояние — кнопка «Отменить» (только для owner на платном тарифе) */}
            {!studio.cancelPending && canCancel && (
              <>
                <button
                  type="button"
                  onClick={handleCancelSubscription}
                  disabled={subscriptionBusy}
                  className="mt-4 inline-flex items-center justify-center w-full px-4 py-2.5 rounded-lg border border-zinc-200 text-zinc-600 text-sm hover:bg-zinc-50 transition-colors disabled:opacity-50"
                >
                  {subscriptionBusy ? 'Отменяем…' : 'Отменить подписку'}
                </button>
                <p className="mt-2 text-xs text-zinc-400">
                  Доступ сохранится до конца оплаченного периода. Деньги назад не возвращаются.
                </p>
              </>
            )}

            {/* Не-owner либо trial — отдельные подсказки вместо кнопки */}
            {!studio.cancelPending && !canCancel && role !== 'owner' && (
              <p className="mt-3 text-xs text-zinc-400">
                Управление подпиской доступно только собственнику студии.
              </p>
            )}
            {!studio.cancelPending && !canCancel && role === 'owner' && studio.plan === 'trial' && (
              <p className="mt-3 text-xs text-zinc-400">
                Сейчас активен пробный период. Когда оформите тариф — здесь появится кнопка «Отменить подписку».
              </p>
            )}
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
