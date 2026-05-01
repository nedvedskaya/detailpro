import { formatDate, findCategoryById, findTagsByIds } from './helpers';
import { getTransactionTypeLabel } from './constants';

interface ExcelColumn {
  header: string;
  key: string;
  width: number;
}

interface ExportOptions<T> {
  sheetName: string;
  fileName: string;
  columns: ExcelColumn[];
  data: T[];
  rowMapper: (item: T) => Record<string, string | number>;
}

export const exportToExcel = async <T>({
  sheetName,
  fileName,
  columns,
  data,
  rowMapper
}: ExportOptions<T>): Promise<void> => {
  if (data.length === 0) {
    alert('Нет данных для экспорта');
    return;
  }

  const ExcelJS = (await import('exceljs')).default;
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet(sheetName);

  worksheet.columns = columns;

  data.forEach(item => {
    worksheet.addRow(rowMapper(item));
  });

  worksheet.getRow(1).font = { bold: true };

  const now = new Date();
  const dateStr = `${now.getDate().toString().padStart(2, '0')}.${(now.getMonth() + 1).toString().padStart(2, '0')}.${now.getFullYear()}`;
  const fullFileName = `${fileName}_${dateStr}.xlsx`;

  const buffer = await workbook.xlsx.writeBuffer();
  const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fullFileName;
  a.click();
  URL.revokeObjectURL(url);
};

export const CLIENTS_COLUMNS: ExcelColumn[] = [
  { header: 'ФИО', key: 'name', width: 25 },
  { header: 'Телефон', key: 'phone', width: 18 },
  { header: 'Email', key: 'email', width: 22 },
  { header: 'Город', key: 'city', width: 15 },
  { header: 'Источник', key: 'source', width: 18 },
  { header: 'Дата рождения', key: 'birthDate', width: 15 },
  { header: 'Марка авто', key: 'carBrand', width: 15 },
  { header: 'Модель авто', key: 'carModel', width: 15 },
  { header: 'Гос. номер', key: 'licensePlate', width: 14 },
  { header: 'ВИН', key: 'vin', width: 20 },
  { header: 'Комментарии', key: 'comment', width: 30 },
  { header: 'Дата добавления', key: 'createdDate', width: 15 }
];

export const TRANSACTIONS_COLUMNS: ExcelColumn[] = [
  { header: 'Дата', key: 'date', width: 15 },
  { header: 'Тип', key: 'type', width: 10 },
  { header: 'Название', key: 'title', width: 25 },
  { header: 'Сумма', key: 'amount', width: 12 },
  { header: 'Описание', key: 'description', width: 25 },
  { header: 'Категория', key: 'category', width: 15 },
  { header: 'Теги', key: 'tags', width: 20 }
];

export const clientRowMapper = (client: { name?: string; phone?: string; email?: string; city?: string; source?: string; birthDate?: string; carBrand?: string; carModel?: string; licensePlate?: string; vin?: string; comment?: string; created_at?: string; createdDate?: string }): Record<string, string | number> => ({
  name: client.name || '',
  phone: client.phone || '',
  email: client.email || '',
  city: client.city || '',
  source: client.source || '',
  birthDate: client.birthDate || '',
  carBrand: client.carBrand || '',
  carModel: client.carModel || '',
  licensePlate: client.licensePlate || '',
  vin: client.vin || '',
  comment: client.comment || '',
  createdDate: client.createdDate || (client.created_at ? client.created_at.slice(0, 10) : '')
});

interface Category {
  id: string;
  name: string;
}

interface Tag {
  id: string;
  name: string;
}

interface ExportTransaction {
  date?: string;
  createdDate?: string;
  type: 'income' | 'expense';
  description?: string;
  amount?: number | string;
  category?: string;
  tags?: string[];
}

export const createTransactionRowMapper = (categories: Category[], tags: Tag[]) => (t: ExportTransaction): Record<string, string | number> => {
  const category = findCategoryById(categories, t.category);
  const transactionTags = findTagsByIds(tags, t.tags || []);
  
  return {
    date: formatDate(t.date || t.createdDate || ''),
    type: getTransactionTypeLabel(t.type),
    title: t.description || '',
    amount: Number(t.amount || 0),
    description: '',
    category: category?.name || 'Без категории',
    tags: transactionTags.map(tag => tag.name).join(', ') || ''
  };
};
