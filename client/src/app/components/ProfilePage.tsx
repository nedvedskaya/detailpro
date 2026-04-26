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
 *   4. Тариф: текущий план + слот-каунтер + 2 карточки (Соло, Студия) с двумя
 *      кнопками оплаты в каждой (за 1 месяц / за 12 месяцев со скидкой). Студия
 *      выделяется как «Популярный». Триал-баннер сверху со счётчиком дней.
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
 * Тариф (2 карточки):
 *   Каждая карточка — Соло и Студия — содержит две кнопки оплаты: за 1 месяц и
 *   за 12 месяцев со скидкой (~15% Соло, ~16% Студия). Линки — Prodamus
 *   payform.ru. Ценники должны соответствовать тому, что настроено на стороне
 *   Prodamus, иначе пользователь увидит на чекауте другую сумму. Если меняется
 *   на стороне Prodamus — правим TARIFF_GROUPS.
 *
 *   Solo → Studio upgrade: специальной кнопки нет. Если пользователь на «Соло»
 *   оплачивает «Студия», бэк (server/routes/webhooks.cjs) делает GREATEST на
 *   access_until — оставшиеся дни не теряются, новый период добавляется сверху.
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
// Тарифы. Структура: 2 группы (Соло, Студия), у каждой — месячный и годовой
// варианты. На карточку рисуем по две кнопки оплаты (мес/год). Цены должны
// совпадать с тем, что настроено в Prodamus payform.ru.
// ──────────────────────────────────────────────────────────────────────
type TariffGroupId = 'solo' | 'studio';
type TariffId = 'solo_month' | 'solo_year' | 'studio_month' | 'studio_year';

interface TariffOption {
  id: TariffId;
  period: 'month' | 'year';
  priceRub: number;          // итоговая сумма на чекауте
  payformUrl: string;
  // Для годового — сколько экономия и сколько в пересчёте на месяц
  perMonthRub?: number;
  saveRub?: number;
  savePct?: number;          // подпись для бейджа: «−15%»
}

interface TariffGroup {
  id: TariffGroupId;
  title: string;
  tagline: string;
  features: string[];
  monthly: TariffOption;
  yearly: TariffOption;
  popular?: boolean;         // визуально выделяем как «самый популярный»
}

// Solo·год = 49 900 ₽: экономия 4900*12 − 49900 = 8900 (≈15%)
// Studio·год = 89 900 ₽: экономия 8900*12 − 89900 = 16900 (≈16%)
const TARIFF_GROUPS: TariffGroup[] = [
  {
    id: 'solo',
    title: 'Соло',
    tagline: 'Для одного мастера, который ведёт студию сам',
    features: [
      '1 пользователь (только собственник)',
      'Клиенты, задачи, календарь',
      'Финансовый учёт и аналитика',
      'Загрузка фото детейлинга',
    ],
    monthly: {
      id: 'solo_month',
      period: 'month',
      priceRub: 4900,
      payformUrl: 'https://payform.ru/dablmR1/',
    },
    yearly: {
      id: 'solo_year',
      period: 'year',
      priceRub: 49900,
      perMonthRub: 4158,
      saveRub: 8900,
      savePct: 15,
      payformUrl: 'https://payform.ru/goblmSQ/',
    },
  },
  {
    id: 'studio',
    title: 'Студия',
    tagline: 'Для команды: собственник + менеджер + мастер',
    features: [
      'До 3 пользователей (собственник + 2)',
      'Роли «Менеджер» и «Мастер»',
      'Всё из тарифа «Соло»',
      'Приоритетная поддержка',
    ],
    monthly: {
      id: 'studio_month',
      period: 'month',
      priceRub: 8900,
      payformUrl: 'https://payform.ru/jqblmUt/',
    },
    yearly: {
      id: 'studio_year',
      period: 'year',
      priceRub: 89900,
      perMonthRub: 7492,
      saveRub: 16900,
      savePct: 16,
      payformUrl: 'https://payform.ru/moblmW2/',
    },
    popular: true,
  },
];

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
  owner: 'bg-orange-500 text-white',
  manager: 'bg-orange-100 text-orange-800',
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
// Сборка URL для Prodamus с проброшенными параметрами.
//   _param_studio_id — Prodamus вернёт его в webhook как поле studio_id
//   _param_plan      — то же, как поле plan ('solo_month' | ...)
//   customer_email   — Prodamus подставит на чекауте, чтобы клиенту не вводить
// ──────────────────────────────────────────────────────────────────────
function buildPayformUrl(option: TariffOption, studioId: string, email: string): string {
  const u = new URL(option.payformUrl);
  u.searchParams.set('_param_studio_id', studioId);
  u.searchParams.set('_param_plan', option.id);
  if (email) u.searchParams.set('customer_email', email);
  return u.toString();
}

// ──────────────────────────────────────────────────────────────────────
// Карточка тарифа: 2 кнопки (мес / год). Студия выделена как «популярная».
// ──────────────────────────────────────────────────────────────────────
interface TariffCardViewProps {
  group: TariffGroup;
  isCurrent: boolean;
  studioId: string;
  email: string;
}

const TariffCardView = ({ group, isCurrent, studioId, email }: TariffCardViewProps) => {
  const monthlyUrl = buildPayformUrl(group.monthly, studioId, email);
  const yearlyUrl  = buildPayformUrl(group.yearly,  studioId, email);

  // Студия: оранжевая рамка + лёгкий tint, бейдж «ПОПУЛЯРНО».
  // Соло: нейтральная рамка.
  const wrapperClass = group.popular
    ? 'border-orange-400 shadow-lg ring-1 ring-orange-200 bg-gradient-to-br from-orange-50/60 to-white'
    : 'border-zinc-200 bg-white';

  return (
    <div className={`relative rounded-2xl border ${wrapperClass} p-6 flex flex-col`}>
      {group.popular && (
        <span className="absolute -top-3 left-1/2 -translate-x-1/2 px-3 py-0.5 rounded-full bg-orange-500 text-white text-[11px] font-bold tracking-wide uppercase shadow-sm">
          Популярный
        </span>
      )}
      {isCurrent && (
        <span className="absolute -top-3 right-4 px-3 py-0.5 rounded-full bg-zinc-900 text-white text-[11px] font-semibold tracking-wide">
          ваш план
        </span>
      )}

      <div className="text-lg font-bold text-zinc-900">{group.title}</div>
      <div className="mt-1 text-xs text-zinc-500">{group.tagline}</div>

      <ul className="mt-4 space-y-2">
        {group.features.map((f, idx) => (
          <li key={idx} className="flex items-start gap-2 text-sm text-zinc-700">
            <span className="mt-0.5 text-orange-500 shrink-0"><CheckIcon /></span>
            <span>{f}</span>
          </li>
        ))}
      </ul>

      <div className="mt-5 flex-1" />

      {/*
        Кнопки оплаты. Mobile-first: label сверху мелким, цена снизу крупной —
        одна и та же раскладка на всех брейкпойнтах, не зависит от ширины
        экрана. Бейдж скидки вынесен наружу (absolute -top-2 -right-2),
        чтобы не перегружать саму кнопку.
        Цветовая логика — единая для Соло и Студии:
          • месячная кнопка = «outline» (белая, оранжевая обводка/текст)
          • годовая кнопка  = «filled»  (оранжевый фон, белый текст)
        Различение Соло/Студия — на уровне обёртки карточки (ring + бейдж
        «Популярный»), а не цветом кнопок.
      */}

      {/* Кнопка «Оплатить на 1 месяц» */}
      <a
        href={monthlyUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="mt-2 flex flex-col items-center justify-center w-full px-4 py-3 rounded-xl bg-white border border-orange-300 text-orange-700 hover:bg-orange-50 active:bg-orange-100 transition-colors"
      >
        <span className="text-xs">Оплатить на 1 месяц</span>
        <span className="mt-0.5 text-lg font-bold">{formatRub(group.monthly.priceRub)}</span>
      </a>

      {/* Кнопка «Оплатить на 12 месяцев» с ribbon-бейджем скидки сбоку */}
      <a
        href={yearlyUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="mt-3 relative flex flex-col items-center justify-center w-full px-4 py-3 rounded-xl bg-orange-500 text-white hover:bg-orange-600 active:bg-orange-700 transition-colors shadow-sm"
      >
        {group.yearly.savePct && (
          <span
            aria-label={`Скидка ${group.yearly.savePct}%`}
            className="absolute -top-2 -right-2 px-2 py-0.5 rounded-full bg-emerald-500 text-white text-[10px] font-bold tracking-wide shadow-md ring-2 ring-white"
          >
            −{group.yearly.savePct}%
          </span>
        )}
        <span className="text-xs opacity-90">Оплатить на 12 месяцев</span>
        <span className="mt-0.5 text-lg font-bold">{formatRub(group.yearly.priceRub)}</span>
      </a>

      {group.yearly.perMonthRub && (
        <p className="mt-2 text-[11px] text-zinc-500 text-center">
          ≈ {formatRub(group.yearly.perMonthRub)}/мес · экономия {formatRub(group.yearly.saveRub || 0)} за год
        </p>
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

  // Подсветка «ваш план» в карточках. period (мес/год) в БД мы пока не храним —
  // различить можно по разнице (access_until − created_at), но ради простоты
  // сейчас подсвечиваем всю группу (Соло или Студия).
  const currentGroup: TariffGroupId | null =
    studio.plan === 'solo' ? 'solo'
    : studio.plan === 'studio' ? 'studio'
    : null;

  // Триал — сколько осталось дней (для шапки-баннера)
  const isTrial = studio.plan === 'trial';
  const trialDaysLeft = isTrial ? (() => {
    const target = (() => {
      if (!studio.accessUntil) return null;
      if (/^\d{4}-\d{2}-\d{2}\s\d{2}:\d{2}/.test(studio.accessUntil)) {
        return new Date(studio.accessUntil.replace(' ', 'T'));
      }
      return new Date(studio.accessUntil);
    })();
    if (!target || isNaN(target.getTime())) return 0;
    const ms = target.getTime() - Date.now();
    return Math.max(0, Math.ceil(ms / (24 * 60 * 60 * 1000)));
  })() : 0;

  // Можно ли отменить подписку: только owner на платном тарифе
  const canCancel = role === 'owner' && (studio.plan === 'solo' || studio.plan === 'studio');

  return (
    // h-full + overflow-y-auto — корневой #root в App.tsx имеет overflow:hidden,
    // поэтому min-h-screen режет нижнюю часть страницы. Делаем внутренний
    // скролл с overscroll-contain, чтобы скролл не «пробивал» наружу.
    <div className="h-full bg-zinc-50 overflow-y-auto overscroll-contain">
      <div className="max-w-3xl mx-auto p-4 sm:p-6 pb-20">
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
                className="absolute bottom-0 right-0 bg-zinc-900 text-white rounded-full p-2 shadow-md hover:bg-orange-600 transition-colors disabled:opacity-50"
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

        {/* ── 4. Тариф: текущий план + слоты + 2 карточки (Соло, Студия) ──
            Видна ТОЛЬКО собственнику. Менеджер/мастер — это сотрудники студии,
            биллинг к ним не относится. */}
        {role === 'owner' && (
        <div className="bg-white rounded-2xl shadow-sm border border-zinc-100 mb-4">
          <div className="px-6 pt-5 pb-3 flex items-center justify-between">
            <span className="text-sm font-medium text-zinc-700">Тариф</span>
            <span className="text-xs text-zinc-400">
              сейчас: {studio.planLabel}
            </span>
          </div>

          {/* Триал-баннер: сколько дней осталось. Если триал ещё активен — */}
          {/* оранжевый градиент с большой цифрой; если завершился — алый      */}
          {/* «истёк» без цифры, чтобы не выглядеть нелепо «0».                */}
          {isTrial && trialDaysLeft > 0 && (
            <div className="mx-4 sm:mx-6 mb-4 p-4 rounded-xl bg-gradient-to-r from-orange-500 to-orange-400 text-white">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-semibold">Пробный период</p>
                  <p className="mt-0.5 text-xs opacity-90">
                    Осталось {trialDaysLeft} {pluralizeDays(trialDaysLeft)} бесплатного доступа
                  </p>
                </div>
                <div className="shrink-0 text-3xl font-bold tabular-nums">
                  {trialDaysLeft}
                </div>
              </div>
              <p className="mt-2 text-[11px] opacity-90">
                Оформите тариф ниже, чтобы не потерять доступ к CRM.
              </p>
            </div>
          )}
          {isTrial && trialDaysLeft === 0 && (
            <div className="mx-4 sm:mx-6 mb-4 p-4 rounded-xl bg-red-50 border border-red-200">
              <p className="text-sm font-semibold text-red-700">Пробный период завершён</p>
              <p className="mt-1 text-xs text-red-600">
                Чтобы вернуть доступ к CRM, оформите тариф ниже.
              </p>
            </div>
          )}

          {/* Слот-каунтер «Сотрудников: N из M» */}
          <div className="px-6 pb-4">
            <div className="flex items-center justify-between text-xs text-zinc-500 mb-1">
              <span>Сотрудников</span>
              <span>{limits.currentUsers} из {limits.maxUsers}</span>
            </div>
            <div className="h-2 bg-zinc-100 rounded-full overflow-hidden">
              <div
                className="h-full bg-orange-500 transition-[width] duration-500"
                style={{ width: `${slotsPct}%` }}
              />
            </div>
            {!limits.canAddUsers && limits.maxUsers > 0 && (
              <p className="mt-2 text-xs text-amber-600">
                Лимит достигнут. Чтобы добавить ещё сотрудника — повысьте тариф до «Студия».
              </p>
            )}
          </div>

          {/* 2 карточки: Соло и Студия. Каждая — с двумя кнопками (мес/год). */}
          <div className="px-6 pb-2">
            <p className="text-xs text-zinc-500 mb-4">
              Выберите подходящий тариф. Оплата — через Prodamus, чек придёт на email автоматически.
            </p>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 md:gap-5">
              {TARIFF_GROUPS.map((group) => (
                <TariffCardView
                  key={group.id}
                  group={group}
                  isCurrent={currentGroup === group.id}
                  studioId={studio.id}
                  email={user.email}
                />
              ))}
            </div>
          </div>

          {/* Подсказка про апгрейд Соло → Студия */}
          {currentGroup === 'solo' && (
            <div className="mx-6 mt-4 mb-5 p-3 rounded-lg bg-orange-50 border border-orange-200">
              <p className="text-xs text-orange-900">
                <span className="font-semibold">Хотите перейти с «Соло» на «Студия»?</span>{' '}
                Просто оплатите тариф «Студия» — оставшиеся дни от «Соло» сохранятся,
                новый период добавится сверху. Платите только за продление, ничего не теряется.
              </p>
            </div>
          )}
          {!currentGroup && !isTrial && (
            <div className="mx-6 mt-4 mb-5 p-3 rounded-lg bg-zinc-50 border border-zinc-200">
              <p className="text-xs text-zinc-600">
                Подписка не активна. Оформите любой тариф, чтобы вернуть доступ к CRM.
              </p>
            </div>
          )}
          {!currentGroup && isTrial && <div className="pb-3" />}
          {currentGroup === 'studio' && <div className="pb-3" />}
        </div>
        )}

        {/* ── 5. Подписка ──────────────────────────────────────────
            Видна ТОЛЬКО собственнику. */}
        {role === 'owner' && (
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
        )}

        {/* ── 6. Реферальная программа — заглушка ──────────────────
            Видна ТОЛЬКО собственнику. */}
        {role === 'owner' && (
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
        )}
      </div>
    </div>
  );
};
