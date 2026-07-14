import pg from 'pg';

const { Pool } = pg;

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
      is_success BOOLEAN,
      weakest_stage TEXT,
      communication_score INTEGER,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    ALTER TABLE calls ADD COLUMN IF NOT EXISTS is_success BOOLEAN;
    ALTER TABLE calls ADD COLUMN IF NOT EXISTS weakest_stage TEXT;
    ALTER TABLE calls ADD COLUMN IF NOT EXISTS communication_score INTEGER;

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

    -- Free-text notes a supervisor leaves about an operator's work (added via the bot). Keyed
    -- by the operator NAME (Binotel is the source of truth for operators; there is no local
    -- managers table). operator_name matches calls.manager_name.
    CREATE TABLE IF NOT EXISTS manager_notes (
      id SERIAL PRIMARY KEY,
      operator_name TEXT,
      author TEXT,
      note TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    ALTER TABLE manager_notes ADD COLUMN IF NOT EXISTS operator_name TEXT;
  `);
}

async function callExists(generalCallId) {
  const { rows } = await pool.query('SELECT 1 FROM calls WHERE general_call_id = $1', [generalCallId]);
  return rows.length > 0;
}

async function saveCall(call) {
  await pool.query(
    `INSERT INTO calls (general_call_id, internal_number, manager_name, call_type, start_time, duration_sec, transcript, is_success, weakest_stage, communication_score)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (general_call_id) DO NOTHING`,
    [
      call.generalCallId,
      call.internalNumber,
      call.managerName,
      call.callType,
      call.startTime,
      call.durationSec,
      call.transcript,
      call.isSuccess,
      call.weakestStage,
      call.communicationScore,
    ]
  );
  await pool.query('DELETE FROM pending_calls WHERE general_call_id = $1', [call.generalCallId]);
}

// ---- Operators (source of truth = Binotel names on the calls) -----------------------------

// The set of named operators seen in calls - i.e. names Binotel put on personal extensions
// (and names our shared-handset identification resolved to). Excludes bare numbers. Used as
// the candidate list for identifying who spoke on a shared handset.
async function getOperatorRoster() {
  const { rows } = await pool.query(
    `SELECT DISTINCT manager_name AS name FROM calls
     WHERE manager_name IS NOT NULL AND manager_name <> '' AND manager_name !~ '^[0-9]+$'`
  );
  return rows.map((r) => r.name);
}

// Everyone who appears in the call log (named operators + any still-unattributed shared
// numbers), most active first - this is the bot's manager picker.
async function getOperators() {
  const { rows } = await pool.query(
    `SELECT manager_name AS name, COUNT(*)::int AS n
     FROM calls
     WHERE transcript IS NOT NULL AND transcript <> '' AND manager_name IS NOT NULL AND manager_name <> ''
     GROUP BY manager_name
     ORDER BY n DESC, manager_name`
  );
  return rows;
}

async function getOperatorStats(name, start, end) {
  const { rows } = await pool.query(
    `SELECT
       COUNT(*)::int AS "callCount",
       COUNT(*) FILTER (WHERE is_success)::int AS "successCount",
       ROUND(AVG(communication_score)::numeric, 1) AS "avgScore",
       MODE() WITHIN GROUP (ORDER BY weakest_stage) AS "topWeakStage"
     FROM calls
     WHERE manager_name = $1 AND start_time >= $2 AND start_time < $3
       AND transcript IS NOT NULL AND transcript <> ''`,
    [name, start, end]
  );
  return rows[0];
}

async function countOperatorCalls(name, start, end) {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS count FROM calls
     WHERE manager_name = $1 AND start_time >= $2 AND start_time < $3
       AND transcript IS NOT NULL AND transcript <> ''`,
    [name, start, end]
  );
  return rows[0].count;
}

async function listOperatorCalls(name, start, end, limit, offset) {
  const { rows } = await pool.query(
    `SELECT general_call_id AS "generalCallId", start_time AS "startTime", call_type AS "callType",
            is_success AS "isSuccess", communication_score AS "communicationScore"
     FROM calls
     WHERE manager_name = $1 AND start_time >= $2 AND start_time < $3
       AND transcript IS NOT NULL AND transcript <> ''
     ORDER BY start_time DESC
     LIMIT $4 OFFSET $5`,
    [name, start, end, limit, offset]
  );
  return rows;
}

async function getCallByGeneralId(generalCallId) {
  const { rows } = await pool.query(
    `SELECT general_call_id AS "generalCallId", manager_name AS "managerName",
            internal_number AS "internalNumber", call_type AS "callType", start_time AS "startTime",
            duration_sec AS "durationSec", transcript, is_success AS "isSuccess",
            weakest_stage AS "weakestStage", communication_score AS "communicationScore"
     FROM calls WHERE general_call_id = $1`,
    [generalCallId]
  );
  return rows[0] || null;
}

// All processed calls in [start, end) with transcript, for the periodic report (grouped by
// manager_name in JS by the caller).
async function getCallsWithTranscriptsInRange(start, end) {
  const { rows } = await pool.query(
    `SELECT manager_name AS "managerName", internal_number AS "internalNumber", transcript,
            start_time AS "startTime", is_success AS "isSuccess",
            weakest_stage AS "weakestStage", communication_score AS "communicationScore"
     FROM calls
     WHERE start_time >= $1 AND start_time < $2 AND transcript IS NOT NULL AND transcript <> ''
     ORDER BY manager_name, start_time`,
    [start, end]
  );
  return rows;
}

// Calls whose manager_name is still a bare number (a shared handset we couldn't attribute to a
// person, e.g. ingested before identification existed). Used by the reattribution backfill.
async function getNumericManagerCalls() {
  const { rows } = await pool.query(
    `SELECT general_call_id AS "generalCallId", internal_number AS "internalNumber",
            manager_name AS "managerName", transcript
     FROM calls
     WHERE manager_name ~ '^[0-9]+$' AND transcript IS NOT NULL AND transcript <> ''
     ORDER BY start_time`
  );
  return rows;
}

async function updateManagerName(generalCallId, managerName) {
  await pool.query('UPDATE calls SET manager_name = $2 WHERE general_call_id = $1', [generalCallId, managerName]);
}

async function addOperatorNote(operatorName, author, note) {
  await pool.query(
    `INSERT INTO manager_notes (operator_name, author, note) VALUES ($1, $2, $3)`,
    [operatorName, author || null, note]
  );
}

async function listOperatorNotes(operatorName, limit = 10) {
  const { rows } = await pool.query(
    `SELECT note, author, created_at AS "createdAt"
     FROM manager_notes WHERE operator_name = $1
     ORDER BY created_at DESC LIMIT $2`,
    [operatorName, limit]
  );
  return rows;
}

// ---- Knowledge base (RAG over uploaded manuals, pgvector) ---------------------------------

// Separate from migrate() so a missing pgvector extension disables only the KB, not the whole
// bot. Called (guarded) at bot startup.
async function migrateKb() {
  await pool.query('CREATE EXTENSION IF NOT EXISTS vector');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS kb_docs (
      id SERIAL PRIMARY KEY,
      filename TEXT NOT NULL,
      uploaded_by TEXT,
      file_id TEXT,
      mime TEXT,
      chunk_count INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    -- Telegram file_id lets us resend the original document ("open file") without storing bytes.
    ALTER TABLE kb_docs ADD COLUMN IF NOT EXISTS file_id TEXT;
    ALTER TABLE kb_docs ADD COLUMN IF NOT EXISTS mime TEXT;

    CREATE TABLE IF NOT EXISTS kb_chunks (
      id SERIAL PRIMARY KEY,
      doc_id INTEGER NOT NULL REFERENCES kb_docs(id) ON DELETE CASCADE,
      ord INTEGER NOT NULL,
      content TEXT NOT NULL,
      embedding vector(1536),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS kb_chunks_embedding_idx ON kb_chunks USING hnsw (embedding vector_cosine_ops);
  `);
}

const vecToStr = (arr) => `[${arr.join(',')}]`;

async function insertKbDoc(filename, uploadedBy, fileId, mime) {
  const { rows } = await pool.query(
    'INSERT INTO kb_docs (filename, uploaded_by, file_id, mime) VALUES ($1, $2, $3, $4) RETURNING id',
    [filename, uploadedBy || null, fileId || null, mime || null]
  );
  return rows[0].id;
}

// chunks: [{ ord, content, embedding: number[] }]
async function insertKbChunks(docId, chunks) {
  for (const c of chunks) {
    await pool.query(
      'INSERT INTO kb_chunks (doc_id, ord, content, embedding) VALUES ($1, $2, $3, $4::vector)',
      [docId, c.ord, c.content, vecToStr(c.embedding)]
    );
  }
  await pool.query('UPDATE kb_docs SET chunk_count = $2 WHERE id = $1', [docId, chunks.length]);
}

async function searchKbChunks(queryEmbedding, k = 6) {
  const { rows } = await pool.query(
    `SELECT c.content, d.filename, d.id AS "docId", (c.embedding <=> $1::vector) AS dist
     FROM kb_chunks c JOIN kb_docs d ON d.id = c.doc_id
     ORDER BY c.embedding <=> $1::vector
     LIMIT $2`,
    [vecToStr(queryEmbedding), k]
  );
  return rows;
}

async function listKbDocs() {
  const { rows } = await pool.query(
    `SELECT id, filename, chunk_count AS "chunkCount", created_at AS "createdAt"
     FROM kb_docs ORDER BY created_at DESC`
  );
  return rows;
}

async function countKbChunks() {
  const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM kb_chunks');
  return rows[0].n;
}

async function getKbDoc(id) {
  const { rows } = await pool.query(
    `SELECT id, filename, file_id AS "fileId", mime, chunk_count AS "chunkCount", created_at AS "createdAt"
     FROM kb_docs WHERE id = $1`,
    [id]
  );
  return rows[0] || null;
}

async function deleteKbDoc(id) {
  await pool.query('DELETE FROM kb_docs WHERE id = $1', [id]);
}

// ---- Pending queue (ingest) ---------------------------------------------------------------

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

// ---- App state (checkpoint + report scheduler) --------------------------------------------

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

async function getReportSlot() {
  return getState('last_report_slot');
}

async function setReportSlot(slotKey) {
  await setState('last_report_slot', slotKey);
}

async function getReportUntil() {
  const value = await getState('last_report_until');
  return value ? new Date(value) : null;
}

async function setReportUntil(date) {
  await setState('last_report_until', date.toISOString());
}

export {
  migrate,
  callExists,
  saveCall,
  getOperatorRoster,
  getOperators,
  getOperatorStats,
  countOperatorCalls,
  listOperatorCalls,
  getCallByGeneralId,
  getCallsWithTranscriptsInRange,
  getNumericManagerCalls,
  updateManagerName,
  addOperatorNote,
  listOperatorNotes,
  migrateKb,
  insertKbDoc,
  insertKbChunks,
  searchKbChunks,
  listKbDocs,
  countKbChunks,
  getKbDoc,
  deleteKbDoc,
  upsertPending,
  markPendingFailed,
  getPendingCalls,
  getCheckpoint,
  setCheckpoint,
  getReportSlot,
  setReportSlot,
  getReportUntil,
  setReportUntil,
};
