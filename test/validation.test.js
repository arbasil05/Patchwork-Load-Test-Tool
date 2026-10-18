'use strict';
/**
 * test/validation.test.js – Tests for src/validation.js
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

// Bootstrap config before requiring validation (so dotenv loads)
process.env.MAX_CONCURRENCY = process.env.MAX_CONCURRENCY || '500';
// Point DB_PATH to a temp location so tests don't create files in data/
process.env.DB_PATH = '/tmp/patchwork-test-validation.sqlite';

const { validateRunRequest, validateCallbackParams, isValidHttpUrl, isUUIDv4 } = require('../src/validation');

describe('validateRunRequest', () => {
  const base = {
    target_url:        'http://127.0.0.1:8000/v1/execute',
    payload:           { key: 'value' },
    concurrency:       5,
    callback_base_url: 'http://127.0.0.1:3000',
    grace_seconds:     30,
  };

  // Test 1: Valid request accepted
  test('accepts a valid request', () => {
    const r = validateRunRequest(base);
    assert.equal(r.valid, true, 'Should be valid');
  });

  // Test 2: Missing target_url
  test('rejects missing target_url', () => {
    const r = validateRunRequest({ ...base, target_url: undefined });
    assert.equal(r.valid, false);
    assert.ok(r.errors.some(e => e.includes('target_url')));
  });

  // Test 3: Invalid target_url (not http)
  test('rejects non-http target_url', () => {
    const r = validateRunRequest({ ...base, target_url: 'ftp://bad.example.com' });
    assert.equal(r.valid, false);
    assert.ok(r.errors.some(e => e.includes('target_url')));
  });

  // Test 4: Invalid target_url (malformed)
  test('rejects malformed target_url', () => {
    const r = validateRunRequest({ ...base, target_url: 'not-a-url' });
    assert.equal(r.valid, false);
  });

  // Test 5: Invalid JSON payload (array instead of object)
  test('rejects array as payload', () => {
    const r = validateRunRequest({ ...base, payload: [1, 2, 3] });
    assert.equal(r.valid, false);
    assert.ok(r.errors.some(e => e.includes('payload')));
  });

  // Test 6: Invalid JSON payload (string)
  test('rejects string as payload', () => {
    const r = validateRunRequest({ ...base, payload: 'hello' });
    assert.equal(r.valid, false);
  });

  // Test 7: concurrency below 1
  test('rejects concurrency = 0', () => {
    const r = validateRunRequest({ ...base, concurrency: 0 });
    assert.equal(r.valid, false);
    assert.ok(r.errors.some(e => e.includes('concurrency')));
  });

  // Test 8: concurrency above MAX
  test('rejects concurrency above MAX_CONCURRENCY', () => {
    const r = validateRunRequest({ ...base, concurrency: 501 });
    assert.equal(r.valid, false);
  });

  // Test 9: Non-integer concurrency
  test('rejects float concurrency', () => {
    const r = validateRunRequest({ ...base, concurrency: 1.5 });
    assert.equal(r.valid, false);
  });

  // Test 10: Invalid expected_exit_code
  test('rejects expected_exit_code = 2', () => {
    const r = validateRunRequest({ ...base, expected_exit_code: 2 });
    assert.equal(r.valid, false);
  });

  // Test 11: expected_exit_code = 0 accepted
  test('accepts expected_exit_code = 0', () => {
    const r = validateRunRequest({ ...base, expected_exit_code: 0 });
    assert.equal(r.valid, true);
  });

  // Test 12: expected_exit_code = 1 accepted
  test('accepts expected_exit_code = 1', () => {
    const r = validateRunRequest({ ...base, expected_exit_code: 1 });
    assert.equal(r.valid, true);
  });

  // Test 13: expected_exit_code = null accepted
  test('accepts expected_exit_code = null', () => {
    const r = validateRunRequest({ ...base, expected_exit_code: null });
    assert.equal(r.valid, true);
  });

  // Test 14: label too long
  test('rejects label longer than 120 chars', () => {
    const r = validateRunRequest({ ...base, label: 'x'.repeat(121) });
    assert.equal(r.valid, false);
  });

  // Test 15: grace_seconds = 0
  test('rejects grace_seconds = 0', () => {
    const r = validateRunRequest({ ...base, grace_seconds: 0 });
    assert.equal(r.valid, false);
  });

  // Test 16: grace_seconds too large
  test('rejects grace_seconds > 3600', () => {
    const r = validateRunRequest({ ...base, grace_seconds: 3601 });
    assert.equal(r.valid, false);
  });
});

describe('validateCallbackParams', () => {
  const base = { run: 'run-uuid', submission: 'sub-uuid', t: '1700000000000' };

  test('accepts valid params', () => {
    const r = validateCallbackParams(base);
    assert.equal(r.valid, true);
  });

  test('rejects missing run', () => {
    const r = validateCallbackParams({ ...base, run: undefined });
    assert.equal(r.valid, false);
  });

  test('rejects missing submission', () => {
    const r = validateCallbackParams({ ...base, submission: undefined });
    assert.equal(r.valid, false);
  });

  test('rejects missing t', () => {
    const r = validateCallbackParams({ ...base, t: undefined });
    assert.equal(r.valid, false);
  });

  test('rejects negative t', () => {
    const r = validateCallbackParams({ ...base, t: '-100' });
    assert.equal(r.valid, false);
  });

  test('rejects non-numeric t', () => {
    const r = validateCallbackParams({ ...base, t: 'abc' });
    assert.equal(r.valid, false);
  });
});

describe('isValidHttpUrl', () => {
  test('accepts http URL', () => assert.ok(isValidHttpUrl('http://example.com')));
  test('accepts https URL', () => assert.ok(isValidHttpUrl('https://example.com/path?q=1')));
  test('rejects ftp URL',  () => assert.ok(!isValidHttpUrl('ftp://example.com')));
  test('rejects bare string', () => assert.ok(!isValidHttpUrl('not-a-url')));
  test('rejects empty string', () => assert.ok(!isValidHttpUrl('')));
});

describe('isUUIDv4', () => {
  test('accepts valid UUID v4', () => {
    assert.ok(isUUIDv4('550e8400-e29b-41d4-a716-446655440000'.replace('41d4', '41d4')));
    // Use a known v4 UUID
    assert.ok(isUUIDv4('f47ac10b-58cc-4372-a567-0e02b2c3d479'));
  });

  test('rejects UUID v1', () => {
    // Version digit is 1, not 4
    assert.ok(!isUUIDv4('6ba7b810-9dad-11d1-80b4-00c04fd430c8'));
  });

  test('rejects empty string', () => assert.ok(!isUUIDv4('')));
  test('rejects random string', () => assert.ok(!isUUIDv4('not-a-uuid')));
  test('rejects UUID without dashes', () => assert.ok(!isUUIDv4('f47ac10b58cc4372a5670e02b2c3d479')));
});
