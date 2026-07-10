// Kyiv-time helpers for the bot: report scheduling (13:00 / 19:30 local) and stat period
// boundaries (day / week-from-Monday / month / quarter). Everything is computed via
// Intl.DateTimeFormat so the EET/EEST DST switch is handled correctly, never a hardcoded
// +2/+3 offset. Boundaries are returned as absolute UTC instants (calls.start_time is UTC).

const TZ = 'Europe/Kyiv';

function kyivParts(date) {
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const m = Object.fromEntries(p.map((x) => [x.type, x.value]));
  return {
    year: Number(m.year),
    month: Number(m.month),
    day: Number(m.day),
    hour: Number(m.hour),
    minute: Number(m.minute),
    dateStr: `${m.year}-${m.month}-${m.day}`,
    hhmm: `${m.hour}:${m.minute}`,
  };
}

// 1 = Monday ... 7 = Sunday
function kyivWeekday(date) {
  const wd = new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short' }).format(date);
  return { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 }[wd];
}

function kyivOffsetMinutes(date) {
  const s = new Intl.DateTimeFormat('en-US', { timeZone: TZ, timeZoneName: 'shortOffset' })
    .formatToParts(date)
    .find((p) => p.type === 'timeZoneName').value; // e.g. "GMT+3" or "GMT+2"
  const mt = s.match(/GMT([+-]\d+)(?::(\d+))?/);
  if (!mt) return 180;
  const h = Number(mt[1]);
  const min = mt[2] ? Number(mt[2]) : 0;
  return h * 60 + (h < 0 ? -min : min);
}

// UTC instant of Kyiv-local midnight for the given Kyiv calendar date.
function kyivMidnightUtc(year, month, day) {
  const approx = new Date(Date.UTC(year, month - 1, day, 0, 0, 0));
  const off = kyivOffsetMinutes(approx);
  return new Date(approx.getTime() - off * 60 * 1000);
}

// Shift a Kyiv calendar date by whole days, returning {year, month, day}.
function shiftKyivDate({ year, month, day }, deltaDays) {
  const d = new Date(Date.UTC(year, month - 1, day));
  d.setUTCDate(d.getUTCDate() + deltaDays);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

function startOfDay(now) {
  const p = kyivParts(now);
  return kyivMidnightUtc(p.year, p.month, p.day);
}

function startOfWeek(now) {
  const p = kyivParts(now);
  const monday = shiftKyivDate(p, -(kyivWeekday(now) - 1));
  return kyivMidnightUtc(monday.year, monday.month, monday.day);
}

function startOfMonth(now) {
  const p = kyivParts(now);
  return kyivMidnightUtc(p.year, p.month, 1);
}

function startOfQuarter(now) {
  const p = kyivParts(now);
  const qMonth = Math.floor((p.month - 1) / 3) * 3 + 1;
  return kyivMidnightUtc(p.year, qMonth, 1);
}

const PERIODS = {
  day: { label: 'сьогодні', start: startOfDay },
  week: { label: 'цей тиждень (з пн)', start: startOfWeek },
  month: { label: 'цей місяць', start: startOfMonth },
  quarter: { label: 'цей квартал', start: startOfQuarter },
};

// { start, end, label } for a named period ending "now".
function periodRange(period, now = new Date()) {
  const def = PERIODS[period] || PERIODS.week;
  return { start: def.start(now), end: now, label: def.label };
}

// "08.07.2026 14:35" in Kyiv time.
function formatKyiv(date) {
  const p = kyivParts(date);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(p.day)}.${pad(p.month)}.${p.year} ${pad(p.hour)}:${pad(p.minute)}`;
}

export { kyivParts, periodRange, startOfDay, formatKyiv };
