import { useMemo, useState } from 'react';
import {
  AlertTriangle,
  ChevronLeft,
  Clock,
  FileDown,
  Search,
  Sparkles,
  Tag,
} from 'lucide-react';
import {
  categoryLabels,
  defaultMaterialIcon,
  materialStats,
  materials,
  statusLabels,
  type MaterialCategory,
  type MaterialItem,
  type MaterialSection,
} from '../data/materials';

interface MaterialsPageProps {
  onBack: () => void;
}

const categories: Array<'all' | MaterialCategory> = ['all', 'tech-card', 'checklist', 'document', 'script'];

const getStatusClass = (status: MaterialItem['status']) => {
  if (status === 'ready') return 'bg-emerald-50 text-emerald-700 border-emerald-100';
  if (status === 'draft') return 'bg-orange-50 text-orange-700 border-orange-100';
  return 'bg-zinc-100 text-zinc-600 border-zinc-200';
};

const normalize = (value: string) => value.toLowerCase().replaceAll('ё', 'е');

export const MaterialsPage = ({ onBack }: MaterialsPageProps) => {
  const [activeCategory, setActiveCategory] = useState<'all' | MaterialCategory>('all');
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState('engine-bay-detailing');
  const [activeSectionId, setActiveSectionId] = useState('value');

  const filteredMaterials = useMemo(() => {
    const normalizedQuery = normalize(query.trim());

    return materials.filter((item) => {
      const byCategory = activeCategory === 'all' || item.category === activeCategory;
      const byQuery =
        !normalizedQuery ||
        normalize(`${item.title} ${item.summary} ${item.tags.join(' ')}`).includes(normalizedQuery);

      return byCategory && byQuery;
    });
  }, [activeCategory, query]);

  const selectedMaterial = useMemo(() => {
    return materials.find((item) => item.id === selectedId) || materials[0];
  }, [selectedId]);

  const activeSection = useMemo<MaterialSection | undefined>(() => {
    return selectedMaterial.sections?.find((section) => section.id === activeSectionId) || selectedMaterial.sections?.[0];
  }, [activeSectionId, selectedMaterial]);

  const handleSelectMaterial = (item: MaterialItem) => {
    setSelectedId(item.id);
    setActiveSectionId(item.sections?.[0]?.id || '');
  };

  const HeaderIcon = defaultMaterialIcon[selectedMaterial.category];

  return (
    <>
      <div
        aria-hidden
        style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          height: 'env(safe-area-inset-top, 0px)',
          background: '#ffffff',
          zIndex: 11,
        }}
      />
      <div
        className="fixed inset-0 bg-zinc-50 overflow-y-auto"
        style={{ paddingTop: 'env(safe-area-inset-top, 0px)' }}
      >
        <div className="bg-white border-b border-zinc-200 px-4 py-3 sticky top-0 z-10 flex justify-start">
          <button
            onClick={onBack}
            className="flex items-center gap-1.5 text-sm font-medium text-zinc-600 hover:text-zinc-900 transition-colors"
          >
            <ChevronLeft size={18} />
            Назад
          </button>
        </div>

        <main className="max-w-6xl mx-auto px-4 py-5 pb-24">
          <section className="mb-5">
            <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
              <div>
                <div className="inline-flex items-center gap-2 rounded-lg border border-orange-100 bg-orange-50 px-3 py-1.5 text-xs font-bold text-orange-700 mb-3">
                  <Sparkles size={14} />
                  База знаний CRM
                </div>
                <h1 className="text-3xl font-black text-zinc-950 leading-tight">Материалы</h1>
                <p className="mt-2 max-w-2xl text-sm leading-relaxed text-zinc-500">
                  Технологические карты, чек-листы, документы и скрипты для работы студии.
                </p>
              </div>

              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 md:w-[480px]">
                <StatCard label="Техкарт" value={materialStats.techCards} />
                <StatCard label="Эталон" value={materialStats.ready} />
                <StatCard label="Чек-листов" value={materialStats.checklists} />
                <StatCard label="Документов" value={materialStats.documents} />
              </div>
            </div>
          </section>

          <section className="grid gap-4 lg:grid-cols-[360px_minmax(0,1fr)]">
            <aside className="space-y-3">
              <div className="relative">
                <Search size={17} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400" />
                <input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Поиск по материалам"
                  className="w-full rounded-lg border border-zinc-200 bg-white py-3 pl-10 pr-3 text-sm font-semibold outline-none transition-colors placeholder:text-zinc-300 focus:border-orange-400"
                />
              </div>

              <div className="flex gap-2 overflow-x-auto pb-1 lg:flex-wrap">
                {categories.map((category) => (
                  <button
                    key={category}
                    onClick={() => setActiveCategory(category)}
                    className={`shrink-0 rounded-lg px-3 py-2 text-xs font-bold transition-colors ${
                      activeCategory === category
                        ? 'bg-orange-500 text-white'
                        : 'border border-zinc-200 bg-white text-zinc-600 hover:bg-zinc-100'
                    }`}
                  >
                    {category === 'all' ? 'Все' : categoryLabels[category]}
                  </button>
                ))}
              </div>

              <div className="space-y-2">
                {filteredMaterials.map((item) => (
                  <MaterialListItem
                    key={item.id}
                    item={item}
                    isActive={item.id === selectedMaterial.id}
                    onSelect={() => handleSelectMaterial(item)}
                  />
                ))}

                {filteredMaterials.length === 0 && (
                  <div className="rounded-lg border border-dashed border-zinc-300 bg-white p-6 text-center text-sm font-medium text-zinc-500">
                    Материалы не найдены
                  </div>
                )}
              </div>
            </aside>

            <article className="space-y-4">
              <section className="rounded-lg border border-zinc-200 bg-white p-5 shadow-sm">
                <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                  <div className="flex gap-3">
                    <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-zinc-950 text-white">
                      <HeaderIcon size={22} />
                    </div>
                    <div>
                      <div className="mb-2 flex flex-wrap items-center gap-2">
                        <span className={`rounded border px-2 py-1 text-xs font-bold ${getStatusClass(selectedMaterial.status)}`}>
                          {statusLabels[selectedMaterial.status]}
                        </span>
                        <span className="rounded border border-zinc-200 bg-zinc-50 px-2 py-1 text-xs font-bold text-zinc-500">
                          {categoryLabels[selectedMaterial.category]}
                        </span>
                      </div>
                      <h2 className="text-2xl font-black leading-tight text-zinc-950">{selectedMaterial.title}</h2>
                      <p className="mt-2 text-sm leading-relaxed text-zinc-600">{selectedMaterial.summary}</p>
                    </div>
                  </div>

                  {selectedMaterial.sourceFile && (
                    <button className="inline-flex items-center justify-center gap-2 rounded-lg border border-zinc-200 bg-white px-3 py-2 text-xs font-bold text-zinc-600 transition-colors hover:bg-zinc-50">
                      <FileDown size={15} />
                      Источник
                    </button>
                  )}
                </div>

                <div className="mt-5 grid gap-2 sm:grid-cols-3">
                  <MetaBox icon={Tag} label="Группа" value={selectedMaterial.serviceGroup} />
                  <MetaBox icon={Clock} label="Время" value={selectedMaterial.duration || 'уточнить'} />
                  <MetaBox icon={Sparkles} label="Цена" value={selectedMaterial.price || 'уточнить'} />
                </div>

                <div className="mt-4 flex flex-wrap gap-2">
                  {selectedMaterial.tags.map((tag) => (
                    <span key={tag} className="rounded bg-zinc-100 px-2.5 py-1 text-xs font-bold text-zinc-500">
                      #{tag}
                    </span>
                  ))}
                </div>
              </section>

              {selectedMaterial.sections && activeSection ? (
                <section className="rounded-lg border border-zinc-200 bg-white shadow-sm">
                  <div className="flex gap-2 overflow-x-auto border-b border-zinc-100 p-3">
                    {selectedMaterial.sections.map((section) => {
                      const SectionIcon = section.icon;
                      return (
                        <button
                          key={section.id}
                          onClick={() => setActiveSectionId(section.id)}
                          className={`inline-flex shrink-0 items-center gap-2 rounded-lg px-3 py-2 text-xs font-bold transition-colors ${
                            activeSection.id === section.id
                              ? 'bg-zinc-950 text-white'
                              : 'bg-zinc-100 text-zinc-600 hover:bg-zinc-200'
                          }`}
                        >
                          <SectionIcon size={15} />
                          {section.title}
                        </button>
                      );
                    })}
                  </div>

                  <div className="p-5">
                    <div className="mb-4 flex items-center gap-3">
                      <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-orange-50 text-orange-600">
                        <activeSection.icon size={19} />
                      </div>
                      <h3 className="text-xl font-black text-zinc-950">{activeSection.title}</h3>
                    </div>

                    {activeSection.body?.map((paragraph) => (
                      <p key={paragraph} className="mb-3 text-sm leading-relaxed text-zinc-600">
                        {paragraph}
                      </p>
                    ))}

                    {activeSection.items && (
                      <ul className="space-y-2">
                        {activeSection.items.map((item) => (
                          <li key={item} className="flex gap-2 text-sm leading-relaxed text-zinc-700">
                            <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-orange-500" />
                            <span>{item}</span>
                          </li>
                        ))}
                      </ul>
                    )}

                    {activeSection.warning && (
                      <div className="mt-5 flex gap-3 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm leading-relaxed text-amber-900">
                        <AlertTriangle size={18} className="mt-0.5 shrink-0" />
                        <p>{activeSection.warning}</p>
                      </div>
                    )}
                  </div>
                </section>
              ) : (
                <section className="rounded-lg border border-dashed border-zinc-300 bg-white p-6">
                  <h3 className="text-lg font-black text-zinc-950">Материал готов к переработке</h3>
                  <p className="mt-2 text-sm leading-relaxed text-zinc-500">
                    Для этого источника уже заведена карточка. Следующий шаг — перенести содержание в единый шаблон:
                    продажа, этапы работ, риски, фотофиксация и контроль качества.
                  </p>
                </section>
              )}

              {selectedMaterial.checklist && (
                <section className="rounded-lg border border-zinc-200 bg-white p-5 shadow-sm">
                  <h3 className="mb-4 text-xl font-black text-zinc-950">Чек-лист мастера</h3>
                  <div className="grid gap-3 md:grid-cols-3">
                    {selectedMaterial.checklist.map((group) => (
                      <div key={group.title} className="rounded-lg border border-zinc-200 p-4">
                        <h4 className="mb-3 text-sm font-black text-zinc-900">{group.title}</h4>
                        <div className="space-y-2">
                          {group.items.map((item) => (
                            <label key={item} className="flex gap-2 text-sm font-medium leading-snug text-zinc-600">
                              <input type="checkbox" className="mt-0.5 h-4 w-4 rounded border-zinc-300 accent-orange-500" />
                              {item}
                            </label>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                </section>
              )}
            </article>
          </section>
        </main>
      </div>
    </>
  );
};

function StatCard({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-zinc-200 bg-white px-3 py-2 shadow-sm">
      <div className="text-2xl font-black leading-none text-zinc-950">{value}</div>
      <div className="mt-1 text-[11px] font-bold uppercase tracking-wide text-zinc-400">{label}</div>
    </div>
  );
}

function MaterialListItem({
  item,
  isActive,
  onSelect,
}: {
  item: MaterialItem;
  isActive: boolean;
  onSelect: () => void;
}) {
  const Icon = defaultMaterialIcon[item.category];

  return (
    <button
      onClick={onSelect}
      className={`w-full rounded-lg border p-3 text-left transition-colors ${
        isActive ? 'border-orange-300 bg-orange-50' : 'border-zinc-200 bg-white hover:border-zinc-300'
      }`}
    >
      <div className="flex gap-3">
        <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${isActive ? 'bg-orange-500 text-white' : 'bg-zinc-100 text-zinc-500'}`}>
          <Icon size={18} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <h3 className="text-sm font-black leading-snug text-zinc-950">{item.title}</h3>
            <span className={`shrink-0 rounded border px-1.5 py-0.5 text-[10px] font-bold ${getStatusClass(item.status)}`}>
              {statusLabels[item.status]}
            </span>
          </div>
          <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-zinc-500">{item.summary}</p>
        </div>
      </div>
    </button>
  );
}

function MetaBox({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof Tag;
  label: string;
  value: string;
}) {
  return (
    <div className="rounded-lg border border-zinc-200 bg-zinc-50 p-3">
      <div className="mb-1 flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wide text-zinc-400">
        <Icon size={13} />
        {label}
      </div>
      <div className="text-sm font-black text-zinc-900">{value}</div>
    </div>
  );
}
