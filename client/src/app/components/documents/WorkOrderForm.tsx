import { useEffect, useMemo, useState } from 'react';
import { Save, FileDown, Loader2, Plus, Trash2, ListPlus, Search } from 'lucide-react';
import { Modal } from '@/app/components/ui/Modal';
import { showToast } from '@/app/components/ui/Toast';
import { handleApiError } from '@/utils/stateHelpers';
import {
  api,
  WorkOrder,
  WorkOrderItem,
  PaymentMethod,
} from '@/utils/api';
import { SignaturePad } from './SignaturePad';

interface PriceRow {
  id: number;
  name: string;
  price: number | string;
  is_active: boolean;
}

/**
 * Форма заказ-наряда.
 *
 * Связка с бэком:
 *   GET  /api/work-orders/:bookingId        — текущий наряд (404 → новый)
 *   PUT  /api/work-orders/:bookingId        — upsert
 *   GET  /api/work-orders/:bookingId/pdf    — скачать PDF
 *
 * total считается на UI (subtotal − discount), на бэке тоже пересчитывается
 * для надёжности — клиент-side total не доверенный.
 */

interface WorkOrderFormProps {
  isOpen: boolean;
  onClose: () => void;
  bookingId: number;
  bookingTitle?: string;
  /** Стартовое заполнение услуг из брони (используется только при создании). */
  initialItems?: WorkOrderItem[];
  onSaved?: (wo: WorkOrder) => void;
}

const PAYMENT_OPTIONS: { value: PaymentMethod; label: string }[] = [
  { value: 'cash',     label: 'Наличные' },
  { value: 'card',     label: 'Карта' },
  { value: 'transfer', label: 'Перевод' },
];

const blankItem = (): WorkOrderItem => ({ name: '', quantity: 1, price: 0 });

function fmtRub(n: number): string {
  return n.toLocaleString('ru-RU', { minimumFractionDigits: 0, maximumFractionDigits: 2 }) + ' ₽';
}

// Локальный инпут с подписью для блоков «Заказчик» и «Автомобиль».
const FieldInput = ({
  label, value, onChange, placeholder, inputMode,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  inputMode?: 'text' | 'numeric' | 'tel';
}) => (
  <label className="block">
    <span className="block text-[11px] font-medium text-zinc-500 mb-1">{label}</span>
    <input
      type="text"
      inputMode={inputMode}
      value={value}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      // placeholder:text-zinc-300 + italic: чтобы пример «Toyota / Camry / 2020»
      // не выглядел заполненным значением. Фидбек: «в спешке не понимаешь
      // заполнен пункт или нет».
      className="w-full bg-white border border-zinc-200 rounded-lg px-3 py-2 text-sm outline-none focus:border-orange-500 transition-all placeholder:text-zinc-300 placeholder:italic"
    />
  </label>
);

export const WorkOrderForm = ({
  isOpen, onClose, bookingId, bookingTitle, initialItems, onSaved,
}: WorkOrderFormProps) => {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving]   = useState(false);
  const [wo, setWo]           = useState<WorkOrder | null>(null);

  const [items, setItems]                 = useState<WorkOrderItem[]>([]);
  const [discount, setDiscount]           = useState<string>('0');
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod | ''>('');
  const [deliveryDate, setDeliveryDate]   = useState<string>('');
  const [deliveryTime, setDeliveryTime]   = useState<string>('');
  const [guarantee, setGuarantee]         = useState<string>('');
  const [notes, setNotes]                 = useState<string>('');
  const [signature, setSignature]         = useState<string | null>(null);

  // Snapshot-поля. Заполняются из карточки клиента, если там есть данные.
  const [clientName, setClientName]   = useState('');
  const [clientPhone, setClientPhone] = useState('');
  const [carBrand, setCarBrand]       = useState('');
  const [carModel, setCarModel]       = useState('');
  const [carYear, setCarYear]         = useState('');
  const [carColor, setCarColor]       = useState('');
  const [carPlate, setCarPlate]       = useState('');
  const [carVin, setCarVin]           = useState('');

  const pickStr = (...vals: Array<string | number | null | undefined>): string => {
    for (const v of vals) {
      if (v !== null && v !== undefined && String(v).trim() !== '') return String(v);
    }
    return '';
  };

  // Загружаем существующий заказ-наряд + контекст параллельно.
  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    setLoading(true);
    Promise.all([
      api.getWorkOrder(bookingId).catch((err: any) => {
        if (err?.status === 404 || /not_found/i.test(String(err?.message))) return null;
        throw err;
      }),
      api.getDocumentContext(bookingId).catch(() => null),
    ])
      .then(([row, ctx]) => {
        if (cancelled) return;
        setWo(row);
        setItems(row && Array.isArray(row.items) && row.items.length > 0
          ? row.items
          : (initialItems && initialItems.length > 0 ? initialItems : [blankItem()]));
        setDiscount(String(Number(row?.discount) || 0));
        setPaymentMethod(row?.payment_method || '');
        // По умолчанию — текущие дата и время. Если в наряде уже сохранено своё —
        // используем его, иначе автоподстановка избавляет пользователя от лишнего ввода.
        const now = new Date();
        const pad = (n: number) => String(n).padStart(2, '0');
        const todayStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
        const timeStr  = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
        setDeliveryDate(row?.delivery_date ? String(row.delivery_date).slice(0, 10) : todayStr);
        setDeliveryTime(row?.delivery_time ? String(row.delivery_time).slice(0, 5)  : timeStr);
        setGuarantee(row?.guarantee_text || '');
        setNotes(row?.notes || '');
        setSignature(row?.signature_data || null);

        const cs = row?.client_snapshot  || {};
        const vs = row?.vehicle_snapshot || {};
        const cv = ctx?.client  || ({} as any);
        const vv = ctx?.vehicle || ({} as any);
        setClientName(pickStr(cs.name,  cv.name));
        setClientPhone(pickStr(cs.phone, cv.phone));
        setCarBrand(pickStr(vs.brand,  vv.brand));
        setCarModel(pickStr(vs.model,  vv.model));
        setCarYear(pickStr(vs.year,   vv.year));
        setCarColor(pickStr(vs.color,  vv.color));
        setCarPlate(pickStr(vs.license_plate, vv.license_plate));
        setCarVin(pickStr(vs.vin,     vv.vin));
      })
      .catch(() => {
        if (cancelled) return;
        showToast('Не удалось загрузить заказ-наряд', 'error');
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
    // initialItems специально не в deps — это «стартовое заполнение», не должно дёргать перезагрузку.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, bookingId]);

  const updateItem = (idx: number, patch: Partial<WorkOrderItem>) => {
    setItems((arr) => arr.map((it, i) => i === idx ? { ...it, ...patch } : it));
  };
  const addItem    = () => setItems((arr) => [...arr, blankItem()]);
  const removeItem = (idx: number) => setItems((arr) => arr.length > 1 ? arr.filter((_, i) => i !== idx) : arr);

  // ── Пикер «Из прайса» ──────────────────────────────────────────
  const [pickerOpen, setPickerOpen]       = useState(false);
  const [priceRows, setPriceRows]         = useState<PriceRow[]>([]);
  const [priceLoading, setPriceLoading]   = useState(false);
  const [priceQuery, setPriceQuery]       = useState('');
  const [pickerSelected, setPickerSelected] = useState<Set<number>>(new Set());

  const openPicker = () => {
    setPickerOpen(true);
    setPickerSelected(new Set());
    setPriceQuery('');
    setPriceLoading(true);
    api.getServices()
      .then((rows: any[]) => setPriceRows((rows || []).filter((r) => r.is_active !== false)))
      .catch(() => showToast('Не удалось загрузить прайс', 'error'))
      .finally(() => setPriceLoading(false));
  };

  const filteredPriceRows = useMemo(() => {
    const q = priceQuery.trim().toLowerCase();
    if (!q) return priceRows;
    return priceRows.filter((r) => r.name.toLowerCase().includes(q));
  }, [priceRows, priceQuery]);

  const togglePickerRow = (id: number) => {
    setPickerSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const applyPickerSelection = () => {
    const picked = priceRows.filter((r) => pickerSelected.has(r.id));
    if (picked.length === 0) return;
    const newRows: WorkOrderItem[] = picked.map((r) => ({
      name: r.name,
      quantity: 1,
      price: Number(r.price) || 0,
    }));
    // Если в текущем списке только одна пустая строка — заменяем её, иначе добавляем сверху.
    setItems((arr) => {
      const onlyBlank = arr.length === 1 && !arr[0].name.trim() && !arr[0].price;
      return onlyBlank ? newRows : [...arr, ...newRows];
    });
    setPickerOpen(false);
  };

  const { subtotal, total } = useMemo(() => {
    const sub = items.reduce((s, it) => s + (Number(it.quantity) || 0) * (Number(it.price) || 0), 0);
    const disc = Math.max(0, Number(discount) || 0);
    return { subtotal: sub, total: Math.max(0, sub - disc) };
  }, [items, discount]);

  // Внутренний сейв. silent=true → без тоста "Заказ-наряд сохранён"
  // (используется при автосохранении перед скачиванием PDF).
  const persist = async (silent = false): Promise<WorkOrder | null> => {
    // Лёгкая валидация: имя у каждой услуги.
    const cleanItems = items
      .map((it) => ({
        name: (it.name || '').trim(),
        quantity: Number(it.quantity) || 0,
        price: Number(it.price) || 0,
      }))
      .filter((it) => it.name.length > 0);

    if (cleanItems.length === 0) {
      showToast('Добавьте хотя бы одну услугу', 'warning');
      return null;
    }

    setSaving(true);
    try {
      const yearNum = carYear.trim() === '' ? null : (parseInt(carYear, 10) || null);
      const payload = {
        items: cleanItems,
        discount: Math.max(0, Number(discount) || 0),
        total,                                          // подсказка, бэк всё равно пересчитает
        payment_method: paymentMethod === '' ? null : paymentMethod,
        delivery_date: deliveryDate || null,
        delivery_time: deliveryTime || null,
        guarantee_text: guarantee.trim() || null,
        notes: notes.trim() || null,
        client_snapshot: {
          name:  clientName.trim()  || null,
          phone: clientPhone.trim() || null,
          email: null,
        },
        vehicle_snapshot: {
          brand:         carBrand.trim() || null,
          model:         carModel.trim() || null,
          color:         carColor.trim() || null,
          license_plate: carPlate.trim() || null,
          vin:           carVin.trim()   || null,
          year:          yearNum,
        },
        signature_data: signature,
      };
      const saved = await api.saveWorkOrder(bookingId, payload);
      setWo(saved);
      if (!silent) showToast('Заказ-наряд сохранён', 'success');
      onSaved?.(saved);
      return saved;
    } catch (err) {
      // Коды (signature_too_large/_invalid, items_invalid) переведены в
      // utils/errorMessages.ts → ERROR_TRANSLATIONS.
      handleApiError(err, 'Не удалось сохранить наряд', 'saveWorkOrder');
      return null;
    } finally {
      setSaving(false);
    }
  };

  const save = () => persist(false);

  // Кнопка "Скачать PDF" всегда активна. Перед открытием PDF делаем тихое
  // автосохранение, чтобы файл содержал актуальные данные формы.
  //
  // Раньше открывали `window.open('', '_blank')` СИНХРОННО в click, чтобы
  // обойти popup-блокер iOS, и потом редиректили эту вкладку. Но сервер
  // отдавал PDF с `Content-Disposition: inline` → iOS Safari показывал
  // «about:blank» новой вкладкой и не успевал перенавигировать. Юзер
  // видел пустую страницу и не понимал, как файл скачать.
  //
  // Сейчас сервер отдаёт `attachment` (см. routes/documents.cjs), поэтому
  // достаточно одной same-window-навигации: iOS вместо нав-replace покажет
  // нативный диалог «Загрузить файл» и оставит юзера в текущей вкладке
  // СРМ. На десктопе — обычное скачивание в Downloads.
  const downloadPdf = async () => {
    const saved = await persist(true);
    if (!saved) return;
    window.location.href = api.workOrderPdfUrl(bookingId);
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={bookingTitle ? `Заказ-наряд — ${bookingTitle}` : 'Заказ-наряд'}
      maxWidth="full"
      position="center"
    >
      {loading ? (
        <div className="flex items-center justify-center py-16 text-zinc-400">
          <Loader2 className="animate-spin mr-2" size={18} /> Загрузка…
        </div>
      ) : (
        <div className="space-y-6 max-w-3xl mx-auto">

          {/* ── Заказчик и автомобиль ── */}
          <div className="space-y-4">
            <div>
              <div className="text-xs font-black text-zinc-400 uppercase tracking-widest mb-2">
                Заказчик
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <FieldInput label="ФИО"     value={clientName}  onChange={setClientName}  placeholder="Иванов Иван Иванович" />
                <FieldInput label="Телефон" value={clientPhone} onChange={setClientPhone} placeholder="+7 999 123-45-67" />
              </div>
            </div>
            <div>
              <div className="text-xs font-black text-zinc-400 uppercase tracking-widest mb-2">
                Автомобиль
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <FieldInput label="Марка"      value={carBrand} onChange={setCarBrand} placeholder="Toyota" />
                <FieldInput label="Модель"     value={carModel} onChange={setCarModel} placeholder="Camry" />
                <FieldInput label="Год выпуска" value={carYear}  onChange={setCarYear}  placeholder="2020" inputMode="numeric" />
                <FieldInput label="Цвет"       value={carColor} onChange={setCarColor} placeholder="белый" />
                <FieldInput label="Госномер"   value={carPlate} onChange={setCarPlate} placeholder="А123ВС777" />
                <FieldInput label="VIN"        value={carVin}   onChange={setCarVin}   placeholder="JT2BG28K1F0123456" />
              </div>
              <p className="text-[11px] text-zinc-400 mt-2">
                Если данные есть в карточке клиента — поля заполнятся автоматически. Можно дополнить вручную.
              </p>
            </div>
          </div>

          {/* ── Услуги ── */}
          <div>
            <div className="flex items-end justify-between mb-3">
              <div>
                <div className="text-xs font-black text-zinc-400 uppercase tracking-widest">Перечень работ</div>
                <div className="text-xs text-zinc-500 mt-1">{items.length} {items.length === 1 ? 'позиция' : 'позиций'}</div>
              </div>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={openPicker}
                  className="inline-flex items-center gap-1.5 bg-white border border-zinc-300 text-zinc-900 text-sm font-bold rounded-xl px-3 py-2 hover:bg-zinc-50 transition-colors"
                >
                  <ListPlus size={14} /> Из прайса
                </button>
                <button
                  type="button"
                  onClick={addItem}
                  className="inline-flex items-center gap-1.5 bg-zinc-100 text-zinc-900 text-sm font-bold rounded-xl px-3 py-2 hover:bg-zinc-200 transition-colors"
                >
                  <Plus size={14} /> Вручную
                </button>
              </div>
            </div>

            <div className="rounded-xl border border-zinc-200 divide-y divide-zinc-100">
              {items.map((it, idx) => {
                const sum = (Number(it.quantity) || 0) * (Number(it.price) || 0);
                return (
                  <div key={idx} className="grid grid-cols-12 gap-2 px-3 py-3 items-center">
                    <input
                      type="text"
                      value={it.name}
                      onChange={(e) => updateItem(idx, { name: e.target.value })}
                      placeholder="Название услуги"
                      maxLength={500}
                      className="col-span-12 sm:col-span-6 bg-white border border-zinc-200 rounded-lg p-2.5 text-sm outline-none focus:border-orange-500 transition-all placeholder:text-zinc-300 placeholder:italic"
                    />
                    <input
                      type="number"
                      inputMode="numeric"
                      min={0}
                      max={99999}
                      value={it.quantity}
                      onChange={(e) => updateItem(idx, { quantity: Number(e.target.value) || 0 })}
                      placeholder="Кол-во"
                      className="col-span-3 sm:col-span-2 bg-white border border-zinc-200 rounded-lg p-2.5 text-sm outline-none focus:border-orange-500 transition-all text-right placeholder:text-zinc-300 placeholder:italic"
                    />
                    <input
                      type="number"
                      inputMode="decimal"
                      min={0}
                      step={0.01}
                      value={it.price}
                      onChange={(e) => updateItem(idx, { price: Number(e.target.value) || 0 })}
                      placeholder="Цена"
                      className="col-span-3 sm:col-span-2 bg-white border border-zinc-200 rounded-lg p-2.5 text-sm outline-none focus:border-orange-500 transition-all text-right placeholder:text-zinc-300 placeholder:italic"
                    />
                    {/* На мобиле сумма получает col-span-4, корзина — col-span-2,
                        чтобы «300 000 ₽» помещался без захода на иконку удаления
                        и трогать кнопку было удобно пальцем. На десктопе
                        возвращаемся к компактным col-span-1. */}
                    <div className="col-span-4 sm:col-span-1 text-sm font-bold text-zinc-900 text-right whitespace-nowrap overflow-hidden text-ellipsis">
                      {fmtRub(sum)}
                    </div>
                    <button
                      type="button"
                      onClick={() => removeItem(idx)}
                      disabled={items.length <= 1}
                      className="col-span-2 sm:col-span-1 flex justify-center text-zinc-400 hover:text-red-600 disabled:opacity-30 disabled:cursor-not-allowed"
                      aria-label="Удалить услугу"
                    >
                      <Trash2 size={16} />
                    </button>
                  </div>
                );
              })}
            </div>
          </div>

          {/* ── Итоги + скидка ── */}
          <div className="rounded-xl bg-zinc-50 border border-zinc-200 p-4 space-y-2">
            <div className="flex justify-between text-sm">
              <span className="text-zinc-500">Сумма работ</span>
              <span className="font-bold text-zinc-900">{fmtRub(subtotal)}</span>
            </div>
            <div className="flex justify-between items-center text-sm">
              <span className="text-zinc-500">Скидка, ₽</span>
              <input
                type="number"
                inputMode="decimal"
                min={0}
                step={0.01}
                value={discount}
                onChange={(e) => setDiscount(e.target.value)}
                className="w-32 bg-white border border-zinc-200 rounded-lg p-2 text-sm outline-none focus:border-orange-500 transition-all text-right"
              />
            </div>
            <div className="border-t border-zinc-200 pt-2 flex justify-between text-base">
              <span className="font-black text-zinc-900">Итого</span>
              <span className="font-black text-orange-600">{fmtRub(total)}</span>
            </div>
          </div>

          {/* ── Способ оплаты + плановая выдача ── */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <label className="text-xs font-black text-zinc-400 uppercase tracking-widest mb-2 block">
                Способ оплаты
              </label>
              <select
                value={paymentMethod}
                onChange={(e) => setPaymentMethod(e.target.value as PaymentMethod | '')}
                className="w-full bg-white border border-zinc-200 rounded-lg p-3 text-sm outline-none focus:border-orange-500 transition-all shadow-sm placeholder:text-zinc-300 placeholder:italic"
              >
                <option value="">— не выбран —</option>
                {PAYMENT_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-xs font-black text-zinc-400 uppercase tracking-widest mb-2 block">
                Дата выдачи
              </label>
              <input
                type="date"
                value={deliveryDate}
                onChange={(e) => setDeliveryDate(e.target.value)}
                className="w-full bg-white border border-zinc-200 rounded-lg p-3 text-sm outline-none focus:border-orange-500 transition-all shadow-sm placeholder:text-zinc-300 placeholder:italic"
              />
            </div>
            <div>
              <label className="text-xs font-black text-zinc-400 uppercase tracking-widest mb-2 block">
                Время выдачи
              </label>
              <input
                type="time"
                value={deliveryTime}
                onChange={(e) => setDeliveryTime(e.target.value)}
                className="w-full bg-white border border-zinc-200 rounded-lg p-3 text-sm outline-none focus:border-orange-500 transition-all shadow-sm placeholder:text-zinc-300 placeholder:italic"
              />
            </div>
          </div>

          {/* ── Гарантия ── */}
          <div>
            <label className="text-xs font-black text-zinc-400 uppercase tracking-widest mb-2 block">
              Гарантия
            </label>
            <textarea
              value={guarantee}
              onChange={(e) => setGuarantee(e.target.value)}
              placeholder="Если оставить пустым — подставится текст из реквизитов студии"
              rows={2}
              maxLength={5000}
              className="w-full bg-white border border-zinc-200 rounded-lg p-3 text-sm outline-none focus:border-orange-500 transition-all shadow-sm placeholder:text-zinc-300 placeholder:italic"
            />
          </div>

          {/* ── Комментарий ── */}
          <div>
            <label className="text-xs font-black text-zinc-400 uppercase tracking-widest mb-2 block">
              Комментарий
            </label>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Особые условия, материалы заказчика и т.п."
              rows={2}
              maxLength={5000}
              className="w-full bg-white border border-zinc-200 rounded-lg p-3 text-sm outline-none focus:border-orange-500 transition-all shadow-sm placeholder:text-zinc-300 placeholder:italic"
            />
          </div>

          {/* ── Подпись ── */}
          <div>
            <div className="text-xs font-black text-zinc-400 uppercase tracking-widest mb-2">
              Подпись заказчика
            </div>
            <SignaturePad value={signature} onChange={setSignature} height={180} />
          </div>

          {/* ── Кнопки ── */}
          <div className="flex flex-col-reverse sm:flex-row gap-2 pt-2 sticky bottom-0 bg-white pb-2">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 bg-zinc-100 text-zinc-900 font-bold rounded-xl py-3 hover:bg-zinc-200 transition-colors"
            >
              Закрыть
            </button>
            <button
              type="button"
              onClick={downloadPdf}
              disabled={saving}
              className="flex-1 inline-flex items-center justify-center gap-2 bg-white border border-zinc-300 text-zinc-900 font-bold rounded-xl py-3 hover:bg-zinc-50 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <FileDown size={16} /> Скачать PDF
            </button>
            <button
              type="button"
              onClick={save}
              disabled={saving}
              className="flex-1 inline-flex items-center justify-center gap-2 bg-orange-500 text-white font-bold rounded-xl py-3 hover:bg-orange-600 transition-colors disabled:opacity-60"
            >
              {saving ? <Loader2 className="animate-spin" size={16} /> : <Save size={16} />}
              {saving ? 'Сохраняем…' : 'Сохранить'}
            </button>
          </div>
        </div>
      )}

      {/* ── Пикер из прайса ────────────────────────────────────── */}
      <Modal
        isOpen={pickerOpen}
        onClose={() => setPickerOpen(false)}
        title="Выбрать из прайса"
        maxWidth="lg"
        position="center"
      >
        <div className="space-y-3">
          <div className="relative">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400 pointer-events-none" />
            <input
              type="text"
              value={priceQuery}
              onChange={(e) => setPriceQuery(e.target.value)}
              placeholder="Поиск по названию"
              className="w-full pl-9 pr-3 py-2.5 rounded-xl border border-zinc-200 text-sm outline-none focus:border-orange-400 placeholder:text-zinc-300 placeholder:italic"
              autoFocus
            />
          </div>

          {priceLoading ? (
            <div className="flex items-center justify-center py-10 text-zinc-400">
              <Loader2 className="animate-spin mr-2" size={18} /> Загрузка…
            </div>
          ) : priceRows.length === 0 ? (
            <div className="py-10 text-center text-sm text-zinc-500">
              Прайс пока пуст. Добавьте услуги в&nbsp;
              <span className="text-zinc-700 font-medium">Профиль → Прайс-лист услуг</span>.
            </div>
          ) : (
            <div className="max-h-[50vh] overflow-y-auto rounded-xl border border-zinc-100 divide-y divide-zinc-100">
              {filteredPriceRows.length === 0 ? (
                <div className="py-8 text-center text-sm text-zinc-400">Ничего не найдено</div>
              ) : filteredPriceRows.map((r) => {
                const checked = pickerSelected.has(r.id);
                return (
                  <label
                    key={r.id}
                    className={`flex items-center gap-3 px-3 py-2.5 cursor-pointer transition-colors ${checked ? 'bg-orange-50' : 'hover:bg-zinc-50'}`}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => togglePickerRow(r.id)}
                      className="h-4 w-4 rounded border-zinc-300 text-orange-500 focus:ring-orange-400"
                    />
                    <div className="flex-1 min-w-0">
                      <div className="text-sm text-zinc-900 truncate">{r.name}</div>
                    </div>
                    <div className="text-sm font-bold text-zinc-900 whitespace-nowrap">
                      {fmtRub(Number(r.price) || 0)}
                    </div>
                  </label>
                );
              })}
            </div>
          )}

          <div className="flex flex-col-reverse sm:flex-row gap-2 pt-2">
            <button
              type="button"
              onClick={() => setPickerOpen(false)}
              className="flex-1 bg-zinc-100 text-zinc-900 font-bold rounded-xl py-3 hover:bg-zinc-200 transition-colors"
            >
              Отмена
            </button>
            <button
              type="button"
              onClick={applyPickerSelection}
              disabled={pickerSelected.size === 0}
              className="flex-1 bg-orange-500 text-white font-bold rounded-xl py-3 hover:bg-orange-600 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Добавить{pickerSelected.size > 0 ? ` (${pickerSelected.size})` : ''}
            </button>
          </div>
        </div>
      </Modal>
    </Modal>
  );
};
