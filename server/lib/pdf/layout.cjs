'use strict';
/**
 * Переиспользуемые layout-хелперы для PDF-документов.
 *
 * Адаптируют HTML-шаблоны из document_templates.md под императивный API pdfkit
 * (нет flex/grid — координаты считаем вручную).
 *
 * Палитра и размеры повторяют CSS из шаблона:
 *   text         #1a1a1a   secondary  #555    muted   #777
 *   border       #ccc      cell-bg    #f5f5f5
 *   legal-bg     #f8f8f8   legal-bd   #ddd
 *   status-ok    #2d6a2d   status-dmg #b85000
 *   paid-bg      #e5f5e5   paid-fg    #1a6b1a
 */

const { FONT } = require('./fonts.cjs');

// Поля страницы из спеки: 15mm/20mm. 1mm ≈ 2.835 pt.
const PAGE_MARGIN_X = 56.7;   // 20mm
const PAGE_MARGIN_Y = 42.5;   // 15mm
const PAGE_WIDTH    = 595.28; // A4 portrait в pt
const CONTENT_LEFT  = PAGE_MARGIN_X;
const CONTENT_RIGHT = PAGE_WIDTH - PAGE_MARGIN_X;
const CONTENT_WIDTH = CONTENT_RIGHT - CONTENT_LEFT;

const COLORS = {
  text:      '#1a1a1a',
  secondary: '#555555',
  muted:     '#777777',
  hairline:  '#cccccc',
  cellBg:    '#f5f5f5',
  legalBg:   '#f8f8f8',
  legalBd:   '#dddddd',
  ok:        '#2d6a2d',
  dmg:       '#b85000',
};

function fmtDate(value) {
  if (!value) return '—';
  const v = String(value);
  if (/^\d{4}-\d{2}-\d{2}/.test(v)) {
    const [y, m, d] = v.slice(0, 10).split('-');
    return `${d}.${m}.${y}`;
  }
  return v;
}

function fmtTime(value) {
  if (!value) return '';
  return String(value).slice(0, 5);
}

/**
 * Выводит «дата · время» из ISO-timestamp (created_at).
 */
function fmtDateTime(value) {
  if (!value) return '—';
  const v = String(value);
  // Ожидаем «YYYY-MM-DD HH:MM:SS+TZ» или ISO.
  const m = v.match(/^(\d{4})-(\d{2})-(\d{2})[T\s](\d{2}):(\d{2})/);
  if (!m) return v;
  return `${m[3]}.${m[2]}.${m[1]} · ${m[4]}:${m[5]}`;
}

function fmtRub(n) {
  const v = Number(n) || 0;
  return v.toLocaleString('ru-RU', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

/**
 * Двухколоночная шапка: слева реквизиты студии, справа title + subtitle + legal-ref.
 * Возвращает Y-координату ниже разделительной линии (откуда продолжать рисование).
 */
function drawHeader(doc, { studio, docTitle, docSubtitle, legalRef }) {
  const top = PAGE_MARGIN_Y;
  const colWidth = CONTENT_WIDTH / 2 - 8;

  // Левая колонка — название и реквизиты студии.
  doc.fillColor(COLORS.text).font(FONT.bold).fontSize(13)
     .text(studio.display_name || 'Студия детейлинга', CONTENT_LEFT, top, { width: colWidth });
  const detailsY = doc.y + 1;
  const studioLines = [];
  const inn = studio.inn ? `ИНН ${studio.inn}` : null;
  const ogrn = studio.ogrn ? `ОГРН ${studio.ogrn}` : null;
  if (inn || ogrn) studioLines.push([inn, ogrn].filter(Boolean).join(' · '));
  if (studio.actual_address || studio.legal_address) {
    studioLines.push(studio.actual_address || studio.legal_address);
  }
  const contacts = [studio.contact_phone, studio.contact_email].filter(Boolean).join(' · ');
  if (contacts) studioLines.push(contacts);
  doc.font(FONT.regular).fontSize(9).fillColor(COLORS.secondary)
     .text(studioLines.join('\n'), CONTENT_LEFT, detailsY, { width: colWidth, lineGap: 1 });
  const leftEndY = doc.y;

  // Правая колонка — заголовок документа.
  const rightX = CONTENT_LEFT + colWidth + 16;
  doc.fillColor(COLORS.text).font(FONT.bold).fontSize(13)
     .text(docTitle, rightX, top, { width: colWidth, align: 'right' });
  let subY = doc.y + 1;
  if (docSubtitle) {
    doc.font(FONT.regular).fontSize(9).fillColor(COLORS.secondary)
       .text(docSubtitle, rightX, subY, { width: colWidth, align: 'right' });
    subY = doc.y;
  }
  if (legalRef) {
    doc.font(FONT.regular).fontSize(9).fillColor(COLORS.muted)
       .text(legalRef, rightX, subY + 1, { width: colWidth, align: 'right' });
  }
  const rightEndY = doc.y;

  // Разделительная линия 1.5px под обеими колонками.
  const lineY = Math.max(leftEndY, rightEndY) + 5;
  doc.moveTo(CONTENT_LEFT, lineY).lineTo(CONTENT_RIGHT, lineY)
     .lineWidth(1.5).strokeColor(COLORS.text).stroke();
  doc.fillColor(COLORS.text);
  return lineY + 8;
}

/**
 * Заголовок секции — мелкий uppercase в gray-каше.
 * Возвращает Y под заголовком (откуда рисовать содержимое).
 */
function drawSectionTitle(doc, y, text) {
  doc.font(FONT.bold).fontSize(8.5).fillColor(COLORS.secondary)
     .text(text.toUpperCase(), CONTENT_LEFT, y, {
       width: CONTENT_WIDTH,
       characterSpacing: 0.6,
     });
  doc.fillColor(COLORS.text);
  return doc.y + 2;
}

/**
 * Прямоугольное поле с label (мелкий gray) и value (поверх).
 * x/y/w — координаты левого верхнего угла и ширина, h — высота поля.
 */
function drawField(doc, x, y, w, h, label, value, opts = {}) {
  doc.lineWidth(0.5).strokeColor(COLORS.hairline).rect(x, y, w, h).stroke();
  doc.font(FONT.regular).fontSize(7.5).fillColor(COLORS.muted)
     .text(label, x + 5, y + 3, { width: w - 10 });
  const valY = y + 11;
  doc.font(FONT.bold).fontSize(opts.valueFontSize || 9.5).fillColor(COLORS.text)
     .text(String(value || '—'), x + 5, valY, {
       width: w - 10,
       height: h - 12,
       ellipsis: true,
       lineBreak: false,
     });
  doc.fillColor(COLORS.text);
}

/**
 * Раскладывает массив полей в N колонок.
 * Каждый элемент: { label, value, valueFontSize? }.
 */
function drawFieldGrid(doc, y, fields, columns, fieldHeight = 22) {
  const gap = 5;
  const colW = (CONTENT_WIDTH - gap * (columns - 1)) / columns;
  const rows = Math.ceil(fields.length / columns);
  for (let i = 0; i < fields.length; i++) {
    const r = Math.floor(i / columns);
    const c = i % columns;
    const x = CONTENT_LEFT + c * (colW + gap);
    const fy = y + r * (fieldHeight + gap);
    drawField(doc, x, fy, colW, fieldHeight, fields[i].label, fields[i].value, fields[i]);
  }
  return y + rows * (fieldHeight + gap);
}

/**
 * Юридический блок — серый фон, скруглённые углы, абзацы.
 */
function drawLegalBlock(doc, y, paragraphs) {
  const padding = 8;
  // Считаем высоту: для каждого параграфа замеряем heightOfString.
  doc.font(FONT.regular).fontSize(8);
  const lineGap = 0.8;
  let inner = 0;
  paragraphs.forEach((p, idx) => {
    const h = doc.heightOfString(p, { width: CONTENT_WIDTH - padding * 2, lineGap });
    inner += h + (idx < paragraphs.length - 1 ? 3 : 0);
  });
  const height = inner + padding * 2;

  doc.roundedRect(CONTENT_LEFT, y, CONTENT_WIDTH, height, 3)
     .fillAndStroke(COLORS.legalBg, COLORS.legalBd);

  doc.fillColor('#444').font(FONT.regular).fontSize(8);
  let py = y + padding;
  paragraphs.forEach((p, idx) => {
    doc.text(p, CONTENT_LEFT + padding, py, {
      width: CONTENT_WIDTH - padding * 2,
      lineGap,
    });
    py = doc.y + (idx < paragraphs.length - 1 ? 3 : 0);
  });
  doc.fillColor(COLORS.text);
  return y + height + 8;
}

/**
 * Двойной блок подписей: слева мастер, справа заказчик.
 * Если signatureBuf указан — подставляется PNG-картинка вместо линии.
 */
function drawSignatures(doc, y, leftSig, rightSig) {
  const gap = 24;
  const colW = (CONTENT_WIDTH - gap) / 2;
  const sigH = 28;

  function drawOne(x, sig) {
    doc.font(FONT.regular).fontSize(8.5).fillColor(COLORS.secondary)
       .text(sig.label, x, y, { width: colW });
    const labelEnd = doc.y;
    const sigTop = labelEnd + 2;
    if (sig.signatureBuf) {
      try {
        doc.image(sig.signatureBuf, x, sigTop, { fit: [colW, sigH], align: 'left' });
      } catch (_) { /* ignore */ }
    }
    const lineY = sigTop + sigH;
    doc.moveTo(x, lineY).lineTo(x + colW, lineY)
       .lineWidth(0.5).strokeColor(COLORS.text).stroke();
    doc.font(FONT.regular).fontSize(8.5).fillColor(COLORS.secondary)
       .text(sig.name + (sig.suffix || '   /подпись/'), x, lineY + 3, { width: colW });
    return doc.y;
  }

  const endL = drawOne(CONTENT_LEFT, leftSig);
  const endR = drawOne(CONTENT_LEFT + colW + gap, rightSig);
  doc.fillColor(COLORS.text);
  return Math.max(endL, endR) + 6;
}

/**
 * Парсит data-URL подписи в Buffer (или null, если строка не подходит).
 */
function signatureBuffer(dataUrl) {
  if (!dataUrl || typeof dataUrl !== 'string') return null;
  if (!dataUrl.startsWith('data:image/png;base64,')) return null;
  try {
    return Buffer.from(dataUrl.replace(/^data:image\/png;base64,/, ''), 'base64');
  } catch (_) {
    return null;
  }
}

module.exports = {
  PAGE_MARGIN_X, PAGE_MARGIN_Y, PAGE_WIDTH,
  CONTENT_LEFT, CONTENT_RIGHT, CONTENT_WIDTH,
  COLORS,
  fmtDate, fmtTime, fmtDateTime, fmtRub,
  drawHeader, drawSectionTitle,
  drawField, drawFieldGrid,
  drawLegalBlock, drawSignatures,
  signatureBuffer,
};
