/**
 * Утилиты для санитизации и валидации пользовательских данных
 * Защита от XSS, инъекций и некорректных данных
 */

/**
 * Санитизация номера телефона
 * Удаляет все символы кроме цифр и +
 * @param phone - номер телефона
 * @returns очищенный номер или пустая строка
 */
export const sanitizePhone = (phone: string | null | undefined): string => {
  if (!phone) return '';
  
  // Оставляем только цифры и знак +
  const sanitized = phone.replace(/[^0-9+]/g, '');
  
  // Проверка на минимальную длину (не менее 10 цифр)
  const digitsOnly = sanitized.replace(/\+/g, '');
  if (digitsOnly.length < 10) {
    console.warn('[Sanitize] Phone number too short:', phone);
  }
  
  return sanitized;
};

/**
 * Санитизация URL для безопасного открытия
 * Проверяет протокол и блокирует опасные схемы
 * @param url - URL для проверки
 * @returns безопасный URL или null
 */
export const sanitizeUrl = (url: string | null | undefined): string | null => {
  if (!url) return null;
  
  const trimmed = url.trim();
  
  // Разрешённые протоколы
  const allowedProtocols = ['http:', 'https:', 'tel:', 'mailto:'];
  
  try {
    const urlObj = new URL(trimmed);
    
    // Проверка протокола
    if (!allowedProtocols.includes(urlObj.protocol)) {
      console.warn('[Sanitize] Unsafe protocol:', urlObj.protocol);
      return null;
    }
    
    return trimmed;
    
  } catch (error) {
    // Если URL невалидный, проверяем относительные ссылки
    if (trimmed.startsWith('/')) {
      return trimmed;
    }
    
    console.warn('[Sanitize] Invalid URL:', trimmed);
    return null;
  }
};

/**
 * Санитизация WhatsApp ссылки
 * @param phone - номер телефона
 * @returns готовая ссылка на WhatsApp или null
 */
export const sanitizeWhatsAppUrl = (phone: string | null | undefined): string | null => {
  const cleanPhone = sanitizePhone(phone);
  
  if (!cleanPhone) {
    return null;
  }
  
  // Удаляем + из начала для WhatsApp API
  const phoneForWA = cleanPhone.replace(/^\+/, '');
  
  // Проверка на минимальную длину
  if (phoneForWA.length < 10) {
    return null;
  }
  
  return `https://wa.me/${phoneForWA}`;
};

/**
 * Санитизация tel: ссылки
 * @param phone - номер телефона
 * @returns готовая tel: ссылка или null
 */
export const sanitizeTelUrl = (phone: string | null | undefined): string | null => {
  const cleanPhone = sanitizePhone(phone);
  
  if (!cleanPhone) {
    return null;
  }
  
  return `tel:${cleanPhone}`;
};

/**
 * Безопасное открытие внешней ссылки
 * Защита от reverse tabnabbing атаки
 * @param url - URL для открытия
 * @returns true если открыто успешно
 */
export const safeOpenLink = (url: string | null | undefined): boolean => {
  const safeUrl = sanitizeUrl(url);
  
  if (!safeUrl) {
    console.warn('[Sanitize] Cannot open unsafe URL:', url);
    return false;
  }
  
  try {
    const newWindow = window.open(safeUrl, '_blank', 'noopener,noreferrer');
    
    // Дополнительная защита от tabnabbing
    if (newWindow) {
      newWindow.opener = null;
      return true;
    }
    
    return false;
    
  } catch (error) {
    console.error('[Sanitize] Error opening link:', error);
    return false;
  }
};

/**
 * Санитизация текста для предотвращения XSS
 * Экранирует HTML специальные символы
 * @param text - текст для санитизации
 * @returns безопасный текст
 */
export const sanitizeText = (text: string | null | undefined): string => {
  if (!text) return '';
  
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;')
    .replace(/\//g, '&#x2F;');
};

