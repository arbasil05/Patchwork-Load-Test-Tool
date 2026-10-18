'use strict';
/**
 * src/migration.js – Database repairs and schema migrations for existing runs.
 *
 * Ensures:
 * 1. Existing jobs missing t_submit_ms recover it from callback_events query params (?t=).
 * 2. Fabricated exit_code 0 on infrastructure failures (where raw_body had exit_code: null) is restored to null.
 * 3. Latencies (e2e_ms) are recomputed accurately from valid timestamps.
 * 4. Stale/premature stats_json records on the runs table are recalculated from the full set of completed jobs.
 */

const { calculateStats } = require('./statistics');

/**
 * Run all migrations on the provided or default database connection.
 * @param {import('better-sqlite3').Database} db
 */
function runMigrations(db) {
  const runs = db.prepare('SELECT * FROM runs').all();
  if (!runs || runs.length === 0) return;

  const updateJobStmt = db.prepare(`
    UPDATE jobs SET
      t_submit_ms = COALESCE(t_submit_ms, @t_submit_ms),
      post_http_status = COALESCE(post_http_status, @post_http_status),
      exit_code = @exit_code,
      status = COALESCE(status, @status),
      e2e_ms = @e2e_ms,
      stderr = COALESCE(stderr, @stderr),
      updated_at_ms = @updated_at_ms
    WHERE run_id = @run_id AND submission_id = @submission_id
  `);

  const updateRunStatsStmt = db.prepare(`
    UPDATE runs SET stats_json = ? WHERE run_id = ?
  `);

  for (const run of runs) {
    const rawEvents = db.prepare('SELECT * FROM callback_events WHERE run_id = ?').all(run.run_id);
    const jobs = db.prepare('SELECT * FROM jobs WHERE run_id = ?').all(run.run_id);

    let runModified = false;

    for (const ev of rawEvents) {
      let query = {};
      let body = {};
      try { query = JSON.parse(ev.query_params || '{}'); } catch (_) {}
      try { body = JSON.parse(ev.raw_body || '{}'); } catch (_) {}

      const job = jobs.find(j => j.submission_id === ev.submission_id);
      if (!job) continue;

      const tSubmit = query.t ? Number(query.t) : null;
      const rawExitCode = body.exit_code;
      const trueExitCode = (rawExitCode !== undefined && rawExitCode !== null && rawExitCode !== '')
        ? Number(rawExitCode)
        : null;

      // Check if this job needs repair
      const needsSubmitRepair = job.t_submit_ms === null && tSubmit !== null;
      const needsExitCodeRepair = job.status === 'failed' && job.exit_code === 0 && rawExitCode === null;
      const needsE2eRepair = job.e2e_ms === null && job.t_complete_ms !== null && tSubmit !== null;

      if (needsSubmitRepair || needsExitCodeRepair || needsE2eRepair) {
        const finalTSubmit = job.t_submit_ms ?? tSubmit;
        const finalE2e = (job.t_complete_ms !== null && finalTSubmit !== null)
          ? (job.t_complete_ms - finalTSubmit)
          : job.e2e_ms;

        updateJobStmt.run({
          run_id:           run.run_id,
          submission_id:    ev.submission_id,
          t_submit_ms:      finalTSubmit,
          post_http_status: job.post_http_status ?? 202,
          exit_code:        needsExitCodeRepair ? null : job.exit_code,
          status:           job.status ?? body.status ?? null,
          e2e_ms:           finalE2e,
          stderr:           job.stderr ?? body.stderr ?? null,
          updated_at_ms:    Date.now(),
        });
        runModified = true;
      }
    }

    // Recalculate stats whenever freshStats differs from currentStats or jobs were modified
    const currentJobs = db.prepare('SELECT * FROM jobs WHERE run_id = ?').all(run.run_id);
    let currentStats = null;
    try { currentStats = run.stats_json ? JSON.parse(run.stats_json) : null; } catch (_) {}

    const freshStats = calculateStats(currentJobs, run);
    if (runModified || !currentStats || JSON.stringify(currentStats) !== JSON.stringify(freshStats)) {
      updateRunStatsStmt.run(JSON.stringify(freshStats), run.run_id);
      console.log(`[migration] Synchronized stats for run ${run.run_id}`);
    }
  }
}

module.exports = { runMigrations };
