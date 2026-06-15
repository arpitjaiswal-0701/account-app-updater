---
name: ghosthand
description: Spot-update ONE account in the Power BI "Account Management App" — draft a weekly remark (and, on explicit request, flip a campaign toggle) from briefs/graph, review it in chat, then write it into the app via the live-validated Ghosthand pipeline. Callable from any session. Trigger: /ghosthand <account> [context]
trigger: /ghosthand
---

# /ghosthand — spot account update

Front door to `~/alm-automation/` (the Ghosthand tool) for a **single account**. Generates a
grounded weekly remark, shows you the current→proposed diff **in chat**, and on your "yes"
writes it into the app through the existing `read → diff → tick → approve → apply` pipeline.
The pipeline is live-validated (2026-06-12); this skill only orchestrates it for one account.

All commands run from `C:\Users\arjaiswa\alm-automation` (use that as cwd). A dedicated
Chrome window opens during read/apply; if the Azure AD session is cold you'll be prompted
to sign in **in that window** — the scripts pause and notify (toast + beep) for it.

## Usage
```
/ghosthand <account>                 # draft a weekly remark for one account, review, apply
/ghosthand <account> <context...>    # bias the draft with inline context (a meeting note, a status line)
```
Campaign toggles are NOT touched unless you explicitly say so in the request (e.g.
"and turn on LMS Consolidation"). Toggles start/end a REAL campaign — see Step 6.

## Binding constraints (do not violate)
On-demand, user-watching, **one account**, no scheduling. The in-chat review in Step 5 IS
the human gate — never skip it, never auto-apply. Never fabricate: if there's no real
source material, say so and draft nothing. (Arbiter conditions, from the design review.)

## Steps — run in order

### 1. Resolve the exact app account name
- Read `data/app-accounts.json`. If missing or `capturedAt` > 24h old, run
  `npm run list-accounts` first (opens Chrome, enumerates the slicer, ~1 min).
- Match the user's `<account>` arg to exactly one name in `app-accounts.json`
  (case-insensitive; allow the obvious short forms — "AMD" → "Advanced Micro Devices (AMD)",
  "CBRE" → "CB Richard Ellis (CBRE)"). The app name with its parenthetical is the **exact**
  string the automation must use.
- 0 matches → tell the user and list the 19 names. >1 match → `AskUserQuestion` to pick.

### 2. Gather source material (internal first)
- Glob `C:\Users\arjaiswa\Desktop\claude-workspace\deals\<slug>-*\` for `brief.md`,
  `deal.yaml`, and `*_Exec_Brief*.pdf`/`*.docx`. Read what exists. **Internal briefs trump
  web** (workspace rule).
- Optionally pull the account's `alm-graph` node for motions / competitive incumbents
  (see `~/.claude/skills/alm-prep/SKILL.md` Step 2 for the graph query, if useful).
- Fold in any inline `context` the user passed.
- If you find nothing real and the user gave no context: STOP and ask what the update should
  say. Do not invent activity.

### 3. Draft the weekly remark
- One tight paragraph (~1–3 sentences, aim ≤ 280 chars), in the user's register: what moved,
  next step. Concrete, no fluff, no `[placeholder]`.
- **Outward-facing — Arpit's ops manager reviews these notes.** Write so a reader outside the
  deal understands it: plain business language, no internal shorthand or deal-tracker codes
  (`78/B+`, `EV $33.8K`, `FY26-H2 FEASIBLE`) unless spelled out; name the product (Adobe
  Learning Manager / ALM), the incumbent, and the business reason. Structure: what moved →
  why it matters → concrete next step.
- Write `data/updates.json`:
```json
{
  "generatedAt": "<ISO now>",
  "records": [
    {
      "key": "<slug>",
      "name": "<EXACT app name from step 1>",
      "recordId": "<EXACT app name>",
      "fields": {
        "weeklyRemarks": { "proposed": "<draft>", "source": "<brief/graph/note provenance>" }
      }
    }
  ]
}
```
- Add a toggle field ONLY if the user explicitly asked (key from `config/fields.json`, e.g.
  `toggleLmsConsolidation`, value `"On"`/`"Off"`, with a `source`).

### 4. Read + diff
- **Clear stale working state first** (delete `data/REVIEW-DIFF.md` and
  `data/approved-plan.json` if present). `generate-diff` carries over a prior tick + value
  when the current value is unchanged — that's for the human re-read flow; for a
  freshly-generated `updates.json` it would mask your new text. Starting clean avoids it.
- `npm run read`   → scrapes the account's current values (read-only).
- `npm run diff`   → writes `data/REVIEW-DIFF.md`.
- Read `data/REVIEW-DIFF.md`. Confirm the proposed value matches your Step 3 draft (not a
  carried-over one); if it doesn't, you didn't clear stale state.
- **Weekly Remarks is an append-only history field.** The app files each saved note into
  Remarks History and clears the textarea, so `current` reads **empty** even when prior notes
  exist — that is normal, not a missing read. Applying **adds** a new dated entry; it never
  overwrites a previous one, so a prior rich/validated note is not at risk. (Don't pile a thin
  or contradictory note on top in the same week just to have one — skip instead.)
- If `read` aborts on a pre-flight slicer-visibility timeout
  (`div.slicerItemContainer:has-text(...):visible`), the Azure AD session is usually cold (the
  app showed a login page) — run `npm run list-accounts` once to warm the session + refresh
  the list, then retry `read`. See the repo RUNBOOK "Slicer pre-flight timeout" entry.

### 5. Review in chat (the gate)
- Show the user, per row: **current → proposed**, plus the `source`. If the read pass shows
  the field already equals the proposed text, say so (nothing to do).
- Ask them to **approve / edit / cancel**. If they edit the wording, capture the new value.
- Cancel → stop, touch nothing.

### 6. Toggle confirmation (only if a toggle is in play)
- For each toggle row, state the real-world effect explicitly, e.g.:
  > "Approving this flips **LMS Consolidation = On** for AMD, which **starts that campaign on
  > the account**. Confirm?"
- Only include a toggle in the approval if the user says yes to that specific toggle.
  The toggle write path has not been live-validated — warn that it's the first real use and
  offer to skip it.

### 7. Apply
- Write `data/approvals.json` — only the approved rows:
```json
[ { "key": "<slug>", "field": "weeklyRemarks", "value": "<final text, only if edited>" } ]
```
  Include `value` only when the user edited the wording; omit it to apply the draft as-is.
- `npm run tick`    → ticks exactly those rows in REVIEW-DIFF.md (force-unticks the rest).
- `npm run approve` → builds `data/approved-plan.json` (re-validates hash/staleness/toggles).
- `npm run apply`   → writes to the app. Tell the user a Chrome window will drive itself and
  not to touch it; they may need to complete sign-in in that window.

### 8. Report
- Read the newest `runs/<timestamp>-apply/SUMMARY.md`. Report the outcome plainly:
  **applied & verified** / **applied — history view lagging** (the app's history refreshes a
  few minutes / ~2h late; not a failure) / **failed** / **skipped (conflict/identity)** /
  **skipped — duplicate** (this exact note was already applied to this account; the
  applied-ledger backstop caught it — the app's cleared textarea + lagging history can't).
- If a duplicate was skipped and the user genuinely wants to re-post, re-run with
  `node src/apply.js --apply --allow-duplicates`.
- If anything failed, point at the journal line; don't claim success the SUMMARY doesn't show.

## Notes
- Each run overwrites the `data/` working files (`updates.json`, `current-values.json`,
  `REVIEW-DIFF.md`, `approved-plan.json`, `approvals.json`). Expected — they're per-run scratch.
- Artifacts are local-only under `~/alm-automation/` (not OneDrive-synced); last 5 runs kept.
- For the multi-account weekly sweep, use `/ghosthand-all` instead.
