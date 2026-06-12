'use strict';
// One-time mapping session helper. Opens the dedicated Chrome, lets you
// navigate to the All Accounts view, then dumps an inventory of every form
// control IN EVERY FRAME (Power BI embeds its writeback visuals in nested
// iframes) to mapping/field-inventory.json. A Claude session turns that
// inventory into config/selectors.json + config/fields.json.
// Modes:
//   (default)   interactive: prompts in the terminal (run it yourself)
//   --open      launch the automation Chrome and exit, leaving it running
//   --capture   attach to the Chrome left open by --open, dump the inventory
//   --close     kill the Chrome left open by --open
// The --open/--capture/--close split exists so a Claude chat session can drive
// mapping: it opens the window, the user navigates, then it captures.
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline/promises');
const { ensureDirs, MAPPING_DIR, CONFIG_DIR } = require('./lib/paths');
const { launchChrome, launchChromePersistent, connectCdp, killPid } = require('./lib/browser');

const SESSION_FILE = () => path.join(MAPPING_DIR, '.cdp-session.json');

const MINIMAL_CONFIG_HINT = `{
  "appName": "Account Management App",
  "navigation": "manual",
  "baseUrl": "",
  "entrySteps": [],
  "appDomains": [],
  "authDomains": ["login.microsoftonline.com", "login.windows.net", "adobe.okta.com", "okta.com"],
  "limits": { "maxRecordsPerRun": 25, "maxConsecutiveFailures": 3, "stalenessHours": 24 },
  "retentionRuns": 5
}`;

const CAPTURE_FN = `(() => {
  const out = [];
  const labelFor = (el) => {
    if (el.id) {
      const l = document.querySelector('label[for="' + (window.CSS && CSS.escape ? CSS.escape(el.id) : el.id) + '"]');
      if (l) return l.textContent.trim();
    }
    const wrap = el.closest('label');
    if (wrap) return wrap.textContent.trim().slice(0, 120);
    return '';
  };
  const els = document.querySelectorAll(
    'input, textarea, select, button, [contenteditable="true"], [role="textbox"], [role="combobox"], [role="switch"], [role="checkbox"], [role="button"], [role="tab"], [aria-pressed], [aria-checked]'
  );
  els.forEach((el) => {
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return;
    out.push({
      tag: el.tagName.toLowerCase(),
      type: el.type || null,
      id: el.id || null,
      name: el.name || null,
      role: el.getAttribute('role'),
      ariaLabel: el.getAttribute('aria-label'),
      ariaChecked: el.getAttribute('aria-checked'),
      ariaPressed: el.getAttribute('aria-pressed'),
      label: labelFor(el),
      placeholder: el.getAttribute('placeholder'),
      dataTestId: el.getAttribute('data-testid') || el.getAttribute('data-test-id'),
      className: (typeof el.className === 'string' ? el.className : '').slice(0, 120),
      text: (el.textContent || '').trim().slice(0, 80),
      value: el.value !== undefined ? String(el.value).slice(0, 80) : null,
    });
  });
  const iframes = [...document.querySelectorAll('iframe')].map((f) => ({
    src: (f.getAttribute('src') || '').slice(0, 200),
    title: f.getAttribute('title'),
    name: f.getAttribute('name'),
    id: f.id || null,
    className: (typeof f.className === 'string' ? f.className : '').slice(0, 120),
  }));
  return { url: location.href, title: document.title, controls: out, childIframes: iframes };
})()`;

function loadOrCreateConfig() {
  const cfgFile = path.join(CONFIG_DIR, 'app.config.json');
  if (fs.existsSync(cfgFile)) return JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
  fs.writeFileSync(cfgFile, MINIMAL_CONFIG_HINT);
  console.log(`Created template ${cfgFile}.`);
  return JSON.parse(MINIMAL_CONFIG_HINT);
}

async function capturePage(page) {
  const frames = page.frames();
  const captures = [];
  for (const frame of frames) {
    try {
      const data = await frame.evaluate(CAPTURE_FN);
      captures.push({
        frameUrl: frame.url().slice(0, 200),
        frameName: frame.name() || null,
        parentUrl: frame.parentFrame() ? frame.parentFrame().url().slice(0, 200) : null,
        ...data,
      });
    } catch (err) {
      captures.push({ frameUrl: frame.url().slice(0, 200), error: err.message });
    }
  }
  return captures;
}

async function captureAndWrite(pages) {
  const all = [];
  for (const page of pages) {
    if (page.url() === 'about:blank') continue;
    const captures = await capturePage(page);
    all.push({ pageUrl: page.url(), frameCount: page.frames().length, frames: captures });
  }
  const inventory = { capturedAt: new Date().toISOString(), pages: all };
  const file = path.join(MAPPING_DIR, 'field-inventory.json');
  fs.writeFileSync(file, JSON.stringify(inventory, null, 2));
  const total = all.flatMap((p) => p.frames).reduce((n, c) => n + ((c.controls && c.controls.length) || 0), 0);
  console.log(`Captured ${total} controls across ${all.reduce((n, p) => n + p.frameCount, 0)} frames on ${all.length} page(s).`);
  console.log(`Inventory written to ${file}`);
  return total;
}

async function main() {
  ensureDirs();
  const argv = process.argv.slice(2);
  const cfg = loadOrCreateConfig();

  if (argv.includes('--open')) {
    const { port, pid } = await launchChromePersistent(cfg, cfg.baseUrl || 'about:blank');
    fs.writeFileSync(SESSION_FILE(), JSON.stringify({ port, pid, startedAt: new Date().toISOString() }, null, 2));
    console.log(`Automation Chrome open (pid ${pid}). Navigate to the All Accounts view, then run --capture.`);
    return;
  }

  if (argv.includes('--capture')) {
    if (!fs.existsSync(SESSION_FILE())) throw new Error('No open mapping session — run with --open first.');
    const sess = JSON.parse(fs.readFileSync(SESSION_FILE(), 'utf8'));
    const browser = await connectCdp(sess.port);
    try {
      const pages = browser.contexts().flatMap((c) => c.pages());
      await captureAndWrite(pages);
    } finally {
      await browser.close(); // disconnect only; Chrome stays open
    }
    return;
  }

  if (argv.includes('--close')) {
    if (!fs.existsSync(SESSION_FILE())) { console.log('No open mapping session.'); return; }
    const sess = JSON.parse(fs.readFileSync(SESSION_FILE(), 'utf8'));
    killPid(sess.pid);
    fs.unlinkSync(SESSION_FILE());
    console.log(`Closed automation Chrome (pid ${sess.pid}).`);
    return;
  }

  // Default: interactive terminal flow.
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const { page, kill } = await launchChrome(cfg, cfg.baseUrl || 'about:blank');
  try {
    await rl.question('\nIn the automation Chrome window: sign in, open the Account App, click "Access Accounts" so the All Accounts panel (cards with toggles + weekly remarks) is visible, then press Enter here... ');
    await captureAndWrite([page]);
    console.log('Next: in a Claude Code session, ask Claude to build config/selectors.json and config/fields.json from this inventory (see MAPPING.md).');
    await rl.question('Press Enter to close the automation Chrome window... ');
  } finally {
    rl.close();
    kill();
  }
}

main().catch((err) => { console.error(err.message); process.exit(1); });
