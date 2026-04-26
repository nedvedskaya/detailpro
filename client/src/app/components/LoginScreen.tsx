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
import { api, ApiError } from '@/utils/api';
import type { Studio } from '@/utils/types';

interface LoginScreenProps {
  onLogin: (payload: { user: any; studio: Studio }) => void;
}

type Mode = 'login' | 'signup';

export const LoginScreen = ({ onLogin }: LoginScreenProps) => {
  const [mode, setMode] = useState<Mode>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');           // только для signup
  const [studioName, setStudioName] = useState(''); // только для signup
  const [consentPersonalData, setConsentPersonalData] = useState(false);
  const [consentTerms, setConsentTerms] = useState(false);
  const [consentMarketing, setConsentMarketing] = useState(false);

  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [focusedField, setFocusedField] = useState<string | null>(null);
  const [showPassword, setShowPassword] = useState(false);
  const [rememberMe, setRememberMe] = useState(true);

  useEffect(() => {
    // Сохранённый email/«запомнить меня» — только UI-удобство, не auth.
    const savedEmail = localStorage.getItem('ugt_saved_email');
    const savedRememberMe = localStorage.getItem('ugt_remember_me');
    if (savedEmail) setEmail(savedEmail);
    if (savedRememberMe !== null) setRememberMe(savedRememberMe === 'true');
    // На всякий случай: старые версии могли положить пароль — снести.
    localStorage.removeItem('ugt_saved_pass');
  }, []);

  const validateEmail = (v: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);

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
    if (!validateEmail(email)) return setError('Введите корректный email');
    if (!password) return setError('Введите пароль');
    if (password.length < 6) return setError('Пароль должен быть не менее 6 символов');

    setIsLoading(true);
    try {
      const res = await api.login({ email, password });
      persistRememberMe();
      onLogin(res);
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : 'Ошибка соединения с сервером';
      setError(msg);
    } finally {
      setIsLoading(false);
    }
  };

  const handleSignup = async () => {
    if (!studioName.trim()) return setError('Введите название студии');
    if (!name.trim()) return setError('Введите ваше имя');
    if (!email.trim()) return setError('Введите email');
    if (!validateEmail(email)) return setError('Введите корректный email');
    if (!password || password.length < 8) {
      return setError('Пароль должен быть не менее 8 символов');
    }
    if (!consentPersonalData) {
      return setError('Без согласия на обработку персональных данных регистрация невозможна');
    }
    if (!consentTerms) {
      return setError('Подтвердите согласие с условиями использования');
    }

    setIsLoading(true);
    try {
      const res = await api.signup({
        studioName: studioName.trim(),
        email: email.trim(),
        password,
        name: name.trim(),
        consents: {
          personal_data: consentPersonalData,
          terms: consentTerms,
          marketing: consentMarketing,
        },
      });
      persistRememberMe();
      onLogin(res);
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : 'Ошибка соединения с сервером';
      setError(msg);
    } finally {
      setIsLoading(false);
    }
  };

  const handleSubmit = () => {
    setError('');
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
    <div className="min-h-screen bg-zinc-50 flex items-center justify-center p-6">
      <div className="w-full max-w-sm">
        <div className="bg-white rounded-2xl shadow-sm border border-zinc-100 p-8">
          <div className="text-center mb-6">
            <h1 className="text-2xl font-semibold text-zinc-900 tracking-tight mb-1">
              SaaS CRM
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
                <input
                  type="text"
                  value={name}
                  onChange={(e) => { setName(e.target.value); setError(''); }}
                  onKeyPress={handleKeyPress}
                  onFocus={() => setFocusedField('name')}
                  onBlur={() => setFocusedField(null)}
                  placeholder="Ваше имя"
                  className={inputClass('name')}
                  autoComplete="name"
                />
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
                </a>
              </Consent>
              <Consent
                checked={consentTerms}
                onToggle={() => setConsentTerms((v) => !v)}
                required
              >
                Я принимаю{' '}
                <a href="/legal/terms" className="text-zinc-900 underline" target="_blank" rel="noreferrer">
                  условия использования
                </a>
              </Consent>
              <Consent
                checked={consentMarketing}
                onToggle={() => setConsentMarketing((v) => !v)}
              >
                Согласен получать новости и обновления продукта на email (необязательно)
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

          <button
            onClick={handleSubmit}
            disabled={isLoading}
            className={`w-full bg-zinc-900 text-white text-base font-medium py-3.5 rounded-xl transition-all ${
              isLoading ? 'opacity-70 cursor-not-allowed' : 'hover:bg-zinc-800 active:scale-[0.98]'
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
            : 'После регистрации сразу попадёте в систему. 14 дней пробного периода.'}
        </p>
      </div>
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
