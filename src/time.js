const TIMEZONE = 'Europe/Kyiv';

function kyivDateParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return { dateStr: `${map.year}-${map.month}-${map.day}`, hour: Number(map.hour) };
}

function kyivOffsetMinutes(date) {
  const part = new Intl.DateTimeFormat('en-US', {
    timeZone: TIMEZONE,
    timeZoneName: 'shortOffset',
  })
    .formatToParts(date)
    .find((p) => p.type === 'timeZoneName').value; // e.g. "GMT+3"
  const match = part.match(/GMT([+-]\d+)/);
  return match ? Number(match[1]) * 60 : 180;
}

// Converts a "YYYY-MM-DD" string, meant as Kyiv-local midnight, into the correct UTC instant
// (handles the EET/EEST DST switch instead of assuming a fixed +2/+3 offset).
function kyivMidnightUtc(dateStr) {
  const approx = new Date(`${dateStr}T00:00:00Z`);
  const offsetMin = kyivOffsetMinutes(approx);
  return new Date(approx.getTime() - offsetMin * 60 * 1000);
}

function addDays(dateStr, days) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// The full previous calendar day in Kyiv time, as UTC boundaries - what "yesterday" means
// for a report that fires once a day at a fixed Kyiv-local hour.
function previousKyivDayRange(now = new Date()) {
  const { dateStr: today } = kyivDateParts(now);
  const yesterday = addDays(today, -1);
  return { start: kyivMidnightUtc(yesterday), end: kyivMidnightUtc(today), dateStr: yesterday };
}

// "2026-07-06" -> "06.07.2026"
function formatDateStr(dateStr) {
  const [year, month, day] = dateStr.split('-');
  return `${day}.${month}.${year}`;
}

module.exports = { kyivDateParts, previousKyivDayRange, formatDateStr };
