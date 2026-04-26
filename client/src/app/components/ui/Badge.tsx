import { AlertOctagon } from 'lucide-react';

type BadgeVariant = 'urgent' | 'overdue' | 'status' | 'payment-none' | 'payment-advance' | 'payment-paid' | 'birthday';

interface BadgeProps {
  variant: BadgeVariant;
  children?: React.ReactNode;
  className?: string;
}

export const Badge = ({ variant, children, className = '' }: BadgeProps) => {
  const variants = {
    // Срочность (иконка)
    urgent: "w-5 h-5 rounded-full bg-gradient-to-br from-red-500 to-orange-500 flex items-center justify-center shadow-md",
    
    // Просрочено
    overdue: "text-[10px] font-bold px-2 py-0.5 rounded uppercase bg-red-100 text-red-600",

    // Статусы
    status: "text-[10px] font-medium px-2 py-1 rounded-full bg-zinc-100 text-zinc-600",
    
    // Статусы оплаты
    'payment-none': "text-[10px] font-bold px-2 py-1 rounded-full bg-gray-100 text-gray-600",
    'payment-advance': "text-[10px] font-bold px-2 py-1 rounded-full bg-orange-100 text-orange-600",
    'payment-paid': "text-[10px] font-bold px-2 py-1 rounded-full bg-green-100 text-green-600",
    'birthday': "text-[10px] font-bold px-2 py-1 rounded-full bg-pink-100 text-pink-600",
  };

  const baseClass = variants[variant];
  
  // Срочность отображается с иконкой
  if (variant === 'urgent') {
    return (
      <div className={`${baseClass} ${className}`}>
        <AlertOctagon size={12} className="text-white" strokeWidth={3} />
      </div>
    );
  }

  return (
    <span className={`${baseClass} ${className}`}>
      {children}
    </span>
  );
};