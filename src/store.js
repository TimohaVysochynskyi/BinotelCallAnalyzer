const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function migrate() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS calls (
      id SERIAL PRIMARY KEY,
      general_call_id TEXT UNIQUE NOT NULL,
      internal_number TEXT,
      manager_name TEXT,
      call_type TEXT,
      start_time TIMESTAMPTZ,
      duration_sec INTEGER,
      transcript TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS pending_calls (
      general_call_id TEXT PRIMARY KEY,
      internal_number TEXT,
      manager_name TEXT,
      call_type TEXT,
      start_time TIMESTAMPTZ,
      duration_sec INTEGER,
      attempts INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending',
      last_error TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS app_state (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `);
}

async function callExists(generalCallId) {
  const { rows } = await pool.query('SELECT 1 FROM calls WHERE general_call_id = $1', [generalCallId]);
  return rows.length > 0;
}

async function saveCall(call) {
  await pool.query(
    `INSERT INTO calls (general_call_id, internal_number, manager_name, call_type, start_time, duration_sec, transcript)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (general_call_id) DO NOTHING`,
    [call.generalCallId, call.internalNumber, call.managerName, call.callType, call.startTime, call.durationSec, call.transcript]
  );
  await pool.query('DELETE FROM pending_calls WHERE general_call_id = $1', [call.generalCallId]);
}

async function getTranscriptsInRange(start, end) {
  const { rows } = await pool.query(
    `SELECT manager_name AS "managerName", transcript, start_time AS "startTime"
     FROM calls
     WHERE start_time >= $1 AND start_time < $2 AND transcript IS NOT NULL AND transcript <> ''
     ORDER BY manager_name, start_time`,
    [start, end]
  );
  return rows;
}

async function upsertPending(call, errorMessage) {
  await pool.query(
    `INSERT INTO pending_calls (general_call_id, internal_number, manager_name, call_type, start_time, duration_sec, attempts, status, last_error, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, 1, 'pending', $7, now())
     ON CONFLICT (general_call_id) DO UPDATE SET
       attempts = pending_calls.attempts + 1,
       last_error = $7,
       updated_at = now()`,
    [call.generalCallId, call.internalNumber, call.managerName, call.callType, call.startTime, call.durationSec, errorMessage || null]
  );
}

async function markPendingFailed(generalCallId) {
  await pool.query(`UPDATE pending_calls SET status = 'failed', updated_at = now() WHERE general_call_id = $1`, [generalCallId]);
}

async function getPendingCalls() {
  const { rows } = await pool.query(
    `SELECT general_call_id AS "generalCallId", internal_number AS "internalNumber", manager_name AS "managerName",
            call_type AS "callType", start_time AS "startTime", duration_sec AS "durationSec", attempts
     FROM pending_calls
     WHERE status = 'pending'
     ORDER BY start_time`
  );
  return rows;
}

async function getState(key) {
  const { rows } = await pool.query('SELECT value FROM app_state WHERE key = $1', [key]);
  return rows[0]?.value ?? null;
}

async function setState(key, value) {
  await pool.query(
    `INSERT INTO app_state (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = $2`,
    [key, value]
  );
}

async function getCheckpoint() {
  const value = await getState('last_polled_until');
  return value ? new Date(value) : null;
}

async function setCheckpoint(date) {
  await setState('last_polled_until', date.toISOString());
}

async function getLastReportDate() {
  return getState('last_report_date');
}

async function setLastReportDate(dateStr) {
  await setState('last_report_date', dateStr);
}

module.exports = {
  migrate,
  callExists,
  saveCall,
  getTranscriptsInRange,
  upsertPending,
  markPendingFailed,
  getPendingCalls,
  getCheckpoint,
  setCheckpoint,
  getLastReportDate,
  setLastReportDate,
};
