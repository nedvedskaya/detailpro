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

import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { api } from '@/utils/api';
import { translateApiError } from '@/utils/errorMessages';
import { getRoleName } from '@/utils/constants';
import { patchCachedUser } from '@/utils/auth';
import {
  canEditStudio,
  canEditOwnProfile,
  canManageSubscription,
  canManageReferrals,
  canManageServices,
  canEditEntities,
} from '@/utils/permissions';
import { handleApiError } from '@/utils/stateHelpers';
import { isValidEmail } from '@/utils/validation';
import { parseDbDate, formatDateRu } from '@/utils/helpers';
import { ServicesManager } from '@/app/components/ServicesManager';
import { ClientsImport } from '@/app/components/ClientsImport';
import type { ProfileResponse, Role } from '@/utils/types';

// Кому пишет пользователь, чтобы изменить email или связаться по биллингу.
const SUPPORT_EMAIL = 'nedwedskaya@yandex.ru';

// ИНН: 10 цифр (юрлицо) или 12 (ИП). ОГРН: 13 (юрлицо) или 15 (ИП).
// Возвращаем читаемый текст ошибки или null если всё ок.
function validateInn(v: string): string | null {
  if (!/^\d+$/.test(v)) return 'Только цифры';
  if (v.length !== 10 && v.length !== 12) return 'ИНН — 10 цифр (юрлицо) или 12 (ИП)';
  return null;
}
function validateOgrn(v: string): string | null {
  if (!/^\d+$/.test(v)) return 'Только цифры';
  if (v.length !== 13 && v.length !== 15) return 'ОГРН — 13 цифр (юрлицо) или 15 (ОГРНИП)';
  return null;
}
function validateEmail(v: string): string | null {
  return isValidEmail(v) ? null : 'Некорректный email';
}

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
      'Документы по приёмке авто',
      'Заказ-наряды',
      'Финансовый учёт и аналитика',
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
      'Бот в Telegram: напоминания о записях и задачах каждый день',
      'Полная аналитика по продажам и клиентам',
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
  const target = parseDbDate(accessUntil);
  if (!target) return { text: 'дата не указана', tone: 'warn' };
  const now = new Date();
  const ms = target.getTime() - now.getTime();
  // floor, а не ceil: «осталось N дней» = сколько ПОЛНЫХ дней до истечения.
  // Если регистрация была вчера в 19:17 и доступ до послезавтра в 19:17 —
  // прошло ~16 часов, осталось 2.3 суток; ceil даст «3» и счётчик не
  // меняется первые сутки (фидбек: «вчера было 3, сегодня 3 — должен идти
  // отсчёт»). floor корректно покажет 2 уже на следующий день.
  const days = Math.floor(ms / (24 * 60 * 60 * 1000));
  if (days < 0) {
    const n = Math.abs(days);
    return { text: `истёк ${n} ${pluralizeDays(n)} назад`, tone: 'expired' };
  }
  if (days === 0) return { text: 'истекает сегодня', tone: 'warn' };
  if (days <= 3) return { text: `осталось ${days} ${pluralizeDays(days)}`, tone: 'warn' };
  return { text: `осталось ${days} ${pluralizeDays(days)}`, tone: 'ok' };
}

// ──────────────────────────────────────────────────────────────────────
// Сворачиваемая секция: заголовок-кнопка + раскрывающееся содержимое.
// Применяется ко всем блокам Профиля кроме «Тариф» (там CTA должны быть
// видны сразу — иначе пользователь не увидит, что подписка заканчивается).
// ──────────────────────────────────────────────────────────────────────
interface CollapsibleSectionProps {
  title: string;
  subtitle?: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}

const CollapsibleSection = ({ title, subtitle, defaultOpen = false, children }: CollapsibleSectionProps) => {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="bg-white rounded-2xl shadow-sm border border-zinc-100 mb-4 overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full px-6 pt-5 pb-4 flex items-start justify-between gap-3 text-left hover:bg-zinc-50/60 transition-colors"
        aria-expanded={open}
      >
        <div className="flex-1 min-w-0">
          <span className="text-sm font-medium text-zinc-700 block">{title}</span>
          {subtitle && (
            <p className="text-xs text-zinc-400 mt-1">{subtitle}</p>
          )}
        </div>
        <ChevronDown
          size={18}
          className={`text-zinc-400 shrink-0 mt-0.5 transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>
      {open && (
        <div className="divide-y divide-zinc-100 border-t border-zinc-100">
          {children}
        </div>
      )}
    </div>
  );
};

// ──────────────────────────────────────────────────────────────────────
// Типизированное поле формы с inline-сохранением.
// Generic по ключу: используется и для user (firstName/lastName/phone),
// и для studio (inn/ogrn/legalAddress/...) — onSave типобезопасно
// привязан к нужному набору ключей со стороны вызова.
//
// validate: если возвращает строку — это текст ошибки, поле не сохраняется.
// digitsOnly: ввод фильтруется до цифр (используется для ИНН/ОГРН).
// ──────────────────────────────────────────────────────────────────────
type UserFieldKey = 'firstName' | 'lastName' | 'phone';
type StudioFieldKey =
  | 'displayName'
  | 'inn'
  | 'ogrn'
  | 'legalAddress'
  | 'actualAddress'
  | 'contactPhone'
  | 'contactEmail'
  | 'guaranteeText';

interface EditableFieldProps<K extends string> {
  label: string;
  fieldKey: K;
  value: string;
  placeholder?: string;
  format?: (raw: string) => string;
  multiline?: boolean;
  digitsOnly?: boolean;
  validate?: (value: string) => string | null;
  onSave: (key: K, value: string) => Promise<void>;
  // readOnly=true — поле показывается, но input/textarea дизейблится. Это
  // нужно для master'a (он профиль не правит) и для не-owner'ов на
  // реквизитах студии. Без этого master видел поле, тыкал «Сохранить»,
  // получал 403 и краснело сообщение об ошибке.
  readOnly?: boolean;
}

const EditableField = <K extends string>({
  label, fieldKey, value, placeholder, format, multiline, digitsOnly, validate, onSave, readOnly,
}: EditableFieldProps<K>) => {
  const [draft, setDraft] = useState(value);
  const [savingState, setSavingState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [errorMsg, setErrorMsg] = useState('');

  // Если value (из props) поменялось снаружи — синкаем draft
  useEffect(() => { setDraft(value); }, [value]);

  const handleChange = (raw: string) => {
    let v = raw;
    if (digitsOnly) v = v.replace(/\D/g, '');
    if (format) v = format(v);
    setDraft(v);
    if (savingState !== 'idle') setSavingState('idle');
  };

  const handleBlur = async () => {
    const trimmed = draft.trim();
    if (trimmed === (value || '').trim()) return; // ничего не поменялось
    // Валидация (для ИНН/ОГРН/...). Для пустого значения validate не вызываем —
    // пустую строку всегда можно сохранить (= очистить поле).
    if (trimmed && validate) {
      const err = validate(trimmed);
      if (err) {
        setSavingState('error');
        setErrorMsg(err);
        return;
      }
    }
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
      <div className={multiline ? 'flex items-start gap-2' : 'flex items-center gap-2'}>
        {multiline ? (
          <textarea
            value={draft}
            placeholder={readOnly ? '—' : placeholder}
            rows={2}
            disabled={readOnly}
            onChange={(e) => handleChange(e.target.value)}
            onBlur={handleBlur}
            // placeholder:text-zinc-300 + italic — фидбек: «в спешке не понимаешь
            // заполнен пункт или нет». Светлый курсив сразу читается как пример,
            // в отличие от валидного значения текстом zinc-900.
            className={`flex-1 bg-transparent outline-none border-b border-transparent transition-colors resize-none leading-snug placeholder:text-zinc-300 placeholder:italic placeholder:font-normal ${
              readOnly ? 'text-zinc-500 cursor-default' : 'text-zinc-900 focus:border-zinc-300'
            }`}
          />
        ) : (
          <input
            type="text"
            value={draft}
            placeholder={readOnly ? '—' : placeholder}
            inputMode={digitsOnly ? 'numeric' : undefined}
            disabled={readOnly}
            onChange={(e) => handleChange(e.target.value)}
            onBlur={handleBlur}
            className={`flex-1 bg-transparent outline-none border-b border-transparent transition-colors placeholder:text-zinc-300 placeholder:italic placeholder:font-normal ${
              readOnly ? 'text-zinc-500 cursor-default' : 'text-zinc-900 focus:border-zinc-300'
            }`}
          />
        )}
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
// DailySummaryTimeField — поле «во сколько присылать утреннюю сводку».
//
// Зачем отдельный компонент (а не EditableField): тут две связанные
// вещи — само время И флаг «вообще присылать?». В одно текстовое поле
// это плохо ложится. Поэтому показываем <input type="time"> + ссылку
// «Не присылать»; если сводка отключена — текст «Сводка отключена» и
// ссылку «Включить».
//
// Сохранение:
//   • Изменили время → onSave('HH:MM') (только если включено)
//   • Нажали «Не присылать» → onSave(null)
//   • Нажали «Включить» → onSave(time) — берём ранее введённое время
//     (или дефолт '09:00')
//
// readOnly=true для не-owner-ов: показываем текущее значение, инпут
// дизейблен, ссылок нет.
// ──────────────────────────────────────────────────────────────────────
interface DailySummaryTimeFieldProps {
  value: string | null;
  onSave: (next: string | null) => Promise<void>;
  readOnly?: boolean;
}

const DailySummaryTimeField = ({ value, onSave, readOnly }: DailySummaryTimeFieldProps) => {
  // localTime хранит время даже когда сводка выключена — чтобы при
  // повторном включении не сбрасывать выбор пользователя.
  const [localTime, setLocalTime] = useState(value || '09:00');
  const [savingState, setSavingState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [errorMsg, setErrorMsg] = useState('');

  useEffect(() => {
    if (value) setLocalTime(value);
  }, [value]);

  const enabled = value !== null;

  const persist = async (next: string | null) => {
    setSavingState('saving');
    setErrorMsg('');
    try {
      await onSave(next);
      setSavingState('saved');
      setTimeout(() => setSavingState('idle'), 2000);
    } catch (e: any) {
      setSavingState('error');
      setErrorMsg(e?.message || 'Не удалось сохранить');
    }
  };

  const handleTimeChange = (raw: string) => {
    setLocalTime(raw);
    if (savingState !== 'idle') setSavingState('idle');
  };

  // Сохраняем по blur — не дёргаем сервер на каждом клике секундомера.
  // Если значение не поменялось или сводка выключена — ничего не шлём.
  const handleTimeBlur = () => {
    if (!enabled) return;
    // <input type="time"> обычно отдаёт 'HH:MM'. На всякий случай
    // нормализуем — если пришло пустое значение, не пытаемся сохранить.
    if (!/^\d{2}:\d{2}$/.test(localTime)) return;
    if (localTime === (value || '')) return;
    persist(localTime);
  };

  const handleDisable = () => persist(null);
  const handleEnable  = () => persist(localTime || '09:00');

  return (
    <div className="px-6 py-4">
      <label className="text-xs text-zinc-400 block mb-1">Время утренней сводки</label>
      <div className="flex items-center gap-3 flex-wrap">
        <input
          type="time"
          value={enabled ? localTime : ''}
          disabled={readOnly || !enabled}
          onChange={(e) => handleTimeChange(e.target.value)}
          onBlur={handleTimeBlur}
          className={`bg-transparent outline-none border-b border-transparent transition-colors px-1 py-0.5 ${
            readOnly || !enabled ? 'text-zinc-400 cursor-default' : 'text-zinc-900 focus:border-zinc-300'
          }`}
        />
        {!readOnly && enabled && (
          <button
            type="button"
            onClick={handleDisable}
            className="text-xs text-zinc-400 hover:text-zinc-700 underline underline-offset-2 transition-colors"
          >
            Не присылать
          </button>
        )}
        {!readOnly && !enabled && (
          <>
            <span className="text-sm text-zinc-500">Сводка отключена</span>
            <button
              type="button"
              onClick={handleEnable}
              className="text-xs text-zinc-500 hover:text-zinc-900 underline underline-offset-2 transition-colors"
            >
              Включить
            </button>
          </>
        )}
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
      <p className="mt-2 text-xs text-zinc-500 leading-relaxed">
        В это время бот пришлёт в Telegram список записей и задач на день.
        Время одно на всю студию — меняет только владелец.
      </p>
    </div>
  );
};

// ──────────────────────────────────────────────────────────────────────
// DemoDataField — две кнопки «Заполнить демо» / «Очистить демо».
//
// Для новой студии демо подкладывается автоматически при регистрации
// (см. server/lib/tenant_provisioning.cjs). Этот блок нужен для двух
// сценариев:
//   1) у юзера в студии всё пусто (demo по какой-то причине не зашёл /
//      зарегистрировался до фичи) — кликает «Заполнить» и видит примеры;
//   2) пощупал и хочет начать с чистого листа — «Очистить» уносит
//      всё с is_demo=TRUE, реальные карточки не трогает.
//
// Owner-only — гейтинг и в UI, и в бэке (только owner может).
// ──────────────────────────────────────────────────────────────────────
const DemoDataField = () => {
  const [busy, setBusy] = useState<'seed' | 'clear' | null>(null);
  const [error, setError] = useState('');
  const [done, setDone] = useState<'seed' | 'clear' | null>(null);

  const callApi = async (kind: 'seed' | 'clear') => {
    setBusy(kind);
    setError('');
    setDone(null);
    try {
      const res = await fetch(`/api/profile/demo/${kind}`, {
        method: 'POST',
        credentials: 'include',
      });
      if (!res.ok) {
        // Прокидываем ApiError-совместимый объект, чтобы translateApiError
        // подхватил `code` из ERROR_TRANSLATIONS и показал русский текст
        // вместо «internal_error».
        const body = await res.json().catch(() => ({} as any));
        const err: any = new Error(body?.error || `HTTP ${res.status}`);
        err.code = body?.error || 'http_error';
        err.status = res.status;
        throw err;
      }
      setDone(kind);
      setBusy(null);
      // Раньше тут был window.location.reload() — терялся scroll и фокус
      // юзера. Теперь не перезагружаем: каждый View (Клиенты / Задачи /
      // Календарь / Финансы) делает fetch при открытии своей вкладки,
      // так что свежие данные подтянутся автоматически при переходе.
      // Зелёный плашка «демо добавлено / удалено» висит дольше (4 сек),
      // чтобы юзер успел заметить и понять что переключаться можно.
      setTimeout(() => setDone(null), 4000);
    } catch (e: any) {
      setError(translateApiError(e, kind === 'seed'
        ? 'Не удалось заполнить демо-данные'
        : 'Не удалось очистить демо-данные'));
      setBusy(null);
    }
  };

  return (
    <div className="px-6 py-4">
      <p className="text-sm text-zinc-600 leading-relaxed mb-3">
        Демо — это 2 клиента с авто, записями, задачами и транзакциями.
        Чтобы привыкнуть к интерфейсу, посмотреть как выглядит заполненная
        CRM. Удалить можно одной кнопкой ниже — настоящие карточки
        не пострадают.
      </p>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => callApi('seed')}
          disabled={busy !== null}
          className="px-4 py-2 rounded-xl text-sm font-medium bg-zinc-900 text-white hover:bg-zinc-800 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {busy === 'seed' ? 'Заполняем…' : 'Заполнить демо'}
        </button>
        <button
          type="button"
          onClick={() => {
            if (window.confirm('Удалить все демо-данные? Реальные карточки не пострадают.')) {
              callApi('clear');
            }
          }}
          disabled={busy !== null}
          className="px-4 py-2 rounded-xl text-sm font-medium bg-zinc-100 text-zinc-700 hover:bg-zinc-200 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {busy === 'clear' ? 'Удаляем…' : 'Очистить демо'}
        </button>
      </div>
      {done === 'seed' && (
        <p className="mt-3 text-xs text-emerald-600 leading-relaxed">
          ✓ Демо добавлено. Открой раздел «Клиенты», «Задачи», «Календарь»
          или «Финансы» — увидишь Ивана Петрова и Анну Смирнову с записями
          и платежами.
        </p>
      )}
      {done === 'clear' && (
        <p className="mt-3 text-xs text-emerald-600 leading-relaxed">
          ✓ Демо удалено. Реальные карточки клиентов остались на месте.
        </p>
      )}
      {error && <p className="mt-2 text-xs text-red-500">{error}</p>}
    </div>
  );
};

// ──────────────────────────────────────────────────────────────────────
// Расчёт сколько бонусов применится — нужен ТОЛЬКО для UI-превью (старая
// перечёркнутая цена + строка «Применятся бонусы: до X»). Реальное значение,
// которое уйдёт в Prodamus, считает сервер при выдаче intent — фронт
// никогда не отправляет этот расчёт «на доверии».
//
// Правило: применить весь баланс, но не больше чем (priceRub - 1) — нужен
// минимум 1 ₽ оплаты, иначе Prodamus откажет на нулевой сумме и webhook
// не сработает. Бэк дублирует это правило в server/routes/profile.cjs
// (intent endpoint).
// ──────────────────────────────────────────────────────────────────────
function calcBonusUsage(priceRub: number, balanceKop: number): { useKop: number; finalRub: number } {
  if (!balanceKop || balanceKop <= 0) return { useKop: 0, finalRub: priceRub };
  const maxApplyKop = Math.max(0, (priceRub - 1) * 100); // оставить минимум 1 ₽
  const useKop = Math.min(balanceKop, maxApplyKop);
  const finalRub = Math.max(1, Math.ceil(priceRub - useKop / 100));
  return { useKop, finalRub };
}

// ──────────────────────────────────────────────────────────────────────
// Стартовать оплату: получить intent → построить payform-URL → открыть.
//
// До этой функции фронт строил URL сам (с `_param_studio_id` из своей
// сессии). Атакующий мог поменять studio_id в devtools на чужой UUID и
// через webhook манипулировать чужой подпиской (см. webhooks.cjs).
//
// Теперь:
//   1. POST /api/profile/payment/intent { plan } → сервер выпускает
//      одноразовый token, привязанный к req.session.studioId.
//   2. Подставляем token как `_param_intent` (плюс _param_plan и
//      customer_email — они для UX чекаута, не для security).
//   3. Бонусы — берём `bonusKopApplied` и `finalAmountRub` ИЗ ОТВЕТА
//      сервера, не считаем на фронте: сервер источник истины, чтобы
//      на чекауте сумма совпала с ожиданием webhook'а.
//
// Раньше открывали `window.open(url, '_blank')`, но iOS Safari (особенно
// in-app браузер Telegram) блокирует popup, если вызов window.open сделан
// ПОСЛЕ async-await (теряется user-gesture контекст). Жалоба «кнопки не
// работают на телефоне» была именно про это.
// Решение: навигируемся в том же окне через window.location.href. Возврат
// после оплаты обрабатывает usePaymentReturn хук — Prodamus редиректит
// обратно на /profile?payment=success, мы парсим query и обновляем UI.
// ──────────────────────────────────────────────────────────────────────
async function startPaymentFlow(
  option: TariffOption,
  email: string,
): Promise<void> {
  const intent = await api.createPaymentIntent(option.id);
  const u = new URL(option.payformUrl);
  u.searchParams.set('_param_intent', intent.token);
  u.searchParams.set('_param_plan', option.id);
  if (email) u.searchParams.set('customer_email', email);
  if (intent.bonusKopApplied > 0) {
    u.searchParams.set('_param_bonus_kop', String(intent.bonusKopApplied));
    // Prodamus: размер скидки в ЦЕЛЫХ рублях. customer_price у них не
    // реализован — поддержка ответила 28.04.2026: «размер скидки по оплате
    // передаётся через параметр discount_value». bonusKopApplied на сервере
    // приведён к кратности 100, поэтому деление точное.
    u.searchParams.set('discount_value', String(Math.floor(intent.bonusKopApplied / 100)));
  }
  // Same-window navigation: надёжно работает на любом мобиле, не зависит
  // от popup-блокеров. После оплаты Prodamus вернёт на /profile с query.
  window.location.href = u.toString();
}

// ──────────────────────────────────────────────────────────────────────
// Карточка тарифа: 2 кнопки (мес / год). Студия выделена как «популярная».
// ──────────────────────────────────────────────────────────────────────
interface TariffCardViewProps {
  group: TariffGroup;
  isCurrent: boolean;
  email: string;
  // Баланс бонусов — для UI-превью скидки и подсказки «будет применено X ₽».
  bonusBalanceKop?: number;
  // Согласие с офертой — общий стейт на родителе, чекбокс отображается
  // в каждой карточке (две колонки), но управляет одним и тем же полем.
  acceptOffer: boolean;
  setAcceptOffer: (v: boolean) => void;
}

const TariffCardView = ({ group, isCurrent, email, bonusBalanceKop = 0, acceptOffer, setAcceptOffer }: TariffCardViewProps) => {
  // Состояние «идёт запрос intent'а» — чтобы заблокировать кнопку и
  // не дать создать два intent'а параллельно (каждый одноразовый,
  // второй пропадёт впустую).
  const [busy, setBusy] = useState<TariffId | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handlePay = async (option: TariffOption) => {
    if (busy) return;
    setBusy(option.id);
    setError(null);
    try {
      await startPaymentFlow(option, email);
    } catch (err) {
      setError(translateApiError(err, 'Не удалось начать оплату'));
    } finally {
      setBusy(null);
    }
  };

  // UI-превью: сколько применится бонусов на месячном/годовом — для
  // перечёркнутой цены и подписи внизу карточки. Реальное значение
  // считает сервер при создании intent'а.
  const monthlyUse = calcBonusUsage(group.monthly.priceRub, bonusBalanceKop);
  const yearlyUse  = calcBonusUsage(group.yearly.priceRub,  bonusBalanceKop);

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

      {/*
        Кнопка «Оплатить на 1 месяц».
        Раньше при клике visual-disabled ставился ОБОИМ кнопкам (через
        `disabled:opacity-50` + `disabled={busy!==null}`) — на телефоне
        это выглядело как «обе мигают», и пользователь не понимал, какая
        реально нажалась. Теперь:
          • тапнутая кнопка получает opacity-60 + cursor-wait + текст
            «Открываем…» → ясно, что система отрабатывает именно её;
          • вторая остаётся в исходном виде, но `disabled`-блокировка
            всё ещё стоит — двойной тап в тот же момент не создаст
            второй intent.
      */}
      <button
        type="button"
        onClick={() => handlePay(group.monthly)}
        disabled={busy !== null}
        aria-busy={busy === group.monthly.id}
        className={
          'mt-2 flex flex-col items-center justify-center w-full px-4 py-3 rounded-xl bg-white border border-orange-300 text-orange-700 hover:bg-orange-50 active:bg-orange-100 transition-colors ' +
          (busy === group.monthly.id ? 'opacity-60 cursor-wait' : '')
        }
      >
        <span className="text-xs">{busy === group.monthly.id ? 'Открываем…' : 'Оплатить на 1 месяц'}</span>
        {monthlyUse.useKop > 0 ? (
          <span className="mt-0.5 text-lg font-bold">
            <span className="line-through text-zinc-400 text-sm font-normal mr-2">
              {formatRub(group.monthly.priceRub)}
            </span>
            {formatRub(monthlyUse.finalRub)}
          </span>
        ) : (
          <span className="mt-0.5 text-lg font-bold">{formatRub(group.monthly.priceRub)}</span>
        )}
      </button>

      {/* Кнопка «Оплатить на 12 месяцев» с ribbon-бейджем скидки сбоку.
          Visual-disabled только на нажатой — см. комментарий к monthly выше. */}
      <button
        type="button"
        onClick={() => handlePay(group.yearly)}
        disabled={busy !== null}
        aria-busy={busy === group.yearly.id}
        className={
          'mt-3 relative flex flex-col items-center justify-center w-full px-4 py-3 rounded-xl bg-orange-500 text-white hover:bg-orange-600 active:bg-orange-700 transition-colors shadow-sm ' +
          (busy === group.yearly.id ? 'opacity-60 cursor-wait' : '')
        }
      >
        {group.yearly.savePct && (
          <span
            aria-label={`Скидка ${group.yearly.savePct}%`}
            className="absolute -top-2 -right-2 px-2 py-0.5 rounded-full bg-emerald-500 text-white text-xs font-bold tracking-wide shadow-md ring-2 ring-white"
          >
            −{group.yearly.savePct}%
          </span>
        )}
        <span className="text-xs opacity-90">{busy === group.yearly.id ? 'Открываем…' : 'Оплатить на 12 месяцев'}</span>
        {yearlyUse.useKop > 0 ? (
          <span className="mt-0.5 text-lg font-bold">
            <span className="line-through opacity-70 text-sm font-normal mr-2">
              {formatRub(group.yearly.priceRub)}
            </span>
            {formatRub(yearlyUse.finalRub)}
          </span>
        ) : (
          <span className="mt-0.5 text-lg font-bold">{formatRub(group.yearly.priceRub)}</span>
        )}
      </button>

      {error && (
        <p className="mt-2 text-xs text-red-500 text-center">{error}</p>
      )}

      {(monthlyUse.useKop > 0 || yearlyUse.useKop > 0) && (
        <p className="mt-2 text-[11px] text-emerald-700 text-center">
          Применятся бонусы: до {formatRub(Math.max(monthlyUse.useKop, yearlyUse.useKop) / 100)}
        </p>
      )}

      {group.yearly.perMonthRub && (
        <p className="mt-2 text-[11px] text-zinc-500 text-center">
          ≈ {formatRub(group.yearly.perMonthRub)}/мес · экономия {formatRub(group.yearly.saveRub || 0)} за год
        </p>
      )}

      {/*
        Чекбокс согласия с офертой — внутри карточки, под строчкой про
        экономию. Стейт общий на обе карточки, но рендерим в каждой,
        чтобы строчка была у юзера прямо перед глазами в момент выбора
        тарифа.
        Чекбокс кастомный (div с border + tick-svg), потому что нативный
        <input type=checkbox> на iOS Safari без accentColor отрисовывается
        как тонкая рамка, плохо различимая на светлом фоне («белый экран»
        в жалобе пользователя). Кастомная рамка-2 + явный фон + явная
        галочка работают одинаково на всех платформах.
      */}
      <label className="mt-3 flex items-start gap-2 cursor-pointer select-none">
        <input
          type="checkbox"
          checked={acceptOffer}
          onChange={(e) => setAcceptOffer(e.target.checked)}
          className="sr-only peer"
        />
        <span
          aria-hidden
          className={
            'mt-0.5 h-5 w-5 shrink-0 rounded border-2 flex items-center justify-center transition-colors ' +
            (acceptOffer
              ? 'bg-orange-500 border-orange-500 text-white'
              : 'bg-white border-zinc-400 text-transparent')
          }
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="5 12 10 17 19 7" />
          </svg>
        </span>
        <span className="text-[11px] text-zinc-600 leading-snug">
          Оплачивая тариф, я принимаю условия{' '}
          <a
            href="/legal/offer.html"
            target="_blank"
            rel="noreferrer"
            className="text-zinc-900 underline"
            onClick={(e) => e.stopPropagation()}
          >
            публичной оферты
          </a>
          {' '}и{' '}
          <a
            href="/legal/privacy-policy"
            target="_blank"
            rel="noreferrer"
            className="text-zinc-900 underline"
            onClick={(e) => e.stopPropagation()}
          >
            политики конфиденциальности
          </a>.
        </span>
      </label>
    </div>
  );
};

// ──────────────────────────────────────────────────────────────────────
// ReferralSection — блок «Моя реферальная программа» в профиле.
//
// Что показываем:
//   • Персональная ссылка с кнопкой «Скопировать».
//   • Текущий баланс бонусов + сколько всего получили / потратили.
//   • Сетка статистики: приглашений / оплативших.
//   • Список приведённых студий (имя + дата + бейдж «оплатили»).
//   • Журнал начислений/списаний.
//
// Данные загружаем лениво (api.getReferral) при первом маунте секции.
// Раздельный эндпоинт от /api/profile, чтобы не утяжелять основную загрузку
// (агрегаты по referral_events недёшевые на больших объёмах).
// ──────────────────────────────────────────────────────────────────────
interface ReferralSectionProps {
  referralCode: string | null;
  bonusBalanceKop: number;
}

const ReferralSection = ({ referralCode, bonusBalanceKop }: ReferralSectionProps) => {
  const [data, setData] = useState<Awaited<ReturnType<typeof api.getReferral>> | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const res = await api.getReferral();
        if (mounted) setData(res);
      } catch (e) {
        if (mounted) setErr(translateApiError(e, 'Не удалось загрузить статистику'));
      } finally {
        if (mounted) setLoading(false);
      }
    })();
    return () => { mounted = false; };
  }, []);

  // Ссылка собирается из кода. Для прода — domain из window.location.origin.
  // Для dev (localhost) тоже сработает, просто будет http://localhost:5173/?ref=…
  const code = data?.referralCode || referralCode || '';
  const link = code
    ? `${typeof window !== 'undefined' ? window.location.origin : 'https://detailprocrm.ru'}/?ref=${code}`
    : '';

  const handleCopy = async () => {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (_) {
      // фолбэк для старых браузеров — выделение и Ctrl+C
      const ta = document.createElement('textarea');
      ta.value = link;
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); setCopied(true); setTimeout(() => setCopied(false), 1500); }
      catch (_) { /* noop */ }
      document.body.removeChild(ta);
    }
  };

  // Используем серверный balance (data.bonusBalanceKop), если успели загрузить —
  // он точнее, чем мог быть на момент открытия профиля.
  const balanceKop = data ? data.bonusBalanceKop : bonusBalanceKop;
  const totalEarnedKop = data?.totalEarnedKop || 0;
  const totalSpentKop  = data?.totalSpentKop  || 0;
  const refCount = data?.referralsCount || 0;
  const paidCount = data?.paidReferralsCount || 0;
  const bonusPerKop = data?.bonusPerReferralKop || 125000;

  return (
    <div className="px-6 py-5 space-y-5">
      {/* Заглушка пока грузим — но код у нас уже есть, можно показать ссылку сразу */}
      {/* ── Реферальная ссылка ─────────────────────────────────────── */}
      <div>
        <div className="text-xs font-medium text-zinc-500 mb-1.5">Ваша персональная ссылка</div>
        <div className="flex flex-col sm:flex-row gap-2">
          <input
            value={link}
            readOnly
            onFocus={(e) => e.currentTarget.select()}
            className="flex-1 bg-zinc-50 border border-zinc-200 rounded-lg px-3 py-2 text-sm text-zinc-700 font-mono outline-none focus:border-zinc-300"
          />
          <button
            type="button"
            onClick={handleCopy}
            disabled={!link}
            className="px-4 py-2 rounded-lg bg-zinc-900 text-white text-sm font-medium hover:bg-zinc-800 transition-colors disabled:opacity-50"
          >
            {copied ? 'Скопировано' : 'Скопировать'}
          </button>
        </div>
        <p className="mt-2 text-[11px] text-zinc-500 leading-relaxed">
          Делитесь ссылкой с коллегами. За каждую студию, оплатившую любой тариф,
          вам начислят <span className="font-semibold text-orange-600">{formatRub(bonusPerKop / 100)}</span> бонусами.
          Бонусы автоматически применяются при оплате вашего тарифа. Снять нельзя.
        </p>
      </div>

      {/* ── Балансы ────────────────────────────────────────────────── */}
      <div className="grid grid-cols-3 gap-2 sm:gap-3">
        <div className="rounded-xl border border-emerald-200 bg-emerald-50/60 p-3">
          <div className="text-xs uppercase tracking-wide text-emerald-700 font-semibold">Доступно</div>
          <div className="mt-1 text-base sm:text-lg font-bold text-emerald-900">
            {formatRub(balanceKop / 100)}
          </div>
        </div>
        <div className="rounded-xl border border-zinc-200 p-3">
          <div className="text-xs uppercase tracking-wide text-zinc-500 font-semibold">Всего начислено</div>
          <div className="mt-1 text-base sm:text-lg font-bold text-zinc-900">
            {formatRub(totalEarnedKop / 100)}
          </div>
        </div>
        <div className="rounded-xl border border-zinc-200 p-3">
          <div className="text-xs uppercase tracking-wide text-zinc-500 font-semibold">Потрачено</div>
          <div className="mt-1 text-base sm:text-lg font-bold text-zinc-900">
            {formatRub(totalSpentKop / 100)}
          </div>
        </div>
      </div>

      {/* ── Статистика приглашений ─────────────────────────────────── */}
      <div className="grid grid-cols-2 gap-2 sm:gap-3">
        <div className="rounded-xl border border-zinc-200 p-3">
          <div className="text-xs uppercase tracking-wide text-zinc-500 font-semibold">Регистраций</div>
          <div className="mt-1 text-lg font-bold text-zinc-900">{refCount}</div>
        </div>
        <div className="rounded-xl border border-zinc-200 p-3">
          <div className="text-xs uppercase tracking-wide text-zinc-500 font-semibold">Оплатили</div>
          <div className="mt-1 text-lg font-bold text-zinc-900">{paidCount}</div>
        </div>
      </div>

      {loading && (
        <div className="text-xs text-zinc-400">Загружаем статистику…</div>
      )}
      {err && !loading && (
        <div className="text-xs text-red-500">{err}</div>
      )}

      {/* ── Список приведённых студий ──────────────────────────────── */}
      {data && data.referrals.length > 0 && (
        <div>
          <div className="text-xs font-medium text-zinc-500 mb-2">Приведённые студии</div>
          <div className="rounded-xl border border-zinc-200 divide-y divide-zinc-100">
            {data.referrals.map((r) => (
              <div key={r.id} className="px-3 py-2.5 flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-sm text-zinc-900 truncate">{r.displayName}</div>
                  <div className="text-[11px] text-zinc-400">
                    Зарегистрирован {formatDateRu(r.createdAt)}
                  </div>
                </div>
                <span
                  className={`shrink-0 px-2 py-0.5 rounded-full text-xs font-semibold uppercase tracking-wide ${
                    r.hasPaid
                      ? 'bg-emerald-100 text-emerald-800'
                      : 'bg-zinc-100 text-zinc-500'
                  }`}
                >
                  {r.hasPaid ? 'оплатил' : 'без оплаты'}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Журнал операций ─────────────────────────────────────────── */}
      {data && data.events.length > 0 && (
        <div>
          <div className="text-xs font-medium text-zinc-500 mb-2">История операций</div>
          <div className="rounded-xl border border-zinc-200 divide-y divide-zinc-100">
            {data.events.map((e) => (
              <div key={e.id} className="px-3 py-2.5 flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-sm text-zinc-900">
                    {e.kind === 'credit' ? 'Начисление' : 'Списание при оплате'}
                  </div>
                  <div className="text-[11px] text-zinc-400">
                    {formatDateRu(e.createdAt)}
                  </div>
                </div>
                <div
                  className={`shrink-0 text-sm font-bold ${
                    e.kind === 'credit' ? 'text-emerald-700' : 'text-zinc-500'
                  }`}
                >
                  {e.kind === 'credit' ? '+' : '−'}
                  {formatRub(e.amountKop / 100)}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {data && data.referrals.length === 0 && (
        <div className="rounded-xl border border-dashed border-zinc-200 p-4 text-center">
          <p className="text-sm text-zinc-600">Пока никто не зарегистрировался по вашей ссылке.</p>
          <p className="mt-1 text-[11px] text-zinc-400">
            Поделитесь ссылкой выше — и сразу увидите здесь первого приглашённого.
          </p>
        </div>
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
  // Чекбокс согласия с офертой: по дефолту включён (по 437/438 ГК РФ
  // оплата = акцепт оферты, поэтому пользователь видит подтверждённое
  // состояние, но может снять галочку — оплата при этом не блокируется).
  // Согласие с офертой/политикой. По 437/438 ГК РФ оплата = акцепт оферты,
  // поэтому юридически чекбокс — формальность; ставим его checked по умолчанию,
  // не гейтим оплату, пользователь может снять при желании. Видим на странице
  // выше карточек, чтобы было понятно, что оплата = акцепт.
  const [acceptOffer, setAcceptOffer] = useState(true);
  // Telegram-привязка. tgBusy блокирует обе кнопки (Подключить/Отключить).
  // tgWaiting=true → пользователь нажал «Подключить», deep-link открыт в новой
  // вкладке; ждём подтверждения от бота. Кнопка превращается в «Я подтвердил
  // в Telegram», по клику дёргаем loadProfile() и проверяем tgLinked.
  const [tgBusy, setTgBusy] = useState(false);
  const [tgWaiting, setTgWaiting] = useState(false);
  const [tgError, setTgError] = useState('');
  // Сохраняем сгенерированную ссылку, чтобы показать пользователю реальный
  // <a target="_blank"> — нативный клик не режется popup-блокером (в отличие
  // от window.open после await на iOS Safari / in-app Telegram-браузере).
  const [tgLinkUrl, setTgLinkUrl] = useState<string | null>(null);
  // Модалка импорта клиентов из xlsx — открывается из секции «Студия».
  // Доступна owner+manager (см. canEditEntities); сервер всё равно перепроверяет
  // в /clients/bulk через requireRole('owner','manager').
  const [importOpen, setImportOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void loadProfile();
  }, []);

  // Рефетч /profile при возврате на вкладку. Сценарий:
  // регистрация через TG-бота открывается в in-app браузере Telegram, который
  // кэширует первый GET профиля и/или замораживает страницу при переключении
  // в основное приложение TG. Юзер возвращается — а tgLinked остаётся false,
  // хотя в БД уже linked. Слушаем visibilitychange и pageshow (BFCache).
  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState === 'visible') {
        // тихо, без isLoading=true — пользователь уже видит контент,
        // не хотим мерцать спиннер на ровном месте.
        api.getProfile().then(setData).catch(() => { /* офлайн — оставим старые данные */ });
      }
    };
    document.addEventListener('visibilitychange', refresh);
    window.addEventListener('pageshow', refresh);
    return () => {
      document.removeEventListener('visibilitychange', refresh);
      window.removeEventListener('pageshow', refresh);
    };
  }, []);

  const loadProfile = async () => {
    try {
      setIsLoading(true);
      setError('');
      const res = await api.getProfile();
      setData(res);
    } catch (err) {
      setError(translateApiError(err, 'Ошибка при загрузке профиля'));
    } finally {
      setIsLoading(false);
    }
  };

  const handleSaveField = async (key: UserFieldKey, value: string) => {
    const patch: Record<string, string | null> = { [key]: value === '' ? null : value };
    try {
      const res = await api.updateProfile(patch);
      setData((prev) => prev ? { ...prev, user: res.user } : prev);
      patchCachedUser({
        firstName: res.user.firstName ?? null,
        lastName: res.user.lastName ?? null,
        phone: res.user.phone ?? null,
        name: res.user.name,
      });
    } catch (err) {
      handleApiError(err, 'Не удалось сохранить — проверьте соединение', 'updateProfile');
    }
  };

  // Реквизиты студии для PDF: только owner. Мерджим обновлённые поля
  // в локальный state.studio, чтобы не перезагружать /profile целиком.
  const handleSaveStudioField = async (key: StudioFieldKey, value: string) => {
    const patch: Record<string, string | null> = { [key]: value === '' ? null : value };
    try {
      const res = await api.updateStudio(patch);
      setData((prev) => prev ? {
        ...prev,
        studio: { ...prev.studio, ...res.studio },
      } : prev);
    } catch (err) {
      // Перебрасываем дальше в EditableField, чтобы оно показало красную
      // подсказку прямо под полем (через translateApiError → русский текст).
      // Раньше ошибку «съедал» handleApiError → пользователь не понимал, почему
      // например название студии не получается стереть.
      const message = translateApiError(err, 'Не удалось сохранить реквизиты');
      throw new Error(message);
    }
  };

  // Время утренней сводки в Telegram. Отдельный хендлер от
  // handleSaveStudioField, потому что значение может быть null
  // (сводка отключена), а handleSaveStudioField заточен под string.
  const handleSaveDailySummaryTime = async (next: string | null) => {
    try {
      const res = await api.updateStudio({ dailySummaryTime: next });
      setData((prev) => prev ? {
        ...prev,
        studio: { ...prev.studio, ...res.studio },
      } : prev);
    } catch (err) {
      const message = translateApiError(err, 'Не удалось сохранить время');
      throw new Error(message);
    }
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
    } catch (err) {
      handleApiError(err, 'Не удалось загрузить аватар', 'uploadAvatar');
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
    } catch (err) {
      handleApiError(err, 'Не удалось удалить аватар', 'deleteAvatar');
    } finally {
      setAvatarBusy(false);
    }
  };

  const handleCancelSubscription = async () => {
    if (subscriptionBusy || !data) return;
    const confirmText =
      'Отменить подписку?\n\n' +
      'Доступ к CRM сохранится до ' + formatDateRu(data.studio.accessUntil) + '. ' +
      'После этой даты автопродления и списаний больше не будет.';
    if (!window.confirm(confirmText)) return;
    setSubscriptionBusy(true);
    try {
      await api.cancelSubscription();
      setData((prev) => prev ? { ...prev, studio: { ...prev.studio, cancelPending: true } } : prev);
    } catch (err) {
      handleApiError(err, 'Не удалось отменить подписку', 'cancelSubscription');
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
    } catch (err) {
      handleApiError(err, 'Не удалось восстановить подписку', 'resumeSubscription');
    } finally {
      setSubscriptionBusy(false);
    }
  };

  // ── Telegram: подключение ────────────────────────────────────────
  // 1) дёргаем POST /profile/telegram/link → одноразовый deep-link
  // 2) сохраняем url в state, чтобы показать пользователю кнопку-якорь
  // 3) переключаем UI в состояние «ждём» с кнопкой «Я подтвердил»
  // 4) по клику или после возврата — loadProfile().
  //
  // Почему НЕ window.open? На мобильных Safari (особенно iOS, и in-app
  // браузер Telegram-бота) после `await` теряется user-gesture, и
  // `window.open(url, '_blank')` блокируется как popup. Раньше выдавали
  // ошибку «Окно заблокировано браузером», но это тупик для юзера: он
  // нажал кнопку и упёрся в текст.
  //
  // Решение: после API-ответа подставляем URL в реальный <a target="_blank">,
  // юзер кликает по нему — это нативный click (не popup), браузер открывает
  // ссылку без блокировки. На телефоне ссылка t.me/... триггерит deep-link
  // в приложение Telegram. Возврат — через кнопку «Я подтвердил».
  // Чекбокс согласия на трансграничную передачу (ч. 4 ст. 12 ФЗ-152) —
  // без него бэк не выдаст deep-link и не запишет согласие в consents.
  // Сбрасываем при отвязке (handleTelegramUnlink), чтобы при повторной
  // привязке юзер прочитал/принял ещё раз.
  const [tgCrossBorderConsent, setTgCrossBorderConsent] = useState(false);

  const handleTelegramLink = async () => {
    if (tgBusy) return;
    if (!tgCrossBorderConsent) {
      setTgError('Поставьте галочку согласия на трансграничную передачу — без неё привязка бота незаконна по 152-ФЗ.');
      return;
    }
    setTgBusy(true);
    setTgError('');
    try {
      const { url } = await api.linkTelegram(tgCrossBorderConsent);
      setTgLinkUrl(url);
      setTgWaiting(true);
    } catch (err) {
      setTgError(translateApiError(err, 'Не удалось создать ссылку для Telegram'));
    } finally {
      setTgBusy(false);
    }
  };

  // Кнопка «Я подтвердил в Telegram» — ручная перепроверка профиля.
  // Если бэк уже зафиксировал привязку, getProfile вернёт tgLinked=true,
  // и мы выйдем из tgWaiting. Если нет — оставим режим ожидания.
  const handleTelegramRecheck = async () => {
    setTgBusy(true);
    setTgError('');
    try {
      const res = await api.getProfile();
      setData(res);
      if (res.user.tgLinked) {
        setTgWaiting(false);
        setTgLinkUrl(null);
      } else {
        setTgError('Пока не вижу привязки. Откройте бот в Telegram и нажмите Start.');
      }
    } catch (err) {
      setTgError(translateApiError(err, 'Не удалось обновить профиль'));
    } finally {
      setTgBusy(false);
    }
  };

  const handleTelegramUnlink = async () => {
    if (tgBusy) return;
    if (!window.confirm('Отключить Telegram?\n\nПосле отключения бот перестанет присылать уведомления, а ссылка на сброс пароля будет недоступна.')) return;
    setTgBusy(true);
    setTgError('');
    try {
      await api.unlinkTelegram();
      setData((prev) => prev ? {
        ...prev,
        user: { ...prev.user, tgLinked: false, tgUsername: null, tgLinkedAt: null },
      } : prev);
      setTgWaiting(false);
      setTgLinkUrl(null);
    } catch (err) {
      setTgError(translateApiError(err, 'Не удалось отключить Telegram'));
    } finally {
      setTgBusy(false);
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
  // Имя в шапке профиля строго синхронизировано с полями «Имя»/«Фамилия»
  // ниже. Если оба пустые — показываем «Без имени» (а не user.name из
  // /profile, который бэк держит как email-prefix для UserMenu —
  // в этой шапке такой фолбек выглядел бы как «залипшая» старая фамилия).
  const fullName = `${user.firstName || ''} ${user.lastName || ''}`.trim() || 'Без имени';

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

  // Триал — сколько осталось дней (для шапки-баннера).
  // Используем parseDbDate (а не голый new Date), чтобы Safari корректно
  // съел Postgres-формат «2026-04-30 03:00:00.123456+00» (микросекунды +
  // короткий TZ-сдвиг). Без нормализации Safari возвращал Invalid Date,
  // trialDaysLeft становился 0 и красный баннер «Пробный период завершён»
  // показывался даже при живом доступе ещё на 3 дня.
  const isTrial = studio.plan === 'trial';
  const trialDaysLeft = isTrial ? (() => {
    const target = parseDbDate(studio.accessUntil);
    if (!target) return 0;
    const ms = target.getTime() - Date.now();
    // floor — см. describeAccessUntil выше: «осталось N дней» считается
    // полными сутками, иначе счётчик «3 дня» висит сутки после регистрации.
    return Math.max(0, Math.floor(ms / (24 * 60 * 60 * 1000)));
  })() : 0;

  // Можно ли отменить подписку: только owner на платном тарифе
  const canCancel = canManageSubscription(role) && (studio.plan === 'solo' || studio.plan === 'studio');

  return (
    // position: fixed inset: 0 — приколачиваем к viewport, чтобы НЕ
    // зависеть от height-цепочки html→body→#root. На iPhone Safari
    // h-full здесь раньше «не находил» однозначной высоты родителя
    // (из-за квирков с -webkit-fill-available / 100dvh при показанном
    // адресном баре), и тач-скролл не работал.
    <div
      className="bg-zinc-50 overflow-y-auto overscroll-contain"
      style={{
        position: 'fixed',
        top: 0, left: 0, right: 0, bottom: 0,
        WebkitOverflowScrolling: 'touch',
      }}
    >
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
        {/*
          Master свой аватар не меняет — кнопка/бейдж выбора файла спрятаны,
          сама аватарка отображается как картинка-плашка без onClick.
          (Бэк это тоже подтверждает 403 'master_cannot_edit'.)
        */}
        <div className="bg-white rounded-2xl shadow-sm border border-zinc-100 p-6 mb-4">
          <div className="flex flex-col items-center">
            <div className="relative">
              {canEditOwnProfile(role) ? (
                <>
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
                </>
              ) : (
                <div className="w-28 h-28 rounded-full bg-zinc-100 flex items-center justify-center overflow-hidden border-2 border-white shadow-sm">
                  {avatarSrc ? (
                    <img src={avatarSrc} alt="Аватар" className="w-full h-full object-cover" />
                  ) : (
                    <div className="text-zinc-400"><UserSilhouette /></div>
                  )}
                </div>
              )}
            </div>

            <h1 className="mt-4 text-xl font-semibold text-zinc-900">{fullName}</h1>

            <span className={`mt-2 inline-flex items-center px-3 py-1 rounded-full text-xs font-medium ${ROLE_CHIP_STYLES[role]}`}>
              {getRoleName(role)}
            </span>

            {/* Удалить — только если фото уже есть И его можно править. */}
            {user.avatarPath && canEditOwnProfile(role) && (
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
        {/*
          Для master'a поля ФИО/телефон показываем в режиме просмотра — его
          данные правит owner через админ-панель. См. canEditOwnProfile().
        */}
        <CollapsibleSection title="Личные данные" defaultOpen>
          <EditableField
            label="Имя"
            fieldKey="firstName"
            value={user.firstName || ''}
            placeholder="Например, Ольга"
            onSave={handleSaveField}
            readOnly={!canEditOwnProfile(role)}
          />
          <EditableField
            label="Фамилия"
            fieldKey="lastName"
            value={user.lastName || ''}
            placeholder="Например, Недведская"
            onSave={handleSaveField}
            readOnly={!canEditOwnProfile(role)}
          />
          <EditableField
            label="Телефон"
            fieldKey="phone"
            value={user.phone || ''}
            placeholder="+7 (___) ___-__-__"
            format={formatPhone}
            onSave={handleSaveField}
            readOnly={!canEditOwnProfile(role)}
          />
          <div className="px-6 py-4">
            <span className="text-xs text-zinc-400 block mb-1">Email</span>
            <span className="text-zinc-900">{user.email}</span>
            <p className="text-xs text-zinc-400 mt-1">
              Чтобы изменить email, напишите на{' '}
              <a className="underline" href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>
            </p>
          </div>
          <div className="px-6 py-4">
            <span className="text-xs text-zinc-400 block mb-1">Дата регистрации</span>
            <span className="text-zinc-900">{formatDateRu(user.createdAt)}</span>
          </div>
        </CollapsibleSection>

        {/* ── 2a. Telegram ─────────────────────────────────────────
            Привязка к боту @crmdetailpro_bot. Используется как канал для:
              • сброса пароля (без e-mail/SMTP)
              • уведомлений об оплате (Phase 2)
              • быстрого доступа к рефке/балансу (Phase 3)
              • уведомлений о новых записях клиентов на тарифе «Студия» (Phase 4)
            Видна всем ролям — каждому пользователю полезно, хотя бы для reset. */}
        <CollapsibleSection
          title="Telegram"
          subtitle={
            user.tgLinked
              ? (user.tgUsername ? `подключён как @${user.tgUsername}` : 'подключён')
              : 'не подключён'
          }
          defaultOpen={!user.tgLinked}
        >
          <div className="px-6 py-5">
            {user.tgLinked ? (
              <>
                <p className="text-sm text-zinc-700 mb-1">
                  Бот {user.tgUsername ? <span className="font-medium">@{user.tgUsername}</span> : 'Telegram'} подключён.
                </p>
                {user.tgLinkedAt && (
                  <p className="text-xs text-zinc-400 mb-4">
                    Привязан {formatDateRu(user.tgLinkedAt)}
                  </p>
                )}
                <p className="text-xs text-zinc-500 mb-4 leading-relaxed">
                  Через бот будут приходить напоминания о записях и задачах.
                </p>
                {tgError && <p className="text-sm text-red-500 mb-3">{tgError}</p>}
                <button
                  type="button"
                  onClick={handleTelegramUnlink}
                  disabled={tgBusy}
                  className="text-sm text-red-500 hover:text-red-600 disabled:opacity-50 transition-colors"
                >
                  {tgBusy ? 'Отключаем…' : 'Отключить Telegram'}
                </button>
              </>
            ) : tgWaiting ? (
              <>
                <p className="text-sm text-zinc-700 mb-2">
                  Откройте бот по кнопке ниже и нажмите в нём <span className="font-medium">Start</span> — затем вернитесь сюда.
                </p>
                <p className="text-xs text-zinc-500 mb-2">
                  Ссылка действует 24 часа и одноразовая.
                </p>
                <p className="text-xs text-zinc-400 mb-4 leading-relaxed">
                  Если бот не открывается — проверьте, что Telegram запущен. В России Telegram
                  может требовать VPN; CRM при этом работает и без VPN.
                </p>
                {tgError && <p className="text-sm text-amber-600 mb-3">{tgError}</p>}
                <div className="flex flex-wrap gap-2">
                  {/* Реальный <a> с target=_blank: на iOS Safari нативный клик
                      по ссылке не блокируется как popup (в отличие от
                      window.open после await). На телефоне ссылка t.me/…
                      триггерит deep-link в приложение Telegram. */}
                  {tgLinkUrl && (
                    <a
                      href={tgLinkUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="px-4 py-2 rounded-xl bg-orange-500 text-white text-sm font-medium hover:bg-orange-600 transition-colors"
                    >
                      Открыть бот в Telegram
                    </a>
                  )}
                  <button
                    type="button"
                    onClick={handleTelegramRecheck}
                    disabled={tgBusy}
                    className="px-4 py-2 rounded-xl bg-zinc-900 text-white text-sm font-medium hover:bg-orange-600 disabled:opacity-50 transition-colors"
                  >
                    {tgBusy ? 'Проверяем…' : 'Я подтвердил в Telegram'}
                  </button>
                  <button
                    type="button"
                    onClick={() => { setTgWaiting(false); setTgError(''); setTgLinkUrl(null); }}
                    disabled={tgBusy}
                    className="px-4 py-2 rounded-xl text-sm text-zinc-600 hover:text-zinc-900 disabled:opacity-50 transition-colors"
                  >
                    Отмена
                  </button>
                </div>
              </>
            ) : (
              <>
                <p className="text-sm text-zinc-600 mb-4 leading-relaxed">
                  Подключите бота, чтобы получать ссылку для сброса пароля,
                  уведомления об оплатах и о новых записях клиентов.
                </p>

                {/* Чекбокс согласия на трансграничную передачу — обязательное
                    отдельное согласие по ч. 4 ст. 12 ФЗ-152. Telegram —
                    зарубежные серверы (UK/UAE), для передачи туда ПДн нужно
                    явное согласие, отдельное от регистрационного. */}
                <label className="flex items-start gap-3 cursor-pointer select-none mb-4">
                  <input
                    type="checkbox"
                    checked={tgCrossBorderConsent}
                    onChange={(e) => setTgCrossBorderConsent(e.target.checked)}
                    className="mt-1 w-5 h-5 rounded border-zinc-300 accent-zinc-900 cursor-pointer"
                  />
                  <span className="text-xs text-zinc-600 leading-relaxed">
                    При привязке бота ваши данные (идентификатор Telegram,
                    имя пользователя, текст сообщений) передаются Telegram
                    Messenger Inc. на серверы за пределами РФ. Я даю согласие
                    на трансграничную передачу персональных данных. Подробнее —{' '}
                    <a
                      href="/legal/personal-data-consent"
                      target="_blank"
                      rel="noreferrer"
                      className="text-zinc-900 underline"
                    >
                      Согласие на обработку ПДн, раздел&nbsp;6
                    </a>.
                  </span>
                </label>

                {tgError && <p className="text-sm text-red-500 mb-3">{tgError}</p>}
                <button
                  type="button"
                  onClick={handleTelegramLink}
                  disabled={tgBusy || !tgCrossBorderConsent}
                  className="px-4 py-2 rounded-xl bg-zinc-900 text-white text-sm font-medium hover:bg-orange-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  {tgBusy ? 'Готовим ссылку…' : 'Подключить Telegram'}
                </button>
              </>
            )}
          </div>
        </CollapsibleSection>

        {/* ── 3. Студия ──────────────────────────────────────────── */}
        <CollapsibleSection title="Студия">
          {canEditStudio(role) ? (
            <EditableField
              label="Название"
              fieldKey="displayName"
              value={studio.displayName}
              placeholder="Например, DetailPro"
              onSave={handleSaveStudioField}
            />
          ) : (
            <div className="px-6 py-4">
              <span className="text-xs text-zinc-400 block mb-1">Название</span>
              <span className="text-zinc-900">{studio.displayName}</span>
            </div>
          )}
          <div className="px-6 py-4">
            <span className="text-xs text-zinc-400 block mb-1">Дата регистрации</span>
            <span className="text-zinc-900">{formatDateRu(studio.createdAt)}</span>
          </div>

          {/*
            Импорт базы клиентов из xlsx. Доступен owner+manager (canEditEntities).
            Master сюда вообще не попадает по бизнес-правилу: импортировать клиентов
            может только тот, кто их же и создаёт в обычном CRUD-флоу. Сервер
            перепроверяет на роли в POST /clients/bulk.
          */}
          {canEditEntities(role) && (
            <div className="px-6 py-4">
              <span className="text-xs text-zinc-400 block mb-2">База клиентов</span>
              <button
                type="button"
                onClick={() => setImportOpen(true)}
                className="inline-flex items-center gap-2 px-4 py-2.5 rounded-2xl bg-zinc-900 hover:bg-zinc-800 text-white text-sm font-semibold transition-colors min-h-[44px]"
              >
                Импортировать клиентов из Excel
              </button>
              <p className="text-xs text-zinc-500 mt-2 leading-relaxed">
                Загрузите готовый список клиентов (xlsx) — мы создадим карточки одним
                массовым импортом. Сначала скачайте шаблон, заполните своими данными,
                потом загрузите обратно.
              </p>
            </div>
          )}
        </CollapsibleSection>

        {/* ── 3a. Реквизиты для документов (owner only) ────────────
            Подставляются в шапку акта приёмки и заказ-наряда.
            Заполняется один раз; пустые поля в PDF выводятся как «—». */}
        {canEditStudio(role) && (
        <CollapsibleSection
          title="Реквизиты для документов"
          subtitle="Используются в шапке актов приёмки авто и заказ-нарядов"
        >
          <EditableField
            label="ИНН"
            fieldKey="inn"
            value={studio.inn || ''}
            placeholder="10 цифр (юрлицо) или 12 (ИП)"
            digitsOnly
            validate={validateInn}
            onSave={handleSaveStudioField}
          />
          <EditableField
            label="ОГРН / ОГРНИП"
            fieldKey="ogrn"
            value={studio.ogrn || ''}
            placeholder="13 или 15 цифр"
            digitsOnly
            validate={validateOgrn}
            onSave={handleSaveStudioField}
          />
          <EditableField
            label="Юридический адрес"
            fieldKey="legalAddress"
            value={studio.legalAddress || ''}
            placeholder="Москва, ул. Примерная, д. 1, оф. 2"
            multiline
            onSave={handleSaveStudioField}
          />
          <EditableField
            label="Фактический адрес студии"
            fieldKey="actualAddress"
            value={studio.actualAddress || ''}
            placeholder="Если совпадает с юридическим — оставьте пустым"
            multiline
            onSave={handleSaveStudioField}
          />
          <EditableField
            label="Телефон студии"
            fieldKey="contactPhone"
            value={studio.contactPhone || ''}
            placeholder="+7 (___) ___-__-__"
            format={formatPhone}
            onSave={handleSaveStudioField}
          />
          <EditableField
            label="Email студии"
            fieldKey="contactEmail"
            value={studio.contactEmail || ''}
            placeholder="info@example.com"
            validate={validateEmail}
            onSave={handleSaveStudioField}
          />
          <EditableField
            label="Текст гарантии"
            fieldKey="guaranteeText"
            value={studio.guaranteeText || ''}
            placeholder="Гарантия на выполненные работы — 14 календарных дней с даты выдачи"
            multiline
            onSave={handleSaveStudioField}
          />
        </CollapsibleSection>
        )}

        {/* ── 3a-bis. Утренняя сводка в Telegram (owner only) ──────────
            Время одно на студию (см. миграцию 011_daily_summary_time.sql),
            меняет только владелец. Бот в Telegram задаёт тот же вопрос
            при онбординге командой /время. Этот блок дублирует ту же
            настройку в CRM — для тех, кто живёт в десктопе и не хочет
            копаться в боте. */}
        {/* Утренняя сводка — фича тарифа «Студия». На trial/solo секция
            спрятана, гейтинг дублируется в PATCH /api/profile/studio
            (server) и в processStudio в reminders.cjs (cron). */}
        {canEditStudio(role) && studio.plan === 'studio' && (
        <CollapsibleSection
          title="Утренняя сводка в Telegram"
          subtitle={
            studio.dailySummaryTime
              ? `Каждый день в ${studio.dailySummaryTime}`
              : 'Сводка отключена'
          }
        >
          <DailySummaryTimeField
            value={studio.dailySummaryTime}
            onSave={handleSaveDailySummaryTime}
          />
        </CollapsibleSection>
        )}

        {/* ── Демо-данные (только owner). Чтобы новый юзер не упирался
            в пустые экраны и мог посмотреть на полный цикл «клиент →
            запись → задача → транзакция», прежде чем создавать своё. */}
        {role === 'owner' && (
        <CollapsibleSection
          title="Демо-данные"
          subtitle="Заполнить или очистить примеры клиентов и записей"
        >
          <DemoDataField />
        </CollapsibleSection>
        )}

        {/* ── 3b. Прайс-лист услуг (owner + manager) ───────────────────
            Услуги используются в выпадашке «Из прайса» при создании
            заказ-наряда. Master видит этот раздел в режиме чтения. */}
        <CollapsibleSection
          title="Прайс-лист услуг"
          subtitle="Используются при создании заказ-наряда"
        >
          <ServicesManager canEdit={canManageServices(role)} />
        </CollapsibleSection>

        {/* ── 4+5. Подписка (объединена с тарифами) ────────────────
            Видна ТОЛЬКО собственнику. Менеджер/мастер — сотрудники студии,
            биллинг к ним не относится.

            Раньше были две отдельные секции: «Тариф» (карточки оплаты) и
            «Подписка» (countdown + кнопка отмены). По UX-фидбэку объединили
            в одну сворачиваемую секцию «Подписка»: сначала статус доступа +
            управление подпиской, ниже — выбор тарифа со всеми CTA.
            Секция стартует свёрнутой — её редко открывают, а заметку
            «сейчас: Студия / Соло / Триал» видно прямо в подзаголовке. */}
        {canManageSubscription(role) && (
        <CollapsibleSection
          title="Подписка"
          subtitle={`сейчас: ${studio.planLabel}`}
        >
          {/* ── Статус доступа + управление подпиской ───────────────
              CollapsibleSection ставит divide-y между прямыми детьми,
              поэтому разделитель между блоками появится автоматически. */}
          <div className="px-6 py-5">
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
              <div className="mt-4 p-3 rounded-lg bg-emerald-50 border border-emerald-200">
                <p className="text-sm text-emerald-800 font-medium">
                  Подписка остановлена
                </p>
                <p className="mt-1 text-xs text-emerald-700">
                  Списаний больше не будет. Доступ к CRM сохраняется до {formatDateRu(studio.accessUntil)}.
                </p>
                <button
                  type="button"
                  onClick={handleResumeSubscription}
                  disabled={subscriptionBusy}
                  className="mt-3 inline-flex items-center justify-center px-3 py-1.5 rounded-md bg-white border border-emerald-300 text-emerald-800 text-xs font-medium hover:bg-emerald-100 transition-colors disabled:opacity-50"
                >
                  {subscriptionBusy ? 'Восстанавливаем…' : 'Возобновить подписку'}
                </button>
              </div>
            )}

            {/* Обычное состояние — кнопка «Отменить» (только для owner на платном тарифе).
                Делаем компактной и неброской: для UX и маркетинга важно, чтобы ключевое
                действие (продление/апгрейд) визуально доминировало над отменой. */}
            {!studio.cancelPending && canCancel && (
              <div className="mt-4">
                <button
                  type="button"
                  onClick={handleCancelSubscription}
                  disabled={subscriptionBusy}
                  className="text-xs text-zinc-400 hover:text-zinc-600 underline underline-offset-2 disabled:opacity-50 transition-colors"
                >
                  {subscriptionBusy ? 'Отменяем…' : 'Отменить подписку'}
                </button>
              </div>
            )}

            {!studio.cancelPending && !canCancel && canManageSubscription(role) && studio.plan === 'trial' && (
              <p className="mt-3 text-xs text-zinc-400">
                Сейчас активен пробный период. Когда оформите тариф — здесь появится кнопка «Отменить подписку».
              </p>
            )}
          </div>

          {/* ── Тарифы: триал-баннер + слот-каунтер + 2 карточки ─────
              Обёрнуты в один div, чтобы divide-y CollapsibleSection не
              разрывал баннер/каунтер/карточки лишними линиями. */}
          <div>

          {/* Триал-баннер: сколько дней осталось. */}
          {isTrial && trialDaysLeft > 0 && (
            <div className="mx-4 sm:mx-6 mt-4 p-4 rounded-xl bg-gradient-to-r from-orange-500 to-orange-400 text-white">
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
            <div className="mx-4 sm:mx-6 mt-4 p-4 rounded-xl bg-red-50 border border-red-200">
              <p className="text-sm font-semibold text-red-700">Пробный период завершён</p>
              <p className="mt-1 text-xs text-red-600">
                Чтобы вернуть доступ к CRM, оформите тариф ниже.
              </p>
            </div>
          )}

          {/* Слот-каунтер «Сотрудников: N из M» */}
          <div className="px-6 pt-4 pb-4">
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
            {/* Чекбокс с офертой теперь живёт ВНУТРИ каждой карточки (под
                кнопками оплаты), стейт общий через acceptOffer/setAcceptOffer.
                Раньше один чекбокс над карточками плохо находился глазами
                на iOS — пользователь думал, что «там белый экран». */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 md:gap-5">
              {TARIFF_GROUPS.map((group) => (
                <TariffCardView
                  key={group.id}
                  group={group}
                  isCurrent={currentGroup === group.id}
                  email={user.email}
                  bonusBalanceKop={studio.bonusBalanceKop || 0}
                  acceptOffer={acceptOffer}
                  setAcceptOffer={setAcceptOffer}
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
        </CollapsibleSection>
        )}

        {/* ── 6. Реферальная программа ──────────────────────────────
            Видна ТОЛЬКО собственнику. Загружает свои данные лениво
            при разворачивании секции — чтобы не дёргать /referral
            у всех владельцев на каждом открытии профиля. */}
        {canManageReferrals(role) && (
          <CollapsibleSection
            title="Реферальная программа"
            subtitle={
              studio.bonusBalanceKop > 0
                ? `Бонусов: ${formatRub(studio.bonusBalanceKop / 100)}`
                : 'Приведите студию — получите 1 250 ₽ бонусами'
            }
          >
            <ReferralSection
              referralCode={studio.referralCode}
              bonusBalanceKop={studio.bonusBalanceKop || 0}
            />
          </CollapsibleSection>
        )}

        {/*
          Модалка импорта клиентов. Рендерим всегда (по флагу isOpen),
          чтобы её состояние не сбрасывалось при коллапсе секции «Студия».
          После закрытия — onImported может прийти, но мы только закрываем:
          в ClientDetails-листе клиенты подтянутся при следующем заходе.
        */}
        <ClientsImport
          isOpen={importOpen}
          onClose={() => setImportOpen(false)}
        />

        {/* ── Подвал Профиля: ссылки на документы + удаление аккаунта ──
            Намеренно без отдельного CollapsibleSection (юзер: «не хочу
            ещё одну секцию, страница и так перегружена»). Просто плоские
            ссылки и кнопка-ссылка внизу. */}
        <ProfileFooterLinks
          isOwner={role === 'owner'}
          deletionRequestedAt={studio.deletionRequestedAt || null}
        />
      </div>
    </div>
  );
};

// ──────────────────────────────────────────────────────────────────────
// ProfileFooterLinks — мини-блок в самом низу Профиля.
//   • Ссылки на 5 юридических документов (внешние ссылки в новой вкладке).
//   • «Удалить аккаунт» (только owner) — toggle с подтверждением.
//
// Отдельный компонент, чтобы держать стейт удаления локально и не лить
// его в ProfilePage (там и так много стейта).
// ──────────────────────────────────────────────────────────────────────
interface ProfileFooterLinksProps {
  isOwner: boolean;
  deletionRequestedAt: string | null;
}

const ProfileFooterLinks = ({ isOwner, deletionRequestedAt: initialDeletion }: ProfileFooterLinksProps) => {
  const [deletionAt, setDeletionAt] = useState<string | null>(initialDeletion);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const requested = !!deletionAt;
  const effectiveAt = useMemo(() => {
    if (!deletionAt) return null;
    const t = parseDbDate(deletionAt);
    if (!t) return null;
    return new Date(t.getTime() + 30 * 24 * 3600 * 1000);
  }, [deletionAt]);

  const handleClick = async () => {
    if (busy) return;
    if (!requested) {
      // Двойное подтверждение перед запросом удаления — это необратимое
      // решение для юзера, нужно явно осознать.
      const ok = window.confirm(
        'Удалить аккаунт?\n\n' +
        'Студия и все данные клиентов будут удалены через 30 дней. ' +
        'Подписка не возвращается, бонусы сгорают. ' +
        'До истечения 30 дней можно отменить запрос — нажмите кнопку ещё раз.\n\n' +
        'Продолжить?'
      );
      if (!ok) return;
    }
    setBusy(true);
    setError('');
    try {
      const res = await api.requestAccountDeletion(requested);
      setDeletionAt(res.deletionRequestedAt);
    } catch (err) {
      setError(translateApiError(err, 'Не удалось обработать запрос'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-8 mb-4 px-2 text-center">
      {/* Обычные пробелы внутри «Поручение ПДн» / «Реферальная программа»
          позволяют переносить на следующую строку. Точки-разделители «·»
          уезжают вместе с соседней ссылкой при переносе — браузер
          обработает естественно. */}
      <p className="text-xs text-zinc-400 leading-relaxed mb-3">
        <a href="/legal/offer.html"                target="_blank" rel="noreferrer" className="hover:text-zinc-700 underline-offset-2 hover:underline">Оферта</a>
        {' · '}
        <a href="/legal/privacy-policy"            target="_blank" rel="noreferrer" className="hover:text-zinc-700 underline-offset-2 hover:underline">Политика</a>
        {' · '}
        <a href="/legal/personal-data-consent"     target="_blank" rel="noreferrer" className="hover:text-zinc-700 underline-offset-2 hover:underline">Согласие</a>
        {' · '}
        <a href="/legal/data-processing-agreement" target="_blank" rel="noreferrer" className="hover:text-zinc-700 underline-offset-2 hover:underline">Поручение ПДн</a>
        {' · '}
        <a href="/legal/referral-program"          target="_blank" rel="noreferrer" className="hover:text-zinc-700 underline-offset-2 hover:underline">Реферальная программа</a>
      </p>

      {isOwner && (
        <div className="text-xs leading-relaxed">
          {requested && effectiveAt ? (
            <div className="text-zinc-600">
              Аккаунт будет удалён{' '}
              <span className="font-medium text-zinc-900">{formatDateRu(effectiveAt)}</span>.{' '}
              <button
                type="button"
                onClick={handleClick}
                disabled={busy}
                className="text-orange-600 hover:text-orange-700 underline underline-offset-2 disabled:opacity-50"
              >
                {busy ? 'Отменяем…' : 'Отменить запрос'}
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={handleClick}
              disabled={busy}
              className="text-zinc-400 hover:text-red-600 underline underline-offset-2 disabled:opacity-50 transition-colors"
            >
              {busy ? 'Отправляем…' : 'Удалить аккаунт'}
            </button>
          )}
          {error && <p className="mt-2 text-red-500">{error}</p>}
        </div>
      )}
    </div>
  );
};
