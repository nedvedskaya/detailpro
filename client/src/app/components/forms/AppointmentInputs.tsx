import React, { useRef } from 'react';
import { getDateStr, matchId } from '@/utils/helpers';

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
    service?: string;
    date?: string;
    time?: string;
    endDate?: string;
    category?: string;
    tags?: (string | number)[];
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
}

export const AppointmentInputs: React.FC<AppointmentInputsProps> = ({ data, onChange, categories, tags, masters }) => {
    const endDateRef = useRef<HTMLInputElement>(null);
    
    const handleDateChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        onChange(e);
        if (e.target.name === 'date' && e.target.value) {
            if (!data.endDate) {
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
    return (
        <div className="space-y-3">
            <input 
                type="text" 
                name="service" 
                value={String(data.service || '')} 
                onChange={onChange} 
                placeholder="Услуга / Деталь" 
                className="w-full bg-white border border-zinc-300 rounded-xl p-4 text-base font-medium text-black outline-none focus:border-black shadow-sm" 
            />
            
            <div className="flex gap-3">
                <div className="flex-1">
                    <span className="text-xs text-gray-400 font-semibold block mb-2">Дата начала</span>
                    <input 
                        type="date" 
                        name="date" 
                        value={String(data.date || '')} 
                        onChange={handleDateChange} 
                        className="w-full bg-white border border-zinc-300 rounded-xl p-4 font-medium text-black outline-none focus:border-black shadow-sm"
                    />
                </div>
                <div className="w-28">
                    <span className="text-xs text-gray-400 font-semibold block mb-2">Время</span>
                    <input 
                        type="time" 
                        name="time" 
                        value={String(data.time || '')} 
                        onChange={onChange} 
                        className="w-full bg-white border border-zinc-300 rounded-xl p-4 font-medium text-black outline-none focus:border-black shadow-sm text-center"
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
                    className="w-full bg-white border border-zinc-300 rounded-xl p-4 font-medium text-black outline-none focus:border-black shadow-sm"
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
                {tags && tags.length > 0 && (
                    <div>
                        <span className="text-xs text-gray-400 font-semibold block mb-2">Теги</span>
                        <div className="flex flex-wrap gap-1.5">
                            {tags.map(tag => (
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
                        className="w-full bg-white border border-zinc-300 rounded-xl p-4 font-medium text-black outline-none focus:border-black shadow-sm"
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
                <span className="text-xs text-gray-400 font-semibold block mb-2">Общая сумма услуги</span>
                <input 
                    type="text" 
                    name="amount" 
                    value={String(data.amount || '')} 
                    onChange={onChange} 
                    placeholder="0 ₽" 
                    className="w-full bg-white border border-zinc-300 rounded-xl p-4 text-lg font-bold text-black outline-none focus:border-black shadow-sm" 
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
                        className="w-full bg-white border border-zinc-300 rounded-xl p-4 font-bold text-black outline-none focus:border-black shadow-sm" 
                    />
                </div>
                <div className="flex-1">
                    <span className="text-xs text-gray-400 font-semibold block mb-2">Дата аванса</span>
                    <input 
                        type="date" 
                        name="advanceDate" 
                        value={String(data.advanceDate || '')} 
                        onChange={onChange} 
                        className="w-full bg-white border border-zinc-300 rounded-xl p-4 font-medium text-black outline-none focus:border-black shadow-sm" 
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
