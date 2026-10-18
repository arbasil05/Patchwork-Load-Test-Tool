'use strict';
/**
 * src/run-manager.js – Orchestrates the full lifecycle of a load-test run.
 *
 * Only one run may be active at a time. Concurrent run attempts get HTTP 409.
 *
 * Lifecycle states:
 *   starting  → k6 is being prepared
 *   submitting → k6 is running and sending requests
 *   waiting   → k6 exited; waiting for remaining callbacks within grace period
 *   done      → grace period elapsed or all callbacks received
 *   aborted   → k6 failed to start or crashed; lock released
 */

const { v4: uuidv4 } = require('uuid');
const db             = require('./database');
const { spawnK6 }    = require('./k6-runner');
const { calculateStats } = require('./statistics');
const { updateRunState, upsertJob, getJobsForRun, markMissingJobs } = require('./database');

// In-memory active-run reference
let activeRunId   = null;
let activeRunProc = null;
let graceTimer    = null;

function getActiveRunId() { return activeRunId; }

function isRunActive() {
  return activeRunId !== null;
}

/**
 * Create and launch a new run.
 * @param {object} config – validated run configuration
 * @returns {string} runId
 */
async function startRun(config) {
  if (isRunActive()) {
    const err = new Error('A run is already active');
    err.code  = 'RUN_ACTIVE';
    throw err;
  }

  const runId = uuidv4();
  const now   = Date.now();

  // Persist the run record
  db.createRun({
    run_id:            runId,
    label:             config.label || null,
    target_url:        config.target_url,
    callback_base_url: config.callback_base_url,
    concurrency:       config.concurrency,
    expected_exit_code: config.expected_exit_code ?? null,
    execution_mode:    config.execution_mode || null,
    grace_seconds:     config.grace_seconds,
    state:             'starting',
    created_at_ms:     now,
  });

  activeRunId = runId;

  // Transition to submitting once k6 starts
  db.updateRunState(runId, 'submitting', { started_at_ms: Date.now() });

  // Spawn k6
  const proc = spawnK6({
    runId,
    concurrency:     config.concurrency,
    targetUrl:       config.target_url,
    callbackBaseUrl: config.callback_base_url,
    payload:         config.payload,
    executionMode:   config.execution_mode || null,
    expectedExitCode: config.expected_exit_code ?? null,

    onEvent(eventType, data) {
      _handleK6Event(runId, eventType, data);
    },

    onExit(code, signal) {
      _handleK6Exit(runId, code, signal, config.grace_seconds);
    },

    onError(err) {
      console.error(`[run-manager] k6 spawn error for run ${runId}:`, err.message);
      db.updateRunState(runId, 'aborted', {
        finished_at_ms: Date.now(),
        error_detail: `k6 spawn failed: ${err.message}`,
      });
      activeRunId   = null;
      activeRunProc = null;
    },
  });

  if (!proc) {
    // Spawn returned null (error already handled in onError callback)
    // but ensure state is consistent
    if (activeRunId === runId) {
      db.updateRunState(runId, 'aborted', {
        finished_at_ms: Date.now(),
        error_detail: 'k6 process could not be started',
      });
      activeRunId   = null;
      activeRunProc = null;
    }
    const err = new Error('k6 process could not be started');
    err.code = 'K6_SPAWN_FAILED';
    throw err;
  }

  activeRunProc = proc;
  return runId;
}

/**
 * Process structured events emitted by k6 via stdout.
 */
function _handleK6Event(runId, eventType, data) {
  if (eventType === 'submission_started') {
    // Create/update the job record before the HTTP request is sent
    // This ensures the record exists even if the webhook arrives first.
    try {
      db.upsertJob({
        run_id:          runId,
        submission_id:   data.submission_id,
        idempotency_key: data.idempotency_key || data.submission_id,
        t_submit_ms:     data.t_submit_ms || null,
      });
    } catch (err) {
      console.error('[run-manager] upsertJob (started) failed:', err.message);
    }
  } else if (eventType === 'submission_response') {
    // Merge POST response details into the existing record
    try {
      db.upsertJob({
        run_id:           runId,
        submission_id:    data.submission_id,
        post_http_status: data.post_http_status !== undefined ? data.post_http_status : null,
        post_ms:          data.post_ms !== undefined ? data.post_ms : null,
      });
    } catch (err) {
      console.error('[run-manager] upsertJob (response) failed:', err.message);
    }
  }
}

/**
 * Handle k6 process exit – begin the grace period.
 */
function _handleK6Exit(runId, code, signal, graceSeconds) {
  if (activeRunId !== runId) return; // stale event

  db.updateRunState(runId, 'waiting');
  activeRunProc = null;

  console.log(`[run-manager] k6 done for run ${runId}. Grace period: ${graceSeconds}s`);

  // Check if all callbacks were already received before k6 exited
  maybeFinishEarly(runId);

  // If still active and waiting for callbacks, start grace timer
  if (activeRunId === runId) {
    graceTimer = setTimeout(() => {
      _finishRun(runId);
    }, graceSeconds * 1000);
  }
}

/**
 * Mark missing jobs and finalise statistics.
 */
function _finishRun(runId) {
  if (graceTimer) { clearTimeout(graceTimer); graceTimer = null; }

  try {
    db.markMissingJobs(runId);

    const jobs  = db.getJobsForRun(runId);
    const run   = db.getRun(runId);
    const stats = calculateStats(jobs, run);

    db.updateRunState(runId, 'done', {
      finished_at_ms: Date.now(),
      stats_json: JSON.stringify(stats),
    });
  } catch (err) {
    console.error('[run-manager] _finishRun error:', err.message);
    db.updateRunState(runId, 'done', {
      finished_at_ms: Date.now(),
      error_detail: `Finish error: ${err.message}`,
    });
  }

  if (activeRunId === runId) {
    activeRunId   = null;
    activeRunProc = null;
  }
}

/**
 * Externally trigger run completion (e.g. all callbacks received early).
 * MUST NOT finish early until k6 has completed AND all expected jobs have arrived or failed.
 */
function maybeFinishEarly(runId) {
  try {
    const run  = db.getRun(runId);
    if (!run || run.state !== 'waiting') return;

    const jobs = db.getJobsForRun(runId);
    // All requested concurrent submissions must be registered in the database
    if (jobs.length < run.concurrency) return;

    // Check if every job has concluded (either webhook arrived or HTTP POST failed)
    const pending = jobs.filter(j =>
      j.t_complete_ms === null &&
      j.completion_source === null &&
      !(j.post_http_status && (j.post_http_status < 200 || j.post_http_status >= 300))
    );

    if (pending.length === 0) {
      console.log(`[run-manager] All ${jobs.length} callbacks/outcomes received for run ${runId}, finishing early.`);
      _finishRun(runId);
    }
  } catch (err) {
    console.error('[run-manager] maybeFinishEarly error:', err.message);
  }
}

/**
 * Force-abort an active run (e.g. user request or server shutdown).
 */
function abortActiveRun(reason = 'manual abort') {
  if (!activeRunId) return;
  const runId = activeRunId;

  if (graceTimer) { clearTimeout(graceTimer); graceTimer = null; }
  if (activeRunProc) {
    try { activeRunProc.kill('SIGTERM'); } catch (_) {}
    activeRunProc = null;
  }

  db.updateRunState(runId, 'aborted', {
    finished_at_ms: Date.now(),
    error_detail:   reason,
  });

  activeRunId = null;
  console.log(`[run-manager] Run ${runId} aborted: ${reason}`);
}

module.exports = { startRun, abortActiveRun, maybeFinishEarly, getActiveRunId, isRunActive };
