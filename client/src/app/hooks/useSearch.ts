import { useState, useMemo } from 'react';

interface UseSearchOptions<T> {
  items: T[];
  searchFields: (keyof T)[];
}

export const useSearch = <T extends Record<string, any>>({ 
  items, 
  searchFields 
}: UseSearchOptions<T>) => {
  const [search, setSearch] = useState('');

  const filteredItems = useMemo(() => {
    if (!search.trim()) return items;

    const searchLower = search.toLowerCase();
    
    return items.filter(item => 
      searchFields.some(field => {
        const value = item[field];
        if (value == null) return false;
        return String(value).toLowerCase().includes(searchLower);
      })
    );
  }, [items, search, searchFields]);

  return {
    search,
    setSearch,
    filteredItems
  };
};
