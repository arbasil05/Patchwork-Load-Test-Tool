'use strict';
/**
 * src/statistics.js – Per-run statistics calculation.
 *
 * Uses the nearest-rank method for percentiles:
 *   rank = ceil(p * N), 1-based index into sorted array.
 */

/**
 * Compute percentile using nearest-rank method.
 * @param {number[]} sorted - ascending sorted array of numbers
 * @param {number} p - percentile fraction, e.g. 0.95
 * @returns {number|null}
 */
function percentile(sorted, p) {
  if (!sorted || sorted.length === 0) return null;
  const rank = Math.ceil(p * sorted.length);          // 1-based rank
  return sorted[Math.min(rank, sorted.length) - 1];   // convert to 0-based index
}

/**
 * Compute median of a sorted array.
 * @param {number[]} sorted - ascending sorted array
 * @returns {number|null}
 */
function median(sorted) {
  if (!sorted || sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid];
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Compute arithmetic mean.
 * @param {number[]} values
 * @returns {number|null}
 */
function mean(values) {
  if (!values || values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/**
 * Round to 3 decimal places. Returns null for non-finite values.
 */
function r3(v) {
  if (v === null || v === undefined || !Number.isFinite(v)) return null;
  return Math.round(v * 1000) / 1000;
}

/**
 * Calculate full statistics for a completed run.
 *
 * @param {object[]} jobs - rows from the jobs table
 * @param {object}   run  - row from the runs table
 * @returns {object} statistics object (no NaN or Infinity values)
 */
function calculateStats(jobs, run) {
  const requested   = run ? run.concurrency : jobs.length;
  const submitted   = jobs.length;
  // A POST failure occurs when HTTP status is outside 2xx
  const postFailed  = jobs.filter(j => j.post_http_status && (j.post_http_status < 200 || j.post_http_status >= 300)).length;
  const webhooksReceived = jobs.filter(j => j.t_complete_ms !== null).length;

  const completed   = jobs.filter(j => j.t_complete_ms !== null && j.status !== null).length;
  // Failures include infrastructure failures (status === 'failed'/'error') and execution failures (exit_code !== 0)
  const failed      = jobs.filter(j =>
    j.t_complete_ms !== null && (
      j.status === 'failed' ||
      j.status === 'error' ||
      (j.exit_code !== null && j.exit_code !== 0)
    )
  ).length;

  const infrastructureFailed = jobs.filter(j =>
    j.t_complete_ms !== null && (
      j.status === 'failed' ||
      j.status === 'error' ||
      (j.status !== 'completed' && j.status !== 'done' && j.exit_code === null)
    )
  ).length;

  const missing     = jobs.filter(j => j.completion_source === 'missing').length;

  // Correctness: only evaluated when an expected exit code was specified
  let correct = null;
  if (run && run.expected_exit_code !== null && run.expected_exit_code !== undefined) {
    correct = jobs.filter(j => j.correct === 1).length;
  }

  // E2E latency sample – only accepted webhook callbacks with non-negative latency
  const e2eSample  = jobs
    .filter(j => j.e2e_ms !== null && j.e2e_ms >= 0 && j.t_complete_ms !== null)
    .map(j => j.e2e_ms)
    .sort((a, b) => a - b);

  // POST latency sample – all submissions that recorded a POST duration
  const postSample = jobs
    .filter(j => j.post_ms !== null && j.post_ms >= 0)
    .map(j => j.post_ms)
    .sort((a, b) => a - b);

  // Throughput: completed webhooks / (last_complete - first_submit) in seconds
  let throughput = null;
  const firstSubmit = jobs.reduce((min, j) => {
    const t = j.t_submit_ms;
    return (t && (min === null || t < min)) ? t : min;
  }, null) ?? (run && run.started_at_ms ? run.started_at_ms : null);

  const lastComplete = jobs.reduce((max, j) => {
    const t = j.t_complete_ms;
    return (t && (max === null || t > max)) ? t : max;
  }, null);

  if (firstSubmit !== null && lastComplete !== null && webhooksReceived > 0) {
    const durationSec = (lastComplete - firstSubmit) / 1000;
    if (durationSec > 0) {
      throughput = r3(webhooksReceived / durationSec);
    } else if (durationSec === 0) {
      // Completed in the same millisecond in mock/instant tests
      throughput = r3(webhooksReceived / 0.001);
    }
  }

  // Worker timing medians (from metadata_json)
  const timingKeys = [
    'queue_delay','container_acquire_time','container_create_time',
    'workspace_creation_time','execution_time','workspace_cleanup_time',
    'container_destroy_time','total_worker_time',
  ];
  const workerTimings = {};
  for (const key of timingKeys) {
    const vals = jobs
      .map(j => { try { return JSON.parse(j.metadata_json || '{}')[key]; } catch { return null; } })
      .filter(v => typeof v === 'number' && Number.isFinite(v))
      .sort((a, b) => a - b);
    workerTimings[key] = vals.length > 0 ? r3(median(vals)) : null;
  }

  return {
    requested,
    submitted,
    post_failed:            postFailed,
    webhooks_received:      webhooksReceived,
    completed,
    failed,
    infrastructure_failed:  infrastructureFailed,
    missing,
    correct,
    e2e_sample_count:       e2eSample.length,
    post_sample_count:      postSample.length,
    // POST latency (ms)
    post_mean_ms:           r3(mean(postSample)),
    post_median_ms:         r3(median(postSample)),
    // E2E latency (ms)
    e2e_mean_ms:            r3(mean(e2eSample)),
    e2e_median_ms:          r3(median(e2eSample)),
    e2e_p95_ms:             r3(percentile(e2eSample, 0.95)),
    e2e_p99_ms:             r3(percentile(e2eSample, 0.99)),
    e2e_min_ms:             e2eSample.length > 0 ? r3(e2eSample[0]) : null,
    e2e_max_ms:             e2eSample.length > 0 ? r3(e2eSample[e2eSample.length - 1]) : null,
    // Throughput
    throughput_jobs_per_sec: throughput,
    // Worker timings
    worker_timings:         workerTimings,
  };
}

module.exports = { percentile, median, mean, calculateStats };
