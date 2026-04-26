import type { PaymentStatus } from '@/utils/types';
import { PAYMENT_STATUSES } from '@/utils/constants';

interface PaymentStatusSelectorProps {
  value: PaymentStatus;
  onChange: (value: PaymentStatus) => void;
  disabled?: boolean;
  className?: string;
  name?: string;
}

/**
 * Селектор статуса оплаты (Не оплачено / Аванс / Оплачено)
 * 
 * @example
 * // С обработчиком события
 * <PaymentStatusSelector 
 *   value={bookingData.paymentStatus}
 *   onChange={(value) => handleChange({ target: { name: 'paymentStatus', value } })}
 * />
 * 
 * @example
 * // С прямым onChange
 * <PaymentStatusSelector 
 *   value={status}
 *   onChange={setStatus}
 * />
 */
export const PaymentStatusSelector = ({ 
  value, 
  onChange,
  disabled = false,
  className = '',
  name = 'paymentStatus'
}: PaymentStatusSelectorProps) => {
  const statuses = PAYMENT_STATUSES;

  const getButtonClass = (status: typeof statuses[0]) => {
    const isActive = value === status.value;
    const baseClass = 'flex-1 px-2 py-2 rounded-xl text-xs font-semibold transition-all';
    
    if (disabled) {
      return `${baseClass} opacity-50 cursor-not-allowed bg-gray-100 text-gray-400`;
    }

    if (isActive) {
      if (status.color === 'gray') {
        return `${baseClass} bg-gray-500 text-white shadow-lg shadow-gray-500/30`;
      }
      return `${baseClass} bg-orange-500 text-white shadow-lg shadow-orange-500/30`;
    }

    return `${baseClass} bg-gray-100 text-gray-400 hover:bg-gray-200`;
  };

  return (
    <div className={className}>
      <label className="text-xs font-black text-zinc-400 uppercase tracking-widest mb-2 block">
        Статус оплаты
      </label>
      <div className="flex gap-2">
        {statuses.map(status => (
          <button
            key={status.value}
            type="button"
            onClick={() => !disabled && onChange(status.value)}
            disabled={disabled}
            className={getButtonClass(status)}
          >
            {status.label}
          </button>
        ))}
      </div>
    </div>
  );
};