import { Clock, Calendar, AlertOctagon, Circle, User } from 'lucide-react';
import { FormField } from './FormField';

interface StudioMember {
  id: string;
  name: string;
  role?: string;
  is_active?: boolean;
}

interface TaskFormFieldsProps {
  taskData: {
    title: string;
    date: string;
    time: string;
    isUrgent: boolean;
    assigned_to?: string | null;
  };
  onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => void;
  onToggleUrgent: () => void;
  users?: StudioMember[];
}

export const TaskFormFields = ({
  taskData,
  onChange,
  onToggleUrgent,
  users
}: TaskFormFieldsProps) => {
  return (
    <div className="space-y-3">
      <FormField
        label="Название задачи"
        name="title"
        type="text"
        value={taskData.title}
        onChange={onChange as any}
        placeholder="Например: Позвонить клиенту"
        required
      />

      <div className="grid grid-cols-2 gap-3">
        <FormField
          label="Дата"
          name="date"
          type="date"
          value={taskData.date}
          onChange={onChange as any}
          icon={Calendar}
          required
        />

        <FormField
          label="Время"
          name="time"
          type="time"
          value={taskData.time}
          onChange={onChange as any}
          icon={Clock}
        />
      </div>

      {users && users.length > 0 && (
        <div>
          <label className="text-xs text-zinc-500 font-semibold block mb-1.5 flex items-center gap-1.5">
            <User size={12} />
            Исполнитель
          </label>
          <select
            name="assigned_to"
            value={taskData.assigned_to ?? ''}
            onChange={onChange}
            className="w-full bg-white border border-zinc-300 rounded-xl p-3 text-sm font-medium text-black outline-none focus:border-black shadow-sm"
          >
            <option value="">Не назначен</option>
            {users
              .filter(u => u.is_active !== false)
              .map(u => (
                <option key={u.id} value={u.id}>{u.name}</option>
              ))}
          </select>
        </div>
      )}

      {/* Кнопка срочности */}
      <button
        type="button"
        onClick={onToggleUrgent}
        className={`w-full py-4 rounded-2xl text-sm font-bold border-2 transition-all flex items-center justify-center gap-3 ${
          taskData.isUrgent
            ? 'bg-gradient-to-r from-red-500 to-orange-500 border-red-500 text-white shadow-xl'
            : 'bg-white border-zinc-200 text-zinc-400 hover:border-zinc-300'
        }`}
      >
        <div className={`w-6 h-6 rounded-full flex items-center justify-center ${
          taskData.isUrgent ? 'bg-white/20' : 'bg-zinc-100'
        }`}>
          {taskData.isUrgent ? <AlertOctagon size={16} className="text-white" /> : <Circle size={16} />}
        </div>
        <span className="uppercase tracking-wide">
          {taskData.isUrgent ? 'Срочная задача' : 'Обычная задача'}
        </span>
      </button>
    </div>
  );
};
