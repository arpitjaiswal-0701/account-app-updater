'use strict';
const crypto = require('node:crypto');

// Shared by generate-diff.js and parse-approvals.js so hash/encoding can never drift.
function curHash(v) {
  return crypto.createHash('sha1').update(String(v ?? '')).digest('hex').slice(0, 10);
}

// Diff rows are single markdown lines; live values can contain newlines and
// backticks. Encode symmetrically so every value round-trips through
// REVIEW-DIFF.md regardless of content.
function encodeVal(v) {
  return String(v ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/`/g, '\\u0060');
}

function decodeVal(v) {
  return String(v ?? '').replace(/\\u0060|\\r|\\n|\\\\/g, (m) =>
    ({ '\\u0060': '`', '\\r': '\r', '\\n': '\n', '\\\\': '\\' }[m]));
}

// Type-aware comparison: rich-text editors normalize whitespace/line endings,
// so a byte-exact compare against the typed string false-fails after the
// content is already in place.
function normCompare(type, v) {
  let s = String(v ?? '').replace(/\r\n/g, '\n');
  if (type === 'richtext') {
    s = s.replace(/\u00a0/g, ' ').replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n');
  }
  return s.trim();
}

function valuesEqual(type, a, b) {
  return normCompare(type, a) === normCompare(type, b);
}

module.exports = { curHash, encodeVal, decodeVal, normCompare, valuesEqual };
