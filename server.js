'use strict';
/**
 * server.js – Main Express application entry point.
 *
 * Serves:
 *   GET  /            → dashboard (public/index.html)
 *   POST /api/runs    → create and launch a new run
 *   GET  /api/runs    → list recent runs
 *   GET  /api/runs/:id           → run details + stats
 *   GET  /api/runs/:id/jobs      → all job records (JSON or CSV)
 *   GET  /api/runs/:id/export    → full run export (JSON)
 *   POST /result      → webhook callback receiver
 *   GET  /health      → health check
 */

const path    = require('path');
const express = require('express');
const { PORT, LISTEN_HOST, CALLBACK_BASE_URL, PROJECT_ROOT } = require('./src/config');
const db      = require('./src/database');
const { validateRunRequest } = require('./src/validation');
const { startRun, abortActiveRun, maybeFinishEarly, getActiveRunId, isRunActive } = require('./src/run-manager');
const { captureArrivalTime, handleCallback } = require('./src/webhook-handler');
const { calculateStats } = require('./src/statistics');

const app = express();

// ── Global middleware ─────────────────────────────────────────────────────────

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(PROJECT_ROOT, 'public')));

// ── Webhook callback receiver ─────────────────────────────────────────────────
// captureArrivalTime must be the FIRST handler on this route.

app.post('/result', captureArrivalTime, async (req, res) => {
  try {
    await handleCallback(req, res);
    // After persisting, try to finish the run early if all callbacks are in
    const runId = req.query.run;
    if (runId) setImmediate(() => maybeFinishEarly(runId));
  } catch (err) {
    console.error('[server] /result handler error:', err);
    if (!res.headersSent) res.status(500).json({ error: 'Internal server error' });
  }
});

// ── API routes ────────────────────────────────────────────────────────────────

// POST /api/runs – create and launch a new run
app.post('/api/runs', async (req, res) => {
  const vr = validateRunRequest(req.body);
  if (!vr.valid) {
    return res.status(400).json({ error: 'Validation failed', details: vr.errors });
  }

  if (isRunActive()) {
    return res.status(409).json({
      error: 'A run is already active',
      active_run_id: getActiveRunId(),
    });
  }

  try {
    const runId = await startRun(req.body);
    return res.status(202).json({ run_id: runId, status: 'starting' });
  } catch (err) {
    if (err.code === 'RUN_ACTIVE') {
      return res.status(409).json({ error: 'A run is already active' });
    }
    if (err.code === 'K6_SPAWN_FAILED') {
      return res.status(503).json({ error: 'k6 could not be started', detail: err.message });
    }
    console.error('[server] startRun error:', err);
    return res.status(500).json({ error: 'Failed to start run', detail: err.message });
  }
});

// GET /api/runs – list recent runs
app.get('/api/runs', (_req, res) => {
  try {
    const runs = db.listRuns(50);
    res.json({
      runs: runs.map(r => {
        const sr = serializeRun(r);
        if (!sr.stats) {
          const jobs = db.getJobsForRun(r.run_id);
          if (jobs.length > 0) sr.stats = calculateStats(jobs, r);
        }
        return sr;
      })
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/runs/:id – run details
app.get('/api/runs/:id', (req, res) => {
  try {
    const run = db.getRun(req.params.id);
    if (!run) return res.status(404).json({ error: 'Run not found' });

    const jobs = db.getJobsForRun(run.run_id);
    const cbStats = db.getRunCallbackStats(run.run_id);

    // Compute live stats from current jobs to ensure counts are always 100% consistent with detailed records
    const stats = jobs.length > 0 ? calculateStats(jobs, run) : (run.stats_json ? JSON.parse(run.stats_json) : null);

    res.json({
      run: serializeRun(run),
      stats,
      job_counts: {
        submitted:             jobs.length,
        completed:             jobs.filter(j => j.t_complete_ms !== null).length,
        missing:               jobs.filter(j => j.completion_source === 'missing').length,
        post_failed:           jobs.filter(j => j.post_http_status && (j.post_http_status < 200 || j.post_http_status >= 300)).length,
        failed:                jobs.filter(j => j.t_complete_ms !== null && (j.status === 'failed' || j.status === 'error' || (j.exit_code !== null && j.exit_code !== 0))).length,
        infrastructure_failed: jobs.filter(j => j.t_complete_ms !== null && (j.status === 'failed' || j.status === 'error' || (j.status !== 'completed' && j.status !== 'done' && j.exit_code === null))).length,
        webhooks_received:     jobs.filter(j => j.t_complete_ms !== null).length,
        duplicate_callbacks:   cbStats ? cbStats.duplicates : 0,
      },
    });
  } catch (err) {
    console.error('[server] GET /api/runs/:id error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/runs/:id/jobs – job records (JSON or CSV)
app.get('/api/runs/:id/jobs', (req, res) => {
  try {
    const run = db.getRun(req.params.id);
    if (!run) return res.status(404).json({ error: 'Run not found' });

    const jobs = db.getJobsForRun(run.run_id);

    if (req.query.format === 'csv') {
      const csv = jobsToCsv(jobs);
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="run-${run.run_id}-jobs.csv"`);
      return res.send(csv);
    }

    res.json({ jobs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/runs/:id/export – full run JSON export
app.get('/api/runs/:id/export', (req, res) => {
  try {
    const run = db.getRun(req.params.id);
    if (!run) return res.status(404).json({ error: 'Run not found' });

    const jobs  = db.getJobsForRun(run.run_id);
    const stats = jobs.length > 0 ? calculateStats(jobs, run) : (run.stats_json ? JSON.parse(run.stats_json) : null);

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="run-${run.run_id}-export.json"`);
    res.json({ run: serializeRun(run), stats, jobs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /health
app.get('/health', (_req, res) => {
  res.json({
    status:        'ok',
    active_run_id: getActiveRunId(),
    timestamp_ms:  Date.now(),
  });
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function serializeRun(run) {
  return {
    run_id:            run.run_id,
    label:             run.label,
    target_url:        run.target_url,
    callback_base_url: run.callback_base_url,
    concurrency:       run.concurrency,
    expected_exit_code: run.expected_exit_code,
    execution_mode:    run.execution_mode,
    grace_seconds:     run.grace_seconds,
    state:             run.state,
    created_at_ms:     run.created_at_ms,
    started_at_ms:     run.started_at_ms,
    finished_at_ms:    run.finished_at_ms,
    stats:             run.stats_json ? JSON.parse(run.stats_json) : null,
    error_detail:      run.error_detail,
  };
}

const CSV_COLS = [
  'run_id','submission_id','idempotency_key','job_id',
  't_submit_ms','post_http_status','post_ms',
  't_complete_ms','e2e_ms','status','exit_code','correct',
  'completion_source',
];

function jobsToCsv(jobs) {
  const header = CSV_COLS.join(',');
  const rows   = jobs.map(j =>
    CSV_COLS.map(col => {
      const v = j[col];
      if (v === null || v === undefined) return '';
      const s = String(v);
      return s.includes(',') || s.includes('"') || s.includes('\n')
        ? `"${s.replace(/"/g, '""')}"` : s;
    }).join(',')
  );
  return [header, ...rows].join('\n');
}

// ── Graceful shutdown ─────────────────────────────────────────────────────────

function shutdown(signal) {
  console.log(`\n[server] Received ${signal}, shutting down...`);
  abortActiveRun(`server shutdown (${signal})`);
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

// ── Start ─────────────────────────────────────────────────────────────────────

const server = app.listen(PORT, LISTEN_HOST, () => {
  console.log(`[server] Patchwork Load Tester running at http://${LISTEN_HOST}:${PORT}`);
  console.log(`[server] Callback base URL: ${CALLBACK_BASE_URL}`);
  console.log(`[server] Dashboard: http://127.0.0.1:${PORT}`);
});
app.server = server;

module.exports = app; // exported for tests
