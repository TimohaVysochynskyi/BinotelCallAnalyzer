const { getTranscriptsInRange } = require('./store');
const { generateManagerReport } = require('./analyze');
const { sendDocument, sendAlert } = require('./telegram');
const { previousKyivDayRange, formatDateStr } = require('./time');
const { generateReportPdf } = require('./pdfReport');

function groupByManager(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = row.managerName || 'Невідомий менеджер';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return groups;
}

// Defaults to the previous full calendar day in Kyiv time - what "report for the last day"
// means when this is triggered once a day at a fixed local hour. Pass an explicit range
// (e.g. from manual testing) to report on something else.
async function generateDailyReport(range) {
  const { start, end, dateStr } = range || previousKyivDayRange();
  const periodLabel = formatDateStr(dateStr);

  console.log(`[report] collecting transcripts for ${start.toISOString()} -> ${end.toISOString()}`);
  const rows = await getTranscriptsInRange(start, end);
  console.log(`[report] found ${rows.length} transcripts for that period`);

  if (rows.length === 0) {
    console.log('[report] nothing to report, skipping PDF/send');
    return;
  }

  const groups = groupByManager(rows);
  console.log(`[report] grouped into ${groups.size} manager(s): ${[...groups.keys()].join(', ')}`);

  const managerReports = [];
  for (const [managerName, transcripts] of groups) {
    try {
      const reportText = await generateManagerReport(transcripts);
      managerReports.push({ managerName, callCount: transcripts.length, reportText });
    } catch (err) {
      console.error(`[report] FAILED to analyze ${managerName}: ${err.message}`);
      await sendAlert(`Не вдалося згенерувати аналіз для ${managerName}: ${err.message}`).catch(
        (e) => console.error(`[report] failed to send alert: ${e.message}`)
      );
    }
  }

  if (managerReports.length === 0) {
    console.error('[report] no manager reports succeeded, nothing to send');
    return;
  }

  try {
    const pdfBuffer = await generateReportPdf(managerReports, { periodLabel });
    const caption = `📊 Звіт аналізу дзвінків за ${periodLabel}\nАвтоматично згенеровано з транскриптів розмов менеджерів (${managerReports.length} менеджер(и), ${rows.length} дзвінків)`;
    await sendDocument(pdfBuffer, `zvit-${dateStr}.pdf`, caption);
    console.log('[report] PDF report sent');
  } catch (err) {
    console.error(`[report] FAILED to build/send PDF: ${err.message}`);
    await sendAlert(`Не вдалося сформувати або надіслати PDF-звіт за ${periodLabel}: ${err.message}`).catch(
      (e) => console.error(`[report] failed to send alert: ${e.message}`)
    );
  }
}

module.exports = { generateDailyReport };
