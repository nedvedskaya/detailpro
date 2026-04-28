import React, { useState, useEffect, useRef } from 'react';

interface AutocompleteInputProps {
    options: string[];
    value: string;
    onChange: (e: { target: { name?: string; value: string } }) => void;
    placeholder?: string;
    className?: string;
    name?: string;
    disabled?: boolean;
    aliases?: Record<string, string>;
    // Опциональная sticky-кнопка в самом верху выпадашки (например, «+ Добавить клиента»).
    topAction?: { label: string; onClick: () => void };
}

export const AutocompleteInput = ({
    options,
    value,
    onChange,
    placeholder,
    className,
    name,
    disabled,
    aliases,
    topAction,
}: AutocompleteInputProps) => {
    const [suggestions, setSuggestions] = useState<string[]>([]);
    const [showSuggestions, setShowSuggestions] = useState(false);
    const wrapperRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const handleClickOutside = (event: MouseEvent) => {
            if (wrapperRef.current && !wrapperRef.current.contains(event.target as Node)) {
                setShowSuggestions(false);
            }
        };
        document.addEventListener("mousedown", handleClickOutside);
        return () => document.removeEventListener("mousedown", handleClickOutside);
    }, []);

    const handleInput = (e: React.ChangeEvent<HTMLInputElement>) => {
        const val = e.target.value;
        onChange(e);
        const searchVal = val.toLowerCase();
        let filtered: string[] = [];
        if (aliases) {
            const matchedBrands = new Set<string>();
            Object.keys(aliases).forEach(alias => { 
                if (alias.includes(searchVal)) matchedBrands.add(aliases[alias]); 
            });
            options.forEach(opt => { 
                if (opt.toLowerCase().includes(searchVal)) matchedBrands.add(opt); 
            });
            filtered = Array.from(matchedBrands);
        } else {
            filtered = val.length > 0 
                ? options.filter(opt => opt.toLowerCase().includes(searchVal)) 
                : options;
        }
        setSuggestions(filtered);
        setShowSuggestions(true);
    };

    const handleFocus = () => {
        if (!disabled) {
            const val = value ? String(value).toLowerCase() : '';
            let filtered: string[] = [];
            if (aliases) {
                const matchedBrands = new Set<string>();
                if (val) {
                    Object.keys(aliases).forEach(alias => { 
                        if (alias.includes(val)) matchedBrands.add(aliases[alias]); 
                    });
                    options.forEach(opt => { 
                        if (opt.toLowerCase().includes(val)) matchedBrands.add(opt); 
                    });
                    filtered = Array.from(matchedBrands);
                } else {
                    filtered = options;
                }
            } else {
                filtered = val 
                    ? options.filter(opt => opt.toLowerCase().includes(val)) 
                    : options;
            }
            setSuggestions(filtered);
            setShowSuggestions(true);
        }
    };

    return (
        <div ref={wrapperRef} className="relative w-full">
            <input 
                type="text" 
                name={name} 
                value={String(value || '')} 
                onChange={handleInput} 
                onFocus={handleFocus}
                placeholder={placeholder} 
                className={className} 
                autoComplete="off" 
                disabled={disabled}
            />
            {showSuggestions && (suggestions.length > 0 || topAction) && !disabled && (
                <div className="absolute z-[150] w-full bg-white border border-zinc-200 rounded-xl mt-1 shadow-2xl max-h-60 overflow-y-auto animate-in fade-in slide-in-from-top-2 duration-200">
                    {topAction && (
                        <div
                            onClick={() => { topAction.onClick(); setShowSuggestions(false); }}
                            className="sticky top-0 px-4 py-3 bg-orange-50 hover:bg-orange-100 cursor-pointer text-sm font-bold text-orange-600 border-b border-orange-100 active:bg-orange-200 transition-colors"
                        >
                            {topAction.label}
                        </div>
                    )}
                    {suggestions.length > 0 && (
                      <div className="sticky bg-zinc-50 px-3 py-1.5 border-b border-zinc-100" style={{ top: topAction ? 44 : 0 }}>
                          <span className="text-xs font-black text-zinc-400 uppercase tracking-wider">
                              {suggestions.length} {suggestions.length === 1 ? 'вариант' : suggestions.length < 5 ? 'варианта' : 'вариантов'}
                          </span>
                      </div>
                    )}
                    {suggestions.map((opt, idx) => (
                        <div 
                            key={idx} 
                            onClick={() => { 
                                onChange({ target: { name, value: opt } }); 
                                setShowSuggestions(false); 
                            }} 
                            className="px-4 py-3 hover:bg-zinc-50 cursor-pointer text-sm font-semibold text-zinc-700 border-b border-zinc-50 last:border-0 active:bg-zinc-100 transition-colors"
                        >
                            {String(opt)}
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
};