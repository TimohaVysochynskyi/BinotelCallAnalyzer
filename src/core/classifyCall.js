import { withRetry } from './retry.js';

const WEAKEST_STAGES = ['виявлення потреби', 'робота із запереченнями', 'допродаж', 'закриття'];

const SYSTEM_PROMPT = `Контекст бізнесу: менеджер приймає вхідні дзвінки та здійснює вихідні.
Успішний дзвінок = клієнт записаний на сервіс або підтвердив дату приїзду.

Оціни ЦЕЙ ОДИН дзвінок і поверни структуровані дані:
- isSuccess: чи клієнт записався / підтвердив дату
- weakestStage: який етап продажу (виявлення потреби / робота із запереченнями / допродаж / закриття) був найслабшим у цьому дзвінку. Якщо етап взагалі не застосовний до цього дзвінка (напр. це просто підтвердження вже існуючого запису) - постав null
- communicationScore: оцінка комунікації менеджера від 1 до 10`;

const SCHEMA = {
  name: 'call_classification',
  strict: true,
  schema: {
    type: 'object',
    properties: {
      isSuccess: { type: 'boolean' },
      weakestStage: { type: ['string', 'null'], enum: [...WEAKEST_STAGES, null] },
      communicationScore: { type: 'integer', minimum: 1, maximum: 10 },
    },
    required: ['isSuccess', 'weakestStage', 'communicationScore'],
    additionalProperties: false,
  },
};

async function classifyCall(transcript) {
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
            { role: 'user', content: transcript },
          ],
          response_format: { type: 'json_schema', json_schema: SCHEMA },
        }),
      });
      if (!res.ok) {
        throw new Error(`OpenAI classification failed: ${res.status} ${await res.text()}`);
      }
      const data = await res.json();
      return JSON.parse(data.choices[0].message.content);
    },
    { attempts: 3, delayMs: 1500, label: 'OpenAI call classification' }
  );
}

export { classifyCall };
