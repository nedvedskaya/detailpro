import React, { useState, useEffect } from 'react';
import { LogOut, User, Settings, ChevronDown, BookOpen } from 'lucide-react';
import { getUser, getStudio, logout } from '@/utils/auth';
import { isAdmin } from '@/utils/permissions';

interface UserMenuProps {
  onLogout: () => void;
  onShowProfile?: () => void;
  onShowAdmin?: () => void;
  // Открывает раздел «Материалы» — пока заглушка «в разработке»,
  // позже там магазин допматериалов (технокарты, чек-листы и т.п.).
  // Доступно всем юзерам, без гейтинга по роли — каждый сотрудник
  // студии может почитать что планируется.
  onShowMaterials?: () => void;
  networkIndicator?: React.ReactNode;
}

function formatAccessUntil(value: string | null | undefined): { label: string; tone: 'ok' | 'warn' | 'danger' } | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const now = new Date();
  const msInDay = 24 * 60 * 60 * 1000;
  const days = Math.ceil((date.getTime() - now.getTime()) / msInDay);
  const label = date.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' });
  if (days < 0) return { label: `Подписка истекла ${label}`, tone: 'danger' };
  if (days <= 3) return { label: `Подписка до ${label}`, tone: 'danger' };
  if (days <= 7) return { label: `Подписка до ${label}`, tone: 'warn' };
  return { label: `Подписка до ${label}`, tone: 'ok' };
}

const AVATAR_CACHE_KEY = 'ugt_avatar_path';

export const UserMenu = ({ onLogout, onShowProfile, onShowAdmin, onShowMaterials, networkIndicator }: UserMenuProps) => {
  const user = getUser();
  const studio = getStudio();
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [avatarLoaded, setAvatarLoaded] = useState(false);

  // Кэшируем avatarPath в sessionStorage — при следующей загрузке
  // браузер уже имеет картинку в HTTP-кэше и показывает её мгновенно.
  useEffect(() => {
    if (user?.avatarPath) {
      try { sessionStorage.setItem(AVATAR_CACHE_KEY, user.avatarPath); } catch {}
      // Предзагрузка: создаём Image объект чтобы браузер закэшировал
      const img = new Image();
      img.src = user.avatarPath;
    }
  }, [user?.avatarPath]);

  if (!user) return null;

  const subscription = formatAccessUntil((studio as any)?.accessUntil ?? (studio as any)?.access_until);
  const subscriptionToneClass =
    subscription?.tone === 'danger'
      ? 'bg-red-50 text-red-700 border-red-200'
      : subscription?.tone === 'warn'
      ? 'bg-amber-50 text-amber-700 border-amber-200'
      : 'bg-emerald-50 text-emerald-700 border-emerald-200';

  const handleLogout = async () => {
    if (confirm('Вы уверены, что хотите выйти?')) {
      await logout();
      onLogout();
    }
  };

  const userIsAdmin = isAdmin(user.role as any);

  return (
    /* paddingTop = max(safe-area-inset-top, 8px) — раньше safe-area висел
       на body, но это ломало scroll-цепочку (см. App.tsx и mobile.css).
       Теперь top-safe-area отрисовывается тут, ниже notch / Dynamic Island. */
    <div
      className="bg-white border-b border-zinc-200 px-4 pb-2 relative shrink-0"
      style={{ paddingTop: 'max(env(safe-area-inset-top, 0px), 8px)' }}
    >
      <div className="flex items-center justify-between">
        <button
          onClick={() => setIsMenuOpen(!isMenuOpen)}
          className="flex items-center gap-2 hover:bg-zinc-50 px-2 py-1.5 rounded-lg transition-all"
        >
          {/* Маленький аватар. Если файла нет — кружок-инициал. nginx /avatars/
              кеширует 1д, поэтому добавляем ?v=lastLoginAt|createdAt для обхода
              кэша при смене аватара (после нового входа /me возвращает свежий
              avatar_path; ?v= меняется и браузер запрашивает заново). */}
          <div className="relative w-6 h-6 shrink-0">
            <div className={`w-6 h-6 rounded-full bg-zinc-200 text-zinc-600 text-xs font-bold flex items-center justify-center absolute inset-0 transition-opacity duration-200 ${avatarLoaded ? 'opacity-0' : 'opacity-100'}`}>
              {(user.name || user.email || '?').charAt(0).toUpperCase()}
            </div>
            {user.avatarPath && (
              <img
                src={`${user.avatarPath}?v=${user.createdAt || ''}`}
                alt=""
                onLoad={() => setAvatarLoaded(true)}
                onError={() => setAvatarLoaded(false)}
                className={`w-6 h-6 rounded-full object-cover absolute inset-0 transition-opacity duration-200 ${avatarLoaded ? 'opacity-100' : 'opacity-0'}`}
              />
            )}
          </div>
          <div className="text-xs font-bold text-zinc-900 truncate max-w-[140px]">
            {user.name || user.email}
          </div>
          <ChevronDown
            size={14}
            className={`text-zinc-400 transition-transform ${isMenuOpen ? 'rotate-180' : ''}`}
          />
        </button>
        {networkIndicator}
      </div>

      {isMenuOpen && (
        <>
          <div 
            className="fixed inset-0 z-40" 
            onClick={() => setIsMenuOpen(false)}
          />
          
          <div className="absolute top-full left-4 mt-1 bg-white rounded-xl shadow-xl border border-zinc-200 overflow-hidden z-50 animate-in fade-in slide-in-from-top-2 min-w-[220px]">
            {studio && (
              <div className="px-4 py-3 border-b border-zinc-100">
                <div className="text-[11px] font-medium text-zinc-500 uppercase tracking-wide">Студия</div>
                <div className="text-sm font-semibold text-zinc-900 truncate">{studio.displayName || studio.name}</div>

              </div>
            )}
            {onShowProfile && (
              <button
                onClick={() => {
                  setIsMenuOpen(false);
                  onShowProfile();
                }}
                className="w-full flex items-center gap-3 px-4 py-3 hover:bg-zinc-50 transition-colors group border-b border-zinc-100"
              >
                <User size={16} className="text-zinc-600" />
                <span className="text-sm font-medium text-zinc-700">
                  Профиль
                </span>
              </button>
            )}
            {userIsAdmin && onShowAdmin && (
              <button
                onClick={() => {
                  setIsMenuOpen(false);
                  onShowAdmin();
                }}
                className="w-full flex items-center gap-3 px-4 py-3 hover:bg-zinc-50 transition-colors group border-b border-zinc-100"
              >
                <Settings size={16} className="text-zinc-600" />
                <span className="text-sm font-medium text-zinc-700">
                  Админ-панель
                </span>
              </button>
            )}
            {onShowMaterials && (
              <button
                onClick={() => {
                  setIsMenuOpen(false);
                  onShowMaterials();
                }}
                className="w-full flex items-center gap-3 px-4 py-3 hover:bg-zinc-50 transition-colors group border-b border-zinc-100"
              >
                <BookOpen size={16} className="text-zinc-600" />
                <span className="text-sm font-medium text-zinc-700">
                  Материалы
                </span>
              </button>
            )}
            <button
              onClick={() => {
                setIsMenuOpen(false);
                handleLogout();
              }}
              className="w-full flex items-center gap-3 px-4 py-3 hover:bg-red-50 transition-colors group"
            >
              <LogOut size={16} className="text-zinc-600 group-hover:text-red-600 transition-colors" />
              <span className="text-sm font-medium text-zinc-700 group-hover:text-red-600 transition-colors">
                Выйти
              </span>
            </button>
          </div>
        </>
      )}
    </div>
  );
};
