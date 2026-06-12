'use strict';
// Programmatic approval: tick exactly the rows the skill approved (after the
// in-chat review gate) in data/REVIEW-DIFF.md, optionally overriding the
// proposed value where the user edited it in chat. EVERY other row is force-
// unticked so only approved rows can reach apply. The embedded row-hash is
// left untouched, so the existing "npm run approve" still enforces hash-
// staleness and toggle-value validation — no new trust surface.
//
// Input: data/approvals.json — an array, or { approve: [...] }:
//   [ { "key": "acme-corp", "field": "weeklyRemarks", "value": "optional override" } ]
const fs = require('node:fs');
const path = require('node:path');
const { DATA_DIR } = require('./lib/paths');
const { encodeVal } = require('./lib/values');

const DIFF = path.join(DATA_DIR, 'REVIEW-DIFF.md');
const APPROVALS = path.join(DATA_DIR, 'approvals.json');

// Capture groups: 1=prefix `- [`, 2=checkbox char, 3=label..proposed-open,
// 4=encoded proposed value, 5=close+row comment, 6=key, 7=field.
const ROW = /^(- \[)( |x|X)(\] \*\*.*?\*\* — current: `[^`]*` → proposed: `)([^`]*)(` <!--row:([^|]+)\|([^|]+)\|[0-9a-f]+-->)\s*$/;

function main() {
  if (!fs.existsSync(DIFF)) throw new Error('REVIEW-DIFF.md not found — run "npm run diff" first.');
  if (!fs.existsSync(APPROVALS)) throw new Error('data/approvals.json not found — the skill must write the approved rows there.');

  const raw = JSON.parse(fs.readFileSync(APPROVALS, 'utf8'));
  const list = Array.isArray(raw) ? raw : raw.approve;
  if (!Array.isArray(list)) throw new Error('approvals.json must be an array or { "approve": [...] }.');

  const want = new Map(); // "key|field" -> override value | undefined
  for (const a of list) {
    if (!a || !a.key || !a.field) throw new Error('each approval needs "key" and "field".');
    want.set(`${a.key}|${a.field}`, a.value);
  }

  const lines = fs.readFileSync(DIFF, 'utf8').split('\n');
  let ticked = 0, overridden = 0;
  const matchedIds = new Set();
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(ROW);
    if (!m) continue;
    const id = `${m[6]}|${m[7]}`;
    if (want.has(id)) {
      matchedIds.add(id);
      const ov = want.get(id);
      let proposed = m[4];
      if (ov !== undefined && ov !== null) {
        if (String(ov).includes('`')) throw new Error(`override for ${id} contains a backtick — not allowed.`);
        proposed = encodeVal(ov);
        overridden++;
      }
      lines[i] = `${m[1]}x${m[3]}${proposed}${m[5]}`;
      ticked++;
    } else {
      // Force-untick: guarantees only approved rows apply, even if a prior
      // generate-diff carried a tick over.
      lines[i] = `${m[1]} ${m[3]}${m[4]}${m[5]}`;
    }
  }

  fs.writeFileSync(DIFF, lines.join('\n'));
  const missing = [...want.keys()].filter((id) => !matchedIds.has(id));
  console.log(`Ticked ${ticked} row(s)${overridden ? `, ${overridden} with a value override` : ''}.`);
  if (missing.length) {
    console.log(`WARNING: ${missing.length} approved row(s) not found in the diff: ${missing.join(', ')}`);
  }
  console.log('Next: npm run approve');
}

main();
