/**
 * ServicesManager — менеджер прайс-листа услуг студии.
 *
 * Использует CRUD `/api/services` (см. server/routes/tenant.cjs):
 *   GET    — все читают
 *   POST/PUT/DELETE — owner и manager (мастер read-only)
 *
 * UX:
 *   • inline-редактирование name/price/duration с onBlur-сохранением
 *   • чекбокс «активна» — мгновенный PUT
 *   • удаление — confirm + DELETE
 *   • новая услуга — форма внизу с одной кнопкой «Добавить»
 *
 * Подключается в ProfilePage внутри отдельной секции, видимой owner+manager.
 */
import { useEffect, useState } from 'react';
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
  /** Если false — режим только-чтение (для master). */
  canEdit: boolean;
}

const fmtRub = (n: number | string): string => {
  const v = Number(n) || 0;
  return v.toLocaleString('ru-RU', { maximumFractionDigits: 2 });
};

export function ServicesManager({ canEdit }: ServicesManagerProps) {
  const [items, setItems] = useState<Service[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Форма добавления.
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

  // Локальный патч + PUT. Откатываем при ошибке.
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
        // duration сохраняем как 60 минут "под капотом" — пока не используется в UI,
        // но колонка NOT NULL в БД и старые записи могут полагаться на это поле.
        duration: 60,
        is_active: true,
      });
      setItems((arr) => [...arr, created].sort((a, b) => a.name.localeCompare(b.name)));
      setNewName('');
      setNewPrice('');
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
    } catch (e: any) {
      setItems(before);
      setError(e?.message || 'Не удалось удалить');
    }
  };

  if (loading) {
    return <div className="px-6 py-4 text-sm text-zinc-400">Загрузка…</div>;
  }

  return (
    <div className="px-6 py-4">
      {error && (
        <div className="mb-3 px-3 py-2 rounded-lg bg-red-50 border border-red-200 text-xs text-red-700">
          {error}
        </div>
      )}

      {items.length === 0 ? (
        <p className="text-sm text-zinc-500 mb-4">
          Прайс пока пустой. Добавьте услуги ниже — они появятся в выпадашке при создании заказ-наряда.
        </p>
      ) : (
        <div className="border border-zinc-100 rounded-xl overflow-hidden mb-4">
          <div className="grid grid-cols-[1fr_120px_80px_36px] gap-2 px-3 py-2 bg-zinc-50 text-xs text-zinc-500 font-medium">
            <span>Название</span>
            <span className="text-right">Цена, ₽</span>
            <span className="text-center">Активна</span>
            <span />
          </div>
          {items.map((it) => (
            <div
              key={it.id}
              className="grid grid-cols-[1fr_120px_80px_36px] gap-2 px-3 py-2 border-t border-zinc-100 items-center"
            >
              <input
                type="text"
                value={it.name}
                disabled={!canEdit}
                onChange={(e) => setItems((arr) => arr.map((x) => (x.id === it.id ? { ...x, name: e.target.value } : x)))}
                onBlur={(e) => {
                  const v = e.target.value.trim();
                  if (v && v !== it.name) updateField(it.id, { name: v });
                  else if (!v) setItems((arr) => arr.map((x) => (x.id === it.id ? { ...x, name: it.name } : x)));
                }}
                className="bg-transparent outline-none text-sm text-zinc-900 disabled:text-zinc-500"
              />
              <input
                type="number"
                value={it.price}
                disabled={!canEdit}
                min={0}
                onChange={(e) => setItems((arr) => arr.map((x) => (x.id === it.id ? { ...x, price: e.target.value } : x)))}
                onBlur={() => {
                  const cur = items.find((x) => x.id === it.id);
                  if (cur && Number(cur.price) !== Number(it.price)) updateField(it.id, { price: Number(cur.price) || 0 });
                }}
                className="bg-transparent outline-none text-sm text-zinc-900 text-right disabled:text-zinc-500"
              />
              <label className="flex items-center justify-center">
                <input
                  type="checkbox"
                  checked={it.is_active}
                  disabled={!canEdit}
                  onChange={(e) => updateField(it.id, { is_active: e.target.checked })}
                  className="h-4 w-4 rounded border-zinc-300 text-orange-500 focus:ring-orange-400"
                />
              </label>
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
        // Мобиль: имя занимает всю ширину сверху, ниже — цена + кнопка.
        // Десктоп (sm+): три колонки в одну строку. Раньше на мобиле
        // grid-cols-[1fr_120px_auto] ужимал «Например: Полировка ЛКП…»,
        // а кнопку «Добавить» выпинывало за правый край экрана.
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
        <p className="text-xs text-zinc-400 mt-1">
          Только владелец и менеджер могут редактировать прайс. У вас режим просмотра.
        </p>
      )}

      {items.length > 0 && (
        <p className="text-xs text-zinc-400 mt-3">
          Всего услуг: {items.length} · активных: {items.filter((x) => x.is_active).length}.
          Сумма по активным: {fmtRub(items.filter((x) => x.is_active).reduce((s, x) => s + (Number(x.price) || 0), 0))} ₽.
        </p>
      )}
    </div>
  );
}
