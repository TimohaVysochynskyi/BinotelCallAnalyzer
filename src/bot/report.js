import {
  getOperatorStats,
  getCallsForReport,
  getActiveOperatorsInRange,
  getRecipients,
  getReportTimes,
  getDeliveredSlots,
  markSlotDelivered,
  deleteOldManualTails,
} from '../core/store.js';
import { reduceFindings } from './analyze.js';
import { assembleReport } from './segments.js';
import { prepareClips, clipKey, sendClip } from './audioClip.js';
import { withProgress, sendLong } from './ui.js';
import { displayName } from './operators.js';
import { kyivParts, kyivDaySegments, startOfDay, formatKyiv } from './time.js';

// Evidence-first report delivery (Telegram text + audio clips). A report is a set of BLOCKS — each
// block is one analysed time segment (a frozen 'scheduled' segment reused from report_segments, or a
// live 'manual_tail'/'live' block). The costly reduce is cached per segment (src/bot/segments.js), so
// repeated / incremental reports reuse it instead of re-analysing from scratch.

const ERROR_ICON = '❌';
const STRENGTH_ICON = '✅';

// Legacy single-pass build (used for the live multi-day path, e.g. week/month "Статистика
// менеджера"): one live reduce over the whole period, wrapped as a single block so delivery is
// uniform with the segmented path.
async function buildManagerEvidenceReport(name, start, end) {
  const stats = await getOperatorStats(name, start, end);
  if (!stats.callCount) return null;
  const calls = await getCallsForReport(name, start, end);
  const { findings, phrases } = await reduceFindings(name, calls, stats);
  return { name, stats, blocks: [{ start, end, kind: 'live', findings, phrases }], phrases, start, end };
}

const hm = (date) => {
  const p = kyivParts(new Date(date));
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(p.hour)}:${pad(p.minute)}`;
};

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

// Subheader shown before a block's findings when a report has more than one non-empty block
// (so the owner sees which time segment each finding set belongs to — the basis of growth tracking).
function blockHeader(b) {
  const range = `${hm(b.start)}–${hm(b.end)}`;
  if (b.kind === 'manual_tail') return `🕒 Поточний відрізок ${range} (свіжий аналіз)`;
  return `🗓 Відрізок ${range}`;
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

async function sendPhrases(api, chatId, phrases) {
  if (!phrases?.length) return;
  await sendLong(
    api,
    chatId,
    '💬 Готові формулювання (зразки, НЕ цитати):\n\n' + phrases.map((p, i) => `${i + 1}. ${p}`).join('\n')
  );
}

// Send a fully-built report to ONE chat. clips (optional Map from prepareClips) carries pre-cut
// audio Buffers keyed by clipKey; each negative finding's quotes are followed by their clip. Reused
// across recipients so audio is cut only once.
async function deliverReport(api, chatId, report, { clips } = {}) {
  await sendLong(api, chatId, headerText(report), { parseMode: 'Markdown' });

  const blocks = (report.blocks || []).filter((b) => (b.findings || []).length);
  if (!blocks.length) {
    const sales = report.stats.salesCount ?? 0;
    const msg =
      sales === 0
        ? '📄 За цей період продажних дзвінків не було — оцінювати продажні навички нема на чому. Вище — числові показники.'
        : '✅ За цей період не знайдено повторюваних патернів (з ≥3 підтвердженими прикладами) — критичних системних проблем у продажах не зафіксовано. Вище — числові показники.';
    await sendLong(api, chatId, msg);
    await sendPhrases(api, chatId, report.phrases);
    return;
  }

  const multi = blocks.length > 1;
  for (const b of blocks) {
    if (multi) await sendLong(api, chatId, blockHeader(b));
    let idx = 0;
    for (const f of b.findings) {
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
  }

  await sendPhrases(api, chatId, report.phrases);
}

// Build + deliver one manager's report to one chat. segmented=true assembles from the frozen
// per-segment cache + a live tail (the daily flow); false = the legacy single live reduce
// (multi-day stats). audio=true cuts and attaches the clips.
async function deliverManagerReport(api, chatId, name, start, end, { audio = false, segmented = false } = {}) {
  const report = segmented
    ? await assembleReport(name, start, end)
    : await buildManagerEvidenceReport(name, start, end);
  if (!report) return { empty: true };
  const clips = audio ? await prepareClips(report) : null;
  await deliverReport(api, chatId, report, { clips });
  return { sent: true };
}

// Manual "Звіт зараз": today so far, every active manager, delivered to the requester (with audio).
// Uses the segmented path → reuses today's frozen scheduled segments + a deduped live tail, so a
// repeated click costs (almost) nothing. Does NOT touch the scheduler state.
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
        await deliverManagerReport(api, chatId, m.name, start, end, { audio: true, segmented: true });
      }
      return { sent: true };
    },
    { notice: '⏳ Бот формує доказовий звіт (аналіз + аудіо), це може зайняти деякий час…' }
  );
  if (res.empty) await api.sendMessage(chatId, 'За сьогодні ще немає оброблених дзвінків для звіту.');
  return res;
}

// Deliver one completed day-bounded segment [start, end] to every recipient. Builds the report
// (which computes+freezes the 'scheduled' segment via assembleReport) ONCE per manager, then fans
// out. A failed send to one recipient doesn't block others.
async function sendScheduledSlot(api, start, end) {
  const recipients = await getRecipients('report');
  if (recipients.length === 0) {
    console.warn('[bot] scheduled report: no recipients configured (Налаштування) - not sent');
    return;
  }
  const managers = await getActiveOperatorsInRange(start, end);
  for (const m of managers) {
    const report = await assembleReport(m.name, start, end);
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
}

let running = false;

// Day-bounded scheduler. On each tick, for each configured slot today whose time (+ grace) has
// passed and that hasn't been delivered yet, deliver the segment that closes at that slot
// ([previous boundary, slot]). The grace window lets late pending-call retries land before the
// segment is frozen; a slot that was missed (bot down) is still delivered when it comes back up.
async function maybeSendScheduledReport(api) {
  const now = new Date();
  const slots = await getReportTimes();
  if (!slots.length) return;
  if (running) return;

  const graceMs = Number(process.env.SEGMENT_GRACE_MIN || 10) * 60000;
  const { dateStr } = kyivParts(now);
  const daySegs = kyivDaySegments(now, slots);
  const delivered = await getDeliveredSlots();

  running = true;
  try {
    for (const hhmm of slots) {
      const seg = daySegs.find((s) => kyivParts(s.end).hhmm === hhmm);
      if (!seg) continue; // slot not a valid boundary today
      if (now.getTime() < seg.end.getTime() + graceMs) continue; // within grace → wait
      const slotKey = `${dateStr}-${hhmm}`;
      if (delivered.includes(slotKey)) continue;

      console.log(`[bot] scheduled slot ${slotKey}: ${seg.start.toISOString()} -> ${seg.end.toISOString()}`);
      await sendScheduledSlot(api, seg.start, seg.end);
      await markSlotDelivered(slotKey);
    }
    // GC ephemeral tails older than 2 days (scheduled segments are never removed).
    await deleteOldManualTails(new Date(Date.now() - 2 * 24 * 3600 * 1000)).catch(() => {});
  } finally {
    running = false;
  }
}

// Both the times and the recipients are read from the DB on every tick (managed in /settings), so
// the scheduler always runs — no env to configure. With no times/recipients set it simply skips.
function startScheduler(api) {
  console.log('[bot] report scheduler on (day-bounded segments, grace, times+recipients from /settings, Kyiv)');
  setInterval(() => {
    maybeSendScheduledReport(api).catch((e) => console.error(`[bot] scheduled report error: ${e.message}`));
  }, 30000);
}

export { buildManagerEvidenceReport, deliverManagerReport, sendManualReport, startScheduler };
