import { withRetry } from './retry.js';

// ElevenLabs Speech-to-Text (Scribe): transcription + speaker diarization in ONE request.
// Endpoint: POST https://api.elevenlabs.io/v1/speech-to-text (auth header: xi-api-key).
// We build a ready-to-store "Менеджер:/Клієнт:" dialogue right here at ingest, so the archive can
// show it instantly with no extra request. Who is the manager vs the client isn't known from
// diarization (it only gives speaker_0/speaker_1), so a cheap LLM call maps speaker -> role;
// if that fails we fall back to the heuristic "first speaker = manager".
const STT_URL = 'https://api.elevenlabs.io/v1/speech-to-text';
const sttModel = () => process.env.ELEVENLABS_STT_MODEL || 'scribe_v1';
const numSpeakers = () => process.env.ELEVENLABS_NUM_SPEAKERS || '2'; // phone call = 2 parties

// Raw STT call. Returns the ElevenLabs JSON ({ text, words:[{text,type,speaker_id,...}], ... }).
async function sttDiarize(audioBlob) {
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) throw new Error('ELEVENLABS_API_KEY is not set');
  return withRetry(
    async () => {
      const form = new FormData();
      form.append('file', audioBlob, 'call.mp3');
      form.append('model_id', sttModel());
      form.append('diarize', 'true');
      form.append('num_speakers', numSpeakers());
      // CALL_LANGUAGE (uk/ru) forces the language; otherwise Scribe auto-detects (uk & ru are both
      // "excellent accuracy"), which also removes the old OpenAI uk-vs-ru re-transcription dance.
      if (process.env.CALL_LANGUAGE) form.append('language_code', process.env.CALL_LANGUAGE);

      const res = await fetch(STT_URL, {
        method: 'POST',
        headers: { 'xi-api-key': key },
        body: form,
      });
      if (!res.ok) throw new Error(`ElevenLabs STT failed: ${res.status} ${await res.text()}`);
      return res.json();
    },
    { attempts: 3, delayMs: 2000, label: 'ElevenLabs STT' }
  );
}

// Group the flat words[] into speaker turns. 'spacing' tokens carry the whitespace and have no
// speaker of their own, so they just extend the current turn; a real word with a different
// speaker_id starts a new turn.
function buildTurns(words) {
  const turns = [];
  let cur = null;
  for (const w of words || []) {
    const t = w.text ?? '';
    if (w.type === 'spacing') {
      if (cur) cur.text += t;
      continue;
    }
    const sid = w.speaker_id ?? (cur ? cur.speaker : 'speaker_0');
    if (!cur || cur.speaker !== sid) {
      if (cur) turns.push(cur);
      cur = { speaker: sid, text: t };
    } else {
      cur.text += t;
    }
  }
  if (cur) turns.push(cur);
  return turns.map((x) => ({ speaker: x.speaker, text: x.text.replace(/\s+/g, ' ').trim() })).filter((x) => x.text);
}

const ROLE_SCHEMA = {
  name: 'speaker_roles',
  strict: true,
  schema: {
    type: 'object',
    properties: {
      reasoning: { type: 'string' },
      manager: { type: 'string' },
      confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    },
    required: ['reasoning', 'manager', 'confidence'],
    additionalProperties: false,
  },
};

// Phrases the SERVICE OPERATOR (manager) uses far more than the client, uk + ru. Substring match,
// lowercased. Used as (a) the deterministic fallback when the LLM call fails and (b) a tie-breaker
// when the LLM is unsure — much more reliable than the old "first speaker = manager" guess.
const MANAGER_MARKERS = [
  'автосервіс', 'автосервис', 'сервіс', 'сервис', 'сто', 'наш майстер', 'майстер', 'мастер',
  'запиш', 'записати', 'запишу', 'запишемо', 'запис на', 'на яку годину', 'на яке авто', 'яка марка',
  'яке авто', 'яка машина', 'діагностик', 'диагностик', 'вартість', 'коштує', 'стоит', 'по ціні',
  'приїжджайте', 'приезжайте', 'підʼїжджайте', 'подъезжайте', 'чим можу допомогти', 'чем могу помочь',
  'передзвоню', 'перезвоню', 'уточню', 'вільн', 'свободн', 'гарного дня', 'працюємо до', 'гривень', 'грн',
  'у нас є', 'наша адреса', 'запчастин', 'запчаст',
];

// STRONGEST signal: the manager self-introduces by their known name (e.g. "Это Андрей вас
// беспокоит", "мене звати Андрій"). Works even when our manager is the CALLER acting like a
// customer (an outbound call to a supplier) — the content-role heuristics fail there, this doesn't.
// Returns the speaker id that self-introduces, or null. Exact (lowercased) match on the name — name
// spelling variants (Андрій/Андрей) are left to the LLM.
function selfIntroManager(turns, speakerIds, managerName) {
  const n = String(managerName || '').trim().toLowerCase();
  if (n.length < 3) return null;
  const patterns = [
    `це ${n}`, `это ${n}`, `мене звати ${n}`, `меня зовут ${n}`, `звати ${n}`, `зовут ${n}`,
    `${n} вас турбує`, `${n} вас беспокоит`, `${n} турбує`, `${n} беспокоит`,
    `${n} на зв`, `${n} на связи`, `це знову ${n}`, `это снова ${n}`,
  ];
  for (const t of turns) {
    const low = t.text.toLowerCase();
    if (patterns.some((p) => low.includes(p))) return t.speaker;
  }
  return null;
}

// Score each speaker by how many operator-markers their lines contain; the highest = manager.
// Returns null when nobody used any marker (no signal to decide on).
function heuristicManager(turns, speakerIds) {
  const score = Object.fromEntries(speakerIds.map((s) => [s, 0]));
  for (const t of turns) {
    const low = t.text.toLowerCase();
    for (const m of MANAGER_MARKERS) if (low.includes(m)) score[t.speaker] += 1;
  }
  let best = null;
  let bestScore = 0;
  for (const sid of speakerIds) {
    if (score[sid] > bestScore) {
      bestScore = score[sid];
      best = sid;
    }
  }
  return best; // null when all scores are 0
}

// Decide which speaker id is OUR MANAGER. The goal is to find our specific employee, NOT "whoever
// plays the service-operator role" — on an outbound call our manager is the caller and sounds like
// a customer, so role-based guessing flips. Layers, most-reliable first:
//   1) self-introduction by the known manager name (deterministic) — e.g. "Это Андрей вас беспокоит";
//   2) LLM over the WHOLE dialogue, framed as "which speaker is our employee «<name>»" when we know
//      the name, else "who is the service operator";
//   3) keyword heuristic (operator markers) then first speaker as last resorts.
async function pickManagerSpeaker(turns, speakerIds, managerName) {
  const intro = selfIntroManager(turns, speakerIds, managerName);
  if (intro) {
    console.log(`[elevenlabs] manager by self-introduction ("${managerName}") → ${intro}`);
    return intro;
  }

  const keyword = heuristicManager(turns, speakerIds);

  const MAX_CHARS = 8000;
  let body = '';
  for (const t of turns) {
    const line = `[${t.speaker}] ${t.text}\n`;
    if (body.length + line.length > MAX_CHARS) break;
    body += line;
  }

  const system = managerName
    ? `Ти аналізуєш транскрипт телефонної розмови автосервісу (СТО). Учасники: ${speakerIds.join(', ')}. ` +
      `Один із них — НАШ працівник на імʼя «${managerName}» (враховуй варіанти написання: Андрій/Андрей, Володимир/Владимир тощо). Визнач, ХТО з мовців — це «${managerName}».\n` +
      `Найнадійніше — САМОПРЕДСТАВЛЕННЯ цим імʼям ("це ${managerName}", "мене звати ${managerName}", "${managerName} вас турбує/беспокоит"): тоді ЦЕЙ мовець і є наш працівник — навіть якщо він сам комусь телефонує й звучить як замовник.\n` +
      `Якщо імені в розмові немає: наш працівник — той, хто поводиться як працівник СТО (вітає від сервісу, консультує клієнта, пропонує запис/ціни/майстра); АБО, якщо це ВИХІДНИЙ дзвінок (наш працівник сам телефонує постачальнику/іншому сервісу), наш працівник — той, хто телефонує й пояснює свою потребу, а НЕ той, хто підняв слухавку ("алло").\n` +
      `Поверни JSON: reasoning (1-2 речення), manager (рівно один id: ${speakerIds.join(', ')}), confidence.`
    : `Ти аналізуєш транскрипт телефонної розмови автосервісу (СТО). Учасники: ${speakerIds.join(', ')}. ` +
      `Рівно один із них — працівник СТО (МЕНЕДЖЕР), решта — КЛІЄНТ.\n` +
      `Ознаки МЕНЕДЖЕРА: вітається від імені сервісу; питає марку/проблему авто; пропонує запис, ціни, майстра.\n` +
      `Ознаки КЛІЄНТА: описує СВОЮ проблему ("у мене стукає"), питає ціну, погоджується/відмовляється.\n` +
      `Аналізуй ВЕСЬ діалог — клієнт міг заговорити першим ("алло?").\n` +
      `Поверни JSON: reasoning (1-2 речення), manager (рівно один id: ${speakerIds.join(', ')}), confidence.`;

  try {
    const out = await withRetry(
      async () => {
        const res = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: process.env.OPENAI_ANALYZE_MODEL || 'gpt-4o-mini',
            messages: [
              { role: 'system', content: system },
              { role: 'user', content: body },
            ],
            response_format: { type: 'json_schema', json_schema: ROLE_SCHEMA },
          }),
        });
        if (!res.ok) throw new Error(`OpenAI speaker role failed: ${res.status} ${await res.text()}`);
        return JSON.parse((await res.json()).choices[0].message.content);
      },
      { attempts: 2, delayMs: 1000, label: 'OpenAI speaker role' }
    );

    if (!speakerIds.includes(out.manager)) return keyword ?? turns[0].speaker;
    // Without a name to anchor on, a low-confidence answer that contradicts a clear operator-marker
    // signal is overridden by the heuristic.
    if (!managerName && out.confidence === 'low' && keyword && keyword !== out.manager) {
      console.log(`[elevenlabs] low-confidence role (LLM=${out.manager}, keyword=${keyword}) → using keyword heuristic`);
      return keyword;
    }
    return out.manager;
  } catch (err) {
    console.error(`[elevenlabs] role labeling failed, using keyword heuristic: ${err.message}`);
    return keyword ?? turns[0].speaker;
  }
}

// Full pipeline: STT + diarize -> "Менеджер:/Клієнт:" dialogue string ready to store. managerName
// (when known from Binotel) anchors role detection on our specific employee. If only one speaker is
// detected (voicemail / IVR) there's no dialogue to build, so the plain text is returned.
async function transcribeDiarized(audioBlob, managerName) {
  const data = await sttDiarize(audioBlob);
  const plain = (data.text || '').trim();
  const turns = buildTurns(data.words);
  if (turns.length === 0) return plain || '(порожньо)';

  const speakerIds = [...new Set(turns.map((t) => t.speaker))];
  if (speakerIds.length < 2) return plain || turns.map((t) => t.text).join(' ');

  const managerId = await pickManagerSpeaker(turns, speakerIds, managerName);
  const label = (sid) => (sid === managerId ? 'Менеджер' : 'Клієнт');
  return turns.map((t) => `${label(t.speaker)}: ${t.text}`).join('\n\n');
}

export { transcribeDiarized, sttDiarize, buildTurns, heuristicManager };
