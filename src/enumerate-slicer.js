'use strict';
// One-off: enumerate every account in the slicer, dump to data/slicer-accounts.txt.
// Useful when a name in updates.json doesn't match the slicer text.
const fs = require('node:fs');
const path = require('node:path');
const { ensureDirs, DATA_DIR } = require('./lib/paths');
const { loadAppConfig, loadSelectors } = require('./lib/config');
const { openApp, listAccounts } = require('./lib/session');

async function main() {
  ensureDirs();
  const cfg = loadAppConfig();
  const selectors = loadSelectors();
  const session = await openApp(cfg, selectors);
  try {
    const names = await listAccounts(session.page, selectors);
    const outPath = path.join(DATA_DIR, 'slicer-accounts.txt');
    fs.writeFileSync(outPath, names.join('\n') + '\n');
    console.log(`Wrote ${names.length} account names to ${outPath}`);
    const needle = process.argv[2];
    if (needle) {
      console.log(`\nMatches for "${needle}":`);
      for (const n of names) if (n.toLowerCase().includes(needle.toLowerCase())) console.log(`  ${n}`);
    }
  } finally {
    session.close();
  }
}

main().catch((err) => { console.error(err.message); process.exit(1); });
