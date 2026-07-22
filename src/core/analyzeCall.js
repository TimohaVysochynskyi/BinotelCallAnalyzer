import { withRetry } from './retry.js';
import { findQuote } from './quoteMatch.js';

// Per-call "MAP" step of the evidence-first report pipeline. Runs ONCE per call at ingest (cheap
// model) and the result is cached in calls.behaviors, so per-period reports only aggregate stored
// data (the "REDUCE" in src/bot/analyze.js) instead of re-analysing transcripts every time.
//
// The model tags the MANAGER's behaviours in this one call — strengths and errors — each with a
// VERBATIM quote of a manager line. Then CODE locates every quote in the call's timecoded segments
// (findQuote): a quote that can't be located is dropped (guards against fabrication/paraphrase), and
// a located quote gets its {start,end} so the report can later cut an audio clip around it.

const ANALYSIS_VERSION = 2;
const MAX_ITEMS = 8; // bound noise/cost; the reduce only needs recurring patterns, not everything
const model = () => process.env.OPENAI_ANALYZE_MODEL || 'gpt-4o-mini';

const BEHAVIOR_STAGES = [
  'встановлення контакту',
  'виявлення потреби',
  'консультація / презентація',
  'робота із запереченнями',
  'допродаж',
  'закриття (фіксація запису)',
  'інше',
];

// Purpose of the call, decided first. Only 'sales' calls feed the sales-effectiveness report;
// 'info'/'other' calls contribute NO behaviours (so a routine status update never becomes a
// "sales mistake"). The purpose is also stored per call (calls.call_purpose) for the report's
// sales-vs-info numeric breakdown.
const CALL_PURPOSES = ['sales', 'info', 'other'];

const SYSTEM_PROMPT = `Контекст: менеджер автосервісу (СТО) веде телефонну розмову.

КРОК 1 — визнач ТИП дзвінка (callPurpose):
- "sales" — Є можливість залучити/записати клієнта чи продати: вхідний запит про послугу/ціну, новий клієнт із проблемою авто, заперечення, допродаж, спроба записати на сервіс.
- "info" — НЕМАЄ продажної можливості: менеджер лише інформує про статус уже наявного замовлення ("машина готова", "буде готово завтра", "вартість вийшла така"), підтверджує вже наявний запис, або клієнт дзвонить уточнити статус своєї машини. Звичайна сервісна/інформаційна розмова.
- "other" — службовий/помилковий/спам/не по темі.

КРОК 2 — поведінки менеджера (items):
- Якщо callPurpose НЕ "sales" → поверни items ПОРОЖНІМ. Не оцінюй продажні навички на інформаційному дзвінку.
- Якщо "sales" → виділи КОНКРЕТНІ поведінки САМЕ МЕНЕДЖЕРА (сильні й слабкі), кожну з ДОСЛІВНОЮ цитатою.

Суворі правила для items (лише для sales-дзвінків):
- Аналізуй ЛИШЕ репліки менеджера (не клієнта).
- "quote" = рівно один рядок МЕНЕДЖЕРА, СКОПІЙОВАНИЙ ДОСЛІВНО (той самий текст, без переказу/перекладу/виправлень).
- Цитата має САМА ПО СОБІ демонструвати цю поведінку. Якщо рядок нейтральний, загальний або лише побічно стосується — НЕ додавай його. Краще 0 поведінок, ніж притягнута за вуха.
- type: "strength" або "error". label: коротка назва (3-6 слів). stage: етап зі списку.
- Не вигадуй. Не більше 8 поведінок. Для короткого/тривіального дзвінка їх може бути 0.`;

const SCHEMA = {
  name: 'call_behaviors',
  strict: true,
  schema: {
    type: 'object',
    properties: {
      callPurpose: { type: 'string', enum: CALL_PURPOSES },
      items: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            type: { type: 'string', enum: ['strength', 'error'] },
            stage: { type: 'string', enum: BEHAVIOR_STAGES },
            label: { type: 'string' },
            quote: { type: 'string' },
          },
          required: ['type', 'stage', 'label', 'quote'],
          additionalProperties: false,
        },
      },
    },
    required: ['callPurpose', 'items'],
    additionalProperties: false,
  },
};

// When a call has no diarized segments (OpenAI fallback path), build verification-only pseudo
// segments from the plain transcript so quotes can still be validated (no timecodes → no audio).
function pseudoSegments(transcript) {
  const text = String(transcript || '');
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const out = [];
  for (const l of lines) {
    const m = /^(Менеджер|Клієнт|Клиент|Оператор)\s*:\s*(.*)$/i.exec(l);
    if (m) out.push({ role: /менеджер|оператор/i.test(m[1]) ? 'manager' : 'client', text: m[2], start: null, end: null });
    else out.push({ role: 'manager', text: l, start: null, end: null });
  }
  if (out.length === 0 && text.trim()) out.push({ role: 'manager', text: text.trim(), start: null, end: null });
  return out;
}

// Returns { version, callPurpose, items:[{type,stage,label,quote,start,end,segIndex}] }.
// callPurpose gates everything: only 'sales' calls get behaviours (info/other → items:[]). segments
// (from ElevenLabs) carry timecodes; when null we verify against the transcript instead (items kept,
// but start/end stay null so no audio clip is produced). A quote is accepted ONLY if it's found in a
// MANAGER segment (requireRole) — a client line can't be mislabelled as a manager behaviour.
async function analyzeCallBehaviors(transcript, segments, managerName) {
  const verifySegments = Array.isArray(segments) && segments.length ? segments : pseudoSegments(transcript);
  if (!transcript || !verifySegments.length) return { version: ANALYSIS_VERSION, callPurpose: 'other', items: [] };

  const raw = await withRetry(
    async () => {
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: model(),
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            {
              role: 'user',
              content: `${managerName ? `Менеджер: ${managerName}\n\n` : ''}Транскрипт:\n${transcript}`,
            },
          ],
          response_format: { type: 'json_schema', json_schema: SCHEMA },
        }),
      });
      if (!res.ok) throw new Error(`OpenAI call-behaviors failed: ${res.status} ${await res.text()}`);
      return JSON.parse((await res.json()).choices[0].message.content);
    },
    { attempts: 2, delayMs: 1500, label: 'OpenAI call behaviors' }
  );

  const callPurpose = CALL_PURPOSES.includes(raw.callPurpose) ? raw.callPurpose : 'other';
  // Non-sales calls contribute no behaviours to the sales-effectiveness report.
  if (callPurpose !== 'sales') return { version: ANALYSIS_VERSION, callPurpose, items: [] };

  const items = [];
  for (const it of (raw.items || []).slice(0, MAX_ITEMS)) {
    if (!it?.quote) continue;
    // Accept only if the quote is a real MANAGER line (anti-fabrication + anti-misattribution).
    // A located quote carries its timecode for later audio clipping.
    const hit = findQuote(verifySegments, it.quote, { requireRole: 'manager' });
    if (!hit) continue;
    items.push({
      type: it.type === 'strength' ? 'strength' : 'error',
      stage: it.stage || 'інше',
      label: String(it.label || '').trim(),
      quote: it.quote.trim(),
      start: hit.start,
      end: hit.end,
      segIndex: hit.segIndex,
    });
  }
  return { version: ANALYSIS_VERSION, callPurpose, items };
}

export { analyzeCallBehaviors, ANALYSIS_VERSION, BEHAVIOR_STAGES, CALL_PURPOSES };
