'use strict';
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const CONFIG_DIR = path.join(ROOT, 'config');
const DATA_DIR = path.join(ROOT, 'data');
const RUNS_DIR = path.join(ROOT, 'runs');
const PROFILE_DIR = path.join(ROOT, 'chrome-profile');
const MAPPING_DIR = path.join(ROOT, 'mapping');

function ensureDirs() {
  for (const d of [CONFIG_DIR, DATA_DIR, RUNS_DIR, MAPPING_DIR]) {
    fs.mkdirSync(d, { recursive: true });
  }
}

function newRunDir(kind) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = path.join(RUNS_DIR, `${stamp}-${kind}`);
  fs.mkdirSync(path.join(dir, 'shots'), { recursive: true });
  return dir;
}

// Arbiter condition 4: artifacts are local-only with retention. Keep the
// newest `keep` run directories, delete the rest — but never the directory of
// the run that is calling us (a resumed run reuses an old timestamp and could
// otherwise purge its own journal and summary).
function purgeOldRuns(keep, activeRunDir) {
  if (!fs.existsSync(RUNS_DIR)) return [];
  const activeName = activeRunDir ? path.basename(activeRunDir) : null;
  const dirs = fs.readdirSync(RUNS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort(); // ISO timestamps sort lexically
  const doomed = dirs.slice(0, Math.max(0, dirs.length - keep)).filter((n) => n !== activeName);
  for (const name of doomed) {
    fs.rmSync(path.join(RUNS_DIR, name), { recursive: true, force: true });
  }
  return doomed;
}

module.exports = { ROOT, CONFIG_DIR, DATA_DIR, RUNS_DIR, PROFILE_DIR, MAPPING_DIR, ensureDirs, newRunDir, purgeOldRuns };
