import React, { ReactNode, useEffect } from 'react';
import { X } from 'lucide-react';

interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  maxWidth?: 'sm' | 'md' | 'lg' | 'xl' | 'full';
  position?: 'center' | 'bottom';
}

export const Modal = ({
  isOpen,
  onClose,
  title,
  children,
  maxWidth = 'md',
  position = 'bottom'
}: ModalProps) => {
  // Пока модалка открыта — выставляем data-атрибут на <body>, чтобы:
  //   1) глобальный CSS прятал нижний TabBar (КЛИЕНТЫ/ЗАДАЧИ/КАЛЕНДАРЬ/ФИНАНСЫ).
  //      На мобильном bottom-sheet занимает 90vh, и TabBar (z:250) перекрывал
  //      нижние кнопки формы (Сохранить / Скачать PDF / Закрыть) — у юзера
  //      на скрине это «срезанные» кнопки в приёмке авто и заказ-наряде.
  //      Modal стоит на z:260, на десктопе перекрывает TabBar нормально, но
  //      на iOS Safari при коллапсе адресной строки и нестабильной visual
  //      viewport-высоте — TabBar просвечивает. Прячем явно.
  //   2) при необходимости можно скрыть и другие fixed-элементы (sticky toast и
  //      т.п.) тем же селектором.
  // Используем data-attribute, а не class, чтобы вложенные модалки и подсветка
  // в DevTools не путали состояние.
  useEffect(() => {
    if (!isOpen) return;
    // Счётчик, чтобы вложенные модалки (например, picker внутри WorkOrderForm)
    // не сбрасывали атрибут раньше времени, когда внешняя ещё открыта.
    const prev = Number(document.body.dataset.modalOpenCount || '0');
    document.body.dataset.modalOpenCount = String(prev + 1);
    document.body.dataset.modalOpen = 'true';
    return () => {
      const n = Number(document.body.dataset.modalOpenCount || '1') - 1;
      if (n <= 0) {
        delete document.body.dataset.modalOpen;
        delete document.body.dataset.modalOpenCount;
      } else {
        document.body.dataset.modalOpenCount = String(n);
      }
    };
  }, [isOpen]);

  if (!isOpen) return null;

  const maxWidthClasses = {
    sm: 'max-w-sm',
    md: 'max-w-md',
    lg: 'max-w-lg',
    xl: 'max-w-xl',
    full: 'max-w-full',
  };

  const positionClasses = position === 'bottom'
    ? 'items-end'
    : 'items-center justify-center';

  const containerClasses = position === 'bottom'
    ? 'w-full rounded-t-[32px] pb-32'
    : `${maxWidthClasses[maxWidth]} rounded-3xl`;

  // На десктопе bottom-sheet превращаем в центрированный диалог: класс
  // .desktop-sheet-center перебивает items-end и ужимает контейнер по ширине.
  // На мобильной версии действуют только мобильные правила.
  const desktopOverride = position === 'bottom' ? 'desktop-sheet-center' : '';

  return (
    <div
      // z-[260]: выше нижнего таб-бара (z-[250] в App.tsx), иначе таб-бар
      // перекрывает кнопку «Закрыть» внизу модалки и тапы по ней не доходят.
      className={`fixed inset-0 z-[260] bg-zinc-900/50 backdrop-blur-sm flex ${positionClasses} ${desktopOverride} animate-in fade-in`}
      onClick={onClose}
    >
      <div
        // overscroll-contain + WebkitOverflowScrolling — чтобы скролл работал на iOS
        // и не «цеплял» страницу под модалкой.
        className={`${containerClasses} bg-white p-6 shadow-2xl max-h-[90vh] overflow-y-auto overscroll-contain`}
        style={{ WebkitOverflowScrolling: 'touch' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex justify-between items-center mb-6">
          <h3 className="text-2xl font-black">{title}</h3>
          <button 
            onClick={onClose} 
            className="bg-zinc-100 p-3 rounded-full hover:bg-zinc-200 transition-colors min-w-[44px] min-h-[44px] flex items-center justify-center"
          >
            <X size={22} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
};
