import { useState } from 'react';
import {
  ChevronLeft, ChevronRight, Edit3, Trash2, Phone, MessageSquare, Send,
  CalendarDays, RotateCcw, History,
  ChevronDown, AlertOctagon, Coins, CheckCircle2,
  ClipboardCheck, FileText
} from 'lucide-react';
import { AcceptanceActForm, WorkOrderForm } from '@/app/components/documents';
import { Button } from '@/app/components/ui/Button';
import { Badge } from '@/app/components/ui/Badge';
import { ClientAvatar } from '@/app/components/ui/ClientAvatar';
import { TaskItem } from '@/app/components/ui/TaskItem';
import { TaskFormFields } from '@/app/components/forms/TaskFormFields';
import { AppointmentInputs } from '@/app/components/forms/AppointmentInputs';
import { BTN_METAL, CARD_METAL } from '@/utils/constants';
import { PaymentBadge } from '@/app/components/ui/PaymentBadge';
import { formatDate, formatTime, formatMoney, getDateStr, findCategoryById, matchId } from '@/utils/helpers';
import { getInitialTaskState, getInitialRecordState } from '@/utils/initialStates';
import { getClientCardColorHex } from '@/utils/clientColors';
import { validateClientRecord, validateTask, hasErrors } from '@/utils/validation';
import { sanitizeTelUrl, sanitizeWhatsAppUrl, sanitizeTelegramUrl, safeOpenLink } from '@/utils/sanitize';

interface ClientDetailsProps {
  client: any;
  onBack: () => void;
  tasks: any[];
  onEdit: () => void;
  onAddTask: (task: any) => void;
  onDelete: () => void;
  onToggleTask: (id: any) => void;
  onAddRecord: (clientId: any, record: any) => Promise<boolean | void>;
  onEditRecord: (clientId: any, recordId: any, record: any) => Promise<boolean | void>;
  onCompleteRecord: (clientId: any, recordId: any) => void;
  onRestoreRecord: (clientId: any, recordId: any) => void;
  onDeleteRecord: (clientId: any, recordId: any) => void;
  onDeleteTask: (id: any) => void;
  onEditTask: (task: any) => void;
  onUpdateAvatar?: (clientId: any, avatar: string | null) => void;
  avatarSavingId?: any;
  categories: any[];
  tags?: any[];
  users?: any[];
  // Прайс-лист услуг — для ServicesPicker внутри AppointmentInputs.
  priceList?: any[];
  userRole?: string;
  // canEdit=false → master видит карточку клиента в режиме просмотра:
  // скрываются кнопки «Редактировать» / «Удалить» в шапке, форма
  // добавления задач/брони не показывается, поля профиля недоступны для правки.
  canEdit?: boolean;
}

export const ClientDetails = ({
  client, onBack, tasks, onEdit, onAddTask, onDelete, onToggleTask,
  onAddRecord, onEditRecord, onCompleteRecord, onRestoreRecord, onDeleteRecord,
  onDeleteTask, onEditTask, onUpdateAvatar, avatarSavingId,
  categories, tags = [], users = [], priceList = [], userRole = 'owner', canEdit = true,
}: ClientDetailsProps) => {
  const clientTasks = tasks.filter(t => t.clientId && client.id && String(t.clientId) === String(client.id));
  const activeTasks = clientTasks.filter(t => !t.completed);
  const completedTasks = clientTasks.filter(t => t.completed);
  const [showArchive, setShowArchive] = useState(false);
  const [showRecordsArchive, setShowRecordsArchive] = useState(false);
  const [isAddingTask, setIsAddingTask] = useState(false);
  const [editingTask, setEditingTask] = useState<any>(null);
  const [newTask, setNewTask] = useState(getInitialTaskState());
  const [isAddingRecord, setIsAddingRecord] = useState(false);
  const [editingRecordId, setEditingRecordId] = useState<any>(null);
  const [newRecord, setNewRecord] = useState(getInitialRecordState());
  const [completingRecordId, setCompletingRecordId] = useState<any>(null);
  const [deletingRecordId, setDeletingRecordId] = useState<any>(null);
  const [savingRecord, setSavingRecord] = useState(false);
  const cardColorHex = getClientCardColorHex(client.cardColor);
  // Открытое окно документа (акт приёмки / заказ-наряд) для конкретной брони.
  // null — закрыто. id здесь — bookingId; форма сама подгрузит/создаст документ.
  const [openDoc, setOpenDoc] = useState<{ bookingId: number; type: 'act' | 'order'; title: string } | null>(null);

  const clientRecords = client.records || [];
  const today = getDateStr(0);
  
  const activeRecords = clientRecords
    .filter((r: any) => !r.isCompleted)
    .sort((a: any, b: any) => (a.date || '').localeCompare(b.date || ''));
  const archivedRecords = clientRecords
    .filter((r: any) => r.isCompleted)
    .sort((a: any, b: any) => (b.date || '').localeCompare(a.date || ''));
  
  const totalEarnings = clientRecords.reduce((sum: number, record: any) => {
    if (record.paymentStatus === 'paid') {
      const amount = Number(record.amount) || 0;
      return sum + amount;
    }
    return sum;
  }, 0);
  
  const handleCompleteClick = (recordId: any) => {
    setCompletingRecordId(recordId);
    setTimeout(() => {
      onCompleteRecord(client.id, recordId);
      setCompletingRecordId(null);
    }, 300);
  };
  
  const handleEditTask = (task: any) => {
    setEditingTask(task);
    setNewTask({
      title: task.title || '',
      date: task.date || getDateStr(0),
      time: task.time || '12:00',
      isUrgent: task.urgency === 'high',
      assigned_to: task.assigned_to ?? null,
    });
    setIsAddingTask(true);
  };
  
  const handleSaveTask = () => {
    const taskErrors = validateTask({ title: newTask.title });
    if (hasErrors(taskErrors)) {
      alert(Object.values(taskErrors)[0]);
      return;
    }
    if (editingTask) {
      onEditTask({ ...editingTask, ...newTask, urgency: newTask.isUrgent ? 'high' : 'low' });
      setEditingTask(null);
    } else {
      onAddTask({...newTask, clientId: client.id, clientName: client.name, completed: false, urgency: newTask.isUrgent ? 'high' : 'low'});
    }
    setIsAddingTask(false);
    setNewTask(getInitialTaskState());
  };

  const handleCancelTask = () => {
    setIsAddingTask(false);
    setEditingTask(null);
    setNewTask(getInitialTaskState());
  };

  // Клик по бэкдропу (область вне карточки на десктопе) — закрывает карточку.
  // На мобиле карточка занимает почти весь экран, бэкдропа почти не видно —
  // там основной способ закрытия остаётся прежним (кнопка «Назад»).
  // Если внутри карточки открыта вложенная форма (редактирование записи или
  // документ приёмки), бэкдроп-клик игнорируем — иначе можно случайно потерять
  // несохранённые правки.
  const handleBackdropClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return;
    if (editingRecordId || isAddingRecord || isAddingTask || openDoc) return;
    onBack();
  };

  return (
    // На десктопе .desktop-card-modal превращает полноэкранную карточку
    // клиента в центрированный диалог — иначе она бы вылезала за границы
    // центрированной колонки приложения.
    // Внешний div — бэкдроп: ловит клики мимо карточки и закрывает её.
    <div
      className="fixed inset-0 z-[120] md:bg-black/40 md:backdrop-blur-sm"
      onClick={handleBackdropClick}
    >
    <div
      className="fixed top-0 left-0 right-0 z-[120] bg-zinc-50 flex flex-col overflow-hidden animate-in slide-in-from-right duration-300 desktop-card-modal"
      style={{bottom: 'calc(64px + env(safe-area-inset-bottom, 0px))'}}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="px-5 pb-4 bg-white border-b border-zinc-200 flex items-center justify-between shrink-0" style={{paddingTop: 'max(env(safe-area-inset-top, 12px), 48px)'}}>
        <button onClick={editingRecordId ? () => { setEditingRecordId(null); setNewRecord(getInitialRecordState()); } : onBack} className="flex items-center gap-1 text-zinc-600 font-bold"><ChevronLeft size={24} />{editingRecordId ? 'Назад к карточке' : 'Назад'}</button>
        {!editingRecordId && canEdit
          ? <div className="flex gap-4"><button onClick={onEdit} className="text-zinc-500 hover:text-black transition-colors"><Edit3 size={20} /></button><button onClick={onDelete} className="text-red-500 transition-colors"><Trash2 size={20} /></button></div>
          : <div />}
      </div>
      <div className="flex-1 overflow-y-auto p-6 md:px-10 space-y-8 overscroll-contain md-scroll-end" style={{paddingBottom: '40px', WebkitOverflowScrolling: 'touch'} as any}>
        {!editingRecordId && (
        <>
        <div className="text-center">
          <div className="flex justify-center mb-3">
            <ClientAvatar
              name={client.name}
              avatar={client.avatar}
              size="lg"
              editable={!!onUpdateAvatar}
              expandable
              isSaving={avatarSavingId === client.id}
              onAvatarChange={(avatar) => onUpdateAvatar?.(client.id, avatar)}
              onAvatarDelete={onUpdateAvatar ? () => onUpdateAvatar(client.id, null) : undefined}
            />
          </div>
          <h2 className="text-3xl font-black text-black leading-tight mb-2 inline-flex items-center justify-center gap-2 max-w-full">
            {cardColorHex && <span className="w-3 h-3 rounded-full shrink-0" style={{ backgroundColor: cardColorHex }} />}
            <span className="truncate">{String(client.name || '')}</span>
          </h2>
          <span className="text-xl font-medium text-zinc-400">{String(client.phone || '')}</span>
          
          <div className="mt-4 mb-6" />

          {/* 3 кнопки в строку: gap-2 на мобиле и !px-3 ужимают паддинги, чтобы
              «Позвонить / WhatsApp / Telegram» помещались в одну линию даже на
              iPhone SE (375 px). На десктопе остаётся стандартный gap-3. */}
          <div className="flex gap-2 sm:gap-3 w-full">
            <Button
              variant="primary"
              icon={Phone}
              onClick={() => {
                const telUrl = sanitizeTelUrl(client.phone);
                if (telUrl) window.location.href = telUrl;
              }}
              className="flex-1 !px-3 sm:!px-4"
            >
              Позвонить
            </Button>
            <Button
              variant="primary"
              icon={MessageSquare}
              onClick={() => {
                const waUrl = sanitizeWhatsAppUrl(client.phone);
                if (waUrl) safeOpenLink(waUrl);
              }}
              className="flex-1 !px-3 sm:!px-4"
            >
              WhatsApp
            </Button>
            <Button
              variant="primary"
              icon={Send}
              onClick={() => {
                const tgUrl = sanitizeTelegramUrl(client.phone);
                // tg://resolve?phone=… надо открывать в текущем окне:
                // window.open('tg://…', '_blank') на iOS Safari открывает
                // пустую вкладку без редиректа в приложение. Через
                // location.href iOS видит deep-link и открывает Telegram.
                if (tgUrl) window.location.href = tgUrl;
              }}
              className="flex-1 !px-3 sm:!px-4"
            >
              Telegram
            </Button>
          </div>
        </div>
        <div className={`rounded-2xl p-5 ${CARD_METAL} space-y-4 shadow-sm`}>
          <div className="flex justify-between border-b border-zinc-100 pb-3 text-sm font-medium"><span className="text-zinc-500">Автомобиль</span><div className="flex gap-2 font-bold"><span className="bg-orange-500 text-white px-2 py-0.5 rounded text-xs uppercase tracking-tighter">{String(client.carBrand || '')}</span><span className="text-zinc-800 tracking-tight">{String(client.carModel || '')}</span></div></div>
          <div className="flex justify-between border-b border-zinc-100 pb-3 text-sm font-medium"><span className="text-zinc-500">Город</span><span className="font-bold text-zinc-800">{String(client.city || '')}</span></div>
          <div className="flex justify-between border-b border-zinc-100 pb-3 text-sm font-medium"><span className="text-zinc-500">Дата рождения</span><span className="font-bold text-zinc-800">{client.birthDate ? formatDate(client.birthDate) : '-'}</span></div>
          <div className="flex justify-between text-sm font-medium"><span className="text-zinc-500">В базе с</span><span className="font-bold text-zinc-800">{client.createdAt ? formatDate(client.createdAt) : formatDate(getDateStr(0))}</span></div>
        </div>
        
        {totalEarnings > 0 && (
          <div className="bg-gradient-to-br from-orange-500 to-orange-600 rounded-2xl p-5 shadow-lg">
            <div className="flex items-center gap-2 mb-2">
              <Coins size={18} className="text-orange-100" />
              <span className="text-xs font-black text-orange-100 uppercase tracking-widest">Всего принес</span>
            </div>
            <div className="flex items-baseline gap-2">
              <span className="text-4xl font-black text-white">{formatMoney(totalEarnings)}</span>
              <span className="text-lg font-bold text-orange-100">₽</span>
            </div>
            <p className="text-xs text-orange-100 mt-1 font-medium">За {clientRecords.filter((r: any) => r.paymentStatus === 'paid').length} {clientRecords.filter((r: any) => r.paymentStatus === 'paid').length === 1 ? 'запись' : 'записей'}</p>
          </div>
        )}
        <div className="bg-white p-5 rounded-2xl border border-zinc-200 text-zinc-700 leading-relaxed text-sm shadow-sm">{String(client.comment || "Нет заметок.")}</div>
        </>
        )}
        
        {/* Бронь */}
        <div>
          <div className="flex items-center justify-between mb-3">
            <span className="text-xs font-black text-orange-500 uppercase tracking-widest">{editingRecordId ? 'Редактирование записи' : 'Запись'}</span>
            {!isAddingRecord && !editingRecordId && (
              <button onClick={() => setIsAddingRecord(true)} className={`text-xs font-bold px-3 py-1.5 rounded-lg ${BTN_METAL}`}>
                + Добавить
              </button>
            )}
          </div>
          {editingRecordId && (
            <p className="text-sm text-zinc-500 font-medium mb-4">{client.name} — {newRecord.service || 'Без названия'}</p>
          )}
          
          {(isAddingRecord || editingRecordId) && (
            <div className="bg-white border border-zinc-200 p-4 rounded-xl space-y-4 mb-4">
              <AppointmentInputs data={newRecord} onChange={(e: any) => {
                if (e.target.name === '_batch') {
                  setNewRecord(prev => ({...prev, ...e.target.value}));
                } else {
                  setNewRecord(prev => ({...prev, [e.target.name]: e.target.value}));
                }
              }} categories={categories || []} tags={tags || []} masters={users} priceList={priceList} />
              <div className="flex gap-2">
                <Button
                  variant="secondary"
                  onClick={() => {
                    setIsAddingRecord(false);
                    setEditingRecordId(null);
                    setNewRecord(getInitialRecordState());
                  }}
                  className="flex-1"
                >
                  Отмена
                </Button>
                <Button
                  variant="primary"
                  disabled={savingRecord}
                  onClick={async () => {
                    const recErrors = validateClientRecord({ date: newRecord.date });
                    if (hasErrors(recErrors)) {
                      alert(Object.values(recErrors)[0]);
                      return;
                    }
                    setSavingRecord(true);
                    try {
                      let success;
                      if (editingRecordId) { 
                        success = await onEditRecord(client.id, editingRecordId, newRecord); 
                      } else { 
                        success = await onAddRecord(client.id, newRecord); 
                      }
                      if (success !== false) {
                        setIsAddingRecord(false);
                        setEditingRecordId(null);
                        setNewRecord(getInitialRecordState());
                      }
                    } finally {
                      setSavingRecord(false);
                    }
                  }}
                  className="flex-1"
                >
                  {savingRecord ? 'Сохранение...' : 'Сохранить'}
                </Button>
              </div>
            </div>
          )}
          
          {!editingRecordId && activeRecords.length > 0 ? (
            <div className="space-y-3">
              {activeRecords.map((record: any) => {
                const category = findCategoryById(categories || [], record.category);
                const recordColorHex = getClientCardColorHex(record.recordColor || (record.isUrgent ? 'red' : 'none'));
                const topBarColor = recordColorHex ? '' : 'bg-gradient-to-r from-orange-400 to-orange-500';
                const iconColor = 'text-orange-500';

                return (
                  <div key={record.id} className="space-y-2">
                    <div className="rounded-2xl bg-zinc-100 border border-zinc-200 shadow-md overflow-hidden">
                      <div className={`h-1.5 ${topBarColor}`} style={recordColorHex ? { backgroundColor: recordColorHex } : undefined}></div>
                      
                      <div className="p-3 space-y-2.5">
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-2">
                            <CalendarDays size={18} className={iconColor} />
                            <span className="text-sm font-bold text-zinc-900">Активная запись</span>
                          </div>
                          <div className="flex items-center gap-2">
                            <PaymentBadge status={record.paymentStatus} size="md" />
                          </div>
                        </div>
                        
                        <div>
                          <h3 className="text-sm font-semibold text-zinc-900 leading-snug line-clamp-2">{String(record.service || '')}</h3>
                          {recordColorHex && (
                            <div className="flex items-center gap-1.5 mt-2">
                              <div className="w-2 h-2 rounded-full" style={{ backgroundColor: recordColorHex }} />
                            </div>
                          )}
                          {category && (
                            <div className="flex items-center gap-1.5 mt-2">
                              <div className="w-2 h-2 rounded-full" style={{ backgroundColor: category.color }} />
                              <span className="text-sm text-zinc-500 font-medium">{category.name}</span>
                            </div>
                          )}
                          {record.tags && record.tags.length > 0 && (
                            <div className="flex flex-wrap gap-1.5 mt-2">
                              {record.tags.map((tagId: string | number) => {
                                const tag = (tags || []).find((t: any) => matchId(t.id, tagId));
                                return tag ? (
                                  <span key={tagId} className="text-xs px-2 py-0.5 rounded-full font-medium" style={{ backgroundColor: `${tag.color}20`, color: tag.color }}>
                                    {tag.name}
                                  </span>
                                ) : null;
                              })}
                            </div>
                          )}
                        </div>
                        
                        <div className="flex items-center gap-4 pt-3 border-t border-zinc-100">
                          <div className="flex items-center gap-2 flex-1">
                            <CalendarDays size={16} className="text-orange-500 shrink-0" />
                            <div>
                              <p className="text-sm font-bold text-zinc-900 whitespace-nowrap">{formatDate(record.date)}</p>
                              {record.endDate && record.endDate !== record.date && (
                                <p className="text-xs text-orange-500 font-medium mt-0.5 whitespace-nowrap">→ {formatDate(record.endDate)}</p>
                              )}
                            </div>
                          </div>
                          <div className="flex items-center gap-2">
                            <span className="text-base">⏰</span>
                            <p className="text-sm font-bold text-zinc-900">{formatTime(record.time)}</p>
                          </div>
                        </div>
                        
                        {record.amount && (
                          <div className="flex items-center justify-between pt-4 border-t border-zinc-100">
                            <span className="text-sm text-zinc-500 font-medium">Сумма</span>
                            <div className="text-right">
                              <p className="text-base font-bold text-orange-500">{formatMoney(record.amount)} ₽</p>
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                    {deletingRecordId === record.id ? (
                      <div className="flex gap-2">
                        <button
                          onClick={() => {
                            onDeleteRecord(client.id, record.id);
                            setDeletingRecordId(null);
                          }}
                          className="flex-1 py-3 rounded-xl flex items-center justify-center gap-2 bg-gradient-to-b from-red-500 to-red-600 text-white font-bold text-sm shadow-md active:scale-95 transition-all duration-300"
                        >
                          <Trash2 size={16} />
                          Да, удалить
                        </button>
                        <button
                          onClick={() => setDeletingRecordId(null)}
                          className={`flex-1 py-3 rounded-xl flex items-center justify-center gap-2 ${BTN_METAL} font-bold text-sm`}
                        >
                          Отмена
                        </button>
                      </div>
                    ) : (
                      <div className="flex gap-2">
                        <button 
                          onClick={() => {
                            setNewRecord(record);
                            setEditingRecordId(record.id);
                          }} 
                          className={`flex-1 py-3 rounded-xl flex items-center justify-center gap-2 ${BTN_METAL} font-bold text-sm`}
                        >
                          <Edit3 size={16} />
                          Редактировать
                        </button>
                        <button 
                          onClick={() => handleCompleteClick(record.id)} 
                          className={`flex-1 py-3 rounded-xl flex items-center justify-center gap-2 font-bold text-sm shadow-md active:scale-95 transition-all duration-300 ${
                            completingRecordId === record.id 
                            ? 'bg-gradient-to-b from-orange-500 to-orange-600 text-white scale-[0.98]' 
                            : `${BTN_METAL}`
                          }`}
                        >
                          <CheckCircle2 size={16} />
                          Выполнено
                        </button>
                        <button
                          onClick={() => setDeletingRecordId(record.id)}
                          className={`w-[44px] min-w-[44px] py-3 rounded-xl flex items-center justify-center ${BTN_METAL} active:scale-95 transition-all duration-300`}
                        >
                          <Trash2 size={16} className="text-red-400" />
                        </button>
                      </div>
                    )}
                    {/* Документы по брони — акт приёмки + заказ-наряд. */}
                    {deletingRecordId !== record.id && (
                      <div className="flex gap-2">
                        <button
                          onClick={() => setOpenDoc({
                            bookingId: Number(record.id),
                            type: 'act',
                            title: `${client.name || ''} • ${record.service || ''}`.trim().replace(/^•\s*/, ''),
                          })}
                          className={`flex-1 py-2.5 rounded-xl flex items-center justify-center gap-2 ${BTN_METAL} font-bold text-xs`}
                        >
                          <ClipboardCheck size={14} />
                          Акт приёмки
                        </button>
                        <button
                          onClick={() => setOpenDoc({
                            bookingId: Number(record.id),
                            type: 'order',
                            title: `${client.name || ''} • ${record.service || ''}`.trim().replace(/^•\s*/, ''),
                          })}
                          className={`flex-1 py-2.5 rounded-xl flex items-center justify-center gap-2 ${BTN_METAL} font-bold text-xs`}
                        >
                          <FileText size={14} />
                          Заказ-наряд
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          ) : !isAddingRecord && !editingRecordId && (
            <div className="p-4 rounded-xl border border-dashed border-zinc-300 text-center text-xs text-zinc-400 italic">
              Нет активных записей
            </div>
          )}
          
          {!editingRecordId && archivedRecords.length > 0 && (
            <div className="mt-6">
              <button 
                onClick={() => setShowRecordsArchive(!showRecordsArchive)} 
                className="flex items-center gap-2 text-xs font-bold text-zinc-400 uppercase tracking-widest mb-3 hover:text-zinc-600 transition-all"
              >
                <History size={12} />
                Архив записей ({archivedRecords.length})
                <ChevronDown size={12} className={`transition-transform ${showRecordsArchive ? 'rotate-180' : ''}`} />
              </button>
              {showRecordsArchive && (
                <div className="space-y-3 animate-in fade-in">
                  {archivedRecords.map((record: any) => (
                    <div key={record.id} className="rounded-xl bg-white border border-zinc-200 shadow-sm overflow-hidden">
                      <div className="h-1 bg-gradient-to-r from-zinc-300 to-zinc-400"></div>
                      
                      <div className="p-4 space-y-2 relative">
                        <div className="flex items-center gap-2 justify-between">
                          <div className="flex items-center gap-2">
                            <CheckCircle2 size={14} className="text-green-600" />
                            <span className="text-xs font-bold uppercase tracking-wider text-zinc-500">Выполнено</span>
                            {record.isPaid && <PaymentBadge status="paid" size="sm" />}
                          </div>
                          
                          <button 
                            onClick={() => {
                              if (window.confirm('Восстановить запись? Связанная транзакция будет удалена из финансов.')) {
                                onRestoreRecord(client.id, record.id);
                              }
                            }} 
                            className="p-1.5 rounded-lg bg-gradient-to-b from-orange-500 to-orange-600 text-white shadow-sm hover:shadow-md active:scale-90 transition-all duration-200"
                            title="Восстановить запись"
                          >
                            <RotateCcw size={14} />
                          </button>
                        </div>
                        <p className="text-base font-bold text-zinc-700">{String(record.service || '')}</p>
                        <div className="flex justify-between items-center">
                          <p className="text-sm font-medium text-zinc-500 whitespace-nowrap">{formatDate(record.date)} • {formatTime(record.time)}</p>
                          <p className="text-lg font-black text-zinc-800">{formatMoney(record.amount)} ₽</p>
                        </div>
                        {/* Быстрый доступ к документам выполненной брони —
                            чтобы вспомнить, что было сделано в прошлый раз. */}
                        <div className="flex gap-2 pt-2">
                          <button
                            onClick={() => setOpenDoc({
                              bookingId: Number(record.id),
                              type: 'act',
                              title: `${client.name || ''} • ${record.service || ''}`.trim().replace(/^•\s*/, ''),
                            })}
                            className={`flex-1 py-2 rounded-xl flex items-center justify-center gap-1.5 ${BTN_METAL} font-bold text-xs`}
                          >
                            <ClipboardCheck size={13} />
                            Акт приёмки
                          </button>
                          <button
                            onClick={() => setOpenDoc({
                              bookingId: Number(record.id),
                              type: 'order',
                              title: `${client.name || ''} • ${record.service || ''}`.trim().replace(/^•\s*/, ''),
                            })}
                            className={`flex-1 py-2 rounded-xl flex items-center justify-center gap-1.5 ${BTN_METAL} font-bold text-xs`}
                          >
                            <FileText size={13} />
                            Заказ-наряд
                          </button>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
        
        {/* Задачи */}
        {!editingRecordId && <div>
          <div className="flex items-center justify-between mb-3">
            <span className="text-xs font-black text-zinc-400 uppercase tracking-widest">Задачи</span>
            <button onClick={() => setIsAddingTask(true)} className={`text-xs font-bold px-3 py-1.5 rounded-lg ${BTN_METAL}`}>+ Создать</button>
          </div>
          {isAddingTask && (
            <div className="bg-zinc-100 p-4 rounded-xl space-y-3 shadow-inner mb-4 animate-in fade-in">
              <TaskFormFields
                taskData={{
                  title: String(newTask.title || ''),
                  date: String(newTask.date || ''),
                  time: String(newTask.time || ''),
                  isUrgent: newTask.isUrgent,
                  assigned_to: newTask.assigned_to ?? null,
                }}
                onChange={(e: any) => setNewTask({...newTask, [e.target.name]: e.target.value})}
                onToggleUrgent={() => setNewTask({...newTask, isUrgent: !newTask.isUrgent})}
                users={users}
              />
              
              <div className="flex gap-2">
                <Button variant="secondary" onClick={handleCancelTask} className="flex-1">Отмена</Button>
                <Button variant="primary" onClick={handleSaveTask} className="flex-1">
                  {editingTask ? 'Сохранить' : 'Добавить'}
                </Button>
              </div>
            </div>
          )}
          <div className="space-y-2">{activeTasks.map(t => <TaskItem key={t.id} task={t} onToggle={onToggleTask} onDelete={onDeleteTask} onEdit={handleEditTask} />)}</div>
          {completedTasks.length > 0 && (<div className="mt-6"><button onClick={() => setShowArchive(!showArchive)} className="flex items-center gap-2 text-xs font-bold text-zinc-400 uppercase tracking-widest mb-3 hover:text-zinc-600 transition-all">Архив ({completedTasks.length}) <ChevronDown size={12} className={showArchive ? 'rotate-180' : ''} /></button>{showArchive && <div className="space-y-2 opacity-60 animate-in fade-in">{completedTasks.map(t => <TaskItem key={t.id} task={t} onToggle={onToggleTask} />)}</div>}</div>)}
        </div>}
      </div>

      {/* ── Документы по брони (акт приёмки / заказ-наряд) ── */}
      {openDoc?.type === 'act' && (
        <AcceptanceActForm
          isOpen
          onClose={() => setOpenDoc(null)}
          bookingId={openDoc.bookingId}
          bookingTitle={openDoc.title}
        />
      )}
      {openDoc?.type === 'order' && (
        <WorkOrderForm
          isOpen
          onClose={() => setOpenDoc(null)}
          bookingId={openDoc.bookingId}
          bookingTitle={openDoc.title}
          initialItems={(() => {
            const rec = activeRecords.find((r: any) => Number(r.id) === openDoc.bookingId);
            if (!rec) return undefined;
            // Multi-service: если в брони сохранён массив services
            // (snapshot из прайса/custom), создаём по строке наряда на
            // каждую услугу — каждая со своей ценой. Это ровно то,
            // что юзер выбрал при создании брони.
            if (Array.isArray(rec.services) && rec.services.length > 0) {
              return rec.services.map((s: any) => ({
                name: String(s.name || ''),
                quantity: 1,
                price: Number(s.price) || 0,
              }));
            }
            // Legacy fallback: старая бронь без services-массива —
            // стартуем наряд с одной строки из service+amount.
            const price = Number(rec.amount) || 0;
            const name = String(rec.service || '').trim();
            return name ? [{ name, quantity: 1, price }] : undefined;
          })()}
        />
      )}
    </div>
    </div>
  );
};
