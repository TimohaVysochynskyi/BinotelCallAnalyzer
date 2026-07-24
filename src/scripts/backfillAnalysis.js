import 'dotenv/config';
import { getCallsMissingSegments, updateCallFullAnalysis } from '../core/store.js';
import { getCallRecordUrl } from '../core/binotel.js';
import { transcribeAudio } from '../core/transcribe.js';
import { analyzeCallBehaviors, ANALYSIS_VERSION } from '../core/analyzeCall.js';
import { classifyCall } from '../core/classifyCall.js';
import { displayName } from '../bot/operators.js';

// Historical re-analysis backfill for the evidence-first report. Every call still missing
// ElevenLabs timecodes (calls.segments IS NULL - an old OpenAI-fallback transcript, or a call
// ingested before ElevenLabs was wired up) is re-transcribed via ElevenLabs to capture per-turn
// TIMECODES (segments) AND diarized speakers, then run through the FULL per-call pipeline exactly
// like a fresh ingest: per-call MAP (behaviors + call_purpose) and, for sales calls, classifyCall
// (isSuccess/weakestStage/communicationScore) — so old calls get scored on the current rubric/
// taxonomy too, not just given timecodes. Covers EVERY operator (named/bare-number/shared), not a
// capped recent window - this used to be "last BACKFILL_LIMIT(30) calls per person operator"; that
// cap is gone since the whole point now is to clear the WHOLE backlog, however large.
// Idempotent: a call that already has segments is skipped, so re-runs only pick up stragglers
// (e.g. ones that fell back to OpenAI last time because ElevenLabs credits ran out mid-run). A call
// whose recording is gone from Binotel is skipped with a warning.
// Run on the VPS (needs DB + Binotel + ELEVENLABS_API_KEY + OPENAI_API_KEY):  npm run backfill:analysis
async function main() {
  if (!process.env.ELEVENLABS_API_KEY) {
    console.error('[backfill] ELEVENLABS_API_KEY is not set — timecodes need ElevenLabs. Aborting.');
    process.exit(1);
  }

  const calls = await getCallsMissingSegments();
  console.log(`[backfill] ${calls.length} call(s) missing segments — re-transcribe + re-analyze (idempotent)\n`);
  if (calls.length === 0) {
    console.log('[backfill] nothing to do.');
    process.exit(0);
  }

  let done = 0;
  let skipped = 0;
  let fail = 0;
  for (const c of calls) {
    const name = displayName(c.managerName);
    try {
      const url = await getCallRecordUrl(c.generalCallId);
      if (!url) {
        skipped += 1;
        console.warn(`   • ${c.generalCallId} (${name}) — no recording in Binotel, skip`);
        continue;
      }
      const { transcript, segments } = await transcribeAudio(url, { managerName: name });

      let behaviors = null;
      try {
        behaviors = await analyzeCallBehaviors(transcript, segments, name);
      } catch (err) {
        console.error(`   ! ${c.generalCallId} behavior analysis failed: ${err.message}`);
      }

      // Same purpose-first gate as a fresh ingest (processCalls.js): only sales calls get scored;
      // an unknown purpose (MAP failed) is treated as sales so a transient error doesn't drop scoring.
      const purpose = behaviors?.callPurpose ?? null;
      const isSalesCall = purpose === null || purpose === 'sales';
      let classification = { isSuccess: null, weakestStage: null, communicationScore: null };
      if (isSalesCall) {
        classification = await classifyCall(transcript);
      }

      await updateCallFullAnalysis(c.generalCallId, {
        transcript,
        segments,
        behaviors,
        analysisVersion: behaviors ? ANALYSIS_VERSION : null,
        callPurpose: behaviors?.callPurpose ?? null,
        isSuccess: classification.isSuccess,
        weakestStage: classification.weakestStage,
        communicationScore: classification.communicationScore,
      });
      const nItems = behaviors?.items?.length ?? 0;
      console.log(
        `   ✓ ${c.generalCallId} (${name}) — ${segments?.length ?? 0} segments, purpose=${behaviors?.callPurpose ?? '—'}, ${nItems} behaviors, score=${classification.communicationScore ?? '—'}`
      );
      done += 1;
    } catch (err) {
      console.error(`   ✗ ${c.generalCallId} (${name}): ${err.message}`);
      fail += 1;
    }
    if ((done + skipped + fail) % 25 === 0) {
      console.log(`   … ${done + skipped + fail}/${calls.length} attempted so far`);
    }
  }

  console.log(`\n[backfill] done: ${done} processed, ${skipped} skipped, ${fail} failed.`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
