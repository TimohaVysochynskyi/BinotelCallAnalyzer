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

    -- One-time cleanup of pre-refactor artifacts. Binotel is now the source of truth for
    -- operators (see identifyManager / resolveManagerName), so the local managers table and
    -- the manager_id foreign keys are gone; attribution keys off calls.manager_name only.
    -- Dropping calls.manager_id / manager_notes.manager_id also drops their FKs to managers,
    -- which is why those columns go before the table. Guarded with IF EXISTS => a no-op once
    -- applied. Both columns were 100% NULL before removal, so no data is lost.
    ALTER TABLE calls DROP COLUMN IF EXISTS manager_id;
    ALTER TABLE manager_notes DROP COLUMN IF EXISTS manager_id;
    DROP TABLE IF EXISTS managers;

    -- Bot access control (role system). Purely for AUTHORIZING who may use the bot and which
    -- features they see — NOT a revival of the old attribution "managers" table (Binotel stays
    -- the source of truth for who spoke on a call). role: director|marketer|manager|mechanic.
    -- telegram_id is NULL for a "pending" invite (added by phone before the person opened the
    -- bot); it's filled and status flips to 'active' when they share their contact. operator_name
    -- links a manager row to calls.manager_name so they can see their own stats.
    CREATE TABLE IF NOT EXISTS bot_users (
      id SERIAL PRIMARY KEY,
      telegram_id BIGINT UNIQUE,
      role TEXT NOT NULL,
      phone TEXT,
      username TEXT,
      display_name TEXT,
      operator_name TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      added_by BIGINT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}

// ---- Bot users / roles (access control) ---------------------------------------------------

const BOT_USER_COLS = `id, telegram_id AS "telegramId", role, phone, username,
  display_name AS "displayName", operator_name AS "operatorName", status`;

// Digits only; phones are matched by their last 9 digits so +380/0-prefix variants still line up.
function normalizePhone(raw) {
  return String(raw || '').replace(/\D/g, '');
}

async function getBotUser(telegramId) {
  const { rows } = await pool.query(
    `SELECT ${BOT_USER_COLS} FROM bot_users WHERE telegram_id = $1`,
    [telegramId]
  );
  return rows[0] || null;
}

async function getBotUserById(id) {
  const { rows } = await pool.query(`SELECT ${BOT_USER_COLS} FROM bot_users WHERE id = $1`, [id]);
  return rows[0] || null;
}

async function getBotUsersByRole(role) {
  const { rows } = await pool.query(
    `SELECT ${BOT_USER_COLS} FROM bot_users WHERE role = $1 ORDER BY status, display_name NULLS LAST, id`,
    [role]
  );
  return rows;
}

// Insert or update a person identified by their Telegram id (the request_users path — we know
// their id immediately). Non-null fields overwrite; nulls keep the existing value.
async function upsertBotUserByTelegram({ telegramId, role, phone, username, displayName, operatorName, addedBy }) {
  const { rows } = await pool.query(
    `INSERT INTO bot_users (telegram_id, role, phone, username, display_name, operator_name, status, added_by)
     VALUES ($1, $2, $3, $4, $5, $6, 'active', $7)
     ON CONFLICT (telegram_id) DO UPDATE SET
       role = $2,
       phone = COALESCE($3, bot_users.phone),
       username = COALESCE($4, bot_users.username),
       display_name = COALESCE($5, bot_users.display_name),
       operator_name = COALESCE($6, bot_users.operator_name),
       status = 'active'
     RETURNING id`,
    [telegramId, role, phone ? normalizePhone(phone) : null, username || null, displayName || null, operatorName || null, addedBy || null]
  );
  return rows[0].id;
}

// Invite by phone before the person has opened the bot (telegram_id unknown yet).
async function addPendingBotUser({ phone, role, displayName, addedBy }) {
  const { rows } = await pool.query(
    `INSERT INTO bot_users (telegram_id, role, phone, display_name, status, added_by)
     VALUES (NULL, $2, $1, $3, 'pending', $4) RETURNING id`,
    [normalizePhone(phone), role, displayName || null, addedBy || null]
  );
  return rows[0].id;
}

// When an unknown user shares their contact, match a pending invite by the last 9 phone digits.
async function activatePendingByPhone(phone, { telegramId, username, displayName }) {
  const { rows } = await pool.query(
    `UPDATE bot_users SET telegram_id = $2, username = COALESCE($3, username),
       display_name = COALESCE($4, display_name), status = 'active'
     WHERE status = 'pending' AND telegram_id IS NULL
       AND RIGHT(regexp_replace(phone, '\\D', '', 'g'), 9) = RIGHT($1, 9)
     RETURNING id, role`,
    [normalizePhone(phone), telegramId, username || null, displayName || null]
  );
  return rows[0] || null;
}

async function setBotUserOperator(id, operatorName) {
  await pool.query('UPDATE bot_users SET operator_name = $2 WHERE id = $1', [id, operatorName]);
}

async function setBotUserPhone(telegramId, phone) {
  await pool.query('UPDATE bot_users SET phone = $2 WHERE telegram_id = $1', [telegramId, normalizePhone(phone)]);
}

async function deleteBotUser(id) {
  const { rows } = await pool.query('DELETE FROM bot_users WHERE id = $1 RETURNING telegram_id AS "telegramId", role', [id]);
  return rows[0] || null;
}

// Bootstrap: make sure a chat id is a director (used to seed TELEGRAM_BOOTSTRAP_CHAT_IDS at
// startup so the owner can never lock themselves out). Never downgrades an existing row.
async function seedDirector(telegramId) {
  await pool.query(
    `INSERT INTO bot_users (telegram_id, role, display_name, status)
     VALUES ($1, 'director', 'Директор', 'active')
     ON CONFLICT (telegram_id) DO NOTHING`,
    [telegramId]
  );
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
    `SELECT manager_name AS name, COUNT(*)::int AS n, MIN(start_time) AS "firstCall"
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

// One manager's calls with transcripts in [start, end) — feeds the per-period AI analysis in the
// bot's "Статистика менеджера" / "Мій звіт" (analyze.js: analyzeManager). Same shape analyzeManager
// expects; same transcript filter as getOperatorStats so counts line up.
async function getOperatorCallsWithTranscripts(name, start, end) {
  const { rows } = await pool.query(
    `SELECT transcript, start_time AS "startTime", is_success AS "isSuccess",
            weakest_stage AS "weakestStage", communication_score AS "communicationScore"
     FROM calls
     WHERE manager_name = $1 AND start_time >= $2 AND start_time < $3
       AND transcript IS NOT NULL AND transcript <> ''
     ORDER BY start_time`,
    [name, start, end]
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

    -- Audience = which employee role a manual is FOR: 'mechanic' | 'manager' | 'both'. Filters KB
    -- answers so a mechanic never gets a manager's sales manual and vice versa (director/marketer
    -- see everything). NOT NULL DEFAULT 'mechanic' also backfills pre-existing rows to 'mechanic'
    -- (per the client's request that current files belong to mechanics).
    ALTER TABLE kb_docs ADD COLUMN IF NOT EXISTS audience TEXT NOT NULL DEFAULT 'mechanic';

    CREATE TABLE IF NOT EXISTS kb_chunks (
      id SERIAL PRIMARY KEY,
      doc_id INTEGER NOT NULL REFERENCES kb_docs(id) ON DELETE CASCADE,
      ord INTEGER NOT NULL,
      content TEXT NOT NULL,
      embedding vector(1536),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS kb_chunks_embedding_idx ON kb_chunks USING hnsw (embedding vector_cosine_ops);

    -- Page range a chunk came from (PDF only; NULL for DOCX/TXT which have no pages). Lets a KB
    -- answer cite the exact page(s). Chunks ingested before this column stay NULL (no page shown).
    ALTER TABLE kb_chunks ADD COLUMN IF NOT EXISTS page_start INTEGER;
    ALTER TABLE kb_chunks ADD COLUMN IF NOT EXISTS page_end INTEGER;
  `);
}

const vecToStr = (arr) => `[${arr.join(',')}]`;

async function insertKbDoc(filename, uploadedBy, fileId, mime, audience = 'mechanic') {
  const { rows } = await pool.query(
    'INSERT INTO kb_docs (filename, uploaded_by, file_id, mime, audience) VALUES ($1, $2, $3, $4, $5) RETURNING id',
    [filename, uploadedBy || null, fileId || null, mime || null, audience]
  );
  return rows[0].id;
}

// chunks: [{ ord, content, embedding: number[], pageStart?: number|null, pageEnd?: number|null }]
async function insertKbChunks(docId, chunks) {
  for (const c of chunks) {
    await pool.query(
      'INSERT INTO kb_chunks (doc_id, ord, content, embedding, page_start, page_end) VALUES ($1, $2, $3, $4::vector, $5, $6)',
      [docId, c.ord, c.content, vecToStr(c.embedding), c.pageStart ?? null, c.pageEnd ?? null]
    );
  }
  await pool.query('UPDATE kb_docs SET chunk_count = $2 WHERE id = $1', [docId, chunks.length]);
}

// audiences: null/undefined => search everything (director/marketer); an array (e.g.
// ['manager','both']) => only chunks from docs for that role, so KB answers never leak across roles.
// Returns chunkId (dedup across multi-query search), page range (source citation) and docId
// (deep-link to the original file) alongside the content.
async function searchKbChunks(queryEmbedding, k = 6, audiences = null) {
  const params = [vecToStr(queryEmbedding), k];
  let filter = '';
  if (audiences && audiences.length) {
    params.push(audiences);
    filter = `WHERE d.audience = ANY($3)`;
  }
  const { rows } = await pool.query(
    `SELECT c.id AS "chunkId", c.content, c.page_start AS "pageStart", c.page_end AS "pageEnd",
            d.filename, d.id AS "docId", (c.embedding <=> $1::vector) AS dist
     FROM kb_chunks c JOIN kb_docs d ON d.id = c.doc_id
     ${filter}
     ORDER BY c.embedding <=> $1::vector
     LIMIT $2`,
    params
  );
  return rows;
}

async function listKbDocs() {
  const { rows } = await pool.query(
    `SELECT id, filename, chunk_count AS "chunkCount", audience, created_at AS "createdAt"
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
    `SELECT id, filename, file_id AS "fileId", mime, chunk_count AS "chunkCount", audience, created_at AS "createdAt"
     FROM kb_docs WHERE id = $1`,
    [id]
  );
  return rows[0] || null;
}

async function setKbDocAudience(id, audience) {
  await pool.query('UPDATE kb_docs SET audience = $2 WHERE id = $1', [id, audience]);
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

async function deleteState(key) {
  await pool.query('DELETE FROM app_state WHERE key = $1', [key]);
}

// Analysis prompt (system instruction for the per-manager report / operator-quality analysis).
// Editable by the owner via the bot's /prompt flow; null when unset -> analyze.js falls back to
// its built-in default. Kept here (typed wrapper) like the other app_state keys.
async function getStoredAnalyzePrompt() {
  return getState('analyze_prompt');
}

async function setStoredAnalyzePrompt(text) {
  await setState('analyze_prompt', text);
}

async function clearStoredAnalyzePrompt() {
  await deleteState('analyze_prompt');
}

// Notification recipients (ingest failure alerts + daily PDF reports). Managed by admins in the
// bot's /settings screen and stored here as a JSON array of { id, name }: id is a Telegram chat id
// (a user who has started the bot, or a group), name is a human label shown in the settings list.
// Replaces the old single TELEGRAM_CHAT_ID / BOT_REPORT_CHAT_ID env vars — both are now lists so a
// message can fan out to several people. kind is 'alert' | 'report'.
async function getRecipients(kind) {
  const raw = await getState(`${kind}_recipients`);
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

async function addRecipient(kind, { id, name }) {
  const list = await getRecipients(kind);
  const sid = String(id);
  if (list.some((r) => String(r.id) === sid)) return list; // already a recipient, no duplicate
  list.push({ id: sid, name: name || sid });
  await setState(`${kind}_recipients`, JSON.stringify(list));
  return list;
}

async function removeRecipient(kind, id) {
  const sid = String(id);
  const list = (await getRecipients(kind)).filter((r) => String(r.id) !== sid);
  await setState(`${kind}_recipients`, JSON.stringify(list));
  return list;
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

// Kyiv-local times the daily PDF report fires at, managed by admins in /settings (was the
// BOT_REPORT_TIMES env var). Stored as a JSON array of canonical "HH:MM" strings. An ABSENT key
// falls back to the default (so behaviour is unchanged until edited); an explicitly stored empty
// array means "no scheduled reports". report.js reads this on every scheduler tick.
const DEFAULT_REPORT_TIMES = ['13:00', '19:30'];

async function getReportTimes() {
  const raw = await getState('report_times');
  if (raw == null) return [...DEFAULT_REPORT_TIMES];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [...DEFAULT_REPORT_TIMES];
  } catch {
    return [...DEFAULT_REPORT_TIMES];
  }
}

async function addReportTime(hhmm) {
  const list = await getReportTimes();
  if (list.includes(hhmm)) return list;
  list.push(hhmm);
  list.sort();
  await setState('report_times', JSON.stringify(list));
  return list;
}

async function removeReportTime(hhmm) {
  const list = (await getReportTimes()).filter((t) => t !== hhmm);
  await setState('report_times', JSON.stringify(list));
  return list;
}

export {
  migrate,
  callExists,
  saveCall,
  getOperatorRoster,
  getOperators,
  getOperatorStats,
  getOperatorCallsWithTranscripts,
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
  setKbDocAudience,
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
  getReportTimes,
  addReportTime,
  removeReportTime,
  getStoredAnalyzePrompt,
  setStoredAnalyzePrompt,
  clearStoredAnalyzePrompt,
  getRecipients,
  addRecipient,
  removeRecipient,
  normalizePhone,
  getBotUser,
  getBotUserById,
  getBotUsersByRole,
  upsertBotUserByTelegram,
  addPendingBotUser,
  activatePendingByPhone,
  setBotUserOperator,
  setBotUserPhone,
  deleteBotUser,
  seedDirector,
};
