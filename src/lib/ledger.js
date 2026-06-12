'use strict';
// Durable applied-ledger — the duplicate-apply backstop.
//
// The app clears the weekly-remarks textarea after submit and its history
// views lag minutes-to-hours, so a re-run's conflict check sees an EMPTY field
// and cannot tell "never written" from "already written". This ledger records
// every successful write (keyed by account + field + value-hash) in a file
// that survives run-retention purging, so re-applying the SAME note to the
// SAME account is caught and skipped. Applying DIFFERENT text to the same
// account is allowed (different hash).
const fs = require('node:fs');
const path = require('node:path');
const { ROOT } = require('./paths');
const { curHash } = require('./values');

const LEDGER_FILE = path.join(ROOT, 'applied-ledger.json');

function load() {
  if (!fs.existsSync(LEDGER_FILE)) return [];
  try { return JSON.parse(fs.readFileSync(LEDGER_FILE, 'utf8')); } catch { return []; }
}

// Has this exact (account key, field, proposed value) already been applied?
function wasApplied(key, field, proposed) {
  const h = curHash(proposed);
  return load().some((e) => e.key === key && e.field === field && e.valueHash === h
    && (e.status === 'applied_verified' || e.status === 'applied_unverified'));
}

// Append one entry per text field of a successfully-applied record. Toggles are
// excluded — their live state is readable, so the conflict rail already guards
// them; only the write-and-clear text fields need the ledger.
function recordApplied(rec, fields, status, runDir) {
  if (status !== 'applied_verified' && status !== 'applied_unverified') return;
  const ledger = load();
  const ts = new Date().toISOString();
  for (const [field, f] of Object.entries(rec.fields)) {
    const def = fields.find((x) => x.key === field);
    if (def && def.type === 'toggle') continue;
    ledger.push({
      key: rec.key, name: rec.name, field,
      valueHash: curHash(f.proposed),
      preview: String(f.proposed).slice(0, 60),
      status, appliedAt: ts, runDir: path.basename(runDir),
    });
  }
  fs.writeFileSync(LEDGER_FILE, JSON.stringify(ledger, null, 2));
}

module.exports = { LEDGER_FILE, wasApplied, recordApplied };
