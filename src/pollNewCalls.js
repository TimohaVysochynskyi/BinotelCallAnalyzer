const { getCheckpoint, setCheckpoint, getLastReportDate, setLastReportDate } = require('./store');
const { processCallsForRange, retryPendingCalls } = require('./processCalls');
const { generateDailyReport } = require('./generateReport');
const { kyivDateParts } = require('./time');

const REPORT_HOUR = Number(process.env.REPORT_HOUR || 8);

// Uses a persisted checkpoint instead of a fixed "last N minutes" window, so a delayed or
// skipped cron run never creates a gap - the next run just picks up exactly where the last
// one left off. Falls back to POLL_WINDOW_MINUTES only on the very first run ever.
async function pollNewCalls() {
  await retryPendingCalls();

  const end = new Date();
  const checkpoint = await getCheckpoint();
  const windowMinutes = Number(process.env.POLL_WINDOW_MINUTES || 20);
  const start = checkpoint || new Date(end.getTime() - windowMinutes * 60 * 1000);

  console.log(`[poll] checkpoint: ${checkpoint ? checkpoint.toISOString() : '(none, using default window)'}`);
  await processCallsForRange(start, end);
  await setCheckpoint(end);

  await maybeSendDailyReport();
}

// This one process/schedule (every ~15 min) also carries the once-a-day report: once the
// Kyiv-local clock hits REPORT_HOUR and today's report hasn't gone out yet, send it. Keeps
// everything on a single Render Cron Job instead of a separate scheduled service.
async function maybeSendDailyReport() {
  const { dateStr: today, hour } = kyivDateParts();
  if (hour !== REPORT_HOUR) return;

  const lastSent = await getLastReportDate();
  if (lastSent === today) return;

  console.log(`[poll] Kyiv hour is ${hour} (report hour) and today's report wasn't sent yet - generating now`);
  await generateDailyReport();
  await setLastReportDate(today);
}

module.exports = { pollNewCalls };
