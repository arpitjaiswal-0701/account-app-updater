'use strict';
// Apply stage — single-page model for the Power BI Account App. Requires
// --apply explicitly. Consumes ONLY data/approved-plan.json (ticked rows).
// Per record: slicer-select → resolve the single visible card (identity
// rail) → conflict check → remarks: fill → verify → "Add Weekly Notes" →
// Success modal → Ok → verify in Remarks History; toggles: geometric
// label↔switch pairing, click only when state differs (instant campaign
// side effect), verify new state. Per-step journal with resume · abort after
// 3 consecutive failures · 24h staleness gate · auth pause/resume · max 25.
const fs = require('node:fs');
const path = require('node:path');
const { ensureDirs, newRunDir, purgeOldRuns, RUNS_DIR } = require('./lib/paths');
const { loadAppConfig, loadSelectors, loadFields, loadApprovedPlan, hoursSince } = require('./lib/config');
const { onAuthPage, waitForUserAuth } = require('./lib/browser');
const { resolveStrict, readFieldValue, fillFieldValue, buildLocator } = require('./lib/locators');
const { KEYS, openApp, selectAccount, selectAllAccounts, resolveCard } = require('./lib/session');
const { readToggle, setToggle } = require('./lib/powerapp');
const { valuesEqual } = require('./lib/values');
const { wasApplied, recordApplied } = require('./lib/ledger');
const { Journal } = require('./lib/journal');
const { writeSummary } = require('./lib/summary');
const { notify, beep } = require('./lib/notify');

function safeName(key) {
  return String(key).replace(/[^a-zA-Z0-9._-]/g, '_');
}

function findResumeDir(resumeArg) {
  const dirs = fs.readdirSync(RUNS_DIR).filter((d) => d.endsWith('-apply')).sort();
  if (resumeArg === true) {
    if (dirs.length === 0) throw new Error('No previous apply run to resume.');
    return path.join(RUNS_DIR, dirs[dirs.length - 1]);
  }
  const hit = dirs.find((d) => d.includes(resumeArg));
  if (!hit) throw new Error(`No apply run matching "${resumeArg}" found in runs/.`);
  return path.join(RUNS_DIR, hit);
}

async function authGuard(page, session, cfg, journal, recKey) {
  if (!onAuthPage(page, cfg)) return;
  journal.append({ record: recKey, step: 'auth_pause', cls: 'AUTH' });
  const ok = await waitForUserAuth(page, cfg);
  if (!ok) throw Object.assign(new Error('Sign-in not completed within 10 minutes — aborting run.'), { fatal: true });
  await session.reEnter();
}

// Cropped screenshot of the (filtered, single-card) panel. Failures journaled.
async function shoot(card, runDir, rec, suffix, journal) {
  try {
    await card.screenshot({ path: path.join(runDir, 'shots', `${safeName(rec.key)}-${suffix}.png`), timeout: 10_000 });
  } catch (err) {
    journal.append({ record: rec.key, step: 'screenshot_fail', detail: `${suffix}: ${err.message.split('\n')[0]}` });
  }
}

// Re-enter the view so the app drops typed-but-unsaved text.
async function discardDirtyState(session, rec, journal) {
  try {
    await session.reEnter();
    journal.append({ record: rec.key, step: 'dirty_discarded' });
  } catch (err) {
    journal.append({ record: rec.key, step: 'dirty_discard_fail', detail: err.message });
  }
}

// "Add Weekly Notes" → Success modal → Ok. The modal is the app's own save
// acknowledgement ("Your Notes are Saved in Weekly Update Section ...").
// The button carries a native disabled attr until the app registers the typed
// text; keyboard activation (focus + Enter) is overlay-proof.
async function submitNotes(rt, card, selectors, rec, journal) {
  const btn = await resolveStrict(card, selectors[KEYS.ADD_NOTES], KEYS.ADD_NOTES);
  const deadline = Date.now() + 15_000;
  while (!(await btn.isEnabled().catch(() => false))) {
    if (Date.now() > deadline) throw new Error('"Add Weekly Notes" stayed disabled — the app did not register the typed text.');
    await rt.page().waitForTimeout(500);
  }
  await pressButton(btn);
  journal.append({ record: rec.key, step: 'save_clicked' });
  const modal = buildLocator(rt, selectors[KEYS.SUCCESS_MODAL], KEYS.SUCCESS_MODAL).first();
  await modal.waitFor({ state: 'visible', timeout: 25_000 });
  journal.append({ record: rec.key, step: 'saved', detail: 'success modal shown' });
  await pressButton(buildLocator(rt, selectors[KEYS.SUCCESS_MODAL_OK], KEYS.SUCCESS_MODAL_OK).first());
  await modal.waitFor({ state: 'hidden', timeout: 10_000 }).catch(() => {});
}

// Keyboard activation for appmagic buttons — pointer clicks on them are
// flaky (overlay/stability quirks); focus + Enter is reliable.
async function pressButton(loc) {
  await loc.press('Enter').catch(async () => { await loc.click({ timeout: 5000 }); });
}

// Best-effort persistence check: the app's writeback views LAG (Remarks
// History takes minutes, the reporting section ~2h — confirmed live), so the
// Success modal is the authoritative save acknowledgement. Finding the note
// in history upgrades confidence; not finding it is NOT a failure.
async function verifyNotes(rt, card, selectors, rec, noteTexts, journal) {
  try {
    await pressButton(await resolveStrict(card, selectors[KEYS.VERIFY_OPEN], KEYS.VERIFY_OPEN));
    await rt.page().waitForTimeout(2500);
    let allFound = true;
    for (const text of noteTexts) {
      const needle = String(text).split('\n')[0].slice(0, 80).trim();
      const found = await rt.getByText(needle, { exact: false }).filter({ visible: true }).first()
        .waitFor({ state: 'visible', timeout: 10_000 }).then(() => true, () => false);
      if (!found) { allFound = false; break; }
    }
    journal.append({
      record: rec.key, step: 'persist_verify',
      detail: allFound ? 'note text found in Remarks History' : 'note not yet in Remarks History (view lags behind saves) — Success modal confirmed the save',
    });
    const close = buildLocator(rt, selectors[KEYS.VERIFY_CLOSE], KEYS.VERIFY_CLOSE).first();
    if (await close.isVisible().catch(() => false)) await pressButton(close).catch(() => {});
    return allFound;
  } catch (err) {
    journal.append({ record: rec.key, step: 'persist_verify', detail: `history check skipped: ${err.message.split('\n')[0]}` });
    return false;
  }
}

async function applyRecord(page, session, cfg, selectors, fields, rec, journal, runDir, allowDuplicates) {
  const fieldEntries = Object.entries(rec.fields);
  const fieldDef = (k) => fields.find((x) => x.key === k);
  const textEntries = fieldEntries.filter(([k]) => (fieldDef(k) || {}).type !== 'toggle');
  const toggleEntries = fieldEntries.filter(([k]) => (fieldDef(k) || {}).type === 'toggle');

  // Duplicate-apply backstop: if this record is text-only and every text field's
  // exact proposed value was already applied to this account, skip it — the
  // app's cleared textarea + lagging history would otherwise let it re-post
  // silently. (--allow-duplicates bypasses; toggles never count as duplicates.)
  if (!allowDuplicates && textEntries.length > 0 && toggleEntries.length === 0) {
    const allDup = textEntries.every(([k, f]) => wasApplied(rec.key, k, f.proposed));
    if (allDup) {
      journal.append({ record: rec.key, step: 'duplicate', status: 'skipped_duplicate', cls: 'DUPLICATE', detail: 'this exact note was already applied to this account (applied-ledger) — use --allow-duplicates to force' });
      return 'skipped_duplicate';
    }
  }

  await authGuard(page, session, cfg, journal, rec.key);
  const rt = await session.rt();
  // Identity rail: name visible + exactly one visible card, or touch nothing.
  // One retry: slicer state can need a second pass (toggle-on-reclick quirk).
  let card;
  for (let attempt = 0; ; attempt++) {
    try {
      await selectAccount(page, selectors, rec.name, rt);
      card = await resolveCard(rt, selectors, rec.name);
      break;
    } catch (err) {
      if (err.cls === 'IDENTITY_MISMATCH' && attempt === 0) continue;
      if (err.cls === 'IDENTITY_MISMATCH') {
        journal.append({ record: rec.key, step: 'identity', status: 'skipped_identity', cls: 'IDENTITY_MISMATCH', detail: err.message });
        return 'skipped_identity';
      }
      throw err;
    }
  }
  journal.append({ record: rec.key, step: 'identity_ok' });

  // Conflict check BEFORE any write: live values must equal the read-pass
  // snapshot, or a human changed them and we leave the record alone.
  for (const [fieldKey, f] of fieldEntries) {
    const def = fieldDef(fieldKey);
    const live = def.type === 'toggle'
      ? await readToggle(rt, def.campaign)
      : await readFieldValue(card, selectors[fieldKey], fieldKey, def.type);
    if (!valuesEqual(def.type, live, f.expectedCurrent)) {
      journal.append({
        record: rec.key, step: 'conflict', status: 'skipped_conflict', cls: 'CONFLICT',
        detail: `${fieldKey}: live="${live}" expected="${f.expectedCurrent}"`,
      });
      return 'skipped_conflict';
    }
  }

  await shoot(card, runDir, rec, 'before', journal);

  // --- Remarks: fill, verify took, submit, modal, verify in history.
  if (textEntries.length > 0) {
    for (const [fieldKey, f] of textEntries) {
      const def = fieldDef(fieldKey);
      await fillFieldValue(page, card, selectors[fieldKey], fieldKey, def.type, f.proposed);
      const took = await readFieldValue(card, selectors[fieldKey], fieldKey, def.type);
      if (!valuesEqual(def.type, took, f.proposed)) {
        journal.append({
          record: rec.key, step: 'fill_verify', status: 'failed_before_save', cls: 'VERIFY_FAIL',
          detail: `${fieldKey}: field shows "${took}" after fill, wanted "${f.proposed}"`,
        });
        await discardDirtyState(session, rec, journal);
        return 'failed_before_save';
      }
    }
    journal.append({ record: rec.key, step: 'filled' });

    if (onAuthPage(page, cfg)) {
      await authGuard(page, session, cfg, journal, rec.key);
      throw Object.assign(new Error('Auth redirect after fill — restarting record.'), { cls: 'AUTH', retriable: true });
    }

    try {
      await submitNotes(rt, card, selectors, rec, journal);
    } catch (err) {
      if (err.fatal) throw err;
      journal.append({ record: rec.key, step: 'save_modal', status: 'failed_after_save', cls: err.cls || 'VERIFY_FAIL', detail: `Success modal did not appear: ${err.message.split('\n')[0]}` });
      return 'failed_after_save';
    }
    rec._historyConfirmed = await verifyNotes(rt, card, selectors, rec, textEntries.map(([, f]) => f.proposed), journal);
  }

  // --- Toggles: instant writes with campaign side effects.
  for (const [fieldKey, f] of toggleEntries) {
    if (onAuthPage(page, cfg)) {
      await authGuard(page, session, cfg, journal, rec.key);
      throw Object.assign(new Error('Auth redirect before toggle — restarting record.'), { cls: 'AUTH', retriable: true });
    }
    const def = fieldDef(fieldKey);
    const res = await setToggle(page, rt, def.campaign, f.proposed);
    if (!res.clicked) {
      journal.append({ record: rec.key, step: 'toggle_already', detail: `${def.campaign} already ${f.proposed}` });
      continue;
    }
    journal.append({ record: rec.key, step: 'toggle_click', detail: `${def.campaign}: ${res.before} -> ${f.proposed} (campaign side effect)` });
    if (res.after !== f.proposed) {
      journal.append({
        record: rec.key, step: 'toggle_verify', status: 'failed_after_save', cls: 'VERIFY_FAIL',
        detail: `${def.campaign}: state is "${res.after}" after click, wanted "${f.proposed}"`,
      });
      return 'failed_after_save';
    }
  }

  await shoot(card, runDir, rec, 'after', journal);
  // Remarks land with a delay in the app's history views; toggles verify
  // immediately. "applied_unverified" = the app's Success modal confirmed the
  // save but the lagging history view hasn't shown it yet — spot-check later.
  const hadText = textEntries.length > 0;
  const status = hadText && !rec._historyConfirmed ? 'applied_unverified' : 'applied_verified';
  journal.append({ record: rec.key, step: 'verified', status });
  recordApplied(rec, fields, status, runDir); // durable duplicate-apply backstop
  return status;
}

async function main() {
  ensureDirs();
  const argv = process.argv.slice(2);
  if (!argv.includes('--apply')) {
    console.log('Refusing to run: the apply stage writes to real records and requires the explicit --apply flag.');
    console.log('Use: npm run apply   (or npm run resume to continue an interrupted run)');
    process.exit(2);
  }
  const resumeIdx = argv.indexOf('--resume');
  const resumeArg = resumeIdx >= 0 ? (argv[resumeIdx + 1] || true) : null;
  const allowDuplicates = argv.includes('--allow-duplicates');
  if (allowDuplicates) console.log('--allow-duplicates: the applied-ledger duplicate check is OFF for this run.');

  const cfg = loadAppConfig();
  const selectors = loadSelectors();
  const fields = loadFields();
  const plan = loadApprovedPlan();

  const age = hoursSince(plan.readAt);
  if (age > cfg.limits.stalenessHours) {
    console.error(`Read pass is ${age.toFixed(1)}h old (limit ${cfg.limits.stalenessHours}h).`);
    console.error('Re-run: npm run read && npm run diff  — your approvals carry over where values are unchanged.');
    process.exit(2);
  }

  const records = plan.records.slice(0, cfg.limits.maxRecordsPerRun);
  const dropped = plan.records.length - records.length;
  if (dropped > 0) {
    console.log(`CAP: ${dropped} approved record(s) beyond the ${cfg.limits.maxRecordsPerRun}/run limit will NOT be attempted — they appear as "not attempted" in the summary. Split updates.json into smaller batches.`);
  }
  const runDir = resumeArg ? findResumeDir(resumeArg) : newRunDir('apply');
  const journal = new Journal(runDir);
  console.log(`Run dir: ${runDir}${resumeArg ? ' (resuming)' : ''}`);
  console.log(`Applying ${records.length} records. Do not use the automation Chrome window while it runs.`);

  const session = await openApp(cfg, selectors);
  const { page } = session;
  let consecutiveFailures = 0;
  let aborted = false;

  try {
    // Pre-flight on the first pending record (Arbiter condition 2).
    const firstPending = records.find((r) => !journal.isDone(r.key));
    if (!firstPending) {
      console.log('All records already applied & verified — nothing to do.');
    } else {
      await authGuard(page, session, cfg, journal, firstPending.key);
      const rt = await session.rt();
      await selectAccount(page, selectors, firstPending.name, rt);
      const card = await resolveCard(rt, selectors, firstPending.name);
      const hasText = Object.keys(firstPending.fields).some((k) => (fields.find((x) => x.key === k) || {}).type !== 'toggle');
      if (hasText) {
        await resolveStrict(card, selectors[KEYS.WEEKLY_REMARKS], KEYS.WEEKLY_REMARKS);
        await resolveStrict(card, selectors[KEYS.ADD_NOTES], KEYS.ADD_NOTES);
        await resolveStrict(card, selectors[KEYS.VERIFY_OPEN], KEYS.VERIFY_OPEN);
      }
      for (const k of Object.keys(firstPending.fields)) {
        const def = fields.find((x) => x.key === k);
        if (def && def.type === 'toggle') await readToggle(rt, def.campaign);
      }
      console.log('Pre-flight selector validation passed.');
    }

    for (const rec of records) {
      if (journal.isDone(rec.key)) {
        console.log(`  [SKIP] ${rec.name} — already applied & verified in this run.`);
        continue;
      }
      let status;
      for (let tries = 0; ; tries++) {
        try {
          status = await applyRecord(page, session, cfg, selectors, fields, rec, journal, runDir, allowDuplicates);
          break;
        } catch (err) {
          if (err.fatal) throw err;
          if (err.retriable && tries === 0) { console.log(`  [RETRY] ${rec.name} — restarting after sign-in.`); continue; }
          const cls = err.cls || (err.message.includes('Selector') || err.message.includes('not visible') ? 'SELECTOR_MISS' : 'VERIFY_FAIL');
          journal.append({ record: rec.key, step: 'error', status: 'failed_before_save', cls, detail: err.message.replace(/\s+/g, ' ').slice(0, 400) });
          status = 'failed_before_save';
          break;
        }
      }
      console.log(`  [${status.toUpperCase()}] ${rec.name}`);

      // Conflict/identity/duplicate skips are the rails working — neutral for
      // the abort gate (no increment, no reset).
      if (status === 'applied_verified' || status === 'applied_unverified') {
        consecutiveFailures = 0;
      } else if (status === 'skipped_conflict' || status === 'skipped_identity' || status === 'skipped_duplicate') {
        // neutral
      } else {
        consecutiveFailures++;
        if (consecutiveFailures >= cfg.limits.maxConsecutiveFailures) {
          aborted = true;
          notify('⛔ ALM run aborted', `${consecutiveFailures} consecutive failures — looks systemic (app change?). See SUMMARY.md.`);
          beep();
          console.error(`\nAborting: ${consecutiveFailures} consecutive failures. Likely an app/selector change — see RUNBOOK.md repair section.`);
          break;
        }
      }
    }
  } finally {
    await selectAllAccounts(page, selectors).catch(() => {});
    session.close();
    const { file, buckets } = writeSummary(runDir, plan.records, journal);
    const purged = purgeOldRuns(cfg.retentionRuns, runDir);
    console.log(`\nSummary: ${buckets.ok.length} applied & verified · ${buckets.okUnverified.length} applied (history lagging, spot-check later) · ${buckets.failedBeforeSave.length} failed before save (no change) · ${buckets.failedAfterSave.length} failed after save (CHECK MANUALLY) · ${buckets.conflict.length + buckets.identity.length} skipped · ${buckets.duplicate.length} duplicate (already applied) · ${buckets.notAttempted.length} not attempted`);
    console.log(`Full summary: ${file}`);
    if (purged.length) console.log(`Retention: purged ${purged.length} old run folder(s).`);
    const appliedN = buckets.ok.length + buckets.okUnverified.length;
    const failedN = buckets.failedBeforeSave.length + buckets.failedAfterSave.length;
    const naN = buckets.notAttempted.length;
    const toastTitle = aborted ? '⛔ ALM run aborted'
                     : failedN ? '⚠️ ALM run — check failures'
                     :           '✅ ALM run complete';
    notify(toastTitle, `${appliedN} applied · ${failedN} failed · ${naN} not attempted`);
    beep();
  }
}

main().catch((err) => { console.error(err.message); process.exit(1); });
