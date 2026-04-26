/**
 * Получить строку даты в формате ISO (YYYY-MM-DD)
 * @param offset - смещение в днях от текущей даты (по умолчанию 0)
 * @returns строка даты в формате YYYY-MM-DD
 */
export const getDateStr = (offset = 0): string => {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

export const parseLocalDate = (dateStr: string): Date => {
  if (!dateStr || typeof dateStr !== 'string') return new Date();
  const parts = dateStr.split('T')[0].split('-');
  if (parts.length === 3) {
    return new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]), 12, 0, 0);
  }
  return new Date(dateStr);
};

export const toDateStr = (val: any): string => {
  if (!val) return '';
  if (typeof val === 'string') {
    const datePart = val.split('T')[0];
    if (/^\d{4}-\d{2}-\d{2}$/.test(datePart)) return datePart;
    return '';
  }
  if (val instanceof Date && !isNaN(val.getTime())) {
    const year = val.getFullYear();
    const month = String(val.getMonth() + 1).padStart(2, '0');
    const day = String(val.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }
  return '';
};

export const parseDateParts = (dateStr: string): { year: number; month: number; day: number } => {
  const parts = (dateStr || '').split('T')[0].split('-');
  return { year: Number(parts[0]) || 0, month: (Number(parts[1]) || 1) - 1, day: Number(parts[2]) || 1 };
};

/**
 * Форматирование суммы денег с разделением разрядов пробелами
 * @param amount - сумма для форматирования
 * @returns отформатированная строка (например: "1 000 000")
 */
export const formatMoney = (amount: any): string => {
  if (amount === undefined || amount === null || amount === "" || typeof amount === 'object') {
    return "0";
  }
  return String(amount).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
};

/**
 * Форматирование даты в русский формат
 * @param dateStr - строка даты в ISO формате
 * @returns отформатированная дата (например: "15 января 2025")
 */
export const formatDate = (dateStr: string | undefined): string => {
  if (!dateStr || typeof dateStr !== 'string') return '';
  const date = parseLocalDate(dateStr);
  if (isNaN(date.getTime())) return dateStr;
  return date.toLocaleDateString('ru-RU', { 
    day: 'numeric', 
    month: 'long'
  });
};

/**
 * Форматирование даты в короткий формат
 * @param dateStr - строка даты в ISO формате
 * @returns отформатированная дата (например: "22 янв")
 */
export const formatDateShort = (dateStr: string | undefined): string => {
  if (!dateStr || typeof dateStr !== 'string') return '';
  const date = parseLocalDate(dateStr);
  if (isNaN(date.getTime())) return dateStr;
  
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  
  if (date.toDateString() === today.toDateString()) {
    return 'Сегодня';
  }
  
  if (date.toDateString() === yesterday.toDateString()) {
    return 'Вчера';
  }
  
  const day = date.getDate();
  const month = date.toLocaleDateString('ru-RU', { month: 'short' });
  
  return `${day} ${month}`;
};

/**
 * Форматирование времени в формат HH:MM
 * @param timeStr - строка времени
 * @returns отформатированное время
 */
export const formatTime = (timeStr: string | undefined): string => {
  if (!timeStr) return '';
  const parts = timeStr.split(':');
  if (parts.length >= 2) return `${parts[0]}:${parts[1]}`;
  return timeStr;
};


/**
 * Форматирование даты и времени
 * @param date - дата в любом формате
 * @param locale - локаль (по умолчанию 'ru-RU')
 * @returns отформатированная дата и время (например: "15.01.2025, 14:30")
 */
export const formatDateTime = (date: Date | string | null | undefined, locale = 'ru-RU'): string => {
  if (!date) return '—';
  let d: Date;
  if (date instanceof Date) {
    d = date;
  } else if (typeof date === 'string') {
    // ISO с «T» или Postgres-формат «YYYY-MM-DD HH:MM:SS» — парсим как полный datetime,
    // иначе fallback на parseLocalDate (для date-only строк, чтобы не было TZ-сдвига).
    if (date.includes('T') || /\d{4}-\d{2}-\d{2}\s\d{2}:\d{2}/.test(date)) {
      d = new Date(date.replace(' ', 'T'));
    } else {
      d = parseLocalDate(date);
    }
  } else {
    return '—';
  }
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleString(locale, {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
};

/**
 * Проверка, является ли дата сегодняшней
 * @param date - дата для проверки
 * @returns true если дата сегодня
 */
export const isToday = (date: Date | string): boolean => {
  const today = new Date();
  const checkDate = typeof date === 'string' ? parseLocalDate(date) : date;
  return today.toDateString() === checkDate.toDateString();
};

/**
 * Проверка, просрочена ли дата
 * @param date - дата для проверки
 * @returns true если дата в прошлом (но не сегодня)
 */
export const isOverdue = (date: Date | string): boolean => {
  const d = typeof date === 'string' ? parseLocalDate(date) : date;
  return d < new Date() && !isToday(date);
};

export const isBirthdayToday = (birthDate: string | undefined): boolean => {
  if (!birthDate) return false;
  const today = new Date();
  let day: number, month: number;
  const dotParts = birthDate.split('.');
  if (dotParts.length === 3) {
    day = parseInt(dotParts[0], 10);
    month = parseInt(dotParts[1], 10) - 1;
  } else {
    const bd = new Date(birthDate);
    if (isNaN(bd.getTime())) return false;
    day = bd.getDate();
    month = bd.getMonth();
  }
  return day === today.getDate() && month === today.getMonth();
};


export const isDateInRange = (
  date: Date | string, 
  startDate: Date | string, 
  endDate: Date | string
): boolean => {
  const check = typeof date === 'string' ? toDateStr(date) : toDateStr(date);
  const start = typeof startDate === 'string' ? toDateStr(startDate) : toDateStr(startDate);
  const end = typeof endDate === 'string' ? toDateStr(endDate) : toDateStr(endDate);
  return check >= start && check <= end;
};

export const findCategoryById = (categories: any[], categoryId: any): any | undefined => {
  if (!categoryId) return undefined;
  const strId = String(categoryId);
  return categories.find(c => String(c.id) === strId);
};

export const findTagsByIds = (allTags: any[], tagIds: any[]): any[] => {
  if (!tagIds || !Array.isArray(tagIds) || tagIds.length === 0) return [];
  const strIds = tagIds.map(String);
  return allTags.filter(tag => strIds.includes(String(tag.id)));
};

export const matchId = (a: any, b: any): boolean => {
  if (!a || !b) return false;
  return String(a) === String(b);
};

const PG_INT_MAX = 2147483647;

export const safeCategoryId = (categoryValue: any): number | null => {
  if (!categoryValue) return null;
  const str = String(categoryValue);
  if (str.startsWith('temp_')) return null;
  const num = parseInt(str, 10);
  if (isNaN(num) || num > PG_INT_MAX || num <= 0) return null;
  return num;
};

export const normalizeRecord = (record: any) => {
  let parsedTags: string[] = [];
  if (Array.isArray(record.tags)) {
    parsedTags = record.tags.map(String);
  } else if (typeof record.tags === 'string') {
    try { parsedTags = JSON.parse(record.tags || '[]').map(String); } catch { parsedTags = []; }
  }
  return {
    id: record.id,
    service: record.service_name || record.description || '',
    date: toDateStr(record.date) || getDateStr(0),
    time: record.time || '10:00',
    amount: parseFloat(record.amount) || 0,
    advance: parseFloat(record.advance) || 0,
    advanceDate: toDateStr(record.advance_date),
    endDate: toDateStr(record.end_date),
    category: record.category_id ? String(record.category_id) : '',
    tags: parsedTags,
    paymentStatus: record.payment_status || 'none',
    isPaid: record.is_paid || false,
    isCompleted: record.is_completed || false
  };
};

export const normalizeTask = (t: any) => ({
  ...t,
  clientId: t.client_id || null,
  clientName: t.client_name || null,
  completed: t.status === 'completed',
  urgency: t.priority === 'high' ? 'high' : 'low',
  date: t.due_date || t.date || getDateStr(0),
  time: t.time || '10:00'
});

export const normalizeClient = (client: any, records: any[] = []) => {
  let parsedNotes: any = {};
  try { parsedNotes = client.notes ? JSON.parse(client.notes) : {}; } catch { parsedNotes = {}; }
  return {
    ...client,
    city: client.city || '',
    source: client.source || '',
    birthDate: client.birth_date || '',
    avatar: client.avatar || null,
    carBrand: parsedNotes.carBrand || '',
    carModel: parsedNotes.carModel || '',
    vin: parsedNotes.vin || '',
    licensePlate: parsedNotes.licensePlate || '',
    comment: parsedNotes.comment || '',
    records
  };
};

export const normalizeTransaction = (t: any) => {
  let parsedTags: string[] = [];
  if (Array.isArray(t.tags)) {
    parsedTags = t.tags.map(String);
  } else if (typeof t.tags === 'string') {
    try { parsedTags = JSON.parse(t.tags).map(String); } catch { parsedTags = []; }
  }
  return {
    ...t,
    description: t.description || '',
    category: t.category ? String(t.category) : '',
    date: toDateStr(t.date) || toDateStr(t.created_at) || getDateStr(0),
    time: t.time || null,
    createdDate: toDateStr(t.created_at) || toDateStr(t.date) || getDateStr(0),
    tags: parsedTags
  };
};

export const buildClientPayload = (data: any) => ({
  name: data.name,
  phone: data.phone || '',
  email: data.email || '',
  city: data.city || '',
  source: data.source || '',
  birth_date: data.birthDate || null,
  avatar: data.avatar || null,
  notes: JSON.stringify({
    carBrand: data.carBrand,
    carModel: data.carModel,
    vin: data.vin,
    licensePlate: data.licensePlate,
    comment: data.comment || ''
  })
});

export const buildTaskPayload = (task: any, overrides: Record<string, any> = {}) => ({
  title: task.title || '',
  description: task.description || '',
  status: task.completed ? 'completed' : 'pending',
  priority: task.urgency === 'high' ? 'high' : 'medium',
  client_id: task.clientId || null,
  due_date: task.date || null,
  ...overrides
});

export const buildRecordPayload = (rec: any, clientId: number | string, overrides: Record<string, any> = {}) => ({
  client_id: clientId,
  service_name: rec.service || rec.service_name || '',
  description: rec.service || rec.service_name || '',
  date: rec.date,
  time: rec.time || '10:00',
  amount: parseFloat(rec.amount) || 0,
  advance: parseFloat(rec.advance) || 0,
  advance_date: rec.advanceDate || rec.advance_date || null,
  end_date: rec.endDate || rec.end_date || null,
  category_id: safeCategoryId(rec.category || rec.category_id),
  tags: Array.isArray(rec.tags) ? rec.tags : [],
  payment_status: rec.paymentStatus || rec.payment_status || 'none',
  is_paid: (rec.paymentStatus || rec.payment_status) === 'paid',
  is_completed: rec.isCompleted || rec.is_completed || false,
  ...overrides
});

export const compressImage = (file: File, maxSize = 128, quality = 0.7): Promise<string> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        let w = img.width;
        let h = img.height;
        if (w > h) { if (w > maxSize) { h = Math.round(h * maxSize / w); w = maxSize; } }
        else { if (h > maxSize) { w = Math.round(w * maxSize / h); h = maxSize; } }
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        if (!ctx) return reject(new Error('Canvas not supported'));
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(img, 0, 0, w, h);
        const dataUrl = canvas.toDataURL('image/webp', quality);
        resolve(dataUrl.startsWith('data:image/webp') ? dataUrl : canvas.toDataURL('image/jpeg', quality));
      };
      img.onerror = reject;
      img.src = e.target?.result as string;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
};
