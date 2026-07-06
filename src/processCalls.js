const { callExists, saveCall, upsertPending, markPendingFailed, getPendingCalls } = require('./store');
const { listCallsForPeriod, getCallRecordUrl } = require('./binotel');
const { transcribeAudio } = require('./transcribe');
const { sendAlert } = require('./telegram');

const MAX_CHUNK_MS = 23 * 60 * 60 * 1000; // stay safely under Binotel's 24h cap on this endpoint
const MAX_PENDING_ATTEMPTS = Number(process.env.MAX_PENDING_ATTEMPTS || 20);

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

// One attempt at turning a discovered call into a saved transcript. Never throws - on
// failure it records the call in the pending queue (or bumps its attempt count) so a
// later poll run retries it, instead of silently losing it.
async function processOneCall(call) {
  const managerName = call.employeeName || String(call.internalNumber);

  if (call.durationSec <= 0) {
    console.log(`[processCalls]   skipping ${call.generalCallId} - no duration (missed/unanswered)`);
    return;
  }

  if (call.recordingStatus !== 'uploaded') {
    console.log(`[processCalls]   ${call.generalCallId} recording not ready yet (status: ${call.recordingStatus}) - queued for retry`);
    await upsertPending({ ...call, managerName }, `recording status: ${call.recordingStatus}`);
    return;
  }

  try {
    console.log(`[processCalls]   fetching recording URL for ${call.generalCallId}...`);
    const recordUrl = await getCallRecordUrl(call.generalCallId);

    console.log(`[processCalls]   transcribing ${call.generalCallId}...`);
    const transcript = await transcribeAudio(recordUrl);

    await saveCall({
      generalCallId: call.generalCallId,
      internalNumber: call.internalNumber,
      managerName,
      callType: call.callType,
      startTime: call.startTime,
      durationSec: call.durationSec,
      transcript,
    });
    console.log(`[processCalls]   done: ${call.generalCallId}`);
  } catch (err) {
    console.error(`[processCalls]   FAILED ${call.generalCallId}: ${err.message}`);
    await upsertPending({ ...call, managerName }, err.message);
  }
}

async function processChunk(start, end) {
  const calls = await listCallsForPeriod(start, end);
  console.log(`[processCalls] chunk ${start.toISOString()} -> ${end.toISOString()}: ${calls.length} call(s)`);

  for (const call of calls) {
    if (await callExists(call.generalCallId)) {
      console.log(`[processCalls]   skipping ${call.generalCallId} - already processed`);
      continue;
    }
    console.log(`[processCalls] call ${call.generalCallId} (ext ${call.internalNumber}, ${call.durationSec}s)`);
    await processOneCall(call);
  }
}

async function processCallsForRange(start, end) {
  const chunks = splitIntoChunks(start, end);
  console.log(`[processCalls] range ${start.toISOString()} -> ${end.toISOString()}, ${chunks.length} chunk(s)`);
  for (const [chunkStart, chunkEnd] of chunks) {
    await processChunk(chunkStart, chunkEnd);
  }
}

// Retries everything still sitting in the pending queue (recording wasn't ready yet, or a
// transient failure) before we look for brand-new calls. Gives up (and alerts) after
// MAX_PENDING_ATTEMPTS so a permanently broken recording doesn't retry forever.
async function retryPendingCalls() {
  const pending = await getPendingCalls();
  if (pending.length === 0) return;

  console.log(`[processCalls] retrying ${pending.length} pending call(s)`);
  for (const call of pending) {
    if (call.attempts >= MAX_PENDING_ATTEMPTS) {
      console.error(`[processCalls] giving up on ${call.generalCallId} after ${call.attempts} attempts`);
      await markPendingFailed(call.generalCallId);
      await sendAlert(`Не вдалося обробити дзвінок ${call.generalCallId} (менеджер ${call.managerName}) після ${call.attempts} спроб. Позначено як "failed", дані в pending_calls збережено для перевірки вручну.`).catch(
        (e) => console.error(`[processCalls] failed to send alert: ${e.message}`)
      );
      continue;
    }

    try {
      console.log(`[processCalls]   retrying record fetch for ${call.generalCallId} (attempt ${call.attempts + 1})...`);
      const recordUrl = await getCallRecordUrl(call.generalCallId);
      const transcript = await transcribeAudio(recordUrl);

      await saveCall({
        generalCallId: call.generalCallId,
        internalNumber: call.internalNumber,
        managerName: call.managerName,
        callType: call.callType,
        startTime: call.startTime,
        durationSec: call.durationSec,
        transcript,
      });
      console.log(`[processCalls]   pending call recovered: ${call.generalCallId}`);
    } catch (err) {
      console.error(`[processCalls]   pending retry failed for ${call.generalCallId}: ${err.message}`);
      await upsertPending(call, err.message);
    }
  }
}

module.exports = { processCallsForRange, retryPendingCalls };
