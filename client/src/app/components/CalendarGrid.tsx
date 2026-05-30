import React from 'react';
import { parseDateParts } from '@/utils/helpers';
import { getClientCardColorHex, getReadableTextColor } from '@/utils/clientColors';

interface CalendarEvent {
    id?: string;
    clientId: string;
    recordId?: string;
    date: string;
    endDate?: string;
    service?: string;
    title?: string;
    isCompleted?: boolean;
    isUrgent?: boolean;
    recordColor?: string;
}

interface CalendarGridProps {
    year: number;
    month: number;
    days: number;
    pad: number;
    events: CalendarEvent[];
    clients: any[];
    getDateStr: (offset: number) => string;
    onDateClick: (date: string) => void;
}

export const CalendarGrid: React.FC<CalendarGridProps> = ({
    year,
    month,
    days,
    pad,
    events,
    clients,
    getDateStr,
    onDateClick,
}) => {
    // Обрабатываем события для календаря
    const processedEvents = React.useMemo(() => {
        const result: any[] = [];
        
        events.forEach(ev => {
            const eventId = ev.id || `${ev.clientId}-${ev.date}-${ev.recordId}`;
            const startParts = parseDateParts(ev.date);
            const eventStartDay = startParts.day;
            const eventStartMonth = startParts.month;
            
            if (eventStartMonth !== month) return;
            
            let durationDays = 1;
            if (ev.endDate && ev.date !== ev.endDate) {
                const endParts = parseDateParts(ev.endDate);
                const endDay = endParts.day;
                const endMonth = endParts.month;
                
                if (endMonth === month) {
                    durationDays = endDay - eventStartDay + 1;
                } else {
                    // Событие продолжается в следующий месяц
                    durationDays = days - eventStartDay + 1;
                }
            }
            
            // Вычисляем позицию в сетке (с учетом pad)
            const gridPosition = pad + eventStartDay - 1;
            const row = Math.floor(gridPosition / 7);
            const col = gridPosition % 7;
            
            // Проверяем, сколько дней остается до конца недели
            const daysToWeekEnd = 7 - col;
            
            // Если событие переходит на следующую неделю, разбиваем его на части
            if (durationDays > daysToWeekEnd) {
                // Первая часть - до конца текущей недели
                result.push({
                    ...ev,
                    eventId: `${eventId}-part-0`,
                    startDay: eventStartDay,
                    row,
                    col,
                    durationDays: daysToWeekEnd,
                    isFirst: true,
                    isLast: false,
                });
                
                // Остальные части
                let remainingDays = durationDays - daysToWeekEnd;
                let currentRow = row + 1;
                let partIndex = 1;
                
                while (remainingDays > 0) {
                    const partDuration = Math.min(remainingDays, 7);
                    result.push({
                        ...ev,
                        eventId: `${eventId}-part-${partIndex}`,
                        startDay: eventStartDay,
                        row: currentRow,
                        col: 0,
                        durationDays: partDuration,
                        isFirst: false,
                        isLast: remainingDays <= 7,
                    });
                    
                    remainingDays -= 7;
                    currentRow++;
                    partIndex++;
                }
            } else {
                // Событие помещается в одну неделю
                result.push({
                    ...ev,
                    eventId,
                    startDay: eventStartDay,
                    row,
                    col,
                    durationDays,
                    isFirst: true,
                    isLast: true,
                });
            }
        });
        
        // Группируем события по строкам для правильного позиционирования по вертикали
        const eventsByRow = new Map();
        result.forEach(ev => {
            if (!eventsByRow.has(ev.row)) {
                eventsByRow.set(ev.row, []);
            }
            eventsByRow.get(ev.row).push(ev);
        });
        
        // Назначаем индекс для каждого события в строке с учётом реального пересечения
        eventsByRow.forEach((rowEvents) => {
            const placed: { col: number; colEnd: number; rowIndex: number; baseId: string }[] = [];
            
            rowEvents.sort((a, b) => a.col - b.col || b.durationDays - a.durationDays);
            
            rowEvents.forEach(ev => {
                const baseId = String(ev.eventId).split('-part-')[0];
                const colEnd = ev.col + ev.durationDays - 1;
                
                const existing = placed.find(p => p.baseId === baseId);
                if (existing) {
                    ev.rowIndex = existing.rowIndex;
                    return;
                }
                
                let idx = 0;
                while (true) {
                    const hasConflict = placed.some(p => 
                        p.rowIndex === idx && !(colEnd < p.col || ev.col > p.colEnd)
                    );
                    if (!hasConflict) break;
                    idx++;
                }
                
                ev.rowIndex = idx;
                placed.push({ col: ev.col, colEnd, rowIndex: idx, baseId });
            });
        });
        
        return result;
    }, [events, month, days, pad]);
    
    const totalCells = pad + days;
    const totalRows = Math.ceil(totalCells / 7);
    
    return (
        <div className="relative">
            {/* Сетка с датами */}
            <div className="grid grid-cols-7 gap-px bg-zinc-100 border border-zinc-200 rounded-lg overflow-hidden">
                {Array.from({length: pad}).map((_, i) => (
                    <div key={`p-${i}`} className="bg-white min-h-[90px]" />
                ))}
                {Array.from({length: days}).map((_, i) => {
                    const d = i + 1;
                    const date = `${year}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
                    
                    return (
                        <div
                            key={d}
                            onClick={() => onDateClick(date)}
                            className="bg-white min-h-[90px] p-1.5 cursor-pointer hover:bg-zinc-50 transition-all"
                        >
                            <span
                                className={`text-xs font-black w-6 h-6 flex items-center justify-center rounded-full ${
                                    date === getDateStr(0) ? 'bg-orange-500 text-white' : 'text-zinc-600'
                                }`}
                            >
                                {d}
                            </span>
                        </div>
                    );
                })}
            </div>
            
            {/* Слой с событиями поверх всей сетки */}
            <div 
                className="absolute pointer-events-none"
                style={{
                    top: '1px',
                    left: '1px',
                    right: '1px',
                    bottom: '1px',
                }}
            >
                {processedEvents.map((ev) => {
                    const recordColor = ev.recordColor || (ev.isUrgent ? 'red' : 'none');
                    const colorHex = getClientCardColorHex(recordColor);
                    const fallbackBgClass = ev.isCompleted
                        ? 'bg-gradient-to-r from-zinc-300 to-zinc-400'
                        : 'bg-gradient-to-r from-orange-400 to-orange-500';
                    
                    // Скругление углов
                    let roundedClass = 'rounded';
                    if (!ev.isFirst && !ev.isLast) {
                        roundedClass = 'rounded-none';
                    } else if (ev.isFirst && !ev.isLast) {
                        roundedClass = 'rounded-l rounded-r-none';
                    } else if (!ev.isFirst && ev.isLast) {
                        roundedClass = 'rounded-r rounded-l-none';
                    }
                    
                    // Рассчитываем позицию и размеры
                    const cellWidth = `calc((100% - ${6}px) / 7)`; // 6px = 6 gaps по 1px
                    const gapWidth = 1;
                    
                    const leftPos = `calc(${ev.col} * (${cellWidth} + ${gapWidth}px))`;
                    const widthCalc = `calc(${ev.durationDays} * ${cellWidth} + ${(ev.durationDays - 1) * gapWidth}px)`;
                    const topPos = `calc(${ev.row} * 91px + 32px + ${ev.rowIndex * 20}px)`; // 91px = 90px min-height + 1px gap
                    
                    return (
                        <div
                            key={ev.eventId}
                            className={`absolute px-1 py-0.5 ${roundedClass} text-[8px] font-bold shadow-sm pointer-events-auto cursor-pointer overflow-hidden whitespace-nowrap text-ellipsis ${colorHex && !ev.isCompleted ? '' : `${fallbackBgClass} text-white`}`}
                            style={{
                                left: leftPos,
                                width: widthCalc,
                                top: topPos,
                                height: '18px',
                                minHeight: '18px',
                                zIndex: 10,
                                ...(colorHex && !ev.isCompleted ? { backgroundColor: colorHex, color: getReadableTextColor(recordColor) } : {}),
                            }}
                            onClick={(e) => {
                                e.stopPropagation();
                                const date = `${year}-${String(month + 1).padStart(2, '0')}-${String(ev.startDay).padStart(2, '0')}`;
                                onDateClick(date);
                            }}
                        >
                            {ev.isFirst ? (ev.service || ev.title || 'Запись') : ''}
                        </div>
                    );
                })}
            </div>
        </div>
    );
};
