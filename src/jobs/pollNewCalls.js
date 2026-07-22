import {
  getCheckpoint,
  setCheckpoint,
  getElevenLabsBalanceState,
  setElevenLabsBalanceState,
} from '../core/store.js';
import { getElevenLabsBalance } from '../core/elevenlabs.js';
import { sendAlert } from '../core/telegram.js';
import { processCallsForRange, retryPendingCalls } from './processCalls.js';

// Low-balance watchdog for ElevenLabs. Runs each poll but alerts (to the same recipients as failure
// alerts, via sendAlert) only when the state CHANGES — so no spam. Credits → approx USD via a
// configurable rate (the API reports credits, not dollars). Never throws.
async function checkElevenLabsBalance() {
  if (!process.env.ELEVENLABS_API_KEY) return;
  const bal = await getElevenLabsBalance();
  const prev = await getElevenLabsBalanceState();

  if (!bal.ok) {
    // Only the (fixable) permission problem is worth a one-time heads-up; transient errors stay quiet.
    if (bal.reason === 'missing_permission' && prev !== 'no_permission') {
      await sendAlert(
        '⚠️ ElevenLabs: не можу перевіряти баланс — API-ключу бракує права «user_read». ' +
        'Додайте дозвіл user_read до ключа (ElevenLabs → Developers → API Keys), щоб отримувати сповіщення про низький баланс.'
      ).catch((e) => console.error(`[poll] balance alert failed: ${e.message}`));
      await setElevenLabsBalanceState('no_permission');
    }
    return;
  }

  const usdPer1000 = Number(process.env.ELEVENLABS_USD_PER_1000_CREDITS || 0.22);
  const minUsd = Number(process.env.ELEVENLABS_MIN_BALANCE_USD || 2);
  const remainingUsd = (bal.remainingCredits / 1000) * usdPer1000;
  const state = remainingUsd < minUsd ? 'low' : 'ok';

  if (state !== prev) {
    if (state === 'low') {
      await sendAlert(
        `⚠️ ElevenLabs: низький баланс — залишилося ~$${remainingUsd.toFixed(2)} ` +
        `(${bal.remainingCredits} кредитів із ${bal.limit}). Поповніть, інакше транскрипція ` +
        `перемкнеться на OpenAI (без діаризації, таймкодів і аудіо-доказів).`
      ).catch((e) => console.error(`[poll] balance alert failed: ${e.message}`));
    }
    await setElevenLabsBalanceState(state); // re-arms when balance recovers to 'ok'
  }
}

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

  // Low-balance watchdog — never let it break the poll.
  await checkElevenLabsBalance().catch((e) => console.error(`[poll] balance check failed: ${e.message}`));
}

export { pollNewCalls };
