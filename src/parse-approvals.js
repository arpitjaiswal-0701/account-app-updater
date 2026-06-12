'use strict';
// Reads REVIEW-DIFF.md, extracts ticked rows (including inline-edited proposed
// values), and writes data/approved-plan.json — the only input apply.js
// accepts. Unticked rows never reach the apply stage.
const fs = require('node:fs');
const path = require('node:path');
const { ensureDirs, DATA_DIR } = require('./lib/paths');
const { loadUpdates, loadCurrentValues, loadFields } = require('./lib/config');
const { curHash, decodeVal } = require('./lib/values');

const ROW_RE = /^- \[(x|X| )\] \*\*(.+?)\*\* — current: `(.*?)` → proposed: `(.*?)` <!--row:(.+?)\|(.+?)\|([0-9a-f]+)-->\s*$/;

function main() {
  ensureDirs();
  const diffFile = path.join(DATA_DIR, 'REVIEW-DIFF.md');
  if (!fs.existsSync(diffFile)) throw new Error('REVIEW-DIFF.md not found — run "npm run diff" first.');
  const updates = loadUpdates();
  const current = loadCurrentValues();
  const fields = loadFields();
  const curByKey = new Map(current.records.map((r) => [r.key, r]));
  const recByKey = new Map(updates.records.map((r) => [r.key, r]));

  let approvedRows = 0, skippedRows = 0, malformed = 0, stale = 0;
  const plan = { createdAt: new Date().toISOString(), readAt: current.readAt, records: [] };
  const planByKey = new Map();

  for (const line of fs.readFileSync(diffFile, 'utf8').split('\n')) {
    if (!line.startsWith('- [')) continue;
    const m = line.match(ROW_RE);
    if (!m) { malformed++; console.log(`  [WARN] Unparseable row (edited too much?): ${line.slice(0, 100)}`); continue; }
    const [, tick, , , proposedRaw, recKey, fieldKey, rowHash] = m;
    if (tick === ' ') { skippedRows++; continue; }

    const rec = recByKey.get(recKey);
    const cur = curByKey.get(recKey);
    if (!rec || !cur || cur.error || !cur.fields[fieldKey]) { malformed++; continue; }

    // The tick was given against the current value embedded in the row's hash.
    // If current-values.json now holds a different value (a read pass ran after
    // the diff was generated), the reviewer approved against a snapshot they no
    // longer have — refuse the row rather than silently re-base expectedCurrent.
    if (curHash(cur.fields[fieldKey].current) !== rowHash) {
      stale++;
      console.log(`  [STALE] ${recKey}.${fieldKey}: current value changed since this diff was generated.`);
      continue;
    }

    // Toggles accept exactly "On" or "Off" — anything else (e.g. an inline
    // edit gone wrong) must not reach a click decision.
    const fdef = fields.find((x) => x.key === fieldKey);
    const proposed = decodeVal(proposedRaw);
    if (fdef && fdef.type === 'toggle' && proposed !== 'On' && proposed !== 'Off') {
      malformed++;
      console.log(`  [WARN] ${recKey}.${fieldKey}: toggle value must be "On" or "Off", got "${proposed}" — row ignored.`);
      continue;
    }

    if (!planByKey.has(recKey)) {
      const entry = { key: rec.key, name: rec.name, recordId: rec.recordId, url: rec.url, fields: {} };
      planByKey.set(recKey, entry);
      plan.records.push(entry);
    }
    planByKey.get(recKey).fields[fieldKey] = {
      // expectedCurrent enforces the never-overwrite-human-edits rule at apply
      // time (Skeptic finding 3 / conflict rule).
      expectedCurrent: cur.fields[fieldKey].current,
      proposed,
      source: (rec.fields[fieldKey] || {}).source || null,
    };
    approvedRows++;
  }

  if (stale > 0) {
    throw new Error(`${stale} approved row(s) are stale (current value changed since the diff was generated). Re-run "npm run diff", re-review, then approve again.`);
  }
  if (approvedRows === 0) throw new Error('No rows ticked — nothing to apply.');
  const file = path.join(DATA_DIR, 'approved-plan.json');
  fs.writeFileSync(file, JSON.stringify(plan, null, 2));
  console.log(`Approved: ${approvedRows} field changes across ${plan.records.length} records.`);
  console.log(`Not approved (left unticked): ${skippedRows}. Malformed rows ignored: ${malformed}. Stale: ${stale}.`);
  console.log(`Plan written to ${file}`);
  console.log('Next: npm run apply');
}

main();
