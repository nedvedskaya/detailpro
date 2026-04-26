import React from 'react';
import { LucideIcon } from 'lucide-react';
import { BTN_METAL } from '@/utils/constants';

type ActionButtonVariant = 'default' | 'metal' | 'urgent' | 'primary' | 'secondary';
type ActionButtonSize = 'sm' | 'md' | 'lg';

interface ActionButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement | HTMLAnchorElement> {
  variant?: ActionButtonVariant;
  size?: ActionButtonSize;
  icon?: LucideIcon;
  iconSize?: number;
  as?: 'button' | 'a';
  href?: string;
  target?: string;
  rel?: string;
  children: React.ReactNode;
}

export const ActionButton = ({ 
  variant = 'default',
  size = 'md',
  icon: Icon,
  iconSize = 12,
  as = 'button',
  className = '',
  children,
  ...props 
}: ActionButtonProps) => {
  const variants = {
    default: "bg-white border border-zinc-300 text-zinc-800 hover:bg-zinc-100",
    metal: BTN_METAL,
    urgent: "bg-gradient-to-r from-red-500 to-orange-500 border-red-500 text-white shadow-xl hover:shadow-2xl",
    primary: "bg-black text-white hover:bg-zinc-800",
    secondary: "bg-zinc-100 text-zinc-800 hover:bg-zinc-200"
  };

  const sizes = {
    sm: "text-[10px] px-3 py-1.5",
    md: "text-xs px-3 py-1.5",
    lg: "text-sm px-4 py-2"
  };

  const baseClass = "rounded-lg font-bold transition-colors flex items-center gap-1";
  const variantClass = variants[variant];
  const sizeClass = sizes[size];
  const finalClass = `${baseClass} ${variantClass} ${sizeClass} ${className}`.trim();

  const content = (
    <>
      {Icon && <Icon size={iconSize} />}
      {children}
    </>
  );

  if (as === 'a') {
    return (
      <a className={finalClass} {...(props as React.AnchorHTMLAttributes<HTMLAnchorElement>)}>
        {content}
      </a>
    );
  }

  return (
    <button className={finalClass} {...(props as React.ButtonHTMLAttributes<HTMLButtonElement>)}>
      {content}
    </button>
  );
};
