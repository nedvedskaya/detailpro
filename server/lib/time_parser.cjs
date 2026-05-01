// Унифицированный парсер времени HH:MM[:SS] для PG TIME.
//
// Принимает: «8:30», «08:30», «8.30», «8 30», «08:30:00».
// Возвращает: «HH:MM:SS» строку или null если ввод невалидный (вне 00:00:59).
//
// Заменяет parseDailySummaryTime (profile.cjs) и parseHHMM (telegram.cjs).
// Оба прежних парсера расходились в наборе разделителей — здесь принимаем
// все три, чтобы фронт-формы и telegram-ввод обрабатывались одинаково
// и баги парсинга не приходилось чинить дважды.

function parseTimeHHMM(input) {
  if (typeof input !== 'string' && typeof input !== 'number') return null;
  const s = String(input).trim();
  const m = s.match(/^(\d{1,2})[:.\s](\d{2})(?::(\d{2}))?$/);
  if (!m) return null;
  const h   = Number(m[1]);
  const min = Number(m[2]);
  const sec = m[3] !== undefined ? Number(m[3]) : 0;
  if (!Number.isFinite(h) || !Number.isFinite(min) || !Number.isFinite(sec)) return null;
  if (h < 0 || h > 23) return null;
  if (min < 0 || min > 59) return null;
  if (sec < 0 || sec > 59) return null;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

module.exports = { parseTimeHHMM };
