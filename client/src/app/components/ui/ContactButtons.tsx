import { Phone, MessageSquare, Send } from 'lucide-react';
import { ActionButton } from './ActionButton';
import { sanitizeTelUrl, sanitizeWhatsAppUrl, sanitizeTelegramUrl } from '@/utils/sanitize';

interface ContactButtonsProps {
  phone: string;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}

export const ContactButtons = ({
  phone,
  size = 'md',
  className = ''
}: ContactButtonsProps) => {
  if (!phone) return null;

  const telUrl = sanitizeTelUrl(phone);
  const waUrl = sanitizeWhatsAppUrl(phone);
  const tgUrl = sanitizeTelegramUrl(phone);

  return (
    <div className={`flex gap-2 ${className}`}>
      {telUrl && (
        <ActionButton
          as="a"
          href={telUrl}
          icon={Phone}
          iconSize={12}
          size={size}
          variant="default"
        >
          Позвонить
        </ActionButton>
      )}
      {waUrl && (
        <ActionButton
          as="a"
          href={waUrl}
          target="_blank"
          rel="noopener noreferrer"
          icon={MessageSquare}
          iconSize={12}
          size={size}
          variant="default"
        >
          WhatsApp
        </ActionButton>
      )}
      {tgUrl && (
        <ActionButton
          as="button"
          // tg://resolve?phone=… надо открывать в текущем окне через
          // location.href — _blank на iOS даёт пустую вкладку без
          // перехода в приложение.
          onClick={() => { window.location.href = tgUrl; }}
          icon={Send}
          iconSize={12}
          size={size}
          variant="default"
        >
          Telegram
        </ActionButton>
      )}
    </div>
  );
};
