import { withRetry } from './retry.js';
import { transcribeDiarized } from './elevenlabs.js';

// Business is a Ukrainian auto-service. Ukrainian phone speech is full of dialect/surzhyk
// ("да" замість "так", "шо", "тіки"), which the ASR often mislabels as Russian and writes in
// Russian. So: transcribe with a Ukrainian-leaning prompt, then detect what was ACTUALLY
// spoken vs what got written, and re-transcribe with the correct language forced if they
// disagree. CALL_LANGUAGE, if set, forces a language and skips detection entirely.
const PROMPTS = {
  uk: 'Це телефонна розмова автосервісу українською мовою. Часто трапляються розмовні форми та суржик (напр. "да", "шо", "тіки", "нема") — це все українська мова, транскрибуй українською.',
  ru: 'Это телефонный разговор автосервиса на русском языке.',
};
const DEFAULT_PROMPT = PROMPTS.uk;

async function transcribeOnce(audioBlob, { language, prompt } = {}) {
  return withRetry(
    async () => {
      const form = new FormData();
      form.append('file', audioBlob, 'call.mp3');
      form.append('model', process.env.OPENAI_TRANSCRIBE_MODEL || 'gpt-4o-mini-transcribe');
      if (language) form.append('language', language);
      if (prompt) form.append('prompt', prompt);

      const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
        body: form,
      });
      if (!res.ok) {
        throw new Error(`OpenAI transcription failed: ${res.status} ${await res.text()}`);
      }
      const data = await res.json();
      return data.text;
    },
    { attempts: 3, delayMs: 2000, label: `OpenAI transcription${language ? ` (${language})` : ''}` }
  );
}

const DETECT_SCHEMA = {
  name: 'lang_detect',
  strict: true,
  schema: {
    type: 'object',
    properties: {
      spoken: { type: 'string', enum: ['uk', 'ru', 'other'] },
      transcriptLanguage: { type: 'string', enum: ['uk', 'ru', 'other'] },
    },
    required: ['spoken', 'transcriptLanguage'],
    additionalProperties: false,
  },
};

const DETECT_SYSTEM = `Проаналізуй транскрипт телефонної розмови й поверни дві мови:
1) spoken — якою мовою РЕАЛЬНО розмовляють люди. Українська розмовна з діалектизмами/суржиком (наприклад "да" замість "так", "шо", "тіки", "нема", "трошки") — це УКРАЇНСЬКА (uk), НЕ російська. Російська — лише коли лексика й граматика справді російські. Інакше — other.
2) transcriptLanguage — якою мовою фактично НАПИСАНО наведений текст (uk / ru / other).

Приклад: людина говорить українською з суржиком, але текст записано російськими словами → spoken="uk", transcriptLanguage="ru".`;

async function detectLanguages(text) {
  return withRetry(
    async () => {
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: process.env.OPENAI_ANALYZE_MODEL || 'gpt-4o-mini',
          messages: [
            { role: 'system', content: DETECT_SYSTEM },
            { role: 'user', content: text.slice(0, 4000) },
          ],
          response_format: { type: 'json_schema', json_schema: DETECT_SCHEMA },
        }),
      });
      if (!res.ok) {
        throw new Error(`OpenAI language detection failed: ${res.status} ${await res.text()}`);
      }
      const data = await res.json();
      return JSON.parse(data.choices[0].message.content);
    },
    { attempts: 2, delayMs: 1000, label: 'OpenAI language detection' }
  );
}

async function transcribeAudio(audioUrl) {
  const audioBlob = await withRetry(
    async () => {
      console.log(`[transcribe] downloading recording from ${audioUrl}`);
      const res = await fetch(audioUrl);
      if (!res.ok) throw new Error(`Failed to download recording: ${res.status}`);
      return res.blob();
    },
    { attempts: 3, delayMs: 1000, label: 'download recording' }
  );
  console.log(`[transcribe] downloaded ${audioBlob.size} bytes`);

  // Primary path: ElevenLabs (Scribe) — transcription + speaker diarization in one call, returning
  // a ready "Менеджер:/Клієнт:" dialogue that the archive shows instantly (no second request). If
  // it fails (no key / API error / quota), fall through to the OpenAI path below so no call is lost.
  if (process.env.ELEVENLABS_API_KEY) {
    try {
      const dialogue = await transcribeDiarized(audioBlob);
      console.log(`[transcribe] ElevenLabs OK — ${dialogue.length} chars (diarized)`);
      return dialogue;
    } catch (err) {
      console.error(`[transcribe] ElevenLabs failed, falling back to OpenAI: ${err.message}`);
    }
  }

  console.log('[transcribe] transcribing via OpenAI (plain, no diarization)...');

  // Explicit override: force a language, skip detection.
  const forced = process.env.CALL_LANGUAGE;
  if (forced) {
    const text = await transcribeOnce(audioBlob, { language: forced, prompt: PROMPTS[forced] });
    console.log(`[transcribe] received ${text.length} chars (forced ${forced})`);
    return text;
  }

  // Pass 1: Ukrainian-leaning transcription.
  let text = await transcribeOnce(audioBlob, { prompt: DEFAULT_PROMPT });

  // Detect spoken vs written language; re-transcribe if they disagree (the uk-said-as-ru case).
  try {
    const { spoken, transcriptLanguage } = await detectLanguages(text);
    console.log(`[transcribe] detected spoken=${spoken}, transcript=${transcriptLanguage}`);
    if ((spoken === 'uk' || spoken === 'ru') && transcriptLanguage !== spoken) {
      console.log(`[transcribe] mismatch - re-transcribing forced ${spoken}`);
      text = await transcribeOnce(audioBlob, { language: spoken, prompt: PROMPTS[spoken] });
    }
  } catch (err) {
    console.error(`[transcribe] language detection skipped: ${err.message}`);
  }

  console.log(`[transcribe] received ${text.length} chars`);
  return text;
}

export { transcribeAudio };
