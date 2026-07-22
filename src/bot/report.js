import {
  getOperatorStats,
  getCallsForReport,
  getActiveOperatorsInRange,
  getReportSlot,
  setReportSlot,
  getReportUntil,
  setReportUntil,
  getRecipients,
  getReportTimes,
} from '../core/store.js';
import { reduceFindings } from './analyze.js';
import { prepareClips, clipKey, sendClip } from './audioClip.js';
import { withProgress, sendLong } from './ui.js';
import { displayName } from './operators.js';
import { kyivParts, startOfDay, formatKyiv } from './time.js';

// Evidence-first report delivery (Telegram text + audio clips). No PDF: findings are short text
// messages, and each NEGATIVE finding is followed by audio clips (~3) of its quotes so the owner can
// listen and verify. Built on the cached per-call "map" (calls.behaviors) → the reduce
// (analyze.reduceFindings) only aggregates, it never re-analyses transcripts.

const ERROR_ICON = '❌';
const STRENGTH_ICON = '✅';

// Build one manager's report for [start, end): numeric stats + verified findings + ideal phrases.
// Returns null when the manager has no processed calls in the period.
async function buildManagerEvidenceReport(name, start, end) {
  const stats = await getOperatorStats(name, start, end);
  if (!stats.callCount) return null;
  const calls = await getCallsForReport(name, start, end);
  const { findings, phrases } = await reduceFindings(name, calls, stats);
  return { name, stats, findings, phrases, start, end };
}

// Numeric header. Conversion / score / weakest stage are over SALES-relevant calls; the breakdown
// line shows how many of the total were sales vs informational so the numbers are honest.
function headerText(report) {
  const { name, stats, start, end } = report;
  const sales = stats.salesCount ?? 0;
  const info = stats.infoCount ?? 0;
  const rate = sales ? Math.round((stats.successCount / sales) * 100) : 0;
  return (
    `📊 *Доказовий звіт* — ${displayName(name)}\n` +
    `_${formatKyiv(start)} – ${formatKyiv(end)}_\n\n` +
    `Дзвінків: *${stats.callCount}* (продажних: ${sales}, інформаційних: ${info})\n` +
    `Записів: *${stats.successCount}* з ${sales} продажних (${rate}%)\n` +
    `Середній бал (продажні): *${stats.avgScore ?? '—'}*\n` +
    `Найслабший етап (продажні): *${stats.topWeakStage ?? '—'}*`
  );
}

// Plain text (no markdown) so arbitrary quote characters (_ * [ …) never break rendering.
function findingText(f, idx) {
  const icon = f.type === 'error' ? ERROR_ICON : STRENGTH_ICON;
  const lines = [`${icon} ${idx}. ${f.claim}`, ''];
  lines.push(`Чому це впливає на записи: ${f.why}`);
  lines.push(`Що зробити: ${f.action}`);
  lines.push('');
  lines.push(`Докази (${f.evidence.length}):`);
  f.evidence.forEach((ev, i) => {
    lines.push(`${i + 1}. «${ev.quote}» — ${formatKyiv(new Date(ev.startTime))}`);
  });
  return lines.join('\n');
}

// Send a fully-built report to ONE chat. clips (optional Map from prepareClips) carries pre-cut
// audio Buffers keyed by clipKey; when present, each negative finding's quotes are followed by their
// audio clip. Reused across recipients so audio is cut only once.
async function deliverReport(api, chatId, report, { clips } = {}) {
  await sendLong(api, chatId, headerText(report), { parseMode: 'Markdown' });

  if (!report.findings.length) {
    const sales = report.stats.salesCount ?? 0;
    const msg = sales === 0
      ? '📄 За цей період продажних дзвінків не було — оцінювати продажні навички нема на чому. Вище — числові показники.'
      : '✅ За цей період не знайдено повторюваних патернів (з ≥3 підтвердженими прикладами) — критичних системних проблем у продажах не зафіксовано. Вище — числові показники.';
    await sendLong(api, chatId, msg);
    if (report.phrases.length) {
      await sendLong(api, chatId, '💬 Готові формулювання (зразки, НЕ цитати):\n\n' + report.phrases.map((p, i) => `${i + 1}. ${p}`).join('\n'));
    }
    return;
  }

  let idx = 0;
  for (const f of report.findings) {
    idx += 1;
    await sendLong(api, chatId, findingText(f, idx));
    // Audio only for negative findings (client's choice), and only for quotes that have a timecode.
    if (clips && f.type === 'error') {
      for (const ev of f.evidence) {
        if (ev.start == null) continue;
        const buf = clips.get(clipKey(ev.callId, ev.start, ev.end));
        if (buf) await sendClip(api, chatId, buf, ev);
      }
    }
  }

  if (report.phrases.length) {
    const body =
      '💬 Готові формулювання (зразки, НЕ цитати):\n\n' +
      report.phrases.map((p, i) => `${i + 1}. ${p}`).join('\n');
    await sendLong(api, chatId, body);
  }
}

// Build + deliver one manager's report to one chat. audio=true cuts and attaches the clips.
async function deliverManagerReport(api, chatId, name, start, end, { audio = false } = {}) {
  const report = await buildManagerEvidenceReport(name, start, end);
  if (!report) return { empty: true };
  const clips = audio ? await prepareClips(report) : null;
  await deliverReport(api, chatId, report, { clips });
  return { sent: true };
}

// Manual "Звіт зараз": today so far, every active manager, delivered to the requester (with audio).
// Does NOT touch the scheduler state.
async function sendManualReport(api, chatId) {
  const end = new Date();
  const start = startOfDay(end);
  const res = await withProgress(
    api,
    chatId,
    'upload_voice',
    async () => {
      const managers = await getActiveOperatorsInRange(start, end);
      if (!managers.length) return { empty: true };
      for (const m of managers) {
        await deliverManagerReport(api, chatId, m.name, start, end, { audio: true });
      }
      return { sent: true };
    },
    { notice: '⏳ Бот формує доказовий звіт (аналіз + аудіо), це може зайняти деякий час…' }
  );
  if (res.empty) await api.sendMessage(chatId, 'За сьогодні ще немає оброблених дзвінків для звіту.');
  return res;
}

// Scheduled report: for each active manager, build the report + cut clips ONCE, then fan out to
// every recipient (app_state.report_recipients). A failed send to one recipient doesn't block others.
async function sendScheduledReport(api, start, end) {
  const recipients = await getRecipients('report');
  if (recipients.length === 0) {
    console.warn('[bot] scheduled report: no recipients configured (Налаштування) - not sent');
    return { sent: false, empty: false };
  }
  const managers = await getActiveOperatorsInRange(start, end);
  if (!managers.length) return { sent: false, empty: true };

  for (const m of managers) {
    const report = await buildManagerEvidenceReport(m.name, start, end);
    if (!report) continue;
    const clips = await prepareClips(report);
    for (const r of recipients) {
      try {
        await deliverReport(api, r.id, report, { clips });
      } catch (err) {
        console.error(`[bot] scheduled report to ${r.id} failed: ${err.message}`);
      }
    }
  }
  return { sent: true };
}

let running = false;

// Fires once per configured time slot (Kyiv). Period = since the previous automatic report (or
// start of today on the very first run). Slot dedup (app_state.last_report_slot) survives restarts;
// the in-memory lock prevents a double-fire within the same minute.
async function maybeSendScheduledReport(api) {
  const now = new Date();
  const { dateStr, hhmm } = kyivParts(now);
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

export { buildManagerEvidenceReport, deliverManagerReport, sendManualReport, startScheduler };
