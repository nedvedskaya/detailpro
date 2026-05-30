export const CLIENT_CARD_COLORS = [
  { id: 'none', label: 'Без метки', hex: null },
  { id: 'red', label: 'Красный', hex: '#ef4444' },
  { id: 'yellow', label: 'Жёлтый', hex: '#f59e0b' },
  { id: 'green', label: 'Зелёный', hex: '#22c55e' },
  { id: 'blue', label: 'Синий', hex: '#3b82f6' },
  { id: 'purple', label: 'Фиолетовый', hex: '#8b5cf6' },
  { id: 'pink', label: 'Розовый', hex: '#ec4899' },
  { id: 'gray', label: 'Серый', hex: '#71717a' },
] as const;

export type ClientCardColor = typeof CLIENT_CARD_COLORS[number]['id'];

export const getClientCardColor = (value?: string | null) => (
  CLIENT_CARD_COLORS.find(color => color.id === value) || CLIENT_CARD_COLORS[0]
);

export const getClientCardColorHex = (value?: string | null) => getClientCardColor(value).hex;

export const hasClientCardColor = (value?: string | null) => Boolean(getClientCardColorHex(value));
