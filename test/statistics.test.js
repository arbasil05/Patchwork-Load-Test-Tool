'use strict';
/**
 * test/statistics.test.js – Tests for src/statistics.js
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

process.env.DB_PATH = '/tmp/patchwork-test-stats.sqlite';

const { percentile, median, mean, calculateStats } = require('../src/statistics');

describe('percentile (nearest-rank)', () => {
  // Test 1: empty array
  test('returns null for empty array', () => {
    assert.equal(percentile([], 0.95), null);
  });

  // Test 2: single element
  test('returns the only element for any p', () => {
    assert.equal(percentile([42], 0.50), 42);
    assert.equal(percentile([42], 0.95), 42);
    assert.equal(percentile([42], 0.99), 42);
  });

  // Test 3: p95 with 20 elements
  test('p95 of [1..20] returns 19', () => {
    const arr = Array.from({ length: 20 }, (_, i) => i + 1); // [1..20]
    // rank = ceil(0.95 * 20) = 19, 0-based index 18 → value 19
    assert.equal(percentile(arr, 0.95), 19);
  });

  // Test 4: p99 with 100 elements
  test('p99 of [1..100] returns 99', () => {
    const arr = Array.from({ length: 100 }, (_, i) => i + 1);
    // rank = ceil(0.99 * 100) = 99, index 98 → value 99
    assert.equal(percentile(arr, 0.99), 99);
  });

  // Test 5: p50 (median via percentile)
  test('p50 of [1..10] returns 5', () => {
    const arr = [1,2,3,4,5,6,7,8,9,10];
    // rank = ceil(0.5 * 10) = 5, index 4 → value 5
    assert.equal(percentile(arr, 0.50), 5);
  });
});

describe('median', () => {
  test('returns null for empty', () => assert.equal(median([]), null));

  test('returns middle for odd count', () => {
    assert.equal(median([1,2,3,4,5]), 3);
  });

  test('averages two middle for even count', () => {
    assert.equal(median([1,2,3,4]), 2.5);
  });

  test('single element', () => assert.equal(median([7]), 7));
});

describe('mean', () => {
  test('returns null for empty', () => assert.equal(mean([]), null));
  test('calculates mean', () => assert.equal(mean([1,2,3,4,5]), 3));
  test('single element', () => assert.equal(mean([10]), 10));
});

describe('calculateStats', () => {
  function makeRun(overrides = {}) {
    return {
      concurrency: 5,
      expected_exit_code: null,
      ...overrides,
    };
  }

  function makeJob(overrides = {}) {
    return {
      run_id:           'r1',
      submission_id:    'sub-' + Math.random(),
      idempotency_key:  null,
      job_id:           null,
      t_submit_ms:      1000,
      post_http_status: 202,
      post_ms:          50,
      t_complete_ms:    2000,
      e2e_ms:           1000,
      status:           'done',
      exit_code:        0,
      correct:          null,
      completion_source: 'webhook',
      stdout:           '',
      stderr:           '',
      metadata_json:    '{}',
      created_at_ms:    1000,
      updated_at_ms:    2000,
      ...overrides,
    };
  }

  // Test 1: No NaN/Infinity in output
  test('no NaN or Infinity in JSON output', () => {
    const jobs = [makeJob(), makeJob(), makeJob()];
    const stats = calculateStats(jobs, makeRun({ concurrency: 3 }));
    const json = JSON.stringify(stats);
    assert.ok(!json.includes('NaN'),      'Should not contain NaN');
    assert.ok(!json.includes('Infinity'), 'Should not contain Infinity');
  });

  // Test 2: Correct job counts
  test('counts completed, missing, post_failed correctly', () => {
    const jobs = [
      makeJob({ t_complete_ms: 2000, e2e_ms: 1000 }),
      makeJob({ t_complete_ms: null, completion_source: 'missing', e2e_ms: null }),
      makeJob({ post_http_status: 500, t_complete_ms: null }),
    ];
    const stats = calculateStats(jobs, makeRun({ concurrency: 3 }));
    assert.equal(stats.completed, 1);
    assert.equal(stats.missing, 1);
    assert.equal(stats.post_failed, 1);
  });

  // Test 3: Missing callbacks do not contribute latency
  test('missing jobs excluded from e2e sample', () => {
    const jobs = [
      makeJob({ e2e_ms: null, t_complete_ms: null, completion_source: 'missing' }),
      makeJob({ e2e_ms: null, t_complete_ms: null, completion_source: 'missing' }),
    ];
    const stats = calculateStats(jobs, makeRun({ concurrency: 2 }));
    assert.equal(stats.e2e_sample_count, 0);
    assert.equal(stats.e2e_mean_ms, null);
    assert.equal(stats.e2e_p95_ms,  null);
  });

  // Test 4: Negative e2e excluded from primary sample
  test('negative e2e_ms excluded from sample', () => {
    const jobs = [
      makeJob({ e2e_ms: 1000 }),
      makeJob({ e2e_ms: -50 }),  // invalid – clock skew
    ];
    const stats = calculateStats(jobs, makeRun({ concurrency: 2 }));
    assert.equal(stats.e2e_sample_count, 1, 'Only non-negative e2e included');
    assert.equal(stats.e2e_mean_ms, 1000);
  });

  // Test 5: Correct exit-code comparison
  test('marks job correct when exit_code matches expected', () => {
    const jobs = [makeJob({ exit_code: 0, correct: 1 })];
    const stats = calculateStats(jobs, makeRun({ concurrency: 1, expected_exit_code: 0 }));
    assert.equal(stats.correct, 1);
  });

  // Test 6: Correctness null when no expected_exit_code
  test('correct is null when expected_exit_code is null', () => {
    const jobs = [makeJob({ exit_code: 0, correct: null })];
    const stats = calculateStats(jobs, makeRun({ concurrency: 1, expected_exit_code: null }));
    assert.equal(stats.correct, null);
  });

  // Test 7: Throughput calculation
  test('calculates throughput in jobs/sec', () => {
    const jobs = [
      makeJob({ t_submit_ms: 1000, t_complete_ms: 3000, e2e_ms: 2000 }),
      makeJob({ t_submit_ms: 1000, t_complete_ms: 3000, e2e_ms: 2000 }),
    ];
    const stats = calculateStats(jobs, makeRun({ concurrency: 2 }));
    // 2 completed / (3000 - 1000) ms = 2 / 2 sec = 1 job/sec
    assert.ok(stats.throughput_jobs_per_sec !== null);
    assert.equal(stats.throughput_jobs_per_sec, 1);
  });

  // Test 8: Throughput null when no completed jobs
  test('throughput is null when no webhooks received', () => {
    const jobs = [
      makeJob({ t_complete_ms: null, completion_source: 'missing', e2e_ms: null }),
    ];
    const stats = calculateStats(jobs, makeRun({ concurrency: 1 }));
    assert.equal(stats.throughput_jobs_per_sec, null);
  });

  // Test 9: P95 and P99 with specific values
  test('p95 and p99 computed correctly', () => {
    const latencies = [100,200,300,400,500,600,700,800,900,1000,
                       1100,1200,1300,1400,1500,1600,1700,1800,1900,2000];
    const jobs = latencies.map(e => makeJob({ e2e_ms: e, t_submit_ms: 0, t_complete_ms: e }));
    const stats = calculateStats(jobs, makeRun({ concurrency: 20 }));
    // p95: rank = ceil(0.95 * 20) = 19, value = 1900
    assert.equal(stats.e2e_p95_ms, 1900);
    // p99: rank = ceil(0.99 * 20) = 20, value = 2000
    assert.equal(stats.e2e_p99_ms, 2000);
  });

  // Test 10: Infrastructure failure detection (status = 'failed' with exit_code = null)
  test('counts infrastructure failures and excludes from correct jobs', () => {
    const jobs = [
      makeJob({ status: 'failed', exit_code: null, correct: 0, stderr: 'Failed to acquire container: Timeout' }),
      makeJob({ status: 'done', exit_code: 0, correct: 1 }),
    ];
    const stats = calculateStats(jobs, makeRun({ concurrency: 2, expected_exit_code: 0 }));
    assert.equal(stats.failed, 1);
    assert.equal(stats.infrastructure_failed, 1);
    assert.equal(stats.completed, 2);
    assert.equal(stats.correct, 1);
  });

  // Test 11: Throughput fallback to run.started_at_ms when t_submit_ms is missing
  test('calculates throughput using run.started_at_ms fallback when jobs lack t_submit_ms', () => {
    const jobs = [
      makeJob({ t_submit_ms: null, t_complete_ms: 5000, e2e_ms: 4000 }),
      makeJob({ t_submit_ms: null, t_complete_ms: 6000, e2e_ms: 5000 }),
    ];
    const run = makeRun({ concurrency: 2, started_at_ms: 1000 });
    const stats = calculateStats(jobs, run);
    // (6000 - 1000) = 5000ms = 5s. 2 webhooks / 5s = 0.4 jobs/sec
    assert.equal(stats.throughput_jobs_per_sec, 0.4);
  });
});
