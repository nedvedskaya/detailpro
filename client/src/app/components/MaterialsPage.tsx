/**
 * MaterialsPage — раздел «Материалы». В будущем — магазин внутри СРМ:
 * технологические карты, чек-листы, шаблоны заказ-нарядов и иные
 * материалы для детейлинг-студий, доступные за дополнительную плату.
 *
 * Сейчас раздел пустой — показываем заглушку «в разработке», чтобы
 * юзеры видели что фича скоро появится. Никаких API-запросов не делает.
 *
 * Пункт меню добавлен в UserMenu.tsx, маршрут /materials заведён в App.tsx
 * по той же схеме, что /profile и /admin.
 */

import { ChevronLeft, Wrench } from 'lucide-react';

interface MaterialsPageProps {
  onBack: () => void;
}

export const MaterialsPage = ({ onBack }: MaterialsPageProps) => {
  return (
    <div
      className="fixed inset-0 bg-zinc-50 overflow-y-auto"
      style={{
        // safe-area-inset-top — отступ под notch / Dynamic Island на iPhone.
        paddingTop: 'max(env(safe-area-inset-top, 0px), 0px)',
      }}
    >
      {/* Шапка с кнопкой «Назад» — повторяет паттерн ProfilePage / AdminPanel
          для единого UX. */}
      <div className="bg-white border-b border-zinc-200 px-4 py-3 sticky top-0 z-10">
        <button
          onClick={onBack}
          className="flex items-center gap-1.5 text-sm font-medium text-zinc-600 hover:text-zinc-900 transition-colors"
        >
          <ChevronLeft size={18} />
          Назад
        </button>
      </div>

      <div className="max-w-md mx-auto px-4 py-12">
        <div className="bg-white rounded-2xl shadow-sm border border-zinc-100 p-8 text-center">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-orange-50 text-orange-500 mb-4">
            <Wrench size={28} />
          </div>
          <h1 className="text-2xl font-black text-zinc-900 mb-3">
            Материалы
          </h1>
          <p className="text-sm text-zinc-500 mb-6 leading-relaxed">
            Раздел в разработке. Скоро здесь появятся дополнительные
            технологические карты, чек-листы для приёмки авто, шаблоны
            заказ-нарядов и другие материалы для детейлинг-студий.
          </p>
          <div className="inline-block px-4 py-2 rounded-xl bg-orange-50 text-orange-700 text-xs font-medium">
            Будет доступно в ближайшее время
          </div>
        </div>
      </div>
    </div>
  );
};
