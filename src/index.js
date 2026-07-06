require('dotenv').config();
const { migrate } = require('./store');
const { pollNewCalls } = require('./pollNewCalls');
const { generateDailyReport } = require('./generateReport');
const { sendAlert } = require('./telegram');

async function main() {
  const jobType = process.env.JOB_TYPE;
  console.log(`[index] starting job: ${jobType}`);

  await migrate();

  if (jobType === 'poll') {
    await pollNewCalls();
  } else if (jobType === 'report') {
    await generateDailyReport();
  } else {
    throw new Error(`Unknown JOB_TYPE "${jobType}" - expected "poll" or "report"`);
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
