'use strict';
// Single-page session for the Power BI Account Management App. There are no
// per-record URLs: one entry into the "All Accounts" view, then per-account
// isolation via the PBI "Account Name" slicer; work happens inside the Power
// Apps panel's active screen.
const readline = require('node:readline/promises');
const { launchChrome, onAuthPage, waitForUserAuth } = require('./browser');
const { resolveStrict } = require('./locators');
const { runtimeFrame, SCREEN_SEL } = require('./powerapp');

// Fixed selector-key names (mapped in config/selectors.json).
const KEYS = {
  SLICER: 'accountSlicer',
  SLICER_SEARCH: 'accountSlicerSearch',
  SLICER_OPTION: 'accountSlicerOption',
  SLICER_SELECT_ALL: 'slicerSelectAll',
  ADD_NOTES: 'addNotesButton',
  SUCCESS_MODAL: 'successModal',
  SUCCESS_MODAL_OK: 'successModalOk',
  VERIFY_OPEN: 'verifyOpen',
  VERIFY_CLOSE: 'verifyClose',
  WEEKLY_REMARKS: 'weeklyRemarks',
};

async function clickEntrySteps(page, cfg, selectors) {
  for (const key of cfg.entrySteps || []) {
    // Silent SSO can bounce the page through login.microsoftonline.com and
    // /signin mid-wait — retry the step after the redirect chain settles.
    for (let attempt = 0; ; attempt++) {
      try {
        await (await resolveStrict(page, selectors[key], key, { timeout: 30_000 })).click();
        break;
      } catch (err) {
        if (attempt >= 2) throw err;
        if (onAuthPage(page, cfg)) {
          const ok = await waitForUserAuth(page, cfg);
          if (!ok) throw Object.assign(new Error('Sign-in not completed within 10 minutes — aborting run.'), { fatal: true });
        }
        await page.waitForLoadState('domcontentloaded').catch(() => {});
        await page.waitForTimeout(3000);
      }
    }
    await page.waitForTimeout(2000);
  }
}

async function settleOnAllAccounts(page) {
  // The Power Apps panel appearing (content fingerprint) is the readiness
  // signal for the All Accounts view.
  const rt = await runtimeFrame(page, 90_000);
  await page.waitForTimeout(8000); // hydration
  return rt;
}

// Opens the dedicated Chrome and lands on the All Accounts view.
async function openApp(cfg, selectors) {
  const manual = cfg.navigation === 'manual';
  const { page, kill } = await launchChrome(cfg, manual ? 'about:blank' : cfg.baseUrl);
  page.on('dialog', (d) => d.accept().catch(() => {}));

  let rl = null;
  const promptUser = async (msg) => {
    if (!rl) rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    await rl.question(msg);
  };

  const enter = async () => {
    if (onAuthPage(page, cfg)) {
      const ok = await waitForUserAuth(page, cfg);
      if (!ok) throw Object.assign(new Error('Sign-in not completed within 10 minutes — aborting run.'), { fatal: true });
      await page.goto(cfg.baseUrl, { waitUntil: 'domcontentloaded' });
    }
    await clickEntrySteps(page, cfg, selectors);
    return settleOnAllAccounts(page);
  };

  let rt;
  if (manual) {
    await promptUser('\n[ACTION] In the automation Chrome window: sign in, open the Account App, click "Access Accounts" so the All Accounts panel is visible, then press Enter here... ');
    try {
      const host = new URL(page.url()).hostname.toLowerCase();
      if (host && !cfg.appDomains.includes(host)) cfg.appDomains.push(host);
    } catch {}
    rt = await settleOnAllAccounts(page);
  } else {
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    rt = await enter();
  }

  const reEnter = async () => {
    if (manual) {
      await promptUser('\n[ACTION] In the automation Chrome window: bring the app back to the All Accounts view, then press Enter here... ');
      rt = await settleOnAllAccounts(page);
    } else {
      await page.goto(cfg.baseUrl, { waitUntil: 'domcontentloaded' });
      rt = await enter();
    }
    return rt;
  };

  const close = () => {
    try { if (rl) rl.close(); } catch {}
    kill();
  };
  // rt() always returns a CURRENT runtime frame — the Power Apps iframe can
  // reload between records, so re-resolve cheaply each time.
  return {
    page,
    rt: async () => { rt = await runtimeFrame(page, 30_000); return rt; },
    reEnter, promptUser, close,
  };
}

// Open the slicer dropdown reliably — clicking the slicer TOGGLES the popup,
// so check whether options are already visible before clicking.
async function ensureSlicerOpen(page, selectors) {
  const { buildLocator } = require('./locators');
  const anyOption = buildLocator(page, selectors[KEYS.SLICER_OPTION], KEYS.SLICER_OPTION, '').first();
  for (let attempt = 0; attempt < 5; attempt++) {
    if (await anyOption.isVisible().catch(() => false)) return;
    await (await resolveStrict(page, selectors[KEYS.SLICER], KEYS.SLICER)).click();
    await page.waitForTimeout(2500); // PBI re-render can swallow the first click
  }
  if (!(await anyOption.isVisible().catch(() => false))) {
    throw new Error('Account Name slicer dropdown did not open.');
  }
}

// Quick non-throwing check: is the panel already filtered to exactly this
// account? (Clicking an already-selected slicer item DESELECTS it, so
// selection must be idempotent.)
async function isFilteredTo(rt, selectors, name) {
  try {
    const { buildLocator } = require('./locators');
    const screen = rt.locator(SCREEN_SEL);
    if (!(await screen.isVisible().catch(() => false))) return false;
    const nameVisible = await screen.getByText(name, { exact: false }).filter({ visible: true }).count();
    if (nameVisible === 0) return false;
    const cards = await buildLocator(screen, selectors[KEYS.WEEKLY_REMARKS], KEYS.WEEKLY_REMARKS).count();
    return cards === 1;
  } catch { return false; }
}

// Isolate one account via the PBI Account Name slicer (main frame). The
// dropdown's item list virtualizes, so use its search box when configured.
async function selectAccount(page, selectors, name, rt = null) {
  if (rt && await isFilteredTo(rt, selectors, name)) return;
  await ensureSlicerOpen(page, selectors);
  if (selectors[KEYS.SLICER_SEARCH]) {
    try {
      const s = await resolveStrict(page, selectors[KEYS.SLICER_SEARCH], KEYS.SLICER_SEARCH, { timeout: 4000 });
      await s.fill(name);
      await page.waitForTimeout(1200);
    } catch { /* search box optional — fall through to direct option click */ }
  }
  await (await resolveStrict(page, selectors[KEYS.SLICER_OPTION], KEYS.SLICER_OPTION, { sub: name, timeout: 8000 })).click();
  await page.keyboard.press('Escape');
  await page.waitForTimeout(5000); // slicer-driven Power Apps gallery refresh
}

// Enumerate every account in the "Account Name" slicer. The dropdown
// virtualizes (only rendered rows are in the DOM), so scroll the popup's
// scroll region and collect texts until the set stops growing. Scoped to the
// Account Name popup so the other slicers (Account Priority etc.) don't leak in.
async function listAccounts(page, selectors) {
  await ensureSlicerOpen(page, selectors);
  // Clear any search filter so the full list is enumerable.
  if (selectors[KEYS.SLICER_SEARCH]) {
    const s = await resolveStrict(page, selectors[KEYS.SLICER_SEARCH], KEYS.SLICER_SEARCH, { timeout: 4000 }).catch(() => null);
    if (s) { await s.fill(''); await page.waitForTimeout(800); }
  }
  const names = [];
  const seen = new Set();
  let stable = 0;
  for (let i = 0; i < 80 && stable < 3; i++) {
    const { batch, atEnd } = await page.mainFrame().evaluate(() => {
      const popup = document.querySelector('.slicer-dropdown-popup');
      if (!popup) return { batch: [], atEnd: true };
      const items = [...popup.querySelectorAll('.slicerItemContainer')]
        .map((el) => el.textContent.trim()).filter(Boolean);
      // Find the scrollable region holding the items.
      let sc = popup;
      const first = popup.querySelector('.slicerItemContainer');
      let n = first;
      while (n && n !== popup) { if (n.scrollHeight > n.clientHeight + 4) { sc = n; break; } n = n.parentElement; }
      if (sc === popup && popup.scrollHeight <= popup.clientHeight + 4) {
        // Some PBI builds put the scroll on an inner viewport div.
        const vp = popup.querySelector('.mid-viewport, .scroll-content, .slicerBody');
        if (vp && vp.scrollHeight > vp.clientHeight + 4) sc = vp;
      }
      const before = sc.scrollTop;
      sc.scrollTop = Math.min(sc.scrollTop + Math.floor((sc.clientHeight || 200) * 0.8), sc.scrollHeight);
      sc.dispatchEvent(new Event('scroll', { bubbles: true }));
      return { batch: items, atEnd: sc.scrollTop <= before + 1 };
    });
    const before = seen.size;
    for (const t of batch) {
      if (t.toLowerCase() === 'select all') continue;
      if (!seen.has(t)) { seen.add(t); names.push(t); }
    }
    if (seen.size === before && atEnd) stable++; else stable = 0;
    await page.waitForTimeout(450);
  }
  await page.keyboard.press('Escape').catch(() => {});
  return names;
}

// Restore the slicer to all accounts (leave the app as the user expects it).
async function selectAllAccounts(page, selectors) {
  try {
    await ensureSlicerOpen(page, selectors);
    if (selectors[KEYS.SLICER_SEARCH]) {
      const s = await resolveStrict(page, selectors[KEYS.SLICER_SEARCH], KEYS.SLICER_SEARCH, { timeout: 4000 }).catch(() => null);
      if (s) { await s.fill(''); await page.waitForTimeout(800); }
    }
    await (await resolveStrict(page, selectors[KEYS.SLICER_SELECT_ALL], KEYS.SLICER_SELECT_ALL, { timeout: 5000 })).click();
    await page.keyboard.press('Escape');
  } catch { /* best-effort restore */ }
}

// Identity rail in the single-page model: after slicer filtering, the active
// screen must (a) show this account's name and (b) contain EXACTLY ONE
// visible weekly-remarks textarea — i.e. exactly one card. Returns the
// card root locator (the active screen).
async function resolveCard(rt, selectors, name) {
  const { buildLocator } = require('./locators');
  const screen = rt.locator(SCREEN_SEL);
  await screen.waitFor({ state: 'visible', timeout: 20_000 });
  const nameVisible = await screen.getByText(name, { exact: false })
    .filter({ visible: true }).count();
  if (nameVisible === 0) {
    throw Object.assign(new Error(`Account name "${name}" not visible after slicer filter.`), { cls: 'IDENTITY_MISMATCH' });
  }
  // One card == one visible weekly-remarks box (selector from selectors.json).
  const cards = await buildLocator(screen, selectors[KEYS.WEEKLY_REMARKS], KEYS.WEEKLY_REMARKS).count();
  if (cards !== 1) {
    throw Object.assign(new Error(`Expected exactly 1 visible card after filtering to "${name}", found ${cards} — slicer filter failed.`), { cls: 'IDENTITY_MISMATCH' });
  }
  return screen;
}

module.exports = { KEYS, openApp, selectAccount, selectAllAccounts, listAccounts, resolveCard, isFilteredTo, clickEntrySteps };
