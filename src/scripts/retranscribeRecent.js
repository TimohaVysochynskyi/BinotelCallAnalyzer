import 'dotenv/config';
import { getOperators, getRecentCallsForOperator, updateCallTranscript } from '../core/store.js';
import { getCallRecordUrl } from '../core/binotel.js';
import { transcribeAudio } from '../core/transcribe.js';
import { displayName, hasAlias } from '../bot/operators.js';

// One-off: re-transcribe the last N calls of each "person" operator (named managers + the aliased
// director number, e.g. Богдан 0674738200) via ElevenLabs, so the diarized "Менеджер:/Клієнт:"
// dialogue can be reviewed in the archive. Bare shared extensions (901/902) are skipped. Only the
// transcript is updated — classification/stats are left as-is. Run on the VPS (needs DB + Binotel +
// ELEVENLABS_API_KEY in .env):  npm run retranscribe:recent
const PER_OPERATOR = Number(process.env.RETRANSCRIBE_LIMIT || 5);

// Target = a named person (non-numeric manager_name) OR an aliased number (Богдан). NOT a bare
// extension like 901/902.
function isPersonOperator(name) {
  if (!name) return false;
  return !/^[0-9]+$/.test(name) || hasAlias(name);
}

async function main() {
  if (!process.env.ELEVENLABS_API_KEY) {
    console.error('[retranscribe] ELEVENLABS_API_KEY is not set — this script is meant to use ElevenLabs. Aborting.');
    process.exit(1);
  }

  const operators = (await getOperators()).filter((o) => isPersonOperator(o.name));
  if (operators.length === 0) {
    console.log('[retranscribe] no person operators found. Nothing to do.');
    process.exit(0);
  }
  console.log(`[retranscribe] operators: ${operators.map((o) => displayName(o.name)).join(', ')}`);
  console.log(`[retranscribe] last ${PER_OPERATOR} call(s) each, via ElevenLabs\n`);

  let ok = 0;
  let fail = 0;
  for (const op of operators) {
    const calls = await getRecentCallsForOperator(op.name, PER_OPERATOR);
    console.log(`[retranscribe] ${displayName(op.name)} — ${calls.length} call(s):`);
    for (const c of calls) {
      try {
        const url = await getCallRecordUrl(c.generalCallId);
        if (!url) throw new Error('no record URL from Binotel');
        // Pass the operator's display name so speaker-role detection anchors on OUR employee
        // (e.g. picks the speaker who says "це Андрій"), not on "who plays the service operator".
        const transcript = await transcribeAudio(url, { managerName: displayName(op.name) });
        await updateCallTranscript(c.generalCallId, transcript);
        console.log(`   ✓ ${c.generalCallId} (${c.startTime}) — ${transcript.length} chars`);
        ok += 1;
      } catch (err) {
        console.error(`   ✗ ${c.generalCallId}: ${err.message}`);
        fail += 1;
      }
    }
  }

  console.log(`\n[retranscribe] done: ${ok} updated, ${fail} failed.`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
