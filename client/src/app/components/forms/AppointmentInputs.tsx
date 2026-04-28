import React, { useRef } from 'react';
import { getDateStr, matchId } from '@/utils/helpers';
import { ServicesPicker, ServiceLine, PriceListItem } from '@/app/components/ui/ServicesPicker';

interface Category {
    id: string;
    name: string;
    type: string;
    color: string;
}

interface Tag {
    id: string | number;
    name: string;
    color?: string;
}

interface AppointmentData {
    // Старое legacy-поле — заполняется автоматически из services.map(s=>s.name).join(', ')
    // (для совместимости с другими местами, читающими data.service).
    service?: string;
    // Новый массив услуг — основной источник правды.
    services?: ServiceLine[];
    date?: string;
    time?: string;
    endDate?: string;
    category?: string;
    tags?: (string | number)[];
    // amount теперь автозаполняется из суммы services.price, поле readOnly в UI.
    amount?: string | number;
    advance?: string | number;
    advanceDate?: string;
    paymentStatus?: string;
    master_id?: string | null;
}

interface StudioMember {
    id: string;
    name: string;
    role?: string;
    is_active?: boolean;
}

// Канал onChange полиморфен: проксирует как нативные input/select события
// (`{ target: { name, value } }`), так и батч-обновления
// (`{ target: { name: '_batch', value: <partial> } }`), которые потребитель
// раскладывает через setState(prev => ({ ...prev, ...value })). Из-за этого
// `value` намеренно any — строгий union здесь не сужается, а type guard
// размывает дискриминирующее поле name.
interface AppointmentInputsProps {
    data: AppointmentData;
    onChange: (e: { target: { name: string; value: any } }) => void;
    categories?: Category[];
    tags?: Tag[];
    masters?: StudioMember[];
    // Прайс-лист студии (services таблица). Загружается родителем один
    // раз через api.getServices, передаётся вниз — в форме, открытой
    // несколько раз подряд, не дёргает /services при каждой повторной отрисовке.
    priceList?: PriceListItem[];
}

export const AppointmentInputs: React.FC<AppointmentInputsProps> = ({ data, onChange, categories, tags, masters, priceList = [] }) => {
    const endDateRef = useRef<HTMLInputElement>(null);
    
    const handleDateChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        onChange(e);
        if (e.target.name === 'date' && e.target.value) {
            // Если конца нет — копируем начало.
            // Если конец РАНЬШЕ нового начала — двигаем его вперёд, чтобы не остался невалидным.
            if (!data.endDate || data.endDate < e.target.value) {
                onChange({ target: { name: 'endDate', value: e.target.value } });
            }
        }
    };
    
    const handleEndDateChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const newEndDate = e.target.value;
        if (data.date && newEndDate && newEndDate < data.date) {
            return;
        }
        onChange(e);
    };
    
    const handleAdvanceChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const raw = e.target.value.replace(/[^0-9.]/g, '');
        const value = raw === '' ? '' : raw.replace(/^0+(\d)/, '$1');
        if (value && parseFloat(value) > 0 && !data.advanceDate) {
            onChange({ target: { name: '_batch', value: { advance: value, advanceDate: getDateStr(0) } } });
        } else {
            onChange({ target: { name: 'advance', value } });
        }
    };
    
    const toggleTag = (tagId: string | number) => {
        const strId = String(tagId);
        const currentTags = (data.tags || []).map(String);
        const newTags = currentTags.includes(strId)
            ? currentTags.filter(t => t !== strId)
            : [...currentTags, strId];
        onChange({ target: { name: 'tags', value: newTags } });
    };
    // Обработчик изменения списка услуг: получает новый массив + сумму,
    // батч-апдейтит три поля родителя одновременно (services, service-legacy,
    // amount). _batch — общая convention в этом компоненте, родитель его
    // раскладывает через setState(prev => ({...prev, ...value})).
    const handleServicesChange = (next: ServiceLine[], totalAmount: number) => {
        onChange({
            target: {
                name: '_batch',
                value: {
                    services: next,
                    // Legacy-поле для обратной совместимости с местами, где
                    // используется data.service напрямую (бэк его всё равно
                    // переписывает на сервере, см. resolveServices).
                    service: next.map(s => s.name).filter(Boolean).join(', '),
                    amount: totalAmount,
                },
            },
        });
    };

    return (
        <div className="space-y-3">
            <ServicesPicker
                value={data.services || []}
                onChange={handleServicesChange}
                priceList={priceList}
            />

            <div className="flex gap-3">
                <div className="flex-1">
                    <span className="text-xs text-gray-400 font-semibold block mb-2">Дата начала</span>
                    <input 
                        type="date" 
                        name="date" 
                        value={String(data.date || '')} 
                        onChange={handleDateChange} 
                        className="w-full bg-white border border-zinc-300 rounded-xl p-4 font-medium text-black outline-none focus:border-orange-500 shadow-sm"
                    />
                </div>
                <div className="w-28">
                    <span className="text-xs text-gray-400 font-semibold block mb-2">Время</span>
                    <input 
                        type="time" 
                        name="time" 
                        value={String(data.time || '')} 
                        onChange={onChange} 
                        className="w-full bg-white border border-zinc-300 rounded-xl p-4 font-medium text-black outline-none focus:border-orange-500 shadow-sm text-center"
                    />
                </div>
            </div>
            
            <div>
                <span className="text-xs text-gray-400 font-semibold block mb-2">Дата окончания</span>
                <input 
                    ref={endDateRef}
                    type="date" 
                    name="endDate" 
                    value={String(data.endDate || '')} 
                    min={data.date || ''}
                    onChange={handleEndDateChange} 
                    className="w-full bg-white border border-zinc-300 rounded-xl p-4 font-medium text-black outline-none focus:border-orange-500 shadow-sm"
                />
            </div>
            
            <div className="grid grid-cols-2 gap-3">
                {categories && categories.length > 0 && (
                    <div>
                        <span className="text-xs text-gray-400 font-semibold block mb-2">Категория</span>
                        <div className="flex flex-wrap gap-1.5">
                            {categories.filter(cat => cat.type === 'income').map(cat => (
                                <button
                                    key={cat.id}
                                    type="button"
                                    onClick={() => onChange({ target: { name: 'category', value: matchId(data.category, cat.id) ? '' : String(cat.id) }})}
                                    className={`inline-flex items-center gap-1 px-2.5 py-1.5 rounded-full text-[11px] font-semibold transition-all ${
                                        matchId(data.category, cat.id) 
                                        ? 'bg-orange-500 text-white shadow-lg shadow-orange-500/30' 
                                        : 'bg-gray-100 text-gray-600'
                                    }`}
                                >
                                    <div 
                                        className="w-2 h-2 rounded-full" 
                                        style={{ backgroundColor: cat.color }}
                                    />
                                    {cat.name}
                                </button>
                            ))}
                        </div>
                    </div>
                )}
                {tags && tags.filter(t => !(t as any).type || (t as any).type === 'income' || (t as any).type === 'all').length > 0 && (
                    <div>
                        <span className="text-xs text-gray-400 font-semibold block mb-2">Теги</span>
                        <div className="flex flex-wrap gap-1.5">
                            {tags.filter(t => !(t as any).type || (t as any).type === 'income' || (t as any).type === 'all').map(tag => (
                                <button
                                    key={tag.id}
                                    type="button"
                                    onClick={() => toggleTag(tag.id)}
                                    className={`inline-flex items-center gap-1 px-2.5 py-1.5 rounded-full text-[11px] font-semibold transition-all ${
                                        (data.tags || []).some(id => matchId(id, tag.id))
                                        ? 'bg-blue-500 text-white shadow-lg shadow-blue-500/30' 
                                        : 'bg-gray-100 text-gray-600'
                                    }`}
                                >
                                    {tag.color && (
                                        <div 
                                            className="w-2 h-2 rounded-full" 
                                            style={{ backgroundColor: tag.color }}
                                        />
                                    )}
                                    {tag.name}
                                </button>
                            ))}
                        </div>
                    </div>
                )}
            </div>
            
            {masters && masters.length > 0 && (
                <div>
                    <span className="text-xs text-gray-400 font-semibold block mb-2">Мастер</span>
                    <select
                        name="master_id"
                        value={data.master_id ?? ''}
                        onChange={(e) => onChange({ target: { name: 'master_id', value: e.target.value } })}
                        className="w-full bg-white border border-zinc-300 rounded-xl p-4 font-medium text-black outline-none focus:border-orange-500 shadow-sm"
                    >
                        <option value="">Не назначен</option>
                        {masters
                            .filter(m => m.is_active !== false)
                            .map(m => (
                                <option key={m.id} value={m.id}>{m.name}</option>
                            ))}
                    </select>
                </div>
            )}

            <div>
                <span className="text-xs text-gray-400 font-semibold block mb-2">
                    Общая сумма услуги
                    {(data.services && data.services.length > 0) && (
                        <span className="ml-2 text-[10px] font-normal text-zinc-400">
                            (рассчитывается автоматически из услуг выше)
                        </span>
                    )}
                </span>
                <input
                    type="text"
                    name="amount"
                    value={data.amount ? `${Number(data.amount).toLocaleString('ru-RU')} ₽` : ''}
                    readOnly
                    placeholder="0 ₽"
                    className="w-full bg-zinc-50 border border-zinc-200 rounded-xl p-4 text-lg font-bold text-zinc-700 outline-none cursor-default"
                />
            </div>
            
            <div className="flex gap-3">
                <div className="flex-1">
                    <span className="text-xs text-gray-400 font-semibold block mb-2">Аванс</span>
                    <input 
                        type="text" 
                        name="advance" 
                        value={data.advance ? String(data.advance) : ''} 
                        onChange={handleAdvanceChange} 
                        placeholder="0 ₽" 
                        className="w-full bg-white border border-zinc-300 rounded-xl p-4 font-bold text-black outline-none focus:border-orange-500 shadow-sm" 
                    />
                </div>
                <div className="flex-1">
                    <span className="text-xs text-gray-400 font-semibold block mb-2">Дата аванса</span>
                    <input 
                        type="date" 
                        name="advanceDate" 
                        value={String(data.advanceDate || '')} 
                        onChange={onChange} 
                        className="w-full bg-white border border-zinc-300 rounded-xl p-4 font-medium text-black outline-none focus:border-orange-500 shadow-sm" 
                    />
                </div>
            </div>
            
            <div>
                <span className="text-xs text-gray-400 font-semibold block mb-2">Оплата</span>
                <div className="flex gap-2">
                    <button
                        type="button"
                        onClick={() => onChange({ target: { name: 'paymentStatus', value: 'none' }})}
                        className={`flex-1 px-2 py-2 rounded-xl text-xs font-semibold transition-all ${
                            data.paymentStatus === 'none' || !data.paymentStatus
                            ? 'bg-orange-500 text-white shadow-lg shadow-orange-500/30' 
                            : 'bg-gray-100 text-gray-400'
                        }`}
                    >
                        Не оплачено
                    </button>
                    <button
                        type="button"
                        onClick={() => onChange({ target: { name: 'paymentStatus', value: 'advance' }})}
                        className={`flex-1 px-2 py-2 rounded-xl text-xs font-semibold transition-all ${
                            data.paymentStatus === 'advance' 
                            ? 'bg-orange-500 text-white shadow-lg shadow-orange-500/30' 
                            : 'bg-gray-100 text-gray-400'
                        }`}
                    >
                        Аванс
                    </button>
                    <button
                        type="button"
                        onClick={() => onChange({ target: { name: 'paymentStatus', value: 'paid' }})}
                        className={`flex-1 px-2 py-2 rounded-xl text-xs font-semibold transition-all ${
                            data.paymentStatus === 'paid' 
                            ? 'bg-orange-500 text-white shadow-lg shadow-orange-500/30' 
                            : 'bg-gray-100 text-gray-400'
                        }`}
                    >
                        Оплачено
                    </button>
                </div>
            </div>
        </div>
    );
};
