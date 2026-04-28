import { useEffect, useMemo, useState } from 'react';
import { Save, FileDown, Loader2 } from 'lucide-react';
import { Modal } from '@/app/components/ui/Modal';
import { showToast } from '@/app/components/ui/Toast';
import { handleApiError } from '@/utils/stateHelpers';
import {
  api,
  AcceptanceAct,
  AcceptanceZone,
  ZoneCondition,
  DEFAULT_ZONES,
} from '@/utils/api';
import { SignaturePad } from './SignaturePad';
import { PhotoUploader } from './PhotoUploader';

/**
 * Форма акта приёмки автомобиля.
 *
 * Связка с бэком:
 *   GET  /api/acceptance-acts/:bookingId        — текущий акт (404 → новый)
 *   PUT  /api/acceptance-acts/:bookingId        — upsert
 *   GET  /api/acceptance-acts/:bookingId/pdf    — скачать PDF
 *
 * Фото грузятся отдельным компонентом (PhotoUploader), photos_count считается на бэке.
 */

interface AcceptanceActFormProps {
  isOpen: boolean;
  onClose: () => void;
  bookingId: number;
  bookingTitle?: string;          // напр. «Иванов И. — Toyota Camry, 12.04 14:00» — для шапки
  onSaved?: (act: AcceptanceAct) => void;
}

// condition выводится автоматически из чекбоксов scratches/dents:
//   нет дефектов → 'ok'; иначе → 'damaged'.
// Решение: одно касание = пометка дефекта; пользователю не нужно одновременно
// крутить чекбоксы и второй селектор. См. фидбек владельца про неинтуитивность UI.
const deriveCondition = (scratches: boolean, dents: boolean): ZoneCondition =>
  (scratches || dents) ? 'damaged' : 'ok';

function buildInitialZones(): AcceptanceZone[] {
  return DEFAULT_ZONES.map((name) => ({
    zone_name: name,
    scratches: false,
    dents: false,
    condition: 'ok' as ZoneCondition,
  }));
}

// Маленький инпут с подписью; используется в блоках «Заказчик» и «Автомобиль».
// Намеренно не выносим в shared-ui — пока единственное место использования.
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

export const AcceptanceActForm = ({
  isOpen, onClose, bookingId, bookingTitle, onSaved,
}: AcceptanceActFormProps) => {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving]   = useState(false);
  const [act, setAct]         = useState<AcceptanceAct | null>(null);

  const [mileage, setMileage]                     = useState<string>('');
  const [zones, setZones]                         = useState<AcceptanceZone[]>(buildInitialZones());
  const [damageDescription, setDamageDescription] = useState('');
  const [valuables, setValuables]                 = useState('');
  const [signature, setSignature]                 = useState<string | null>(null);
  const [photosCount, setPhotosCount]             = useState(0);

  // Snapshot-поля клиента и авто. Заполняются из карточки клиента (через
  // getDocumentContext); если в карточке пусто, пользователь вписывает вручную.
  const [clientName, setClientName]   = useState('');
  const [clientPhone, setClientPhone] = useState('');
  const [carBrand, setCarBrand]       = useState('');
  const [carModel, setCarModel]       = useState('');
  const [carYear, setCarYear]         = useState('');
  const [carColor, setCarColor]       = useState('');
  const [carPlate, setCarPlate]       = useState('');
  const [carVin, setCarVin]           = useState('');

  // Хелпер: вернуть первое непустое значение из списка (snapshot → ctx → '').
  const pick = (...vals: Array<string | number | null | undefined>): string => {
    for (const v of vals) {
      if (v !== null && v !== undefined && String(v).trim() !== '') return String(v);
    }
    return '';
  };

  // Загружаем существующий акт + контекст (клиент/авто из БД) параллельно.
  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    setLoading(true);

    Promise.all([
      api.getAcceptanceAct(bookingId).catch((err: any) => {
        // 404 = акта ещё нет; возвращаем null, не считаем ошибкой
        if (err?.status === 404 || /not_found/i.test(String(err?.message))) return null;
        throw err;
      }),
      api.getDocumentContext(bookingId).catch(() => null),
    ])
      .then(([row, ctx]) => {
        if (cancelled) return;
        const cs = row?.client_snapshot  || {};
        const vs = row?.vehicle_snapshot || {};
        const cv = ctx?.client  || ({} as any);
        const vv = ctx?.vehicle || ({} as any);

        setAct(row);
        setMileage(row?.mileage != null ? String(row.mileage) : '');
        const incoming = row && Array.isArray(row.zones) && row.zones.length > 0
          ? row.zones
          : buildInitialZones();
        setZones(incoming);
        setDamageDescription(row?.damage_description || '');
        setValuables(row?.valuables || '');
        setSignature(row?.signature_data || null);
        setPhotosCount(row?.photos_count || 0);

        // Snapshot имеет приоритет — пользователь мог уже вписать данные.
        setClientName(pick(cs.name,  cv.name));
        setClientPhone(pick(cs.phone, cv.phone));
        setCarBrand(pick(vs.brand,  vv.brand));
        setCarModel(pick(vs.model,  vv.model));
        setCarYear(pick(vs.year,   vv.year));
        setCarColor(pick(vs.color,  vv.color));
        setCarPlate(pick(vs.license_plate, vv.license_plate));
        setCarVin(pick(vs.vin,     vv.vin));
      })
      .catch(() => {
        if (cancelled) return;
        showToast('Не удалось загрузить акт приёмки', 'error');
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [isOpen, bookingId]);

  const updateZone = (idx: number, patch: Partial<AcceptanceZone>) => {
    setZones((arr) => arr.map((z, i) => {
      if (i !== idx) return z;
      const next = { ...z, ...patch };
      // condition автоматически следует за чекбоксами, чтобы не было двойной работы.
      next.condition = deriveCondition(next.scratches, next.dents);
      return next;
    }));
  };

  const stats = useMemo(() => {
    let damaged = 0, minor = 0, withDefects = 0;
    zones.forEach((z) => {
      if (z.condition === 'damaged') damaged++;
      if (z.condition === 'minor') minor++;
      if (z.scratches || z.dents || z.condition !== 'ok') withDefects++;
    });
    return { damaged, minor, withDefects };
  }, [zones]);

  // Внутренний сейв: возвращает saved или null (если упал — toast уже показан).
  // silent=true → не показывать «Акт приёмки сохранён» (используется при автосохранении
  // перед скачиванием PDF, чтобы не было лишнего тоста).
  const persist = async (silent = false): Promise<AcceptanceAct | null> => {
    setSaving(true);
    try {
      const yearNum = carYear.trim() === '' ? null : (parseInt(carYear, 10) || null);
      const payload = {
        mileage: mileage.trim() === '' ? null : Number(mileage),
        zones,
        damage_description: damageDescription.trim() || null,
        valuables: valuables.trim() || null,
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
      const saved = await api.saveAcceptanceAct(bookingId, payload);
      setAct(saved);
      if (!silent) showToast('Акт приёмки сохранён', 'success');
      onSaved?.(saved);
      return saved;
    } catch (err) {
      // Конкретные коды (signature_too_large/_invalid, zones_invalid)
      // переведены в utils/errorMessages.ts → ERROR_TRANSLATIONS.
      handleApiError(err, 'Не удалось сохранить акт', 'saveAcceptanceAct');
      return null;
    } finally {
      setSaving(false);
    }
  };

  const save = () => persist(false);

  // Кнопка скачать PDF всегда активна. Перед открытием PDF делаем тихое
  // автосохранение, чтобы файл содержал актуальные данные формы
  // (а не последнюю сохранённую версию).
  //
  // Раньше тут была пляска с `window.open('', '_blank')` СИНХРОННО в click —
  // чтобы обойти popup-блокер iOS. Но сервер отдавал PDF с
  // `Content-Disposition: inline`, и iOS Safari открывал «about:blank»
  // вторым табом, не успевая перенавигировать его на PDF. Юзер видел
  // пустую вкладку и не понимал, как файл скачать.
  //
  // Сейчас сервер отдаёт `attachment` (см. routes/documents.cjs), поэтому
  // достаточно одной same-window-навигации: iOS вместо нав-replace покажет
  // нативный диалог «Загрузить файл» и оставит юзера в текущей вкладке
  // СРМ. На десктопе — обычное скачивание в Downloads.
  const downloadPdf = async () => {
    const saved = await persist(true);
    if (!saved) return;
    window.location.href = api.acceptanceActPdfUrl(bookingId);
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={bookingTitle ? `Акт приёмки — ${bookingTitle}` : 'Акт приёмки'}
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

          {/* ── Пробег ── */}
          <div>
            <label className="text-xs font-black text-zinc-400 uppercase tracking-widest mb-2 block">
              Пробег, км
            </label>
            <input
              type="number"
              inputMode="numeric"
              min={0}
              max={9999999}
              value={mileage}
              onChange={(e) => setMileage(e.target.value)}
              placeholder="например, 124 500"
              className="w-full bg-white border border-zinc-200 rounded-lg p-3 text-sm outline-none focus:border-orange-500 transition-all shadow-sm placeholder:text-zinc-300 placeholder:italic"
            />
          </div>

          {/* ── Зоны ── */}
          <div>
            <div className="flex items-end justify-between mb-3">
              <div>
                <div className="text-xs font-black text-zinc-400 uppercase tracking-widest">
                  Состояние кузова
                </div>
                <div className="text-xs text-zinc-500 mt-1">
                  16 зон • с дефектами: <b className="text-zinc-900">{stats.withDefects}</b>
                  {stats.damaged > 0 && <> • повреждений: <b className="text-red-600">{stats.damaged}</b></>}
                </div>
              </div>
            </div>

            <div className="text-xs text-zinc-500 mb-2">
              Нажмите на «Царапины» или «Вмятины», если на этой зоне есть дефект. Если ничего не нажато — зона в норме.
            </div>

            <div className="rounded-xl border border-zinc-200 overflow-hidden">
              <div className="divide-y divide-zinc-100">
                {zones.map((z, idx) => {
                  const hasDefect = z.scratches || z.dents;
                  return (
                    <div
                      key={z.zone_name + idx}
                      className={`grid grid-cols-1 sm:grid-cols-[1fr_auto] gap-3 px-4 py-3 items-center ${
                        hasDefect ? 'bg-red-50/40' : 'bg-white'
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        <span className={`inline-block w-2 h-2 rounded-full ${
                          hasDefect ? 'bg-red-500' : 'bg-emerald-500'
                        }`} />
                        <span className="font-medium text-sm text-zinc-900">{z.zone_name}</span>
                      </div>
                      <div className="flex flex-wrap gap-2 sm:justify-end">
                        <button
                          type="button"
                          onClick={() => updateZone(idx, { scratches: !z.scratches })}
                          aria-pressed={z.scratches}
                          className={`text-xs font-bold px-3 py-1.5 rounded-lg border transition-colors ${
                            z.scratches
                              ? 'bg-amber-100 text-amber-800 border-amber-300'
                              : 'bg-white text-zinc-500 border-zinc-200 hover:border-amber-200 hover:text-amber-700'
                          }`}
                        >
                          Царапины
                        </button>
                        <button
                          type="button"
                          onClick={() => updateZone(idx, { dents: !z.dents })}
                          aria-pressed={z.dents}
                          className={`text-xs font-bold px-3 py-1.5 rounded-lg border transition-colors ${
                            z.dents
                              ? 'bg-red-100 text-red-800 border-red-300'
                              : 'bg-white text-zinc-500 border-zinc-200 hover:border-red-200 hover:text-red-700'
                          }`}
                        >
                          Вмятины
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>

          {/* ── Описание повреждений ── */}
          <div>
            <label className="text-xs font-black text-zinc-400 uppercase tracking-widest mb-2 block">
              Описание повреждений
            </label>
            <textarea
              value={damageDescription}
              onChange={(e) => setDamageDescription(e.target.value)}
              placeholder="Свободное описание царапин, сколов, вмятин с указанием расположения"
              rows={3}
              maxLength={5000}
              className="w-full bg-white border border-zinc-200 rounded-lg p-3 text-sm outline-none focus:border-orange-500 transition-all shadow-sm placeholder:text-zinc-300 placeholder:italic"
            />
          </div>

          {/* ── Ценные вещи ── */}
          <div>
            <label className="text-xs font-black text-zinc-400 uppercase tracking-widest mb-2 block">
              Ценные вещи в салоне
            </label>
            <textarea
              value={valuables}
              onChange={(e) => setValuables(e.target.value)}
              placeholder="Например: «Не заявлены» / «Регистратор, navigator»"
              rows={2}
              maxLength={2000}
              className="w-full bg-white border border-zinc-200 rounded-lg p-3 text-sm outline-none focus:border-orange-500 transition-all shadow-sm placeholder:text-zinc-300 placeholder:italic"
            />
          </div>

          {/* ── Фото ── */}
          <PhotoUploader bookingId={bookingId} photoType="acceptance" onCountChange={setPhotosCount} />

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

          <div className="text-[11px] text-zinc-400 text-center">
            Загружено фотографий: {photosCount}
          </div>
        </div>
      )}
    </Modal>
  );
};
