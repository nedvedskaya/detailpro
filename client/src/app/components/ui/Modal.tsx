import React, { ReactNode, useEffect } from 'react';
import { Overlay } from './Overlay';
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

  // Закрытие по Esc (a11y / WCAG). Для вложенных модалок проверяем, что
  // эта — самая внешняя из открытых на текущий момент: если есть
  // child-modal, Esc должен закрывать только её, а не нашу. Делаем это
  // через capture+stopPropagation в child'е, либо просто через сравнение
  // счётчика — но вложенный кейс редкий, проще: всегда закрываем верхнюю.
  // На практике у нас не больше одной модалки одновременно (picker внутри
  // WorkOrderForm — отдельный bottom-sheet, не Modal-компонент).
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const maxWidthClasses = {
    sm: 'max-w-sm',
    md: 'max-w-md',
    lg: 'max-w-lg',
    xl: 'max-w-xl',
    full: 'max-w-full',
  };

  const containerClasses = position === 'bottom'
    ? 'w-full rounded-t-[32px] pb-32'
    : `${maxWidthClasses[maxWidth]} rounded-3xl`;

  return (
    <Overlay
      zIndex={260}
      align={position === 'bottom' ? 'bottom' : 'center'}
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
    </Overlay>
  );
};
