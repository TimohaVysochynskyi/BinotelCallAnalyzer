const { withRetry } = require('./retry');

const ANALYSIS_PROMPT = `Контекст бізнесу: менеджер приймає вхідні дзвінки та здійснює вихідні.
Успішний дзвінок = клієнт записаний на сервіс або підтвердив дату приїзду.

Мені НЕ потрібен розбір кожного дзвінка окремо.
Потрібен узагальнений аналітичний звіт на основі всіх транскриптів разом.

Сформуй звіт суворо у такому форматі (Markdown):

---

ЗАГАЛЬНА ХАРАКТЕРИСТИКА МЕНЕДЖЕРА
5–7 речень. Стиль комунікації, рівень впевненості, структура розмови, емоційний стан (енергія, втома, роздратованість), поведінкові патерни.

---

СИЛЬНІ СТОРОНИ (від 3 до 5 повторюваних позитивних закономірностей)
Кожен пункт:
- *Назва*
- Пояснення
- Приклад фрази або ситуації з дзвінків

---

СИСТЕМНІ ПОМИЛКИ (від 3 до 5 повторюваних слабких місць)
Кожен пункт:
- *Назва проблеми*
- Як саме проявляється
- Чому це шкодить продажу / запису клієнта

---

НАЙСЛАБШИЙ ЕТАП ПРОДАЖУ
Визнач один головний: виявлення потреби / робота із запереченнями / допродаж (масло, фільтри, додаткові роботи) / закриття (фіксація запису).
Поясни чому саме цей етап і як це впливає на результат.

---

ДИНАМІКА ЗА ПЕРІОД
Чи є прогрес або деградація від початку до кінця періоду?
Якщо не можна визначити — так і напиши.

---

ТОП-3 ТОЧКИ РОСТУ
Що змінити в першу чергу для швидкого результату.
Для кожної: що саме змінити і який ефект очікувати.

---

ГОТОВІ ФОРМУЛЮВАННЯ
5–7 конкретних фраз, прив'язаних до реальних ситуацій цього менеджера:
- заперечення "дорого" / "подумаю" / "зроблю в іншому місці"
- момент закриття (фіксація дати запису)
- уточнення проблеми авто`;

async function generateManagerReport(transcripts) {
  console.log(`[analyze] generating report from ${transcripts.length} transcripts...`);
  const transcriptsBlock = transcripts
    .map((t, i) => `--- Дзвінок ${i + 1} (${t.startTime}) ---\n${t.transcript}`)
    .join('\n\n');

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
            { role: 'system', content: ANALYSIS_PROMPT },
            { role: 'user', content: `Транскрипти дзвінків за період:\n\n${transcriptsBlock}` },
          ],
        }),
      });
      if (!res.ok) {
        throw new Error(`OpenAI analysis failed: ${res.status} ${await res.text()}`);
      }
      const data = await res.json();
      return data.choices[0].message.content;
    },
    { attempts: 3, delayMs: 2000, label: 'OpenAI analysis' }
  );
}

module.exports = { generateManagerReport };
