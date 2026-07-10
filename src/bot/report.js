import {
  getCallsWithTranscriptsInRange,
  getReportSlot,
  setReportSlot,
  getReportUntil,
  setReportUntil,
} from '../core/store.js';
import { analyzeManager } from './analyze.js';
import { sendLong } from './ui.js';
import { kyivParts, startOfDay, formatKyiv } from './time.js';

const REPORT_TIMES = (process.env.BOT_REPORT_TIMES || '13:00,19:30')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

function groupByManager(rows) {
  const groups = new Map();
  for (const r of rows) {
    const name = r.managerName || 'Невідомий менеджер';
    if (!groups.has(name)) groups.set(name, { name, calls: [] });
    groups.get(name).calls.push(r);
  }
  return [...groups.values()];
}

// Returns the assembled report text, or null when there were no processed calls in the period.
async function buildReport(start, end) {
  const rows = await getCallsWithTranscriptsInRange(start, end);
  if (rows.length === 0) return null;

  const groups = groupByManager(rows);
  const parts = [];
  for (const g of groups) {
    try {
      const { stats, summary } = await analyzeManager(g.name, g.calls);
      const rate = stats.callCount ? Math.round((stats.successCount / stats.callCount) * 100) : 0;
      parts.push(`👤 *${g.name}* — ${stats.callCount} дзв., успішність ${rate}%, бал ${stats.avgScore ?? '—'}\n${summary}`);
    } catch (err) {
      parts.push(`👤 *${g.name}* — не вдалося згенерувати аналіз: ${err.message}`);
    }
  }

  const header = `📊 *Звіт за період*\n${formatKyiv(start)} – ${formatKyiv(end)}\nМенеджерів: ${groups.length}, дзвінків: ${rows.length}`;
  return `${header}\n\n${parts.join('\n\n———\n\n')}`;
}

async function sendReport(api, chatId, start, end) {
  const text = await buildReport(start, end);
  if (!text) return { sent: false, empty: true };
  await sendLong(api, chatId, text, { parseMode: 'Markdown' });
  return { sent: true };
}

// Manual "report now": covers today so far and does NOT touch the scheduler state, so it can't
// disturb the next automatic slot.
async function sendManualReport(api, chatId) {
  const end = new Date();
  const res = await sendReport(api, chatId, startOfDay(end), end);
  if (res.empty) await api.sendMessage(chatId, 'За сьогодні ще немає оброблених дзвінків для звіту.');
  return res;
}

let running = false;

// Fires once per configured time slot (Kyiv). Period = since the previous automatic report
// (or start of today on the very first run), so back-to-back slots never overlap or leave a
// gap. Slot dedup (app_state.last_report_slot) survives restarts; the in-memory lock prevents
// a double-fire within the same minute.
async function maybeSendScheduledReport(api, chatId) {
  const now = new Date();
  const { dateStr, hhmm } = kyivParts(now);
  if (!REPORT_TIMES.includes(hhmm)) return;

  const slotKey = `${dateStr}-${hhmm}`;
  if (running) return;
  if ((await getReportSlot()) === slotKey) return;

  running = true;
  try {
    const end = now;
    const start = (await getReportUntil()) || startOfDay(now);
    console.log(`[bot] scheduled report slot ${slotKey}: ${start.toISOString()} -> ${end.toISOString()}`);
    const res = await sendReport(api, chatId, start, end);
    await setReportSlot(slotKey);
    await setReportUntil(end);
    if (res.empty) console.log('[bot] scheduled report: nothing to send this period');
  } finally {
    running = false;
  }
}

function startScheduler(api, chatId) {
  console.log(`[bot] report scheduler on for ${REPORT_TIMES.join(', ')} (Kyiv), recipient chat ${chatId}`);
  setInterval(() => {
    maybeSendScheduledReport(api, chatId).catch((e) => console.error(`[bot] scheduled report error: ${e.message}`));
  }, 30000);
}

export { buildReport, sendReport, sendManualReport, startScheduler };
