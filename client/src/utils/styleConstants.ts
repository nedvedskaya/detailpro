export const LAYOUT_CLASSES = {
  container: "flex-1 overflow-y-auto overscroll-contain",
  listContainer: "px-6 space-y-3 pt-3 pb-32",
  compactListContainer: "px-6 space-y-2.5 pt-3 pb-32",
  header: "sticky top-0 z-40 bg-white/95 backdrop-blur-md border-b border-zinc-200/50",
  modal: "absolute inset-0 z-[150] bg-zinc-900/50 backdrop-blur-sm flex items-end animate-in fade-in",
  modalContent: "w-full bg-white rounded-t-[32px] p-6 shadow-2xl space-y-6 pb-32 overflow-y-auto max-h-[90vh]",
  emptyState: "flex flex-col items-center justify-center py-20 text-center px-6"
} as const;
