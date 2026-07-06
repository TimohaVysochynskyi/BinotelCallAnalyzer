const { getCheckpoint, setCheckpoint } = require('./store');
const { processCallsForRange, retryPendingCalls } = require('./processCalls');

// Uses a persisted checkpoint instead of a fixed "last N minutes" window, so a delayed or
// skipped cron run never creates a gap - the next run just picks up exactly where the last
// one left off. Falls back to POLL_WINDOW_MINUTES only on the very first run ever.
async function pollNewCalls() {
  await retryPendingCalls();

  const end = new Date();
  const checkpoint = await getCheckpoint();
  const windowMinutes = Number(process.env.POLL_WINDOW_MINUTES || 20);
  const start = checkpoint || new Date(end.getTime() - windowMinutes * 60 * 1000);

  console.log(`[poll] checkpoint: ${checkpoint ? checkpoint.toISOString() : '(none, using default window)'}`);
  await processCallsForRange(start, end);
  await setCheckpoint(end);
}

module.exports = { pollNewCalls };
