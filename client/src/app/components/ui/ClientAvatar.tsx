import { useRef, useState, useEffect } from 'react';
import { Camera, X, Loader2, Trash2 } from 'lucide-react';
import { compressImage } from '@/utils/helpers';

interface ClientAvatarProps {
  name: string;
  avatar?: string | null;
  size?: 'sm' | 'md' | 'lg';
  editable?: boolean;
  expandable?: boolean;
  isSaving?: boolean;
  onAvatarChange?: (avatar: string) => void;
  onAvatarDelete?: () => void;
}

const SIZES = {
  sm: { container: 'w-10 h-10', text: 'text-base', btn: 'w-5 h-5 -bottom-0.5 -right-0.5', delBtn: 'w-5 h-5 -bottom-0.5 -left-0.5', icon: 12 },
  md: { container: 'w-14 h-14', text: 'text-xl', btn: 'w-6 h-6 -bottom-0.5 -right-0.5', delBtn: 'w-6 h-6 -bottom-0.5 -left-0.5', icon: 13 },
  lg: { container: 'w-20 h-20', text: 'text-2xl', btn: 'w-7 h-7 -bottom-1 -right-1', delBtn: 'w-7 h-7 -bottom-1 -left-1', icon: 14 },
};

export const ClientAvatar = ({ name, avatar, size = 'md', editable = false, expandable = false, isSaving = false, onAvatarChange, onAvatarDelete }: ClientAvatarProps) => {
  const inputRef = useRef<HTMLInputElement>(null);
  const [imgError, setImgError] = useState(false);
  const [isOpen, setIsOpen] = useState(false);
  const s = SIZES[size];

  useEffect(() => { setImgError(false); }, [avatar]);
  const initial = String(name || '').charAt(0).toUpperCase();
  const showImage = avatar && !imgError;

  return (
    <>
      <div className="relative inline-block">
        <div
          className={`${s.container} rounded-full overflow-hidden bg-gradient-to-br from-orange-400 to-orange-500 flex items-center justify-center text-white ${s.text} font-black shadow-lg shrink-0 ${expandable && showImage && !isSaving ? 'cursor-pointer active:scale-95 transition-transform' : ''}`}
          onClick={() => expandable && showImage && !isSaving && setIsOpen(true)}
        >
          {showImage ? (
            <img src={avatar} alt="" className="w-full h-full object-cover" onError={() => setImgError(true)} />
          ) : (
            initial
          )}
        </div>

        {isSaving && (
          <div className={`absolute inset-0 rounded-full bg-orange-500/50 flex items-center justify-center`}>
            <Loader2 size={size === 'lg' ? 22 : size === 'md' ? 16 : 12} className="text-white animate-spin" />
          </div>
        )}

        {editable && onAvatarChange && !isSaving && (
          <>
            <button
              type="button"
              onClick={() => inputRef.current?.click()}
              className={`absolute ${s.btn} rounded-full bg-zinc-800 text-white flex items-center justify-center shadow-md hover:bg-zinc-700 transition-colors`}
            >
              <Camera size={s.icon} />
            </button>
            <input
              ref={inputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={async (e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                try {
                  const compressed = await compressImage(file, 1200, 0.92);
                  setImgError(false);
                  onAvatarChange(compressed);
                } catch (err) {
                  console.error('Error compressing image:', err);
                }
                e.target.value = '';
              }}
            />
          </>
        )}

        {editable && onAvatarDelete && showImage && !isSaving && (
          <button
            type="button"
            onClick={onAvatarDelete}
            className={`absolute ${s.delBtn} rounded-full bg-red-500 text-white flex items-center justify-center shadow-md hover:bg-red-600 transition-colors`}
          >
            <Trash2 size={s.icon} />
          </button>
        )}
      </div>

      {isOpen && showImage && (
        <div
          className="fixed inset-0 z-[1000] bg-orange-500/90 flex items-center justify-center"
          onClick={() => setIsOpen(false)}
        >
          <button
            className="absolute right-4 w-10 h-10 rounded-full bg-white/10 flex items-center justify-center text-white z-10"
            style={{ top: 'max(env(safe-area-inset-top, 12px), 16px)' }}
            onClick={() => setIsOpen(false)}
          >
            <X size={20} />
          </button>
          <img
            src={avatar!}
            alt=""
            className="max-w-[90vw] max-h-[85vh] rounded-2xl object-contain shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      )}
    </>
  );
};
