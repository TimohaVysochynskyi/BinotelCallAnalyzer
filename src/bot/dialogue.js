import { withRetry } from '../core/retry.js';

// Turns a raw (mono, single-channel, unlabelled) call transcript into a readable dialogue with
// "Менеджер:" / "Клієнт:" turns. The recording has no channel separation, so the model infers who
// speaks from context. It must NOT invent or reword content — only segment into turns, label them,
// and lightly fix punctuation/casing. Used on-demand when viewing a call in the archive.
const DIALOGUE_SYSTEM = `Тобі дано транскрипт телефонної розмови в автосервісі між МЕНЕДЖЕРОМ (працівник сервісу) і КЛІЄНТОМ. Запис моно, без розділення каналів, тому репліки не розмічені.

Подай цю саму розмову у форматі діалогу:
- Визнач, де говорить менеджер, а де клієнт, за змістом: менеджер вітає від імені сервісу, консультує, пропонує запис/послуги, називає ціни й дати; клієнт запитує, описує проблему авто, погоджується/відмовляється.
- Розбий суцільний текст на репліки. Кожну репліку почни з "Менеджер:" або "Клієнт:".
- НЕ вигадуй і не додавай інформацію, не змінюй зміст і слова. Дозволено лише легко виправити пунктуацію та великі літери для читабельності.
- Якщо фрагмент складно віднести впевнено — віднеси за найкращим здогадом, але НЕ пропускай текст.
- Зберігай мову оригіналу. Поверни ЛИШЕ діалог: кожна репліка з нового рядка, між репліками порожній рядок. Без вступів і підсумків.`;

async function formatDialogue(transcript) {
  const text = (transcript || '').trim();
  if (!text) return '(порожньо)';
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
            { role: 'system', content: DIALOGUE_SYSTEM },
            { role: 'user', content: text },
          ],
        }),
      });
      if (!res.ok) throw new Error(`OpenAI dialogue format failed: ${res.status} ${await res.text()}`);
      const data = await res.json();
      return data.choices[0].message.content;
    },
    { attempts: 3, delayMs: 2000, label: 'OpenAI dialogue format' }
  );
}

export { formatDialogue };
