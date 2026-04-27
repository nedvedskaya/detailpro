'use strict';
/**
 * Шрифты для PDF-документов.
 *
 * pdfkit по умолчанию использует Helvetica, у которой нет кириллицы.
 * Подключаем Roboto (Apache 2.0) — есть полное покрытие RU-символов
 * и относительно компактный (≈500 KB на начертание).
 *
 * Использование внутри PDFDocument:
 *   const { registerFonts, FONT } = require('../lib/pdf/fonts');
 *   registerFonts(doc);
 *   doc.font(FONT.regular).text('Привет, мир!');
 *   doc.font(FONT.bold).text('Заголовок');
 *
 * Файлы лежат в server/assets/fonts/ и поедут вместе с rsync на VPS
 * (var/, .git/, node_modules/ исключены — assets/ нет).
 */

const path = require('node:path');

const FONTS_DIR = path.join(__dirname, '..', '..', 'assets', 'fonts');

const FONT = {
  regular: 'Roboto',
  bold:    'Roboto-Bold',
};

/**
 * Регистрирует начертания Roboto в указанном PDFDocument.
 * Должна быть вызвана ДО первого doc.font(...).
 * @param {import('pdfkit')} doc
 */
function registerFonts(doc) {
  doc.registerFont(FONT.regular, path.join(FONTS_DIR, 'Roboto-Regular.ttf'));
  doc.registerFont(FONT.bold,    path.join(FONTS_DIR, 'Roboto-Bold.ttf'));
}

module.exports = { registerFonts, FONT, FONTS_DIR };
