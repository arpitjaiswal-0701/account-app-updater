'use strict';
// Read pass (default mode): single-page model for the Power BI Account App.
// One entry into the All Accounts view, then per account: slicer-select →
// resolve the single visible card (identity rail) → read current remarks
// text + campaign toggle states for the review diff. Types nothing, submits
// nothing — only navigation chrome (slicer/entry) is clicked.
const fs = require('node:fs');
const path = require('node:path');
const { ensureDirs, newRunDir, DATA_DIR } = require('./lib/paths');
const { loadAppConfig, loadSelectors, loadFields, loadUpdates } = require('./lib/config');
const { onAuthPage, waitForUserAuth } = require('./lib/browser');
const { resolveStrict, readFieldValue } = require('./lib/locators');
const { KEYS, openApp, selectAccount, selectAllAccounts, resolveCard } = require('./lib/session');
const { readToggle } = require('./lib/powerapp');

async function main() {
  ensureDirs();
  const cfg = loadAppConfig();
  const selectors = loadSelectors();
  const fields = loadFields();
  const updates = loadUpdates();

  const records = updates.records.slice(0, cfg.limits.maxRecordsPerRun);
  if (updates.records.length > records.length) {
    console.log(`Capped at ${cfg.limits.maxRecordsPerRun} records per run; ${updates.records.length - records.length} dropped (split into another batch).`);
  }

  newRunDir('read'); // run marker for retention bookkeeping
  const session = await openApp(cfg, selectors);
  const { page } = session;
  const out = { readAt: new Date().toISOString(), records: [] };

  try {
    let preflightDone = false;
    for (const rec of records) {
      const entry = { key: rec.key, name: rec.name, recordId: rec.recordId, identityOk: false, fields: {}, error: null };
      out.records.push(entry);
      try {
        if (onAuthPage(page, cfg)) {
          const ok = await waitForUserAuth(page, cfg);
          if (!ok) throw new Error('Sign-in not completed within 10 minutes.');
          await session.reEnter();
        }

        const rt = await session.rt();
        await selectAccount(page, selectors, rec.name, rt);
        // Identity rail: name visible + exactly one visible card.
        const card = await resolveCard(rt, selectors, rec.name);
        entry.identityOk = true;

        // Pre-flight (Arbiter condition 2): on the first record the core
        // selectors must resolve, or the whole pass aborts.
        if (!preflightDone) {
          await resolveStrict(card, selectors[KEYS.WEEKLY_REMARKS], KEYS.WEEKLY_REMARKS);
          await resolveStrict(card, selectors[KEYS.ADD_NOTES], KEYS.ADD_NOTES);
          preflightDone = true;
          console.log('Pre-flight selector validation passed.');
        }

        for (const fieldKey of Object.keys(rec.fields || {})) {
          const f = fields.find((x) => x.key === fieldKey);
          if (!f) { entry.fields[fieldKey] = { current: null, error: `Field "${fieldKey}" not in fields.json` }; continue; }
          try {
            entry.fields[fieldKey] = {
              current: f.type === 'toggle'
                ? await readToggle(rt, f.campaign)
                : await readFieldValue(card, selectors[fieldKey], fieldKey, f.type),
            };
          } catch (err) {
            // e.g. a campaign this account doesn't have — row omitted in diff.
            entry.fields[fieldKey] = { current: null, error: err.message };
          }
        }
        const got = Object.values(entry.fields).filter((v) => v.error === undefined || v.error === null).length;
        console.log(`  [READ] ${rec.name} (${got}/${Object.keys(rec.fields || {}).length} fields)`);
      } catch (err) {
        if (err.fatal) throw err;
        entry.error = err.message;
        console.log(`  [FAIL] ${rec.name}: ${err.message}`);
        if (!preflightDone) throw new Error(`Pre-flight failed on first record — aborting read pass. ${err.message}`);
      }
    }
  } finally {
    await selectAllAccounts(page, selectors).catch(() => {});
    session.close();
  }

  fs.writeFileSync(path.join(DATA_DIR, 'current-values.json'), JSON.stringify(out, null, 2));
  console.log(`\nCurrent values captured for ${out.records.filter((r) => !r.error).length}/${records.length} records.`);
  console.log('Next: npm run diff');
}

main().catch((err) => { console.error(err.message); process.exit(1); });
