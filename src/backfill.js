require('dotenv').config();
const { migrate } = require('./store');
const { processCallsForRange } = require('./processCalls');

// Process every call in an explicit date/time range (auto-split into <=23h chunks
// per Binotel's 24h cap on list-of-calls-for-period). Dates are parsed in the local
// timezone of this machine unless you include an explicit offset/Z.
// Usage: node src/backfill.js "2026-07-01 00:00:00" "2026-07-03 23:59:59"
async function main() {
  const [startArg, endArg] = process.argv.slice(2);
  if (!startArg || !endArg) {
    throw new Error('Usage: node src/backfill.js "<start date/time>" "<end date/time>"');
  }

  const start = new Date(startArg);
  const end = new Date(endArg);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    throw new Error('Could not parse one of the dates - try a format like "2026-07-01 00:00:00"');
  }
  if (start >= end) {
    throw new Error('Start must be before end');
  }

  await migrate();
  await processCallsForRange(start, end);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
