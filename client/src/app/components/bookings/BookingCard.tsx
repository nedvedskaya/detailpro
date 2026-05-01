import { Calendar, Clock, Edit3, Trash2, Check } from 'lucide-react';
import { formatDate, formatTime, formatMoney } from '@/utils/helpers';
import { Badge } from '@/app/components/ui';

interface BookingCardProps {
  record: any;
  onEdit?: () => void;
  onComplete?: () => void;
  showActions?: boolean;
  compact?: boolean;
}

export const BookingCard = ({ 
  record, 
  onEdit, 
  onComplete,
  showActions = true,
  compact = false
}: BookingCardProps) => {
  const getPaymentStatus = () => {
    if (record.paymentStatus === 'paid' || record.isPaid) {
      return { variant: 'payment-paid' as const, label: 'Оплачено' };
    }
    if (record.paymentStatus === 'advance') {
      return { variant: 'payment-advance' as const, label: 'Аванс' };
    }
    return { variant: 'payment-none' as const, label: 'Не оплачено' };
  };

  const paymentStatus = getPaymentStatus();

  if (compact) {
    return (
      <div className="p-3 bg-white rounded-lg border border-zinc-200">
        <div className="flex items-center justify-between mb-1">
          <span className="text-sm font-bold text-zinc-900">{String(record.service || '')}</span>
          <span className="text-sm font-bold text-orange-600">{formatMoney(record.amount)} ₽</span>
        </div>
        <div className="flex items-center gap-2 text-xs text-zinc-500 whitespace-nowrap">
          <Calendar size={12} />
          <span>{formatDate(record.date)}</span>
          {record.time && (
            <>
              <Clock size={12} />
              <span>{formatTime(record.time)}</span>
            </>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-2xl bg-white border border-zinc-200 shadow-md overflow-hidden">
      {/* Оранжевая полоска сверху */}
      <div className="h-1 bg-gradient-to-r from-orange-500 to-orange-600" />
      
      <div className="p-4 space-y-3">
        {/* Заголовок с кнопками */}
        <div className="flex items-start justify-between">
          <div className="flex-1">
            <h4 className="text-base font-bold text-zinc-900 mb-1">
              {String(record.service || '')}
            </h4>
            <div className="flex items-center gap-2 flex-wrap">
              <Badge variant={paymentStatus.variant}>
                {paymentStatus.label}
              </Badge>
              {record.category && (
                <Badge variant="status">
                  {String(record.category)}
                </Badge>
              )}
            </div>
          </div>
          
          {showActions && (
            <div className="flex gap-1 ml-2">
              {onEdit && (
                <button 
                  onClick={onEdit}
                  className="p-2 text-zinc-400 hover:text-orange-600 transition-colors"
                >
                  <Edit3 size={16} />
                </button>
              )}
              {onComplete && !record.isCompleted && (
                <button 
                  onClick={onComplete}
                  className="p-2 text-zinc-400 hover:text-green-600 transition-colors"
                >
                  <Check size={16} />
                </button>
              )}
            </div>
          )}
        </div>

        {/* Информация о бронировании */}
        <div className="grid grid-cols-2 gap-3 text-xs">
          <div>
            <span className="text-zinc-400 font-medium">Дата начала</span>
            <div className="flex items-center gap-1 mt-1">
              <Calendar size={12} className="text-zinc-500" />
              <p className="font-bold text-zinc-800 whitespace-nowrap">{formatDate(record.date)}</p>
            </div>
          </div>
          
          {record.endDate && (
            <div>
              <span className="text-zinc-400 font-medium">Дата выдачи</span>
              <div className="flex items-center gap-1 mt-1">
                <Calendar size={12} className="text-zinc-500" />
                <p className="font-bold text-zinc-800 whitespace-nowrap">{formatDate(record.endDate)}</p>
              </div>
            </div>
          )}
          
          {record.time && (
            <div>
              <span className="text-zinc-400 font-medium">Время</span>
              <div className="flex items-center gap-1 mt-1">
                <Clock size={12} className="text-zinc-500" />
                <p className="font-bold text-zinc-800">{formatTime(record.time)}</p>
              </div>
            </div>
          )}
          
          <div>
            <span className="text-zinc-400 font-medium">Сумма</span>
            <p className="font-bold text-orange-600 text-base mt-1">
              {formatMoney(record.amount)} ₽
            </p>
          </div>
        </div>
      </div>
    </div>
  );
};
