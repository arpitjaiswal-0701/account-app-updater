'use strict';
// App-specific glue for the Power BI "Account Management App" (Power Apps
// writeback panel). Product of the 2026-06-12 mapping session — see
// MAPPING.md for the probe evidence behind each decision.
//
// Facts this module encodes:
// - The Power Apps runtime frame's URL often comes back EMPTY on CDP
//   re-attach, so the frame is found by content fingerprint, not URL.
// - Power Apps keeps every screen in the DOM; only `.activeScreen` under
//   div.canvasContentDiv is live, and hidden controls sit at (0,0) — all
//   matching must be scoped to the active screen AND visibility-filtered.
// - Campaign toggles are NOT DOM-nested under their row label (flattened,
//   absolutely-positioned layout). Pairing is geometric: the visible switch
//   whose Y matches the visible campaign label's Y within TOLERANCE_PX
//   (probe: label y=203 <-> switch y=205; rows are ~21px apart).
// - aria-checked on the VISIBLE switch is truthful (verified against an
//   all-on and an all-off account).

const TOLERANCE_PX = 15;
const SCREEN_SEL = 'div.canvasContentDiv.activeScreen';
const TAG_ATTR = 'data-alm-target';

// Find the Power Apps runtime frame by content fingerprint.
async function runtimeFrame(page, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const f of page.frames()) {
      const hit = await f.evaluate(() => !!document.querySelector('div.canvasContentDiv [class*=appmagic]'))
        .catch(() => false);
      if (hit) return f;
    }
    await page.waitForTimeout(1500);
  }
  throw new Error('Power Apps panel did not appear (runtime frame not found). Is the All Accounts view open?');
}

// Locate the visible switch for a campaign row; tag it for a trusted
// Playwright click. Returns { ariaChecked } or { error }.
async function locateToggle(rt, campaign) {
  return rt.evaluate(({ campaign, screenSel, tol, tagAttr }) => {
    const s = document.querySelector(screenSel);
    if (!s) return { error: 'active screen not found' };
    const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    for (const el of s.querySelectorAll(`[${tagAttr}]`)) el.removeAttribute(tagAttr);
    const leaf = [...s.querySelectorAll('*')].filter((e) => e.children.length === 0 && vis(e));
    const label = leaf.find((e) => e.textContent.trim() === campaign);
    if (!label) return { error: `campaign label "${campaign}" not visible on this card` };
    const ly = label.getBoundingClientRect().y;
    const cands = [...s.querySelectorAll('[role=switch]')].filter(vis)
      .map((sw) => ({ sw, dy: Math.abs(sw.getBoundingClientRect().y - ly) }))
      .sort((a, b) => a.dy - b.dy);
    if (!cands.length || cands[0].dy > tol) return { error: `no visible switch within ${tol}px of "${campaign}"` };
    cands[0].sw.setAttribute(tagAttr, 'toggle');
    // Independent state signal: an "On" row also shows a "Campaign Started"
    // label at the same Y. Disagreement means the binding hasn't settled.
    const started = leaf.some((e) => /Campaign Started/.test(e.textContent) && Math.abs(e.getBoundingClientRect().y - ly) < tol);
    return { ariaChecked: cands[0].sw.getAttribute('aria-checked'), startedLabel: started, dy: cands[0].dy };
  }, { campaign, screenSel: SCREEN_SEL, tol: TOLERANCE_PX, tagAttr: TAG_ATTR });
}

async function readToggle(rt, campaign) {
  // aria-checked must agree with the "Campaign Started" label; a mismatch is
  // an unsettled binding — wait and retry once, then refuse to guess.
  for (let attempt = 0; ; attempt++) {
    const info = await locateToggle(rt, campaign);
    if (info.error) throw new Error(`Toggle "${campaign}": ${info.error}`);
    const on = info.ariaChecked === 'true';
    if (on === info.startedLabel) return on ? 'On' : 'Off';
    if (attempt >= 1) throw new Error(`Toggle "${campaign}": state signals disagree (aria-checked=${info.ariaChecked}, startedLabel=${info.startedLabel}) — refusing to guess.`);
    await rt.page().waitForTimeout(4000);
  }
}

// Click only if state differs (instant campaign side effect). Returns
// { before, after, clicked }.
async function setToggle(page, rt, campaign, target) {
  const info = await locateToggle(rt, campaign);
  if (info.error) throw new Error(`Toggle "${campaign}": ${info.error}`);
  const before = info.ariaChecked === 'true' ? 'On' : 'Off';
  if (before === target) return { before, after: before, clicked: false };
  await rt.locator(`[${TAG_ATTR}="toggle"]`).click();
  await page.waitForTimeout(2000); // writeback settle
  const after = await readToggle(rt, campaign);
  return { before, after, clicked: true };
}

module.exports = { runtimeFrame, readToggle, setToggle, SCREEN_SEL };
