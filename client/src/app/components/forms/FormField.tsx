import { LucideIcon } from 'lucide-react';

type FormFieldType = 'text' | 'tel' | 'date' | 'time' | 'number' | 'textarea' | 'select';

interface FormFieldProps {
  label: string;
  name: string;
  type?: FormFieldType;
  value: string | number;
  onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => void;
  placeholder?: string;
  required?: boolean;
  icon?: LucideIcon;
  options?: { value: string; label: string }[];
  disabled?: boolean;
  className?: string;
  rows?: number;
}

export const FormField = ({
  label,
  name,
  type = 'text',
  value,
  onChange,
  placeholder,
  required = false,
  icon: Icon,
  options,
  disabled = false,
  className = '',
  rows = 3
}: FormFieldProps) => {
  const baseInputClass = "w-full bg-white border border-zinc-200 rounded-lg p-3 text-sm outline-none focus:border-orange-500 transition-all shadow-sm disabled:bg-zinc-50 disabled:text-zinc-400 whitespace-nowrap";
  const labelClass = "text-xs font-black text-zinc-400 uppercase tracking-widest mb-2 block";

  const renderInput = () => {
    if (type === 'textarea') {
      return (
        <textarea
          name={name}
          value={value}
          onChange={onChange}
          placeholder={placeholder}
          required={required}
          disabled={disabled}
          rows={rows}
          className={baseInputClass}
        />
      );
    }

    if (type === 'select' && options) {
      return (
        <select
          name={name}
          value={value}
          onChange={onChange}
          required={required}
          disabled={disabled}
          className={baseInputClass}
        >
          <option value="">{placeholder || 'Выберите...'}</option>
          {options.map(option => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      );
    }

    return (
      <div className="relative">
        {Icon && (
          <div className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400">
            <Icon size={16} />
          </div>
        )}
        <input
          type={type}
          name={name}
          value={value}
          onChange={onChange}
          placeholder={placeholder}
          required={required}
          disabled={disabled}
          className={`${baseInputClass} ${Icon ? 'pl-10' : ''}`}
        />
      </div>
    );
  };

  return (
    <div className={className}>
      <label className={labelClass}>
        {label}
        {required && <span className="text-orange-500 ml-1">*</span>}
      </label>
      {renderInput()}
    </div>
  );
};
