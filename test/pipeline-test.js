'use strict';
// Offline regression test of the generate-diff -> parse-approvals round-trip,
// including multiline/backtick values, stale-hash rejection, and carry-over.
// WARNING: overwrites config/fields.json and the data/ working files - run only
// before real config exists, or back those up first.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { curHash } = require('../src/lib/values');

const ROOT = require('path').resolve(__dirname, '..');
const DATA = path.join(ROOT, 'data');
const run = (script) => execFileSync('node', [path.join(ROOT, 'src', script)], { encoding: 'utf8' });
const runFail = (script) => {
  try { execFileSync('node', [path.join(ROOT, 'src', script)], { encoding: 'utf8', stdio: 'pipe' }); return null; }
  catch (e) { return (e.stderr || '') + (e.stdout || ''); }
};
let failures = 0;
const assert = (cond, name) => { console.log((cond ? 'PASS' : 'FAIL') + ': ' + name); if (!cond) failures++; };

// Self-protect the REAL config: this test overwrites config/fields.json and
// the data/ working files; back them up and restore at exit.
const PROTECTED = [
  path.join(ROOT, 'config', 'fields.json'),
  ...['updates.json', 'current-values.json', 'REVIEW-DIFF.md', 'approved-plan.json', 'approvals.json'].map((f) => path.join(DATA, f)),
];
const backups = new Map();
for (const f of PROTECTED) if (fs.existsSync(f)) backups.set(f, fs.readFileSync(f));
process.on('exit', () => {
  for (const f of PROTECTED) {
    if (backups.has(f)) fs.writeFileSync(f, backups.get(f));
    else if (fs.existsSync(f)) fs.unlinkSync(f);
  }
});

// Fixtures — multiline + backtick current value to exercise the codec.
const multilineCur = 'Line one.\nLine `two` with backtick.';
const multilineProp = 'New line one.\nNew line two.';
fs.writeFileSync(path.join(ROOT, 'config', 'fields.json'), JSON.stringify([
  { key: 'accountNotes', label: 'Account Notes', type: 'richtext' },
  { key: 'renewalStage', label: 'Renewal Stage', type: 'select' },
], null, 2));
fs.writeFileSync(path.join(DATA, 'updates.json'), JSON.stringify({
  generatedAt: new Date().toISOString(),
  records: [{
    key: 'acme', name: 'Acme', recordId: 'ACC-1',
    fields: {
      accountNotes: { proposed: multilineProp, source: 'test' },
      renewalStage: { proposed: 'Negotiation', source: 'test' },
    },
  }],
}, null, 2));
fs.writeFileSync(path.join(DATA, 'current-values.json'), JSON.stringify({
  readAt: new Date().toISOString(),
  records: [{
    key: 'acme', name: 'Acme', recordId: 'ACC-1', identityOk: true, error: null,
    fields: { accountNotes: { current: multilineCur }, renewalStage: { current: 'Discovery' } },
  }],
}, null, 2));
if (fs.existsSync(path.join(DATA, 'REVIEW-DIFF.md'))) fs.unlinkSync(path.join(DATA, 'REVIEW-DIFF.md'));

// 1. Diff generation with multiline values stays single-line per row.
run('generate-diff.js');
const diff1 = fs.readFileSync(path.join(DATA, 'REVIEW-DIFF.md'), 'utf8');
const rowLines = diff1.split('\n').filter((l) => l.startsWith('- ['));
assert(rowLines.length === 2, 'multiline values emit exactly 2 single-line rows');
assert(rowLines[0].includes('\\n') && rowLines[0].includes('\\u0060'), 'newlines and backticks are escaped in the row');

// 2. Tick both rows, approve, check decode round-trip.
fs.writeFileSync(path.join(DATA, 'REVIEW-DIFF.md'), diff1.replace(/- \[ \]/g, '- [x]'));
run('parse-approvals.js');
const plan1 = JSON.parse(fs.readFileSync(path.join(DATA, 'approved-plan.json'), 'utf8'));
assert(plan1.records[0].fields.accountNotes.proposed === multilineProp, 'multiline proposed value round-trips exactly');
assert(plan1.records[0].fields.accountNotes.expectedCurrent === multilineCur, 'multiline expectedCurrent preserved');

// 3. Carry-over: regenerate diff, ticks survive, values intact.
run('generate-diff.js');
const diff2 = fs.readFileSync(path.join(DATA, 'REVIEW-DIFF.md'), 'utf8');
assert((diff2.match(/- \[x\]/g) || []).length === 2, 'both ticks carried over on regeneration');

// 4. Stale-hash rejection: change current value (new read pass), approve must throw.
const cv = JSON.parse(fs.readFileSync(path.join(DATA, 'current-values.json'), 'utf8'));
cv.records[0].fields.renewalStage.current = 'Closed Won';
cv.readAt = new Date().toISOString();
fs.writeFileSync(path.join(DATA, 'current-values.json'), JSON.stringify(cv, null, 2));
const staleOut = runFail('parse-approvals.js');
assert(staleOut !== null && /stale/i.test(staleOut), 'approve rejects rows whose current value changed since diff');

// 5. After re-running diff, the changed row is un-ticked; unchanged row keeps its tick.
run('generate-diff.js');
const diff3 = fs.readFileSync(path.join(DATA, 'REVIEW-DIFF.md'), 'utf8');
const stageRow = diff3.split('\n').find((l) => l.includes('renewalStage'));
const notesRow = diff3.split('\n').find((l) => l.includes('accountNotes'));
assert(stageRow.startsWith('- [ ]'), 'changed row lost its tick (must be re-reviewed)');
assert(notesRow.startsWith('- [x]'), 'unchanged row kept its tick');
assert(stageRow.includes('`Closed Won`'), 'changed row shows the NEW current value');
assert(stageRow.includes(curHash('Closed Won')), 'changed row hash matches new current value');

// 6. Toggle fields: On/Off round-trip, side-effect marker, bad-value rejection.
fs.writeFileSync(path.join(ROOT, 'config', 'fields.json'), JSON.stringify([
  { key: 'weeklyRemarks', label: 'Weekly Remarks', type: 'textarea' },
  { key: 'toggleCampA', label: 'Campaign: Example Campaign A', type: 'toggle', sideEffect: true },
], null, 2));
fs.writeFileSync(path.join(DATA, 'updates.json'), JSON.stringify({
  generatedAt: new Date().toISOString(),
  records: [{
    key: 'acme', name: 'Acme Corp', recordId: 'Acme Corp',
    fields: {
      weeklyRemarks: { proposed: 'Met L&D team.', source: 'test' },
      toggleCampA: { proposed: 'On', source: 'test' },
    },
  }],
}, null, 2));
fs.writeFileSync(path.join(DATA, 'current-values.json'), JSON.stringify({
  readAt: new Date().toISOString(),
  records: [{
    key: 'acme', name: 'Acme Corp', recordId: 'Acme Corp', identityOk: true, error: null,
    fields: { weeklyRemarks: { current: '' }, toggleCampA: { current: 'Off' } },
  }],
}, null, 2));
fs.unlinkSync(path.join(DATA, 'REVIEW-DIFF.md'));
run('generate-diff.js');
const diff4 = fs.readFileSync(path.join(DATA, 'REVIEW-DIFF.md'), 'utf8');
assert(diff4.includes('side effect'), 'toggle row carries the side-effect warning line');
fs.writeFileSync(path.join(DATA, 'REVIEW-DIFF.md'), diff4.replace(/- \[ \]/g, '- [x]'));
run('parse-approvals.js');
const plan2 = JSON.parse(fs.readFileSync(path.join(DATA, 'approved-plan.json'), 'utf8'));
assert(plan2.records[0].fields.toggleCampA.proposed === 'On', 'toggle On value round-trips');
assert(plan2.records[0].fields.toggleCampA.expectedCurrent === 'Off', 'toggle expectedCurrent preserved');

const diffBad = fs.readFileSync(path.join(DATA, 'REVIEW-DIFF.md'), 'utf8')
  .replace('proposed: `On`', 'proposed: `Maybe`');
fs.writeFileSync(path.join(DATA, 'REVIEW-DIFF.md'), diffBad);
const badOut = runFail('parse-approvals.js') || run('parse-approvals.js');
assert(/toggle value must be/i.test(badOut), 'invalid toggle value is rejected with a warning');

// 7. tick.js: programmatic approval. Two rows in the diff; approve only one,
// with a value override; the unapproved row must be force-unticked and the
// override must round-trip through approve into the plan.
fs.writeFileSync(path.join(ROOT, 'config', 'fields.json'), JSON.stringify([
  { key: 'weeklyRemarks', label: 'Weekly Remarks', type: 'textarea' },
], null, 2));
fs.writeFileSync(path.join(DATA, 'updates.json'), JSON.stringify({
  generatedAt: new Date().toISOString(),
  records: [
    { key: 'acme', name: 'Acme Corp', recordId: 'Acme Corp', fields: { weeklyRemarks: { proposed: 'Draft A.', source: 't' } } },
    { key: 'globex', name: 'Globex Industries', recordId: 'Globex Industries', fields: { weeklyRemarks: { proposed: 'Draft B.', source: 't' } } },
  ],
}, null, 2));
fs.writeFileSync(path.join(DATA, 'current-values.json'), JSON.stringify({
  readAt: new Date().toISOString(),
  records: [
    { key: 'acme', name: 'Acme Corp', recordId: 'Acme Corp', identityOk: true, error: null, fields: { weeklyRemarks: { current: '' } } },
    { key: 'globex', name: 'Globex Industries', recordId: 'Globex Industries', identityOk: true, error: null, fields: { weeklyRemarks: { current: '' } } },
  ],
}, null, 2));
fs.unlinkSync(path.join(DATA, 'REVIEW-DIFF.md'));
run('generate-diff.js');
// Approve only Acme, overriding its proposed text. (Globex left out.)
fs.writeFileSync(path.join(DATA, 'approvals.json'), JSON.stringify([
  { key: 'acme', field: 'weeklyRemarks', value: 'Overridden in chat.' },
]));
run('tick.js');
const diff7 = fs.readFileSync(path.join(DATA, 'REVIEW-DIFF.md'), 'utf8');
const amdRow = diff7.split('\n').find((l) => l.includes('row:acme|weeklyRemarks'));
const bitRow = diff7.split('\n').find((l) => l.includes('row:globex|weeklyRemarks'));
assert(amdRow.startsWith('- [x]'), 'tick: approved row is ticked');
assert(bitRow.startsWith('- [ ]'), 'tick: unapproved row is force-unticked');
assert(amdRow.includes('Overridden in chat.'), 'tick: value override written into the row');
run('parse-approvals.js');
const plan3 = JSON.parse(fs.readFileSync(path.join(DATA, 'approved-plan.json'), 'utf8'));
assert(plan3.records.length === 1 && plan3.records[0].key === 'acme', 'tick: only approved record reaches the plan');
assert(plan3.records[0].fields.weeklyRemarks.proposed === 'Overridden in chat.', 'tick: override round-trips into the plan');

// 8. applied-ledger: wasApplied is hash-exact and status-gated.
const { wasApplied, recordApplied, LEDGER_FILE } = require('../src/lib/ledger');
const ledgerBackup = fs.existsSync(LEDGER_FILE) ? fs.readFileSync(LEDGER_FILE) : null;
try {
  if (fs.existsSync(LEDGER_FILE)) fs.unlinkSync(LEDGER_FILE);
  const ledFields = [{ key: 'weeklyRemarks', label: 'Weekly Remarks', type: 'textarea' }];
  const rec = { key: 'acme', name: 'Acme Corp', fields: { weeklyRemarks: { proposed: 'Note one.' } } };
  assert(wasApplied('acme', 'weeklyRemarks', 'Note one.') === false, 'ledger: unseen note is not a duplicate');
  recordApplied(rec, ledFields, 'applied_verified', '/runs/x-apply');
  assert(wasApplied('acme', 'weeklyRemarks', 'Note one.') === true, 'ledger: applied note is recorded as duplicate');
  assert(wasApplied('acme', 'weeklyRemarks', 'Different note.') === false, 'ledger: different text for same account is NOT a duplicate');
  assert(wasApplied('globex', 'weeklyRemarks', 'Note one.') === false, 'ledger: same text for a different account is NOT a duplicate');
  recordApplied({ key: 'cbre', name: 'CBRE', fields: { weeklyRemarks: { proposed: 'X.' } } }, ledFields, 'failed_after_save', '/runs/x-apply');
  assert(wasApplied('cbre', 'weeklyRemarks', 'X.') === false, 'ledger: non-applied statuses are not recorded');
} finally {
  if (ledgerBackup) fs.writeFileSync(LEDGER_FILE, ledgerBackup);
  else if (fs.existsSync(LEDGER_FILE)) fs.unlinkSync(LEDGER_FILE);
}

// Cleanup: remove fixtures so the real config/data flow starts clean.
for (const f of ['updates.json', 'current-values.json', 'REVIEW-DIFF.md', 'approved-plan.json', 'approvals.json']) {
  try { fs.unlinkSync(path.join(DATA, f)); } catch {}
}
try { fs.unlinkSync(path.join(ROOT, 'config', 'fields.json')); } catch {}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
