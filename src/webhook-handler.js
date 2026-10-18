'use strict';
/**
 * src/webhook-handler.js – Express middleware and handler for POST /result.
 *
 * The request-arrival timestamp is captured at the very top of the handler,
 * before body parsing or database operations, to minimise measurement bias.
 */

const db = require('./database');
const { validateCallbackParams } = require('./validation');

const MAX_STDERR_DISPLAY = 300; // characters stored in `stderr` column
const MAX_FULL_STDERR    = 10_000; // characters to store in full; rest truncated

/**
 * Returns a middleware function that captures the arrival timestamp.
 * Attach this as the FIRST middleware on the /result route.
 */
function captureArrivalTime(req, _res, next) {
  req.arrivalMs = Date.now();
  next();
}

/**
 * Main callback handler: POST /result
 */
async function handleCallback(req, res) {
  // tComplete is set as early as possible before any async work
  const tCompleteMs = req.arrivalMs || Date.now();

  // 1. Validate query parameters
  const qv = validateCallbackParams(req.query);
  if (!qv.valid) {
    return res.status(400).json({ error: 'Invalid query parameters', details: qv.errors });
  }

  const runId       = req.query.run;
  const submissionId = req.query.submission;
  const tSubmitMs   = Number(req.query.t);

  // 2. Validate body
  if (!req.body || typeof req.body !== 'object') {
    return res.status(400).json({ error: 'Request body must be a JSON object' });
  }

  // 3. Check run exists
  const run = db.getRun(runId);
  if (!run) {
    return res.status(404).json({ error: `Unknown run: ${runId}` });
  }

  // 4. Record the raw callback event (always – before checking duplicates)
  let rawBody = null;
  try {
    rawBody = JSON.stringify(req.body);
  } catch (_) {}

  const queryParams = JSON.stringify(req.query);

  // 5. Check for duplicate (job already has t_complete_ms)
  const existingJob = db.getJob(runId, submissionId);
  const isDuplicate = existingJob && existingJob.t_complete_ms !== null;

  db.recordCallbackEvent({
    run_id:       runId,
    submission_id: submissionId,
    arrived_at_ms: tCompleteMs,
    is_duplicate:  isDuplicate ? 1 : 0,
    raw_body:      rawBody ? rawBody.substring(0, 8192) : null,
    query_params:  queryParams,
  });

  if (isDuplicate) {
    // Acknowledge but do not overwrite original result
    return res.status(200).json({ status: 'duplicate', message: 'Result already recorded' });
  }

  // 6. Parse the callback payload
  const body = req.body;

  // Calculate end-to-end latency
  let e2eMs = null;
  let validLatency = false;
  if (tSubmitMs !== null && Number.isFinite(tSubmitMs)) {
    e2eMs = tCompleteMs - tSubmitMs;
    validLatency = e2eMs >= 0;
    if (!validLatency) {
      console.warn(`[webhook] Negative latency for run=${runId} sub=${submissionId}: ${e2eMs}ms – likely clock skew`);
    }
  }

  // Extract fields from body (Patchwork API contract)
  const jobId    = body.job_id   || body.id   || null;
  const status   = body.status   || null;

  // Do NOT convert null or empty to 0; preserve null when no exit code was returned
  const rawExitCode = body.exit_code;
  const parsedExitCode = (rawExitCode !== undefined && rawExitCode !== null && rawExitCode !== '')
    ? Number(rawExitCode)
    : null;
  const cleanExitCode = (parsedExitCode !== null && Number.isFinite(parsedExitCode)) ? parsedExitCode : null;

  const stdout   = typeof body.stdout === 'string' ? body.stdout : null;
  const stderrFull = typeof body.stderr === 'string' ? body.stderr : null;
  const stderrShort = stderrFull ? stderrFull.substring(0, MAX_STDERR_DISPLAY) : null;

  // Correctness: evaluate only if expected_exit_code is specified
  let correct = null;
  if (run.expected_exit_code !== null && run.expected_exit_code !== undefined) {
    if (status === 'failed' || status === 'error' || cleanExitCode === null) {
      // Infrastructure failure or crashed before code execution
      correct = 0;
    } else {
      correct = cleanExitCode === run.expected_exit_code ? 1 : 0;
    }
  }

  // Extract metadata / worker timings
  const metadata = {};
  const timingKeys = [
    'queue_delay','container_acquire_time','container_create_time',
    'workspace_creation_time','execution_time','workspace_cleanup_time',
    'container_destroy_time','total_worker_time',
  ];
  for (const k of timingKeys) {
    if (body[k] !== undefined) metadata[k] = body[k];
  }
  // Also capture the full result metadata
  if (body.metadata && typeof body.metadata === 'object') {
    Object.assign(metadata, body.metadata);
  }

  // 7. Persist the result
  try {
    db.upsertJob({
      run_id:           runId,
      submission_id:    submissionId,
      idempotency_key:  submissionId,
      job_id:           jobId,
      t_submit_ms:      tSubmitMs,
      t_complete_ms:    tCompleteMs,
      e2e_ms:           validLatency ? e2eMs : null,
      status:           status,
      exit_code:        cleanExitCode,
      correct:          correct,
      completion_source: 'webhook',
      stdout:           stdout ? stdout.substring(0, 65535) : null,
      stderr:           stderrShort,
      metadata_json:    JSON.stringify(metadata),
    });

    // If callback arrived for a run that is already in 'done' state,
    // re-synchronize stats_json in SQLite
    if (run.state === 'done') {
      try {
        const { calculateStats } = require('./statistics');
        const allJobs = db.getJobsForRun(runId);
        const updatedStats = calculateStats(allJobs, run);
        db.updateRunState(runId, 'done', { stats_json: JSON.stringify(updatedStats) });
      } catch (_) {}
    }
  } catch (err) {
    console.error('[webhook] DB write failed:', err.message);
    return res.status(500).json({ error: 'Database write failed' });
  }

  // 8. Acknowledge promptly
  res.status(200).json({ status: 'ok', e2e_ms: validLatency ? e2eMs : null });
}

module.exports = { captureArrivalTime, handleCallback };
