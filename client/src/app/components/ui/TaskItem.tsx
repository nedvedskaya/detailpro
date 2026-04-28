import React from 'react';
import { CheckCircle2, Edit3, Trash2 } from 'lucide-react';
import { formatDate, formatTime, getDateStr } from '@/utils/helpers';

interface TaskItemProps {
  task: {
    id: any;
    title?: string;
    date: string;
    time?: string;
    completed?: boolean;
    urgency?: string;
    clientName?: string;
  };
  onToggle: (id: any) => void;
  onDelete?: (id: any) => void;
  onEdit?: (task: any) => void;
  client?: {
    id: any;
    name: string;
  } | null;
  onOpenClient?: (client: any) => void;
}

export const TaskItem: React.FC<TaskItemProps> = ({
  task,
  onToggle,
  onDelete,
  onEdit,
  client,
  onOpenClient
}) => {
  const isOverdue = task.date < getDateStr(0) && !task.completed;
  const isUrgent = task.urgency === 'high';

  // Тап по всему блоку → редактирование задачи (для архивных тапы no-op).
  // Внутренние кнопки (toggle, badge клиента, edit/delete-иконки, «Восстановить»)
  // делают stopPropagation, чтобы тап в них не вылетал в карточку.
  const handleCardClick = () => {
    if (task.completed) return;
    if (onEdit) onEdit(task);
  };
  const stop = (fn: () => void) => (e: React.MouseEvent) => {
    e.stopPropagation();
    fn();
  };

  const cardCls =
    'p-4 rounded-xl border shadow-sm transition-all ' +
    (task.completed
      ? 'bg-zinc-50 border-zinc-200'
      : isOverdue
        ? 'bg-red-50 border-red-200'
        : isUrgent
          ? 'bg-orange-50 border-orange-200'
          : 'bg-white border-zinc-200') +
    (task.completed ? '' : ' cursor-pointer active:scale-[0.99] hover:border-zinc-300');

  return (
    <div className={cardCls} onClick={handleCardClick} role={task.completed ? undefined : 'button'}>
      <div className="flex items-start gap-3">
        <button
          type="button"
          onClick={stop(() => onToggle(task.id))}
          className={`w-6 h-6 rounded-full border-2 flex items-center justify-center shrink-0 mt-0.5 transition-all ${task.completed ? 'bg-green-500 border-green-500 text-white' : 'border-zinc-300 hover:border-zinc-400'}`}
        >
          {task.completed && <CheckCircle2 size={14} />}
        </button>
        <div className="flex-1 min-w-0">
          {(client || task.clientName) && (
            <button
              type="button"
              onClick={stop(() => { if (client && onOpenClient) onOpenClient(client); })}
              className={`text-xs px-2 py-1 rounded-lg font-bold mb-2 inline-block ${
                client
                  ? 'bg-orange-500 text-white hover:bg-orange-600 cursor-pointer'
                  : 'bg-zinc-200 text-zinc-600 cursor-default'
              } transition-colors`}
            >
              {client?.name || task.clientName}
            </button>
          )}
          <p className={`font-bold text-sm ${task.completed ? 'line-through text-zinc-400' : 'text-zinc-900'}`}>
            {task.title}
          </p>
          <div className="flex items-center gap-2 mt-2 flex-wrap">
            <span className={`text-xs ${isOverdue ? 'text-red-500 font-bold' : 'text-zinc-400'}`}>
              {formatDate(task.date)} • {formatTime(task.time)}
            </span>
            {isUrgent && !task.completed && (
              <span className="text-xs bg-orange-500 text-white px-1.5 py-0.5 rounded font-bold">
                СРОЧНО
              </span>
            )}
            {task.completed && (
              <button
                type="button"
                onClick={stop(() => onToggle(task.id))}
                className="text-xs bg-orange-100 text-orange-700 px-2 py-0.5 rounded font-semibold hover:bg-orange-200 transition-colors"
              >
                Восстановить
              </button>
            )}
          </div>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {!task.completed && onEdit && (
            <button
              type="button"
              onClick={stop(() => onEdit(task))}
              className="text-zinc-400 hover:text-zinc-600 p-1"
              aria-label="Редактировать"
            >
              <Edit3 size={16} />
            </button>
          )}
          {onDelete && (
            <button
              type="button"
              onClick={stop(() => onDelete(task.id))}
              className="text-zinc-400 hover:text-red-500 p-1"
              aria-label="Удалить"
            >
              <Trash2 size={16} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
};