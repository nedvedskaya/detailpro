import React from 'react';

interface NetworkIndicatorProps {
  isOnline: boolean;
}

export const NetworkIndicator: React.FC<NetworkIndicatorProps> = ({ isOnline }) => {
  return (
    <div className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold transition-all duration-300 ${
      isOnline 
        ? 'bg-emerald-50 text-emerald-700' 
        : 'bg-amber-50 text-amber-700'
    }`}>
      <span className={`w-2 h-2 rounded-full ${
        isOnline 
          ? 'bg-emerald-500 animate-pulse' 
          : 'bg-amber-500 animate-pulse'
      }`} />
      <span>{isOnline ? 'CRM доступна' : 'Сервер недоступен'}</span>
    </div>
  );
};
