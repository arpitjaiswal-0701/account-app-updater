'use strict';
// Builds REVIEW-DIFF.md: per account+field, current value vs proposed value
// with provenance. The diff IS the approval surface — tick a row's checkbox
// to approve it; edit the proposed backtick value inline to override it
// (User Advocate finding 1). Diffing is deterministic string comparison;
// current values are never sent to the LLM (Constraint Guardian finding 4).
const fs = require('node:fs');
const path = require('node:path');
const { ensureDirs, DATA_DIR } = require('./lib/paths');
const { loadUpdates, loadCurrentValues, loadFields, hoursSince } = require('./lib/config');
const { curHash, encodeVal, decodeVal } = require('./lib/values');

const DIFF_FILE = path.join(DATA_DIR, 'REVIEW-DIFF.md');

// Approval carry-over (User Advocate finding 5): rows previously ticked stay
// ticked on regeneration IF the current value is unchanged (same hash) — and
// the user's last reviewed proposed value (including inline edits) is kept,
// so a regen can never re-attach their tick to wording they didn't approve.
function loadPriorApprovals() {
  const approved = new Map();
  if (!fs.existsSync(DIFF_FILE)) return approved;
  for (const line of fs.readFileSync(DIFF_FILE, 'utf8').split('\n')) {
    const m = line.match(/^- \[(x|X)\] .*→ proposed: `(.*?)` <!--row:(.+?)\|(.+?)\|([0-9a-f]+)-->/);
    if (m) approved.set(`${m[3]}|${m[4]}`, { hash: m[5], proposed: decodeVal(m[2]) });
  }
  return approved;
}

function main() {
  ensureDirs();
  const updates = loadUpdates();
  const current = loadCurrentValues();
  const fields = loadFields();
  const prior = loadPriorApprovals();

  const age = hoursSince(current.readAt);
  const curByKey = new Map(current.records.map((r) => [r.key, r]));

  let rows = 0, unchanged = 0, carried = 0;
  const sections = [];
  for (const rec of updates.records) {
    const cur = curByKey.get(rec.key);
    const lines = [`## ${rec.name} (${rec.recordId})`];
    if (!cur || cur.error) {
      lines.push(`> ⚠ Read pass failed for this record: ${cur ? cur.error : 'not read'} — no rows to approve.`);
      sections.push(lines.join('\n'));
      continue;
    }
    for (const [fieldKey, prop] of Object.entries(rec.fields || {})) {
      const f = fields.find((x) => x.key === fieldKey);
      const label = f ? f.label : fieldKey;
      const curVal = cur.fields[fieldKey] ? cur.fields[fieldKey].current : null;
      if (curVal === null || curVal === undefined) {
        lines.push(`> ⚠ ${label}: current value could not be read — row omitted.`);
        continue;
      }
      const hash = curHash(curVal);
      const priorRow = prior.get(`${rec.key}|${fieldKey}`);
      const wasApproved = priorRow !== undefined && priorRow.hash === hash;
      const proposed = wasApproved ? priorRow.proposed : prop.proposed;
      if (String(curVal).trim() === String(proposed).trim()) { unchanged++; continue; }
      if (wasApproved) carried++;
      rows++;
      lines.push(
        `- [${wasApproved ? 'x' : ' '}] **${label}** — current: \`${encodeVal(curVal)}\` → proposed: \`${encodeVal(proposed)}\` <!--row:${rec.key}|${fieldKey}|${hash}-->`
      );
      if (f && f.sideEffect) lines.push('  - ⚠ **side effect**: flipping this toggle starts/ends a real campaign on the account');
      if (prop.source) lines.push(`  - source: ${prop.source}`);
    }
    if (lines.length === 1) lines.push('_No changes needed — all proposed values already match._');
    sections.push(lines.join('\n'));
  }

  const md = `# Review diff — generated ${new Date().toISOString()}

Read pass: ${current.readAt} (${age.toFixed(1)}h ago${age > 24 ? ' — STALE, re-run "npm run read" before applying' : ''})

**How to review:** tick \`[x]\` on each row you approve. To override a value, edit the
text inside the *proposed* backticks. Unticked rows are never applied. Multi-line
values appear as \\n escapes — keep them escaped when editing. When done: \`npm run approve\`.

${sections.join('\n\n')}

---
${rows} rows to review (${carried} approvals carried over) · ${unchanged} fields already match and were omitted.
`;
  fs.writeFileSync(DIFF_FILE, md);
  console.log(`Wrote ${DIFF_FILE}`);
  console.log(`${rows} rows to review (${carried} carried over), ${unchanged} already match.`);
  console.log('Next: review/tick rows, then npm run approve');
}

main();
