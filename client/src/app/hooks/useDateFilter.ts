import { useMemo } from 'react';
import { getDateStr } from '@/utils/helpers';

interface UseDateFilterOptions<T> {
  items: T[];
  dateField: keyof T;
  filterType?: 'today' | 'future' | 'past' | 'all';
}

export const useDateFilter = <T extends Record<string, any>>({ 
  items, 
  dateField,
  filterType = 'all'
}: UseDateFilterOptions<T>) => {
  const today = getDateStr(0);

  const filteredItems = useMemo(() => {
    if (filterType === 'all') return items;

    return items.filter(item => {
      // dateField типизировано как keyof T → возвращаемое значение T[keyof T]
      // не сравнимо со string. В рантайме мы храним даты строками 'YYYY-MM-DD',
      // поэтому приводим к string для лексикографического сравнения.
      const itemDate = String(item[dateField] ?? '');
      if (!itemDate) return false;

      switch (filterType) {
        case 'today':
          return itemDate === today;
        case 'future':
          return itemDate > today;
        case 'past':
          return itemDate < today;
        default:
          return true;
      }
    });
  }, [items, dateField, filterType, today]);

  return filteredItems;
};
