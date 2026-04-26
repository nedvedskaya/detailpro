import React, { useState, useEffect, useCallback, useRef } from 'react';
import { X, AlertTriangle, CheckCircle2, Info, WifiOff } from 'lucide-react';

type ToastType = 'success' | 'error' | 'warning' | 'info' | 'offline';

interface ToastMessage {
  id: number;
  text: string;
  type: ToastType;
}

const TOAST_ICONS: Record<ToastType, React.ElementType> = {
  success: CheckCircle2,
  error: AlertTriangle,
  warning: AlertTriangle,
  info: Info,
  offline: WifiOff,
};

const TOAST_COLORS: Record<ToastType, string> = {
  success: 'bg-emerald-600',
  error: 'bg-red-600',
  warning: 'bg-amber-500',
  info: 'bg-blue-600',
  offline: 'bg-amber-600',
};

let globalAddToast: ((text: string, type?: ToastType) => void) | null = null;

export function showToast(text: string, type: ToastType = 'info') {
  if (globalAddToast) globalAddToast(text, type);
}

export const ToastContainer: React.FC = () => {
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const counterRef = useRef(0);

  const addToast = useCallback((text: string, type: ToastType = 'info') => {
    const id = ++counterRef.current;
    setToasts(prev => [...prev.slice(-4), { id, text, type }]);
    setTimeout(() => {
      setToasts(prev => prev.filter(t => t.id !== id));
    }, 4000);
  }, []);

  useEffect(() => {
    globalAddToast = addToast;
    return () => { globalAddToast = null; };
  }, [addToast]);

  const removeToast = (id: number) => {
    setToasts(prev => prev.filter(t => t.id !== id));
  };

  if (toasts.length === 0) return null;

  return (
    <div className="fixed left-0 right-0 z-[9999] flex flex-col gap-2 items-center px-4 pointer-events-none" style={{ top: 'calc(env(safe-area-inset-top, 0px) + 16px)' }}>
      {toasts.map(toast => {
        const Icon = TOAST_ICONS[toast.type];
        return (
          <div
            key={toast.id}
            className={`${TOAST_COLORS[toast.type]} text-white rounded-2xl px-4 py-3 shadow-2xl flex items-start gap-3 pointer-events-auto animate-slide-down w-full max-w-md`}
          >
            <Icon size={20} className="shrink-0 mt-0.5" />
            <p className="text-sm font-medium flex-1">{toast.text}</p>
            <button onClick={() => removeToast(toast.id)} className="shrink-0 opacity-70 hover:opacity-100">
              <X size={16} />
            </button>
          </div>
        );
      })}
    </div>
  );
};
