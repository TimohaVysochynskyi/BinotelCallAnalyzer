import 'dotenv/config';
import { migrate } from '../core/store.js';
import { pollNewCalls } from './pollNewCalls.js';
import { sendAlert } from '../core/telegram.js';

async function main() {
  const jobType = process.env.JOB_TYPE || 'poll';
  console.log(`[index] starting job: ${jobType}`);

  await migrate();

  if (jobType === 'poll') {
    // The single deployed job: pull new calls from Binotel, transcribe, classify and store
    // them. Reporting/stats live in a separate bot project that reads the same database.
    await pollNewCalls();
  } else {
    throw new Error(`Unknown JOB_TYPE "${jobType}" - only "poll" is supported`);
  }

  console.log(`[index] job finished`);
}

main().catch(async (err) => {
  console.error(err);
  try {
    await sendAlert(`Джоба "${process.env.JOB_TYPE}" впала: ${err.message}`);
  } catch (alertErr) {
    console.error(`[index] failed to send failure alert: ${alertErr.message}`);
  }
  process.exit(1);
});
