/**
 * k6/vendor/uuid.js – UUID v4 generator compatible with the k6 JavaScript runtime.
 *
 * k6 uses a Go-based goja JS engine, which supports ES5+ but NOT Node.js APIs
 * (no crypto module, no require(), no Buffer, etc.).
 *
 * This implementation uses Math.random() for entropy, which is acceptable for
 * the purpose of generating unique idempotency keys in a load test.
 *
 * Format: xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx
 * where y is one of 8, 9, a, or b (RFC 4122 variant).
 *
 * NOTE: This file must use only ES5/ES6 syntax compatible with the k6 runtime.
 * Do not use Node.js require() or import from a CDN.
 */

export function uuidv4() {
  var hex = '0123456789abcdef';
  var result = '';
  var r;

  for (var i = 0; i < 32; i++) {
    r = Math.floor(Math.random() * 16);

    if (i === 8 || i === 12 || i === 16 || i === 20) {
      result += '-';
    }

    if (i === 12) {
      result += '4'; // version 4
    } else if (i === 16) {
      // variant: 10xx → 8, 9, a, b
      result += hex[(r & 0x3) | 0x8];
    } else {
      result += hex[r];
    }
  }

  return result;
}

/**
 * Verify a string matches the UUID v4 pattern.
 * Returns true for a valid UUID v4.
 */
export function isUUIDv4(str) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(str);
}
