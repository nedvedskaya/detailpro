import { Car, Cake } from 'lucide-react';
import { Badge, ActionButtons } from '@/app/components/ui';
import { ClientAvatar } from '@/app/components/ui/ClientAvatar';
import { isBirthdayToday } from '@/utils/helpers';

interface ClientListCardProps {
  client: any;
  onOpen: () => void;
  onEdit: () => void;
  onDelete: () => void;
}

export const ClientListCard = ({ 
  client, 
  onOpen, 
  onEdit, 
  onDelete 
}: ClientListCardProps) => {
  const activeRecords = (client.records || []).filter((r: any) => !r.isCompleted);
  const hasActiveBooking = activeRecords.length > 0;
  const hasBirthday = isBirthdayToday(client.birthDate);

  return (
    <div 
      onClick={onOpen}
      className={`bg-white border rounded-2xl p-3 cursor-pointer hover:shadow-lg transition-all active:scale-[0.98] relative overflow-hidden ${
        hasBirthday ? 'border-orange-300 hover:border-orange-400' : 'border-zinc-200 hover:border-orange-300'
      }`}
    >
      {hasActiveBooking && (
        <div className="absolute top-0 left-0 right-0 h-1 bg-gradient-to-r from-orange-500 to-orange-600" />
      )}
      
      <div className="flex items-start gap-3">
        <ClientAvatar name={client.name} avatar={client.avatar} size="sm" />
        
        {/* Основная информация */}
        <div className="flex-1 min-w-0">
          <div className="flex items-start justify-between mb-1">
            <h3 className="font-bold text-base text-zinc-900 truncate">
              {String(client.name || '')}
            </h3>
            <ActionButtons onEdit={onEdit} onDelete={onDelete} />
          </div>
          
          <div className="flex items-center gap-2 text-xs text-zinc-500 mb-1.5">
            <Car size={12} />
            <span className="truncate">
              {String(client.carBrand || '')} {String(client.carModel || '')}
            </span>
          </div>
          
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs text-zinc-400">{String(client.phone || '')}</span>
            {hasBirthday && (
              <span className="text-xs font-bold px-2 py-1 rounded-full bg-orange-100 text-orange-600 flex items-center gap-1">
                <Cake size={10} /> ДР
              </span>
            )}
            {hasActiveBooking && (
              <Badge variant="status">
                Активная бронь
              </Badge>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};