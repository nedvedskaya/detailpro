interface MaterialsPageProps {
  onBack: () => void;
}

export const MaterialsPage = ({ onBack }: MaterialsPageProps) => {
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
        className="fixed inset-0 overflow-y-auto bg-white"
        style={{ paddingTop: 'env(safe-area-inset-top, 0px)' }}
      >
        <header className="sticky top-0 z-10 border-b border-zinc-200 bg-white px-4 py-3">
          <button
            type="button"
            onClick={onBack}
            className="text-sm font-semibold text-zinc-600 transition-colors hover:text-zinc-950"
          >
            ← Назад
          </button>
        </header>

        <main className="mx-auto flex min-h-[calc(100vh-56px)] max-w-2xl flex-col justify-center px-5 py-16 text-center">
          <p className="mb-3 text-xs font-bold uppercase tracking-[0.18em] text-orange-600">Материалы</p>
          <h1 className="text-2xl font-black leading-tight text-zinc-950 sm:text-3xl">
            Раздел находится в разработке
          </h1>
          <p className="mx-auto mt-3 max-w-md text-sm leading-6 text-zinc-500">
            Мы готовим технологические карты, чек-листы и документы в едином стиле CRM.
          </p>
        </main>
      </div>
    </>
  );
};
