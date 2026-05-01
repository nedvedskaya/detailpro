import { useState, useMemo } from 'react';
import { Plus, X, ArrowDownLeft, ArrowUpRight, Wallet, Edit3, Trash2, ChevronLeft, ChevronRight, TrendingUp, TrendingDown, Tag, BarChart3, ChevronDown, Download } from 'lucide-react';
import { PieChart, Pie, Cell, ResponsiveContainer } from 'recharts';
import { TransactionItem } from '@/app/components/TransactionItem';

// Импорт утилит и констант
import { BTN_METAL_DARK, BTN_METAL, CARD_METAL, COLORS, TRANSACTION_TYPES } from '@/utils/constants';
import { exportToExcel, TRANSACTIONS_COLUMNS, createTransactionRowMapper } from '@/utils/excelExport';
import { formatMoney, formatDate, formatDateShort, getDateStr, toDateStr, findCategoryById, findTagsByIds, matchId } from '@/utils/helpers';
import { getInitialTransactionState } from '@/utils/initialStates';
import { validateTransaction, hasErrors } from '@/utils/validation';
import { Header } from '@/app/components/ui/Header';
import { Button } from '@/app/components/ui/Button';
import { Modal } from '@/app/components/ui/Modal';
import { ColorPicker } from '@/app/components/ui/ColorPicker';
import { ToggleGroup } from '@/app/components/ui/ToggleGroup';

interface FinanceViewProps {
    transactions: any[];
    onAddTransaction: (transaction: any) => void;
    onEditTransaction: (transaction: any) => void;
    onDeleteTransaction: (id: string) => void;
    categories: any[];
    onAddCategory: (category: any) => void;
    onEditCategory: (id: string, updates: any) => void;
    onDeleteCategory: (id: string) => void;
    tags: any[];
    onAddTag: (tag: any) => void;
    onDeleteTag: (id: string) => void;
    // canEdit=false → manager без can_view_finance сюда не попадёт вовсе (App.tsx
    // проверяет viewerCanViewFinance перед рендером). Прокидывается на случай,
    // если в будущем разрешим финансы менеджеру в read-only.
    canEdit?: boolean;
}

export const FinanceView = ({ transactions, onAddTransaction, onEditTransaction, onDeleteTransaction, categories, onAddCategory, onEditCategory, onDeleteCategory, tags, onAddTag, onDeleteTag, canEdit = true }: FinanceViewProps) => {
    const [activeSection, setActiveSection] = useState<'operations' | 'analytics'>('operations');
    const [isAdding, setIsAdding] = useState(false);
    const [editingTransaction, setEditingTransaction] = useState(null);
    const [newTransaction, setNewTransaction] = useState(getInitialTransactionState());
    
    // New transaction state
    const [selectedCategory, setSelectedCategory] = useState<string>('');
    const [selectedTags, setSelectedTags] = useState<string[]>([]);
    const [isAddingNewCategory, setIsAddingNewCategory] = useState(false);
    const [isAddingNewTag, setIsAddingNewTag] = useState(false);
    const [isEditingCategories, setIsEditingCategories] = useState(false);
    const [isEditingTags, setIsEditingTags] = useState(false);
    const [newCategoryName, setNewCategoryName] = useState('');
    const [newTagName, setNewTagName] = useState('');
    const [newCategoryColor, setNewCategoryColor] = useState(COLORS[0]);
    const [newTagColor, setNewTagColor] = useState(COLORS[0]);
    
    // Analytics state
    const [viewMode, setViewMode] = useState<'income' | 'expense'>('expense');
    const [timeFilter, setTimeFilter] = useState<'day' | 'week' | 'month' | 'year'>('month');
    const [currentDate, setCurrentDate] = useState(new Date());
    const [isAddingCategory, setIsAddingCategory] = useState(false);
    const [editingCategory, setEditingCategory] = useState<any>(null);
    const [newCategory, setNewCategory] = useState({ name: '', color: COLORS[0], type: 'expense' });
    const [serviceFilter, setServiceFilter] = useState<string>('all');
    const [expandedCategories, setExpandedCategories] = useState<Set<string>>(new Set());

    // Переключение раскрытия категории
    const toggleCategoryExpand = (categoryId: string) => {
        setExpandedCategories(prev => {
            const newSet = new Set(prev);
            if (newSet.has(categoryId)) {
                newSet.delete(categoryId);
            } else {
                newSet.add(categoryId);
            }
            return newSet;
        });
    };

    // Получаем список услуг из транзакций
    const services = useMemo(() => {
        const serviceSet = new Set(transactions.map(t => t.description).filter(Boolean));
        return ['all', ...Array.from(serviceSet)];
    }, [transactions]);

    // Фильтрация транзакций по времени для аналитики
    const filteredTransactions = useMemo(() => {
        const now = currentDate;
        let filtered = transactions.filter(t => t.type === viewMode);

        if (timeFilter === 'day') {
            // Получаем локальную дату в формате YYYY-MM-DD
            const today = getDateStr(0);
            
            filtered = filtered.filter(t => {
                const d = toDateStr(t.date || t.createdDate);
                return d === today;
            });
        } else if (timeFilter === 'week') {
            const weekStart = new Date(now);
            weekStart.setDate(now.getDate() - now.getDay());
            const weekEnd = new Date(weekStart);
            weekEnd.setDate(weekStart.getDate() + 6);
            const wsStr = toDateStr(weekStart);
            const weStr = toDateStr(weekEnd);
            filtered = filtered.filter(t => {
                const d = toDateStr(t.date);
                return d >= wsStr && d <= weStr;
            });
        } else if (timeFilter === 'month') {
            const mPrefix = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`;
            filtered = filtered.filter(t => {
                return toDateStr(t.date).startsWith(mPrefix);
            });
        } else if (timeFilter === 'year') {
            const yPrefix = `${now.getFullYear()}`;
            filtered = filtered.filter(t => {
                return toDateStr(t.date).startsWith(yPrefix);
            });
        }

        // Фильтр по услугам
        if (serviceFilter !== 'all') {
            filtered = filtered.filter(t => t.description === serviceFilter);
        }

        return filtered;
    }, [transactions, viewMode, timeFilter, currentDate, serviceFilter]);

    // Группировка по категориям
    const categoryStats = useMemo(() => {
        const stats: Record<string, { amount: number; count: number; percentage: number; category: any }> = {};
        const total = filteredTransactions.reduce((sum, t) => sum + (Number(t.amount) || 0), 0);

        filteredTransactions.forEach(t => {
            const catId = t.category ? String(t.category) : 'uncategorized';
            if (!stats[catId]) {
                const cat = findCategoryById(categories, catId) || { id: catId, name: 'Без категории', color: '#94a3b8' };
                stats[catId] = { amount: 0, count: 0, percentage: 0, category: cat };
            }
            stats[catId].amount += Number(t.amount) || 0;
            stats[catId].count += 1;
        });

        // Подсчет процентов
        Object.keys(stats).forEach(key => {
            stats[key].percentage = total > 0 ? (stats[key].amount / total) * 100 : 0;
        });

        return Object.values(stats).sort((a, b) => b.amount - a.amount);
    }, [filteredTransactions, categories]);

    const totalAmount = useMemo(() => 
        filteredTransactions.reduce((sum, t) => sum + (Number(t.amount) || 0), 0)
    , [filteredTransactions]);

    // Навигация по времени
    const navigateTime = (direction: 'prev' | 'next') => {
        const newDate = new Date(currentDate);
        if (timeFilter === 'day') {
            newDate.setDate(newDate.getDate() + (direction === 'next' ? 1 : -1));
        } else if (timeFilter === 'week') {
            newDate.setDate(newDate.getDate() + (direction === 'next' ? 7 : -7));
        } else if (timeFilter === 'month') {
            newDate.setMonth(newDate.getMonth() + (direction === 'next' ? 1 : -1));
        } else if (timeFilter === 'year') {
            newDate.setFullYear(newDate.getFullYear() + (direction === 'next' ? 1 : -1));
        }
        setCurrentDate(newDate);
    };

    const getDateLabel = () => {
        if (timeFilter === 'day') {
            return formatDate(toDateStr(currentDate));
        } else if (timeFilter === 'week') {
            const weekStart = new Date(currentDate);
            weekStart.setDate(currentDate.getDate() - currentDate.getDay());
            const weekEnd = new Date(weekStart);
            weekEnd.setDate(weekStart.getDate() + 6);
            return `${formatDate(toDateStr(weekStart))} - ${formatDate(toDateStr(weekEnd))}`;
        } else if (timeFilter === 'month') {
            return currentDate.toLocaleDateString('ru-RU', { month: 'long' });
        } else {
            return currentDate.getFullYear().toString();
        }
    };

    const handleSaveCategory = () => {
        if (editingCategory) {
            onEditCategory(editingCategory.id, newCategory);
            setEditingCategory(null);
        } else {
            onAddCategory({ ...newCategory, id: `temp_cat_${Date.now()}` });
        }
        setIsAddingCategory(false);
        setNewCategory({ name: '', color: COLORS[0], type: 'expense' });
    };
    
    // Карточка «Баланс» в шапке Операций показывает доходы/расходы только
    // за ТЕКУЩИЙ календарный месяц — пользователь хочет видеть результат
    // месяца, а не накопленный итог за всё время. Для аналитики и фильтров
    // по периоду в других вкладках используется отдельная логика (см.
    // selectedPeriod ниже), которая на эту карточку не влияет.
    const monthFilteredTx = useMemo(() => {
        const now = new Date();
        const y = now.getFullYear();
        const m = now.getMonth();
        return transactions.filter(t => {
            if (!t.date) return false;
            const d = new Date(t.date);
            return d.getFullYear() === y && d.getMonth() === m;
        });
    }, [transactions]);
    const income = useMemo(() => monthFilteredTx.filter(t => t.type === 'income').reduce((acc, t) => acc + Number(t.amount || 0), 0), [monthFilteredTx]);
    const expense = useMemo(() => monthFilteredTx.filter(t => t.type === 'expense').reduce((acc, t) => acc + Number(t.amount || 0), 0), [monthFilteredTx]);
    const balance = income - expense;
    
    const handleSaveTransaction = () => {
        const txErrors = validateTransaction({ amount: newTransaction.amount });
        if (hasErrors(txErrors)) {
          alert(Object.values(txErrors)[0]);
          return;
        }
        if (!newTransaction.title || newTransaction.title.trim() === '') return;
        
        const transactionData = {
            ...newTransaction,
            amount: parseFloat(newTransaction.amount) || 0,
            category: selectedCategory,
            tags: selectedTags,
        };
        
        if (editingTransaction) {
            // Объединяем данные редактируемой транзакции с новыми данными
            const updated = {
                ...(editingTransaction as any),
                ...transactionData,
            };
            onEditTransaction(updated);
        } else {
            onAddTransaction(transactionData);
        }
        
        setIsAdding(false);
        setEditingTransaction(null);
        setNewTransaction(getInitialTransactionState());
        setSelectedCategory('');
        setSelectedTags([]);
    };
    
    const toggleTag = (tagId: string | number) => {
        const strId = String(tagId);
        setSelectedTags(prev => 
            prev.includes(strId) ? prev.filter(id => id !== strId) : [...prev, strId]
        );
    };
    
    const handleAddQuickCategory = () => {
        if (!newCategoryName.trim()) return;
        const newCat = {
            id: `temp_cat_${Date.now()}`,
            name: newCategoryName,
            color: newCategoryColor,
            type: newTransaction.type
        };
        onAddCategory(newCat);
        setSelectedCategory(newCat.id);
        setNewCategoryName('');
        setIsAddingNewCategory(false);
    };
    
    const handleAddQuickTag = () => {
        if (!newTagName.trim()) return;
        // type = тип текущей операции → тег появится только в доходах или
        // только в расходах. Чтобы создать общий тег ('all') — пользователь
        // делает это в разделе клиентов/записей; здесь тег всегда «прописан»
        // к типу финансовой операции.
        const newTag = {
            id: `temp_tag_${Date.now()}`,
            name: newTagName.toUpperCase(),
            color: newTagColor,
            type: newTransaction.type,
        };
        onAddTag(newTag);
        setSelectedTags([...selectedTags, newTag.id]);
        setNewTagName('');
        setIsAddingNewTag(false);
    };
    
    const filteredCategories = categories.filter(c => c.type === newTransaction.type);
    // Фильтр тегов по типу операции: показываем теги, помеченные как
    // 'all' (общие, видны и в доходах, и в расходах) либо совпадающие с
    // типом текущей операции. Старые теги без поля type считаем общими.
    const filteredTags = tags.filter(t => {
      const tagType = t.type || 'all';
      return tagType === 'all' || tagType === newTransaction.type;
    });
    
    const handleEditClick = (t) => {
        setEditingTransaction(t);
        const desc = (t.description || '').replace('Оплата: ', '').replace('Аванс: ', '');
        const dateStr = toDateStr(t.date || t.createdDate);
        setNewTransaction(prev => ({
            ...prev,
            title: desc,
            amount: t.amount,
            type: t.type,
            sub: '',
            category: t.category ? String(t.category) : prev.category,
            account: t.account || prev.account,
            date: dateStr,
            time: t.time ? t.time.slice(0, 5) : '',
        }));
        setSelectedCategory(t.category ? String(t.category) : '');
        setSelectedTags(Array.isArray(t.tags) ? t.tags.map(String) : []);
        setIsAdding(true);
    };
    
    const incomeTransactions = transactions.filter(t => t.type === 'income');
    const expenseTransactions = transactions.filter(t => t.type === 'expense');
    
    // Группировка транзакций по датам
    const transactionsByDate = useMemo(() => {
        const grouped: Record<string, any[]> = {};
        
        const sorted = [...transactions].sort((a, b) => {
            const dateA = toDateStr(a.date || a.createdDate);
            const dateB = toDateStr(b.date || b.createdDate);
            const dateCmp = dateB.localeCompare(dateA);
            if (dateCmp !== 0) return dateCmp;
            const timeA = a.time || '00:00';
            const timeB = b.time || '00:00';
            return timeB.localeCompare(timeA);
        });
        
        sorted.forEach(t => {
            const dateKey = t.date || t.createdDate || getDateStr(0);
            if (!grouped[dateKey]) {
                grouped[dateKey] = [];
            }
            grouped[dateKey].push(t);
        });
        
        return grouped;
    }, [transactions]);
    
    const handleExportToExcel = () => {
        exportToExcel({
            sheetName: 'Операции',
            fileName: 'Финансы',
            columns: TRANSACTIONS_COLUMNS,
            data: transactions,
            rowMapper: createTransactionRowMapper(categories, tags)
        });
    };
    
    return (
      <div className="flex flex-col h-full bg-zinc-50 overflow-hidden relative">
        {isAdding && (
            <div className="fixed inset-0 z-[260] bg-zinc-900/50 backdrop-blur-sm flex items-end animate-in fade-in desktop-sheet-center" onClick={() => {
                setIsAdding(false); 
                setEditingTransaction(null); 
                setNewTransaction(getInitialTransactionState());
                setSelectedCategory('');
                setSelectedTags([]);
                setIsEditingCategories(false);
                setIsEditingTags(false);
            }}>
                <div className="w-full bg-white rounded-t-[32px] shadow-2xl max-h-[90dvh] overflow-y-auto" style={{paddingTop: 'max(env(safe-area-inset-top, 0px), 24px)', paddingBottom: 'calc(100px + env(safe-area-inset-bottom, 20px))', paddingLeft: '24px', paddingRight: '24px'}} onClick={(e) => e.stopPropagation()}>
                    <div className="flex justify-between items-center mb-6 sticky top-0 bg-white pt-2 pb-2 z-10">
                        <h3 className="text-2xl font-black">{editingTransaction ? 'Редактировать' : 'Новая операция'}</h3>
                        <button onClick={() => { 
                            setIsAdding(false); 
                            setEditingTransaction(null); 
                            setNewTransaction(getInitialTransactionState());
                            setSelectedCategory('');
                            setSelectedTags([]);
                            setIsEditingCategories(false);
                            setIsEditingTags(false);
                        }} className="bg-zinc-100 p-3 rounded-full min-w-[44px] min-h-[44px] flex items-center justify-center">
                            <X size={22}/>
                        </button>
                    </div>
                    <div className="space-y-4">
                        <div>
                            <label className="text-xs font-bold text-zinc-400 uppercase tracking-wide mb-2 block">Тип операции</label>
                            <ToggleGroup
                                options={[
                                    { value: 'income', label: TRANSACTION_TYPES.income.label, icon: ArrowDownLeft },
                                    { value: 'expense', label: TRANSACTION_TYPES.expense.label, icon: ArrowUpRight }
                                ]}
                                value={newTransaction.type}
                                onChange={(value) => setNewTransaction({...newTransaction, type: value as 'income' | 'expense'})}
                                variant="default"
                            />
                        </div>
                        <div>
                            <label className="text-xs font-bold text-zinc-400 uppercase tracking-wide mb-2 block">Название</label>
                            <input 
                                type="text" 
                                value={newTransaction.title} 
                                onChange={(e) => setNewTransaction({...newTransaction, title: e.target.value})}
                                placeholder="Например: Зарплата, Аренда..." 
                                className="w-full bg-zinc-50 border border-zinc-200 rounded-xl p-4 text-sm font-bold outline-none focus:border-orange-500 transition-all" 
                            />
                        </div>
                        <div>
                            <label className="text-xs font-bold text-zinc-400 uppercase tracking-wide mb-2 block">Сумма</label>
                            <input 
                                type="number" 
                                value={newTransaction.amount} 
                                onChange={(e) => setNewTransaction({...newTransaction, amount: e.target.value})}
                                placeholder="0" 
                                className="w-full bg-zinc-50 border border-zinc-200 rounded-xl p-4 text-2xl font-black outline-none focus:border-orange-500 transition-all" 
                            />
                        </div>
                        <div className="grid grid-cols-2 gap-3">
                            <div>
                                <label className="text-xs font-bold text-zinc-400 uppercase tracking-wide mb-2 block">Дата</label>
                                <input 
                                    type="date" 
                                    value={newTransaction.date} 
                                    onChange={(e) => setNewTransaction({...newTransaction, date: e.target.value})}
                                    className="w-full bg-zinc-50 border border-zinc-200 rounded-xl p-4 text-sm font-bold outline-none focus:border-orange-500 transition-all" 
                                />
                            </div>
                            <div>
                                <label className="text-xs font-bold text-zinc-400 uppercase tracking-wide mb-2 block">Время</label>
                                <input 
                                    type="time" 
                                    value={newTransaction.time || ''} 
                                    onChange={(e) => setNewTransaction({...newTransaction, time: e.target.value})}
                                    className="w-full bg-zinc-50 border border-zinc-200 rounded-xl p-4 text-sm font-bold outline-none focus:border-orange-500 transition-all" 
                                />
                            </div>
                        </div>
                        <div>
                            <label className="text-xs font-bold text-zinc-400 uppercase tracking-wide mb-2 block">Описание (необязательно)</label>
                            <input 
                                type="text" 
                                value={newTransaction.sub} 
                                onChange={(e) => setNewTransaction({...newTransaction, sub: e.target.value})}
                                placeholder="Дополнительная информация..." 
                                className="w-full bg-zinc-50 border border-zinc-200 rounded-xl p-4 text-sm font-medium outline-none focus:border-orange-500 transition-all" 
                            />
                        </div>
                        {/* Категория - компактный блок */}
                        <div>
                            <div className="flex items-center justify-between mb-2">
                                <label className="text-xs font-bold text-zinc-400 uppercase tracking-wider">Категория</label>
                                <div className="flex items-center gap-3">
                                    {filteredCategories.length > 0 && (
                                        <button 
                                            onClick={() => setIsEditingCategories(!isEditingCategories)}
                                            className={`text-[11px] font-bold transition-all ${isEditingCategories ? 'text-red-500' : 'text-zinc-400 hover:text-zinc-600'}`}
                                        >
                                            {isEditingCategories ? 'Готово' : 'Удалить'}
                                        </button>
                                    )}
                                    <button 
                                        onClick={() => setIsAddingNewCategory(true)}
                                        className="text-[11px] font-bold text-zinc-600 hover:text-black transition-all"
                                    >
                                        + Добавить
                                    </button>
                                </div>
                            </div>
                            {filteredCategories.length > 0 ? (
                                <div className="flex flex-wrap gap-2">
                                    {filteredCategories.map(cat => (
                                        <div
                                            key={cat.id}
                                            className={`inline-flex items-center gap-1.5 px-3 py-2 rounded-full text-xs font-bold transition-all cursor-pointer ${
                                                isEditingCategories
                                                ? 'bg-red-50 border border-red-200 text-red-700 animate-pulse-subtle'
                                                : matchId(selectedCategory, cat.id) 
                                                    ? 'bg-orange-500 text-white shadow-md' 
                                                    : 'bg-white border border-zinc-200 text-zinc-700 hover:border-zinc-300'
                                            }`}
                                            onClick={() => {
                                                if (isEditingCategories) {
                                                    if (confirm(`Удалить категорию "${cat.name}"?`)) {
                                                        onDeleteCategory(cat.id);
                                                        if (matchId(selectedCategory, cat.id)) setSelectedCategory('');
                                                    }
                                                } else {
                                                    setSelectedCategory(matchId(selectedCategory, cat.id) ? '' : String(cat.id));
                                                }
                                            }}
                                        >
                                            <div 
                                                className="w-2 h-2 rounded-full" 
                                                style={{ backgroundColor: isEditingCategories ? undefined : cat.color }}
                                            />
                                            {cat.name}
                                            {isEditingCategories && <X size={12} className="ml-0.5 text-red-500" />}
                                        </div>
                                    ))}
                                </div>
                            ) : (
                                <p className="text-xs text-zinc-400 italic">Нет категорий</p>
                            )}
                        </div>
                        {/* Теги - компактный блок */}
                        <div>
                            <div className="flex items-center justify-between mb-2">
                                <label className="text-xs font-bold text-zinc-400 uppercase tracking-wider">Теги</label>
                                <div className="flex items-center gap-3">
                                    {filteredTags.length > 0 && (
                                        <button
                                            onClick={() => setIsEditingTags(!isEditingTags)}
                                            className={`text-[11px] font-bold transition-all ${isEditingTags ? 'text-red-500' : 'text-zinc-400 hover:text-zinc-600'}`}
                                        >
                                            {isEditingTags ? 'Готово' : 'Удалить'}
                                        </button>
                                    )}
                                    <button 
                                        onClick={() => setIsAddingNewTag(true)}
                                        className="text-[11px] font-bold text-zinc-600 hover:text-black transition-all"
                                    >
                                        + Добавить
                                    </button>
                                </div>
                            </div>
                            {filteredTags.length > 0 ? (
                                <div className="flex flex-wrap gap-2">
                                    {filteredTags.map(tag => (
                                        <div
                                            key={tag.id}
                                            className={`inline-flex items-center gap-1.5 px-3 py-2 rounded-full text-xs font-bold transition-all cursor-pointer ${
                                                isEditingTags
                                                ? 'bg-red-50 border border-red-200 text-red-700 animate-pulse-subtle'
                                                : selectedTags.some(id => matchId(id, tag.id))
                                                    ? 'bg-orange-500 text-white shadow-md' 
                                                    : 'bg-white border border-zinc-200 text-zinc-700 hover:border-zinc-300'
                                            }`}
                                            onClick={() => {
                                                if (isEditingTags) {
                                                    if (confirm(`Удалить тег "${tag.name}"?`)) {
                                                        onDeleteTag(tag.id);
                                                        setSelectedTags(prev => prev.filter(id => String(id) !== String(tag.id)));
                                                    }
                                                } else {
                                                    toggleTag(tag.id);
                                                }
                                            }}
                                        >
                                            <div 
                                                className="w-2 h-2 rounded-full" 
                                                style={{ backgroundColor: isEditingTags ? undefined : (tag.color || COLORS[0]) }}
                                            />
                                            {tag.name}
                                            {isEditingTags && <X size={12} className="ml-0.5 text-red-500" />}
                                        </div>
                                    ))}
                                </div>
                            ) : (
                                <p className="text-xs text-zinc-400 italic">Нет тегов</p>
                            )}
                        </div>
                        <Button
                            variant="primary"
                            size="lg"
                            fullWidth
                            onClick={handleSaveTransaction}
                            className="mt-6"
                        >
                            {editingTransaction ? 'Сохранить' : 'Добавить операцию'}
                        </Button>
                    </div>
                </div>
            </div>
        )}

        {/* Модальное окно добавления категории */}
        <Modal
            isOpen={isAddingNewCategory}
            onClose={() => {
                setIsAddingNewCategory(false);
                setNewCategoryName('');
                setNewCategoryColor(COLORS[0]);
            }}
            title="Новая категория"
            position="center"
            maxWidth="md"
        >
            <input 
                type="text" 
                value={newCategoryName} 
                onChange={(e) => setNewCategoryName(e.target.value)}
                placeholder="Название категории..."
                className="w-full bg-zinc-50 border-2 border-zinc-200 p-4 rounded-xl outline-none text-base font-bold focus:border-orange-500 transition-all mb-4"
                autoFocus
            />
            <ColorPicker
                colors={COLORS}
                selectedColor={newCategoryColor}
                onColorSelect={setNewCategoryColor}
                label="Цвет"
            />
            <div className="flex gap-3 mt-6">
                <Button
                    variant="secondary"
                    onClick={() => {
                        setIsAddingNewCategory(false);
                        setNewCategoryName('');
                        setNewCategoryColor(COLORS[0]);
                    }}
                    fullWidth
                >
                    Отмена
                </Button>
                <Button
                    variant="primary"
                    onClick={handleAddQuickCategory}
                    fullWidth
                >
                    Сохранить
                </Button>
            </div>
        </Modal>

        {/* Модальное окно добавления тега */}
        <Modal
            isOpen={isAddingNewTag}
            onClose={() => {
                setIsAddingNewTag(false);
                setNewTagName('');
                setNewTagColor(COLORS[0]);
            }}
            title="Новый тег"
            position="center"
            maxWidth="md"
        >
            <input 
                type="text" 
                value={newTagName} 
                onChange={(e) => setNewTagName(e.target.value)}
                placeholder="Название тега..."
                className="w-full bg-zinc-50 border-2 border-zinc-200 p-4 rounded-xl outline-none text-base font-bold focus:border-orange-500 transition-all mb-4"
                autoFocus
            />
            <ColorPicker
                colors={COLORS}
                selectedColor={newTagColor}
                onColorSelect={setNewTagColor}
                label="Цвет"
            />
            <div className="flex gap-3 mt-6">
                <Button
                    variant="secondary"
                    onClick={() => {
                        setIsAddingNewTag(false);
                        setNewTagName('');
                        setNewTagColor(COLORS[0]);
                    }}
                    fullWidth
                >
                    Отмена
                </Button>
                <Button
                    variant="primary"
                    onClick={handleAddQuickTag}
                    fullWidth
                >
                    Сохранить
                </Button>
            </div>
        </Modal>
        
        <Header
            title="Финансы"
            actionIcon={canEdit && activeSection === 'operations' ? Plus : null}
            onAction={canEdit && activeSection === 'operations' ? () => setIsAdding(true) : null}
            secondaryIcon={Download}
            onSecondaryAction={handleExportToExcel}
            showSecondaryAction={activeSection === 'operations' && transactions.length > 0}
            variant="simple" 
        />
        
        {/* Переключатель разделов: Операции / Аналитика */}
        <div className="px-4 pt-2 pb-2 bg-white border-b border-zinc-200 shrink-0">
            <ToggleGroup
                options={[
                    { value: 'operations', label: 'ОПЕРАЦИИ', icon: Wallet },
                    { value: 'analytics', label: 'АНАЛИТИКА', icon: BarChart3 }
                ]}
                value={activeSection}
                onChange={(value) => setActiveSection(value as 'operations' | 'analytics')}
                variant="default"
            />
        </div>

        {/* Контент: Операции */}
        {activeSection === 'operations' && (
            <div className="flex-1 overflow-y-auto pb-32 bg-zinc-50">
              {/* Баланс - градиент как в аналитике */}
              <div className="px-6 pt-4 pb-3">
                <div className="bg-gradient-to-br from-orange-500 to-orange-600 rounded-3xl p-5 text-center shadow-xl">
                  <div className="text-sm font-medium text-white mb-1 uppercase tracking-wide">Баланс</div>
                  <div className="text-[11px] text-white/70 mb-2">за {new Date().toLocaleDateString('ru-RU', { month: 'long', year: 'numeric' })}</div>
                  <div className="text-4xl font-bold text-white mb-4 tracking-tight">{formatMoney(balance)} ₽</div>
                  <div className="flex gap-4 justify-center">
                      <div>
                          <div className="text-xs text-white/80 mb-1">{TRANSACTION_TYPES.income.label}</div>
                          <div className="text-xl font-bold text-white">+{formatMoney(income)}</div>
                      </div>
                      <div className="w-px bg-white/20"></div>
                      <div>
                          <div className="text-xs text-white/80 mb-1">{TRANSACTION_TYPES.expense.label}</div>
                          <div className="text-xl font-bold text-white">−{formatMoney(expense)}</div>
                      </div>
                  </div>
                </div>
              </div>

              {/* Операции по датам */}
              {Object.keys(transactionsByDate).length > 0 ? (
                  <div className="px-4 pb-4">
                      {Object.keys(transactionsByDate).map(dateKey => {
                          const dayTransactions = transactionsByDate[dateKey];
                          
                          return (
                              <div key={dateKey}>
                                  {/* Дата - тонкий элегантный разделитель */}
                                  <div className="sticky top-0 bg-zinc-50 z-10 py-2">
                                      <div className="flex items-center gap-3">
                                          <div className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">{formatDateShort(dateKey)}</div>
                                          <div className="flex-1 h-px bg-zinc-200"></div>
                                      </div>
                                  </div>
                                  
                                  {/* Транзакции */}
                                  <div className="space-y-1">
                                      {dayTransactions.map(t => {
                                          const category = findCategoryById(categories, t.category);
                                          const transactionTags = findTagsByIds(tags, t.tags || []);
                                          
                                          return (
                                              <TransactionItem
                                                  key={t.id}
                                                  transaction={t}
                                                  category={category}
                                                  tags={transactionTags}
                                                  // В read-only прячем меню Edit/Delete: TransactionItem
                                                  // не рендерит экшены, если onEdit/onDelete = undefined.
                                                  onEdit={!canEdit ? undefined : (transaction) => {
                                                      setEditingTransaction(transaction);
                                                      const transactionTitle = transaction.title || transaction.description || '';
                                                      const dateStr = toDateStr(transaction.date || transaction.createdDate);
                                                      setNewTransaction(prev => ({
                                                          ...prev,
                                                          title: transactionTitle.replace('Оплата: ', '').replace('Аванс: ', ''),
                                                          amount: transaction.amount,
                                                          type: transaction.type,
                                                          sub: transaction.sub || '',
                                                          category: transaction.category ? String(transaction.category) : prev.category,
                                                          account: transaction.account || prev.account,
                                                          date: dateStr,
                                                          time: transaction.time ? transaction.time.slice(0, 5) : '',
                                                      }));
                                                      setSelectedCategory(transaction.category || '');
                                                      setSelectedTags(Array.isArray(transaction.tags) ? transaction.tags : []);
                                                      setIsAdding(true);
                                                  }}
                                                  onDelete={canEdit ? onDeleteTransaction : undefined}
                                              />
                                          );
                                      })}
                                  </div>
                              </div>
                          );
                      })}
                  </div>
              ) : null}
              
              {transactions.length === 0 && (
                  <div className="text-center py-16 px-6">
                    <div className="text-gray-300 mb-3">
                        <Wallet size={48} className="mx-auto" />
                    </div>
                    <p className="text-base font-medium text-gray-400">Нет операций</p>
                  </div>
              )}
            </div>
        )}

        {/* Контент: Аналитика */}
        {activeSection === 'analytics' && (
            <div className="flex-1 overflow-y-auto pb-24 bg-white">
                {/* Минималистичная шапка */}
                <div className="px-6 pt-6 pb-4">
                    {/* Переключатель Расходы/Доходы */}
                    <div className="flex gap-3 mb-4">
                        <button
                            onClick={() => setViewMode('expense')}
                            className={`flex-1 py-3 rounded-2xl text-base font-semibold transition-all ${
                                viewMode === 'expense'
                                ? 'bg-orange-500 text-white shadow-lg shadow-orange-500/30'
                                : 'bg-gray-100 text-gray-400'
                            }`}
                        >
                            {TRANSACTION_TYPES.expense.labelPlural}
                        </button>
                        <button
                            onClick={() => setViewMode('income')}
                            className={`flex-1 py-3 rounded-2xl text-base font-semibold transition-all ${
                                viewMode === 'income'
                                ? 'bg-orange-500 text-white shadow-lg shadow-orange-500/30'
                                : 'bg-gray-100 text-gray-400'
                            }`}
                        >
                            {TRANSACTION_TYPES.income.labelPlural}
                        </button>
                    </div>

                    {/* Фильтры времени */}
                    <div className="flex gap-2">
                        {[
                            { value: 'day', label: 'День' },
                            { value: 'week', label: 'Неделя' },
                            { value: 'month', label: 'Месяц' },
                            { value: 'year', label: 'Год' }
                        ].map((filter) => (
                            <button
                                key={filter.value}
                                onClick={() => setTimeFilter(filter.value as any)}
                                className={`flex-1 py-2 rounded-xl text-sm font-medium transition-all ${
                                    timeFilter === filter.value
                                    ? 'text-orange-500 bg-orange-50'
                                    : 'text-gray-400 bg-transparent'
                                }`}
                            >
                                {filter.label}
                            </button>
                        ))}
                    </div>
                </div>

                {/* Навигация по датам */}
                <div className="px-6 pb-6 flex items-center justify-center gap-4">
                    <button 
                        onClick={() => navigateTime('prev')} 
                        className="w-10 h-10 rounded-full flex items-center justify-center hover:bg-gray-50 transition-all"
                    >
                        <ChevronLeft size={20} className="text-gray-400" />
                    </button>
                    <span className="text-lg font-semibold text-gray-900 min-w-[140px] text-center">{getDateLabel()}</span>
                    <button 
                        onClick={() => navigateTime('next')} 
                        className="w-10 h-10 rounded-full flex items-center justify-center hover:bg-gray-50 transition-all"
                    >
                        <ChevronRight size={20} className="text-gray-400" />
                    </button>
                </div>

                {/* Компактная главная метрика */}
                <div className="px-4 pb-4">
                    <div className="bg-gradient-to-br from-orange-500 to-orange-600 rounded-2xl p-5 text-center shadow-lg">
                        <div className="text-xs font-semibold text-orange-100 mb-1 uppercase tracking-wide">
                            {TRANSACTION_TYPES[viewMode as keyof typeof TRANSACTION_TYPES]?.labelPlural}
                        </div>
                        <div className="text-4xl font-black text-white tracking-tight">
                            {formatMoney(totalAmount)} ₽
                        </div>
                    </div>
                </div>

                {/* Компактная круговая диаграмма */}
                {categoryStats.length > 0 && (
                    <div className="px-4 pb-4">
                        <div className="bg-gray-50 rounded-2xl p-4">
                            <ResponsiveContainer width="100%" height={180}>
                                <PieChart>
                                    <Pie
                                        data={categoryStats.map(s => ({ name: s.category.name, value: s.amount }))}
                                        cx="50%"
                                        cy="50%"
                                        innerRadius={50}
                                        outerRadius={80}
                                        paddingAngle={3}
                                        dataKey="value"
                                    >
                                        {categoryStats.map((entry, index) => (
                                            <Cell key={`cell-${index}`} fill={entry.category.color} />
                                        ))}
                                    </Pie>
                                </PieChart>
                            </ResponsiveContainer>
                            
                            {/* Легенда с названиями категорий */}
                            <div className="mt-4 flex flex-wrap gap-x-4 gap-y-2">
                                {categoryStats.map((stat) => (
                                    <div key={String(stat.category.id)} className="flex items-center gap-2">
                                        <div 
                                            className="w-2.5 h-2.5 rounded-full shrink-0" 
                                            style={{ backgroundColor: stat.category.color }}
                                        />
                                        <span className="text-xs font-semibold text-gray-700">
                                            {stat.category.name}
                                        </span>
                                        <span className="text-xs text-gray-400 font-medium">
                                            {Math.round(stat.percentage)}%
                                        </span>
                                    </div>
                                ))}
                            </div>
                        </div>
                    </div>
                )}

                {/* Компактный список категорий */}
                <div className="px-4 pb-4">
                    <div className="space-y-2">
                        {categoryStats.length > 0 ? (
                            categoryStats.map((stat) => {
                                const catKey = String(stat.category.id);
                                const isExpanded = expandedCategories.has(catKey);
                                const categoryTransactions = filteredTransactions.filter(t => 
                                    String(t.category || 'uncategorized') === catKey
                                );
                                
                                return (
                                    <div 
                                        key={catKey} 
                                        className="bg-white rounded-xl border border-gray-100 overflow-hidden"
                                    >
                                        {/* Заголовок категории */}
                                        <div 
                                            className="p-3 cursor-pointer hover:bg-gray-50 transition-colors"
                                            onClick={() => toggleCategoryExpand(catKey)}
                                        >
                                            <div className="flex items-start justify-between mb-2">
                                                <div className="flex items-center gap-2 flex-1 min-w-0">
                                                    <div 
                                                        className="w-3 h-3 rounded-full shrink-0" 
                                                        style={{ backgroundColor: stat.category.color }}
                                                    />
                                                    <span className="text-sm font-semibold text-gray-900 truncate">
                                                        {stat.category.name}
                                                    </span>
                                                    <ChevronDown 
                                                        size={16} 
                                                        className={`text-gray-400 transition-transform shrink-0 ${isExpanded ? 'rotate-180' : ''}`} 
                                                    />
                                                </div>
                                                <span className="text-xs text-gray-400 font-medium ml-2 shrink-0">
                                                    {Math.round(stat.percentage)}%
                                                </span>
                                            </div>
                                            <div className="text-lg font-bold text-gray-900 mb-2">
                                                {formatMoney(stat.amount)} ₽
                                            </div>
                                            <div className="bg-gray-100 h-1 rounded-full overflow-hidden">
                                                <div 
                                                    className="h-full rounded-full transition-all"
                                                    style={{ 
                                                        width: `${stat.percentage}%`,
                                                        backgroundColor: stat.category.color 
                                                    }}
                                                />
                                            </div>
                                        </div>

                                        {/* Раскрывающийся список операций, разбитый по тегам */}
                                        {isExpanded && (() => {
                                            const usedTagIds = [...new Set(categoryTransactions.flatMap(t => (t.tags || []).map(String)))];
                                            const usedTags = usedTagIds.map(tid => tags.find(tag => matchId(tag.id, tid))).filter(Boolean);
                                            
                                            if (usedTags.length === 0) {
                                                return (
                                                    <div className="border-t border-gray-100 bg-gray-50 px-3 py-2">
                                                        <div className="space-y-1.5">
                                                            {categoryTransactions.map(t => (
                                                                <div key={t.id} className="bg-white rounded-lg p-2 border border-gray-100">
                                                                    <div className="flex items-start justify-between">
                                                                        <span className="text-xs font-semibold text-gray-900 flex-1 mr-2">{t.description}</span>
                                                                        <span className="text-xs font-bold text-gray-900 shrink-0">{formatMoney(t.amount)} ₽</span>
                                                                    </div>
                                                                    {t.date && <div className="text-xs text-gray-400 mt-0.5">{formatDateShort(t.date)}</div>}
                                                                </div>
                                                            ))}
                                                        </div>
                                                    </div>
                                                );
                                            }

                                            const tagGroups: { tag: any; txns: any[]; total: number }[] = usedTags.map(tag => {
                                                const txns = categoryTransactions.filter(t => (t.tags || []).some((tid: any) => matchId(tid, tag.id)));
                                                return { tag, txns, total: txns.reduce((s, t) => s + Number(t.amount), 0) };
                                            }).filter(g => g.txns.length > 0);

                                            const taggedTxnIds = new Set(tagGroups.flatMap(g => g.txns.map((t: any) => t.id)));
                                            const noTagTxns = categoryTransactions.filter(t => !taggedTxnIds.has(t.id));

                                            return (
                                                <div className="border-t border-gray-100 bg-gray-50 px-3 py-2 space-y-3">
                                                    {tagGroups.map(group => (
                                                        <div key={String(group.tag.id)}>
                                                            <div className="flex items-center justify-between mb-1.5">
                                                                <div className="flex items-center gap-1.5">
                                                                    <div className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: group.tag.color || '#94a3b8' }} />
                                                                    <span className="text-[11px] font-bold text-gray-500 uppercase tracking-wider">{group.tag.name}</span>
                                                                    <span className="text-xs text-gray-400">{group.txns.length} оп.</span>
                                                                </div>
                                                                <span className="text-xs font-bold text-gray-800">{formatMoney(group.total)} ₽</span>
                                                            </div>
                                                            <div className="space-y-1">
                                                                {group.txns.map((t: any) => (
                                                                    <div key={t.id} className="bg-white rounded-lg px-2.5 py-1.5 border border-gray-100">
                                                                        <div className="flex items-start justify-between gap-2">
                                                                            <span className="text-[11px] font-semibold text-gray-900 flex-1 leading-tight">{t.description}</span>
                                                                            <span className="text-[11px] font-bold text-gray-900 shrink-0">{formatMoney(t.amount)} ₽</span>
                                                                        </div>
                                                                        {t.date && <div className="text-xs text-gray-400 mt-0.5">{formatDateShort(t.date)}</div>}
                                                                    </div>
                                                                ))}
                                                            </div>
                                                        </div>
                                                    ))}
                                                    {noTagTxns.length > 0 && (
                                                        <div>
                                                            <div className="flex items-center justify-between mb-1.5">
                                                                <div className="flex items-center gap-1.5">
                                                                    <div className="w-2 h-2 rounded-full shrink-0 bg-gray-300" />
                                                                    <span className="text-[11px] font-bold text-gray-400 uppercase tracking-wider">Без тега</span>
                                                                    <span className="text-xs text-gray-400">{noTagTxns.length} оп.</span>
                                                                </div>
                                                                <span className="text-xs font-bold text-gray-800">{formatMoney(noTagTxns.reduce((s, t) => s + Number(t.amount), 0))} ₽</span>
                                                            </div>
                                                            <div className="space-y-1">
                                                                {noTagTxns.map(t => (
                                                                    <div key={t.id} className="bg-white rounded-lg px-2.5 py-1.5 border border-gray-100">
                                                                        <div className="flex items-start justify-between gap-2">
                                                                            <span className="text-[11px] font-semibold text-gray-900 flex-1 leading-tight">{t.description}</span>
                                                                            <span className="text-[11px] font-bold text-gray-900 shrink-0">{formatMoney(t.amount)} ₽</span>
                                                                        </div>
                                                                        {t.date && <div className="text-xs text-gray-400 mt-0.5">{formatDateShort(t.date)}</div>}
                                                                    </div>
                                                                ))}
                                                            </div>
                                                        </div>
                                                    )}
                                                </div>
                                            );
                                        })()}
                                    </div>
                                );
                            })
                        ) : (
                            <div className="p-8 text-center">
                                <p className="text-sm text-gray-400 font-medium">Нет данных</p>
                            </div>
                        )}
                    </div>
                </div>
            </div>
        )}
      </div>
    );
};