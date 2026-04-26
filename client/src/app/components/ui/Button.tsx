import React from 'react';
import { LucideIcon } from 'lucide-react';

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  size?: 'sm' | 'md' | 'lg';
  fullWidth?: boolean;
  icon?: LucideIcon;
  children: React.ReactNode;
}

export const Button = ({ 
  variant = 'primary', 
  size = 'md', 
  fullWidth = false,
  icon: Icon,
  children, 
  className = '',
  ...props 
}: ButtonProps) => {
  const baseStyles = 'font-bold transition-all rounded-xl flex items-center justify-center gap-2';
  
  const variants = {
    primary: 'bg-gradient-to-b from-zinc-800 to-zinc-900 text-white shadow-lg hover:shadow-xl',
    secondary: 'bg-zinc-100 text-zinc-600 hover:bg-zinc-200',
    ghost: 'bg-transparent text-zinc-500 hover:text-zinc-800',
    danger: 'bg-red-50 text-red-600 hover:bg-red-100',
  };
  
  const sizes = {
    sm: 'px-3 py-1.5 text-xs',
    md: 'px-4 py-3 text-sm',
    lg: 'px-6 py-4 text-base',
  };
  
  const widthClass = fullWidth ? 'w-full' : '';
  
  return (
    <button
      className={`${baseStyles} ${variants[variant]} ${sizes[size]} ${widthClass} ${className}`}
      {...props}
    >
      {Icon && <Icon size={size === 'sm' ? 14 : size === 'md' ? 16 : 20} />}
      {children}
    </button>
  );
};
