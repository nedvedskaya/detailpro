import React from 'react';

interface ColorPickerProps {
  colors: string[];
  selectedColor: string;
  onColorSelect: (color: string) => void;
  label?: string;
}

export const ColorPicker = ({ colors, selectedColor, onColorSelect, label = 'Цвет' }: ColorPickerProps) => {
  return (
    <div>
      <p className="text-[10px] font-black text-zinc-400 uppercase tracking-wider mb-2">{label}</p>
      <div className="grid grid-cols-8 gap-2">
        {colors.map(color => (
          <button
            key={color}
            type="button"
            onClick={() => onColorSelect(color)}
            className={`w-full aspect-square rounded-lg transition-all ${
              selectedColor === color 
                ? 'ring-2 ring-offset-2 ring-black scale-110' 
                : 'hover:scale-105'
            }`}
            style={{ backgroundColor: color }}
          />
        ))}
      </div>
    </div>
  );
};
