import { withRetry } from '../core/retry.js';
import { findQuote } from '../core/quoteMatch.js';
import {
  getStoredAnalyzePrompt,
  setStoredAnalyzePrompt,
  clearStoredAnalyzePrompt,
} from '../core/store.js';

// ============================================================================================
// REDUCE step of the evidence-first report pipeline.
//
// The per-call MAP (src/core/analyzeCall.js) already tagged each call's manager behaviours with
// VERBATIM, code-verified quotes (+ timecodes), cached in calls.behaviors. Here we only AGGREGATE
// those cached behaviours for a period into a few evidence-backed findings — no transcript is
// re-analysed, so day/week/month/quarter reports are cheap and consistent.
//
// Hard rules the CODE enforces regardless of the (tunable) guidance prompt:
//   • the model may reference evidence ONLY by id from the candidate list we give it → it cannot
//     invent a quote;
//   • every referenced quote is re-verified against its call's segments (findQuote) → paraphrased /
//     mismatched quotes are dropped;
//   • one quote can back only ONE finding (no duplicate evidence across findings);
//   • a finding with < MIN_EVIDENCE verified quotes is dropped entirely.
// "Готові формулювання" are authored by the model as IDEAL phrasings — NEVER copied from transcripts
// (so ASR/surzhyk artefacts can't leak in).
// ============================================================================================

const MIN_EVIDENCE = 3;
const reduceModel = () => process.env.OPENAI_REPORT_MODEL || 'gpt-4o';

// The tunable GUIDANCE (owner edits it via /prompt). It shapes tone/wording of claim/why/action and
// the recommended phrases — it does NOT control structure or the evidence rules (code does). Stored
// in app_state.analyze_prompt; the legacy prose prompt is reset once by migrate().
const DEFAULT_REPORT_GUIDANCE = `Ти — вимогливий аналітик відділу продажів автосервісу (СТО). Оцінюєш роботу менеджера на дзвінках.
Успіх дзвінка = клієнт записаний на сервіс або підтвердив дату приїзду.

Пиши БЕЗ води: жодних вступів, компліментів, загальних характеристик. Кожне твердження — конкретна поведінка менеджера, а не абстракція.

Для кожного finding:
- claim: одне конкретне твердження про повторювану поведінку (що САМЕ менеджер робить/не робить).
- why_hurts_booking: чому це коштує записів клієнтів (для помилок) або чому це допомагає записувати (для сильних сторін) — коротко, по суті.
- action: рівно одна конкретна дія, що змінити (для помилок) або що масштабувати (для сильних сторін).
Групуй лише ПОВТОРЮВАНІ патерни (щонайменше 3 різні приклади). Разові випадки не включай.

recommended_phrases: 5-7 готових ІДЕАЛЬНИХ формулювань для типових ситуацій цього менеджера (заперечення «дорого»/«подумаю»/«зроблю в іншому місці», момент закриття та фіксації дати запису, уточнення проблеми авто). Це ЗРАЗКИ від тебе — НЕ цитати з транскриптів.`;

// Effective guidance = owner's custom text (app_state) or the built-in default. (Function names are
// kept as *AnalyzePrompt* so the existing /prompt UI wiring in prompt.js / index.js is unchanged.)
async function getAnalyzePrompt() {
  return (await getStoredAnalyzePrompt()) || DEFAULT_REPORT_GUIDANCE;
}

async function getAnalyzePromptInfo() {
  const custom = await getStoredAnalyzePrompt();
  return { prompt: custom || DEFAULT_REPORT_GUIDANCE, isCustom: Boolean(custom) };
}

async function setAnalyzePrompt(text) {
  await setStoredAnalyzePrompt(text);
}

async function resetAnalyzePrompt() {
  await clearStoredAnalyzePrompt();
}

const FINDINGS_SCHEMA = {
  name: 'evidence_findings',
  strict: true,
  schema: {
    type: 'object',
    properties: {
      findings: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            type: { type: 'string', enum: ['strength', 'error'] },
            claim: { type: 'string' },
            why_hurts_booking: { type: 'string' },
            action: { type: 'string' },
            evidence_ids: { type: 'array', items: { type: 'string' } },
          },
          required: ['type', 'claim', 'why_hurts_booking', 'action', 'evidence_ids'],
          additionalProperties: false,
        },
      },
      recommended_phrases: { type: 'array', items: { type: 'string' } },
    },
    required: ['findings', 'recommended_phrases'],
    additionalProperties: false,
  },
};

// Second-pass relevance check: for each finding, which of its (already existence-verified) quotes
// ACTUALLY demonstrate the claim. Kills the "quote exists but is unrelated" failure the existence
// check alone can't catch.
const RELEVANCE_SCHEMA = {
  name: 'evidence_relevance',
  strict: true,
  schema: {
    type: 'object',
    properties: {
      findings: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            index: { type: 'integer' },
            supporting: { type: 'array', items: { type: 'integer' } },
          },
          required: ['index', 'supporting'],
          additionalProperties: false,
        },
      },
    },
    required: ['findings'],
    additionalProperties: false,
  },
};

// Flatten every call's cached behaviours into a candidate pool with stable ids ("e0","e1",…). Keeps
// the source call + timecode so verification/audio can resolve back to the exact spot. Non-sales
// calls (call_purpose 'info'/'other') are skipped entirely so a routine status update never becomes
// a "sales mistake" finding. (NULL purpose = not yet analysed → included for backward-compat.)
function buildCandidates(calls) {
  const candidates = [];
  const byId = new Map();
  calls.forEach((c) => {
    if (c.callPurpose === 'info' || c.callPurpose === 'other') return;
    const items = c.behaviors?.items || [];
    items.forEach((it) => {
      if (!it?.quote) return;
      const id = `e${candidates.length}`;
      const cand = {
        id,
        callId: c.generalCallId,
        startTime: c.startTime,
        segments: c.segments || null,
        type: it.type === 'strength' ? 'strength' : 'error',
        stage: it.stage || 'інше',
        label: it.label || '',
        quote: it.quote,
        start: it.start ?? null,
        end: it.end ?? null,
        segIndex: it.segIndex ?? null,
      };
      candidates.push(cand);
      byId.set(id, cand);
    });
  });
  return { candidates, byId };
}

// One candidate rendered for the model: [e3] (error/закриття) label | "quote"
function renderCandidate(c) {
  return `[${c.id}] (${c.type}/${c.stage}) ${c.label} | "${c.quote}"`;
}

// Re-verify a candidate's quote against its own call's segments (defensive; also refreshes the
// timecode used for audio). Calls without segments (OpenAI fallback) were already verified at map
// time, so keep them (no timecode → no clip). Returns the evidence object or null.
function verifyCandidate(c) {
  if (Array.isArray(c.segments) && c.segments.length) {
    const hit = findQuote(c.segments, c.quote, { requireRole: 'manager' });
    if (!hit) return null;
    return { callId: c.callId, startTime: c.startTime, quote: c.quote, start: hit.start, end: hit.end };
  }
  // No segments to check against: trust the map-time verification, but require a non-trivial quote.
  if (String(c.quote).trim().length < 3) return null;
  return { callId: c.callId, startTime: c.startTime, quote: c.quote, start: null, end: null };
}

// PURE, code-enforced evidence rules (no LLM/DB) — the guarantee against fabricated/duplicated/
// unsupported findings. Exported so it can be unit-tested directly. Given the model's raw findings
// (which reference evidence only by candidate id) and the period's calls, it:
//   • resolves each id to its cached behaviour candidate (unknown ids dropped);
//   • drops evidence whose type ≠ the finding's type;
//   • re-verifies each quote against its call's segments (findQuote) — paraphrased/mismatched dropped;
//   • lets one quote back only ONE finding (global dedup);
//   • drops any finding left with < MIN_EVIDENCE verified evidence;
//   • orders errors before strengths (audio evidence attaches to errors).
function assembleFindings(rawFindings, calls) {
  const { byId } = buildCandidates(calls);
  const usedIds = new Set();
  const findings = [];
  for (const f of rawFindings || []) {
    const type = f.type === 'strength' ? 'strength' : 'error';
    const evidence = [];
    for (const id of f.evidence_ids || []) {
      if (usedIds.has(id)) continue;
      const cand = byId.get(id);
      if (!cand || cand.type !== type) continue;
      const ev = verifyCandidate(cand);
      if (!ev) continue;
      usedIds.add(id);
      evidence.push(ev);
    }
    if (evidence.length < MIN_EVIDENCE) continue;
    findings.push({
      type,
      claim: String(f.claim || '').trim(),
      why: String(f.why_hurts_booking || '').trim(),
      action: String(f.action || '').trim(),
      evidence,
    });
  }
  findings.sort((a, b) => (a.type === b.type ? 0 : a.type === 'error' ? -1 : 1));
  return findings;
}

// Relevance verification (LLM). Given assembled findings (each already has >= MIN_EVIDENCE existing
// manager quotes), ask a strict reviewer which quotes REALLY demonstrate each claim; keep only those,
// and drop a finding that falls below MIN_EVIDENCE. On any API failure, fall back to the assembled
// findings unchanged (don't nuke the whole report over a transient error). Pure filtering — never
// invents or edits text.
async function verifyFindingsRelevance(findings) {
  if (!findings.length) return findings;

  const payload = findings.map((f, fi) => ({
    index: fi,
    type: f.type,
    claim: f.claim,
    evidence: f.evidence.map((e, ei) => ({ i: ei, quote: e.quote })),
  }));

  const system =
    `Ти суворий рецензент доказів у звіті про роботу менеджера автосервісу. Для КОЖНОГО finding дано ` +
    `твердження (claim) і пронумеровані цитати з реплік менеджера.\n` +
    `Визнач, які цитати САМІ ПО СОБІ доводять саме це твердження. Цитата, що нейтральна, загальна, ` +
    `не про те, або лише побічно стосується, — НЕ підтверджує (не включай її).\n` +
    `Будь суворим: краще менше, ніж притягнуте за вуха. Поверни для кожного finding його index і ` +
    `масив "supporting" — індекси (i) цитат, що справді підтверджують claim.`;

  let out;
  try {
    out = await withRetry(
      async () => {
        const res = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: reduceModel(),
            messages: [
              { role: 'system', content: system },
              { role: 'user', content: JSON.stringify(payload) },
            ],
            response_format: { type: 'json_schema', json_schema: RELEVANCE_SCHEMA },
          }),
        });
        if (!res.ok) throw new Error(`OpenAI relevance verify failed: ${res.status} ${await res.text()}`);
        return JSON.parse((await res.json()).choices[0].message.content);
      },
      { attempts: 2, delayMs: 1500, label: 'OpenAI relevance verify' }
    );
  } catch (err) {
    console.error(`[analyze] relevance verify failed, keeping assembled findings: ${err.message}`);
    return findings;
  }

  const supMap = new Map((out.findings || []).map((r) => [r.index, new Set(r.supporting || [])]));
  const kept = [];
  findings.forEach((f, fi) => {
    const sup = supMap.get(fi);
    if (!sup) return; // finding the reviewer didn't confirm → drop (strict)
    const evidence = f.evidence.filter((_, ei) => sup.has(ei));
    if (evidence.length < MIN_EVIDENCE) return;
    kept.push({ ...f, evidence });
  });
  return kept;
}

// calls: rows from store.getCallsForReport (with cached behaviors + segments). stats: numeric block
// from store.getOperatorStats. Returns { findings, phrases } where each finding has >= MIN_EVIDENCE
// verified, distinct evidence and findings are ordered errors-first.
async function reduceFindings(managerName, calls, stats) {
  const { candidates } = buildCandidates(calls);
  if (candidates.length < MIN_EVIDENCE) {
    return { findings: [], phrases: [] };
  }

  const rate = stats.callCount ? Math.round((stats.successCount / stats.callCount) * 100) : 0;
  const metricsLine =
    `Менеджер: ${managerName}. Дзвінків: ${stats.callCount}, записів/успішних: ${stats.successCount} ` +
    `(конверсія ${rate}%), середній бал: ${stats.avgScore ?? '—'}, найчастіший слабкий етап: ${stats.topWeakStage ?? '—'}.`;

  const guidance = await getAnalyzePrompt();
  const system =
    `${guidance}\n\n` +
    `ФОРМАТ РОБОТИ (обовʼязково):\n` +
    `Тобі дано МЕТРИКИ за період і СПИСОК КАНДИДАТІВ — це вже витягнуті з реальних дзвінків поведінки менеджера з дослівними цитатами, кожна має id.\n` +
    `Згрупуй кандидатів у findings. У кожному finding поле evidence_ids — це id кандидатів (мінімум ${MIN_EVIDENCE}), що підтверджують саме це твердження. Усі докази в одному finding мають бути одного type, що й finding.\n` +
    `Використовуй ТІЛЬКИ id зі списку. НЕ вигадуй цитат і НЕ пиши цитати в тексті — цитати підставить система за id.\n` +
    `Не додавай finding, якщо для нього немає щонайменше ${MIN_EVIDENCE} доказів. Один id не використовуй у двох findings.`;

  const user =
    `${metricsLine}\n\nКАНДИДАТИ:\n` +
    candidates.map(renderCandidate).join('\n');

  const raw = await withRetry(
    async () => {
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: reduceModel(),
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
          response_format: { type: 'json_schema', json_schema: FINDINGS_SCHEMA },
        }),
      });
      if (!res.ok) throw new Error(`OpenAI reduce failed: ${res.status} ${await res.text()}`);
      return JSON.parse((await res.json()).choices[0].message.content);
    },
    { attempts: 2, delayMs: 2000, label: `OpenAI reduce ${managerName}` }
  );

  // Code-enforced evidence rules (pure, testable) — anti-fabrication / anti-dup / manager-role.
  const assembled = assembleFindings(raw.findings, calls);
  // Then an LLM relevance pass — drop quotes that don't actually demonstrate the claim.
  const findings = await verifyFindingsRelevance(assembled);
  const phrases = (raw.recommended_phrases || []).map((p) => String(p).trim()).filter(Boolean);
  return { findings, phrases };
}

export {
  reduceFindings,
  assembleFindings,
  MIN_EVIDENCE,
  DEFAULT_REPORT_GUIDANCE,
  getAnalyzePrompt,
  getAnalyzePromptInfo,
  setAnalyzePrompt,
  resetAnalyzePrompt,
};
