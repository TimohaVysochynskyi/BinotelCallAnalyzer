import 'dotenv/config';
import { getRecentCalls, updateCallAnalysis } from '../core/store.js';
import { getCallRecordUrl } from '../core/binotel.js';
import { transcribeDiarized } from '../core/elevenlabs.js';
import { analyzeCallBehaviors, ANALYSIS_VERSION } from '../core/analyzeCall.js';
import { displayName } from '../bot/operators.js';

// One-off: re-run the last N calls OVERALL through ElevenLabs. Use after a stretch where ElevenLabs
// was unavailable (e.g. out of credits) and calls fell back to OpenAI — those have no diarization /
// timecodes. This FORCES the ElevenLabs path (transcribeDiarized on the downloaded audio, no silent
// OpenAI fallback), then refreshes segments + per-call behaviours + call_purpose. If ElevenLabs
// fails for a call, that call is reported and skipped (не тихо падає на OpenAI).
// Run on the VPS (needs DB + Binotel + ELEVENLABS_API_KEY + OPENAI_API_KEY):  npm run retranscribe:last
const LIMIT = Number(process.env.RETRANSCRIBE_LAST_LIMIT || 7); // last 6 were OpenAI; 7 = with a buffer

async function main() {
  if (!process.env.ELEVENLABS_API_KEY) {
    console.error('[retranscribe:last] ELEVENLABS_API_KEY is not set — this script must use ElevenLabs. Aborting.');
    process.exit(1);
  }

  const calls = await getRecentCalls(LIMIT);
  if (calls.length === 0) {
    console.log('[retranscribe:last] no calls found. Nothing to do.');
    process.exit(0);
  }
  console.log(`[retranscribe:last] re-running the last ${calls.length} call(s) through ElevenLabs\n`);

  let ok = 0;
  let fail = 0;
  for (const c of calls) {
    const who = displayName(c.managerName) || c.managerName || c.internalNumber || '—';
    try {
      const url = await getCallRecordUrl(c.generalCallId);
      if (!url) {
        console.warn(`   • ${c.generalCallId} (${who}) — no recording in Binotel, skip`);
        continue;
      }
      const res = await fetch(url);
      if (!res.ok) throw new Error(`download HTTP ${res.status}`);
      const blob = await res.blob();

      // Force ElevenLabs (throws if it fails — we do NOT fall back to OpenAI here on purpose).
      const { transcript, segments } = await transcribeDiarized(blob, who);
      let behaviors = null;
      try {
        behaviors = await analyzeCallBehaviors(transcript, segments, who);
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
      console.log(
        `   ✓ ${c.generalCallId} (${who}) — ${segments?.length ?? 0} segments, ` +
        `purpose=${behaviors?.callPurpose ?? '—'}, ${behaviors?.items?.length ?? 0} behaviors`
      );
      ok += 1;
    } catch (err) {
      console.error(`   ✗ ${c.generalCallId} (${who}): ${err.message}`);
      fail += 1;
    }
  }

  console.log(`\n[retranscribe:last] done: ${ok} re-transcribed, ${fail} failed.`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
