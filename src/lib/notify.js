'use strict';
const { spawn } = require('node:child_process');

let notifier = null;
try { notifier = require('node-notifier'); } catch {}

function notify(title, message) {
  if (notifier) {
    try { notifier.notify({ title, message, appID: 'ALM Automation' }); return; } catch {}
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
