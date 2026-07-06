const { withRetry } = require('./retry');

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
  console.log(`[transcribe] downloaded ${audioBlob.size} bytes, sending to OpenAI...`);

  const text = await withRetry(
    async () => {
      const form = new FormData();
      form.append('file', audioBlob, 'call.mp3');
      form.append('model', process.env.OPENAI_TRANSCRIBE_MODEL || 'gpt-4o-mini-transcribe');
      if (process.env.CALL_LANGUAGE) {
        form.append('language', process.env.CALL_LANGUAGE);
      }

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
    { attempts: 3, delayMs: 2000, label: 'OpenAI transcription' }
  );

  console.log(`[transcribe] received ${text.length} chars`);
  return text;
}

module.exports = { transcribeAudio };
