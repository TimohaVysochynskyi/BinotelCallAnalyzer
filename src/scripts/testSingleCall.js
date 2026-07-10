import 'dotenv/config';
import { getCallRecordUrl } from '../core/binotel.js';
import { transcribeAudio } from '../core/transcribe.js';

// Manual smoke test for a single known generalCallID (grab one from the Binotel web dashboard
// call log). Skips the DB entirely - only exercises Binotel call-record.json + OpenAI
// transcription.
// Usage: node src/scripts/testSingleCall.js <generalCallId>
async function main() {
  const generalCallId = process.argv[2];
  if (!generalCallId) {
    throw new Error('Usage: node src/scripts/testSingleCall.js <generalCallId>');
  }

  console.log('Fetching record URL...');
  const recordUrl = await getCallRecordUrl(generalCallId);
  console.log('Record URL:', recordUrl);

  console.log('Transcribing...');
  const transcript = await transcribeAudio(recordUrl);
  console.log('\n--- Transcript ---\n');
  console.log(transcript);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
