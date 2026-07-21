import { InputFile } from 'grammy';
import {
  getCallsWithTranscriptsInRange,
  getReportSlot,
  setReportSlot,
  getReportUntil,
  setReportUntil,
  getRecipients,
  getReportTimes,
} from '../core/store.js';
import { analyzeManager } from './analyze.js';
import { withProgress } from './ui.js';
import { generateReportPdf } from './pdfReport.js';
import { displayName } from './operators.js';
import { kyivParts, startOfDay, formatKyiv, shortDate } from './time.js';

function groupByManager(rows) {
  const groups = new Map();
  for (const r of rows) {
    const name = r.managerName || 'Невідомий менеджер';
    if (!groups.has(name)) groups.set(name, { name, calls: [] });
    groups.get(name).calls.push(r);
  }
  return [...groups.values()];
}

// Builds the per-manager analyses for [start, end). Returns { managerReports, totalCalls,
// periodLabel } or null when there were no processed calls in the period. managerReports is
// shaped for pdfReport.js (one entry -> one page). Manager names are aliased for display
// (displayName), so e.g. the director's number shows as "Богдан" in the PDF too.
async function buildReport(start, end) {
  const rows = await getCallsWithTranscriptsInRange(start, end);
  if (rows.length === 0) return null;

  const groups = groupByManager(rows);
  const managerReports = [];
  for (const g of groups) {
    const name = displayName(g.name);
    try {
      const { stats, summary } = await analyzeManager(g.name, g.calls);
      const rate = stats.callCount ? Math.round((stats.successCount / stats.callCount) * 100) : 0;
      managerReports.push({
        managerName: name,
        subtitle: `${stats.callCount} дзв. · успішність ${rate}% · середній бал ${stats.avgScore ?? '—'}`,
        reportText: summary,
      });
    } catch (err) {
      managerReports.push({
        managerName: name,
        subtitle: '',
        reportText: `Не вдалося згенерувати аналіз: ${err.message}`,
      });
    }
  }

  const periodLabel = `${formatKyiv(start)} – ${formatKyiv(end)}`;
  return { managerReports, totalCalls: rows.length, periodLabel };
}

// Renders the built report into a ready-to-send PDF (Buffer) + filename + caption. Kept separate
// from sending so the same PDF can be built once and delivered to several recipients.
function renderReport(built, start, end) {
  const { managerReports, totalCalls, periodLabel } = built;
  const pdf = generateReportPdf(managerReports, { periodLabel }); // Promise<Buffer>
  const filename = `zvit_${shortDate(start).replace(/\./g, '-')}_${shortDate(end).replace(/\./g, '-')}.pdf`;
  const caption =
    `📊 Звіт за період\n${periodLabel}\n` +
    `Менеджерів: ${managerReports.length}, дзвінків: ${totalCalls}`;
  return { pdf, filename, caption };
}

// Generates the PDF report and sends it to ONE chat. Used by the manual "Звіт зараз" (goes to the
// requester's own chat). The format is identical to the scheduled report.
async function sendReport(api, chatId, start, end) {
  const built = await buildReport(start, end);
  if (!built) return { sent: false, empty: true };
  const { pdf, filename, caption } = renderReport(built, start, end);
  await api.sendDocument(chatId, new InputFile(await pdf, filename), { caption });
  return { sent: true };
}

// Scheduled report: build the PDF once and fan it out to every recipient configured in the bot's
// /settings → "Щоденні звіти" (app_state.report_recipients). Replaces the old single
// BOT_REPORT_CHAT_ID env target. A failed send to one recipient doesn't block the others.
async function sendScheduledReport(api, start, end) {
  const built = await buildReport(start, end);
  if (!built) return { sent: false, empty: true };
  const recipients = await getRecipients('report');
  if (recipients.length === 0) {
    console.warn('[bot] scheduled report: no recipients configured (Налаштування) - not sent');
    return { sent: false, empty: false };
  }
  const { pdf, filename, caption } = renderReport(built, start, end);
  const buffer = await pdf;
  for (const r of recipients) {
    try {
      await api.sendDocument(r.id, new InputFile(buffer, filename), { caption });
    } catch (err) {
      console.error(`[bot] scheduled report to ${r.id} failed: ${err.message}`);
    }
  }
  return { sent: true };
}

// Manual "report now": covers today so far and does NOT touch the scheduler state, so it can't
// disturb the next automatic slot.
async function sendManualReport(api, chatId) {
  const end = new Date();
  // Report generation calls OpenAI once per manager then renders a PDF (15-40s total); keep an
  // "надсилає документ" indicator alive so the chat doesn't look frozen while it works.
  const res = await withProgress(
    api,
    chatId,
    'upload_document',
    () => sendReport(api, chatId, startOfDay(end), end),
    { notice: '⏳ Бот формує PDF-звіт, це може зайняти деякий час…' }
  );
  if (res.empty) await api.sendMessage(chatId, 'За сьогодні ще немає оброблених дзвінків для звіту.');
  return res;
}

let running = false;

// Fires once per configured time slot (Kyiv). Period = since the previous automatic report
// (or start of today on the very first run), so back-to-back slots never overlap or leave a
// gap. Slot dedup (app_state.last_report_slot) survives restarts; the in-memory lock prevents
// a double-fire within the same minute.
async function maybeSendScheduledReport(api) {
  const now = new Date();
  const { dateStr, hhmm } = kyivParts(now);
  // Times are managed in /settings (app_state.report_times), read every tick so edits apply
  // without a restart.
  const times = await getReportTimes();
  if (!times.includes(hhmm)) return;

  const slotKey = `${dateStr}-${hhmm}`;
  if (running) return;
  if ((await getReportSlot()) === slotKey) return;

  running = true;
  try {
    const end = now;
    const start = (await getReportUntil()) || startOfDay(now);
    console.log(`[bot] scheduled report slot ${slotKey}: ${start.toISOString()} -> ${end.toISOString()}`);
    const res = await sendScheduledReport(api, start, end);
    await setReportSlot(slotKey);
    await setReportUntil(end);
    if (res.empty) console.log('[bot] scheduled report: nothing to send this period');
  } finally {
    running = false;
  }
}

// Both the times and the recipients are read from the DB on every tick (managed in /settings), so
// the scheduler always runs — no env to configure. With no times/recipients set it simply skips.
function startScheduler(api) {
  console.log('[bot] report scheduler on (times + recipients from /settings, Kyiv)');
  setInterval(() => {
    maybeSendScheduledReport(api).catch((e) => console.error(`[bot] scheduled report error: ${e.message}`));
  }, 30000);
}

export { buildReport, sendReport, sendManualReport, startScheduler };
