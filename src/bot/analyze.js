import { withRetry } from '../core/retry.js';

// Keep the prompt cheap and the output short - this goes into a Telegram message, not a PDF.
// Placeholder wording: the client will hand over a real prompt later.
const SYSTEM_PROMPT = `Ти — аналітик відділу продажів автосервісу. На основі транскриптів дзвінків ОДНОГО менеджера за період дай стислий звіт українською.

Формат (без зайвого тексту, markdown):
*Загальне:* 2-3 речення про стиль і результативність.
*➕ Сильні:* 1-2 пункти.
*➖ Слабкі:* 1-2 пункти.
*Найслабший етап:* один із — виявлення потреби / робота із запереченнями / допродаж / закриття.
*📌 Поради:* 1-2 конкретні дії.

Пиши коротко й по суті, спирайся на реальні репліки з дзвінків.`;

const MAX_TRANSCRIPT_CHARS = 1500;
const MAX_TOTAL_CHARS = 14000;

function buildUserContent(managerName, calls, stats) {
  let block = '';
  let used = 0;
  let included = 0;
  for (const c of calls) {
    const piece = `--- Дзвінок (${c.startTime}) ---\n${(c.transcript || '').slice(0, MAX_TRANSCRIPT_CHARS)}\n\n`;
    if (used + piece.length > MAX_TOTAL_CHARS) break;
    block += piece;
    used += piece.length;
    included += 1;
  }
  const omitted = calls.length - included;
  const statsLine = `Менеджер: ${managerName}. Дзвінків: ${stats.callCount}, успішних: ${stats.successCount}, середній бал: ${stats.avgScore ?? '—'}.`;
  const note = omitted > 0 ? `\n(показано ${included} з ${calls.length} транскриптів, решту опущено через обсяг)` : '';
  return `${statsLine}${note}\n\nТранскрипти:\n\n${block}`;
}

// calls: [{ transcript, startTime, isSuccess, weakestStage, communicationScore }]
async function analyzeManager(managerName, calls) {
  const successCount = calls.filter((c) => c.isSuccess).length;
  const scored = calls.filter((c) => typeof c.communicationScore === 'number');
  const avgScore = scored.length
    ? Math.round((scored.reduce((s, c) => s + c.communicationScore, 0) / scored.length) * 10) / 10
    : null;
  const stats = { callCount: calls.length, successCount, avgScore };

  const summary = await withRetry(
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
            { role: 'user', content: buildUserContent(managerName, calls, stats) },
          ],
        }),
      });
      if (!res.ok) {
        throw new Error(`OpenAI manager report failed: ${res.status} ${await res.text()}`);
      }
      const data = await res.json();
      return data.choices[0].message.content;
    },
    { attempts: 3, delayMs: 2000, label: `OpenAI report ${managerName}` }
  );

  return { managerName, stats, summary };
}

export { analyzeManager };
