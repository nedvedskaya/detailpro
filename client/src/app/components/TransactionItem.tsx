import { Edit3, Trash2 } from 'lucide-react';
import { formatMoney } from '@/utils/helpers';
import { COLORS } from '@/utils/constants';

interface TransactionItemProps {
    transaction: any;
    category: any;
    tags: any[];
    onEdit: (transaction: any) => void;
    onDelete: (id: string) => void;
}

export const TransactionItem = ({ transaction: t, category, tags: transactionTags, onEdit, onDelete }: TransactionItemProps) => {
    const isIncome = t.type === 'income';
    const timeStr = t.time ? t.time.slice(0, 5) : null;
    
    return (
        <div className="border-b border-gray-100 py-2.5 last:border-0">
            <div className="flex items-center gap-2">
                <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-1.5 min-w-0">
                            {timeStr && (
                                <span className="text-[10px] font-semibold text-zinc-400 shrink-0">{timeStr}</span>
                            )}
                            <span className="text-sm font-bold text-gray-900 truncate">{String(t.description || '')}</span>
                        </div>
                        <span className={`text-sm font-black shrink-0 ${isIncome ? 'text-green-600' : 'text-red-600'}`}>
                            {isIncome ? '+' : '-'}{formatMoney(t.amount)} ₽
                        </span>
                    </div>
                    {(category || transactionTags.length > 0) && (
                        <div className="flex flex-wrap gap-1 mt-1">
                            {category && (
                                <div className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-gray-100">
                                    <div className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: category.color }} />
                                    <span className="text-[10px] font-semibold text-gray-500">{category.name}</span>
                                </div>
                            )}
                            {transactionTags.map(tag => (
                                <div key={tag.id} className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-gray-100">
                                    <div className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: tag.color || COLORS[0] }} />
                                    <span className="text-[10px] font-semibold text-gray-500">{tag.name}</span>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
                <div className="flex gap-0.5 shrink-0">
                    <button onClick={() => onEdit(t)} className="text-zinc-300 hover:text-orange-600 transition-colors p-1">
                        <Edit3 size={13} />
                    </button>
                    <button 
                        onClick={() => { if (confirm(`Удалить операцию "${t.description}"?`)) onDelete(t.id); }}
                        className="text-zinc-300 hover:text-red-600 transition-colors p-1"
                    >
                        <Trash2 size={13} />
                    </button>
                </div>
            </div>
        </div>
    );
};
