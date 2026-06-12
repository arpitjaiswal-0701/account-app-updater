'use strict';
// Enumerate the accounts the app shows in the "Account Name" slicer after
// "Access Accounts", and cache them to data/app-accounts.json. The exact app
// account names are cached nowhere else (alm-graph/accounts.yaml overlaps only
// a couple of them), so this live list is the source of truth the spot/bulk
// skills resolve names against.
const fs = require('node:fs');
const path = require('node:path');
const { ensureDirs, DATA_DIR } = require('./lib/paths');
const { loadAppConfig, loadSelectors } = require('./lib/config');
const { openApp, listAccounts, selectAllAccounts } = require('./lib/session');

async function main() {
  ensureDirs();
  const cfg = loadAppConfig();
  const selectors = loadSelectors();
  const session = await openApp(cfg, selectors);
  const { page } = session;
  try {
    const names = await listAccounts(page, selectors);
    if (names.length === 0) throw new Error('Enumerated 0 accounts — the slicer popup was not readable. Re-run, or confirm the All Accounts view loaded.');
    const out = { capturedAt: new Date().toISOString(), count: names.length, names };
    fs.writeFileSync(path.join(DATA_DIR, 'app-accounts.json'), JSON.stringify(out, null, 2));
    console.log(`Enumerated ${names.length} accounts:`);
    names.forEach((n) => console.log('  - ' + n));
    console.log('\nWritten to data/app-accounts.json');
  } finally {
    await selectAllAccounts(page, selectors).catch(() => {});
    session.close();
  }
}

main().catch((err) => { console.error(err.message); process.exit(1); });
