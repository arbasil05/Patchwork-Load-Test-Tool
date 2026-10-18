/**
 * k6/burst.js – One-shot concurrent burst load test for Patchwork POST /v1/execute.
 *
 * Executor: per-vu-iterations
 *   vus        = N (from env)
 *   iterations = 1  (one request per virtual user)
 *
 * All VUs start simultaneously within the limitations of k6's scheduler and the
 * host system. True simultaneity cannot be guaranteed.
 *
 * Event protocol (stdout → Express):
 *   Each event is a single JSON line emitted via console.log().
 *   console.log() is routed to stdout via --console-output=stdout.
 *
 * Env variables read:
 *   TARGET_URL        – target HTTP endpoint
 *   CALLBACK_BASE_URL – base URL for webhook callbacks
 *   RUN_ID            – UUID of the current run
 *   N                 – number of concurrent virtual users
 *   PAYLOAD_FILE      – absolute path to the JSON payload template file
 *   EXECUTION_MODE    – optional, injected into payload if set
 *   EXPECTED_EXIT_CODE – optional, for documentation only
 */

import http from 'k6/http';
import { sleep } from 'k6';
import { SharedArray } from 'k6/data';
import { uuidv4 } from './vendor/uuid.js';

// ── Environment validation ────────────────────────────────────────────────────

const TARGET_URL        = __ENV.TARGET_URL;
const CALLBACK_BASE_URL = (__ENV.CALLBACK_BASE_URL || '').replace(/\/$/, '');
const RUN_ID            = __ENV.RUN_ID;
const N                 = parseInt(__ENV.N || '1', 10);
const PAYLOAD_FILE      = __ENV.PAYLOAD_FILE;
const EXECUTION_MODE    = __ENV.EXECUTION_MODE || null;

if (!TARGET_URL)        { throw new Error('TARGET_URL environment variable is required'); }
if (!CALLBACK_BASE_URL) { throw new Error('CALLBACK_BASE_URL environment variable is required'); }
if (!RUN_ID)            { throw new Error('RUN_ID environment variable is required'); }
if (!PAYLOAD_FILE)      { throw new Error('PAYLOAD_FILE environment variable is required'); }
if (isNaN(N) || N < 1) { throw new Error('N must be a positive integer'); }

// ── Load payload template from file ──────────────────────────────────────────
// SharedArray loads the file once and shares it across VUs (read-only).

const payloadTemplate = new SharedArray('payload', function () {
  const raw = open(PAYLOAD_FILE);
  return [JSON.parse(raw)]; // wrap in array; access as payloadTemplate[0]
});

// ── k6 executor options ───────────────────────────────────────────────────────

export const options = {
  scenarios: {
    burst: {
      executor:          'per-vu-iterations',
      vus:               N,
      iterations:        1,
      maxDuration:       '10m',   // hard ceiling to avoid hanging runs
      gracefulStop:      '30s',
    },
  },
  // Suppress default summary to keep stdout clean for event parsing
  summaryTrendStats: [],
};

// ── Default function: called once per VU ─────────────────────────────────────

export default function () {
  // 1. Generate a fresh UUID for this submission
  const submissionId = uuidv4();

  // 2. Deep-copy the template (do NOT mutate the shared object)
  const body = JSON.parse(JSON.stringify(payloadTemplate[0]));

  // 3. Capture submit time BEFORE constructing the callback URL
  //    (this will be embedded in the URL so Express can calculate e2e latency)
  const tSubmitMs = Date.now();

  // 4. Build callback URL
  //    Format: <CALLBACK_BASE_URL>/result?run=<RUN_ID>&submission=<UUID>&t=<ms>
  const callbackUrl = CALLBACK_BASE_URL + '/result'
    + '?run=' + encodeURIComponent(RUN_ID)
    + '&submission=' + encodeURIComponent(submissionId)
    + '&t=' + String(tSubmitMs);

  // 5. Inject idempotency_key and callback_url (mandatory overrides)
  body.idempotency_key = submissionId;
  body.callback_url    = callbackUrl;

  // 6. Optionally inject execution_mode if provided and not already set
  if (EXECUTION_MODE && body.execution_mode === undefined) {
    body.execution_mode = EXECUTION_MODE;
  }

  // 7. Emit submission_started BEFORE sending the request.
  //    Express must know about the submission before the callback can arrive.
  const startedEvent = {
    event:           'submission_started',
    run_id:          RUN_ID,
    submission_id:   submissionId,
    idempotency_key: submissionId,
    t_submit_ms:     tSubmitMs,
  };
  console.log(JSON.stringify(startedEvent));

  // 8. Send the POST request
  const startNs = Date.now(); // coarse pre-request timestamp (k6 ms precision)
  const response = http.post(
    TARGET_URL,
    JSON.stringify(body),
    {
      headers: {
        'Content-Type': 'application/json',
        'Accept':       'application/json',
      },
      timeout: '120s',   // generous timeout; jobs may be slow
    }
  );
  const postMs = Date.now() - startNs;

  // 9. Emit submission_response with POST outcome
  const responseEvent = {
    event:            'submission_response',
    run_id:           RUN_ID,
    submission_id:    submissionId,
    post_http_status: response.status,
    post_ms:          postMs,
  };
  console.log(JSON.stringify(responseEvent));

  // 10. Log non-2xx responses for debugging (goes to stderr via k6 runtime log)
  if (response.status < 200 || response.status >= 300) {
    const bodyPreview = response.body ? String(response.body).substring(0, 200) : '<empty body>';
    console.error(
      'Non-2xx response for submission ' + submissionId +
      ': HTTP ' + response.status +
      ' body=' + bodyPreview
    );
  }
}
