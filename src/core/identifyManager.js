import { withRetry } from './retry.js';

// Shared handsets (901/902) don't tell Binotel who answered, so we identify the operator from
// what they say on the recording. The candidate list comes from Binotel itself (the operator
// names seen on personal extensions - getOperatorRoster), so there's no hand-maintained table.
// The model is constrained to return EXACTLY one of those names (or null), which also handles
// colloquial variants ("Володя" -> "Владимир") and guarantees the result groups cleanly with
// the personal-extension calls of the same person.
const SYSTEM_PROMPT = `Це транскрипт телефонної розмови автосервісу. Запис моно: обидва голоси (працівник і клієнт) в одному тексті, без розділення. Дзвінок надійшов на спільний телефон, тому працівник представляється на початку розмови.

Твоє завдання: визначити, ХТО зі списку відомих операторів вів цю розмову — за тим, як представився САМЕ ПРАЦІВНИК автосервісу (не клієнт).

Правила:
- Поверни рівно одне ім'я зі списку кандидатів (враховуй розмовні форми: Володя=Владимир, Вова=Владимир, Андрей=Андрій тощо).
- Якщо працівник не назвався, або впевнено зіставити з жодним кандидатом не вдається — поверни null.
- Не вгадуй. Краще null, ніж помилкова атрибуція.`;

// roster: array of candidate operator names. Returns one of them, or null.
async function identifyManager(transcript, roster = []) {
  const candidates = (roster || []).filter(Boolean);
  if (candidates.length === 0) return null;

  const schema = {
    name: 'manager_identification',
    strict: true,
    schema: {
      type: 'object',
      properties: {
        operator: {
          type: ['string', 'null'],
          enum: [...candidates, null],
          description: 'Точне ім\'я оператора зі списку кандидатів, або null',
        },
      },
      required: ['operator'],
      additionalProperties: false,
    },
  };

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
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: `Кандидати: ${candidates.join(', ')}\n\nТранскрипт:\n${transcript}` },
          ],
          response_format: { type: 'json_schema', json_schema: schema },
        }),
      });
      if (!res.ok) {
        throw new Error(`OpenAI manager identification failed: ${res.status} ${await res.text()}`);
      }
      const data = await res.json();
      const parsed = JSON.parse(data.choices[0].message.content);
      return parsed.operator || null;
    },
    { attempts: 3, delayMs: 1500, label: 'OpenAI manager identification' }
  );
}

export { identifyManager };
