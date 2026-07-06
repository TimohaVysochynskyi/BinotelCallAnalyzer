const { withRetry } = require('./retry');

const BASE_URL = process.env.BINOTEL_BASE_URL || 'https://api.binotel.com/api/4.0';

function auth() {
  return {
    key: process.env.BINOTEL_API_KEY,
    secret: process.env.BINOTEL_API_SECRET,
  };
}

async function callBinotel(path, body) {
  return withRetry(
    async () => {
      console.log(`[binotel] POST ${path}`, JSON.stringify(body));
      const res = await fetch(`${BASE_URL}/${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...auth(), ...body }),
      });
      if (!res.ok) {
        throw new Error(`Binotel ${path} failed: ${res.status} ${await res.text()}`);
      }
      const data = await res.json();
      console.log(`[binotel] response from ${path}:`, JSON.stringify(data).slice(0, 500));
      return data;
    },
    { attempts: 3, delayMs: 1500, label: `binotel ${path}` }
  );
}

function toUnixSeconds(date) {
  return Math.floor(date.getTime() / 1000);
}

// Confirmed against a real account on 2026-07-06: callDetails is an OBJECT keyed by
// generalCallID, not an array. Binotel caps this method at a 24h window.
async function listCallsForPeriod(startDate, endDate) {
  const data = await callBinotel('stats/list-of-calls-for-period.json', {
    startTime: toUnixSeconds(startDate),
    stopTime: toUnixSeconds(endDate),
  });
  const calls = Object.values(data.callDetails || {});
  return calls.map((c) => ({
    generalCallId: c.generalCallID,
    internalNumber: c.internalNumber,
    // employeeData.name is populated for calls answered on a personal extension (confirmed
    // for 903). Shared-handset extensions may not carry a name - callers fall back to the
    // raw internalNumber when this is empty.
    employeeName: c.employeeData?.name || null,
    callType: c.callType,
    startTime: new Date(Number(c.startTime) * 1000).toISOString(),
    durationSec: Number(c.billsec || 0),
    recordingStatus: c.recordingStatus,
  }));
}

// Binotel support's email used "generalCallID" for this endpoint, but the underlying
// SDK docs call it "callID" - sending both since they're confirmed to hold the same value.
async function getCallRecordUrl(generalCallId) {
  const data = await callBinotel('stats/call-record.json', {
    generalCallID: generalCallId,
    callID: generalCallId,
  });
  return data.url || data.response?.record || data.record;
}

module.exports = { listCallsForPeriod, getCallRecordUrl };
