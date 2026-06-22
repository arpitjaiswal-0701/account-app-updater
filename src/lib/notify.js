'use strict';
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

let notifier = null;
try { notifier = require('node-notifier'); } catch {}

// Big in-toast image (SnoreToast appLogoOverride, via node-notifier's `icon` → -p).
// Header app icon comes separately from the AppUserModelID shortcut — see
// scripts/install-toast-shortcut.ps1. Skip if the asset isn't generated yet
// (scripts/convert-logo.py) so toasts still fire, just with SnoreToast's default.
const ICON_PATH = path.join(__dirname, '..', '..', 'assets', 'alm.png');
const TOAST_ICON = fs.existsSync(ICON_PATH) ? ICON_PATH : null;

function notify(title, message) {
  if (notifier) {
    const opts = { title, message, appID: 'Adobe.ALM.Toast' };
    if (TOAST_ICON) opts.icon = TOAST_ICON;
    try { notifier.notify(opts); return; } catch {}
  }
  console.log(`[NOTIFY] ${title}: ${message}`);
}

function beep() {
  try {
    spawn('powershell', ['-NoProfile', '-Command', '[console]::beep(900,400)'], { stdio: 'ignore', detached: true }).unref();
  } catch {}
  process.stdout.write('\x07');
}

module.exports = { notify, beep };
