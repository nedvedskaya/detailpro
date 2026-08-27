import React, { useState, useMemo, useEffect } from 'react';
import { Search, Download, Plus, ArrowUpDown, Cake, Check, LayoutGrid, List } from 'lucide-react';
import { ClientListCard } from '@/app/components/clients';
import { EmptyState, ActionButtons } from '@/app/components/ui';
import { ClientAvatar } from '@/app/components/ui/ClientAvatar';
import { useSearch } from '@/app/hooks';
import { exportToExcel, CLIENTS_COLUMNS, clientRowMapper } from '@/utils/excelExport';
import { isBirthdayToday } from '@/utils/helpers';

type SortMode = 'name' | 'car' | 'date';

interface ClientsViewProps {
  allClients: any[];
  onAddClient: (data: any, tasks: any[], records?: any[]) => Promise<any>;
  onDeleteClient: (id: number) => void;
  onOpenClient: (client: any) => void;
  onEditClient: (params: { client: any; mode: string }) => void;
  ClientForm: React.ComponentType<any>;
  categories?: any[];
  tags?: any[];
  users?: any[];
  priceList?: any[];
  isOnline?: boolean;
  canEdit?: boolean;
  canEditRecords?: boolean;
  canEditTasks?: boolean;
}

const sortOptions: { value: SortMode; label: string }[] = [
  { value: 'name', label: 'По алфавиту' },
  { value: 'car', label: 'По марке авто' },
  { value: 'date', label: 'По дате добавления' },
];

export const ClientsView = ({ 
  allClients, 
  onAddClient, 
  onDeleteClient, 
  onOpenClient, 
  onEditClient,
  ClientForm,
  categories = [],
  tags = [],
  users = [],
  priceList = [],
  isOnline = true,
  canEdit = true,
  canEditRecords = true,
  canEditTasks = true,
}: ClientsViewProps) => {
  const [isAdding, setIsAdding] = useState(false);
  const [sortMode, setSortMode] = useState<SortMode>('date');
  const [showSortMenu, setShowSortMenu] = useState(false);
  const [viewFormat, setViewFormat] = useState<'cards' | 'table'>(() => {
    return (localStorage.getItem('clients_view_format') as 'cards' | 'table') || 'cards';
  });

  const toggleViewFormat = () => {
    const next = viewFormat === 'cards' ? 'table' : 'cards';
    setViewFormat(next);
    localStorage.setItem('clients_view_format', next);
  };
  
  const { search, setSearch, filteredItems } = useSearch({
    items: allClients,
    searchFields: ['name', 'carBrand', 'city', 'phone']
  });

  const sortedItems = useMemo(() => {
    const items = [...filteredItems];
    switch (sortMode) {
      case 'name':
        return items.sort((a, b) => (a.name || '').localeCompare(b.name || '', 'ru'));
      case 'car':
        return items.sort((a, b) => (a.carBrand || '').localeCompare(b.carBrand || '', 'ru'));
      case 'date':
        return items.sort((a, b) => (b.createdDate || '').localeCompare(a.createdDate || ''));
      default:
        return items;
    }
  }, [filteredItems, sortMode]);

  const birthdayClients = useMemo(() => 
    allClients.filter(c => isBirthdayToday(c.birthDate)),
    [allClients]
  );

  const handleExportToExcel = () => {
    exportToExcel({
      sheetName: 'Клиенты',
      fileName: 'Клиенты',
      columns: CLIENTS_COLUMNS,
      data: allClients,
      rowMapper: clientRowMapper
    });
  };

  const activeSortLabel = sortOptions.find(o => o.value === sortMode)?.label || '';
  const isSortNonDefault = sortMode !== 'date';

  return (
    <div className="flex flex-col h-full bg-zinc-50 overflow-hidden relative">
      {isAdding && (
        <ClientForm
          onSave={async (d: any, t: any, r: any, shouldClose?: boolean) => {
            const ok = await onAddClient(d, t, r);
            if (ok === false) return;
            if (shouldClose !== false) setIsAdding(false);
          }}
          onCancel={() => setIsAdding(false)}
          categories={categories}
          tags={tags}
          users={users}
          priceList={priceList}
          canEditRecords={canEditRecords}
          canEditTasks={canEditTasks}
        />
      )}
      
      <div className="sticky top-0 z-30 bg-white shadow-sm shrink-0">
        <div className="flex items-center justify-between px-6 py-3 border-b border-zinc-200">
          <div className="flex items-center gap-3">
            <h1 className="text-3xl font-black">Клиенты</h1>
            <button
              onClick={handleExportToExcel}
              className="w-8 h-8 rounded-full bg-orange-100 hover:bg-orange-200 flex items-center justify-center transition-all active:scale-95"
              title="Экспорт в Excel"
            >
              <Download size={16} className="text-orange-600" />
            </button>
            <button
              onClick={toggleViewFormat}
              className="hidden md:flex w-8 h-8 rounded-full bg-zinc-100 hover:bg-zinc-200 items-center justify-center transition-all active:scale-95"
              title={viewFormat === 'cards' ? 'Переключить на таблицу' : 'Переключить на блоки'}
            >
              {viewFormat === 'cards' ? <List size={16} className="text-zinc-600" /> : <LayoutGrid size={16} className="text-zinc-600" />}
            </button>
            
            <div className="relative">
              <button
                onClick={() => setShowSortMenu(!showSortMenu)}
                className={`w-8 h-8 rounded-full flex items-center justify-center transition-all active:scale-95 ${
                  isSortNonDefault
                    ? 'bg-orange-500 text-white'
                    : 'bg-zinc-100 hover:bg-zinc-200 text-zinc-600'
                }`}
                title="Сортировка"
              >
                <ArrowUpDown size={16} />
              </button>
              
              {showSortMenu && (
                <>
                  <div 
                    className="fixed inset-0 z-40" 
                    onClick={() => setShowSortMenu(false)}
                  />
                  <div className="absolute left-0 top-full mt-2 bg-white rounded-xl shadow-2xl border border-zinc-200 py-2 z-50 min-w-[200px] animate-in fade-in slide-in-from-top-2">
                    {sortOptions.map(option => (
                      <button
                        key={option.value}
                        onClick={() => {
                          setSortMode(option.value);
                          setShowSortMenu(false);
                        }}
                        className={`w-full px-4 py-2.5 text-left text-sm font-bold transition-all flex items-center justify-between ${
                          sortMode === option.value
                            ? 'bg-zinc-100 text-black'
                            : 'text-zinc-500 hover:bg-zinc-50'
                        }`}
                      >
                        {option.label}
                        {sortMode === option.value && <Check size={16} className="text-black" />}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
          </div>
          {canEdit && (
            <button
              onClick={() => isOnline && setIsAdding(true)}
              disabled={!isOnline}
              className={`w-12 h-12 rounded-full flex items-center justify-center transition-all active:scale-95 ${
                isOnline
                  ? 'bg-orange-500 hover:scale-110'
                  : 'bg-zinc-300 cursor-not-allowed'
              }`}
              title={isOnline ? 'Добавить клиента' : 'Нет подключения к сети'}
            >
              <Plus size={24} className="text-white" />
            </button>
          )}
        </div>
        
        <div className="px-6 pb-3 pt-3 relative">
          <Search className="absolute left-9 top-1/2 -translate-y-1/2 text-zinc-400" size={18} />
          <input 
            type="text" 
            placeholder="Поиск по базе..." 
            value={search} 
            onChange={(e) => setSearch(e.target.value)} 
            className="w-full bg-zinc-50 border border-zinc-200 rounded-xl py-3 pl-12 pr-4 text-sm font-medium outline-none focus:border-orange-500 transition-all" 
          />
        </div>

        {isSortNonDefault && (
          <div className="px-6 pb-3">
            <div className="bg-zinc-100 rounded-lg px-3 py-2 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <ArrowUpDown size={14} className="text-zinc-500" />
                <span className="text-xs font-bold text-zinc-600">{activeSortLabel}</span>
              </div>
              <button
                onClick={() => setSortMode('date')}
                className="text-zinc-400 hover:text-zinc-600 text-xs font-bold"
              >
                Сбросить
              </button>
            </div>
          </div>
        )}
      </div>
      
      <div className="flex-1 overflow-y-auto px-6 pt-3 pb-32 md-scroll-end overscroll-contain">
        {birthdayClients.length > 0 && (
          <div className="bg-orange-50 border border-orange-200 rounded-xl px-3 py-2.5 flex items-center gap-2.5 mb-3">
            <Cake size={16} className="text-orange-500 shrink-0" />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-1.5 flex-wrap">
                <span className="text-xs font-bold text-orange-800">ДР сегодня:</span>
                {birthdayClients.map((c, i) => (
                  <span key={c.id} onClick={() => onOpenClient(c)} className="text-xs font-bold text-orange-600 underline cursor-pointer active:opacity-70">
                    {String(c.name || '')}{i < birthdayClients.length - 1 ? ',' : ''}
                  </span>
                ))}
              </div>
            </div>
          </div>
        )}

        {sortedItems.length === 0 ? (
          <EmptyState
            icon={Search}
            title={search ? 'Клиенты не найдены' : 'Нет клиентов'}
            description={search ? 'Попробуйте изменить параметры поиска' : 'Нажмите + чтобы добавить первого клиента'}
          />
        ) : viewFormat === 'table' ? (
          /* Таблица — только на десктопе, если выбран этот формат */
          <table className="w-full border-collapse">
            <thead>
              <tr className="border-b-2 border-zinc-200 text-left">
                <th className="pb-3 text-xs font-black text-zinc-400 uppercase tracking-widest pl-2">Клиент</th>
                <th className="pb-3 text-xs font-black text-zinc-400 uppercase tracking-widest">Телефон</th>
                <th className="pb-3 text-xs font-black text-zinc-400 uppercase tracking-widest">Email</th>
                <th className="pb-3 text-xs font-black text-zinc-400 uppercase tracking-widest">Город</th>
                <th className="pb-3 text-xs font-black text-zinc-400 uppercase tracking-widest">Автомобиль</th>
                <th className="pb-3 text-xs font-black text-zinc-400 uppercase tracking-widest">Гос. номер</th>
                <th className="pb-3 text-xs font-black text-zinc-400 uppercase tracking-widest">Статус</th>
                <th className="pb-3"></th>
              </tr>
            </thead>
            <tbody>
              {sortedItems.map(client => {
                const hasActiveBooking = (client.records || []).some((r: any) => !r.isCompleted);
                const hasBirthday = isBirthdayToday(client.birthDate);
                return (
                  <tr
                    key={client.id}
                    onClick={() => onOpenClient(client)}
                    className="border-b border-zinc-100 hover:bg-orange-50 cursor-pointer group transition-colors"
                  >
                    <td className="py-3 pl-2">
                      <div className="flex items-center gap-3">
                        <ClientAvatar name={client.name} avatar={client.avatar} size="sm" />
                        <div>
                          <div className="font-bold text-zinc-900 leading-tight">{String(client.name || '')}</div>
                          {hasBirthday && <span className="text-xs text-orange-500 font-bold">ДР сегодня</span>}
                        </div>
                      </div>
                    </td>
                    <td className="py-3 text-sm text-zinc-600">{String(client.phone || '')}</td>
                    <td className="py-3 text-sm text-zinc-500">{String(client.email || '')}</td>
                    <td className="py-3 text-sm text-zinc-500">{String(client.city || '')}</td>
                    <td className="py-3 text-sm text-zinc-600">{String(client.carBrand || '')} {String(client.carModel || '')}</td>
                    <td className="py-3 text-sm text-zinc-500">{String(client.licensePlate || '')}</td>
                    <td className="py-3">
                      {hasActiveBooking && (
                        <span className="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-bold bg-orange-100 text-orange-700">
                          Активная запись
                        </span>
                      )}
                    </td>
                    <td className="py-3 pr-2">
                      <div className="flex items-center justify-end gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                        {canEdit && (
                          <ActionButtons
                            onEdit={() => onEditClient({ client, mode: 'base' })}
                            onDelete={() => onDeleteClient(client.id)}
                          />
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : (
          /* Карточки */
          <div className="space-y-3 desktop-grid-2">
            {sortedItems.map(client => (
              <ClientListCard
                key={client.id}
                client={client}
                onOpen={() => onOpenClient(client)}
                onEdit={canEdit ? () => onEditClient({ client, mode: 'base' }) : undefined}
                onDelete={canEdit ? () => onDeleteClient(client.id) : undefined}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
