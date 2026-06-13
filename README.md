# Ghosthand

> An invisible hand that fills your account fields for you.

Drive weekly **account-hygiene updates** into a Power BI "Account Management App"
(a Power BI report with an embedded Power Apps writeback panel) through **real browser
UI actions** — because the app has no API and updates must happen via the UI.

It writes **weekly remarks** (free text per account) and, with explicit confirmation, flips
**campaign toggles**. Every run is **on-demand, watched, and human-gated**: you review a
current → proposed diff before anything is written.

> Built and live-validated 2026-06-12. Single-page model: one entry into the "All Accounts"
> view, then each account is isolated via the Power BI **Account Name slicer** and edited
> inside its **card**.

---

## How it works (one screen)

```
                    you review the diff in chat / a file  ← the human gate
                                   │
 updates.json ──read──► current-values.json ──diff──► REVIEW-DIFF.md ──tick──►
   (what to             (scraped live,                 (current → proposed     (approve
    write)               read-only)                     per field)              rows)
                                   │                                              │
                                   └───────────── approve ──► approved-plan.json ─┘
                                                                   │
                                                                 apply ──► the live app
                                                                   │        (+ screenshots,
                                                                journal,      SUMMARY.md)
                                                              applied-ledger
```

- **read** opens a dedicated Chrome, signs in (interactive, no stored creds), scrapes each
  account's current field values — **read-only, types nothing**.
- **diff** produces a deterministic current → proposed comparison with provenance.
- **tick / approve** turn your approvals into the only thing `apply` will act on.
- **apply** writes to the app per account: select → assert it's the right card → check
  nobody changed the field since the read → fill → Save → confirm the app's Success dialog →
  verify → screenshot → journal.

---

## Two ways to drive it

### A. The skills (recommended) — chat-driven, from any session

| Skill | Use |
|---|---|
| `/ghosthand <account> [context]` | Spot-update **one** account. Drafts a remark from briefs/graph, shows the diff in chat, applies on your "yes". |
| `/ghosthand-all [subset]` | Weekly sweep over **all** accounts the app lists. Auto-drafts a remark per account (one validated agent each, no fabrication), batch-reviews, applies the approved set. |

These are Claude Code skills (`~/.claude/skills/ghosthand`, `~/.claude/skills/ghosthand-all`).
They orchestrate the pipeline below and render the review **in chat** — you approve/edit/drop
per account, then they apply. See each `SKILL.md` for the exact step list.

### B. The raw pipeline — scriptable, for advanced/manual use

```bash
cd ghosthand
npm run list-accounts   # enumerate the app's account list  -> data/app-accounts.json
# write data/updates.json yourself (see "Data contracts" below)
npm run read            # scrape current values             -> data/current-values.json
npm run diff            # build the review file              -> data/REVIEW-DIFF.md
#   …tick rows by hand in REVIEW-DIFF.md (- [ ] -> - [x]), OR:
#   write data/approvals.json and run:  npm run tick
npm run approve         # build the apply plan from ticks    -> data/approved-plan.json
npm run apply           # WRITE to the app  (requires the explicit --apply flag)
npm run resume          # continue an interrupted apply run
```

---

## Setup

### Prerequisites
- **Node 18+** and **Google Chrome** installed (Windows; paths auto-detected).
- Access to the target Power BI app, and — for a managed/corporate machine — **approval to
  run Chrome with remote debugging** (this tool launches a dedicated debug Chrome on a random
  loopback port with its own profile; it never touches your daily Chrome).
- `npm install` (installs `playwright-core` + `node-notifier`).

### Configure
1. Copy the sample and fill in your report URL:
   ```bash
   cp config/app.config.sample.json config/app.config.json
   ```
   Set `baseUrl` to your Power BI `reportEmbed?...` URL (with `autoAuth=true`), and
   `appDomains` to its host. `navigation: "auto"` clicks "Access Accounts" itself;
   `"manual"` lets you open the view and press Enter.
2. **Map the UI once** (produces `config/selectors.json` + `config/fields.json`):
   ```bash
   npm run map           # opens Chrome, dumps the form controls across all frames
   ```
   Then have Claude build the two config files from `mapping/field-inventory.json`.
   Full walkthrough: **MAPPING.md**. Re-map only when the app's UI changes.

Your live `config/*.json` are git-ignored (`app.config.json` carries tenant/report IDs;
`selectors.json` + `fields.json` are app-specific). The repo ships `*.sample.json` templates —
copy each to its real name and adapt (or let `npm run map` generate selectors/fields).

---

## Data contracts

**`data/updates.json`** — what you want to write. One record per account:
```json
{
  "generatedAt": "2026-01-01T10:00:00Z",
  "records": [
    {
      "key": "acme-corp",
      "name": "Acme Corp",
      "recordId": "Acme Corp",
      "fields": {
        "weeklyRemarks": { "proposed": "Renewal moving to security review; next: pricing workshop.", "source": "brief.md p.3" }
      }
    }
  ]
}
```
- `name` / `recordId` **must match the app's exact account name** (run `npm run list-accounts`
  to get them). `key` is an internal slug.
- `weeklyRemarks` is the text field. A toggle field (e.g. `toggleCampaignA`) takes
  `"On"` / `"Off"` — **toggles start/end a real campaign**, so they're opt-in only.
- Every value should carry a `source` (provenance). Never fabricate.

**`data/approvals.json`** — the rows you approved (consumed by `npm run tick`):
```json
[ { "key": "acme-corp", "field": "weeklyRemarks", "value": "optional edited text" } ]
```
`tick` ticks exactly these rows in `REVIEW-DIFF.md` and force-unticks everything else, so
only approved rows reach `apply`. `value` overrides the proposed text where you edited it.

---

## Safety rails (why you can trust it)

- **Human gate** — nothing is written until you approve the diff. `apply` refuses to run
  without an explicit `--apply` flag.
- **Read is read-only** — the dry run scrapes values; it never types or clicks Save.
- **Identity assertion** — before writing, the loaded card must match the expected account
  (exact name); a mismatch is skipped, untouched.
- **Conflict check** — if a field changed since the read pass (someone edited it), that record
  is skipped, never overwritten.
- **Duplicate backstop (applied-ledger)** — the app clears the remarks box after submit and
  its history view lags minutes-to-hours, so a re-run's conflict check sees an *empty* field.
  `applied-ledger.json` records every successful write (account + field + value-hash); an
  identical note to the same account is **skipped as a duplicate**. Force with
  `node src/apply.js --apply --allow-duplicates`.
- **Per-record verification** — after Save, the app's Success dialog is the save acknowledgement;
  the note is then looked for in the history view (which lags, so "applied — history lagging"
  is a normal, non-failure outcome).
- **Abort budget** — stops after 3 consecutive real failures (likely a UI change); conflict/
  identity/duplicate skips are neutral and don't count.
- **Caps & staleness** — ≤ 25 records/run; an approval older than 24h forces a fresh read.
- **Resume** — interrupted runs resume from the journal, skipping already-applied records.
- **Local-only artifacts** — `data/`, `runs/` (last 5 kept), screenshots, and the ledger stay
  on disk and are git-ignored. Scraped values are diffed by script and never sent to an LLM.

**Scope is intentionally frozen:** on-demand, user-watching, ≤ 25 records, **no scheduling**.
Don't wire it to a scheduler without re-reviewing the design.

---

## After a run

`runs/<timestamp>-apply/SUMMARY.md` reports each account in plain language:

| Outcome | Meaning |
|---|---|
| Applied & verified | Saved and confirmed in the history view. |
| Applied — history lagging | App confirmed the save; the history view just hasn't refreshed (normal). |
| Failed before save | Nothing was written; the record is untouched. |
| Failed after save (CHECK MANUALLY) | Save fired but verification failed — open the record. |
| Skipped — conflict / identity | A human edited it / the wrong card loaded — untouched. |
| Skipped — duplicate | This exact note was already applied (ledger backstop). |

Per-record steps and any errors are in `journal.jsonl`; before/after card screenshots in `shots/`.

---

## Troubleshooting

- **"Automation Chrome exited immediately…"** — a previous automation Chrome is still open on
  the profile. Close it (or kill `chrome.exe` processes whose command line contains
  `alm-automation\chrome-profile`) and retry.
- **Repeated `SELECTOR_MISS` / pre-flight abort** — the app's UI changed. Re-run `npm run map`
  and rebuild `config/selectors.json` from the fresh inventory (see MAPPING.md).
- **Sign-in loop** — the dedicated Chrome window pauses for Okta/Entra MFA and notifies (toast +
  beep); complete it **in that window**.
- **A real note didn't show in history right away** — expected; the history view lags
  (minutes; the weekly reporting section ~2h).

---

## Project layout

```
src/
  list-accounts.js   enumerate the app's account slicer -> data/app-accounts.json
  read-pass.js       scrape current values (read-only)
  generate-diff.js   build REVIEW-DIFF.md (current -> proposed + provenance)
  tick.js            programmatic approval from data/approvals.json
  parse-approvals.js build approved-plan.json from ticked rows (hash/staleness/toggle checks)
  apply.js           write to the app (--apply required; --resume, --allow-duplicates)
  map-fields.js      one-time UI inventory across frames
  lib/
    session.js       openApp, slicer select/enumerate, card identity rail
    powerapp.js      Power Apps panel glue (frame discovery, toggle geometry)
    locators.js      frame-/card-scoped, strict (exactly-one) locators
    values.js        hashing + diff-row encode/decode + type-aware compare
    ledger.js        applied-ledger duplicate backstop
    journal.js       per-step run journal + resume
    summary.js       human-readable SUMMARY.md
    config.js        config loaders + validation
    browser.js       dedicated debug-Chrome launch + auth-pause handling
    notify.js        Windows toast + beep
    paths.js         paths + run-retention purge
test/pipeline-test.js  offline regression (diff/tick/approve/ledger round-trips)
config/            app.config (git-ignored) + selectors + fields  (+ samples)
RUNBOOK.md         operator runbook   ·   MAPPING.md  one-time UI mapping guide
```

Run the offline regression with `node test/pipeline-test.js` (no browser needed).
