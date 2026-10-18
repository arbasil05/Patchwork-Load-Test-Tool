'use strict';
/**
 * src/validation.js – Input validation helpers used by the API layer and tests.
 */

const { MAX_CONCURRENCY } = require('./config');

/**
 * Validates a run-creation request body.
 * Returns { valid: true } or { valid: false, errors: string[] }.
 */
function validateRunRequest(body) {
  const errors = [];

  // target_url
  if (!body.target_url) {
    errors.push('target_url is required');
  } else if (!isValidHttpUrl(body.target_url)) {
    errors.push('target_url must be a valid http or https URL');
  }

  // payload
  if (body.payload === undefined || body.payload === null) {
    errors.push('payload is required');
  } else if (typeof body.payload !== 'object' || Array.isArray(body.payload)) {
    errors.push('payload must be a JSON object');
  }

  // concurrency
  const conc = body.concurrency;
  if (conc === undefined || conc === null) {
    errors.push('concurrency is required');
  } else if (!Number.isInteger(conc) || conc < 1 || conc > MAX_CONCURRENCY) {
    errors.push(`concurrency must be an integer between 1 and ${MAX_CONCURRENCY}`);
  }

  // callback_base_url
  if (!body.callback_base_url) {
    errors.push('callback_base_url is required');
  } else if (!isValidHttpUrl(body.callback_base_url)) {
    errors.push('callback_base_url must be a valid http or https URL');
  }

  // label (optional)
  if (body.label !== undefined && body.label !== null) {
    if (typeof body.label !== 'string' || body.label.length > 120) {
      errors.push('label must be a string of at most 120 characters');
    }
  }

  // grace_seconds
  const grace = body.grace_seconds;
  if (grace === undefined || grace === null) {
    errors.push('grace_seconds is required');
  } else if (!Number.isInteger(grace) || grace < 1 || grace > 3600) {
    errors.push('grace_seconds must be a positive integer up to 3600');
  }

  // expected_exit_code (optional: 0, 1, or null)
  if (body.expected_exit_code !== undefined && body.expected_exit_code !== null) {
    if (body.expected_exit_code !== 0 && body.expected_exit_code !== 1) {
      errors.push('expected_exit_code must be 0, 1, or null');
    }
  }

  // execution_mode (optional string)
  if (body.execution_mode !== undefined && body.execution_mode !== null) {
    if (typeof body.execution_mode !== 'string' || body.execution_mode.length > 64) {
      errors.push('execution_mode must be a string of at most 64 characters');
    }
  }

  return errors.length === 0 ? { valid: true } : { valid: false, errors };
}

/**
 * Validates callback query parameters.
 */
function validateCallbackParams(query) {
  const errors = [];

  if (!query.run)        errors.push('run query parameter is required');
  if (!query.submission) errors.push('submission query parameter is required');
  if (!query.t)          errors.push('t query parameter is required');

  if (query.t) {
    const t = Number(query.t);
    if (!Number.isFinite(t) || t <= 0) {
      errors.push('t must be a positive finite number');
    }
  }

  return errors.length === 0 ? { valid: true } : { valid: false, errors };
}

/**
 * Returns true when the string is a well-formed http or https URL.
 */
function isValidHttpUrl(str) {
  try {
    const u = new URL(str);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Returns true when the string matches the canonical UUID v4 pattern.
 */
function isUUIDv4(str) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(str);
}

module.exports = { validateRunRequest, validateCallbackParams, isValidHttpUrl, isUUIDv4 };
