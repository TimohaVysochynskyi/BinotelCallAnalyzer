require('dotenv').config();
const { getCallRecordUrl } = require('./binotel');
const { transcribeAudio } = require('./transcribe');

// Manual smoke test for a single known generalCallID (grab one from the Binotel web dashboard
// call log). Skips the DB and the not-yet-confirmed "list calls for period" endpoint entirely -
// only exercises the two pieces the client already gave us: call-record.json + OpenAI transcription.
// Usage: node src/testSingleCall.js <generalCallId>
async function main() {
  const generalCallId = process.argv[2];
  if (!generalCallId) {
    throw new Error('Usage: node src/testSingleCall.js <generalCallId>');
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
