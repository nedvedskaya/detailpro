import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Camera, Trash2, Image as ImageIcon, AlertCircle, X, ZoomIn, ZoomOut, ChevronLeft, ChevronRight } from 'lucide-react';
import { api, OrderPhoto, OrderPhotoType } from '@/utils/api';
import { showToast } from '@/app/components/ui/Toast';

/**
 * Сетка фотографий с загрузкой и удалением.
 *
 * Лимиты согласованы с бэком:
 *   • до 30 фото на бронь (MAX_PHOTOS_PER_BOOKING в documents.cjs)
 *   • до 10 MB на файл (multer limit)
 *   • рекомендуемый минимум — 8 (предупреждение, не блок)
 */

const MAX_PHOTOS = 30;
const RECOMMENDED_MIN = 8;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const ACCEPTED = 'image/jpeg,image/png,image/webp,image/heic,image/heif';

interface PhotoUploaderProps {
  bookingId: number;
  photoType?: OrderPhotoType;
  onCountChange?: (count: number) => void;
}

export const PhotoUploader = ({ bookingId, photoType = 'acceptance', onCountChange }: PhotoUploaderProps) => {
  const [photos, setPhotos] = useState<OrderPhoto[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Лайтбокс: индекс открытого фото (null — закрыт). Зум/позиция управляются
  // внутри PhotoLightbox; родителю достаточно знать только какое фото показано.
  const [lightboxIdx, setLightboxIdx] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api.listOrderPhotos(bookingId)
      .then((rows) => { if (!cancelled) { setPhotos(rows); onCountChange?.(rows.length); } })
      .catch(() => { if (!cancelled) showToast('Не удалось загрузить фото', 'error'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
    // onCountChange намеренно не в deps — иначе пере-load при каждом ререндере родителя.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookingId]);

  const refresh = async () => {
    try {
      const rows = await api.listOrderPhotos(bookingId);
      setPhotos(rows);
      onCountChange?.(rows.length);
    } catch {
      // тихо: на UI уже отображается старое состояние.
    }
  };

  const onSelect = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const free = MAX_PHOTOS - photos.length;
    if (free <= 0) {
      showToast(`Лимит ${MAX_PHOTOS} фото на бронь`, 'warning');
      return;
    }
    const list = Array.from(files).slice(0, free);
    if (files.length > free) {
      showToast(`Загружено только ${free} из ${files.length} (лимит ${MAX_PHOTOS})`, 'warning');
    }

    // Отсекаем переразмеренные файлы заранее — пользователь сразу видит,
    // что эти не пойдут, остальные грузятся параллельно.
    const tooBig = list.filter(f => f.size > MAX_FILE_BYTES);
    const okFiles = list.filter(f => f.size <= MAX_FILE_BYTES);
    tooBig.forEach(f => showToast(`«${f.name}» больше 10 MB — пропущен`, 'warning'));
    if (okFiles.length === 0) return;

    // Параллельная загрузка: раньше был последовательный for-await, и пачка из
    // 10 фото упиралась в RTT каждого запроса. Promise.allSettled даёт всем
    // файлам грузиться одновременно — UX «выбрал 10 фотографий и ушёл пить
    // кофе» вместо «жду каждую по очереди».
    setUploading((n) => n + okFiles.length);

    let firstErrShown = false;
    const tasks = okFiles.map(async (file) => {
      try {
        await api.uploadOrderPhoto(bookingId, file, photoType);
      } catch (err: any) {
        // Показываем общий тост один раз, чтобы не спамить при сбое сети.
        if (!firstErrShown) {
          firstErrShown = true;
          const msg = err?.message?.includes('photo_limit_exceeded')
            ? 'Достигнут лимит фото'
            : 'Не удалось загрузить часть файлов';
          showToast(msg, 'error');
        }
      } finally {
        setUploading((n) => n - 1);
      }
    });

    await Promise.allSettled(tasks);
    await refresh();
  };

  const remove = async (id: number) => {
    if (!confirm('Удалить это фото?')) return;
    // оптимистично прячем, при ошибке восстановим
    const prev = photos;
    setPhotos((arr) => arr.filter((p) => p.id !== id));
    try {
      await api.deleteOrderPhoto(id);
      onCountChange?.(prev.length - 1);
    } catch {
      setPhotos(prev);
      showToast('Не удалось удалить фото', 'error');
    }
  };

  const total = photos.length + uploading;
  const lowCount = photos.length > 0 && photos.length < RECOMMENDED_MIN;

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <div>
          <div className="text-xs font-black text-zinc-400 uppercase tracking-widest">Фотографии</div>
          <div className="text-xs text-zinc-500 mt-1">
            {total} из {MAX_PHOTOS} • рекомендуем минимум {RECOMMENDED_MIN} • можно выбрать несколько
          </div>
        </div>
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          disabled={total >= MAX_PHOTOS}
          className="inline-flex items-center gap-2 bg-zinc-900 text-white text-sm font-bold rounded-xl px-4 py-2.5 hover:bg-zinc-700 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <Camera size={16} /> Добавить
        </button>
        <input
          ref={inputRef}
          type="file"
          accept={ACCEPTED}
          multiple
          className="hidden"
          onChange={(e) => { onSelect(e.target.files); e.target.value = ''; }}
        />
      </div>

      {lowCount && (
        <div className="mb-3 flex items-start gap-2 rounded-xl bg-amber-50 border border-amber-200 p-3 text-amber-800 text-xs">
          <AlertCircle size={14} className="shrink-0 mt-0.5" />
          <span>Рекомендуем сделать минимум {RECOMMENDED_MIN} фото со всех сторон автомобиля.</span>
        </div>
      )}

      {loading ? (
        <div className="text-sm text-zinc-400 py-6 text-center">Загрузка…</div>
      ) : (
        <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
          {photos.map((p, idx) => (
            <div key={p.id} className="relative group aspect-square rounded-xl overflow-hidden bg-zinc-100">
              <img
                src={api.orderPhotoThumbUrl(p.id)}
                alt=""
                className="w-full h-full object-cover cursor-zoom-in"
                loading="lazy"
                onClick={() => setLightboxIdx(idx)}
              />
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); remove(p.id); }}
                className="absolute top-1 right-1 bg-zinc-900/80 text-white p-1.5 rounded-lg opacity-0 group-hover:opacity-100 transition-opacity"
                aria-label="Удалить фото"
              >
                <Trash2 size={14} />
              </button>
            </div>
          ))}
          {Array.from({ length: uploading }).map((_, i) => (
            <div key={'up' + i} className="aspect-square rounded-xl bg-zinc-100 animate-pulse flex items-center justify-center">
              <ImageIcon size={20} className="text-zinc-300" />
            </div>
          ))}
          {total === 0 && (
            <div className="col-span-3 sm:col-span-4 text-sm text-zinc-400 py-8 text-center border-2 border-dashed border-zinc-200 rounded-xl">
              Пока нет фотографий
            </div>
          )}
        </div>
      )}

      {lightboxIdx !== null && photos[lightboxIdx] && (
        <PhotoLightbox
          photos={photos}
          index={lightboxIdx}
          onClose={() => setLightboxIdx(null)}
          onChange={setLightboxIdx}
        />
      )}
    </div>
  );
};

/* -------------------------------------------------------------------------- */
/* Лайтбокс: full-screen просмотр с зумом, навигацией и pan-перетаскиванием.  */
/* -------------------------------------------------------------------------- */

interface PhotoLightboxProps {
  photos: OrderPhoto[];
  index: number;
  onClose: () => void;
  onChange: (idx: number) => void;
}

const ZOOM_LEVELS = [1, 1.5, 2, 3];

const PhotoLightbox = ({ photos, index, onClose, onChange }: PhotoLightboxProps) => {
  const [zoomStep, setZoomStep] = useState(0);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const dragRef = useRef<{ startX: number; startY: number; baseX: number; baseY: number } | null>(null);

  const zoom = ZOOM_LEVELS[zoomStep];
  const photo = photos[index];

  const reset = useCallback(() => {
    setZoomStep(0);
    setOffset({ x: 0, y: 0 });
  }, []);

  const prev = useCallback(() => {
    if (index > 0) { onChange(index - 1); reset(); }
  }, [index, onChange, reset]);

  const next = useCallback(() => {
    if (index < photos.length - 1) { onChange(index + 1); reset(); }
  }, [index, onChange, photos.length, reset]);

  const cycleZoom = useCallback(() => {
    setZoomStep((s) => {
      const ns = (s + 1) % ZOOM_LEVELS.length;
      if (ns === 0) setOffset({ x: 0, y: 0 });
      return ns;
    });
  }, []);

  const zoomIn = useCallback(() => {
    setZoomStep((s) => Math.min(s + 1, ZOOM_LEVELS.length - 1));
  }, []);

  const zoomOut = useCallback(() => {
    setZoomStep((s) => {
      const ns = Math.max(s - 1, 0);
      if (ns === 0) setOffset({ x: 0, y: 0 });
      return ns;
    });
  }, []);

  // Клавиатура: Esc закрывает, стрелки листают, +/- зумят.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowLeft') prev();
      else if (e.key === 'ArrowRight') next();
      else if (e.key === '+' || e.key === '=') zoomIn();
      else if (e.key === '-' || e.key === '_') zoomOut();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, prev, next, zoomIn, zoomOut]);

  // Скролл фона выключаем, пока открыт лайтбокс.
  useEffect(() => {
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prevOverflow; };
  }, []);

  const onPointerDown = (e: React.PointerEvent) => {
    if (zoom === 1) return;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    dragRef.current = { startX: e.clientX, startY: e.clientY, baseX: offset.x, baseY: offset.y };
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!dragRef.current) return;
    const d = dragRef.current;
    setOffset({ x: d.baseX + (e.clientX - d.startX), y: d.baseY + (e.clientY - d.startY) });
  };

  const onPointerUp = (e: React.PointerEvent) => {
    if (!dragRef.current) return;
    try { (e.target as HTMLElement).releasePointerCapture(e.pointerId); } catch {}
    dragRef.current = null;
  };

  const onWheel = (e: React.WheelEvent) => {
    if (e.deltaY < 0) zoomIn();
    else if (e.deltaY > 0) zoomOut();
  };

  return (
    <div
      className="fixed inset-0 z-[100] bg-black/95 flex items-center justify-center select-none"
      onClick={onClose}
    >
      {/* Картинка — клик по ней не закрывает оверлей, а циклит зум. */}
      <div
        className="relative w-full h-full flex items-center justify-center overflow-hidden"
        onClick={(e) => e.stopPropagation()}
        onWheel={onWheel}
      >
        <img
          src={api.orderPhotoFileUrl(photo.id)}
          alt=""
          draggable={false}
          onClick={cycleZoom}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          style={{
            transform: `translate(${offset.x}px, ${offset.y}px) scale(${zoom})`,
            transition: dragRef.current ? 'none' : 'transform 150ms ease-out',
            cursor: zoom === 1 ? 'zoom-in' : (dragRef.current ? 'grabbing' : 'grab'),
            maxWidth: '95vw',
            maxHeight: '95vh',
          }}
          className="object-contain"
        />
      </div>

      {/* Закрытие */}
      <button
        type="button"
        onClick={onClose}
        className="absolute top-4 right-4 bg-white/10 hover:bg-white/20 text-white p-2 rounded-full transition-colors"
        aria-label="Закрыть"
      >
        <X size={20} />
      </button>

      {/* Зум */}
      <div className="absolute top-4 left-4 flex items-center gap-2">
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); zoomOut(); }}
          disabled={zoomStep === 0}
          className="bg-white/10 hover:bg-white/20 text-white p-2 rounded-full transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
          aria-label="Уменьшить"
        >
          <ZoomOut size={20} />
        </button>
        <div className="text-white/80 text-xs font-bold tabular-nums w-12 text-center">
          {Math.round(zoom * 100)}%
        </div>
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); zoomIn(); }}
          disabled={zoomStep === ZOOM_LEVELS.length - 1}
          className="bg-white/10 hover:bg-white/20 text-white p-2 rounded-full transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
          aria-label="Увеличить"
        >
          <ZoomIn size={20} />
        </button>
      </div>

      {/* Навигация */}
      {index > 0 && (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); prev(); }}
          className="absolute left-4 top-1/2 -translate-y-1/2 bg-white/10 hover:bg-white/20 text-white p-3 rounded-full transition-colors"
          aria-label="Предыдущее"
        >
          <ChevronLeft size={24} />
        </button>
      )}
      {index < photos.length - 1 && (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); next(); }}
          className="absolute right-4 top-1/2 -translate-y-1/2 bg-white/10 hover:bg-white/20 text-white p-3 rounded-full transition-colors"
          aria-label="Следующее"
        >
          <ChevronRight size={24} />
        </button>
      )}

      {/* Счётчик */}
      <div className="absolute bottom-4 left-1/2 -translate-x-1/2 bg-white/10 text-white text-xs font-bold px-3 py-1.5 rounded-full">
        {index + 1} / {photos.length}
      </div>
    </div>
  );
};
