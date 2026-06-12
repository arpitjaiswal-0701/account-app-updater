'use strict';
const fs = require('node:fs');
const path = require('node:path');

// Plain-language end-of-run reconciliation (User Advocate finding 2). Buckets:
//   applied & verified           — change saved and re-read from a fresh load
//   failed before save           — no change was saved to this record
//   failed after save attempt    — Save was clicked but persistence is UNVERIFIED: check manually
//   skipped (conflict)           — someone changed the field since the read pass; untouched
//   skipped (identity mismatch)  — page did not match the expected account; untouched
//   not attempted                — run ended before reaching this record
function writeSummary(runDir, allRecords, journal) {
  const buckets = {
    ok: [], okUnverified: [], failedBeforeSave: [], failedAfterSave: [],
    conflict: [], identity: [], duplicate: [], notAttempted: [],
  };
  for (const rec of allRecords) {
    const last = journal.lastStatus(rec.key);
    if (!last) { buckets.notAttempted.push(rec); continue; }
    switch (last.status) {
      case 'applied_verified': buckets.ok.push(rec); break;
      case 'applied_unverified': buckets.okUnverified.push(rec); break;
      case 'skipped_duplicate': buckets.duplicate.push(rec); break;
      case 'failed_before_save': buckets.failedBeforeSave.push(rec); break;
      case 'failed_after_save': buckets.failedAfterSave.push(rec); break;
      case 'skipped_conflict': buckets.conflict.push(rec); break;
      case 'skipped_identity': buckets.identity.push(rec); break;
      default: buckets.notAttempted.push(rec);
    }
  }

  const li = (recs) => recs.length
    ? recs.map((r) => `  - ${r.name} (${r.recordId})`).join('\n')
    : '  - none';

  const md = `# Run summary — ${new Date().toISOString()}

| Outcome | Count |
|---|---|
| Applied & verified | ${buckets.ok.length} |
| Applied — app confirmed save; history view lagging (spot-check later) | ${buckets.okUnverified.length} |
| Failed before save (no change made) | ${buckets.failedBeforeSave.length} |
| Failed after save attempt (CHECK MANUALLY) | ${buckets.failedAfterSave.length} |
| Skipped — value changed since read pass (untouched) | ${buckets.conflict.length} |
| Skipped — wrong page identity (untouched) | ${buckets.identity.length} |
| Skipped — duplicate (this exact note already applied to this account) | ${buckets.duplicate.length} |
| Not attempted | ${buckets.notAttempted.length} |

## Applied & verified
${li(buckets.ok)}

## Applied — the app's Success dialog confirmed the save, but the history view hadn't refreshed yet (it lags; spot-check later)
${li(buckets.okUnverified)}

## Failed before save — nothing was saved (any typed-but-unsaved text was discarded by a reload)
${li(buckets.failedBeforeSave)}

## Failed after save attempt — open these records and check manually
${li(buckets.failedAfterSave)}

## Skipped (conflict — a human edited the field since the read pass; nothing overwritten)
${li(buckets.conflict)}

## Skipped (page identity mismatch — wrong record loaded; nothing touched)
${li(buckets.identity)}

## Skipped (duplicate — this exact note was already applied to this account; applied-ledger backstop. Use --allow-duplicates to force)
${li(buckets.duplicate)}

## Not attempted
${li(buckets.notAttempted)}

Technical detail: journal.jsonl in this folder. Screenshots in shots/.
`;
  const file = path.join(runDir, 'SUMMARY.md');
  fs.writeFileSync(file, md);
  return { file, md, buckets };
}

module.exports = { writeSummary };
