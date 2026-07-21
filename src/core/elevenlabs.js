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
    properties: { manager: { type: 'string' } },
    required: ['manager'],
    additionalProperties: false,
  },
};

// Ask the model which speaker id is the auto-service MANAGER. Cheap (a short sample + one id back).
// Falls back to "first speaker = manager" on any failure.
async function pickManagerSpeaker(turns, speakerIds) {
  const sample = turns.slice(0, 14).map((t) => `[${t.speaker}] ${t.text}`).join('\n');
  const system =
    `Це діалог телефонної розмови автосервісу. Мовці позначені: ${speakerIds.join(', ')}. ` +
    `Визнач, який із них МЕНЕДЖЕР (працівник автосервісу: вітає від імені сервісу, консультує, ` +
    `пропонує запис/послуги, називає ціни й дати), а не клієнт. ` +
    `Поверни JSON {"manager":"<id>"} рівно з одним зі значень: ${speakerIds.join(', ')}.`;
  try {
    const manager = await withRetry(
      async () => {
        const res = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: process.env.OPENAI_ANALYZE_MODEL || 'gpt-4o-mini',
            messages: [
              { role: 'system', content: system },
              { role: 'user', content: sample },
            ],
            response_format: { type: 'json_schema', json_schema: ROLE_SCHEMA },
          }),
        });
        if (!res.ok) throw new Error(`OpenAI speaker role failed: ${res.status} ${await res.text()}`);
        const data = await res.json();
        return JSON.parse(data.choices[0].message.content).manager;
      },
      { attempts: 2, delayMs: 1000, label: 'OpenAI speaker role' }
    );
    return speakerIds.includes(manager) ? manager : turns[0].speaker;
  } catch (err) {
    console.error(`[elevenlabs] role labeling failed, first speaker = manager: ${err.message}`);
    return turns[0].speaker; // heuristic fallback
  }
}

// Full pipeline: STT + diarize -> "Менеджер:/Клієнт:" dialogue string ready to store. If only one
// speaker is detected (voicemail / IVR) there is no dialogue to build, so the plain text is returned.
async function transcribeDiarized(audioBlob) {
  const data = await sttDiarize(audioBlob);
  const plain = (data.text || '').trim();
  const turns = buildTurns(data.words);
  if (turns.length === 0) return plain || '(порожньо)';

  const speakerIds = [...new Set(turns.map((t) => t.speaker))];
  if (speakerIds.length < 2) return plain || turns.map((t) => t.text).join(' ');

  const managerId = await pickManagerSpeaker(turns, speakerIds);
  const label = (sid) => (sid === managerId ? 'Менеджер' : 'Клієнт');
  return turns.map((t) => `${label(t.speaker)}: ${t.text}`).join('\n\n');
}

export { transcribeDiarized, sttDiarize, buildTurns };
