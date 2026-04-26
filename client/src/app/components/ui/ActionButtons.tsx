import { Edit3, Trash2, Eye } from 'lucide-react';

interface ActionButtonsProps {
  onEdit?: () => void;
  onDelete?: () => void;
  onView?: () => void;
  size?: number;
  className?: string;
}

/**
 * Переиспользуемые кнопки действий (Edit, Delete, View)
 * Автоматически предотвращает всплытие событий
 * 
 * @example
 * <ActionButtons onEdit={handleEdit} onDelete={handleDelete} />
 * <ActionButtons onView={handleView} onEdit={handleEdit} size={18} />
 */
export const ActionButtons = ({ 
  onEdit, 
  onDelete, 
  onView,
  size = 16,
  className = ''
}: ActionButtonsProps) => {
  const handleClick = (e: React.MouseEvent, callback: () => void) => {
    e.stopPropagation();
    callback();
  };

  return (
    <div className={`flex gap-1 ml-2 shrink-0 ${className}`}>
      {onView && (
        <button 
          onClick={(e) => handleClick(e, onView)}
          className="p-1.5 text-zinc-400 hover:text-blue-600 transition-colors"
          title="Просмотр"
          type="button"
        >
          <Eye size={size} />
        </button>
      )}
      {onEdit && (
        <button 
          onClick={(e) => handleClick(e, onEdit)}
          className="p-1.5 text-zinc-400 hover:text-orange-600 transition-colors"
          title="Редактировать"
          type="button"
        >
          <Edit3 size={size} />
        </button>
      )}
      {onDelete && (
        <button 
          onClick={(e) => handleClick(e, onDelete)}
          className="p-1.5 text-zinc-400 hover:text-red-600 transition-colors"
          title="Удалить"
          type="button"
        >
          <Trash2 size={size} />
        </button>
      )}
    </div>
  );
};
