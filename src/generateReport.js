const { getTranscriptsSince } = require('./store');
const { generateManagerReport } = require('./analyze');
const { sendMessage, sendAlert } = require('./telegram');

function groupByManager(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = row.managerName || 'Невідомий менеджер';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return groups;
}

async function generateDailyReport() {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  console.log(`[report] collecting transcripts since ${since.toISOString()}`);
  const rows = await getTranscriptsSince(since);
  console.log(`[report] found ${rows.length} transcripts for the past day`);

  const groups = groupByManager(rows);
  console.log(`[report] grouped into ${groups.size} manager(s): ${[...groups.keys()].join(', ')}`);

  for (const [managerName, transcripts] of groups) {
    try {
      const report = await generateManagerReport(transcripts);
      await sendMessage(`*Звіт за день — ${managerName}*\n(${transcripts.length} дзвінків)\n\n${report}`);
      console.log(`[report] sent report for ${managerName}`);
    } catch (err) {
      console.error(`[report] FAILED for ${managerName}: ${err.message}`);
      await sendAlert(`Не вдалося згенерувати/надіслати звіт для ${managerName}: ${err.message}`).catch(
        (e) => console.error(`[report] failed to send alert: ${e.message}`)
      );
    }
  }
}

module.exports = { generateDailyReport };
