/**
 * LoginScreen — две вкладки: «Войти» и «Регистрация студии».
 *
 * Изменения относительно старой версии (Crm-new-main):
 *   - reCAPTCHA удалена (от ботов на сигнап-эндпоинте бэк защищается
 *     на уровне rate-limit + email-уникальности; для логина 5/15мин в памяти).
 *   - Эндпоинты /api/login/.../api/auth/login (см. server/routes/auth.cjs).
 *   - Токен в ответе не возвращается — бэк ставит HttpOnly cookie.
 *   - Появилась регистрация студии (новый flow, в старом моноарендаторе её не было).
 *     Поля: studioName, name (имя владельца), email, password + согласия.
 *
 * Контракт onLogin:
 *   После успешного login/signup передаём объекты user+studio наверх (App.tsx),
 *   чтобы App не делал лишний /api/auth/me.
 */

import { useState, useEffect } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { api } from '@/utils/api';
import { translateApiError } from '@/utils/errorMessages';
import { isValidEmail, PASSWORD_MIN_LENGTH } from '@/utils/validation';
import type { Studio } from '@/utils/types';

interface LoginScreenProps {
  onLogin: (payload: { user: any; studio: Studio }) => void;
}

type Mode = 'login' | 'signup';

export const LoginScreen = ({ onLogin }: LoginScreenProps) => {
  const [mode, setMode] = useState<Mode>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  // signup-поля. Имя/фамилию шлём отдельно (после миграции 001 в saas_meta.users
  // есть first_name/last_name). Для обратной совместимости бэк сам соберёт `name`.
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [studioName, setStudioName] = useState('');
  const [consentPersonalData, setConsentPersonalData] = useState(false);
  const [consentTerms, setConsentTerms] = useState(false);
  // Маркетинговое согласие убрано: рассылок мы не делаем, чекбокс был
  // лишним шумом в форме регистрации (по запросу пользователя 2026-04-27).

  const [error, setError] = useState('');
  // При signup-е поднимается, если бэк ответил email_already_used. Используем
  // отдельно от error, чтобы под текстом ошибки показать «Войти» / «Забыли
  // пароль?» — пользователь не должен переключать вкладки руками.
  const [emailAlreadyUsed, setEmailAlreadyUsed] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [focusedField, setFocusedField] = useState<string | null>(null);
  const [showPassword, setShowPassword] = useState(false);
  const [rememberMe, setRememberMe] = useState(true);

  // Модалка «Забыли пароль?» — отдельное состояние, чтобы не путать с
  // ошибками логина. resetState — это шаги мини-flow:
  //   'idle'        — закрыта
  //   'form'        — открыта форма с email
  //   'submitting'  — отправляем запрос
  //   'sent'        — показали «проверьте Telegram»
  //   'no_channel'  — у юзера нет TG, направляем в поддержку
  const [resetState, setResetState] = useState<'idle' | 'form' | 'submitting' | 'sent' | 'no_channel'>('idle');
  const [resetEmail, setResetEmail] = useState('');
  const [resetError, setResetError] = useState('');

  // TG-токен из ?tg=<token> (сохранён в localStorage в main.tsx). Бот →
  // сайт: бейдж «Telegram @username будет подключён» над формой signup.
  // tgUsername=null если токен валиден, но у TG-юзера нет username.
  const [tgUsername, setTgUsername] = useState<string | null>(null);
  const [tgTokenValid, setTgTokenValid] = useState<boolean>(false);

  useEffect(() => {
    const stored = (() => {
      try { return localStorage.getItem('ugt_tg_signup_token'); } catch (_) { return null; }
    })();
    if (!stored) return;
    let cancelled = false;
    (async () => {
      try {
        const r = await api.getTgSignupToken(stored);
        if (cancelled) return;
        if (r.valid) {
          setTgTokenValid(true);
          setTgUsername(r.tg_username);
          // Если токен валиден — переключаем форму на signup (человек пришёл
          // из бота специально создать аккаунт, нет смысла показывать «Войти»).
          setMode('signup');
        } else {
          // Токен протух / уже потрачен — чистим, чтобы не пытаться слать его
          // на signup и не получать 409.
          try { localStorage.removeItem('ugt_tg_signup_token'); } catch (_) { /* */ }
        }
      } catch (_) { /* network error — молча, показывать форму без бейджа ок */ }
    })();
    return () => { cancelled = true; };
  }, []);

  const openResetForm = () => {
    setResetState('form');
    setResetEmail(email);   // префилл текущего значения
    setResetError('');
  };

  const submitReset = async () => {
    setResetError('');
    const e = resetEmail.trim();
    if (!e || !isValidEmail(e)) {
      setResetError('Введите корректный email');
      return;
    }
    setResetState('submitting');
    try {
      const r = await api.requestPasswordReset(e);
      if (r.delivery === 'no_channel') setResetState('no_channel');
      else setResetState('sent');
    } catch (err: any) {
      // Один частный случай — 429 (слишком часто). Остальное молча в sent,
      // чтобы не выдавать существование email.
      if (err?.status === 429) {
        setResetError('Слишком много попыток. Попробуйте через 15 минут.');
        setResetState('form');
      } else {
        setResetState('sent');
      }
    }
  };

  useEffect(() => {
    // Сохранённый email/«запомнить меня» — только UI-удобство, не auth.
    const savedEmail = localStorage.getItem('ugt_saved_email');
    const savedRememberMe = localStorage.getItem('ugt_remember_me');
    if (savedEmail) setEmail(savedEmail);
    if (savedRememberMe !== null) setRememberMe(savedRememberMe === 'true');
    // На всякий случай: старые версии могли положить пароль — снести.
    localStorage.removeItem('ugt_saved_pass');
  }, []);

  const persistRememberMe = () => {
    if (rememberMe) {
      localStorage.setItem('ugt_saved_email', email);
      localStorage.setItem('ugt_remember_me', 'true');
    } else {
      localStorage.removeItem('ugt_saved_email');
      localStorage.setItem('ugt_remember_me', 'false');
    }
  };

  const handleLogin = async () => {
    if (!email.trim()) return setError('Введите email');
    if (!isValidEmail(email)) return setError('Введите корректный email');
    if (!password) return setError('Введите пароль');
    // Для login используем минимальную проверку — фактическую длину
    // решает бэк. Это просто защита от отправки пустого поля.
    if (password.length < 6) return setError('Пароль должен быть не менее 6 символов');

    setIsLoading(true);
    try {
      const res = await api.login({ email, password, rememberMe });
      persistRememberMe();
      onLogin(res);
    } catch (err) {
      setError(translateApiError(err));
    } finally {
      setIsLoading(false);
    }
  };

  const handleSignup = async () => {
    if (!studioName.trim()) return setError('Введите название студии');
    if (!firstName.trim()) return setError('Введите ваше имя');
    if (!email.trim()) return setError('Введите email');
    if (!isValidEmail(email)) return setError('Введите корректный email');
    if (!password || password.length < PASSWORD_MIN_LENGTH) {
      return setError(`Пароль должен быть не менее ${PASSWORD_MIN_LENGTH} символов`);
    }
    if (!consentPersonalData) {
      return setError('Без согласия на обработку персональных данных регистрация невозможна');
    }
    if (!consentTerms) {
      return setError('Подтвердите согласие с условиями использования');
    }

    setIsLoading(true);
    try {
      // Реферальный код, если пользователь пришёл по ?ref=… (сохранили в main.tsx).
      // Чистим из localStorage сразу после signup — повторно не нужен.
      let referralCode: string | undefined;
      try {
        const stored = localStorage.getItem('ugt_referral_code');
        if (stored) referralCode = stored;
      } catch (_) { /* noop */ }

      // TG-токен из ?tg=… — сценарий «бот → сайт». Бэк линкует TG-аккаунт.
      let tgSignupToken: string | undefined;
      try {
        const stored = localStorage.getItem('ugt_tg_signup_token');
        if (stored) tgSignupToken = stored;
      } catch (_) { /* noop */ }

      const res = await api.signup({
        studioName: studioName.trim(),
        email: email.trim(),
        password,
        firstName: firstName.trim(),
        lastName: lastName.trim() || undefined,
        consents: {
          personal_data: consentPersonalData,
          terms: consentTerms,
        },
        referralCode,
        tgSignupToken,
      });
      try { localStorage.removeItem('ugt_referral_code'); } catch (_) { /* noop */ }
      try { localStorage.removeItem('ugt_tg_signup_token'); } catch (_) { /* noop */ }
      persistRememberMe();
      onLogin(res);
    } catch (err) {
      setError(translateApiError(err));
      // ApiError кладёт error-код бэка в .message (если .code не пришёл).
      // По нему понимаем, надо ли подсказать пользователю «войти/восстановить пароль».
      const apiErr = err as { code?: string; message?: string } | null;
      const errCode = (apiErr?.code || apiErr?.message || '').toString();
      setEmailAlreadyUsed(errCode === 'email_already_used');
    } finally {
      setIsLoading(false);
    }
  };

  const handleSubmit = () => {
    setError('');
    setEmailAlreadyUsed(false);
    if (mode === 'login') return handleLogin();
    return handleSignup();
  };

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') handleSubmit();
  };

  const inputClass = (fieldName: string, errored = false) =>
    `w-full bg-zinc-50 border ${
      focusedField === fieldName
        ? 'border-zinc-900 bg-white'
        : errored
        ? 'border-red-400'
        : 'border-zinc-200'
    } rounded-xl px-4 py-3.5 text-base text-zinc-900 placeholder:text-zinc-400 outline-none transition-all`;

  return (
    <div className="min-h-screen bg-zinc-50 flex flex-col p-6">
      {/* flex-1 + items-center + justify-center: форма забирает всё
          доступное вертикальное пространство и центрируется внутри.
          Футер ниже остаётся плотно у нижнего края экрана. Без этой
          обёртки justify-center на корне выравнивал группу «форма+
          футер» как одно целое, и форма уезжала вверх. */}
      <div className="flex-1 flex flex-col items-center justify-center w-full">
      <div className="w-full max-w-sm">
        <div className="bg-white rounded-2xl shadow-sm border border-zinc-100 p-8">
          <div className="text-center mb-6">
            {/* Заголовок: «Детейл Про» крупно, поверх — мини-бейдж CRM в оранжевой плашке.
                Бейдж абсолютно позиционирован у правого верхнего угла буквы «о», чтобы
                визуально «приклеиться» к названию, как индекс/«superscript». */}
            <h1 className="relative inline-block text-3xl font-semibold text-zinc-900 tracking-tight mb-1">
              Детейл&nbsp;Про
              <span
                aria-label="CRM"
                className="absolute -top-2 -right-7 inline-flex items-center justify-center
                           rounded-md bg-orange-500 px-1.5 py-0.5 text-xs font-bold
                           tracking-wider text-white shadow-sm leading-none"
              >
                CRM
              </span>
            </h1>
            <p className="text-sm text-zinc-500">
              {mode === 'login' ? 'Войдите в систему' : 'Регистрация студии'}
            </p>
          </div>

          {/* Переключатель Войти / Регистрация */}
          <div className="flex bg-zinc-100 rounded-xl p-1 mb-6">
            <button
              type="button"
              onClick={() => { setMode('login'); setError(''); }}
              className={`flex-1 py-2 text-sm font-medium rounded-lg transition-all ${
                mode === 'login' ? 'bg-white text-zinc-900 shadow-sm' : 'text-zinc-500'
              }`}
            >
              Войти
            </button>
            <button
              type="button"
              onClick={() => { setMode('signup'); setError(''); }}
              className={`flex-1 py-2 text-sm font-medium rounded-lg transition-all ${
                mode === 'signup' ? 'bg-white text-zinc-900 shadow-sm' : 'text-zinc-500'
              }`}
            >
              Регистрация
            </button>
          </div>

          {/* Бейдж «Telegram будет подключён» — показываем при заходе с
              ?tg=<token> от бота (сценарий «бот → сайт»). При успешном signup
              бэк автоматически линкует TG к новому аккаунту и шлёт онбординг
              в чат. */}
          {mode === 'signup' && tgTokenValid && (
            <div className="mb-4 px-4 py-3 rounded-xl bg-emerald-50 border border-emerald-200 flex items-start gap-2.5">
              <div className="mt-0.5 w-5 h-5 rounded-full bg-emerald-500 text-white flex items-center justify-center text-[12px] font-bold shrink-0">✓</div>
              <div className="text-[13px] text-emerald-800 font-medium leading-snug">
                {tgUsername
                  ? <>Telegram <span className="font-bold">@{tgUsername}</span> будет подключён к аккаунту автоматически — после регистрации напоминания и сброс пароля сразу заработают.</>
                  : <>Telegram будет подключён к аккаунту автоматически — после регистрации напоминания и сброс пароля сразу заработают.</>
                }
              </div>
            </div>
          )}

          <div className="space-y-4 mb-4">
            {mode === 'signup' && (
              <>
                <input
                  type="text"
                  value={studioName}
                  onChange={(e) => { setStudioName(e.target.value); setError(''); }}
                  onKeyPress={handleKeyPress}
                  onFocus={() => setFocusedField('studioName')}
                  onBlur={() => setFocusedField(null)}
                  placeholder="Название студии"
                  className={inputClass('studioName')}
                  autoComplete="organization"
                />
                <div className="grid grid-cols-2 gap-3">
                  <input
                    type="text"
                    value={firstName}
                    onChange={(e) => { setFirstName(e.target.value); setError(''); }}
                    onKeyPress={handleKeyPress}
                    onFocus={() => setFocusedField('firstName')}
                    onBlur={() => setFocusedField(null)}
                    placeholder="Имя"
                    className={inputClass('firstName')}
                    autoComplete="given-name"
                  />
                  <input
                    type="text"
                    value={lastName}
                    onChange={(e) => { setLastName(e.target.value); setError(''); }}
                    onKeyPress={handleKeyPress}
                    onFocus={() => setFocusedField('lastName')}
                    onBlur={() => setFocusedField(null)}
                    placeholder="Фамилия"
                    className={inputClass('lastName')}
                    autoComplete="family-name"
                  />
                </div>
              </>
            )}

            <input
              type="email"
              value={email}
              onChange={(e) => { setEmail(e.target.value); setError(''); }}
              onKeyPress={handleKeyPress}
              onFocus={() => setFocusedField('email')}
              onBlur={() => setFocusedField(null)}
              placeholder="Email"
              className={inputClass('email', !!error && !email)}
              autoFocus={mode === 'login'}
              autoComplete="email"
            />

            <div className="relative">
              <input
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={(e) => { setPassword(e.target.value); setError(''); }}
                onKeyPress={handleKeyPress}
                onFocus={() => setFocusedField('password')}
                onBlur={() => setFocusedField(null)}
                placeholder={mode === 'signup' ? 'Пароль (мин. 8 символов)' : 'Пароль'}
                className={inputClass('password') + ' pr-12'}
                autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                className="absolute right-4 top-1/2 -translate-y-1/2 text-zinc-400 hover:text-zinc-600 transition-colors"
              >
                {showPassword ? <EyeOff size={20} /> : <Eye size={20} />}
              </button>
            </div>

            {/* Ссылка «Забыли пароль?» — только в режиме входа.
                Восстановление идёт через привязанный TG-бот:
                бэк генерит /reset?token=… и шлёт ссылку в TG. */}
            {mode === 'login' && (
              <div className="text-right">
                <button
                  type="button"
                  onClick={openResetForm}
                  className="text-xs text-zinc-500 hover:text-zinc-900 underline underline-offset-2 transition-colors"
                >
                  Забыли пароль?
                </button>
              </div>
            )}
          </div>

          {/* Согласия — только при регистрации (ФЗ-152) */}
          {mode === 'signup' && (
            <div className="space-y-3 mb-4">
              <Consent
                checked={consentPersonalData}
                onToggle={() => setConsentPersonalData((v) => !v)}
                required
              >
                Я даю согласие на обработку персональных данных в соответствии с{' '}
                <a href="/legal/privacy-policy" className="text-zinc-900 underline" target="_blank" rel="noreferrer">
                  Политикой конфиденциальности
                </a>{' '}
                и{' '}
                <a href="/legal/personal-data-consent" className="text-zinc-900 underline" target="_blank" rel="noreferrer">
                  Согласием
                </a>
              </Consent>
              <Consent
                checked={consentTerms}
                onToggle={() => setConsentTerms((v) => !v)}
                required
              >
                Я принимаю{' '}
                <a href="/legal/offer.html" className="text-zinc-900 underline" target="_blank" rel="noreferrer">
                  Договор-оферту
                </a>
              </Consent>
            </div>
          )}

          {/* Запомнить меня — только в режиме входа */}
          {mode === 'login' && (
            <label className="flex items-center gap-3 cursor-pointer select-none mb-4">
              <div
                onClick={(e) => { e.preventDefault(); setRememberMe(!rememberMe); }}
                className={`w-6 h-6 rounded-lg border-2 flex items-center justify-center transition-all ${
                  rememberMe ? 'bg-zinc-900 border-zinc-900' : 'bg-white border-zinc-300'
                }`}
              >
                {rememberMe && (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="20 6 9 17 4 12"></polyline>
                  </svg>
                )}
              </div>
              <span className="text-sm text-zinc-600 font-medium">Запомнить меня</span>
            </label>
          )}

          {error && <p className="text-sm text-red-500 px-1 mb-3">{error}</p>}

          {emailAlreadyUsed && mode === 'signup' && (
            <div className="mb-3 px-3 py-2 rounded-lg bg-orange-50 border border-orange-200 flex flex-col gap-2">
              <p className="text-xs text-orange-900 leading-snug">
                У вас уже есть аккаунт с этим email. Войдите или восстановите пароль.
              </p>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => { setMode('login'); setError(''); setEmailAlreadyUsed(false); }}
                  className="flex-1 text-xs font-semibold py-2 rounded-md bg-zinc-900 text-white hover:bg-zinc-800"
                >
                  Войти
                </button>
                <button
                  type="button"
                  onClick={() => { setMode('login'); setError(''); setEmailAlreadyUsed(false); openResetForm(); }}
                  className="flex-1 text-xs font-semibold py-2 rounded-md bg-white text-zinc-900 border border-zinc-300 hover:bg-zinc-50"
                >
                  Забыли пароль?
                </button>
              </div>
            </div>
          )}

          <button
            onClick={handleSubmit}
            disabled={isLoading || (mode === 'signup' && (!consentPersonalData || !consentTerms))}
            className={`w-full bg-zinc-900 text-white text-base font-medium py-3.5 rounded-xl transition-all ${
              isLoading || (mode === 'signup' && (!consentPersonalData || !consentTerms)) ? 'opacity-40 cursor-not-allowed' : 'hover:bg-orange-600 active:scale-[0.98]'
            }`}
          >
            {isLoading ? (
              <span className="flex items-center justify-center gap-2">
                <svg className="animate-spin h-5 w-5" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                </svg>
                {mode === 'login' ? 'Вход…' : 'Регистрация…'}
              </span>
            ) : (
              mode === 'login' ? 'Войти' : 'Создать студию'
            )}
          </button>
        </div>

        <p className="mt-6 text-center text-xs text-zinc-400">
          {mode === 'login'
            ? 'Доступ только для авторизованных пользователей'
            : 'После регистрации сразу попадёте в систему. 7 дней бесплатного пробного периода.'}
        </p>
      </div>
      </div>

      {/* Подвал с реквизитами и юридическими ссылками. Рендерится только
          на странице входа/регистрации — внутри CRM (с TabBar) footer
          мешает. По требованию ФЗ-152 ссылка на Политику должна быть
          в общедоступном месте; страница входа подходит идеально. */}
      <footer className="mt-10 mb-6 px-4 text-center text-xs text-zinc-400 leading-relaxed max-w-xl mx-auto">
        <p className="font-semibold text-zinc-600 mb-1">ДЕТЕЙЛ ПРО CRM</p>
        <p>Самозанятый Недведская О. А., ИНН 401110148860</p>
        <p className="mb-3">
          <a href="mailto:nedwedskaya@yandex.ru" className="hover:text-zinc-700">nedwedskaya@yandex.ru</a>
          <span className="mx-1">·</span>
          <a href="tel:+79206101841" className="hover:text-zinc-700">+7 920 610 18 41</a>
        </p>
        {/* Обычные пробелы (НЕ &nbsp;) внутри «Поручение ПДн» /
            «Реферальная программа» позволяют браузеру естественно
            переносить ссылки на новую строку на узких экранах
            (iPhone ≤390px). Точки-разделители «·» сохранены и
            корректно ведут себя при переносе — оказываются в начале
            новой строки если ссылка сместилась. */}
        <p className="leading-relaxed">
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
      </footer>

      {/* Модалка «Забыли пароль?» — рендерится поверх login-карточки. */}
      {resetState !== 'idle' && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center p-4 z-50">
          <div className="w-full max-w-sm bg-white rounded-2xl shadow-lg p-6">
            {resetState === 'form' || resetState === 'submitting' ? (
              <>
                <h2 className="text-xl font-semibold text-zinc-900 mb-2">Восстановление пароля</h2>
                <p className="text-sm text-zinc-500 mb-4">
                  Введите email от вашего аккаунта. Если у вас подключён Telegram-бот,
                  ссылку для смены пароля пришлём в Telegram.
                </p>
                <input
                  type="email"
                  value={resetEmail}
                  onChange={(e) => { setResetEmail(e.target.value); setResetError(''); }}
                  placeholder="Email"
                  disabled={resetState === 'submitting'}
                  className="w-full bg-zinc-50 border border-zinc-200 rounded-xl px-4 py-3 text-base text-zinc-900 placeholder:text-zinc-400 outline-none focus:border-zinc-900 focus:bg-white transition-all disabled:opacity-50"
                  autoFocus
                />
                {resetError && <p className="text-sm text-red-500 mt-2">{resetError}</p>}
                <div className="flex gap-3 mt-4">
                  <button
                    type="button"
                    onClick={() => setResetState('idle')}
                    disabled={resetState === 'submitting'}
                    className="flex-1 py-3 text-sm font-medium rounded-xl border border-zinc-200 text-zinc-600 hover:bg-zinc-50 transition-colors disabled:opacity-50"
                  >
                    Отмена
                  </button>
                  <button
                    type="button"
                    onClick={submitReset}
                    disabled={resetState === 'submitting'}
                    className="flex-1 py-3 text-sm font-medium rounded-xl bg-zinc-900 text-white hover:bg-orange-600 transition-colors disabled:opacity-50"
                  >
                    {resetState === 'submitting' ? 'Отправляем…' : 'Прислать ссылку'}
                  </button>
                </div>
              </>
            ) : resetState === 'sent' ? (
              <>
                <h2 className="text-xl font-semibold text-zinc-900 mb-2">Проверьте Telegram</h2>
                <p className="text-sm text-zinc-600 mb-4">
                  Если у этого аккаунта подключён Telegram-бот, мы прислали туда ссылку
                  для сброса пароля. Она действует 30 минут.
                </p>
                <p className="text-xs text-zinc-400 mb-4">
                  Не приходит сообщение? Возможно, бот не подключён к вашему аккаунту.
                  В этом случае напишите в поддержку — мы поможем сбросить вручную.
                </p>
                <button
                  type="button"
                  onClick={() => setResetState('idle')}
                  className="w-full py-3 text-sm font-medium rounded-xl bg-zinc-900 text-white hover:bg-orange-600 transition-colors"
                >
                  Понятно
                </button>
              </>
            ) : resetState === 'no_channel' ? (
              <>
                <h2 className="text-xl font-semibold text-zinc-900 mb-2">Telegram не подключён</h2>
                <p className="text-sm text-zinc-600 mb-4">
                  У этого аккаунта нет подключённого Telegram-бота, поэтому мы не можем
                  отправить ссылку для сброса автоматически.
                </p>
                <p className="text-sm text-zinc-600 mb-4">
                  Напишите в поддержку — мы сбросим пароль вручную и отправим временный
                  на этот же email.
                </p>
                <button
                  type="button"
                  onClick={() => setResetState('idle')}
                  className="w-full py-3 text-sm font-medium rounded-xl bg-zinc-900 text-white hover:bg-orange-600 transition-colors"
                >
                  Понятно
                </button>
              </>
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
};

// Маленький подкомпонент для чекбокса согласия — чтобы не дублировать разметку.
function Consent({
  checked,
  onToggle,
  required = false,
  children,
}: {
  checked: boolean;
  onToggle: () => void;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className="flex items-start gap-3 cursor-pointer select-none">
      <div
        onClick={(e) => { e.preventDefault(); onToggle(); }}
        className={`mt-0.5 w-5 h-5 flex-shrink-0 rounded border-2 flex items-center justify-center transition-all ${
          checked ? 'bg-zinc-900 border-zinc-900' : 'bg-white border-zinc-300'
        }`}
      >
        {checked && (
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="20 6 9 17 4 12"></polyline>
          </svg>
        )}
      </div>
      <span className="text-xs text-zinc-600 leading-relaxed">
        {children}
        {required && <span className="text-red-500"> *</span>}
      </span>
    </label>
  );
}
