/**
 * ServicesManager — простой прайс-лист услуг.
 * Плоский список: название + цена. Поиск — в ServicesPicker при выборе услуги.
 * При любом изменении вызывает onServicesChange() — синхронизирует прайс в App.
 */
import { useEffect, useRef, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { api } from '@/utils/api';

interface Service {
  id: number;
  name: string;
  price: number | string;
  duration: number;
  description: string | null;
  is_active: boolean;
}

interface ServicesManagerProps {
  canEdit: boolean;
  onServicesChange?: () => void;
}

const fmtRub = (n: number | string) =>
  Math.round(Number(n) || 0).toLocaleString('ru-RU');

export function ServicesManager({ canEdit, onServicesChange }: ServicesManagerProps) {
  const [items, setItems] = useState<Service[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [newName, setNewName] = useState('');
  const [newPrice, setNewPrice] = useState('');
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    let mounted = true;
    api.getServices()
      .then((rows) => { if (mounted) setItems(rows || []); })
      .catch((e) => { if (mounted) setError(e?.message || 'Не удалось загрузить'); })
      .finally(() => { if (mounted) setLoading(false); });
    return () => { mounted = false; };
  }, []);

  const updateField = async (id: number, patch: Partial<Service>) => {
    const before = items;
    const next = items.map((it) => (it.id === id ? { ...it, ...patch } : it));
    setItems(next);
    const cur = next.find((it) => it.id === id);
    if (!cur) return;
    try {
      await api.updateService(id, {
        name: cur.name,
        price: Number(cur.price) || 0,
        duration: cur.duration,
        description: cur.description,
        is_active: cur.is_active,
      });
      onServicesChange?.();
    } catch (e: any) {
      setItems(before);
      setError(e?.message || 'Не удалось сохранить');
    }
  };

  const handleAdd = async () => {
    const name = newName.trim();
    if (!name) return;
    setAdding(true);
    setError(null);
    try {
      const created = await api.createService({
        name,
        price: Number(newPrice) || 0,
        duration: 60,
        is_active: true,
      });
      setItems((arr) => [...arr, created].sort((a, b) => a.name.localeCompare(b.name)));
      setNewName('');
      setNewPrice('');
      onServicesChange?.();
    } catch (e: any) {
      setError(e?.message || 'Не удалось добавить');
    } finally {
      setAdding(false);
    }
  };

  const handleDelete = async (id: number) => {
    const it = items.find((x) => x.id === id);
    if (!it) return;
    if (!window.confirm(`Удалить услугу «${it.name}»?`)) return;
    const before = items;
    setItems(items.filter((x) => x.id !== id));
    try {
      await api.deleteService(id);
      onServicesChange?.();
    } catch (e: any) {
      setItems(before);
      setError(e?.message || 'Не удалось удалить');
    }
  };

  if (loading) return <div className="px-6 py-4 text-sm text-zinc-400">Загрузка…</div>;

  return (
    <div className="px-6 py-4">
      {error && (
        <div className="mb-3 px-3 py-2 rounded-lg bg-red-50 border border-red-200 text-xs text-red-700">{error}</div>
      )}

      {items.length === 0 ? (
        <p className="text-sm text-zinc-500 mb-4">
          Прайс пока пустой. Добавьте услуги ниже — они появятся в выборе услуг при создании записи.
        </p>
      ) : (
        <div className="border border-zinc-100 rounded-xl overflow-hidden mb-4">
          <div className="grid grid-cols-[1fr_90px_36px] gap-2 px-3 py-2 bg-zinc-50 text-xs text-zinc-500 font-medium">
            <span>Название</span>
            <span className="text-right">Цена, ₽</span>
            <span />
          </div>
          {items.map((it) => (
            <div key={it.id} className="grid grid-cols-[1fr_90px_36px] gap-2 px-3 py-2 border-t border-zinc-100 items-start">
              <textarea
                value={it.name}
                rows={1}
                disabled={!canEdit}
                onChange={(e) => {
                  setItems((arr) => arr.map((x) => (x.id === it.id ? { ...x, name: e.target.value } : x)));
                  const el = e.target as HTMLTextAreaElement;
                  el.style.height = 'auto';
                  el.style.height = el.scrollHeight + 'px';
                }}
                onBlur={(e) => {
                  const v = e.target.value.trim();
                  if (v && v !== it.name) updateField(it.id, { name: v });
                  else if (!v) setItems((arr) => arr.map((x) => (x.id === it.id ? { ...x, name: it.name } : x)));
                }}
                ref={(el) => {
                  if (el && el.scrollHeight !== el.clientHeight) {
                    el.style.height = 'auto';
                    el.style.height = el.scrollHeight + 'px';
                  }
                }}
                className="bg-transparent outline-none text-sm text-zinc-900 disabled:text-zinc-500 resize-none overflow-hidden leading-snug"
              />
              <input
                type="text"
                inputMode="numeric"
                value={fmtRub(it.price)}
                disabled={!canEdit}
                onChange={(e) => {
                  const raw = e.target.value.replace(/[^0-9]/g, '');
                  setItems((arr) => arr.map((x) => (x.id === it.id ? { ...x, price: raw === '' ? 0 : Number(raw) } : x)));
                }}
                onBlur={() => {
                  const cur = items.find((x) => x.id === it.id);
                  if (cur && Number(cur.price) !== Number(it.price)) updateField(it.id, { price: Number(cur.price) || 0 });
                }}
                className="bg-transparent outline-none text-sm text-zinc-900 text-right disabled:text-zinc-500 mt-0.5"
              />
              {canEdit ? (
                <button
                  type="button"
                  onClick={() => handleDelete(it.id)}
                  className="text-zinc-400 hover:text-red-500 transition-colors flex items-center justify-center"
                  title="Удалить"
                >
                  <Trash2 size={16} />
                </button>
              ) : <span />}
            </div>
          ))}
        </div>
      )}

      {canEdit && (
        <div className="grid grid-cols-[1fr_auto] sm:grid-cols-[1fr_120px_auto] gap-2 items-center">
          <input
            type="text"
            value={newName}
            placeholder="Например: Полировка ЛКП"
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleAdd()}
            className="col-span-2 sm:col-span-1 min-w-0 w-full px-3 py-2 rounded-lg border border-zinc-200 text-sm outline-none focus:border-orange-300"
          />
          <input
            type="number"
            value={newPrice}
            placeholder="Цена, ₽"
            min={0}
            onChange={(e) => setNewPrice(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleAdd()}
            inputMode="numeric"
            className="min-w-0 w-full px-3 py-2 rounded-lg border border-zinc-200 text-sm outline-none focus:border-orange-300 text-right"
          />
          <button
            type="button"
            onClick={handleAdd}
            disabled={!newName.trim() || adding}
            className="px-4 py-2 rounded-lg bg-zinc-900 text-white text-sm font-medium hover:bg-zinc-800 disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center gap-1.5 whitespace-nowrap"
          >
            <Plus size={16} />
            Добавить
          </button>
        </div>
      )}

      {!canEdit && (
        <p className="text-xs text-zinc-400 mt-1">Только владелец и менеджер могут редактировать прайс.</p>
      )}

      {items.length > 0 && (
        <p className="text-xs text-zinc-400 mt-3">
          Всего: {items.length} · Сумма: {fmtRub(items.reduce((s, x) => s + (Number(x.price) || 0), 0))} ₽
        </p>
      )}
    </div>
  );
}
