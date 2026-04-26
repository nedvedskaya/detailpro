import { LucideIcon } from 'lucide-react';

interface TabButtonProps {
  isActive: boolean;
  icon: LucideIcon;
  label: string;
  onClick: () => void;
  className?: string;
}

export const TabButton = ({ 
  isActive, 
  icon: Icon, 
  label, 
  onClick,
  className = ''
}: TabButtonProps) => {
  const activeClass = isActive 
    ? 'bg-black text-white' 
    : 'bg-zinc-100 text-zinc-600 hover:bg-zinc-200';

  return (
    <button
      onClick={onClick}
      className={`flex-1 py-3 rounded-xl flex items-center justify-center gap-2 font-bold text-xs transition-all ${activeClass} ${className}`}
    >
      <Icon size={16} />
      <span>{label}</span>
    </button>
  );
};
