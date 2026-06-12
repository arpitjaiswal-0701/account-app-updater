'use strict';

// selectors.json entries:
//   { "strategy": "label"|"role"|"css"|"testid"|"text",
//     "value": "...", "role": "...", "exact": true,
//     "frames": ["iframe[title='...']", ...],   // chain into nested iframes, FROM THE PAGE only
//     "stateAttr": "aria-checked", "onValue": "true" }   // toggle fields
//
// "{name}" inside value is replaced with the current account name at use time.
// Card-scoped specs (fields inside an account card) must NOT set "frames" —
// the card root is already inside the right frame. Global specs (entry
// buttons, slicer, modal) DO need "frames" when the control lives in an
// embedded visual (Power BI / Power Apps iframes).

function isPage(root) {
  return typeof root.goto === 'function';
}

function frameRoot(page, spec) {
  let root = page;
  for (const sel of spec.frames || []) root = root.frameLocator(sel);
  return root;
}

function buildLocator(root, spec, key, sub) {
  if (!spec) throw new Error(`No selector spec for "${key}" in selectors.json.`);
  const base = (spec.frames && spec.frames.length && isPage(root)) ? frameRoot(root, spec) : root;
  const value = sub !== undefined && typeof spec.value === 'string'
    ? spec.value.split('{name}').join(sub)
    : spec.value;
  switch (spec.strategy) {
    case 'label': return base.getByLabel(value, { exact: spec.exact !== false });
    case 'role': return base.getByRole(spec.role, { name: value, exact: spec.exact !== false });
    case 'css': return base.locator(value);
    case 'testid': return base.getByTestId(value);
    case 'text': return base.getByText(value, { exact: spec.exact !== false });
    default: throw new Error(`Unknown selector strategy "${spec.strategy}" for "${key}".`);
  }
}

// Pre-flight / per-use guard: a stale selector matching 0 or >1 elements must
// never silently write into the wrong field (Skeptic finding 2).
async function resolveStrict(root, spec, key, opts = {}) {
  const loc = buildLocator(root, spec, key, opts.sub);
  await loc.first().waitFor({ state: 'visible', timeout: opts.timeout || 10_000 });
  const n = await loc.count();
  if (n !== 1) throw new Error(`Selector "${key}" matched ${n} elements (need exactly 1).`);
  return loc;
}

async function readFieldValue(root, spec, key, fieldType) {
  const loc = await resolveStrict(root, spec, key);
  switch (fieldType) {
    case 'select':
      // Read the selected option's LABEL, not its value attribute — fills are
      // by label, and current/proposed in the review diff are labels too.
      return (await loc.evaluate((el) =>
        el.selectedIndex >= 0 ? (el.options[el.selectedIndex].label || el.options[el.selectedIndex].text || '') : ''
      )).trim();
    case 'toggle': {
      const attr = spec.stateAttr || 'aria-checked';
      const on = spec.onValue !== undefined ? String(spec.onValue) : 'true';
      return String(await loc.first().getAttribute(attr)) === on ? 'On' : 'Off';
    }
    case 'richtext': return (await loc.innerText()).trim();
    default: return (await loc.inputValue()).trim();
  }
}

async function fillFieldValue(page, root, spec, key, fieldType, value) {
  const loc = await resolveStrict(root, spec, key);
  switch (fieldType) {
    case 'toggle': {
      // Instant write: clicking flips the state (and in this app starts/ends a
      // campaign). Click ONLY when the state actually differs.
      const cur = await readFieldValue(root, spec, key, 'toggle');
      if (cur !== value) await loc.click();
      return;
    }
    case 'select':
      await loc.selectOption({ label: value }).catch(() => loc.selectOption(value));
      break;
    case 'combobox':
      await loc.click();
      await loc.fill(value);
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('Enter');
      break;
    case 'richtext':
      await loc.click();
      await page.keyboard.press('Control+a');
      await page.keyboard.type(value);
      break;
    default:
      // Real keystrokes, not fill(): Power Apps (appmagic) inputs only update
      // their model on key events — fill() leaves the submit button disabled.
      // locator.press/pressSequentially focus the element programmatically,
      // which sidesteps the overlay divs that intercept pointer clicks.
      await loc.press('ControlOrMeta+a');
      await loc.press('Delete');
      await loc.pressSequentially(value);
  }
  // Settle blur-triggered handlers before verification reads.
  await page.keyboard.press('Tab');
}

module.exports = { buildLocator, resolveStrict, readFieldValue, fillFieldValue };
