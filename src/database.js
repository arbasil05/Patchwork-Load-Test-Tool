'use strict';
/**
 * src/database.js – SQLite persistence layer using better-sqlite3.
 *
 * All public functions are synchronous (better-sqlite3 is synchronous by design)
 * but are called from async Express handlers, so they should not block the event
 * loop for more than a few milliseconds each.
 */

const Database = require('better-sqlite3');
const path     = require('path');
const { DB_PATH } = require('./config');

let _db = null;

/**
 * Returns the singleton DB connection, creating it on first call.
 */
function getDb() {
  if (_db) return _db;
  _db = new Database(DB_PATH);
  _db.pragma('journal_mode = WAL');
  _db.pragma('synchronous = NORMAL');
  _db.pragma('foreign_keys = ON');
  _applyMigrations(_db);
  return _db;
}

/**
 * Idempotent schema creation / migration.
 */
function _applyMigrations(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS runs (
      run_id             TEXT PRIMARY KEY,
      label              TEXT,
      target_url         TEXT NOT NULL,
      callback_base_url  TEXT NOT NULL,
      concurrency        INTEGER NOT NULL,
      expected_exit_code INTEGER,
      execution_mode     TEXT,
      grace_seconds      INTEGER NOT NULL,
      state              TEXT NOT NULL DEFAULT 'starting',
      created_at_ms      INTEGER NOT NULL,
      started_at_ms      INTEGER,
      finished_at_ms     INTEGER,
      -- final statistics (stored as JSON for flexibility)
      stats_json         TEXT,
      error_detail       TEXT
    );

    CREATE TABLE IF NOT EXISTS jobs (
      id                      INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id                  TEXT NOT NULL,
      submission_id           TEXT NOT NULL,
      idempotency_key         TEXT NOT NULL,
      job_id                  TEXT,
      t_submit_ms             INTEGER,
      post_http_status        INTEGER,
      post_ms                 REAL,
      t_complete_ms           INTEGER,
      e2e_ms                  REAL,
      status                  TEXT,
      exit_code               INTEGER,
      correct                 INTEGER,   -- 1 true, 0 false, NULL unknown
      completion_source       TEXT,      -- 'webhook' | 'missing'
      stdout                  TEXT,
      stderr                  TEXT,
      metadata_json           TEXT,
      created_at_ms           INTEGER NOT NULL,
      updated_at_ms           INTEGER NOT NULL,
      UNIQUE(run_id, submission_id)
    );

    CREATE TABLE IF NOT EXISTS callback_events (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id          TEXT NOT NULL,
      submission_id   TEXT NOT NULL,
      arrived_at_ms   INTEGER NOT NULL,
      is_duplicate    INTEGER NOT NULL DEFAULT 0,
      raw_body        TEXT,
      query_params    TEXT
    );
  `);

  try {
    const { runMigrations } = require('./migration');
    runMigrations(db);
  } catch (err) {
    console.error('[database] Migration error:', err.message);
  }
}

// ── Runs ─────────────────────────────────────────────────────────────────────

function createRun(run) {
  const db = getDb();
  db.prepare(`
    INSERT INTO runs
      (run_id, label, target_url, callback_base_url, concurrency,
       expected_exit_code, execution_mode, grace_seconds, state, created_at_ms)
    VALUES
      (@run_id, @label, @target_url, @callback_base_url, @concurrency,
       @expected_exit_code, @execution_mode, @grace_seconds, @state, @created_at_ms)
  `).run({
    run_id:             run.run_id,
    label:              run.label ?? null,
    target_url:         run.target_url,
    callback_base_url:  run.callback_base_url,
    concurrency:        run.concurrency,
    expected_exit_code: run.expected_exit_code ?? null,
    execution_mode:     run.execution_mode ?? null,
    grace_seconds:      run.grace_seconds,
    state:              run.state ?? 'starting',
    created_at_ms:      run.created_at_ms ?? Date.now(),
  });
}

function updateRunState(runId, state, extra = {}) {
  const db = getDb();
  const sets = ['state = @state'];
  const params = { run_id: runId, state };

  if (extra.started_at_ms !== undefined) { sets.push('started_at_ms = @started_at_ms'); params.started_at_ms = extra.started_at_ms; }
  if (extra.finished_at_ms !== undefined){ sets.push('finished_at_ms = @finished_at_ms'); params.finished_at_ms = extra.finished_at_ms; }
  if (extra.stats_json !== undefined)    { sets.push('stats_json = @stats_json'); params.stats_json = extra.stats_json; }
  if (extra.error_detail !== undefined)  { sets.push('error_detail = @error_detail'); params.error_detail = extra.error_detail; }

  db.prepare(`UPDATE runs SET ${sets.join(', ')} WHERE run_id = @run_id`).run(params);
}

function getRun(runId) {
  return getDb().prepare('SELECT * FROM runs WHERE run_id = ?').get(runId) || null;
}

function listRuns(limit = 50) {
  return getDb().prepare('SELECT * FROM runs ORDER BY created_at_ms DESC LIMIT ?').all(limit);
}

// ── Jobs ─────────────────────────────────────────────────────────────────────

/**
 * Upsert a job record. Creates it if it doesn't exist, merges supplied fields
 * into the existing row if it does.
 *
 * This handles the race condition where a webhook arrives before the k6
 * POST-response event is processed.
 */
function upsertJob(fields) {
  const db  = getDb();
  const now = Date.now();

  // Try insert first
  const existing = db.prepare(
    'SELECT id FROM jobs WHERE run_id = ? AND submission_id = ?'
  ).get(fields.run_id, fields.submission_id);

  if (!existing) {
    db.prepare(`
      INSERT INTO jobs
        (run_id, submission_id, idempotency_key, job_id,
         t_submit_ms, post_http_status, post_ms,
         t_complete_ms, e2e_ms, status, exit_code, correct,
         completion_source, stdout, stderr, metadata_json,
         created_at_ms, updated_at_ms)
      VALUES
        (@run_id, @submission_id, @idempotency_key, @job_id,
         @t_submit_ms, @post_http_status, @post_ms,
         @t_complete_ms, @e2e_ms, @status, @exit_code, @correct,
         @completion_source, @stdout, @stderr, @metadata_json,
         @created_at_ms, @updated_at_ms)
    `).run({
      run_id:           fields.run_id         ?? null,
      submission_id:    fields.submission_id   ?? null,
      idempotency_key:  fields.idempotency_key ?? fields.submission_id ?? null,
      job_id:           fields.job_id          ?? null,
      t_submit_ms:      fields.t_submit_ms     ?? null,
      post_http_status: fields.post_http_status ?? null,
      post_ms:          fields.post_ms         ?? null,
      t_complete_ms:    fields.t_complete_ms   ?? null,
      e2e_ms:           fields.e2e_ms          ?? null,
      status:           fields.status          ?? null,
      exit_code:        fields.exit_code       ?? null,
      correct:          fields.correct         ?? null,
      completion_source: fields.completion_source ?? null,
      stdout:           fields.stdout          ?? null,
      stderr:           fields.stderr          ?? null,
      metadata_json:    fields.metadata_json   ?? null,
      created_at_ms:    now,
      updated_at_ms:    now,
    });
  } else {
    // Build a dynamic UPDATE with only the supplied non-null fields
    const updates = [];
    const params  = { run_id: fields.run_id, submission_id: fields.submission_id, updated_at_ms: now };

    const cols = [
      'job_id','t_submit_ms','post_http_status','post_ms',
      't_complete_ms','e2e_ms','status','exit_code','correct',
      'completion_source','stdout','stderr','metadata_json','idempotency_key',
    ];

    for (const col of cols) {
      if (fields[col] !== undefined && fields[col] !== null) {
        updates.push(`${col} = @${col}`);
        params[col] = fields[col];
      }
    }
    updates.push('updated_at_ms = @updated_at_ms');

    if (updates.length > 1) {
      db.prepare(`
        UPDATE jobs SET ${updates.join(', ')}
        WHERE run_id = @run_id AND submission_id = @submission_id
      `).run(params);
    }
  }
}

function getJob(runId, submissionId) {
  return getDb().prepare(
    'SELECT * FROM jobs WHERE run_id = ? AND submission_id = ?'
  ).get(runId, submissionId) || null;
}

function getJobsForRun(runId) {
  return getDb().prepare(
    'SELECT * FROM jobs WHERE run_id = ? ORDER BY t_submit_ms ASC'
  ).all(runId);
}

function markMissingJobs(runId) {
  const db  = getDb();
  const now = Date.now();
  db.prepare(`
    UPDATE jobs SET completion_source = 'missing', updated_at_ms = ?
    WHERE run_id = ? AND t_complete_ms IS NULL AND completion_source IS NULL
  `).run(now, runId);
}

// ── Callback events ───────────────────────────────────────────────────────────

function recordCallbackEvent(evt) {
  getDb().prepare(`
    INSERT INTO callback_events
      (run_id, submission_id, arrived_at_ms, is_duplicate, raw_body, query_params)
    VALUES
      (@run_id, @submission_id, @arrived_at_ms, @is_duplicate, @raw_body, @query_params)
  `).run({
    run_id:        evt.run_id,
    submission_id: evt.submission_id,
    arrived_at_ms: evt.arrived_at_ms,
    is_duplicate:  evt.is_duplicate ? 1 : 0,
    raw_body:      evt.raw_body ?? null,
    query_params:  evt.query_params ?? null,
  });
}

function closeDb() {
  if (_db) {
    try { _db.close(); } catch (_) {}
    _db = null;
  }
}

function getDuplicateCount(runId, submissionId) {
  const row = getDb().prepare(`
    SELECT COUNT(*) as cnt FROM callback_events
    WHERE run_id = ? AND submission_id = ? AND is_duplicate = 1
  `).get(runId, submissionId);
  return row ? row.cnt : 0;
}

function getRunCallbackStats(runId) {
  const row = getDb().prepare(`
    SELECT
      COUNT(*)                          AS total,
      SUM(CASE WHEN is_duplicate=1 THEN 1 ELSE 0 END) AS duplicates
    FROM callback_events WHERE run_id = ?
  `).get(runId);
  return row;
}

module.exports = {
  getDb,
  closeDb,
  createRun,
  updateRunState,
  getRun,
  listRuns,
  upsertJob,
  getJob,
  getJobsForRun,
  markMissingJobs,
  recordCallbackEvent,
  getDuplicateCount,
  getRunCallbackStats,
};
