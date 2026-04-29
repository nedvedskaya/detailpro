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
 *
 * Не делаем сам fetch внутри: компонент может рендериться несколько раз
 * в разных формах (Календарь, Карточка клиента), а прайс — один на студию;
 * пусть его грузит родитель (или App-уровень) и пробрасывает вниз.
 */

import { useState } from 'react';
import { Plus, X, Pencil } from 'lucide-react';

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
}

interface ServicesPickerProps {
  value: ServiceLine[];
  onChange: (next: ServiceLine[], totalAmount: number) => void;
  priceList: PriceListItem[];
  // Если true — компонент в режиме просмотра (master), без кнопок и редактирования.
  readOnly?: boolean;
}

const sumPrices = (rows: ServiceLine[]) =>
  rows.reduce((s, r) => s + (Number(r.price) || 0), 0);

export const ServicesPicker = ({ value, onChange, priceList, readOnly }: ServicesPickerProps) => {
  // Открыт ли picker «Из прайса». Простой dropdown, без отдельной модалки —
  // на мобиле фокус остаётся на форме брони.
  const [pickerOpen, setPickerOpen] = useState(false);

  const update = (next: ServiceLine[]) => {
    onChange(next, sumPrices(next));
  };

  const addFromPrice = (item: PriceListItem) => {
    update([...value, { service_id: item.id, name: item.name, price: Number(item.price) || 0 }]);
    setPickerOpen(false);
  };

  const addCustom = () => {
    update([...value, { service_id: null, name: '', price: 0 }]);
  };

  const removeAt = (idx: number) => {
    update(value.filter((_, i) => i !== idx));
  };

  const updateCustomField = (idx: number, field: 'name' | 'price', raw: string) => {
    update(
      value.map((row, i) => {
        if (i !== idx) return row;
        if (field === 'price') {
          const p = Number(raw.replace(/[^0-9.]/g, '')) || 0;
          return { ...row, price: p };
        }
        return { ...row, name: raw };
      })
    );
  };

  const total = sumPrices(value);
  const activePriceList = priceList.filter((p) => p.is_active !== false);

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-xs text-gray-400 font-semibold">Услуги</span>
        {value.length > 0 && (
          <span className="text-xs text-zinc-500">
            Итого: <span className="font-bold text-zinc-900">{total.toLocaleString('ru-RU')}&nbsp;₽</span>
          </span>
        )}
      </div>

      {/* Список выбранных услуг. Каждая строка: имя + цена + крестик. */}
      {value.length === 0 ? (
        <p className="text-sm text-zinc-400 italic px-1 py-2">
          {readOnly ? 'Услуги не указаны' : 'Добавьте услугу из прайса или введите свою'}
        </p>
      ) : (
        <ul className="space-y-1.5">
          {value.map((row, idx) => {
            // Из прайса (service_id есть) — отображаем как нередактируемое имя.
            // Своя (service_id=null) — два инпута, имя и цена.
            const isCustom = row.service_id == null;
            return (
              <li
                key={idx}
                className="flex items-center gap-2 bg-zinc-50 border border-zinc-200 rounded-xl px-3 py-2"
              >
                {isCustom ? (
                  <>
                    <Pencil size={14} className="text-zinc-400 shrink-0" />
                    <input
                      type="text"
                      value={row.name}
                      onChange={(e) => updateCustomField(idx, 'name', e.target.value)}
                      placeholder="Название услуги"
                      disabled={readOnly}
                      className="flex-1 bg-transparent outline-none text-sm font-medium text-zinc-900 placeholder:text-zinc-300 placeholder:italic"
                    />
                    <input
                      type="text"
                      inputMode="numeric"
                      value={row.price > 0 ? String(row.price) : ''}
                      onChange={(e) => updateCustomField(idx, 'price', e.target.value)}
                      placeholder="0"
                      disabled={readOnly}
                      className="w-20 bg-transparent outline-none text-sm font-bold text-zinc-900 text-right placeholder:text-zinc-300"
                    />
                    <span className="text-xs text-zinc-500">₽</span>
                  </>
                ) : (
                  <>
                    {/* text-[13px] + break-words: меньший шрифт даёт длинному
                        названию шанс уместиться в одну строку, но если не
                        влезает — переносится, а не обрезается.
                        Раньше truncate делал «Полировка кузова Глянцев…» и
                        «Полировка кузова Детейл…» неотличимыми — мастер мог
                        промахнуться с услугой и взять не ту цену. */}
                    <span className="flex-1 text-[13px] font-medium text-zinc-900 break-words leading-snug">
                      {row.name}
                    </span>
                    <span className="text-[13px] font-bold text-zinc-900 whitespace-nowrap shrink-0">
                      {row.price.toLocaleString('ru-RU')}&nbsp;₽
                    </span>
                  </>
                )}
                {!readOnly && (
                  <button
                    type="button"
                    onClick={() => removeAt(idx)}
                    className="text-zinc-400 hover:text-red-500 transition-colors p-0.5 -mr-0.5"
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
        <div className="flex gap-2 pt-1">
          {/* Кнопка «Из прайса» — открывает inline-выпадашку. */}
          <div className="relative flex-1">
            <button
              type="button"
              onClick={() => setPickerOpen((v) => !v)}
              className="w-full flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl bg-zinc-100 hover:bg-zinc-200 text-zinc-700 text-sm font-medium transition-colors"
            >
              <Plus size={16} />
              Из прайса
            </button>
            {pickerOpen && (
              <>
                {/* Backdrop для закрытия по клику вне */}
                <div
                  className="fixed inset-0 z-30"
                  onClick={() => setPickerOpen(false)}
                />
                <div className="absolute top-full left-0 right-0 mt-1 bg-white border border-zinc-200 rounded-xl shadow-lg z-40 max-h-72 overflow-y-auto">
                  {activePriceList.length === 0 ? (
                    <p className="text-sm text-zinc-400 italic px-3 py-3 text-center">
                      Прайс-лист пуст. Заполните его в Профиле&nbsp;→&nbsp;Прайс-лист услуг.
                    </p>
                  ) : (
                    activePriceList.map((p) => (
                      <button
                        key={p.id}
                        type="button"
                        onClick={() => addFromPrice(p)}
                        className="w-full flex items-start justify-between gap-3 px-3 py-2.5 hover:bg-zinc-50 text-left border-b border-zinc-100 last:border-b-0"
                      >
                        {/* Без truncate — название переносится на несколько
                            строк целиком. Кнопка вырастает по высоте, цена
                            пристёгнута справа сверху (items-start). Это
                            критично для безопасности: похожие названия с
                            разной ценой не должны выглядеть одинаково. */}
                        <span className="flex-1 min-w-0 text-[13px] font-medium text-zinc-900 break-words leading-snug">{p.name}</span>
                        <span className="text-[13px] font-bold text-zinc-700 whitespace-nowrap shrink-0">
                          {Number(p.price).toLocaleString('ru-RU')}&nbsp;₽
                        </span>
                      </button>
                    ))
                  )}
                </div>
              </>
            )}
          </div>
          {/* Кнопка «Своя услуга» — добавляет пустую строку. */}
          <button
            type="button"
            onClick={addCustom}
            className="flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl bg-zinc-100 hover:bg-zinc-200 text-zinc-700 text-sm font-medium transition-colors"
          >
            <Pencil size={14} />
            Своя
          </button>
        </div>
      )}
    </div>
  );
};
