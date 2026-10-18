'use strict';
/**
 * test/webhook.test.js – Tests for the webhook handler and database layer.
 *
 * Uses an in-memory/temp SQLite database to avoid touching production data.
 */

const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path   = require('path');
const os     = require('os');
const fs     = require('fs');

// Use a unique temp DB for this test suite
const testDbPath = path.join(os.tmpdir(), `patchwork-test-webhook-${Date.now()}.sqlite`);
process.env.DB_PATH   = testDbPath;
process.env.MAX_CONCURRENCY = '500';

const db = require('../src/database');
const { validateCallbackParams } = require('../src/validation');

// ── Helper to simulate req/res for the webhook handler ───────────────────────
function makeReq(overrides = {}) {
  return {
    arrivalMs: Date.now(),
    query:  { run: 'run-1', submission: 'sub-1', t: String(Date.now() - 100), ...overrides.query },
    body:   { status: 'done', exit_code: 0, stdout: 'ok', stderr: '', job_id: 'job-abc', ...overrides.body },
    ...overrides,
  };
}

function makeRes() {
  let _status = 200;
  let _body   = null;
  return {
    status(s) { _status = s; return this; },
    json(b)   { _body   = b; return this; },
    send(b)   { _body   = b; return this; },
    get statusCode() { return _status; },
    get body()       { return _body; },
  };
}

before(() => {
  // Create the test run so foreign-key constraints are satisfied
  db.createRun({
    run_id:            'run-1',
    label:             'test',
    target_url:        'http://127.0.0.1:9999/v1/execute',
    callback_base_url: 'http://127.0.0.1:3000',
    concurrency:       1,
    expected_exit_code: 0,
    execution_mode:    null,
    grace_seconds:     30,
    state:             'waiting',
    created_at_ms:     Date.now(),
  });
});

after(() => {
  db.closeDb();
  try { fs.unlinkSync(testDbPath); } catch (_) {}
});

describe('validateCallbackParams', () => {
  // Test: Missing query parameters
  test('rejects missing run', () => {
    const r = validateCallbackParams({ submission: 'sub', t: '1000' });
    assert.equal(r.valid, false);
  });

  test('rejects missing submission', () => {
    const r = validateCallbackParams({ run: 'r1', t: '1000' });
    assert.equal(r.valid, false);
  });

  test('rejects missing t', () => {
    const r = validateCallbackParams({ run: 'r1', submission: 'sub' });
    assert.equal(r.valid, false);
  });
});

describe('webhook handler – database operations', () => {
  const { captureArrivalTime, handleCallback } = require('../src/webhook-handler');

  // Test: Valid callback persisted
  test('persists a valid callback result', async () => {
    const tBefore = Date.now();
    const req = makeReq({ query: { run: 'run-1', submission: 'sub-valid-1', t: String(tBefore - 500) } });
    const res = makeRes();

    // Pre-create the job so there's a record to merge into
    db.upsertJob({ run_id: 'run-1', submission_id: 'sub-valid-1', idempotency_key: 'sub-valid-1', t_submit_ms: tBefore - 500 });

    await handleCallback(req, res);
    assert.equal(res.statusCode, 200);

    const job = db.getJob('run-1', 'sub-valid-1');
    assert.ok(job, 'Job should exist');
    assert.ok(job.t_complete_ms !== null, 'Completion timestamp set');
    assert.ok(job.e2e_ms >= 0, 'e2e_ms should be non-negative');
    assert.equal(job.exit_code, 0);
  });

  // Test: Duplicate callback does not overwrite first result
  test('duplicate callback returns 200 but does not overwrite', async () => {
    const tSubmit = Date.now() - 1000;
    const req1 = makeReq({ query: { run: 'run-1', submission: 'sub-dup-1', t: String(tSubmit) } });
    req1.body = { status: 'done', exit_code: 0, job_id: 'job-first' };

    db.upsertJob({ run_id: 'run-1', submission_id: 'sub-dup-1', idempotency_key: 'sub-dup-1', t_submit_ms: tSubmit });

    const res1 = makeRes();
    await handleCallback(req1, res1);
    assert.equal(res1.statusCode, 200);

    // Send duplicate
    const req2 = makeReq({ query: { run: 'run-1', submission: 'sub-dup-1', t: String(tSubmit) } });
    req2.body = { status: 'done', exit_code: 99, job_id: 'job-second-SHOULD-NOT-OVERWRITE' };
    const res2 = makeRes();
    await handleCallback(req2, res2);

    // Response should indicate duplicate
    assert.equal(res2.body.status, 'duplicate');

    // Original result preserved
    const job = db.getJob('run-1', 'sub-dup-1');
    assert.equal(job.exit_code, 0, 'Original exit_code preserved');
  });

  // Test: Unknown run ID returns 404
  test('returns 404 for unknown run', async () => {
    const req = makeReq({ query: { run: 'run-unknown-xyz', submission: 'sub-1', t: String(Date.now()) } });
    const res = makeRes();
    await handleCallback(req, res);
    assert.equal(res.statusCode, 404);
  });

  // Test: End-to-end latency calculation
  test('calculates e2e latency correctly', async () => {
    const tSubmit = Date.now() - 1234;
    const req = makeReq({ query: { run: 'run-1', submission: 'sub-latency-1', t: String(tSubmit) } });
    req.arrivalMs = Date.now();

    db.upsertJob({ run_id: 'run-1', submission_id: 'sub-latency-1', idempotency_key: 'sub-latency-1', t_submit_ms: tSubmit });

    const res = makeRes();
    await handleCallback(req, res);

    const job = db.getJob('run-1', 'sub-latency-1');
    assert.ok(job, 'Job exists');
    const expectedE2e = req.arrivalMs - tSubmit;
    assert.ok(Math.abs(job.e2e_ms - expectedE2e) <= 5, `e2e_ms ${job.e2e_ms} should be close to ${expectedE2e}`);
  });

  // Test: Negative latency flagged (clock skew simulation)
  test('negative latency is set to null and flagged', async () => {
    // Simulate t in the future (t > arrival)
    const tFuture = Date.now() + 10000;
    const req = makeReq({ query: { run: 'run-1', submission: 'sub-neg-latency', t: String(tFuture) } });
    req.arrivalMs = Date.now(); // arrival is before tFuture → negative latency

    db.upsertJob({ run_id: 'run-1', submission_id: 'sub-neg-latency', idempotency_key: 'sub-neg-latency', t_submit_ms: tFuture });

    const res = makeRes();
    await handleCallback(req, res);

    // Should still return 200 (we accept the callback, but latency is null)
    assert.equal(res.statusCode, 200);
    const job = db.getJob('run-1', 'sub-neg-latency');
    assert.ok(job, 'Job exists');
    assert.equal(job.e2e_ms, null, 'Negative latency stored as null');
  });

  // Test: Missing body returns 400
  test('rejects null body', async () => {
    const req = makeReq();
    req.body = null;
    const res = makeRes();
    await handleCallback(req, res);
    assert.equal(res.statusCode, 400);
  });

  // Test: Early webhook arrival before POST-response event
  test('webhook arriving before POST-response can still be processed', async () => {
    const tSubmit = Date.now() - 200;
    // Webhook arrives WITHOUT a prior upsertJob (simulating extreme early arrival)
    const req = makeReq({ query: { run: 'run-1', submission: 'sub-early-webhook', t: String(tSubmit) } });
    req.arrivalMs = Date.now();

    const res = makeRes();
    await handleCallback(req, res);

    // Should succeed: upsert creates the record on first callback
    assert.equal(res.statusCode, 200);
    const job = db.getJob('run-1', 'sub-early-webhook');
    assert.ok(job, 'Job created by webhook');
    assert.ok(job.t_complete_ms !== null, 'Completion timestamp set');
  });
});

describe('database upsert – race condition handling', () => {
  // Test: POST-response event arrives after webhook
  test('merges POST-response into existing webhook record', () => {
    const runId = 'run-1';
    const subId = 'sub-race-test';
    const tSubmit = Date.now() - 500;
    const tComplete = Date.now() - 100;

    // Webhook arrives first
    db.upsertJob({
      run_id: runId, submission_id: subId, idempotency_key: subId,
      t_complete_ms: tComplete, e2e_ms: 400, status: 'done',
      exit_code: 0, completion_source: 'webhook',
    });

    // POST-response event arrives second
    db.upsertJob({
      run_id: runId, submission_id: subId,
      t_submit_ms: tSubmit, post_http_status: 202, post_ms: 25,
    });

    const job = db.getJob(runId, subId);
    assert.ok(job, 'Job exists');
    assert.equal(job.t_complete_ms, tComplete, 'Webhook data preserved');
    assert.equal(job.post_http_status, 202,    'POST data merged');
    assert.equal(job.post_ms, 25,              'POST duration merged');
    assert.equal(job.exit_code, 0,             'Exit code preserved');
  });

  // Test: Duplicate job record prevention
  test('UNIQUE constraint prevents two records for same (run, submission)', () => {
    const runId = 'run-1';
    const subId = 'sub-unique-test';

    db.upsertJob({ run_id: runId, submission_id: subId, idempotency_key: subId });
    db.upsertJob({ run_id: runId, submission_id: subId, idempotency_key: subId }); // should not throw

    const rows = db.getJobsForRun(runId).filter(j => j.submission_id === subId);
    assert.equal(rows.length, 1, 'Only one record for (run, submission)');
  });
});

describe('callback_events table', () => {
  test('records callback events including duplicates', () => {
    db.recordCallbackEvent({
      run_id:       'run-1',
      submission_id: 'sub-evt-1',
      arrived_at_ms: Date.now(),
      is_duplicate:  0,
      raw_body:      '{}',
      query_params:  '{}',
    });
    db.recordCallbackEvent({
      run_id:       'run-1',
      submission_id: 'sub-evt-1',
      arrived_at_ms: Date.now(),
      is_duplicate:  1,
      raw_body:      '{}',
      query_params:  '{}',
    });

    const dupCount = db.getDuplicateCount('run-1', 'sub-evt-1');
    assert.equal(dupCount, 1);
  });
});
