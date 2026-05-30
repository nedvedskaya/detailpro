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

/**
 * Устойчивый парсер для значений из Postgres TIMESTAMPTZ.
 *
 * Зачем отдельная функция: дефолтный `new Date(...)` в Safari/iOS падает на
 * двух квирках формата pg-драйвера:
 *   1. Микросекунды («2026-04-26 11:28:31.968692+00») — Safari ждёт максимум
 *      миллисекунды, поэтому хвост `968692` интерпретируется как ошибка.
 *   2. Без двоеточия в TZ-смещении («+00» вместо «+00:00») — тоже Invalid Date.
 *   3. Пробел вместо «T» как разделитель даты и времени — Chrome/Firefox
 *      ещё кушают, а Safari нет.
 *
 * Эта функция нормализует все три случая и возвращает `null` для невалидного
 * входа (вместо «Invalid Date»), чтобы вызывающий код мог честно показать
 * fallback-текст вроде «дата не указана» вместо «дата некорректна».
 *
 * Используется в ProfilePage для access_until и в любых других местах,
 * где приходит TIMESTAMPTZ из бэка. Для DATE-only полей (YYYY-MM-DD) лучше
 * использовать parseLocalDate выше — он не «теряет» день из-за TZ.
 */
export const parseDbDate = (value: string | Date | null | undefined): Date | null => {
  if (!value) return null;
  if (value instanceof Date) return isNaN(value.getTime()) ? null : value;
  let str = String(value).trim();
  if (!str) return null;
  // Чистый DATE — отдаём через локальный полдень, как parseLocalDate.
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) {
    const [y, m, day] = str.split('-').map(Number);
    return new Date(y, m - 1, day, 12, 0, 0);
  }
  if (/^\d{4}-\d{2}-\d{2}\s\d{2}:\d{2}/.test(str)) str = str.replace(' ', 'T');
  str = str.replace(/\.(\d{3})\d+/, '.$1');           // µs → ms
  str = str.replace(/([+-]\d{2})$/, '$1:00');          // +00 → +00:00
  const d = new Date(str);
  return isNaN(d.getTime()) ? null : d;
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
 *
 * Принимает Postgres TIMESTAMPTZ (с микросекундами и неполным TZ типа «+00»)
 * и DATE-only строки — всё через parseDbDate / parseLocalDate, чтобы не падать
 * в Safari/Chrome на квирках pg-драйвера.
 */
export const formatDateTime = (date: Date | string | null | undefined, locale = 'ru-RU'): string => {
  if (!date) return '—';
  let d: Date | null;
  if (date instanceof Date) {
    d = isNaN(date.getTime()) ? null : date;
  } else if (typeof date === 'string') {
    // DATE-only (YYYY-MM-DD) — через parseLocalDate, чтобы не было TZ-сдвига на день.
    // Всё остальное (ISO с «T», PG-формат с пробелом, µs, «+00») — через parseDbDate.
    d = /^\d{4}-\d{2}-\d{2}$/.test(date) ? parseLocalDate(date) : parseDbDate(date);
  } else {
    return '—';
  }
  if (!d || isNaN(d.getTime())) return '—';
  return d.toLocaleString(locale, {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
};

/**
 * formatDateRu — «26 апреля 2026», без времени, для дат регистрации, доступа,
 * подписки и т.п.
 *
 * Работает с Postgres TIMESTAMPTZ (включая микросекунды и неполный TZ-сдвиг
 * вроде «+00») и с чистыми DATE («YYYY-MM-DD»). Для невалидного входа
 * возвращает «—», чтобы UI не падал на «Invalid Date».
 *
 * Используется в ProfilePage (дата регистрации, access_until), AdminPanel
 * (дата регистрации сотрудника) и везде, где нужна «человеческая» дата без часов.
 */
export const formatDateRu = (value: string | Date | null | undefined): string => {
  const d = parseDbDate(value);
  if (!d) return '—';
  return d.toLocaleDateString('ru-RU', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
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
  // services: JSONB-массив снимков услуг. PG-pg-driver обычно отдаёт уже
  // распарсенный объект, но на всякий случай ловим строковую форму.
  let parsedServices: any[] = [];
  if (Array.isArray(record.services)) {
    parsedServices = record.services;
  } else if (typeof record.services === 'string') {
    try { parsedServices = JSON.parse(record.services || '[]'); } catch { parsedServices = []; }
  }
  return {
    id: record.id,
    service: record.service_name || record.description || '',
    services: parsedServices,
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
    isCompleted: record.is_completed || false,
    isUrgent: record.is_urgent || false,
    master_id: record.master_id || null,
    master_name: record.master_name || null
  };
};

export const normalizeTask = (t: any) => ({
  ...t,
  clientId: t.client_id || null,
  clientName: t.client_name || null,
  completed: t.status === 'done',
  urgency: t.priority === 'high' ? 'high' : 'low',
  date: t.due_date || t.date || getDateStr(0),
  time: t.due_time || t.time || '10:00',
  assigned_to: t.assigned_to || null,
  assigned_to_name: t.assigned_to_name || null
});

export const normalizeClient = (client: any, records: any[] = []) => {
  let parsedNotes: any = {};
  try { parsedNotes = client.notes ? JSON.parse(client.notes) : {}; } catch { parsedNotes = {}; }
  return {
    ...client,
    city: client.city || '',
    source: client.source || '',
    cardColor: client.card_color || client.cardColor || 'none',
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
  card_color: data.cardColor || 'none',
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
  status: task.completed ? 'done' : 'pending',
  priority: task.urgency === 'high' ? 'high' : 'medium',
  client_id: task.clientId || null,
  due_date: task.date || null,
  due_time: task.time || null,
  assigned_to: task.assigned_to || null,
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
  is_urgent: rec.isUrgent || rec.is_urgent || false,
  master_id: rec.master_id || null,
  // Multi-service: пробрасываем массив строк услуг как есть. Бэк его
  // resolveServices'ом преобразует в snapshot и пересчитает amount/
  // service_name (защита от подмены). Если массива нет — бэк fallback'нет
  // на legacy service_name + amount.
  services: Array.isArray(rec.services) ? rec.services : undefined,
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
