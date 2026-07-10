import 'dotenv/config';
import { migrate, getOperatorRoster, getNumericManagerCalls, updateManagerName } from '../core/store.js';
import { identifyManager } from '../core/identifyManager.js';

// One-off backfill: existing shared-handset calls that were saved with a bare number as the
// manager (e.g. "901") - re-run identification from the stored transcript against the current
// Binotel-derived operator roster, and attribute them to a person where possible. Only touches
// calls on SHARED_EXTENSIONS; stray external numbers are left as-is. Safe to re-run.
const SHARED_EXTENSIONS = (process.env.SHARED_EXTENSIONS || '901,902')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

async function main() {
  await migrate();
  const roster = await getOperatorRoster();
  if (roster.length === 0) {
    console.log('[reattribute] roster is empty - nothing to match against. Aborting.');
    return;
  }
  console.log(`[reattribute] roster: ${roster.join(', ')}`);

  const calls = (await getNumericManagerCalls()).filter((c) => SHARED_EXTENSIONS.includes(String(c.internalNumber)));
  console.log(`[reattribute] ${calls.length} shared-handset call(s) to check`);

  let updated = 0;
  for (const c of calls) {
    const name = await identifyManager(c.transcript, roster);
    if (name && name !== c.managerName) {
      await updateManagerName(c.generalCallId, name);
      updated += 1;
      console.log(`[reattribute]   ${c.generalCallId} (ext ${c.internalNumber}): ${c.managerName} -> ${name}`);
    } else {
      console.log(`[reattribute]   ${c.generalCallId} (ext ${c.internalNumber}): no confident match, left as ${c.managerName}`);
    }
  }
  console.log(`[reattribute] done: ${updated}/${calls.length} reattributed`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
