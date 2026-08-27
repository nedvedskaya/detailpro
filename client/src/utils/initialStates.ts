import { getDateStr } from './helpers';

const newOperationId = (): string => crypto.randomUUID();

/**
 * Начальные состояния форм. Параметр branch удалён вместе с понятием филиала
 * (SaaS multi-tenant модель — все записи в одной схеме студии).
 */

export const getInitialTaskState = () => ({
  operationId: newOperationId(),
  title: '',
  date: getDateStr(0),
  time: '12:00',
  isUrgent: false,
  assigned_to: null as string | null,
});

export const getInitialBookingState = (options?: { clientName?: string }) => ({
  operationId: newOperationId(),
  ...(options?.clientName !== undefined && { clientName: options.clientName }),
  service: '',
  amount: '',
  advance: '',
  advanceDate: '',
  date: getDateStr(0),
  endDate: getDateStr(0),
  time: '10:00',
  paymentStatus: 'none' as const,
  category: '',
  tags: [] as (string | number)[],
  master_id: null as string | null,
  recordColor: 'none',
  isUrgent: false,
});

export const getInitialRecordState = () => getInitialBookingState();

/**
 * Начальное состояние формы клиента (поле branch удалено).
 */
export const getInitialClientState = () => ({
  operationId: newOperationId(),
  createdAt: getDateStr(0),
  name: '',
  phone: '',
  birthDate: '',
  city: '',
  cardColor: 'none',
  avatar: null as string | null,
  carBrand: '',
  carModel: '',
  comment: '',
  hasAppointment: false,
  service: '',
  amount: '',
  date: getDateStr(0),
  time: '10:00',
  paymentStatus: 'none',
});

export const getInitialTransactionState = () => {
  const now = new Date();
  return {
    title: '',
    amount: '',
    type: 'income' as 'income' | 'expense',
    sub: '',
    category: 'other',
    account: 'card',
    date: getDateStr(0),
    time: `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`,
  };
};

export const getInitialCalendarEntryState = () => getInitialBookingState({ clientName: '' });
