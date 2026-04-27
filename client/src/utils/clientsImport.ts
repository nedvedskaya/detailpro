/**
 * Импорт базы клиентов из .xlsx.
 *
 * Состоит из двух частей:
 *   1) downloadClientsImportTemplate() — генерит и скачивает шаблон
 *      с двумя листами: «Клиенты» (там колонки + одна строка-пример) и
 *      «Подсказка» (как заполнять). Лист данных стартует с заголовка
 *      жирным + freeze panes на первой строке. Обязательные колонки
 *      (Имя) подсвечены оранжевым, чтобы пользователь сразу понимал,
 *      что без них строка отобьётся.
 *
 *   2) parseClientsImportFile(file) — читает загруженный xlsx, нормализует
 *      каждую строку в форму, которую ждёт POST /api/clients/bulk:
 *      { client: {...}, vehicle?: {...} }, плюс per-row errors для UI.
 *
 * Почему НЕ csv: пользователю проще работать в Excel/Numbers, а xlsx
 * сохраняет типы (телефон не превращается в число с ведущим нулём,
 * дата не уезжает в формат локали). exceljs уже в бандле — нет повода
 * тащить ещё и Papa Parse.
 */

const REQUIRED_HEADERS = ['Имя'] as const;

// Маппинг «человеческие» заголовки шаблона → ключи в payload.
// Если пользователь переставит колонки местами — мы всё равно найдём
// нужные по заголовку. Если заголовок отличается (опечатка/перевод/
// переименование) — строка просто не подхватится в этом поле, а в UI
// появится подсказка «не нашли колонку Х».
const HEADER_MAP = {
  'Имя': 'name',
  'Телефон': 'phone',
  'Email': 'email',
  'Город': 'city',
  'Источник': 'source',
  'Дата рождения': 'birth_date',
  'Заметка': 'notes',
  'Марка авто': 'vehicle_brand',
  'Модель авто': 'vehicle_model',
  'Гос. номер': 'vehicle_plate',
  'Цвет авто': 'vehicle_color',
  'Год авто': 'vehicle_year',
} as const;

type HeaderKey = typeof HEADER_MAP[keyof typeof HEADER_MAP];

const COLUMNS_ORDER: Array<{ header: string; key: HeaderKey; width: number; required?: boolean }> = [
  { header: 'Имя', key: 'name', width: 26, required: true },
  { header: 'Телефон', key: 'phone', width: 22 },
  { header: 'Email', key: 'email', width: 28 },
  { header: 'Город', key: 'city', width: 18 },
  { header: 'Источник', key: 'source', width: 18 },
  { header: 'Дата рождения', key: 'birth_date', width: 16 },
  { header: 'Заметка', key: 'notes', width: 40 },
  { header: 'Марка авто', key: 'vehicle_brand', width: 16 },
  { header: 'Модель авто', key: 'vehicle_model', width: 16 },
  { header: 'Гос. номер', key: 'vehicle_plate', width: 14 },
  { header: 'Цвет авто', key: 'vehicle_color', width: 14 },
  { header: 'Год авто', key: 'vehicle_year', width: 10 },
];

const HINT_LINES: Array<[string, string]> = [
  ['Имя', 'Обязательное поле. Имя или ФИО клиента. Если оставить пустым — строка пропустится и попадёт в список ошибок.'],
  ['Телефон', 'Формат свободный: «+7 (920) 610-18-41», «8 920 610 18 41», «79206101841» — мы нормализуем сами. По телефону ищутся дубликаты при загрузке.'],
  ['Email', 'Необязательно. Если указан — должен быть валидным («info@example.com»). Иначе строка пометится как ошибка.'],
  ['Город', 'Свободный текст. Используется для фильтра и аналитики.'],
  ['Источник', 'Откуда пришёл клиент: «инстаграм», «по рекомендации», «директ» и т.п. Свободный текст.'],
  ['Дата рождения', 'Формат «ДД.ММ.ГГГГ», например 12.03.1990. Если в Excel ячейка отформатирована как дата — тоже распознается.'],
  ['Заметка', 'Любые комментарии: предпочтения по детейлингу, особенности кузова, аллергии на химию и т.д.'],
  ['Марка авто', 'Если у клиента одна машина — заполняйте, она создастся вместе с клиентом. Несколько машин — добавьте после импорта вручную в карточке клиента.'],
  ['Модель авто', 'Опционально. Например, «X5», «Camry».'],
  ['Гос. номер', 'Опционально. Любой формат, его не валидируем.'],
  ['Цвет авто', 'Опционально. «Чёрный», «Белый перламутр» и т.д.'],
  ['Год авто', 'Опционально. Только год выпуска (4 цифры). Например, 2020.'],
];

const HINT_NOTE = [
  'Удалите строку-пример (Иван Иванов) перед загрузкой — она показана только для образца.',
  'При импорте мы ищем совпадения по нормализованному телефону. Можно выбрать стратегию:',
  '  • «Пропустить дубликаты» — существующие клиенты не трогаются.',
  '  • «Перезаписать» — поля старого клиента заменяются на новые из файла.',
  '  • «Создать новых» — каждый ряд создаст нового клиента, даже если телефон уже есть.',
  'Лимит за один импорт — 5000 строк. Если у вас больше, разбейте файл на несколько.',
];

/**
 * Скачивает .xlsx-шаблон в браузер. Файл — два листа: «Клиенты» (колонки
 * + одна строка-пример) и «Подсказка». На листе «Клиенты» первая строка
 * закреплена и выделена жирным; колонка «Имя» подсвечена оранжевым
 * как обязательная.
 */
export async function downloadClientsImportTemplate(): Promise<void> {
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  wb.creator = 'DetailPro CRM';
  wb.created = new Date();

  // ── Лист 1: Клиенты ───────────────────────────────────────────
  const ws = wb.addWorksheet('Клиенты', {
    views: [{ state: 'frozen', ySplit: 1 }], // freeze header
  });
  ws.columns = COLUMNS_ORDER.map(c => ({
    header: c.header,
    key: c.key,
    width: c.width,
  }));

  // Header row styling
  const headerRow = ws.getRow(1);
  headerRow.font = { bold: true, color: { argb: 'FF1F2937' } };
  headerRow.alignment = { vertical: 'middle', horizontal: 'left' };
  headerRow.height = 22;

  // Подсветка обязательных колонок
  COLUMNS_ORDER.forEach((col, idx) => {
    if (col.required) {
      const cell = headerRow.getCell(idx + 1);
      cell.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FFFED7AA' }, // orange-200
      };
    }
  });

  // Пример-заполнение
  ws.addRow({
    name: 'Иван Иванов',
    phone: '+7 (920) 610-18-41',
    email: 'ivan@example.com',
    city: 'Москва',
    source: 'инстаграм',
    birth_date: '12.03.1990',
    notes: 'Любит кварц, не любит керамику',
    vehicle_brand: 'BMW',
    vehicle_model: 'X5',
    vehicle_plate: 'А123БВ77',
    vehicle_color: 'Чёрный',
    vehicle_year: 2020,
  });

  // ── Лист 2: Подсказка ──────────────────────────────────────
  const wh = wb.addWorksheet('Подсказка');
  wh.columns = [
    { header: 'Колонка', key: 'col', width: 22 },
    { header: 'Как заполнять', key: 'desc', width: 90 },
  ];
  const wRow = wh.getRow(1);
  wRow.font = { bold: true };
  wRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF3F4F6' } };

  HINT_LINES.forEach(([col, desc]) => {
    const r = wh.addRow({ col, desc });
    r.alignment = { vertical: 'top', wrapText: true };
  });

  // Пустая строка + примечания
  wh.addRow({});
  const noteHeader = wh.addRow({ col: 'Важно' });
  noteHeader.font = { bold: true };
  HINT_NOTE.forEach(line => {
    const r = wh.addRow({ desc: line });
    r.alignment = { vertical: 'top', wrapText: true };
  });

  const buffer = await wb.xlsx.writeBuffer();
  const blob = new Blob([buffer], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'detailpro_клиенты_шаблон.xlsx';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ──────────────────────────────────────────────────────────────────
// Парсинг загруженного файла

export interface ParsedRow {
  rowNum: number;
  client: {
    name: string;
    phone?: string | null;
    email?: string | null;
    notes?: string | null;
    city?: string | null;
    source?: string | null;
    birth_date?: string | null;
  };
  vehicle?: {
    brand?: string | null;
    model?: string | null;
    license_plate?: string | null;
    color?: string | null;
    year?: number | null;
  } | null;
  /**
   * Локальные ошибки этой строки, найденные на клиенте до отправки на бэк.
   * Если массив непустой — строка не уйдёт в payload.
   */
  errors: string[];
}

export interface ParseResult {
  rows: ParsedRow[];
  /**
   * Структурные ошибки файла целиком (нет колонки «Имя», пустой лист, и т.п.) —
   * не для конкретной строки, а для всего импорта.
   */
  fatalErrors: string[];
}

const isExcelDate = (val: unknown): val is Date =>
  val instanceof Date && !Number.isNaN(val.getTime());

const formatExcelDate = (d: Date): string => {
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const yyyy = d.getUTCFullYear();
  return `${dd}.${mm}.${yyyy}`;
};

const cellToString = (val: unknown): string => {
  if (val === null || val === undefined) return '';
  if (typeof val === 'string') return val.trim();
  if (typeof val === 'number') return String(val);
  if (typeof val === 'boolean') return val ? 'да' : 'нет';
  if (isExcelDate(val)) return formatExcelDate(val);
  // ExcelJS rich text: { richText: [{text:...}] }
  if (typeof val === 'object' && val !== null) {
    const obj = val as { richText?: Array<{ text: string }>; text?: string; result?: unknown };
    if (Array.isArray(obj.richText)) {
      return obj.richText.map(p => p?.text ?? '').join('').trim();
    }
    if (typeof obj.text === 'string') return obj.text.trim();
    if (obj.result !== undefined) return cellToString(obj.result);
  }
  return String(val).trim();
};

// Email-валидатор — простой, без RFC-чудес. Достаточно для отсева
// откровенного мусора («Иван@» или «без собачки»). Серверной валидации
// мы тут не дублируем — на бэке email хранится как есть.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Дата рождения — принимаем «ДД.ММ.ГГГГ», «ДД-ММ-ГГГГ», «ДД/ММ/ГГГГ»,
// «ГГГГ-ММ-ДД» и Excel-Date (Date object).
const parseBirthDate = (raw: string): { ok: boolean; value?: string } => {
  if (!raw) return { ok: true, value: undefined };
  const trimmed = raw.trim();
  // dd.mm.yyyy / dd-mm-yyyy / dd/mm/yyyy
  let m = trimmed.match(/^(\d{1,2})[.\-/](\d{1,2})[.\-/](\d{2,4})$/);
  if (m) {
    let [, dd, mm, yyyy] = m;
    if (yyyy.length === 2) yyyy = (Number(yyyy) > 50 ? '19' : '20') + yyyy;
    return { ok: true, value: `${dd.padStart(2, '0')}.${mm.padStart(2, '0')}.${yyyy}` };
  }
  // yyyy-mm-dd
  m = trimmed.match(/^(\d{4})[.\-/](\d{1,2})[.\-/](\d{1,2})$/);
  if (m) {
    const [, yyyy, mm, dd] = m;
    return { ok: true, value: `${dd.padStart(2, '0')}.${mm.padStart(2, '0')}.${yyyy}` };
  }
  return { ok: false };
};

const parseYear = (raw: string): { ok: boolean; value?: number } => {
  if (!raw) return { ok: true };
  const n = Number(raw.replace(/\D/g, ''));
  if (!Number.isFinite(n) || n < 1900 || n > 2100) return { ok: false };
  return { ok: true, value: n };
};

export async function parseClientsImportFile(file: File): Promise<ParseResult> {
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();

  let buffer: ArrayBuffer;
  try {
    buffer = await file.arrayBuffer();
  } catch {
    return { rows: [], fatalErrors: ['Не удалось прочитать файл — попробуйте сохранить его как .xlsx и загрузить снова.'] };
  }

  try {
    await wb.xlsx.load(buffer);
  } catch {
    return { rows: [], fatalErrors: ['Файл повреждён или это не .xlsx. Скачайте свежий шаблон и заполните его в Excel/Numbers/Google Sheets.'] };
  }

  // Берём первый непустой worksheet — обычно «Клиенты», но если переименовали,
  // тоже подхватится.
  const ws = wb.worksheets.find(w => w.rowCount > 1);
  if (!ws) {
    return { rows: [], fatalErrors: ['В файле нет ни одной строки данных. Проверьте, что вы заполнили лист «Клиенты», и сохраните файл.'] };
  }

  // Читаем заголовки из первой строки. Маппим по «нашим» именам.
  const headerRow = ws.getRow(1);
  const colKeyByIndex = new Map<number, HeaderKey>();
  headerRow.eachCell({ includeEmpty: false }, (cell, colNumber) => {
    const text = cellToString(cell.value);
    if (!text) return;
    const mapped = (HEADER_MAP as Record<string, HeaderKey>)[text];
    if (mapped) colKeyByIndex.set(colNumber, mapped);
  });

  // Обязательная колонка «Имя» должна быть.
  const allKeys = new Set(colKeyByIndex.values());
  const fatalErrors: string[] = [];
  for (const required of REQUIRED_HEADERS) {
    const requiredKey = (HEADER_MAP as Record<string, HeaderKey>)[required];
    if (!allKeys.has(requiredKey)) {
      fatalErrors.push(`Не нашли колонку «${required}» — она обязательна. Скачайте свежий шаблон и не переименовывайте заголовки.`);
    }
  }
  if (fatalErrors.length) return { rows: [], fatalErrors };

  // Парсим строки.
  const rows: ParsedRow[] = [];
  const totalRows = ws.rowCount;
  for (let rowIdx = 2; rowIdx <= totalRows; rowIdx++) {
    const row = ws.getRow(rowIdx);
    // Полностью пустая строка — пропускаем без ошибки.
    let hasAny = false;
    const data: Partial<Record<HeaderKey, string>> = {};
    colKeyByIndex.forEach((key, colNumber) => {
      const v = cellToString(row.getCell(colNumber).value);
      if (v) {
        hasAny = true;
        data[key] = v;
      }
    });
    if (!hasAny) continue;

    const errors: string[] = [];
    const name = data.name?.trim() || '';
    if (!name) {
      errors.push('Пустое поле «Имя» — строка не будет загружена.');
    }

    const email = data.email?.trim() || '';
    if (email && !EMAIL_RE.test(email)) {
      errors.push(`Email «${email}» не похож на корректный — пропускаем строку.`);
    }

    let birthDate: string | undefined;
    if (data.birth_date) {
      const parsed = parseBirthDate(data.birth_date);
      if (!parsed.ok) {
        errors.push(`Дата рождения «${data.birth_date}» — формат не распознан. Используйте «ДД.ММ.ГГГГ».`);
      } else {
        birthDate = parsed.value;
      }
    }

    let year: number | undefined;
    if (data.vehicle_year) {
      const parsed = parseYear(data.vehicle_year);
      if (!parsed.ok) {
        errors.push(`Год авто «${data.vehicle_year}» — должно быть 4-значное число от 1900 до 2100.`);
      } else {
        year = parsed.value;
      }
    }

    const hasVehicle = !!(data.vehicle_brand && data.vehicle_brand.trim());

    rows.push({
      rowNum: rowIdx,
      client: {
        name,
        phone: data.phone || null,
        email: email || null,
        city: data.city || null,
        source: data.source || null,
        notes: data.notes || null,
        birth_date: birthDate || null,
      },
      vehicle: hasVehicle
        ? {
            brand: data.vehicle_brand || null,
            model: data.vehicle_model || null,
            license_plate: data.vehicle_plate || null,
            color: data.vehicle_color || null,
            year: year ?? null,
          }
        : null,
      errors,
    });
  }

  return { rows, fatalErrors: [] };
}
