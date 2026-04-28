'use strict';
/**
 * Серверные форматтеры для строк, попадающих к юзеру:
 *   • formatRub(kop)   — копейки → «8 900» (без знака ₽, без копеек,
 *                        пробел в тысячах согласно типографике).
 *   • formatDateRu(d)  — дата → «28.04.2026» (московский календарь).
 *
 * Раньше эти функции были локальными в webhooks.cjs (lines 83-95).
 * Вынесены в lib чтобы переиспользовать в других сообщениях бота
 * и telegram-уведомлениях, и не дублировать одну и ту же логику.
 *
 * На клиенте есть свои версии (client/src/utils/helpers.ts) — там
 * UI-context, могут отличаться (например, добавлять знак ₽). Не
 * сводим их в один модуль: фронт и бэк независимы по типу пакета.
 */

function formatRub(amountKop) {
  const rub = Math.round((amountKop || 0) / 100);
  // \B(?=(\d{3})+(?!\d)) — вставляем пробел перед каждой группой
  // из 3 цифр, считая с конца. 8900 → «8 900», 123456789 → «123 456 789».
  return rub.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

function formatDateRu(dateLike) {
  const d = dateLike instanceof Date ? dateLike : new Date(dateLike);
  if (Number.isNaN(d.getTime())) return '—';
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yyyy = d.getFullYear();
  return `${dd}.${mm}.${yyyy}`;
}

module.exports = { formatRub, formatDateRu };
