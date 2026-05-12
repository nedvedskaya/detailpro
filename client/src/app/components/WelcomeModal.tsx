import React from 'react';
import { Modal } from '@/app/components/ui/Modal';
import { Car, Calendar, FileText, BarChart2, Users, Bell } from 'lucide-react';

const FEATURES = [
  { icon: Calendar, text: 'Клиенты, записи и календарь — всё в одном месте, без таблиц и заметок' },
  { icon: Car, text: 'Электронная приёмка авто: фото, состояние кузова по зонам, подпись клиента' },
  { icon: FileText, text: 'Заказ-наряды по прайсу студии: скачал, распечатал, отдал клиенту' },
  { icon: BarChart2, text: 'Финансы, выручка, аналитика — все цифры сразу, без Excel' },
  { icon: Users, text: 'До 3 пользователей: собственник, менеджер, мастер — у каждого свои права' },
  { icon: Bell, text: 'Бот-помощник: сам отправляет напоминания о записях и задачах' },
];

const STORAGE_KEY = 'ugt_welcome_shown';

interface WelcomeModalProps {
  isOpen: boolean;
  tgLinked?: boolean;
  onClose: () => void;
  onConnectTelegram: () => void;
}

export const WelcomeModal = ({ isOpen, tgLinked, onClose, onConnectTelegram }: WelcomeModalProps) => {
  const handleStart = () => {
    try { localStorage.setItem(STORAGE_KEY, 'true'); } catch (_) {}
    onClose();
  };

  const handleConnectTg = () => {
    try { localStorage.setItem(STORAGE_KEY, 'true'); } catch (_) {}
    onConnectTelegram();
  };

  return (
    <Modal isOpen={isOpen} onClose={handleStart} title="Добро пожаловать в Детейл Про" maxWidth="md" position="bottom">
      <div className="space-y-4">
        <p className="text-sm text-zinc-500">Вот что умеет ваша CRM:</p>
        <ul className="space-y-3">
          {FEATURES.map(({ icon: Icon, text }) => (
            <li key={text} className="flex items-start gap-3">
              <span className="mt-0.5 flex-shrink-0 w-7 h-7 rounded-lg bg-orange-50 flex items-center justify-center">
                <Icon size={15} className="text-orange-500" />
              </span>
              <span className="text-sm text-zinc-700 leading-snug">{text}</span>
            </li>
          ))}
        </ul>
        <div className="pt-2 space-y-2">
          {!tgLinked && (
            <button
              onClick={handleConnectTg}
              className="w-full py-3 rounded-xl text-sm font-medium bg-zinc-100 text-zinc-800 hover:bg-zinc-200 transition-colors"
            >
              Подключить Telegram-бот
            </button>
          )}
          <button
            onClick={handleStart}
            className="w-full py-3 rounded-xl text-sm font-medium bg-zinc-900 text-white hover:bg-zinc-800 transition-colors"
          >
            Начать работу
          </button>
        </div>
      </div>
    </Modal>
  );
};

export function shouldShowWelcome(): boolean {
  try { return localStorage.getItem(STORAGE_KEY) !== 'true'; } catch (_) { return false; }
}
