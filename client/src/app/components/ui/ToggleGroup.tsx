import React from 'react';
import type { LucideIcon } from 'lucide-react';

// Принимаем как обычные React.ComponentType, так и lucide-иконки
// (они ForwardRefExoticComponent и имеют size: string | number).
type IconComponent =
  | LucideIcon
  | React.ComponentType<{ size?: number | string; className?: string }>;

interface ToggleOption {
  value: string;
  label: string;
  icon?: IconComponent;
}

interface ToggleGroupProps {
  options: ToggleOption[];
  value: string;
  onChange: (value: string) => void;
  variant?: 'default' | 'minimal';
}

export const ToggleGroup = ({ options, value, onChange, variant = 'default' }: ToggleGroupProps) => {
  const containerClasses = variant === 'default'
    ? 'flex gap-2 p-1 bg-zinc-100 rounded-xl'
    : 'flex gap-3';

  const activeClasses = variant === 'default'
    ? 'bg-white text-black shadow-sm'
    : 'bg-white text-black shadow-md';

  const inactiveClasses = variant === 'default'
    ? 'text-zinc-500'
    : 'bg-transparent text-zinc-400 border border-zinc-200';

  return (
    <div className={containerClasses}>
      {options.map((option) => {
        const Icon = option.icon;
        return (
          <button
            key={option.value}
            onClick={() => onChange(option.value)}
            className={`flex-1 py-2.5 rounded-lg font-bold text-sm transition-all flex items-center justify-center gap-2 ${
              value === option.value ? activeClasses : inactiveClasses
            }`}
          >
            {Icon && <Icon size={16} />}
            {option.label}
          </button>
        );
      })}
    </div>
  );
};
