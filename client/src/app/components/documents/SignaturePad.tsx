import { useEffect, useRef, useState } from 'react';
import { Eraser } from 'lucide-react';

/**
 * Canvas-based pad для подписи. Возвращает PNG в base64 (data URL) через onChange.
 *
 * Используется в актах приёмки и заказ-нарядах. Поддерживает мышь и touch.
 * При изменении внешнего value (например, после загрузки сохранённой подписи)
 * рисуем картинку на canvas один раз.
 */

interface SignaturePadProps {
  value: string | null;                  // data:image/png;base64,…
  onChange: (dataUrl: string | null) => void;
  height?: number;
  disabled?: boolean;
}

export const SignaturePad = ({ value, onChange, height = 160, disabled = false }: SignaturePadProps) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const drawingRef = useRef(false);
  const lastPointRef = useRef<{ x: number; y: number } | null>(null);
  const [hasInk, setHasInk] = useState(Boolean(value));

  // Подгоняем размер canvas под ширину контейнера и DPR.
  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      const rect = container.getBoundingClientRect();
      const cssW = Math.max(200, rect.width);
      const cssH = height;
      canvas.style.width = cssW + 'px';
      canvas.style.height = cssH + 'px';
      canvas.width = Math.round(cssW * dpr);
      canvas.height = Math.round(cssH * dpr);
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, cssW, cssH);
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.strokeStyle = '#1a1a1a';
      ctx.lineWidth = 2;

      // Если есть сохранённая подпись — отрисуем её.
      if (value && value.startsWith('data:image/')) {
        const img = new Image();
        img.onload = () => { ctx.drawImage(img, 0, 0, cssW, cssH); };
        img.src = value;
      }
    };

    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(container);
    return () => ro.disconnect();
    // value намеренно не включаем — перерисовка при resize, а первичная отрисовка идёт при монтировании.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [height]);

  const getPoint = (ev: PointerEvent | React.PointerEvent) => {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    return { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
  };

  const handlePointerDown = (ev: React.PointerEvent<HTMLCanvasElement>) => {
    if (disabled) return;
    ev.preventDefault();
    canvasRef.current?.setPointerCapture(ev.pointerId);
    drawingRef.current = true;
    lastPointRef.current = getPoint(ev);
  };

  const handlePointerMove = (ev: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawingRef.current || disabled) return;
    const ctx = canvasRef.current?.getContext('2d');
    if (!ctx) return;
    const p = getPoint(ev);
    const last = lastPointRef.current;
    if (last) {
      ctx.beginPath();
      ctx.moveTo(last.x, last.y);
      ctx.lineTo(p.x, p.y);
      ctx.stroke();
    }
    lastPointRef.current = p;
    if (!hasInk) setHasInk(true);
  };

  const handlePointerUp = (ev: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawingRef.current) return;
    drawingRef.current = false;
    lastPointRef.current = null;
    canvasRef.current?.releasePointerCapture(ev.pointerId);
    // Экспорт PNG (data URL).
    const dataUrl = canvasRef.current?.toDataURL('image/png') || null;
    onChange(dataUrl);
  };

  const clear = () => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    const rect = canvas.getBoundingClientRect();
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, rect.width, rect.height);
    setHasInk(false);
    onChange(null);
  };

  return (
    <div ref={containerRef} className="w-full">
      <div className="relative rounded-xl border-2 border-dashed border-zinc-300 bg-white overflow-hidden">
        <canvas
          ref={canvasRef}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
          className="block touch-none cursor-crosshair w-full"
          style={{ height }}
        />
        {!hasInk && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none text-zinc-400 text-sm">
            Распишитесь здесь
          </div>
        )}
      </div>
      <div className="mt-2 flex justify-between items-center">
        <span className="text-xs text-zinc-400">
          {hasInk ? 'Подпись зафиксирована' : 'Подпись не задана'}
        </span>
        <button
          type="button"
          onClick={clear}
          disabled={disabled || !hasInk}
          className="inline-flex items-center gap-1.5 text-xs font-bold text-zinc-500 hover:text-zinc-900 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <Eraser size={14} /> Очистить
        </button>
      </div>
    </div>
  );
};
