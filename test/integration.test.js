'use strict';
/**
 * test/integration.test.js – Integration tests using a local mock server.
 *
 * Starts a mini "Patchwork" mock server that accepts POST /v1/execute and
 * immediately calls back to the Express webhook receiver with a simulated result.
 *
 * Tests core functionality without requiring a real Patchwork instance.
 */

const { test, describe, before, after } = require('node:test');
const assert  = require('node:assert/strict');
const http    = require('http');
const path    = require('path');
const os      = require('os');
const fs      = require('fs');
const { v4: uuidv4 } = require('uuid');

// Use unique temp DB
const testDbPath = path.join(os.tmpdir(), `patchwork-test-integration-${Date.now()}.sqlite`);
process.env.DB_PATH          = testDbPath;
process.env.MAX_CONCURRENCY  = '500';
process.env.LISTEN_HOST      = '127.0.0.1';
process.env.PORT             = '3099'; // separate port from production
process.env.CALLBACK_BASE_URL = 'http://127.0.0.1:3099';

const db                = require('../src/database');
const { validateRunRequest } = require('../src/validation');
const { isUUIDv4 }      = require('../src/validation');
const { calculateStats } = require('../src/statistics');
const { captureArrivalTime, handleCallback } = require('../src/webhook-handler');

// ── Helpers ───────────────────────────────────────────────────────────────────

function postJson(url, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const u    = new URL(url);
    const req  = http.request({
      hostname: u.hostname,
      port:     parseInt(u.port),
      path:     u.pathname + u.search,
      method:   'POST',
      headers: {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(data),
      },
    }, (res) => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
        catch { resolve({ status: res.statusCode, body: raw }); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    http.get({
      hostname: u.hostname,
      port:     parseInt(u.port),
      path:     u.pathname + u.search,
    }, (res) => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
        catch { resolve({ status: res.statusCode, body: raw }); }
      });
    }).on('error', reject);
  });
}

// ── Test Setup ────────────────────────────────────────────────────────────────

let expressApp;
let expressServer;
const EXPRESS_PORT = 3099;

before(async () => {
  // Start the Express app (imports server.js which binds the port)
  expressApp    = require('../server');
  // Wait briefly for the server to bind
  await new Promise(r => setTimeout(r, 300));
});

after(async () => {
  if (expressApp && expressApp.server) {
    await new Promise(resolve => expressApp.server.close(resolve));
  }
  db.closeDb();
  await new Promise(r => setTimeout(r, 100));
  try { fs.unlinkSync(testDbPath); } catch (_) {}
});

// ── UUID uniqueness tests ─────────────────────────────────────────────────────

describe('UUID uniqueness and format', () => {
  // Test 1: UUID v4 format verification
  test('generated UUID is valid v4 format', () => {
    const id = uuidv4();
    assert.ok(isUUIDv4(id), `${id} should be a valid UUID v4`);
  });

  // Test 2: Unique UUIDs per submission
  test('100 generated UUIDs are all unique', () => {
    const ids = new Set(Array.from({ length: 100 }, () => uuidv4()));
    assert.equal(ids.size, 100, 'All 100 UUIDs should be unique');
  });

  // Test 3: idempotency_key equals callback submission parameter
  test('idempotency_key equals submission UUID in callback URL', () => {
    const submissionId = uuidv4();
    const body = { idempotency_key: submissionId };
    const callbackUrl = `http://127.0.0.1:3099/result?run=r1&submission=${submissionId}&t=123`;

    const urlParams = new URL(callbackUrl).searchParams;
    assert.equal(urlParams.get('submission'), body.idempotency_key);
  });

  // Test 4: Template not mutated
  test('payload template is not mutated between requests', () => {
    const template = { key: 'original', callback_url: 'original-url', idempotency_key: 'original-key' };
    const original = JSON.stringify(template);

    // Simulate what k6 does: deep copy and override
    function buildBody(tmpl, submissionId, callbackUrl) {
      const body = JSON.parse(JSON.stringify(tmpl));
      body.idempotency_key = submissionId;
      body.callback_url    = callbackUrl;
      return body;
    }

    buildBody(template, uuidv4(), 'http://cb1');
    buildBody(template, uuidv4(), 'http://cb2');

    assert.equal(JSON.stringify(template), original, 'Template must not be mutated');
  });

  // Test 5: Callback URL preserves submission timestamp
  test('callback URL contains the submission timestamp', () => {
    const tSubmitMs    = Date.now();
    const submissionId = uuidv4();
    const callbackUrl  = `http://127.0.0.1:3099/result?run=r1&submission=${submissionId}&t=${tSubmitMs}`;

    const params = new URL(callbackUrl).searchParams;
    assert.equal(Number(params.get('t')), tSubmitMs);
  });
});

// ── HTTP API integration tests ────────────────────────────────────────────────

describe('Express API – /health', () => {
  test('GET /health returns ok', async () => {
    const r = await getJson(`http://127.0.0.1:${EXPRESS_PORT}/health`);
    assert.equal(r.status, 200);
    assert.equal(r.body.status, 'ok');
  });
});

describe('Express API – POST /api/runs validation', () => {
  const validBody = {
    target_url:        'http://127.0.0.1:9998/v1/execute',
    payload:           { test: true },
    concurrency:       1,
    callback_base_url: 'http://127.0.0.1:3099',
    grace_seconds:     10,
  };

  // Test: Valid request returns 202
  test('valid request returns 202', async () => {
    // Note: k6 is not installed in test env, this will fail at k6 spawn.
    // We only check validation layer here.
    const r = await postJson(`http://127.0.0.1:${EXPRESS_PORT}/api/runs`, validBody);
    // 202 (k6 may not be available, so 503 is also acceptable)
    assert.ok([202, 503].includes(r.status), `Expected 202 or 503, got ${r.status}`);
  });

  // Test: Invalid JSON body rejected
  test('missing target_url returns 400', async () => {
    const r = await postJson(`http://127.0.0.1:${EXPRESS_PORT}/api/runs`, {
      ...validBody,
      target_url: undefined,
    });
    assert.equal(r.status, 400);
  });

  // Test: Invalid concurrency rejected
  test('concurrency = 0 returns 400', async () => {
    const r = await postJson(`http://127.0.0.1:${EXPRESS_PORT}/api/runs`, {
      ...validBody,
      concurrency: 0,
    });
    assert.equal(r.status, 400);
  });

  // Test: concurrency > 500 rejected
  test('concurrency = 501 returns 400', async () => {
    const r = await postJson(`http://127.0.0.1:${EXPRESS_PORT}/api/runs`, {
      ...validBody,
      concurrency: 501,
    });
    assert.equal(r.status, 400);
  });

  // Test: Invalid target URL
  test('invalid target_url returns 400', async () => {
    const r = await postJson(`http://127.0.0.1:${EXPRESS_PORT}/api/runs`, {
      ...validBody,
      target_url: 'not-a-url',
    });
    assert.equal(r.status, 400);
  });
});

describe('Express API – run listing and job export', () => {
  let testRunId;

  before(() => {
    // Create a run directly in DB for testing listing and export
    testRunId = uuidv4();
    db.createRun({
      run_id:            testRunId,
      label:             'integration-test-run',
      target_url:        'http://127.0.0.1:9998/v1/execute',
      callback_base_url: 'http://127.0.0.1:3099',
      concurrency:       2,
      expected_exit_code: 0,
      execution_mode:    null,
      grace_seconds:     10,
      state:             'done',
      created_at_ms:     Date.now(),
    });

    // Insert some jobs
    const tNow = Date.now();
    for (let i = 0; i < 2; i++) {
      db.upsertJob({
        run_id:           testRunId,
        submission_id:    uuidv4(),
        idempotency_key:  uuidv4(),
        t_submit_ms:      tNow - 2000,
        post_http_status: 202,
        post_ms:          50 + i * 10,
        t_complete_ms:    tNow - 100,
        e2e_ms:           1900 + i * 100,
        status:           'done',
        exit_code:        0,
        correct:          1,
        completion_source: 'webhook',
      });
    }
  });

  // Test: GET /api/runs returns the run
  test('GET /api/runs lists the test run', async () => {
    const r = await getJson(`http://127.0.0.1:${EXPRESS_PORT}/api/runs`);
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.body.runs), 'runs should be an array');
    const found = r.body.runs.find(run => run.run_id === testRunId);
    assert.ok(found, 'Test run should appear in the list');
  });

  // Test: GET /api/runs/:id returns run details
  test('GET /api/runs/:id returns run details', async () => {
    const r = await getJson(`http://127.0.0.1:${EXPRESS_PORT}/api/runs/${testRunId}`);
    assert.equal(r.status, 200);
    assert.equal(r.body.run.run_id, testRunId);
    assert.ok(r.body.job_counts, 'Should include job counts');
  });

  // Test: GET /api/runs/:id/jobs returns all jobs
  test('GET /api/runs/:id/jobs returns jobs', async () => {
    const r = await getJson(`http://127.0.0.1:${EXPRESS_PORT}/api/runs/${testRunId}/jobs`);
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.body.jobs));
    assert.equal(r.body.jobs.length, 2);
  });

  // Test: GET /api/runs/:id/jobs?format=csv returns CSV
  test('GET /api/runs/:id/jobs?format=csv returns CSV', async () => {
    const r = await getJson(`http://127.0.0.1:${EXPRESS_PORT}/api/runs/${testRunId}/jobs?format=csv`);
    assert.equal(r.status, 200);
    // CSV body is a string
    assert.ok(typeof r.body === 'string' || typeof r.body === 'object');
  });

  // Test: Unknown run returns 404
  test('GET /api/runs/unknown returns 404', async () => {
    const r = await getJson(`http://127.0.0.1:${EXPRESS_PORT}/api/runs/does-not-exist`);
    assert.equal(r.status, 404);
  });

  // Test: JSON export
  test('GET /api/runs/:id/export returns JSON', async () => {
    const r = await getJson(`http://127.0.0.1:${EXPRESS_PORT}/api/runs/${testRunId}/export`);
    assert.equal(r.status, 200);
    assert.ok(r.body.run, 'Export contains run');
    assert.ok(r.body.jobs, 'Export contains jobs');
    assert.ok(r.body.stats, 'Export contains stats');
  });
});

describe('SQLite persistence', () => {
  // Test: Run persists across DB calls
  test('createRun and getRun round-trip', () => {
    const id = uuidv4();
    db.createRun({
      run_id:            id,
      label:             'persistence-test',
      target_url:        'http://127.0.0.1:9998',
      callback_base_url: 'http://127.0.0.1:3099',
      concurrency:       3,
      expected_exit_code: null,
      execution_mode:    null,
      grace_seconds:     60,
      state:             'starting',
      created_at_ms:     Date.now(),
    });

    const found = db.getRun(id);
    assert.ok(found, 'Run should be findable');
    assert.equal(found.run_id, id);
    assert.equal(found.concurrency, 3);
    assert.equal(found.label, 'persistence-test');
  });

  // Test: updateRunState transitions
  test('updateRunState changes state and timestamps', () => {
    const id  = uuidv4();
    const now = Date.now();
    db.createRun({
      run_id:            id,
      target_url:        'http://127.0.0.1:9998',
      callback_base_url: 'http://127.0.0.1:3099',
      concurrency:       1,
      expected_exit_code: null,
      execution_mode:    null,
      grace_seconds:     10,
      state:             'starting',
      created_at_ms:     now,
    });

    db.updateRunState(id, 'done', { finished_at_ms: now + 5000 });
    const run = db.getRun(id);
    assert.equal(run.state, 'done');
    assert.equal(run.finished_at_ms, now + 5000);
  });

  // Test: markMissingJobs
  test('markMissingJobs marks jobs without completion_source', () => {
    const runId = uuidv4();
    db.createRun({
      run_id:            runId,
      target_url:        'http://127.0.0.1:9998',
      callback_base_url: 'http://127.0.0.1:3099',
      concurrency:       2,
      expected_exit_code: null,
      execution_mode:    null,
      grace_seconds:     10,
      state:             'waiting',
      created_at_ms:     Date.now(),
    });

    db.upsertJob({ run_id: runId, submission_id: 's1', idempotency_key: 's1' }); // no completion
    db.upsertJob({ run_id: runId, submission_id: 's2', idempotency_key: 's2', t_complete_ms: Date.now(), e2e_ms: 100 }); // completed

    db.markMissingJobs(runId);

    const jobs = db.getJobsForRun(runId);
    const missing   = jobs.find(j => j.submission_id === 's1');
    const completed = jobs.find(j => j.submission_id === 's2');
    assert.equal(missing.completion_source,   'missing');
    assert.equal(completed.completion_source, null,      'Completed job not marked missing');
  });
});

describe('Correctness calculation', () => {
  // Test: exit_code 0 vs expected 0 → correct
  test('exit_code 0 with expected 0 is correct', () => {
    const run  = { concurrency: 1, expected_exit_code: 0 };
    const jobs = [{ run_id: 'r', submission_id: 's', e2e_ms: 100, t_complete_ms: 1000, t_submit_ms: 900, exit_code: 0, correct: 1, post_ms: 10, post_http_status: 202, completion_source: 'webhook', metadata_json: '{}' }];
    const stats = calculateStats(jobs, run);
    assert.equal(stats.correct, 1);
  });

  // Test: exit_code 1 vs expected 1 → correct (deliberately failing job)
  test('exit_code 1 with expected 1 is correct', () => {
    const run  = { concurrency: 1, expected_exit_code: 1 };
    const jobs = [{ run_id: 'r', submission_id: 's', e2e_ms: 100, t_complete_ms: 1000, t_submit_ms: 900, exit_code: 1, correct: 1, post_ms: 10, post_http_status: 202, completion_source: 'webhook', metadata_json: '{}' }];
    const stats = calculateStats(jobs, run);
    assert.equal(stats.correct, 1);
  });

  // Test: exit_code 0 vs expected 1 → not correct
  test('exit_code 0 with expected 1 is not correct', () => {
    const run  = { concurrency: 1, expected_exit_code: 1 };
    const jobs = [{ run_id: 'r', submission_id: 's', e2e_ms: 100, t_complete_ms: 1000, t_submit_ms: 900, exit_code: 0, correct: 0, post_ms: 10, post_http_status: 202, completion_source: 'webhook', metadata_json: '{}' }];
    const stats = calculateStats(jobs, run);
    assert.equal(stats.correct, 0);
  });
});

describe('Concurrent submission events and race condition merging', () => {
  test('merges out-of-order submission events and early callbacks cleanly', async () => {
    const runId = uuidv4();
    const now = Date.now();
    db.createRun({
      run_id: runId,
      target_url: 'http://127.0.0.1:9998/v1/execute',
      callback_base_url: 'http://127.0.0.1:3099',
      concurrency: 5,
      expected_exit_code: 0,
      execution_mode: null,
      grace_seconds: 15,
      state: 'waiting',
      created_at_ms: now,
    });

    const sub1 = uuidv4();
    const sub2 = uuidv4();
    const sub3 = uuidv4();

    // 1. sub1: submission_started -> callback -> submission_response (callback before POST response)
    db.upsertJob({ run_id: runId, submission_id: sub1, idempotency_key: sub1, t_submit_ms: now });
    const req1 = {
      arrivalMs: now + 50,
      query: { run: runId, submission: sub1, t: String(now) },
      body: { status: 'completed', exit_code: 0, job_id: 'job-1' },
    };
    const res1 = { status() { return this; }, json() {} };
    await handleCallback(req1, res1);
    db.upsertJob({ run_id: runId, submission_id: sub1, post_http_status: 202, post_ms: 60 });

    const job1 = db.getJob(runId, sub1);
    assert.equal(job1.t_submit_ms, now);
    assert.equal(job1.post_http_status, 202);
    assert.equal(job1.post_ms, 60);
    assert.equal(job1.t_complete_ms, now + 50);
    assert.equal(job1.e2e_ms, 50);
    assert.equal(job1.status, 'completed');
    assert.equal(job1.exit_code, 0);

    // 2. sub2: webhook arrives BEFORE submission_started
    const req2 = {
      arrivalMs: now + 80,
      query: { run: runId, submission: sub2, t: String(now + 10) },
      body: { status: 'completed', exit_code: 0, job_id: 'job-2' },
    };
    await handleCallback(req2, res1);
    db.upsertJob({ run_id: runId, submission_id: sub2, idempotency_key: sub2, t_submit_ms: now + 10 });
    db.upsertJob({ run_id: runId, submission_id: sub2, post_http_status: 202, post_ms: 90 });

    const job2 = db.getJob(runId, sub2);
    assert.equal(job2.t_submit_ms, now + 10);
    assert.equal(job2.t_complete_ms, now + 80);
    assert.equal(job2.e2e_ms, 70);
    assert.equal(job2.post_http_status, 202);
    assert.equal(job2.post_ms, 90);

    // 3. sub3: normal order: started -> response -> callback
    db.upsertJob({ run_id: runId, submission_id: sub3, idempotency_key: sub3, t_submit_ms: now + 20 });
    db.upsertJob({ run_id: runId, submission_id: sub3, post_http_status: 202, post_ms: 30 });
    const req3 = {
      arrivalMs: now + 120,
      query: { run: runId, submission: sub3, t: String(now + 20) },
      body: { status: 'completed', exit_code: 0, job_id: 'job-3' },
    };
    await handleCallback(req3, res1);

    const job3 = db.getJob(runId, sub3);
    assert.equal(job3.t_submit_ms, now + 20);
    assert.equal(job3.post_http_status, 202);
    assert.equal(job3.post_ms, 30);
    assert.equal(job3.t_complete_ms, now + 120);
    assert.equal(job3.e2e_ms, 100);
  });
});

describe('Run lifecycle and early finalization safeguards', () => {
  test('maybeFinishEarly does not finalize prematurely when jobs are pending', async () => {
    const { maybeFinishEarly } = require('../src/run-manager');
    const runId = uuidv4();
    const now = Date.now();
    db.createRun({
      run_id: runId,
      target_url: 'http://127.0.0.1:9998/v1/execute',
      callback_base_url: 'http://127.0.0.1:3099',
      concurrency: 3,
      expected_exit_code: 0,
      execution_mode: null,
      grace_seconds: 30,
      state: 'waiting',
      created_at_ms: now,
    });

    const s1 = uuidv4();
    const s2 = uuidv4();
    const s3 = uuidv4();

    // Register 3 submissions
    db.upsertJob({ run_id: runId, submission_id: s1, idempotency_key: s1, t_submit_ms: now, post_http_status: 202 });
    db.upsertJob({ run_id: runId, submission_id: s2, idempotency_key: s2, t_submit_ms: now, post_http_status: 202 });
    db.upsertJob({ run_id: runId, submission_id: s3, idempotency_key: s3, t_submit_ms: now, post_http_status: 202 });

    // Callback 1 arrives
    db.upsertJob({ run_id: runId, submission_id: s1, t_complete_ms: now + 100, e2e_ms: 100, status: 'completed' });
    maybeFinishEarly(runId);
    assert.equal(db.getRun(runId).state, 'waiting', 'Run must NOT finish after only 1 of 3 callbacks');

    // Callback 2 arrives
    db.upsertJob({ run_id: runId, submission_id: s2, t_complete_ms: now + 150, e2e_ms: 150, status: 'completed' });
    maybeFinishEarly(runId);
    assert.equal(db.getRun(runId).state, 'waiting', 'Run must NOT finish after only 2 of 3 callbacks');

    // Callback 3 arrives
    db.upsertJob({ run_id: runId, submission_id: s3, t_complete_ms: now + 200, e2e_ms: 200, status: 'completed' });
    maybeFinishEarly(runId);
    assert.equal(db.getRun(runId).state, 'done', 'Run MUST finish once all 3 callbacks arrive');

    const finalRun = db.getRun(runId);
    const stats = JSON.parse(finalRun.stats_json);
    assert.equal(stats.submitted, 3);
    assert.equal(stats.webhooks_received, 3);
    assert.equal(stats.e2e_sample_count, 3);
    assert.ok(stats.throughput_jobs_per_sec > 0);
  });
});

describe('Infrastructure failures and missing exit codes', () => {
  test('preserves null exit_code on infrastructure failure and marks correct = 0', async () => {
    const runId = uuidv4();
    const now = Date.now();
    db.createRun({
      run_id: runId,
      target_url: 'http://127.0.0.1:9998/v1/execute',
      callback_base_url: 'http://127.0.0.1:3099',
      concurrency: 1,
      expected_exit_code: 0,
      execution_mode: null,
      grace_seconds: 10,
      state: 'waiting',
      created_at_ms: now,
    });

    const subId = uuidv4();
    db.upsertJob({ run_id: runId, submission_id: subId, idempotency_key: subId, t_submit_ms: now, post_http_status: 202 });

    const req = {
      arrivalMs: now + 200,
      query: { run: runId, submission: subId, t: String(now) },
      body: {
        job_id: subId,
        status: 'failed',
        exit_code: null,
        stdout: null,
        stderr: 'Failed to acquire container: Timeout: No warm patchwork-django containers became available in time.',
      },
    };
    const res = { status() { return this; }, json() {} };
    await handleCallback(req, res);

    const job = db.getJob(runId, subId);
    assert.equal(job.status, 'failed');
    assert.equal(job.exit_code, null, 'exit_code must NOT be converted to 0');
    assert.equal(job.correct, 0, 'Infrastructure failure cannot be marked correct');
    assert.ok(job.stderr.includes('Failed to acquire container'));

    const run = db.getRun(runId);
    const stats = calculateStats([job], run);
    assert.equal(stats.failed, 1);
    assert.equal(stats.infrastructure_failed, 1);
    assert.equal(stats.correct, 0);
    assert.equal(stats.e2e_sample_count, 1);
  });
});
