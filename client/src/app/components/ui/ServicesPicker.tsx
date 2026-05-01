/**
 * ServicesPicker — управление списком услуг в брони.
 *
 * Юзер видит:
 *   • Список выбранных услуг (имя + цена + кнопка «×»)
 *   • Две кнопки добавления:
 *       — «Из прайса»     — выпадашка из прайс-листа студии (services table)
 *       — «Своя услуга»   — добавляет пустую строку, юзер вводит имя+цену вручную
 *   • Итоговая сумма всех строк (live-расчёт)
 *
 * Props:
 *   value      — текущий массив строк услуг (контролируемый компонент)
 *   onChange   — колбэк (newValue, totalAmount) ← родитель пишет в state
 *   priceList  — список услуг из прайса студии (загружается родителем
 *                один раз через api.getServices, передаётся вниз).
 *   readOnly   — если true, компонент в режиме просмотра (master),
 *                без кнопок и редактирования.
 *
 * Не делаем сам fetch внутри: компонент может рендериться несколько раз
 * в разных формах (Календарь, Карточка клиента), а прайс — один на студию;
 * пусть его грузит родитель (или App-уровень) и пробрасывает вниз.
 */

import { useState, useRef } from 'react';
import { Plus, X, Pencil, Check, ChevronDown, ChevronRight } from 'lucide-react';

export interface ServiceLine {
  service_id: number | null;
  name: string;
  price: number;
}

export interface PriceListItem {
  id: number;
  name: string;
  price: number;
  is_active: boolean;
  category_id?: number | null;
  category_name?: string | null;
  category_color?: string | null;
}

interface ServicesPickerProps {
  value: ServiceLine[];
  onChange: (next: ServiceLine[], totalAmount: number) => void;
  priceList: PriceListItem[];
  readOnly?: boolean;
}

const fmt = (n: number) => Math.round(n).toLocaleString('ru-RU');

const sumPrices = (rows: ServiceLine[]) =>
  rows.reduce((s, r) => s + (Number(r.price) || 0), 0);

export const ServicesPicker = ({ value, onChange, priceList, readOnly }: ServicesPickerProps) => {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [collapsedCats, setCollapsedCats] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState('');
  const [dropPos, setDropPos] = useState<{ top: number; left: number; width: number } | null>(null);
  const rowRef = useRef<HTMLDivElement>(null);

  const update = (next: ServiceLine[]) => {
    const forSum = next.filter(r => r.service_id !== null || r.name.trim() !== '');
    onChange(next, sumPrices(forSum));
  };

  const selectedIds = new Set(value.filter(r => r.service_id !== null).map(r => r.service_id));

  const toggleFromPrice = (item: PriceListItem) => {
    if (selectedIds.has(item.id)) {
      const idx = value.findIndex(r => r.service_id === item.id);
      update(value.filter((_, i) => i !== idx));
    } else {
      update([...value, { service_id: item.id, name: item.name, price: Number(item.price) || 0 }]);
    }
  };

  const addCustom = () => {
    update([...value, { service_id: null, name: '', price: 0 }]);
    setPickerOpen(false);
  };

  const removeAt = (idx: number) => update(value.filter((_, i) => i !== idx));

  const updateCustomField = (idx: number, field: 'name' | 'price', raw: string) => {
    update(value.map((row, i) => {
      if (i !== idx) return row;
      if (field === 'price') return { ...row, price: Number(raw.replace(/[^0-9.]/g, '')) || 0 };
      return { ...row, name: raw };
    }));
  };

  const toggleCat = (key: string) => {
    setCollapsedCats(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const total = sumPrices(value);
  const activePriceList = priceList.filter((p) => p.is_active !== false);

  const q = search.trim().toLowerCase();
  const filtered = q ? activePriceList.filter(p => p.name.toLowerCase().includes(q)) : activePriceList;

  const grouped: Array<{ key: string; label: string; color: string; items: PriceListItem[] }> = [];
  if (q) {
    grouped.push({ key: '__search__', label: '', color: '', items: filtered });
  } else {
    const byCategory = new Map<string, { label: string; color: string; items: PriceListItem[] }>();
    for (const item of activePriceList) {
      const key = item.category_id ? String(item.category_id) : '__none__';
      const label = item.category_name || 'Без категории';
      const color = item.category_color || '#71717a';
      if (!byCategory.has(key)) byCategory.set(key, { label, color, items: [] });
      byCategory.get(key)!.items.push(item);
    }
    for (const [key, val] of byCategory) {
      if (key !== '__none__') grouped.push({ key, ...val });
    }
    const none = byCategory.get('__none__');
    if (none) grouped.push({ key: '__none__', ...none });
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-xs text-gray-400 font-semibold">Услуги</span>
        {value.length > 0 && (
          <span className="text-xs text-zinc-500">
            Итого: <span className="font-bold text-zinc-900">{fmt(total)}&nbsp;₽</span>
          </span>
        )}
      </div>

      {value.length === 0 ? (
        <p className="text-sm text-zinc-400 italic px-1 py-2">
          {readOnly ? 'Услуги не указаны' : 'Добавьте услугу из прайса или введите свою'}
        </p>
      ) : (
        <ul className="space-y-1.5">
          {value.map((row, idx) => {
            const isCustom = row.service_id == null;
            return (
              <li key={idx} className="flex items-center gap-2 bg-zinc-50 border border-zinc-200 rounded-xl px-3 py-2">
                {isCustom ? (
                  <>
                    <Pencil size={14} className="text-zinc-400 shrink-0" />
                    <input
                      type="text"
                      value={row.name}
                      onChange={(e) => updateCustomField(idx, 'name', e.target.value)}
                      placeholder="Название услуги"
                      disabled={readOnly}
                      className="flex-1 min-w-0 bg-transparent outline-none text-sm font-medium text-zinc-900 placeholder:text-zinc-300 placeholder:italic truncate"
                    />
                    <input
                      type="text"
                      inputMode="numeric"
                      value={row.price > 0 ? String(Math.round(row.price)) : ''}
                      onChange={(e) => updateCustomField(idx, 'price', e.target.value)}
                      placeholder="0"
                      disabled={readOnly}
                      className="w-16 bg-transparent outline-none text-sm font-bold text-zinc-900 text-right placeholder:text-zinc-300 shrink-0"
                    />
                    <span className="text-xs text-zinc-500 shrink-0">₽</span>
                  </>
                ) : (
                  <>
                    <span className="flex-1 min-w-0 text-sm font-medium text-zinc-900 truncate" title={row.name}>
                      {row.name}
                    </span>
                    <input
                      type="text"
                      inputMode="numeric"
                      value={row.price > 0 ? String(Math.round(row.price)) : '0'}
                      onChange={(e) => updateCustomField(idx, 'price', e.target.value)}
                      disabled={readOnly}
                      className="w-20 bg-transparent outline-none text-sm font-bold text-zinc-900 text-right shrink-0"
                    />
                    <span className="text-xs text-zinc-500 shrink-0">₽</span>
                  </>
                )}
                {!readOnly && (
                  <button
                    type="button"
                    onClick={() => removeAt(idx)}
                    className="text-zinc-400 hover:text-red-500 transition-colors p-0.5 -mr-0.5 shrink-0"
                    aria-label="Удалить услугу"
                  >
                    <X size={16} />
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {!readOnly && (
        <div className="flex gap-2 pt-1" ref={rowRef}>
          <button
            type="button"
            onClick={() => {
              if (!pickerOpen && rowRef.current) {
                const rect = rowRef.current.getBoundingClientRect();
                setDropPos({ top: rect.bottom + 4, left: rect.left, width: rect.width });
              }
              setPickerOpen((v) => !v);
              setSearch('');
            }}
            className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl bg-zinc-100 hover:bg-zinc-200 text-zinc-700 text-sm font-medium transition-colors"
          >
            <Plus size={16} />
            Из прайса
          </button>
          <button
            type="button"
            onClick={addCustom}
            className="flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl bg-zinc-100 hover:bg-zinc-200 text-zinc-700 text-sm font-medium transition-colors"
          >
            <Pencil size={14} />
            Своя
          </button>

          {pickerOpen && (
            <>
              <div className="fixed inset-0 z-30" onClick={() => setPickerOpen(false)} />
              <div
                className="fixed bg-white border border-zinc-200 rounded-xl shadow-lg z-40 max-h-[60vh] flex flex-col"
                style={dropPos ? { top: dropPos.top, left: dropPos.left, width: dropPos.width } : { top: 0, left: 0, right: 0 }}
              >
                <div className="px-3 pt-2 pb-1.5 border-b border-zinc-100 shrink-0">
                  <input
                    type="text"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Поиск услуги…"
                    autoFocus
                    onClick={(e) => e.stopPropagation()}
                    className="w-full text-sm outline-none text-zinc-800 placeholder:text-zinc-300"
                  />
                </div>
                <div className="overflow-y-auto flex-1">
                  {activePriceList.length === 0 ? (
                    <p className="text-sm text-zinc-400 italic px-3 py-3 text-center">
                      Прайс-лист пуст. Заполните его в Профиле → Прайс-лист услуг.
                    </p>
                  ) : filtered.length === 0 ? (
                    <p className="text-sm text-zinc-400 italic px-3 py-3 text-center">Ничего не найдено</p>
                  ) : q ? (
                    filtered.map((p) => {
                      const isSelected = selectedIds.has(p.id);
                      return (
                        <button
                          key={p.id}
                          type="button"
                          onClick={(e) => { e.stopPropagation(); toggleFromPrice(p); }}
                          className={'w-full flex items-center gap-2.5 px-3 py-2 text-left border-b border-zinc-100 last:border-b-0 transition-colors ' + (isSelected ? 'bg-orange-50' : 'hover:bg-zinc-50')}
                        >
                          <div className={'w-4 h-4 rounded flex items-center justify-center shrink-0 border transition-colors ' + (isSelected ? 'bg-orange-500 border-orange-500' : 'border-zinc-300')}>
                            {isSelected && <Check size={11} className="text-white" strokeWidth={3} />}
                          </div>
                          <span className="flex-1 min-w-0 text-sm font-medium text-zinc-900 truncate" title={p.name}>{p.name}</span>
                          <span className="text-sm font-bold text-zinc-700 whitespace-nowrap shrink-0">{fmt(Number(p.price))}&nbsp;₽</span>
                        </button>
                      );
                    })
                  ) : (
                    grouped.map(({ key, label, color, items: grpItems }) => {
                      const isCollapsed = collapsedCats.has(key);
                      return (
                        <div key={key}>
                          {grouped.length > 1 && (
                            <button
                              type="button"
                              onClick={(e) => { e.stopPropagation(); toggleCat(key); }}
                              className="w-full flex items-center gap-2 px-3 py-1.5 bg-zinc-50 hover:bg-zinc-100 text-left"
                            >
                              <div className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: color }} />
                              <span className="flex-1 text-xs font-bold text-zinc-500 uppercase tracking-wide">{label}</span>
                              <span className="text-xs text-zinc-400">{grpItems.length}</span>
                              {isCollapsed ? <ChevronRight size={12} className="text-zinc-400" /> : <ChevronDown size={12} className="text-zinc-400" />}
                            </button>
                          )}
                          {!isCollapsed && grpItems.map((p) => {
                            const isSelected = selectedIds.has(p.id);
                            return (
                              <button
                                key={p.id}
                                type="button"
                                onClick={(e) => { e.stopPropagation(); toggleFromPrice(p); }}
                                className={'w-full flex items-center gap-2.5 px-3 py-2 text-left border-b border-zinc-100 last:border-b-0 transition-colors ' + (isSelected ? 'bg-orange-50' : 'hover:bg-zinc-50')}
                              >
                                <div className={'w-4 h-4 rounded flex items-center justify-center shrink-0 border transition-colors ' + (isSelected ? 'bg-orange-500 border-orange-500' : 'border-zinc-300')}>
                                  {isSelected && <Check size={11} className="text-white" strokeWidth={3} />}
                                </div>
                                <span className="flex-1 min-w-0 text-sm font-medium text-zinc-900 truncate" title={p.name}>{p.name}</span>
                                <span className="text-sm font-bold text-zinc-700 whitespace-nowrap shrink-0">{fmt(Number(p.price))}&nbsp;₽</span>
                              </button>
                            );
                          })}
                        </div>
                      );
                    })
                  )}
                </div>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
};
