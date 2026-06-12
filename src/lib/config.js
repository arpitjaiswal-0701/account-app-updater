'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { CONFIG_DIR, DATA_DIR } = require('./paths');

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function loadAppConfig() {
  const file = path.join(CONFIG_DIR, 'app.config.json');
  if (!fs.existsSync(file)) {
    throw new Error(`Missing ${file} — run the mapping session first (see MAPPING.md).`);
  }
  const cfg = readJson(file);
  // navigation: "auto" drives entry itself (needs baseUrl + entrySteps);
  // "manual" means the user brings the app to the All Accounts view and the
  // app domain is captured from the live page.
  cfg.appDomains = cfg.appDomains || [];
  if (!cfg.navigation) {
    cfg.navigation = cfg.baseUrl && !String(cfg.baseUrl).includes('FILL.ME') ? 'auto' : 'manual';
  }
  if (cfg.navigation === 'auto') {
    if (!cfg.baseUrl || String(cfg.baseUrl).includes('FILL.ME')) {
      throw new Error('app.config.json: navigation is "auto" but "baseUrl" is not set — set it or use "navigation": "manual".');
    }
  }
  cfg.entrySteps = cfg.entrySteps || [];
  cfg.authDomains = cfg.authDomains || cfg.oktaDomains || ['login.microsoftonline.com', 'login.windows.net', 'okta.com'];
  cfg.limits = Object.assign(
    { maxRecordsPerRun: 25, maxConsecutiveFailures: 3, stalenessHours: 24 },
    cfg.limits || {}
  );
  cfg.retentionRuns = cfg.retentionRuns || 5;
  return cfg;
}

function loadSelectors() {
  const file = path.join(CONFIG_DIR, 'selectors.json');
  if (!fs.existsSync(file)) {
    throw new Error(`Missing ${file} — run the mapping session first (see MAPPING.md).`);
  }
  return readJson(file);
}

function loadFields() {
  const file = path.join(CONFIG_DIR, 'fields.json');
  if (!fs.existsSync(file)) {
    throw new Error(`Missing ${file} — run the mapping session first (see MAPPING.md).`);
  }
  return readJson(file);
}

function loadUpdates() {
  const file = path.join(DATA_DIR, 'updates.json');
  if (!fs.existsSync(file)) {
    throw new Error(`Missing ${file} — generate it in a Claude session first (see RUNBOOK.md, Generate stage).`);
  }
  const updates = readJson(file);
  if (!Array.isArray(updates.records) || updates.records.length === 0) {
    throw new Error('updates.json has no records.');
  }
  return updates;
}

function loadCurrentValues() {
  const file = path.join(DATA_DIR, 'current-values.json');
  if (!fs.existsSync(file)) {
    throw new Error(`Missing ${file} — run "npm run read" first.`);
  }
  return readJson(file);
}

function loadApprovedPlan() {
  const file = path.join(DATA_DIR, 'approved-plan.json');
  if (!fs.existsSync(file)) {
    throw new Error(`Missing ${file} — review REVIEW-DIFF.md, tick rows, then run "npm run approve".`);
  }
  return readJson(file);
}

function hoursSince(iso) {
  return (Date.now() - new Date(iso).getTime()) / 3_600_000;
}

module.exports = {
  loadAppConfig, loadSelectors, loadFields,
  loadUpdates, loadCurrentValues, loadApprovedPlan,
  hoursSince,
};
