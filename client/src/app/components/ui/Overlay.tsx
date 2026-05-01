import React, { ReactNode } from 'react';

// Голый overlay-фон для модалок и нижних шторок.
//
// Объединяет повторяющиеся inline-классы из FinanceView/CalendarView/App/Modal:
//   `<position> inset-0 z-[N] bg-zinc-900/X backdrop-blur-sm flex <align> animate-in fade-in`
//
// Используй его как обёртку: внутри положи белый контейнер контента со
// своим onClick={(e) => e.stopPropagation()}, а на сам Overlay повесь
// onClick={() => закрыть}.
//
// Если изменишь блюр / opacity / animation — все модалки получат изменение
// разом, без беготни по 4-5 файлам.

export interface OverlayProps {
  /** fixed (default) или absolute — для случаев когда overlay внутри
   *  ограниченного контейнера, как в CalendarView. */
  position?: 'fixed' | 'absolute';
  /** Z-index слоя. По умолчанию 260 — выше TabBar (z-250).
   *  Используй 300+ для блокирующих экранов, 400+ для critical confirm. */
  zIndex?: number;
  /** bottom — нижняя шторка (mobile bottom-sheet, на десктопе центрируется
   *  через .desktop-sheet-center), center — обычный диалог. */
  align?: 'bottom' | 'center';
  /** Затемнение фона. Значения завязаны на готовые классы tailwind, чтобы
   *  они попали в production-bundle (Tailwind не подхватывает динамические
   *  arbitrary values из шаблонных строк). */
  darkness?: 40 | 50 | 70 | 80;
  /** Дополнительные классы — например свой animate-in вариант. */
  className?: string;
  /** Хендлер клика по фону (обычно — закрыть модалку). */
  onClick?: () => void;
  children: ReactNode;
}

const DARKNESS_CLASS: Record<number, string> = {
  40: 'bg-zinc-900/40',
  50: 'bg-zinc-900/50',
  70: 'bg-zinc-900/70',
  80: 'bg-zinc-900/80',
};

export const Overlay = ({
  position = 'fixed',
  zIndex = 260,
  align = 'bottom',
  darkness = 50,
  className = '',
  onClick,
  children,
}: OverlayProps) => {
  const alignClass = align === 'bottom'
    ? 'items-end desktop-sheet-center'
    : 'items-center justify-center';

  const darknessClass = DARKNESS_CLASS[darkness] || DARKNESS_CLASS[50];

  return (
    <div
      className={`${position} inset-0 ${darknessClass} backdrop-blur-sm flex ${alignClass} animate-in fade-in ${className}`}
      style={{ zIndex }}
      onClick={onClick}
    >
      {children}
    </div>
  );
};
