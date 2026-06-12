'use strict';
const fs = require('node:fs');
const path = require('node:path');

// Error classes (design v4): SELECTOR_MISS, CONFLICT, AUTH, VERIFY_FAIL,
// IDENTITY_MISMATCH. Steps: navigated, identity_ok, filled, saved, verified.
const TERMINAL_OK = 'applied_verified';

class Journal {
  constructor(runDir) {
    this.file = path.join(runDir, 'journal.jsonl');
    this.entries = [];
    if (fs.existsSync(this.file)) {
      this.entries = fs.readFileSync(this.file, 'utf8')
        .split('\n').filter(Boolean).map((l) => JSON.parse(l));
    }
  }

  append(entry) {
    const row = Object.assign({ ts: new Date().toISOString() }, entry);
    this.entries.push(row);
    fs.appendFileSync(this.file, JSON.stringify(row) + '\n');
  }

  // Last status entry per record; resume always restarts an unfinished record
  // from navigate (Constraint Guardian finding 6).
  lastStatus(recordKey) {
    for (let i = this.entries.length - 1; i >= 0; i--) {
      if (this.entries[i].record === recordKey && this.entries[i].status) return this.entries[i];
    }
    return null;
  }

  isAppliedVerified(recordKey) {
    const last = this.lastStatus(recordKey);
    return last !== null && last.status === TERMINAL_OK;
  }

  // Done = applied; "applied_unverified" means the app's Success modal
  // confirmed the save but the lagging history view hadn't shown it yet.
  // Resume must skip these too — re-running would post a duplicate note.
  isDone(recordKey) {
    const last = this.lastStatus(recordKey);
    return last !== null && (last.status === TERMINAL_OK || last.status === 'applied_unverified');
  }
}

module.exports = { Journal, TERMINAL_OK };
