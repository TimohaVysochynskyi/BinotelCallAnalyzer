import { callExists, saveCall, upsertPending, markPendingFailed, getPendingCalls, getOperatorRoster } from '../core/store.js';
import { listCallsForPeriod, getCallRecordUrl } from '../core/binotel.js';
import { transcribeAudio } from '../core/transcribe.js';
import { classifyCall } from '../core/classifyCall.js';
import { identifyManager } from '../core/identifyManager.js';
import { sendAlert } from '../core/telegram.js';

const MAX_CHUNK_MS = 23 * 60 * 60 * 1000; // stay safely under Binotel's 24h cap on this endpoint
const MAX_PENDING_ATTEMPTS = Number(process.env.MAX_PENDING_ATTEMPTS || 20);

// Extensions that are physically shared between operators (a common handset), where Binotel
// can't tell us who actually answered. For these the operator is identified from the recording
// (see identifyManager). Personal extensions carry a name from Binotel directly.
const SHARED_EXTENSIONS = (process.env.SHARED_EXTENSIONS || '901,902')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

function splitIntoChunks(start, end) {
  const chunks = [];
  let chunkStart = start;
  while (chunkStart < end) {
    const chunkEnd = new Date(Math.min(chunkStart.getTime() + MAX_CHUNK_MS, end.getTime()));
    chunks.push([chunkStart, chunkEnd]);
    chunkStart = chunkEnd;
  }
  return chunks;
}

// Binotel is the source of truth for operators. Personal extensions carry the name directly
// (employeeData.name). Shared handsets (SHARED_EXTENSIONS) don't, so we ask the model who
// introduced themselves, constrained to the known operator names (roster, derived from Binotel
// names on other calls). No match / no name -> keep the bare extension as the label so the call
// still shows up, just unattributed to a person.
async function resolveManagerName(call, transcript, roster) {
  const ext = String(call.internalNumber);

  if (SHARED_EXTENSIONS.includes(ext) || !call.employeeName) {
    const identified = await identifyManager(transcript, roster);
    return identified || call.employeeName || ext;
  }

  return call.employeeName;
}

// Transcribes, classifies (success / weakest stage / score), resolves the operator name, and
// saves. Shared by the fresh-call path and the pending-retry path so all of this happens
// exactly once, right when the transcript first becomes available.
async function transcribeClassifyAndSave(call, roster) {
  const recordUrl = await getCallRecordUrl(call.generalCallId);
  const transcript = await transcribeAudio(recordUrl);
  const classification = await classifyCall(transcript);
  const managerName = await resolveManagerName(call, transcript, roster);

  await saveCall({
    generalCallId: call.generalCallId,
    internalNumber: call.internalNumber,
    managerName,
    startTime: call.startTime,
    durationSec: call.durationSec,
    transcript,
    isSuccess: classification.isSuccess,
    weakestStage: classification.weakestStage,
    communicationScore: classification.communicationScore,
  });
}

// One attempt at turning a discovered call into a saved transcript. Never throws - on failure
// it records the call in the pending queue (or bumps its attempt count) so a later poll run
// retries it, instead of silently losing it.
async function processOneCall(call, roster) {
  const pendingLabel = call.employeeName || String(call.internalNumber);

  if (call.durationSec <= 0) {
    console.log(`[processCalls]   skipping ${call.generalCallId} - no duration (missed/unanswered)`);
    return;
  }

  if (call.recordingStatus !== 'uploaded') {
    console.log(`[processCalls]   ${call.generalCallId} recording not ready yet (status: ${call.recordingStatus}) - queued for retry`);
    await upsertPending({ ...call, managerName: pendingLabel }, `recording status: ${call.recordingStatus}`);
    return;
  }

  try {
    console.log(`[processCalls]   processing ${call.generalCallId}...`);
    await transcribeClassifyAndSave(call, roster);
    console.log(`[processCalls]   done: ${call.generalCallId}`);
  } catch (err) {
    console.error(`[processCalls]   FAILED ${call.generalCallId}: ${err.message}`);
    await upsertPending({ ...call, managerName: pendingLabel }, err.message);
  }
}

async function processChunk(start, end, roster) {
  const calls = await listCallsForPeriod(start, end);
  console.log(`[processCalls] chunk ${start.toISOString()} -> ${end.toISOString()}: ${calls.length} call(s)`);

  for (const call of calls) {
    if (await callExists(call.generalCallId)) {
      console.log(`[processCalls]   skipping ${call.generalCallId} - already processed`);
      continue;
    }
    console.log(`[processCalls] call ${call.generalCallId} (ext ${call.internalNumber}, ${call.durationSec}s)`);
    await processOneCall(call, roster);
  }
}

async function processCallsForRange(start, end) {
  const roster = await getOperatorRoster();
  const chunks = splitIntoChunks(start, end);
  console.log(`[processCalls] range ${start.toISOString()} -> ${end.toISOString()}, ${chunks.length} chunk(s), roster: ${roster.join(', ') || '(empty)'}`);
  for (const [chunkStart, chunkEnd] of chunks) {
    await processChunk(chunkStart, chunkEnd, roster);
  }
}

// Retries everything still sitting in the pending queue before we look for brand-new calls.
// Gives up (and alerts) after MAX_PENDING_ATTEMPTS so a permanently broken recording doesn't
// retry forever.
async function retryPendingCalls() {
  const pending = await getPendingCalls();
  if (pending.length === 0) return;

  const roster = await getOperatorRoster();
  console.log(`[processCalls] retrying ${pending.length} pending call(s)`);
  for (const call of pending) {
    if (call.attempts >= MAX_PENDING_ATTEMPTS) {
      console.error(`[processCalls] giving up on ${call.generalCallId} after ${call.attempts} attempts`);
      await markPendingFailed(call.generalCallId);
      await sendAlert(`Не вдалося обробити дзвінок ${call.generalCallId} (${call.managerName}) після ${call.attempts} спроб. Позначено як "failed", дані в pending_calls збережено для перевірки вручну.`).catch(
        (e) => console.error(`[processCalls] failed to send alert: ${e.message}`)
      );
      continue;
    }

    try {
      console.log(`[processCalls]   retrying ${call.generalCallId} (attempt ${call.attempts + 1})...`);
      await transcribeClassifyAndSave(call, roster);
      console.log(`[processCalls]   pending call recovered: ${call.generalCallId}`);
    } catch (err) {
      console.error(`[processCalls]   pending retry failed for ${call.generalCallId}: ${err.message}`);
      await upsertPending(call, err.message);
    }
  }
}

export { processCallsForRange, retryPendingCalls };
