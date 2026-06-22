'use strict';
const { spawn, execSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const { chromium } = require('playwright-core');
const { PROFILE_DIR } = require('./paths');
const { notify, beep } = require('./notify');

const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
];

function findChrome(cfg) {
  const candidates = cfg.chromePath ? [cfg.chromePath, ...CHROME_CANDIDATES] : CHROME_CANDIDATES;
  const found = candidates.find((p) => p && fs.existsSync(p));
  if (!found) throw new Error('chrome.exe not found — set "chromePath" in app.config.json.');
  return found;
}

function cdpReady(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/json/version', timeout: 1000 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

// Launches a DEDICATED Chrome window: randomized CDP port bound to 127.0.0.1,
// separate user-data-dir (never the daily profile), and a watchdog that kills
// the window on any exit path — normal, Ctrl+C, or crash (Constraint Guardian
// finding 1).
async function launchChrome(cfg, startUrl) {
  const chromePath = findChrome(cfg);
  const port = 9300 + crypto.randomInt(600);
  const child = spawn(chromePath, [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${PROFILE_DIR}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--new-window',
    startUrl || cfg.baseUrl,
  ], { detached: false, stdio: 'ignore' });

  let killed = false;
  let exited = false;
  child.on('exit', () => { exited = true; });
  const kill = () => {
    if (killed) return;
    killed = true;
    try { child.kill(); } catch {}
    try { execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' }); } catch {}
  };
  process.on('exit', kill);
  process.on('SIGINT', () => { kill(); process.exit(130); });
  process.on('uncaughtException', (err) => { console.error(err); kill(); process.exit(1); });

  const deadline = Date.now() + 30_000;
  while (!(await cdpReady(port))) {
    if (exited) {
      // Chrome's single-instance handoff: if an automation window is already
      // running on this profile, the new process delegates to it and exits —
      // its CDP port never opens and we must not taskkill a random PID.
      throw new Error('Automation Chrome exited immediately — a leftover automation window is probably still running. Close every Chrome window using the alm-automation profile and retry.');
    }
    if (Date.now() > deadline) { kill(); throw new Error('Chrome CDP endpoint did not come up in 30s.'); }
    await new Promise((r) => setTimeout(r, 300));
  }

  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const context = browser.contexts()[0];
  const page = context.pages()[0] || await context.newPage();
  return { browser, context, page, kill };
}

function hostOf(url) {
  try { return new URL(url).hostname.toLowerCase(); } catch { return ''; }
}

function onAppDomain(page, cfg) {
  const host = hostOf(page.url());
  return (cfg.appDomains || []).some((d) => host === d.toLowerCase() || host.endsWith('.' + d.toLowerCase()));
}

function onAuthPage(page, cfg) {
  const host = hostOf(page.url());
  if (host === '' || page.url() === 'about:blank') return false; // pre-navigation blank tab
  const auth = cfg.authDomains || cfg.oktaDomains || [];
  if (auth.some((d) => host === d.toLowerCase() || host.endsWith('.' + d.toLowerCase()))) return true;
  if ((cfg.appDomains || []).length === 0) return false; // manual mode before the app host is captured
  // Any navigation off the app's domains mid-run is treated as an auth
  // interstitial, not a page to type into (Skeptic finding 5).
  return !onAppDomain(page, cfg);
}

// Okta redirect mid-run: pause, notify (toast + beep), wait for the user to
// finish MFA interactively, then let the caller restart the record from
// navigate (Constraint Guardian finding 6; User Advocate finding 3).
async function waitForUserAuth(page, cfg) {
  notify('⏸️ ALM run paused', 'Sign-in required. Complete the sign-in/MFA in the automation Chrome window.');
  beep();
  console.log('\n[PAUSED] Complete the sign-in/MFA in the automation window. Waiting (up to 10 min)...');
  const deadline = Date.now() + 600_000;
  while (Date.now() < deadline) {
    if (onAppDomain(page, cfg)) {
      console.log('[RESUMED] Back on the app.');
      return true;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  return false;
}

// Mapping-session variant: Chrome outlives the script (detached, no watchdog)
// so the user can navigate between two tool invocations. Caller MUST close it
// afterwards via the recorded PID — the debug port stays open until then.
async function launchChromePersistent(cfg, startUrl) {
  const chromePath = findChrome(cfg);
  const port = 9300 + crypto.randomInt(600);
  const child = spawn(chromePath, [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${PROFILE_DIR}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--new-window',
    startUrl || 'about:blank',
  ], { detached: true, stdio: 'ignore' });
  child.unref();

  let exited = false;
  child.on('exit', () => { exited = true; });
  const deadline = Date.now() + 30_000;
  while (!(await cdpReady(port))) {
    if (exited) throw new Error('Automation Chrome exited immediately — a leftover automation window is probably still running. Close every Chrome window using the alm-automation profile and retry.');
    if (Date.now() > deadline) throw new Error('Chrome CDP endpoint did not come up in 30s.');
    await new Promise((r) => setTimeout(r, 300));
  }
  return { port, pid: child.pid };
}

async function connectCdp(port) {
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  return browser; // browser.close() only disconnects; Chrome keeps running
}

function killPid(pid) {
  try { execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' }); return true; } catch { return false; }
}

module.exports = { launchChrome, launchChromePersistent, connectCdp, killPid, onAppDomain, onAuthPage, waitForUserAuth };
