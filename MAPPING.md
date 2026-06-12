# One-Time Mapping Session (Power BI Account Management App)

Goal: produce `config/selectors.json` + `config/fields.json` (and finish
`config/app.config.json`). Takes ~15 minutes. Repeat only when the app's UI
changes (see RUNBOOK.md repair section).

The app is a Power BI report with an embedded writeback panel (account cards
with campaign toggles + weekly remarks). Controls live inside **nested
iframes** — the inventory captures every frame; selectors carry a `frames`
chain.

## Steps

1. `npm run map` (first run creates `config/app.config.json` if missing —
   defaults to `"navigation": "manual"`, which works immediately).
2. A dedicated Chrome window opens: sign in, open the Account App, click
   **Access Accounts** so the All Accounts panel is visible, press Enter in the
   terminal. The script dumps every control in every frame to
   `mapping/field-inventory.json`.
3. In Claude Code, ask:
   > Build `config/selectors.json` and `config/fields.json` from
   > `mapping/field-inventory.json`. Fields: weeklyRemarks (textarea),
   > the 4 campaign toggles (sideEffect: true). Also map: cardContainer
   > (one account's card, use {name}), accountSlicer + accountSlicerOption
   > (Account Name slicer), addNotesButton, successModal, successModalOk,
   > verifyOpen/verifyContainer/verifyClose (Remarks History or Weekly Update
   > view). Use the frames info to set each selector's "frames" chain.
   > Prefer label/role/text strategies; avoid generated class names.
4. (Optional, recommended) Switch to auto navigation: set `"navigation": "auto"`,
   `"baseUrl"` to the report URL, `"appDomains"` to its hostname (e.g.
   `["app.powerbi.com"]`), and `"entrySteps": ["accessAccountsButton"]` with an
   `accessAccountsButton` selector.
5. Verify: `npm run read` against a 1-record updates.json — pre-flight must pass.

## Selector spec shape

```json
{
  "accessAccountsButton": { "strategy": "text", "value": "Access Accounts", "exact": false,
                            "frames": ["iframe[title='Account App']"] },
  "accountSlicer":        { "strategy": "css", "value": "[aria-label='Account Name']",
                            "frames": ["iframe[title='Account App']"] },
  "accountSlicerOption":  { "strategy": "text", "value": "{name}",
                            "frames": ["iframe[title='Account App']"] },
  "cardContainer":        { "strategy": "css", "value": "div.account-card:has-text(\"{name}\")",
                            "frames": ["iframe[title='Account App']", "iframe[title='Power Apps']"] },
  "weeklyRemarks":        { "strategy": "css", "value": "textarea" },
  "addNotesButton":       { "strategy": "text", "value": "Add Weekly Notes", "exact": false },
  "toggleCampaignA":      { "strategy": "css", "value": "[role=switch]:near(:text('Example Campaign A'))",
                              "stateAttr": "aria-checked", "onValue": "true" },
  "successModal":         { "strategy": "text", "value": "Your Notes are Saved", "exact": false,
                            "frames": ["iframe[title='Account App']", "iframe[title='Power Apps']"] },
  "successModalOk":       { "strategy": "role", "role": "button", "value": "Ok",
                            "frames": ["iframe[title='Account App']", "iframe[title='Power Apps']"] }
}
```

Rules:
- `{name}` in `value` is replaced with the account name at use time.
- **Global** selectors (entry buttons, slicer, modal, cardContainer) need a
  `frames` chain. **Card-scoped** selectors (weeklyRemarks, toggles,
  addNotesButton — anything resolved inside the card) must NOT set `frames`;
  they inherit the card's frame.
- Toggles need `stateAttr` (usually `aria-checked` or `aria-pressed`) and
  `onValue` — read as `On`/`Off`.

## `config/fields.json`

```json
[
  { "key": "weeklyRemarks", "label": "Weekly Remarks", "type": "textarea" },
  { "key": "toggleCampaignA", "label": "Campaign: Example Campaign A", "type": "toggle", "campaign": "Example Campaign A", "sideEffect": true },
  { "key": "toggleCampaignB", "label": "Campaign: Example Campaign B", "type": "toggle", "campaign": "Example Campaign B", "sideEffect": true }
]
```

Types: `text`, `textarea`, `select`, `combobox`, `richtext`, `toggle`.
`sideEffect: true` adds a warning line under the row in REVIEW-DIFF.md —
flipping a campaign toggle starts/ends a real campaign instantly.

> **Canvas caveat:** if the inventory shows few/no controls in any frame, the
> writeback visual may render to canvas — Playwright cannot reach those.
> The inventory answers this immediately; scope then shrinks to DOM-reachable
> controls and the rest stays manual.
