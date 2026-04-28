/**
 * /reset?token=... — установка нового пароля по токену.
 *
 * Пользователь попадает сюда из ссылки в Telegram-сообщении, которую
 * сгенерил бэк после `POST /api/auth/password-reset/request`.
 *
 * Состояния:
 *   - no_token   — пользователь зашёл на /reset без token=
 *   - form       — форма «новый пароль / повтор»
 *   - submitting — отправляем
 *   - done       — успех, через 2 сек редирект на /
 *   - invalid    — token не найден / просрочен / уже использован
 *
 * После успешного reset бэк уже создал свежую сессию (cookie), поэтому
 * редирект на «/» сразу попадает в авторизованный CRM, не на /login.
 */

import { useState, useEffect } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { api } from '@/utils/api';
import { translateApiError } from '@/utils/errorMessages';
import { PASSWORD_MIN_LENGTH } from '@/utils/validation';

type State = 'no_token' | 'form' | 'submitting' | 'done' | 'invalid';

export const ResetPasswordPage = () => {
  // token берём из URL один раз, дальше он живёт только в локальном замыкании.
  // НЕ кладём в state — иначе при ре-рендере замигает /reset?token=… в адресной
  // строке после успеха (мы делаем replaceState).
  const [token] = useState(() => {
    try {
      const params = new URLSearchParams(window.location.search);
      return params.get('token') || '';
    } catch (_) { return ''; }
  });

  const [state, setState] = useState<State>(() => (token ? 'form' : 'no_token'));
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');

  // После done — через 2 сек редирект на /. Делаем replaceState чтобы /reset
  // не висел в истории (Back не должен возвращать на «pas changed»-страницу).
  useEffect(() => {
    if (state !== 'done') return;
    const t = setTimeout(() => {
      window.history.replaceState({}, '', '/');
      window.location.href = '/';
    }, 2000);
    return () => clearTimeout(t);
  }, [state]);

  const submit = async () => {
    setError('');
    if (!password || password.length < PASSWORD_MIN_LENGTH) {
      setError(`Пароль должен быть не менее ${PASSWORD_MIN_LENGTH} символов`);
      return;
    }
    if (password !== confirm) {
      setError('Пароли не совпадают');
      return;
    }
    setState('submitting');
    try {
      await api.confirmPasswordReset(token, password);
      setState('done');
    } catch (err: any) {
      // Серверные коды: invalid_token / token_used / token_expired / password_too_short
      const code = err?.body?.error || err?.error;
      if (code === 'invalid_token' || code === 'token_used' || code === 'token_expired') {
        setState('invalid');
      } else {
        setError(translateApiError(err));
        setState('form');
      }
    }
  };

  return (
    <div className="min-h-screen bg-zinc-50 flex items-center justify-center p-6">
      <div className="w-full max-w-sm">
        <div className="bg-white rounded-2xl shadow-sm border border-zinc-100 p-8">
          <div className="text-center mb-6">
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
            <p className="text-sm text-zinc-500">Новый пароль</p>
          </div>

          {state === 'no_token' && (
            <>
              <p className="text-sm text-zinc-600 mb-4">
                Ссылка некорректная. Откройте её ещё раз из сообщения в Telegram —
                либо запросите новую через «Забыли пароль?» на странице входа.
              </p>
              <a
                href="/"
                className="block w-full text-center py-3 text-sm font-medium rounded-xl bg-zinc-900 text-white hover:bg-orange-600 transition-colors"
              >
                На страницу входа
              </a>
            </>
          )}

          {state === 'invalid' && (
            <>
              <p className="text-sm text-zinc-600 mb-4">
                Эта ссылка больше не действует — она просрочена (живёт 30 минут)
                или уже была использована.
              </p>
              <p className="text-sm text-zinc-600 mb-4">
                Запросите новую ссылку через «Забыли пароль?» на странице входа.
              </p>
              <a
                href="/"
                className="block w-full text-center py-3 text-sm font-medium rounded-xl bg-zinc-900 text-white hover:bg-orange-600 transition-colors"
              >
                На страницу входа
              </a>
            </>
          )}

          {state === 'done' && (
            <>
              <p className="text-sm text-emerald-700 mb-4">
                Пароль изменён. Сейчас перенаправим вас в CRM…
              </p>
            </>
          )}

          {(state === 'form' || state === 'submitting') && (
            <>
              <div className="space-y-4 mb-4">
                <div className="relative">
                  <input
                    type={showPassword ? 'text' : 'password'}
                    value={password}
                    onChange={(e) => { setPassword(e.target.value); setError(''); }}
                    onKeyPress={(e) => e.key === 'Enter' && submit()}
                    placeholder="Новый пароль"
                    disabled={state === 'submitting'}
                    autoFocus
                    autoComplete="new-password"
                    className="w-full bg-zinc-50 border border-zinc-200 rounded-xl px-4 py-3.5 pr-12 text-base text-zinc-900 placeholder:text-zinc-400 outline-none focus:border-zinc-900 focus:bg-white transition-all disabled:opacity-50"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    className="absolute right-4 top-1/2 -translate-y-1/2 text-zinc-400 hover:text-zinc-600 transition-colors"
                  >
                    {showPassword ? <EyeOff size={20} /> : <Eye size={20} />}
                  </button>
                </div>
                <input
                  type={showPassword ? 'text' : 'password'}
                  value={confirm}
                  onChange={(e) => { setConfirm(e.target.value); setError(''); }}
                  onKeyPress={(e) => e.key === 'Enter' && submit()}
                  placeholder="Повторите пароль"
                  disabled={state === 'submitting'}
                  autoComplete="new-password"
                  className="w-full bg-zinc-50 border border-zinc-200 rounded-xl px-4 py-3.5 text-base text-zinc-900 placeholder:text-zinc-400 outline-none focus:border-zinc-900 focus:bg-white transition-all disabled:opacity-50"
                />
                <p className="text-xs text-zinc-400 px-1">
                  Не менее {PASSWORD_MIN_LENGTH} символов
                </p>
              </div>

              {error && <p className="text-sm text-red-500 px-1 mb-3">{error}</p>}

              <button
                type="button"
                onClick={submit}
                disabled={state === 'submitting'}
                className={`w-full py-3.5 text-base font-medium rounded-xl text-white transition-all ${
                  state === 'submitting'
                    ? 'bg-zinc-900 opacity-70 cursor-not-allowed'
                    : 'bg-zinc-900 hover:bg-orange-600 active:scale-[0.98]'
                }`}
              >
                {state === 'submitting' ? 'Сохраняем…' : 'Установить пароль'}
              </button>
            </>
          )}
        </div>

        <p className="mt-6 text-center text-xs text-zinc-400">
          Если ссылку прислал не наш бот — закройте страницу.
        </p>
      </div>
    </div>
  );
};

export default ResetPasswordPage;
