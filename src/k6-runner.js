'use strict';
/**
 * src/k6-runner.js – Spawns k6 as a child process using child_process.spawn()
 * with an explicit argument array (no shell interpolation).
 *
 * Event communication strategy (verified against k6 behavior):
 *   k6 console.log() calls go to stdout when --console-output=stdout is used.
 *   We write structured JSON events there and parse them line-by-line.
 *   Diagnostics from the k6 runtime itself go to stderr.
 *
 * We also write events to a JSONL event file so Express can read them
 * even if stdout lines arrive in an unexpected order.
 */

const { spawn }   = require('child_process');
const fs          = require('fs');
const path        = require('path');
const readline    = require('readline');
const { v4: uuidv4 } = require('uuid');
const { K6_BIN, K6_SCRIPT, DATA_DIR } = require('./config');

/**
 * Writes a payload snapshot to disk and returns the absolute path.
 */
function writePayloadFile(runId, payload) {
  const filePath = path.join(DATA_DIR, `${runId}.payload.json`);
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf8');
  return filePath;
}

/**
 * Launches k6 and returns an EventEmitter-compatible object that emits:
 *   'submission_started'  – before each HTTP request
 *   'submission_response' – after each HTTP response
 *   'exit'               – when k6 exits
 *   'error'              – on spawn / stdio errors
 *
 * @param {object} opts
 * @param {string} opts.runId
 * @param {number} opts.concurrency
 * @param {string} opts.targetUrl
 * @param {string} opts.callbackBaseUrl
 * @param {object} opts.payload         - template payload object
 * @param {string} [opts.executionMode]
 * @param {number} [opts.expectedExitCode]
 * @param {function} opts.onEvent       - called with (eventType, data)
 * @param {function} opts.onExit        - called with (code, signal)
 * @param {function} [opts.onError]     - called with (err)
 */
function spawnK6(opts) {
  const {
    runId,
    concurrency,
    targetUrl,
    callbackBaseUrl,
    payload,
    executionMode,
    expectedExitCode,
    onEvent,
    onExit,
    onError,
  } = opts;

  // Write the payload template to disk
  const payloadFile = writePayloadFile(runId, payload);

  // Log file paths
  const stdoutLog = path.join(DATA_DIR, `${runId}.k6.stdout.log`);
  const stderrLog = path.join(DATA_DIR, `${runId}.k6.stderr.log`);
  const eventsLog = path.join(DATA_DIR, `${runId}.events.jsonl`);

  // Open log file streams
  const stdoutStream = fs.createWriteStream(stdoutLog, { flags: 'a' });
  const stderrStream = fs.createWriteStream(stderrLog, { flags: 'a' });
  const eventsStream = fs.createWriteStream(eventsLog, { flags: 'a' });

  // Build environment for k6
  const env = {
    ...process.env,
    TARGET_URL:        targetUrl,
    CALLBACK_BASE_URL: callbackBaseUrl.replace(/\/$/, ''),
    RUN_ID:            runId,
    N:                 String(concurrency),
    PAYLOAD_FILE:      payloadFile,
  };
  if (executionMode)                   env.EXECUTION_MODE    = executionMode;
  if (expectedExitCode !== undefined && expectedExitCode !== null) {
    env.EXPECTED_EXIT_CODE = String(expectedExitCode);
  }

  // Resolve k6 binary
  const k6Bin = K6_BIN;

  // Build argument array (no shell interpolation)
  const args = [
    'run',
    '--log-format=raw',          // raw log format ensures JSON console.log lines are emitted un-decorated
    '--no-usage-report',
    '--no-color',
    K6_SCRIPT,
  ];

  console.log(`[k6-runner] Spawning: ${k6Bin} ${args.join(' ')}`);

  let proc;
  try {
    proc = spawn(k6Bin, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    if (onError) onError(err);
    return null;
  }

  // ── Unified line handler for stdout & stderr: parse JSON events ──────────
  function handleStreamLine(line, isStderr) {
    if (isStderr) {
      stderrStream.write(line + '\n');
    } else {
      stdoutStream.write(line + '\n');
    }

    const trimmed = line.trim();
    if (trimmed.startsWith('{')) {
      try {
        const evt = JSON.parse(trimmed);
        if (evt && evt.event) {
          eventsStream.write(trimmed + '\n');
          if (onEvent) onEvent(evt.event, evt);
          return;
        }
      } catch (_) {
        // Not JSON event; proceed
      }
    }

    // Forward non-event stderr messages to console for diagnostics
    if (isStderr && trimmed.length > 0 && !trimmed.startsWith('{')) {
      process.stderr.write(`[k6-stderr] ${line}\n`);
    }
  }

  const rlOut = readline.createInterface({ input: proc.stdout, crlfDelay: Infinity });
  rlOut.on('line', (line) => handleStreamLine(line, false));

  const rlErr = readline.createInterface({ input: proc.stderr, crlfDelay: Infinity });
  rlErr.on('line', (line) => handleStreamLine(line, true));

  proc.on('error', (err) => {
    console.error('[k6-runner] spawn error:', err.message);
    stdoutStream.destroy();
    stderrStream.destroy();
    eventsStream.destroy();
    if (onError) onError(err);
  });

  proc.on('close', (code, signal) => {
    stdoutStream.end();
    stderrStream.end();
    eventsStream.end();
    console.log(`[k6-runner] k6 exited with code=${code} signal=${signal}`);
    if (onExit) onExit(code, signal);
  });

  return proc;
}

module.exports = { spawnK6, writePayloadFile };
