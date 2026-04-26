import { LucideIcon } from 'lucide-react';
import { LAYOUT_CLASSES } from '@/utils/styleConstants';

interface EmptyStateProps {
  icon?: LucideIcon;
  title: string;
  description?: string;
  action?: {
    label: string;
    onClick: () => void;
    icon?: LucideIcon;
  };
}

/**
 * Компонент для отображения пустого состояния списков
 * 
 * @example
 * <EmptyState 
 *   icon={Search}
 *   title="Клиенты не найдены"
 *   description="Попробуйте изменить параметры поиска"
 * />
 * 
 * @example
 * // С кнопкой действия
 * <EmptyState 
 *   icon={Plus}
 *   title="Нет задач"
 *   description="Начните добавлять задачи"
 *   action={{
 *     label: "Добавить задачу",
 *     onClick: () => setIsAdding(true),
 *     icon: Plus
 *   }}
 * />
 */
export const EmptyState = ({ 
  icon: Icon, 
  title, 
  description,
  action 
}: EmptyStateProps) => {
  return (
    <div className={LAYOUT_CLASSES.emptyState}>
      {Icon && (
        <div className="w-16 h-16 rounded-full bg-zinc-100 flex items-center justify-center mb-4">
          <Icon size={28} className="text-zinc-400" />
        </div>
      )}
      <p className="text-zinc-400 font-bold text-sm mb-1">{title}</p>
      {description && (
        <p className="text-zinc-300 text-sm mt-1 max-w-xs">{description}</p>
      )}
      {action && (
        <button
          onClick={action.onClick}
          className="mt-4 px-6 py-2 bg-black text-white rounded-full font-bold text-sm active:scale-95 transition-all flex items-center gap-2"
        >
          {action.icon && <action.icon size={16} />}
          {action.label}
        </button>
      )}
    </div>
  );
};
