# ALM Automation Runbook

On-demand **Generate → Review → Apply** loop that pushes Claude-generated weekly
remarks and campaign-toggle changes into the **Power BI Account Management App**
via real UI interactions in a dedicated Chrome window.

Design v4 (reworked for the single-page Power BI model), approved by
multi-agent review 2026-06-12 with conditions:
1. Adobe IT approval for debug-flagged Chrome — **obtained** (2026-06-12).
2. Selector pre-flight is a hard gate every run — any pre-flight failure aborts before changes.
3. Scope frozen: on-demand, user watching, max 25 records/run. **No scheduled/unattended execution** without a new design review.
4. 24h staleness window and local-only artifacts (`runs/`, keep last 5) are load-bearing — do not relax.

## Front door: the two skills (preferred)

Day-to-day, drive this through the invokable skills rather than raw npm scripts:

- **`/ghosthand <account> [context]`** — spot-update ONE account. Drafts a weekly remark
  from briefs/graph, shows the current→proposed diff in chat, applies on your "yes".
  Callable from any session.
- **`/ghosthand-all [subset]`** — weekly sweep across all accounts the app lists.
  Enumerates the live list (`npm run list-accounts`), auto-drafts a remark per account
  (one schema-validated agent each, no fabrication), batch-reviews in chat, applies the
  approved set.

Both skills are thin orchestrators over the same pipeline below; the in-chat review is the
human gate. Supporting scripts they rely on: `npm run list-accounts` (enumerate the slicer
→ `data/app-accounts.json`) and `npm run tick` (programmatically tick approved rows in
`REVIEW-DIFF.md` from `data/approvals.json`, then the normal `approve` runs unchanged).

## How it navigates

The app is one Power BI page — no per-record URLs. The tool enters the
**All Accounts** view once, then isolates each account with the **Account Name
slicer** and works inside that account's **card**.

- `"navigation": "manual"` (default): the tool opens its Chrome window, you sign
  in and click **Access Accounts** yourself, press Enter, and it takes over.
- `"navigation": "auto"`: the tool opens `baseUrl` and clicks the configured
  `entrySteps` itself; you only do sign-in/MFA when prompted.

## When to use it

10–25 accounts per batch is the sweet spot. **Below ~5, editing manually is
faster.** The app's own banner applies to us too: it wants a fresh page —
the tool always starts from a fresh entry.

## The flow

### 0. One-time setup
Mapping session → `config/selectors.json`, `config/fields.json`,
`config/app.config.json`. See `MAPPING.md`.

### 1. Generate (Claude session — no browser)
Ask Claude to produce `data/updates.json` from the ALM graph / account briefs.
Contract (see `data/updates.sample.json`): per account, `weeklyRemarks` text
and/or toggle fields with `"On"`/`"Off"`. Every value MUST carry a `source`.

### 2. Read pass (read-only)
```
npm run read
```
Reads each account's current textarea content and toggle states. Types nothing,
submits nothing. Output: `data/current-values.json`.

### 3. Review
```
npm run diff
```
Open `data/REVIEW-DIFF.md`. Each row: **current → proposed** with source.
- Tick `[x]` to approve. Unticked rows are never applied.
- Edit the proposed backtick value inline to override wording.
- Toggle rows carry a ⚠ **side effect** line — approving one starts/ends a real campaign.
- Re-running `read` + `diff` keeps ticks wherever the current value didn't change.

```
npm run approve
```

### 4. Apply (watch it)
```
npm run apply
```
Per account: slicer-select → card found by exact name (wrong card = untouched,
skipped) → check nobody changed values since the read pass → type remarks →
**Add Weekly Notes** → wait for the app's **Success** dialog → Ok → confirm the
note appears in the saved-notes view → flip approved toggles (only if state
differs) → verify each → screenshot the card before/after.

Windows toast + beep on sign-in pause, abort, or finish.

### 5. After the run
Read `runs/<latest>/SUMMARY.md`:
- **Applied & verified** — note confirmed in saved-notes view / toggle state confirmed.
- **Applied — history lagging** — the app's Success dialog confirmed the save, but
  Remarks History hadn't refreshed yet (the app's writeback views lag by minutes;
  the reporting section by ~2h). Normal — spot-check later if you care.
- **Failed before save (no change made)** — record untouched (typed text discarded by re-entering the view).
- **Failed after save attempt (CHECK MANUALLY)** — submit happened but verification failed; open the account.
- **Skipped (conflict)** — someone edited since the read pass; nothing overwritten.
- **Skipped (identity mismatch)** — the card didn't match the expected account; nothing touched.
- **Not attempted** — run ended first → `npm run resume`.

Notes land in the Weekly Update section immediately; the app's weekly
*reporting* section refreshes ~2 hours later — don't panic if reporting lags.

## When it breaks (selector repair, ~10–15 min)

Symptom: abort with repeated `SELECTOR_MISS`, or pre-flight failure. The app's
UI changed. Fix:
1. `npm run map` — fresh frame-aware inventory from the All Accounts view.
2. In Claude Code: "Selectors broke — rebuild config/selectors.json from
   mapping/field-inventory.json, keeping the same field keys."
3. `npm run read` (pre-flight confirms the fix).

| Journal class | Meaning | Your data |
|---|---|---|
| SELECTOR_MISS | App UI changed; a control couldn't be found | Untouched |
| CONFLICT | Value changed since read pass | Untouched (by design) |
| AUTH | Sign-in interrupted the run | Record restarted after sign-in |
| VERIFY_FAIL | Value didn't stick / modal missing / toggle state wrong | Check the record |
| IDENTITY_MISMATCH | Card for the expected account not found uniquely | Untouched |

## Privacy & hygiene
- All artifacts stay in this folder (`data/`, `runs/`, `mapping/`) — local-only,
  **not** under OneDrive sync. Only the last 5 runs are kept.
- Screenshots are cropped to the single account card.
- Current values scraped from the app are diffed by script only — never fed to Claude.
- The automation Chrome uses its own profile (`chrome-profile/`); your daily
  Chrome is never touched. The debug port is random, bound to 127.0.0.1, and
  dies with the script.
- Campaign toggles are instant, real actions. The tool clicks one only when the
  approved value differs from the live state, and journals every click.
