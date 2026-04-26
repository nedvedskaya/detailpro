import React from 'react';

const BADGE_COLORS = {
  paid: 'bg-green-100 text-green-700',
  advance: 'bg-blue-100 text-blue-700',
  none: 'bg-orange-100 text-orange-700'
} as const;

const BADGE_LABELS = {
  paid: 'Оплачено',
  advance: 'Аванс',
  none: 'Не оплачено'
} as const;

const BADGE_SIZES = {
  xs: 'text-[9px] px-1.5 py-0.5 rounded',
  sm: 'text-[10px] px-2 py-0.5 rounded-lg font-semibold',
  md: 'text-xs px-2.5 py-1 rounded-lg font-semibold'
} as const;

type PaymentStatus = 'paid' | 'advance' | 'none';
type BadgeSize = 'xs' | 'sm' | 'md';

interface PaymentBadgeProps {
  status: string | undefined | null;
  size?: BadgeSize;
  icon?: React.ReactNode;
  className?: string;
}

export const PaymentBadge: React.FC<PaymentBadgeProps> = ({ status, size = 'sm', icon, className = '' }) => {
  const key = (status === 'paid' || status === 'advance') ? status : 'none';
  const colors = BADGE_COLORS[key];
  const label = BADGE_LABELS[key];
  const sizeClass = BADGE_SIZES[size];

  return (
    <span className={`${colors} ${sizeClass} ${icon ? 'flex items-center gap-1' : ''} ${className}`}>
      {icon}{label}
    </span>
  );
};
