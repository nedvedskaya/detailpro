import React, { useState } from 'react';
import { Overlay } from './ui/Overlay';
import { Plus, X, ChevronLeft, ChevronRight, CalendarDays, ChevronRight as ChevronRightIcon, Copy, CheckCircle2, DollarSign } from 'lucide-react';
import { formatDate, formatTime, getDateStr, findCategoryById, isDateInRange } from '@/utils/helpers';
import { LAYOUT_CLASSES } from '@/utils/styleConstants';
import { getInitialCalendarEntryState } from '@/utils/initialStates';
import { Header } from '@/app/components/ui/Header';
import { Button } from '@/app/components/ui/Button';
import { AutocompleteInput } from '@/app/components/ui/AutocompleteInput';
import { AppointmentInputs } from '@/app/components/forms/AppointmentInputs';
import { CalendarGrid } from '@/app/components/CalendarGrid';
import { showToast } from '@/app/components/ui/Toast';
import { PaymentBadge } from '@/app/components/ui/PaymentBadge';
import { getClientCardColorHex } from '@/utils/clientColors';

interface CalendarViewProps {
    events: any[];
    clients: any[];
    onAddRecord: (clientId: any, record: any) => Promise<boolean | void>;
    onOpenClient: (client: any) => void;
    categories: any[];
    tags: any[];
    users?: any[];
    // Прайс-лист студии — для ServicesPicker внутри AppointmentInputs.
    priceList?: any[];
    // canEdit=false → master-режим: скрываем «+» в шапке. Тап по дню/событию
    // открывает детали клиента в просмотре через onOpenClient.
    canEdit?: boolean;
    // Создание клиента прямо из формы новой брони (sticky-кнопка в выпадашке).
    onAddClient?: (data: any, tasks?: any, records?: any) => Promise<any>;
    ClientForm?: React.ComponentType<any>;
}

export const CalendarView = ({
    events,
    clients,
    onAddRecord,
    onOpenClient,
    categories,
    tags,
    users = [],
    priceList = [],
    canEdit = true,
    onAddClient,
    ClientForm,
}: CalendarViewProps) => {
    const [currentDate, setCurrentDate] = useState(new Date());
    const [isAdding, setIsAdding] = useState(false);
    const [selectedDate, setSelectedDate] = useState<string | null>(null);
    const [newEntry, setNewEntry] = useState(getInitialCalendarEntryState());
    // Sub-modal: «+ Добавить клиента» прямо из формы новой брони.
    const [isAddingClient, setIsAddingClient] = useState(false);
    const month = currentDate.getMonth();
    const year = currentDate.getFullYear();
    const names = ["Январь", "Февраль", "Март", "Апрель", "Май", "Июнь", "Июль", "Август", "Сентябрь", "Октябрь", "Ноябрь", "Декабрь"];
    const week = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
    const days = new Date(year, month + 1, 0).getDate();
    const start = new Date(year, month, 1).getDay();
    const pad = start === 0 ? 6 : start - 1;
    
    const selectedDateEvents = selectedDate ? events.filter(e => 
        e.endDate ? isDateInRange(selectedDate, e.date, e.endDate) : e.date === selectedDate
    ) : [];

    return (
        <div className="flex flex-col h-full bg-zinc-50 overflow-hidden relative">
             <Header title="Календарь" actionIcon={canEdit ? Plus : undefined} onAction={canEdit ? () => setIsAdding(true) : undefined} />
             {isAdding && canEdit && (
                 <div className={LAYOUT_CLASSES.modal} onClick={(e) => { if (e.target === e.currentTarget && !newEntry.clientName && !newEntry.service) setIsAdding(false); }}>
                    <div className={LAYOUT_CLASSES.modalContent} onClick={(e) => e.stopPropagation()}>
                        <div className="flex justify-between items-center">
                            <h3 className="text-xl font-black">Новая запись</h3>
                            <button onClick={() => setIsAdding(false)} className="bg-zinc-100 p-3 rounded-full min-w-[44px] min-h-[44px] flex items-center justify-center"><X size={22}/></button>
                        </div>
                        <div className="space-y-4">
                            <AutocompleteInput
                                options={clients.map(c => c.name)}
                                value={newEntry.clientName}
                                onChange={(e) => setNewEntry({...newEntry, clientName: e.target.value})}
                                placeholder="Поиск клиента..."
                                className="w-full bg-zinc-50 border border-zinc-200 rounded-2xl p-4 font-bold outline-none"
                                topAction={(onAddClient && ClientForm) ? {
                                    label: '+ Добавить клиента',
                                    onClick: () => setIsAddingClient(true),
                                } : undefined}
                            />
                            <AppointmentInputs
                                data={newEntry}
                                onChange={(e) => {
                                    if (e.target.name === '_batch') {
                                        setNewEntry(prev => ({...prev, ...e.target.value}));
                                    } else {
                                        setNewEntry(prev => ({...prev, [e.target.name]: e.target.value}));
                                    }
                                }}
                                categories={categories || []}
                                tags={tags || []}
                                masters={users}
                                priceList={priceList}
                            />
                            <Button 
                                variant="primary" 
                                size="lg" 
                                fullWidth 
                                onClick={async () => { 
                                    const c = clients.find(cl => cl.name === newEntry.clientName); 
                                    if(c) { 
                                        const success = await onAddRecord(c.id, newEntry); 
                                        if (success !== false) {
                                            setIsAdding(false);
                                            setNewEntry(getInitialCalendarEntryState());
                                        }
                                    } else {
                                        showToast('Клиент не найден', 'warning'); 
                                    }
                                }}
                            >
                                Добавить
                            </Button>
                        </div>
                    </div>
                 </div>
             )}
             {isAdding && canEdit && isAddingClient && ClientForm && onAddClient && (
                 <ClientForm
                     onSave={async (data: any, tasks: any, records: any) => {
                         const saved = await onAddClient(data, tasks, records);
                         if (saved === false) return;
                         // Подставляем имя нового клиента в текущую форму брони.
                         const name = saved?.name || data?.name || '';
                         if (name) setNewEntry((prev: any) => ({ ...prev, clientName: name }));
                         setIsAddingClient(false);
                     }}
                     onCancel={() => setIsAddingClient(false)}
                     categories={categories}
                     tags={tags}
                     users={users}
                     priceList={priceList}
                 />
             )}
             <div className="px-4 py-2 flex items-center justify-between bg-white/50 backdrop-blur-sm shrink-0">
                <div className="flex items-center gap-4">
                    <button onClick={() => setCurrentDate(new Date(year, month - 1, 1))} className="p-2 text-zinc-400 transition-colors hover:text-black"><ChevronLeft size={24} /></button>
                    <span className="text-3xl font-black">{names[month]}</span>
                    <button onClick={() => setCurrentDate(new Date(year, month + 1, 1))} className="p-2 text-zinc-400 transition-colors hover:text-black"><ChevronRight size={24} /></button>
                </div>
                <div className="text-sm font-bold text-zinc-400 pr-2">{year}</div>
            </div>
             <div className="flex-1 overflow-y-auto bg-white p-2 overscroll-contain md-scroll-end" style={{paddingBottom: 'calc(100px + env(safe-area-inset-bottom, 20px))', WebkitOverflowScrolling: 'touch'}}>
                <div className="grid grid-cols-7 border-b border-zinc-100 pb-2 mb-2 text-center text-xs font-black text-zinc-400 uppercase">{week.map(d => <div key={d}>{d}</div>)}</div>
                <CalendarGrid
                    year={year}
                    month={month}
                    days={days}
                    pad={pad}
                    events={events}
                    clients={clients}
                    getDateStr={getDateStr}
                    onDateClick={setSelectedDate}
                />
            </div>
            
            {selectedDate && (
                <Overlay position="absolute" zIndex={150} onClick={() => setSelectedDate(null)}>
                    <div className="w-full bg-white rounded-t-[32px] p-6 shadow-2xl overflow-y-auto" style={{maxHeight: '80dvh', paddingBottom: 'calc(80px + env(safe-area-inset-bottom, 20px))'}} onClick={(e) => e.stopPropagation()}>
                        <div className="flex justify-between items-center mb-6">
                            <div>
                                <h3 className="text-2xl font-black whitespace-nowrap">{formatDate(selectedDate)}</h3>
                                <p className="text-sm text-zinc-400 font-medium mt-1">{selectedDateEvents.length} {selectedDateEvents.length === 1 ? 'запись' : 'записей'}</p>
                            </div>
                            <div className="flex gap-2">
                                <Button 
                                    variant="primary"
                                    icon={Plus}
                                    onClick={() => { setNewEntry({...newEntry, date: selectedDate}); setSelectedDate(null); setIsAdding(true); }}
                                >
                                    Добавить
                                </Button>
                                <button onClick={() => setSelectedDate(null)} className="bg-zinc-100 p-3 rounded-full min-w-[44px] min-h-[44px] flex items-center justify-center">
                                    <X size={22}/>
                                </button>
                            </div>
                        </div>
                        
                        {selectedDateEvents.length === 0 ? (
                            <div className="text-center py-12 text-zinc-400">
                                <CalendarDays size={48} className="mx-auto mb-3 opacity-30" />
                                <p className="font-semibold">Нет записей на этот день</p>
                            </div>
                        ) : (
                            <div className="space-y-3">
                                {selectedDateEvents.map((ev, idx) => {
                                    const client = clients.find(c => c.id === ev.clientId);
                                    const category = findCategoryById(categories || [], ev.category);
                                    const record = client?.records?.find((r: any) => r.id === ev.recordId);
                                    const isCompleted = record?.isCompleted;
                                    const recordColor = record?.recordColor || ev.recordColor || (record?.isUrgent ? 'red' : 'none');
                                    const recordColorHex = getClientCardColorHex(recordColor);
                                    let bgGradient = 'from-zinc-50 to-white';
                                    let borderColor = 'border-zinc-200';
                                    let timeBg = 'bg-zinc-500';

                                    if (isCompleted) {
                                        bgGradient = 'from-gray-50 to-white';
                                        borderColor = 'border-gray-200';
                                        timeBg = 'bg-gray-500';
                                    } else {
                                        bgGradient = 'from-orange-50 to-white';
                                        borderColor = 'border-orange-200';
                                        timeBg = 'bg-orange-600';
                                    }
                                    
                                    return (
                                        <div key={idx} className={`bg-gradient-to-r ${bgGradient} border ${borderColor} rounded-2xl p-4 shadow-sm`}>
                                            <div className="flex items-start justify-between mb-3">
                                                <div className="flex items-center gap-3 flex-1">
                                                    <div
                                                        className={`${timeBg} text-white rounded-xl px-3 py-2 font-black text-sm shrink-0`}
                                                        style={recordColorHex && !isCompleted ? { backgroundColor: recordColorHex } : undefined}
                                                    >
                                                        {formatTime(ev.time)}
                                                    </div>
                                                    {ev.paymentStatus === 'paid' && (
                                                        <PaymentBadge status="paid" size="sm" icon={<CheckCircle2 size={12} />} className="uppercase" />
                                                    )}
                                                    {ev.paymentStatus === 'advance' && (
                                                        <PaymentBadge status="advance" size="sm" icon={<DollarSign size={12} />} className="uppercase" />
                                                    )}
                                                    <div 
                                                        className="cursor-pointer group flex-1"
                                                        onClick={() => {
                                                            if (client) {
                                                                setSelectedDate(null);
                                                                onOpenClient(client);
                                                            }
                                                        }}
                                                    >
                                                        <div className="flex items-center gap-1.5">
                                                            <p className="font-black text-black text-base group-hover:text-orange-500 transition-colors">
                                                                {client?.name || 'Клиент'}
                                                            </p>
                                                            <ChevronRightIcon size={20} className="text-orange-500 shrink-0 group-hover:translate-x-1 transition-transform" strokeWidth={3} />
                                                        </div>
                                                        <p className="text-sm font-bold text-zinc-700 mt-1">{String(ev.service || 'Услуга')}</p>
                                                        {recordColorHex && !isCompleted && (
                                                            <div className="w-2 h-2 rounded-full mt-1" style={{ backgroundColor: recordColorHex }} />
                                                        )}
                                                        <div className="flex items-center gap-2 mt-1 flex-wrap">
                                                            {category && (
                                                                <div className="flex items-center gap-1.5">
                                                                    <div 
                                                                        className="w-2 h-2 rounded-full" 
                                                                        style={{ backgroundColor: category.color }}
                                                                    />
                                                                    <span className="text-xs text-zinc-500 font-medium">{category.name}</span>
                                                                </div>
                                                            )}
                                                        </div>
                                                        {ev.endDate && (
                                                            <p className="text-xs text-orange-600 font-bold mt-1 whitespace-nowrap">
                                                                {formatDate(ev.date)} - {formatDate(ev.endDate)}
                                                            </p>
                                                        )}
                                                    </div>
                                                </div>
                                            </div>
                                            {client && (
                                                <div className="flex gap-2 mt-3 pt-3 border-t border-orange-100">
                                                    <div className="flex-1 bg-white rounded-lg px-3 py-2 border border-zinc-200">
                                                        <p className="text-xs text-zinc-400 font-bold uppercase tracking-wide">Автомобиль</p>
                                                        <p className="text-sm font-bold text-black mt-0.5">{client.carBrand} {client.carModel}</p>
                                                    </div>
                                                    <div 
                                                        className="flex-1 bg-white rounded-lg px-3 py-2 border border-zinc-200 cursor-pointer hover:bg-orange-50 hover:border-orange-300 transition-all active:scale-95"
                                                        onClick={(e) => {
                                                            e.stopPropagation();
                                                            navigator.clipboard.writeText(client.phone);
                                                        }}
                                                    >
                                                        <p className="text-xs text-zinc-400 font-bold uppercase tracking-wide">Телефон</p>
                                                        <div className="flex items-center gap-1.5 mt-0.5">
                                                            <p className="text-sm font-bold text-black whitespace-nowrap">{client.phone}</p>
                                                            <Copy size={14} className="text-orange-500 shrink-0" />
                                                        </div>
                                                    </div>
                                                </div>
                                            )}
                                        </div>
                                    );
                                })}
                            </div>
                        )}
                    </div>
                </Overlay>
            )}
        </div>
    );
};
