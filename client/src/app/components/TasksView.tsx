import React, { useState, useMemo } from 'react';
import { Plus, X, AlertOctagon, Circle, CalendarDays, Clock, CheckSquare, History, ChevronDown, Phone } from 'lucide-react';
import type { Task, Client } from '@/utils/types';
import { getDateStr, formatDate, formatMoney } from '@/utils/helpers';
import { LAYOUT_CLASSES } from '@/utils/styleConstants';
import { getInitialTaskState } from '@/utils/initialStates';
import { validateTask, hasErrors } from '@/utils/validation';
import { Button } from '@/app/components/ui/Button';
import { Header } from '@/app/components/ui/Header';
import { TaskItem } from '@/app/components/ui/TaskItem';
import { AutocompleteInput } from '@/app/components/ui/AutocompleteInput';
import { PaymentBadge } from '@/app/components/ui/PaymentBadge';

interface TasksViewProps {
    tasks: Task[];
    onToggleTask: (taskId: string | number) => void;
    onAddTask: (task: Partial<Task>) => void;
    onDeleteTask: (taskId: string | number) => void;
    onEditTask: (task: Task) => void;
    clients: Client[];
    onOpenClient?: (client: any) => void;
    // canEdit=false → master-режим: скрываем «+» в шапке и удаление/редактирование
    // в TaskItem; чекбокс «выполнено» тоже отключается (master не должен менять
    // статус задач других сотрудников).
    canEdit?: boolean;
}

const TasksView: React.FC<TasksViewProps> = ({ tasks, onToggleTask, onAddTask, onDeleteTask, onEditTask, clients, onOpenClient, canEdit = true }) => {
    // No-op обработчики для read-only режима (master). Передаём функции, а не
    // undefined, потому что TaskItem не помечает onToggle/onEdit/onDelete как
    // опциональные. Реальные «безопасные» хендлеры собираем после объявления
    // handleEditTask (TDZ — нельзя ссылаться выше).
    const noop = () => {};
    const [isAdding, setIsAdding] = useState(false);
    const [showArchive, setShowArchive] = useState(false);
    const [editingTask, setEditingTask] = useState<Task | null>(null);
    const [taskFilter, setTaskFilter] = useState('today');
    const [newTask, setNewTask] = useState({
        ...getInitialTaskState(),
        clientName: ''
    });

    const today = getDateStr(0);
    
    const activeTasks = tasks.filter(t => !t.completed).map(task => {
        const isOverdue = task.date < today;
        return {
            ...task,
            isOverdue
        };
    });
    
    const archivedTasks = tasks.filter(t => t.completed);
    
    const todayTasks = activeTasks.filter(t => t.date === today || t.isOverdue);
    const futureTasks = activeTasks.filter(t => t.date > today);
    const displayTasks = taskFilter === 'today' ? todayTasks : activeTasks;

    const bookingsByDay = useMemo(() => {
        const allBookings: any[] = [];
        clients.forEach(client => {
            (client.records || []).forEach((record: any) => {
                allBookings.push({
                    ...record,
                    clientName: client.name,
                    clientPhone: client.phone,
                    clientId: client.id,
                    isArchived: record.isCompleted || record.date < today,
                });
            });
        });
        allBookings.sort((a, b) => {
            const dateComp = b.date.localeCompare(a.date);
            if (dateComp !== 0) return dateComp;
            return (a.time || '').localeCompare(b.time || '');
        });
        const grouped: Record<string, any[]> = {};
        allBookings.forEach(b => {
            if (!grouped[b.date]) grouped[b.date] = [];
            grouped[b.date].push(b);
        });
        return grouped;
    }, [clients, today]);
    
    const handleEditTask = (task: Task) => {
        setEditingTask(task);
        setNewTask({
            title: task.title || '',
            date: task.date || getDateStr(0),
            time: task.time || '12:00',
            isUrgent: task.urgency === 'high',
            clientName: task.clientName || '',
            assigned_to: task.assigned_to ?? null,
        });
        setIsAdding(true);
    };
    
    const handleSaveTask = () => {
        const taskErrors = validateTask({ title: newTask.title });
        if (hasErrors(taskErrors)) {
          alert(Object.values(taskErrors)[0]);
          return;
        }
        if(newTask.title) {
            const client = clients.find(c => c.name === newTask.clientName);
            const taskData = {
                ...newTask, 
                completed: false,
                urgency: newTask.isUrgent ? 'high' : 'low',
                clientId: client ? client.id : null
            };
            
            if (editingTask) {
                onEditTask({ ...editingTask, ...taskData } as Task);
                setEditingTask(null);
            } else {
                onAddTask(taskData);
            }
            
            setIsAdding(false);
            setNewTask({
                ...getInitialTaskState(),
                clientName: ''
            });
        }
    };

    const handleCancel = () => {
        setIsAdding(false);
        setEditingTask(null);
        setNewTask({
            ...getInitialTaskState(),
            clientName: ''
        });
    };

    return (
        <div className="flex flex-col h-full bg-zinc-50 overflow-hidden relative">
            <Header title="Задачи" actionIcon={canEdit ? Plus : undefined} onAction={canEdit ? () => setIsAdding(true) : undefined} />
            
            <div className="sticky top-0 z-20 bg-white px-6 pt-2 pb-2 border-b border-zinc-200">
                <div className="flex gap-1.5">
                    <button 
                        onClick={() => setTaskFilter('today')}
                        className={`flex-1 py-2 px-2 rounded-xl font-bold text-xs whitespace-nowrap transition-all ${
                            taskFilter === 'today' 
                                ? 'bg-orange-500 text-white shadow-lg' 
                                : 'bg-zinc-100 text-zinc-400 hover:bg-zinc-200'
                        }`}
                    >
                        сегодня{todayTasks.length > 0 ? ` ${todayTasks.length}` : ''}
                    </button>
                    <button 
                        onClick={() => setTaskFilter('all')}
                        className={`flex-1 py-2 px-2 rounded-xl font-bold text-xs whitespace-nowrap transition-all ${
                            taskFilter === 'all' 
                                ? 'bg-orange-500 text-white shadow-lg' 
                                : 'bg-zinc-100 text-zinc-400 hover:bg-zinc-200'
                        }`}
                    >
                        задачи{activeTasks.length > 0 ? ` ${activeTasks.length}` : ''}
                    </button>
                    <button 
                        onClick={() => setTaskFilter('bookings')}
                        className={`flex-1 py-2 px-2 rounded-xl font-bold text-xs whitespace-nowrap transition-all ${
                            taskFilter === 'bookings' 
                                ? 'bg-orange-500 text-white shadow-lg' 
                                : 'bg-zinc-100 text-zinc-400 hover:bg-zinc-200'
                        }`}
                    >
                        записи{Object.values(bookingsByDay).flat().length > 0 ? ` ${Object.values(bookingsByDay).flat().length}` : ''}
                    </button>
                </div>
            </div>
            
            {isAdding && (
                <div className={LAYOUT_CLASSES.modal}>
                    <div className={LAYOUT_CLASSES.modalContent} style={{paddingBottom: 'calc(80px + env(safe-area-inset-bottom, 20px))'}}>
                        <div className="flex justify-between items-center">
                            <h3 className="text-xl font-black">{editingTask ? 'Редактировать задачу' : 'Новая задача'}</h3>
                            <button onClick={handleCancel} className="bg-zinc-100 p-3 rounded-full min-w-[44px] min-h-[44px] flex items-center justify-center">
                                <X size={22}/>
                            </button>
                        </div>
                        <div className="space-y-4">
                            <input 
                                type="text" 
                                value={String(newTask.title || '')} 
                                onChange={(e) => setNewTask({...newTask, title: e.target.value})} 
                                placeholder="Название задачи..." 
                                className="w-full bg-zinc-50 border border-zinc-200 rounded-2xl p-4 font-bold outline-none shadow-sm" 
                            />
                            
                            <div className="relative">
                                <AutocompleteInput 
                                    options={clients.map(c => c.name)} 
                                    value={newTask.clientName} 
                                    onChange={(e) => setNewTask({...newTask, clientName: e.target.value})} 
                                    placeholder="Выбрать клиента" 
                                    className="w-full bg-zinc-50 border border-zinc-200 rounded-2xl p-4 font-bold outline-none shadow-sm" 
                                />
                            </div>
                            
                            <div className="flex gap-3">
                                <input 
                                    type="date" 
                                    value={String(newTask.date || '')} 
                                    onChange={(e) => setNewTask({...newTask, date: e.target.value})} 
                                    className="flex-1 bg-zinc-50 border border-zinc-200 rounded-2xl p-4 font-bold outline-none shadow-sm" 
                                />
                                <input 
                                    type="time" 
                                    value={String(newTask.time || '')} 
                                    onChange={(e) => setNewTask({...newTask, time: e.target.value})} 
                                    className="w-32 bg-zinc-50 border border-zinc-200 rounded-2xl p-4 font-bold outline-none text-center shadow-sm" 
                                />
                            </div>
                            
                            <button
                                onClick={() => setNewTask({...newTask, isUrgent: !newTask.isUrgent})} 
                                className={`w-full py-4 rounded-2xl text-sm font-bold border-2 transition-all flex items-center justify-center gap-3 ${
                                    newTask.isUrgent 
                                    ? 'bg-gradient-to-r from-red-500 to-orange-500 border-red-500 text-white shadow-xl' 
                                    : 'bg-white border-zinc-200 text-zinc-400 hover:border-zinc-300'
                                }`}
                            >
                                <div className={`w-6 h-6 rounded-full flex items-center justify-center ${
                                    newTask.isUrgent ? 'bg-white/20' : 'bg-zinc-100'
                                }`}>
                                    {newTask.isUrgent ? <AlertOctagon size={16} className="text-white" /> : <Circle size={16} />}
                                </div>
                                <span className="uppercase tracking-wide">
                                    {newTask.isUrgent ? 'Срочная задача' : 'Обычная задача'}
                                </span>
                            </button>
                            
                            <Button
                                variant="primary"
                                size="lg"
                                fullWidth
                                onClick={handleSaveTask}
                            >
                                {editingTask ? 'Сохранить изменения' : 'Добавить задачу'}
                            </Button>
                        </div>
                    </div>
                </div>
            )}
            
            <div className="flex-1 overflow-y-auto px-6 mt-2 space-y-2.5 pt-3 overscroll-contain" style={{paddingBottom: 'calc(100px + env(safe-area-inset-bottom, 20px))', WebkitOverflowScrolling: 'touch'}}>
                {taskFilter === 'bookings' ? (
                    <div className="space-y-4">
                        {Object.keys(bookingsByDay).length === 0 ? (
                            <div className="flex flex-col items-center justify-center h-64 text-center">
                                <CalendarDays size={48} className="text-zinc-300 mb-4" />
                                <p className="text-zinc-400 font-semibold">нет записей</p>
                            </div>
                        ) : (
                            Object.entries(bookingsByDay).map(([date, bookings]: [string, any[]]) => (
                                <div key={date}>
                                    <div className="flex items-center gap-2 text-xs font-black text-zinc-400 uppercase tracking-widest mb-1.5">
                                        <CalendarDays size={12} />
                                        {date === today ? 'сегодня' : formatDate(date)}
                                    </div>
                                    <div className="space-y-1.5">
                                        {bookings.map((booking: any) => {
                                            const isArchived = booking.isArchived;
                                            const topBarColor = isArchived ? 'bg-zinc-300' : 'bg-gradient-to-r from-orange-400 to-orange-500';
                                            return (
                                                <div 
                                                    key={booking.id} 
                                                    className={`rounded-xl border overflow-hidden active:scale-[0.98] transition-all cursor-pointer ${isArchived ? 'bg-zinc-50 border-zinc-200 opacity-60' : 'bg-zinc-100 border-zinc-200 shadow-sm'}`}
                                                    onClick={() => {
                                                        const client = clients.find(c => String(c.id) === String(booking.clientId));
                                                        if (client && onOpenClient) onOpenClient(client);
                                                    }}
                                                >
                                                    <div className={`h-0.5 ${topBarColor}`} />
                                                    <div className="px-3 py-2">
                                                        <div className="flex items-center justify-between gap-2">
                                                            <div className="flex items-center gap-1.5 min-w-0 flex-1">
                                                                <span className={`text-sm font-bold shrink-0 ${isArchived ? 'text-zinc-400 line-through' : 'text-zinc-900'}`} style={{maxWidth: '45%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'}}>{booking.service || '—'}</span>
                                                                <span className="text-zinc-400 text-xs shrink-0">·</span>
                                                                <span className={`text-xs truncate ${isArchived ? 'text-zinc-400' : 'text-zinc-500'}`}>{booking.clientName}</span>
                                                            </div>
                                                            <div className="flex items-center gap-1.5 shrink-0">
                                                                {booking.amount > 0 && (
                                                                    <span className={`text-xs font-bold ${isArchived ? 'text-zinc-400' : 'text-zinc-800'}`}>{formatMoney(booking.amount)}₽</span>
                                                                )}
                                                                <PaymentBadge status={booking.paymentStatus} size="xs" />
                                                            </div>
                                                        </div>
                                                    </div>
                                                </div>
                                            );
                                        })}
                                    </div>
                                </div>
                            ))
                        )}
                    </div>
                ) : taskFilter === 'all' ? (
                    <>
                        {todayTasks.length > 0 && (
                            <div className="space-y-2.5">
                                <div className="flex items-center gap-2 text-xs font-black text-zinc-400 uppercase tracking-widest">
                                    <CalendarDays size={14} />
                                    сегодня и просроченные
                                </div>
                                {todayTasks.map(t => {
                                    const client = t.clientId ? clients.find(c => String(c.id) === String(t.clientId)) : null;
                                    return <TaskItem key={t.id} task={t} onToggle={canEdit ? onToggleTask : noop} onDelete={canEdit ? onDeleteTask : noop} onEdit={canEdit ? handleEditTask : noop} client={client} onOpenClient={onOpenClient} />;
                                })}
                            </div>
                        )}
                        
                        {futureTasks.length > 0 && (
                            <div className="space-y-2.5 mt-4">
                                <div className="flex items-center gap-2 text-xs font-black text-zinc-400 uppercase tracking-widest pt-3 border-t border-zinc-200">
                                    <Clock size={14} />
                                    запланированные
                                </div>
                                {futureTasks.map(t => {
                                    const client = t.clientId ? clients.find(c => String(c.id) === String(t.clientId)) : null;
                                    return <TaskItem key={t.id} task={t} onToggle={canEdit ? onToggleTask : noop} onDelete={canEdit ? onDeleteTask : noop} onEdit={canEdit ? handleEditTask : noop} client={client} onOpenClient={onOpenClient} />;
                                })}
                            </div>
                        )}
                        
                        {todayTasks.length === 0 && futureTasks.length === 0 && (
                            <div className="flex flex-col items-center justify-center h-64 text-center">
                                <CheckSquare size={48} className="text-zinc-300 mb-4" />
                                <p className="text-zinc-400 font-semibold">нет задач</p>
                                <p className="text-zinc-300 text-sm mt-1">нажмите + чтобы добавить</p>
                            </div>
                        )}
                    </>
                ) : (
                    <div className="space-y-2.5">
                        {displayTasks.length === 0 ? (
                            <div className="flex flex-col items-center justify-center h-64 text-center">
                                <CheckSquare size={48} className="text-zinc-300 mb-4" />
                                <p className="text-zinc-400 font-semibold">нет задач на сегодня</p>
                                <p className="text-zinc-300 text-sm mt-1">отличная работа!</p>
                            </div>
                        ) : (
                            displayTasks.map(t => {
                                const client = t.clientId ? clients.find(c => String(c.id) === String(t.clientId)) : null;
                                return <TaskItem key={t.id} task={t} onToggle={canEdit ? onToggleTask : noop} onDelete={canEdit ? onDeleteTask : noop} onEdit={canEdit ? handleEditTask : noop} client={client} onOpenClient={onOpenClient} />;
                            })
                        )}
                    </div>
                )}

                {taskFilter !== 'bookings' && archivedTasks.length > 0 && (
                    <div className="mt-6 pt-4 border-t border-zinc-200">
                        <button 
                            onClick={() => setShowArchive(!showArchive)} 
                            className="flex items-center gap-2 text-xs font-black text-zinc-400 uppercase tracking-widest mb-3 hover:text-zinc-600 transition-all"
                        >
                            <History size={14} />
                            архив ({archivedTasks.length})
                            <ChevronDown size={14} className={`transition-transform ${showArchive ? 'rotate-180' : ''}`} />
                        </button>
                        {showArchive && (
                            <div className="space-y-2.5 opacity-60 animate-in fade-in">
                                {archivedTasks.map(t => {
                                    const client = t.clientId ? clients.find(c => String(c.id) === String(t.clientId)) : null;
                                    return <TaskItem key={t.id} task={t} onToggle={canEdit ? onToggleTask : noop} onDelete={canEdit ? onDeleteTask : noop} onEdit={canEdit ? handleEditTask : noop} client={client} onOpenClient={onOpenClient} />;
                                })}
                            </div>
                        )}
                    </div>
                )}
            </div>
        </div>
    );
};

export default TasksView;
