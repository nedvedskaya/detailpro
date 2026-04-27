'use strict';
/**
 * Генератор PDF заказ-наряда.
 *
 * Этап 6: финальный layout под document_templates.md.
 * Двухколоночная шапка, бордерные поля сторон/авто/сроков, таблица услуг
 * с серой шапкой, итоги справа, бейджи оплаты, юр-блок и две подписи.
 *
 * API:
 *   streamWorkOrderPdf(stream, { studio, booking, workOrder, client, vehicle, master });
 */

const PDFDocument = require('pdfkit');
const { registerFonts, FONT } = require('./fonts.cjs');
const L = require('./layout.cjs');

const PAYMENT_LABELS = { cash: 'Наличные', card: 'Карта', transfer: 'Перевод' };

function streamWorkOrderPdf(stream, ctx) {
  const { studio, booking, workOrder } = ctx;
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
    docTitle:    `Заказ-наряд № ${workOrder.id}`,
    docSubtitle: `от ${L.fmtDate(workOrder.created_at)}`,
    legalRef:    'Договор возмездного оказания услуг (ст. 779 ГК РФ)',
  });

  // ── СТОРОНЫ ────────────────────────────────────────────────────────
  y = L.drawSectionTitle(doc, y, 'Стороны');
  y = L.drawFieldGrid(doc, y, [
    { label: 'Исполнитель',     value: studio.display_name || '—' },
    { label: 'Заказчик (ФИО)',  value: client.name  || '—' },
    { label: 'Телефон',         value: client.phone || '—' },
  ], 3);
  y += 8;

  // ── АВТОМОБИЛЬ ─────────────────────────────────────────────────────
  y = L.drawSectionTitle(doc, y, 'Автомобиль');
  const carBrand = [vehicle.brand, vehicle.model].filter(Boolean).join(' ') || '—';
  const yearColor = [vehicle.year, vehicle.color].filter(Boolean).join(', ') || '—';
  y = L.drawFieldGrid(doc, y, [
    { label: 'Марка и модель', value: carBrand },
    { label: 'Год / цвет',     value: yearColor },
    { label: 'Госномер',       value: vehicle.license_plate || '—' },
    { label: 'VIN',            value: vehicle.vin || '—', valueFontSize: 9 },
  ], 4);
  y += 8;

  // ── СРОКИ И МАСТЕР ─────────────────────────────────────────────────
  y = L.drawFieldGrid(doc, y, [
    { label: 'Дата приёмки',    value: L.fmtDate(workOrder.created_at) },
    { label: 'Время приёмки',   value: L.fmtTime(workOrder.created_at?.slice?.(11)) || L.fmtDateTime(workOrder.created_at).split('· ')[1] || '—' },
    { label: 'Плановая выдача', value: workOrder.delivery_date
        ? L.fmtDate(workOrder.delivery_date) + (workOrder.delivery_time ? ` ${L.fmtTime(workOrder.delivery_time)}` : '')
        : '—' },
    { label: 'Мастер',          value: master.name || '—' },
  ], 4);
  y += 8;

  // ── ПЕРЕЧЕНЬ РАБОТ ─────────────────────────────────────────────────
  y = L.drawSectionTitle(doc, y, 'Перечень работ');

  const items = Array.isArray(workOrder.items) ? workOrder.items : [];
  // Колонки: №, Услуга, Кол-во, Стоимость
  const numW   = 28;
  const qtyW   = 60;
  const priceW = 100;
  const nameW  = L.CONTENT_WIDTH - numW - qtyW - priceW;
  const colX = {
    num:   L.CONTENT_LEFT,
    name:  L.CONTENT_LEFT + numW,
    qty:   L.CONTENT_LEFT + numW + nameW,
    price: L.CONTENT_LEFT + numW + nameW + qtyW,
  };

  // Заголовок таблицы.
  const headerH = 20;
  doc.rect(L.CONTENT_LEFT, y, L.CONTENT_WIDTH, headerH).fillAndStroke(L.COLORS.cellBg, L.COLORS.hairline);
  doc.fillColor(L.COLORS.text).font(FONT.bold).fontSize(9);
  doc.text('№',                    colX.num   + 4, y + 6, { width: numW   - 8, align: 'center' });
  doc.text('Наименование услуги',  colX.name  + 6, y + 6, { width: nameW  - 12 });
  doc.text('Кол-во',               colX.qty   + 4, y + 6, { width: qtyW   - 8, align: 'center' });
  doc.text('Стоимость, ₽',         colX.price + 4, y + 6, { width: priceW - 8, align: 'right'  });
  y += headerH;

  // Строки.
  doc.font(FONT.regular).fontSize(10);
  let subtotal = 0;
  items.forEach((it, i) => {
    const qty   = Number(it.quantity) || 0;
    const price = Number(it.price) || 0;
    const sum   = qty * price;
    subtotal += sum;

    // Авто-высота строки в зависимости от длины названия.
    const nameStr = String(it.name || '—');
    doc.font(FONT.regular).fontSize(10);
    const nameH = doc.heightOfString(nameStr, { width: nameW - 12 });
    const rowH  = Math.max(20, nameH + 12);

    doc.lineWidth(0.5).strokeColor(L.COLORS.hairline)
       .rect(L.CONTENT_LEFT, y, L.CONTENT_WIDTH, rowH).stroke();
    [colX.name, colX.qty, colX.price].forEach((vx) => {
      doc.moveTo(vx, y).lineTo(vx, y + rowH).stroke();
    });

    doc.fillColor(L.COLORS.muted)
       .text(String(i + 1), colX.num + 4, y + 6, { width: numW - 8, align: 'center' });
    doc.fillColor(L.COLORS.text)
       .text(nameStr,        colX.name + 6, y + 6, { width: nameW - 12 });
    doc.fillColor(L.COLORS.text)
       .text(String(qty),    colX.qty  + 4, y + 6, { width: qtyW  - 8, align: 'center' });
    doc.font(FONT.bold)
       .text(L.fmtRub(price), colX.price + 4, y + 6, { width: priceW - 8, align: 'right' });
    doc.font(FONT.regular);
    y += rowH;
  });

  y += 8;

  // ── ИТОГИ ──────────────────────────────────────────────────────────
  const discount = Number(workOrder.discount) || 0;
  const total    = Number(workOrder.total) || (subtotal - discount);
  doc.font(FONT.regular).fontSize(11).fillColor(L.COLORS.secondary)
     .text('Итого:', L.CONTENT_LEFT, y, { width: L.CONTENT_WIDTH - 100, align: 'right' });
  doc.font(FONT.bold).fillColor(L.COLORS.text)
     .text(`${L.fmtRub(subtotal)} ₽`, L.CONTENT_LEFT, y, { width: L.CONTENT_WIDTH, align: 'right' });
  y = doc.y + 2;

  if (discount > 0) {
    doc.font(FONT.regular).fontSize(11).fillColor(L.COLORS.secondary)
       .text('Скидка:', L.CONTENT_LEFT, y, { width: L.CONTENT_WIDTH - 100, align: 'right' });
    doc.font(FONT.bold).fillColor(L.COLORS.text)
       .text(`− ${L.fmtRub(discount)} ₽`, L.CONTENT_LEFT, y, { width: L.CONTENT_WIDTH, align: 'right' });
    y = doc.y + 2;
  }

  // Финальная строка с верхней разделительной линией.
  const totalLineY = y + 4;
  doc.moveTo(L.CONTENT_LEFT + L.CONTENT_WIDTH * 0.55, totalLineY)
     .lineTo(L.CONTENT_RIGHT, totalLineY)
     .lineWidth(1).strokeColor(L.COLORS.text).stroke();
  y = totalLineY + 6;

  doc.font(FONT.bold).fontSize(13).fillColor(L.COLORS.text)
     .text('Итого к оплате:', L.CONTENT_LEFT, y, { width: L.CONTENT_WIDTH - 130, align: 'right' });
  doc.font(FONT.bold).fontSize(13)
     .text(`${L.fmtRub(total)} ₽`, L.CONTENT_LEFT, y, { width: L.CONTENT_WIDTH, align: 'right' });
  y = doc.y + 16;

  // ── ОПЛАТА (бейджи) ────────────────────────────────────────────────
  y = L.drawSectionTitle(doc, y, 'Оплата');
  doc.font(FONT.regular).fontSize(9).fillColor(L.COLORS.muted)
     .text('Способ оплаты', L.CONTENT_LEFT, y);
  y += 14;
  // Рисуем три бейджа в ряд, активный — с тёмной обводкой и жирным текстом.
  const badgeOpts = ['cash', 'card', 'transfer'];
  let bx = L.CONTENT_LEFT;
  const badgeH = 18;
  badgeOpts.forEach((key) => {
    const label = PAYMENT_LABELS[key];
    const active = workOrder.payment_method === key;
    doc.font(active ? FONT.bold : FONT.regular).fontSize(10);
    const w = doc.widthOfString(label) + 18;
    doc.lineWidth(active ? 1 : 0.5).strokeColor(active ? L.COLORS.text : L.COLORS.hairline)
       .rect(bx, y, w, badgeH).stroke();
    doc.fillColor(active ? L.COLORS.text : L.COLORS.secondary)
       .text(label, bx, y + 4, { width: w, align: 'center' });
    bx += w + 8;
  });
  y += badgeH + 14;

  // ── ГАРАНТИЯ + ЮРИДИЧЕСКИЙ БЛОК ───────────────────────────────────
  const guarantee = workOrder.guarantee_text || studio.guarantee_text;
  const legalParas = [];
  if (guarantee) legalParas.push(`Гарантия: ${String(guarantee)}`);
  legalParas.push(
    'Настоящий заказ-наряд является договором возмездного оказания услуг в соответствии ' +
    'со ст. 779 ГК РФ. Подписывая документ, заказчик подтверждает ознакомление с перечнем, ' +
    'стоимостью работ и даёт согласие на их выполнение.'
  );
  legalParas.push(
    'Заказчик даёт согласие на обработку персональных данных (ФИО, телефон, данные ' +
    'автомобиля) в соответствии с Федеральным законом № 152-ФЗ «О персональных данных» ' +
    'и Политикой конфиденциальности исполнителя.'
  );
  legalParas.push(
    'Споры решаются путём переговоров. При недостижении согласия — в соответствии с ' +
    'действующим законодательством РФ. Права потребителя регулируются Законом РФ ' +
    '№ 2300-1 «О защите прав потребителей».'
  );
  if (workOrder.notes) legalParas.push(`Комментарий: ${String(workOrder.notes)}`);

  y = L.drawLegalBlock(doc, y, legalParas);

  // ── ПОДПИСИ ────────────────────────────────────────────────────────
  const sigBuf = L.signatureBuffer(workOrder.signature_data);
  const deliveryStr = workOrder.delivery_date
    ? `   дата выдачи: ${L.fmtDate(workOrder.delivery_date)}`
    : '   дата выдачи: ____________';
  L.drawSignatures(doc, y, {
    label: 'Работы выполнил (мастер)',
    name:  master.name || '—',
  }, {
    label: 'Автомобиль получил, работы проверил, качеством удовлетворён, претензий не имею (заказчик)',
    name:  client.name || '—',
    suffix: '   /подпись/' + deliveryStr,
    signatureBuf: sigBuf,
  });

  doc.end();
}

module.exports = { streamWorkOrderPdf };
