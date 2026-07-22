import 'dotenv/config';
import { getOperators, getRecentCallsForOperator, updateCallAnalysis } from '../core/store.js';
import { getCallRecordUrl } from '../core/binotel.js';
import { transcribeAudio } from '../core/transcribe.js';
import { analyzeCallBehaviors, ANALYSIS_VERSION } from '../core/analyzeCall.js';
import { displayName, hasAlias } from '../bot/operators.js';

// One-off backfill for the evidence-first report. For the last N calls of each "person" operator
// (named managers + the aliased director number, e.g. Богдан), re-transcribe via ElevenLabs to
// capture per-turn TIMECODES (calls.segments) and run the per-call MAP (calls.behaviors) so the
// report can cut audio clips and aggregate cached behaviours. Bare shared extensions (901/902) are
// skipped. Idempotent: a call that already has segments is skipped, so re-runs are cheap; a call
// whose recording is gone from Binotel is skipped with a warning.
// Run on the VPS (needs DB + Binotel + ELEVENLABS_API_KEY + OPENAI_API_KEY):  npm run backfill:analysis
const PER_OPERATOR = Number(process.env.BACKFILL_LIMIT || 30);

function isPersonOperator(name) {
  if (!name) return false;
  return !/^[0-9]+$/.test(name) || hasAlias(name);
}

async function main() {
  if (!process.env.ELEVENLABS_API_KEY) {
    console.error('[backfill] ELEVENLABS_API_KEY is not set — timecodes need ElevenLabs. Aborting.');
    process.exit(1);
  }

  const operators = (await getOperators()).filter((o) => isPersonOperator(o.name));
  if (operators.length === 0) {
    console.log('[backfill] no person operators found. Nothing to do.');
    process.exit(0);
  }
  console.log(`[backfill] operators: ${operators.map((o) => displayName(o.name)).join(', ')}`);
  console.log(`[backfill] last ${PER_OPERATOR} call(s) each — segments + behaviors (idempotent)\n`);

  let done = 0;
  let skipped = 0;
  let fail = 0;
  for (const op of operators) {
    const name = displayName(op.name);
    const calls = await getRecentCallsForOperator(op.name, PER_OPERATOR);
    console.log(`[backfill] ${name} — ${calls.length} call(s):`);
    for (const c of calls) {
      // Idempotent: skip only when already analysed at the CURRENT version. A stale version
      // (e.g. before call_purpose) is re-processed so old rows get the new fields.
      if (c.hasSegments && (c.analysisVersion ?? 0) >= ANALYSIS_VERSION) {
        skipped += 1;
        console.log(`   • ${c.generalCallId} — already analysed (v${c.analysisVersion}), skip`);
        continue;
      }
      try {
        const url = await getCallRecordUrl(c.generalCallId);
        if (!url) {
          skipped += 1;
          console.warn(`   • ${c.generalCallId} — no recording in Binotel, skip`);
          continue;
        }
        const { transcript, segments } = await transcribeAudio(url, { managerName: name });
        let behaviors = null;
        try {
          behaviors = await analyzeCallBehaviors(transcript, segments, name);
        } catch (err) {
          console.error(`   ! ${c.generalCallId} behavior analysis failed: ${err.message}`);
        }
        await updateCallAnalysis(c.generalCallId, {
          transcript,
          segments,
          behaviors,
          analysisVersion: behaviors ? ANALYSIS_VERSION : null,
          callPurpose: behaviors?.callPurpose ?? null,
        });
        const nItems = behaviors?.items?.length ?? 0;
        console.log(`   ✓ ${c.generalCallId} — ${segments?.length ?? 0} segments, purpose=${behaviors?.callPurpose ?? '—'}, ${nItems} behaviors`);
        done += 1;
      } catch (err) {
        console.error(`   ✗ ${c.generalCallId}: ${err.message}`);
        fail += 1;
      }
    }
  }

  console.log(`\n[backfill] done: ${done} processed, ${skipped} skipped, ${fail} failed.`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
