const PDFDocument = require('pdfkit');

const FONT_REGULAR = require.resolve('dejavu-fonts-ttf/ttf/DejaVuSans.ttf');
const FONT_BOLD = require.resolve('dejavu-fonts-ttf/ttf/DejaVuSans-Bold.ttf');

const COLOR_HEADING = '#1a3d7c';
const COLOR_TEXT = '#1a1a1a';
const COLOR_MUTED = '#888888';

// The analysis prompt always produces its section titles as standalone, fully-uppercase
// lines (e.g. "СИЛЬНІ СТОРОНИ") - used as a heuristic instead of hardcoding exact titles,
// since the model doesn't always reproduce the parenthesised part of the prompt's headings.
function isHeading(line) {
  if (!line || line === '---' || line.startsWith('-') || line.startsWith('*')) return false;
  const letters = line.replace(/[^a-zA-Zа-яА-ЯіїєґІЇЄҐ]/g, '');
  return letters.length > 0 && letters === letters.toUpperCase() && line.length < 90;
}

// Renders one paragraph, switching between the regular and bold font wherever the AI
// output wraps text in *asterisks* - pdfkit has no built-in markdown support.
function renderInline(doc, text, { prefix = '' } = {}) {
  const parts = text.split(/(\*[^*]+\*)/g).filter(Boolean);
  if (prefix) {
    doc.font('Regular').text(prefix, { continued: true });
  }
  parts.forEach((part, i) => {
    const isBold = part.startsWith('*') && part.endsWith('*') && part.length > 1;
    doc.font(isBold ? 'Bold' : 'Regular');
    doc.text(isBold ? part.slice(1, -1) : part, { continued: i < parts.length - 1 });
  });
}

function renderReportBody(doc, text) {
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || line === '---') {
      doc.moveDown(0.4);
      continue;
    }
    if (isHeading(line)) {
      doc.moveDown(0.6).font('Bold').fontSize(13).fillColor(COLOR_HEADING).text(line);
      doc.moveDown(0.2).fontSize(11).fillColor(COLOR_TEXT);
      continue;
    }
    if (line.startsWith('- ')) {
      renderInline(doc, line.slice(2), { prefix: '   •  ' });
      continue;
    }
    renderInline(doc, line);
    doc.moveDown(0.2);
  }
}

function addFooters(doc, footerText) {
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i += 1) {
    doc.switchToPage(i);
    // Drawing this close to the bottom edge is inside the page's default bottom margin,
    // which makes pdfkit think the text overflows and silently appends a blank page for
    // every footer - dropping the margin to 0 for this one call stops that.
    const bottomMargin = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    doc
      .font('Regular')
      .fontSize(8)
      .fillColor(COLOR_MUTED)
      .text(`${footerText} · сторінка ${i + 1} з ${range.count}`, 50, doc.page.height - 40, {
        width: doc.page.width - 100,
        align: 'center',
        lineBreak: false,
      });
    doc.page.margins.bottom = bottomMargin;
  }
}

// managerReports: [{ managerName, callCount, reportText }]. One page per manager.
function generateReportPdf(managerReports, { periodLabel }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50, bufferPages: true });
    doc.registerFont('Regular', FONT_REGULAR);
    doc.registerFont('Bold', FONT_BOLD);

    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    managerReports.forEach((mr, i) => {
      if (i > 0) doc.addPage();
      doc.font('Bold').fontSize(18).fillColor(COLOR_HEADING).text(mr.managerName);
      doc
        .font('Regular')
        .fontSize(10)
        .fillColor(COLOR_MUTED)
        .text(`${periodLabel} · ${mr.callCount} дзвінків`);
      doc.moveDown(1);
      renderReportBody(doc, mr.reportText);
    });

    addFooters(doc, `Автоматичний аналіз дзвінків менеджерів · ${periodLabel}`);
    doc.end();
  });
}

module.exports = { generateReportPdf };
