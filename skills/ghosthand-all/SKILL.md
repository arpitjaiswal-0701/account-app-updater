---
name: ghosthand-all
description: Bulk weekly-remark sweep across all accounts in the Power BI "Account Management App" — enumerate the live account list, auto-draft a grounded remark per account (one schema-validated agent each, no fabrication), batch-review the diff in chat, then write the approved set into the app via the Ghosthand pipeline. Trigger: /ghosthand-all [subset]
trigger: /ghosthand-all
---

# /ghosthand-all — bulk account sweep

Front door to `~/alm-automation/` (the Ghosthand tool) for the **weekly multi-account sweep**.
Enumerates the accounts the app lists after "Access Accounts" (~19), auto-drafts a weekly
remark per account from real source material, shows you the whole batch as a diff **in chat**,
and on your approval writes the approved rows into the app through the live-validated
`read → diff → tick → approve → apply` pipeline.

All commands run from `C:\Users\arjaiswa\alm-automation`. A dedicated Chrome window opens
during read/apply; complete sign-in in that window if prompted.

## Usage
```
/ghosthand-all                 # sweep all accounts the app lists
/ghosthand-all <a, b, c>       # restrict to a named subset of the live list
```
Default is **remarks-only**. Toggles (real campaign start/end) are out of scope here unless
you explicitly name them; if named, each is gated per Step 5.

## Binding constraints (do not violate)
On-demand, user-watching, ≤ 25 records/run, **no scheduling**. The in-chat batch review in
Step 4 IS the human gate. **Never fabricate** — an account with no real source material gets
no remark and is listed as skipped. Surface every skip (no silent truncation).

## Mandatory pre-read
Before the per-account fan-out, read `~/alm-graph/FAN-OUT-PLAYBOOK.md`. Core rules applied
below: deterministic-first; **schema + validate every agent output that drives a mutation**;
fail-fast on schema misses; trust on-disk artifacts over agent prose; never fan out to look
thorough.

## Steps — run in order

### 1. Enumerate the live account list
- Run `npm run list-accounts` (refresh; or reuse `data/app-accounts.json` if `capturedAt`
  < 24h). This is the authoritative set — the app's names are cached nowhere else.
- If the user named a subset, intersect it with the live list (resolve short forms to exact
  names). Report any named account not found in the live list.

### 2. Auto-draft one remark per account (schema-validated fan-out)
- Spawn **one agent per account** (Agent tool; run them in parallel batches — keep concurrency
  modest). Each agent's job, for its single account:
  1. Gather source material: deal folder
     `C:\Users\arjaiswa\Desktop\claude-workspace\deals\<slug>-*\` (`brief.md`, `deal.yaml`,
     `*_Exec_Brief*.pdf`), the `alm-graph` node, recent notes. Internal briefs trump web.
  2. If real material exists, draft ONE weekly remark (≤ 280 chars, concrete, the user's
     register). **Outward-facing — Arpit's ops manager reviews these:** plain business
     language, no internal shorthand or deal-tracker codes unless spelled out; name the
     product (Adobe Learning Manager / ALM), the incumbent, and the business reason; structure
     as what moved → why it matters → next step. Otherwise draft nothing.
- Each agent MUST return exactly this JSON (validate it; re-run or drop on malformed output):
```json
{ "account": "<exact app name>", "key": "<slug>",
  "proposed": "<remark or empty>", "source": "<provenance or empty>",
  "hasSourceMaterial": true }
```
- Keep accounts with `hasSourceMaterial: true` and a non-empty `proposed`. Set the rest aside
  as **skipped — nothing to say** (carry the list forward to the report).

### 3. Build updates.json, read + diff
- Write `data/updates.json` with one record per kept account:
  `{ key, name: "<exact app name>", recordId: "<exact app name>",
     fields: { weeklyRemarks: { proposed, source } } }`. Respect the 25-record cap; if more
  than 25 qualify, batch and tell the user.
- **Clear stale working state first** (delete `data/REVIEW-DIFF.md` and
  `data/approved-plan.json` if present) so `generate-diff` can't carry over an old tick/value
  in place of this run's fresh drafts.
- `npm run read`  → scrapes current values for those accounts (read-only).
- `npm run diff`  → `data/REVIEW-DIFF.md`. Read it; confirm proposed values match this run's
  drafts.
- **Weekly Remarks is append-only history.** Saved notes go to Remarks History and the
  textarea clears, so `current` reads empty even when prior notes exist (normal). Applying
  **adds** a dated entry; it never overwrites. A prior validated note is safe — but don't pile
  a thin/contradictory note on top in the same week; drop that account instead.
- If `read` aborts on a pre-flight slicer-visibility timeout, the Azure AD session is usually
  cold — run `npm run list-accounts` once to warm it + refresh the list, then retry `read`.
  Root cause + fix: repo RUNBOOK "Slicer pre-flight timeout".

### 4. Batch review in chat (the gate)
- Render a table: **Account | Current | Proposed | Source**. Flag rows where current already
  equals proposed (no change).
- Let the user **drop or edit** specific accounts. Capture edits. They may approve all, a
  subset, or none.

### 5. Toggles (only if explicitly named)
- If the user asked to flip any toggle, gate each one individually: state that it starts/ends
  a real campaign on that account, require an explicit per-toggle "yes", and warn the toggle
  write path is not yet live-validated. Default: no toggles.

### 6. Apply
- Write `data/approvals.json` — only approved rows (include `value` only where the user edited):
```json
[ { "key": "<slug>", "field": "weeklyRemarks", "value": "<edited text, optional>" }, ... ]
```
- `npm run tick` → `npm run approve` → `npm run apply`. Tell the user the Chrome window will
  drive itself across the batch and not to touch it; sign-in may be needed once.

### 7. Report
- Read the newest `runs/<timestamp>-apply/SUMMARY.md`. Produce a per-account outcome table:
  **applied & verified** / **applied — history view lagging** (refreshes minutes–2h late;
  not a failure) / **failed (check manually)** / **skipped (conflict/identity)** /
  **skipped — duplicate** (this exact note was already applied to this account; the
  applied-ledger backstop caught it). To force a duplicate, re-run with
  `node src/apply.js --apply --allow-duplicates`.
- Then list the **skipped — nothing to say** accounts from Step 2, so coverage gaps are
  explicit. Never imply an account was updated when it was skipped.

## Notes
- Each run overwrites the `data/` working files — expected, per-run scratch.
- Artifacts local-only under `~/alm-automation/` (not OneDrive-synced); last 5 runs kept.
- For a single account, use `/ghosthand <account>` instead.
