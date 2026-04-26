import { ContactButtons } from '@/app/components/ui';
import { formatDate } from '@/utils/helpers';

interface ClientCardProps {
  client: any;
  compact?: boolean;
  showComment?: boolean;
  className?: string;
}

export const ClientCard = ({ 
  client, 
  compact = false,
  showComment = true,
  className = '' 
}: ClientCardProps) => {
  if (compact) {
    return (
      <div className={`p-3 bg-zinc-50 rounded-lg border border-zinc-200 ${className}`}>
        <div className="flex items-center justify-between mb-2">
          <h4 className="font-bold text-sm">{String(client.name || '')}</h4>
        </div>
        <div className="flex items-center gap-2 text-xs text-zinc-600">
          <span>{String(client.phone || '')}</span>
          <span>•</span>
          <span>{String(client.carBrand || '')} {String(client.carModel || '')}</span>
        </div>
      </div>
    );
  }

  return (
    <div className={`p-4 rounded-xl bg-zinc-50 border border-zinc-200 space-y-3 ${className}`}>
      <div className="flex items-center justify-between">
        <h4 className="font-bold text-sm">{String(client.name || '')}</h4>
        <ContactButtons phone={client.phone} size="md" />
      </div>
      
      <div className="grid grid-cols-2 gap-3 text-xs">
        <div>
          <span className="text-zinc-400 font-medium">Телефон</span>
          <p className="font-bold text-zinc-800">{String(client.phone || '')}</p>
        </div>
        <div>
          <span className="text-zinc-400 font-medium">Город</span>
          <p className="font-bold text-zinc-800">{String(client.city || '')}</p>
        </div>
        <div>
          <span className="text-zinc-400 font-medium">Автомобиль</span>
          <p className="font-bold text-zinc-800">{String(client.carBrand || '')} {String(client.carModel || '')}</p>
        </div>
        {client.birthDate && (
          <div>
            <span className="text-zinc-400 font-medium">Дата рождения</span>
            <p className="font-bold text-zinc-800">{formatDate(client.birthDate)}</p>
          </div>
        )}
      </div>
      
      {showComment && client.comment && (
        <div className="pt-2 border-t border-zinc-200">
          <span className="text-zinc-400 font-medium text-xs">Комментарий</span>
          <p className="text-xs text-zinc-600 mt-1">{String(client.comment || '')}</p>
        </div>
      )}
    </div>
  );
};
