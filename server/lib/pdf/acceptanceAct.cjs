'use strict';
/**
 * Генератор PDF акта приёмки автомобиля.
 *
 * Этап 6: финальный layout под document_templates.md (без фотографий внутри!).
 * Фото остаются ТОЛЬКО в UI-разделе формы (PhotoUploader). В PDF упоминается
 * лишь количество — текстом, без изображений.
 *
 * API:
 *   streamAcceptanceActPdf(stream, { studio, booking, act, client, vehicle, master });
 */

const PDFDocument = require('pdfkit');
const { registerFonts, FONT } = require('./fonts.cjs');
const L = require('./layout.cjs');

const CONDITION_LABEL = { ok: 'Норма', minor: 'Незнач.', damaged: 'Повр.' };
const YN = (v) => (v ? 'Есть' : 'Нет');

function streamAcceptanceActPdf(stream, ctx) {
  const { studio, booking, act } = ctx;
  const client  = ctx.client  || {};
  const vehicle = ctx.vehicle || {};
  const master  = ctx.master  || {};

  const doc = new PDFDocument({
    size: 'A4',
    margins: {
      top: L.PAGE_MARGIN_Y, bottom: L.PAGE_MARGIN_Y,
      left: L.PAGE_MARGIN_X, right: L.PAGE_MARGIN_X,
    },
  });
  registerFonts(doc);
  doc.pipe(stream);

  // ── ШАПКА ──────────────────────────────────────────────────────────
  let y = L.drawHeader(doc, {
    studio,
    docTitle: 'Акт приёмки-передачи автомобиля',
    docSubtitle: `№ ${act.id} от ${L.fmtDateTime(act.created_at)}`,
    legalRef: booking ? `Является приложением к Заказ-наряду № ${booking.id}` : null,
  });

  // ── ЗАКАЗЧИК ───────────────────────────────────────────────────────
  y = L.drawSectionTitle(doc, y, 'Заказчик');
  y = L.drawFieldGrid(doc, y, [
    { label: 'ФИО',     value: client.name  || '—' },
    { label: 'Телефон', value: client.phone || '—' },
  ], 2);
  y += 8;

  // ── АВТОМОБИЛЬ ─────────────────────────────────────────────────────
  y = L.drawSectionTitle(doc, y, 'Автомобиль');
  const carBrand = [vehicle.brand, vehicle.model].filter(Boolean).join(' ') || '—';
  y = L.drawFieldGrid(doc, y, [
    { label: 'Марка и модель', value: carBrand },
    { label: 'Год выпуска',    value: vehicle.year || '—' },
    { label: 'Цвет',           value: vehicle.color || '—' },
    { label: 'Госномер',       value: vehicle.license_plate || '—' },
    { label: 'VIN',            value: vehicle.vin || '—', valueFontSize: 9 },
    { label: 'Пробег, км',     value: act.mileage != null ? String(act.mileage) : '—' },
  ], 3);
  y += 4;

  // ── СОСТОЯНИЕ КУЗОВА ───────────────────────────────────────────────
  // 16 зон в две колонки по 8: экономим ~50% вертикали без потери читаемости.
  y = L.drawSectionTitle(doc, y, 'Состояние кузова по зонам');

  const zones = Array.isArray(act.zones) ? act.zones : [];
  const halfGap = 6;
  const halfW = (L.CONTENT_WIDTH - halfGap) / 2;
  const subCols = [
    { fr: 0.42, label: 'Зона',     align: 'left'   },
    { fr: 0.18, label: 'Цар.',     align: 'center' },
    { fr: 0.16, label: 'Вмят.',    align: 'center' },
    { fr: 0.24, label: 'Сост.',    align: 'center' },
  ];

  function drawZonesHalf(xBase) {
    const headerH = 14;
    doc.rect(xBase, y, halfW, headerH).fillAndStroke(L.COLORS.cellBg, L.COLORS.hairline);
    doc.fillColor(L.COLORS.text).font(FONT.bold).fontSize(8);
    let cx = xBase;
    subCols.forEach((c) => {
      const w = halfW * c.fr;
      doc.text(c.label, cx + 3, y + 3, { width: w - 6, align: c.align });
      cx += w;
    });
  }

  // Заголовки обеих половин.
  drawZonesHalf(L.CONTENT_LEFT);
  drawZonesHalf(L.CONTENT_LEFT + halfW + halfGap);
  y += 14;

  const rowH = 13;
  const half1 = zones.slice(0, 8);
  const half2 = zones.slice(8, 16);
  const rows  = Math.max(half1.length, half2.length);

  function drawRow(z, xBase, rowY) {
    if (!z) return;
    doc.lineWidth(0.4).strokeColor(L.COLORS.hairline)
       .rect(xBase, rowY, halfW, rowH).stroke();
    let cx = xBase;
    const widths = subCols.map((c) => halfW * c.fr);

    const scratchesDmg = !!z.scratches;
    const dentsDmg     = !!z.dents;
    const condDmg      = z.condition === 'damaged';

    // вертикальные сепараторы
    let sx = xBase + widths[0];
    for (let i = 1; i < widths.length; i++) {
      doc.moveTo(sx, rowY).lineTo(sx, rowY + rowH).stroke();
      sx += widths[i];
    }

    doc.font(FONT.regular).fontSize(8.5).fillColor(L.COLORS.text)
       .text(String(z.zone_name || '—'), cx + 4, rowY + 3, { width: widths[0] - 8, align: 'left', ellipsis: true, lineBreak: false });
    cx += widths[0];
    doc.fillColor(scratchesDmg ? L.COLORS.dmg : L.COLORS.ok)
       .text(YN(scratchesDmg), cx + 2, rowY + 3, { width: widths[1] - 4, align: 'center' });
    cx += widths[1];
    doc.fillColor(dentsDmg ? L.COLORS.dmg : L.COLORS.ok)
       .text(YN(dentsDmg), cx + 2, rowY + 3, { width: widths[2] - 4, align: 'center' });
    cx += widths[2];
    doc.fillColor(condDmg ? L.COLORS.dmg : L.COLORS.ok)
       .text(CONDITION_LABEL[z.condition] || z.condition || '—',
             cx + 2, rowY + 3, { width: widths[3] - 4, align: 'center', ellipsis: true, lineBreak: false });
  }

  for (let i = 0; i < rows; i++) {
    const rowY = y + i * rowH;
    drawRow(half1[i], L.CONTENT_LEFT, rowY);
    drawRow(half2[i], L.CONTENT_LEFT + halfW + halfGap, rowY);
  }
  doc.fillColor(L.COLORS.text);
  y += rows * rowH + 8;

  // ── ОПИСАНИЕ ПОВРЕЖДЕНИЙ + ЦЕННОСТИ (2 колонки) ───────────────────
  const half = (L.CONTENT_WIDTH - 8) / 2;
  const textBoxH = 56;
  // Левый блок
  doc.font(FONT.regular).fontSize(8).fillColor(L.COLORS.muted)
     .text('Описание повреждений (свободный текст)', L.CONTENT_LEFT, y);
  doc.lineWidth(0.5).strokeColor(L.COLORS.hairline)
     .rect(L.CONTENT_LEFT, y + 12, half, textBoxH).stroke();
  doc.font(FONT.regular).fontSize(10).fillColor(L.COLORS.text)
     .text(String(act.damage_description || '—'),
           L.CONTENT_LEFT + 6, y + 16, { width: half - 12, height: textBoxH - 8, ellipsis: true });

  // Правый блок
  doc.font(FONT.regular).fontSize(8).fillColor(L.COLORS.muted)
     .text('Ценности в автомобиле', L.CONTENT_LEFT + half + 8, y);
  doc.lineWidth(0.5).strokeColor(L.COLORS.hairline)
     .rect(L.CONTENT_LEFT + half + 8, y + 12, half, textBoxH).stroke();
  doc.font(FONT.regular).fontSize(10).fillColor(L.COLORS.text)
     .text(String(act.valuables || 'Не заявлены'),
           L.CONTENT_LEFT + half + 14, y + 16, { width: half - 12, height: textBoxH - 8, ellipsis: true });

  y += 12 + textBoxH + 14;

  // ── ФОТОФИКСАЦИЯ (только текстом, без изображений) ────────────────
  y = L.drawSectionTitle(doc, y, 'Фотофиксация');
  const photosBoxH = 30;
  doc.lineWidth(0.5).strokeColor(L.COLORS.hairline)
     .rect(L.CONTENT_LEFT, y, L.CONTENT_WIDTH, photosBoxH).stroke();
  doc.font(FONT.bold).fontSize(10).fillColor(L.COLORS.text)
     .text(`Фотографий при приёмке: ${act.photos_count || 0} шт.`, L.CONTENT_LEFT + 8, y + 5);
  doc.font(FONT.regular).fontSize(9).fillColor(L.COLORS.muted)
     .text('Фотографии сохранены в системе DetailPro, доступны в карточке заказа',
           L.CONTENT_LEFT + 8, y + 17);
  if (booking?.id) {
    doc.font(FONT.regular).fontSize(9).fillColor(L.COLORS.muted)
       .text(`Заказ № ${booking.id}`, L.CONTENT_LEFT, y + 11,
             { width: L.CONTENT_WIDTH - 8, align: 'right' });
  }
  doc.fillColor(L.COLORS.text);
  y += photosBoxH + 14;

  // ── ЮРИДИЧЕСКИЙ БЛОК ──────────────────────────────────────────────
  const orderRef = booking?.id ? `№ ${booking.id}` : '';
  y = L.drawLegalBlock(doc, y, [
    `Настоящий акт составлен в соответствии с требованиями Гражданского кодекса РФ ` +
    `и является неотъемлемой частью Заказ-наряда ${orderRef}.`.trim(),
    'Заказчик подтверждает, что лично осмотрел автомобиль совместно с представителем ' +
    'студии и согласен с зафиксированным состоянием на момент приёмки. Студия не несёт ' +
    'ответственности за повреждения, зафиксированные в настоящем акте.',
    'Заказчик даёт согласие на обработку персональных данных (ФИО, телефон, данные ' +
    'автомобиля) в соответствии с Федеральным законом № 152-ФЗ «О персональных данных» ' +
    'и Политикой конфиденциальности исполнителя.',
  ]);

  // ── ПОДПИСИ ────────────────────────────────────────────────────────
  const sigBuf = L.signatureBuffer(act.signature_data);
  y = L.drawSignatures(doc, y, {
    label: 'Автомобиль принял (мастер)',
    name:  master.name || '—',
  }, {
    label: 'Автомобиль сдал (заказчик)',
    name:  client.name || '—',
    signatureBuf: sigBuf,
  });

  // ── НИЖНЯЯ СНОСКА ──────────────────────────────────────────────────
  doc.font(FONT.regular).fontSize(9).fillColor(L.COLORS.secondary)
     .text(`Дата и время приёмки: ${L.fmtDateTime(act.created_at)}`,
           L.CONTENT_LEFT, y + 4, { width: L.CONTENT_WIDTH, align: 'center' });

  doc.end();
}

module.exports = { streamAcceptanceActPdf };
