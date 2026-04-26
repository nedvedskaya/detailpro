import { Calendar, Clock, DollarSign, User } from 'lucide-react';
import { FormField } from './FormField';
import { PaymentStatusSelector } from '@/app/components/ui/PaymentStatusSelector';

interface StudioMember {
  id: string;
  name: string;
  role?: string;
  is_active?: boolean;
}

interface BookingFormFieldsProps {
  bookingData: {
    service: string;
    date: string;
    endDate?: string;
    time: string;
    amount: string | number;
    category?: string;
    paymentStatus: 'none' | 'advance' | 'paid';
    master_id?: string | null;
  };
  onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => void;
  categories?: { value: string; label: string }[];
  showEndDate?: boolean;
  masters?: StudioMember[];
}

export const BookingFormFields = ({
  bookingData,
  onChange,
  categories = [],
  showEndDate = false,
  masters
}: BookingFormFieldsProps) => {
  return (
    <div className="space-y-3">
      <FormField
        label="Услуга"
        name="service"
        type="text"
        value={bookingData.service}
        onChange={onChange}
        placeholder="Например: Сплиттер, Диффузор..."
        required
      />

      {categories.length > 0 && (
        <FormField
          label="Категория"
          name="category"
          type="select"
          value={bookingData.category || ''}
          onChange={onChange}
          options={categories}
          placeholder="Выберите категорию"
        />
      )}

      <div className="grid grid-cols-2 gap-3">
        <FormField
          label="Дата начала"
          name="date"
          type="date"
          value={bookingData.date}
          onChange={onChange}
          icon={Calendar}
          required
        />

        {showEndDate && (
          <FormField
            label="Дата окончания"
            name="endDate"
            type="date"
            value={bookingData.endDate || ''}
            onChange={onChange}
            icon={Calendar}
          />
        )}

        <FormField
          label="Время"
          name="time"
          type="time"
          value={bookingData.time}
          onChange={onChange}
          icon={Clock}
        />

        <FormField
          label="Сумма (₽)"
          name="amount"
          type="number"
          value={bookingData.amount}
          onChange={onChange}
          icon={DollarSign}
          placeholder="0"
          required
        />
      </div>

      {masters && masters.length > 0 && (
        <FormField
          label="Мастер"
          name="master_id"
          type="select"
          value={bookingData.master_id ?? ''}
          onChange={onChange}
          icon={User}
          options={[
            { value: '', label: 'Не назначен' },
            ...masters.filter(m => m.is_active !== false).map(m => ({ value: m.id, label: m.name })),
          ]}
        />
      )}

      {/* Статус оплаты */}
      <PaymentStatusSelector
        value={bookingData.paymentStatus}
        onChange={(value) => onChange({ target: { name: 'paymentStatus', value } } as any)}
      />
    </div>
  );
};