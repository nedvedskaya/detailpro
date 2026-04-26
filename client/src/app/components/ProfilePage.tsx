import { useState, useEffect } from 'react';
import { api } from '@/utils/api';
import { formatDate } from '@/utils/helpers';
import { getRoleName } from '@/utils/constants';

interface ProfileData {
  id: string;
  email: string;
  name: string;
  firstName: string | null;
  lastName: string | null;
  avatar: string | null;
  phone: string | null;
  role: string;
  createdAt: string;
}

interface ProfilePageProps {
  onBack: () => void;
}

const UserIcon = () => (
  <svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/>
    <circle cx="12" cy="7" r="4"/>
  </svg>
);

const ArrowLeftIcon = () => (
  <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M19 12H5M12 19l-7-7 7-7"/>
  </svg>
);

export const ProfilePage = ({ onBack }: ProfilePageProps) => {
  const [profile, setProfile] = useState<ProfileData | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    loadProfile();
  }, []);

  const loadProfile = async () => {
    try {
      setIsLoading(true);
      // SaaS-бэк возвращает {user, studio} через /api/auth/me. Старая модель ProfilePage
      // ждала firstName/lastName/avatar/phone/createdAt — этих полей в новой схеме нет,
      // прокидываем null до тех пор, пока бэк не выставит /api/profile отдельным маршрутом.
      const me = await api.getMe();
      setProfile({
        id: String(me.user.id),
        email: me.user.email,
        name: me.user.name,
        firstName: null,
        lastName: null,
        avatar: null,
        phone: null,
        role: me.user.role,
        createdAt: '',
      });
    } catch (err: any) {
      setError(err.message || 'Ошибка при загрузке профиля');
    } finally {
      setIsLoading(false);
    }
  };

  if (isLoading) {
    return (
      <div className="min-h-screen bg-zinc-50 flex items-center justify-center">
        <div className="animate-spin h-8 w-8 border-2 border-zinc-300 border-t-zinc-900 rounded-full"></div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen bg-zinc-50 flex items-center justify-center p-6">
        <div className="text-center">
          <p className="text-red-500 mb-4">{error}</p>
          <button
            onClick={loadProfile}
            className="text-zinc-900 underline"
          >
            Попробовать снова
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-zinc-50">
      <div className="max-w-lg mx-auto p-6">
        <button
          onClick={onBack}
          className="flex items-center gap-2 text-zinc-500 hover:text-zinc-900 transition-colors mb-8"
        >
          <ArrowLeftIcon />
          <span>Назад</span>
        </button>

        <div className="bg-white rounded-2xl shadow-sm border border-zinc-100 overflow-hidden">
          <div className="p-8 flex flex-col items-center">
            <div className="w-24 h-24 rounded-full bg-zinc-100 flex items-center justify-center mb-6 overflow-hidden">
              {profile?.avatar ? (
                <img 
                  src={profile.avatar} 
                  alt="Аватар" 
                  className="w-full h-full object-cover"
                />
              ) : (
                <div className="text-zinc-400">
                  <UserIcon />
                </div>
              )}
            </div>

            <h1 className="text-xl font-semibold text-zinc-900 mb-1">
              {profile?.firstName || profile?.lastName 
                ? `${profile?.firstName || ''} ${profile?.lastName || ''}`.trim()
                : profile?.name || 'Пользователь'
              }
            </h1>
            
            <span className="inline-flex items-center px-3 py-1 rounded-full text-sm font-medium bg-zinc-100 text-zinc-700 mb-6">
              {getRoleName(profile?.role || 'master')}
            </span>
          </div>

          <div className="border-t border-zinc-100">
            <div className="divide-y divide-zinc-100">
              <div className="px-8 py-4">
                <span className="text-sm text-zinc-400 block mb-1">Email</span>
                <span className="text-zinc-900">{profile?.email}</span>
              </div>

              {profile?.phone && (
                <div className="px-8 py-4">
                  <span className="text-sm text-zinc-400 block mb-1">Телефон</span>
                  <span className="text-zinc-900">{profile.phone}</span>
                </div>
              )}

              {(profile?.firstName || profile?.lastName) && (
                <>
                  {profile?.firstName && (
                    <div className="px-8 py-4">
                      <span className="text-sm text-zinc-400 block mb-1">Имя</span>
                      <span className="text-zinc-900">{profile.firstName}</span>
                    </div>
                  )}
                  {profile?.lastName && (
                    <div className="px-8 py-4">
                      <span className="text-sm text-zinc-400 block mb-1">Фамилия</span>
                      <span className="text-zinc-900">{profile.lastName}</span>
                    </div>
                  )}
                </>
              )}

              <div className="px-8 py-4">
                <span className="text-sm text-zinc-400 block mb-1">Дата регистрации</span>
                <span className="text-zinc-900">{formatDate(profile?.createdAt || '')}</span>
              </div>
            </div>
          </div>
        </div>

        <p className="mt-6 text-center text-xs text-zinc-400">
          Данные профиля заполняются администратором
        </p>
      </div>
    </div>
  );
};
