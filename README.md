# Micro-Batch Lab Journal

A local-first laboratory workspace for independent perfumers, built to the *Micro-Batch Fragrance Lab Journal* brief (28 October 2026). It keeps **intended formulas**, **actual batches** and **physical samples** as separate records, and links them: a label opens the exact batch, its frozen formula revision, stock strengths, lots and smelling history.

Research notes that shaped the design are in [docs/RESEARCH.md](docs/RESEARCH.md).

## Project layout

```
src/
  ui/          screens and components (React)
  domain/      formulas, batches, inventory, journal, merge: pure functions, no I/O
  services/    exports, desktop bridge, team sessions (Supabase), optional AI summary
  import/      CSV, .xlsx and .ods readers and the .xlsx writer
  catalog/     material reference list and search
  store/       IndexedDB persistence
  i18n/        UI text in seven languages
electron/      desktop shell (main process and preload)
supabase/      database setup script for team sessions
tests/         unit tests (vitest)
samples/       example spreadsheets for trying the importer
scripts/       helper scripts (regenerating the samples)
build/         app icon used for the desktop build
docs/          research notes
```

## Run

```bash
npm install
npm run dev        # http://localhost:5178
npm test           # 50 tests: acceptance cases, persistence, reservations, corrections, i18n, imports, new features
npm run build
npm run desktop    # run the Windows desktop app from source
npm run dist:win   # build release/MicroBatchLabJournal-1.0.0-portable.exe and -setup.exe
```

**Desktop app.** `release/MicroBatchLabJournal-1.0.0-portable.exe` runs without installing; `-setup.exe` installs it with a Start-menu entry. Both are unsigned, so Windows SmartScreen will warn on first run (More info → Run anyway). Data is stored in the app's own profile (`%APPDATA%\Micro-Batch Lab Journal`), separate from any browser.

Stack: React 18 + TypeScript, `decimal.js` for all arithmetic, IndexedDB (`idb`) for storage, `fflate` for reading and writing `.xlsx`, `qrcode` for labels. Business logic lives in `src/domain` and `src/import` with no UI code; screens are in `src/ui`.

## The core journey (verified in the browser)

1. **Import**: `Formulas → Import formula → Use example spreadsheet` (or a file from `samples/`). The importer finds the header row, maps the columns, detects the decimal comma and excludes the Total row. Exact name matches link to existing material records. Saving creates draft **AT-F003** in one transaction.
2. **Edit**: a spreadsheet-style grid. Enter, Tab and arrow keys move between cells; Enter on the last row adds a row. Ctrl+Enter inserts a row, Ctrl+Delete deletes one, Ctrl+Z / Ctrl+Y undo and redo, and multi-cell paste works. Drafts autosave and the save state is always shown.
3. **Make a batch**: freezes AT-F003 and plans a 10.000 g batch. The 20 % line of a 10 % stock plans 2.000 g, which is 0.2000 g of parent material. The 0.002 g trace is flagged against the 0.010 g practical minimum.
4. **Bench mode (AT-B019)**: one line at a time with large Target / Added / Remaining figures, a keypad, lot selection, pause/resume and incremental additions. Recording 0.100 g + 0.020 g of black tea absolute against a 0.100 g target shows the deviation. **Preview proportional top-up** offers a minimum ×1.2 plan to 12.000 g, checks stock and container capacity, and is applied only after approval. Original targets stay on record.
5. **Complete**: saves the as-weighed composition. The record shows original, planned and actual amounts, parent equivalent, the recorded cost (marked partial where costs are unknown), the weighing log and the history. **Print label** and **Download label (SVG)** give a 50 × 25 mm label with the batch ID and an optional QR code.
6. **Sample and journal**: create AT-B019-S1 (20 % in ethanol) and apply it to a blotter with planned checkpoints. Each observation stores both **batch age** and **time since application**.
7. **Compare**: AT-F002 against AT-F003 shows percentage-point changes, stock strengths, batches with their deviations and costs, and observations side by side. Mismatched batch age, elapsed time, medium or sample strength is flagged, and the page states that side-by-side notes do not establish causation.
8. **Retrieve**: type or scan `AT-B019` (or the QR payload) into the top search box. It opens the exact batch after a reload, and after backup and restore.

## Acceptance cases

All ten are covered by automated tests in `tests/acceptance.test.ts`, `tests/persistence.test.ts` and `tests/samples.test.ts`. Cases 1, 2, 3, 4, 6, 7 and 8 were also checked by hand in the browser.

| # | Case | Where |
|---|---|---|
| 1 | 10 g × 20 % of a 10 % stock gives 2 g of stock and 0.2 g parent | `formula.ts` `planBatch`, `parentEquivalent` |
| 2 | Drawing 0.100 g of stock debits only the stock, exactly once | `batch.ts` `recordAddition` (idempotency key = event id), `inventory.ts` `prepareStock` |
| 3 | 0.120 g against a 0.100 g target keeps the target; minimum 12 g plan | `batch.ts` `topUpPreview`, `applyTopUp` |
| 4 | 0.002 g flagged with a 0.010 g minimum on a 0.001 g balance | settings keep readability and practical minimum separate |
| 5 | Editing after B019 leaves B019 untouched | frozen revisions are immutable; batches snapshot lines, strengths and cost |
| 6 | Label resolves after reopening and after backup/restore | `ids.ts` label payload; persistence test |
| 7 | "Batch aged 7 d, observed 15 min after application" keeps both | `journal.ts`, stored on each observation |
| 8 | Decimal-comma and decimal-point files give identical amounts; "1,250" flagged | `import/numbers.ts`, sample-file test |
| 9 | Cancel or resave neither erases nor duplicates consumption | append-only weigh events and inventory transactions |
| 10 | Export, restore and relationships intact; unknown never becomes 0 or "approved" | `backup.ts` with an integrity check; unknown is `null` throughout |

## Implemented

- **Persistence**: IndexedDB, one transaction per action. "Saved on this device" appears only after the write succeeds. Schema versioning and a migration path cover both the database and backups.
- **Backup and restore**: a complete versioned JSON backup with every store, including history, stock movements and attachments. Restore shows a preview with counts and an integrity check before replacing data. The last-backup time is always visible. You can also request persistent browser storage.
- **Export**: CSV and XLSX per revision and per batch. **Open in Excel** on a formula writes a working workbook: live formulas for % of formula, parent equivalent and cost share, a totals row, frozen headers, and a *Scale* sheet where typing a batch size recalculates every weight. There is also plus a full workbook (revisions, batches, observations). Formula-like text is escaped and original material names are preserved.
- **Import**: CSV/TSV (delimiter detected), pasted cells, and `.xlsx`. The `.xlsx` reader is our own: it reads cached values only, never runs macros, formulas or external links, and caps file, row, column and decompressed sizes. You choose the sheet and header row, map the columns, choose the number convention (required when cells are ambiguous) and the blank-strength policy. It flags total rows, formulas without cached values and blank versus zero amounts. Strength written in a name is only suggested, never applied without your choice. Unmapped columns are kept with each line. Mappings can be saved.
- **Data rules**: decimal arithmetic throughout. Exact values are kept and display rounding is shown separately; traces show as "< 0.001 g", never 0. Percentage totals other than 100 % stay visible, and normalization is an explicit preview. Amount modes (g / % / parts) are explicit, and changing them asks whether to convert or reinterpret. Nested dilution strengths multiply. Unknown strength, cost or quantity stays unknown.
- **Inventory (optional)**: material identity is separate from lots. Prepared stocks record their provenance (source lot, source mass, carrier mass). Adjustments require a reason. Untracked quantity shows as "not tracked".
- **Reservations**: an open batch reserves the not-yet-drawn part of each line planned from a tracked lot. Planning, Bench and top-up stock checks use the unreserved quantity, and Materials shows what is reserved. Completing or cancelling a batch releases the reservation; material already poured stays consumed.
- **Corrections without overwriting**: a weighing correction appends an offsetting entry; an observation correction appends a superseding entry with a reason. The original stays visible and both clocks keep their values. Comparisons use the current entry; exports include both.
- **Editing**: material identity details (name, grade, supplier, CAS, notes) and project name/objective can be edited, with history entries. Formula lines keep the name they were recorded with; project codes are fixed. Projects and drafts are soft-deleted and recoverable from Data & backup.
- **Robustness**: a screen error shows a recovery panel instead of a blank app; navigation and backup keep working. Screens load on demand.
- **Safety documents**: attach files with source, date, intended use and review state. There is no compliance badge anywhere.
- **Languages**: English, Spanish, Chinese, French, Italian, Japanese and Turkish. Numbers display with the locale's separators while stored values stay canonical. Trade names are never translated. A test checks that every language has every key and the same placeholders.
- **Accords**: mark a project as an accord; each frozen accord revision becomes a material other formulas can use as one ingredient. Formulas show their composition with accords expanded through stock strength.
- **Your own limit check**: record a maximum (% in finished product) and its source on any material. The formula screen checks each material, including those inside accords, at a dose you enter. It is labelled as a working check, never as IFRA or regulatory compliance.
- **Balances**: named balance profiles with their own readability, practical minimum and serial speed; a batch records the balance it was planned on. A connected balance (USB/serial, in the desktop app or Chromium browsers) can be read in Bench mode; the stable reading is copied into the entry field and the user still records it.
- **Volume entry**: with a density on the material record, Bench mode converts a measured volume to grams; the event notes the volume and density used.
- **Blind sessions**: samples get random three-character codes; evaluators rate intensity and liking under codes; a preparation key is shown only on request; revealing locks the ratings and shows averages per sample.
- **Merge restore and folder sync**: restoring a backup can merge instead of replace. Nothing is deleted; newer drafts and batches completed elsewhere are taken, records changed on both sides are kept as they are and listed, and duplicate codes are flagged. The desktop app can sync through a chosen folder (e.g. a cloud drive) using the same merge.
- **Share files**: export one revision as a share file (costs optional) and import someone else's as a new project with one draft.
- **AI drafting (optional)**: with the user's own Anthropic API key (stored on the device, never in backups), Compare can draft a plain-language summary of two revisions and their notes. Nothing is sent unless asked; the draft is labelled and never saved automatically.
- **OpenDocument import**: `.ods` files are read with the same safeguards as `.xlsx` (stored values only).
- **Appearance and accessibility**: light, dark or system theme; skip link, labelled navigation, visible focus, reduced-motion support.
- **Material library and search-as-you-type**: 2,274 perfumery materials (828 naturals, 1,063 aroma chemicals, 240 trade-name molecules, 107 named or generic bases, 36 solvents/carriers) with aliases, kind and odour family, in `src/catalog/materials.json`. Typing in a formula's material cell suggests your own materials first, then catalog names, matched by name or alias in any word order (Up/Down and Enter, or click); any other name can still be typed. **Material library** browses by family and kind and adds ticked materials as lines. The catalog holds names only: no CAS numbers, safety data or limits.
- **Team sessions (Supabase)**: build one formula together in real time. Everyone sees each line with who added it and who changed it last, a live activity feed (added / changed from → to / removed), and who is online. Sessions are joined with an 8-character code; anyone in the session can *Save as my draft* into a local project. Setup is done once in the Team screen: create a Supabase project, run `supabase/schema.sql` (the app copies it for you), turn on anonymous sign-ins, paste the project URL and anon key. Row-level security limits every table to session members; who-added and the activity log are written by database triggers, so they cannot be forged by a client. Only the session name, display names and shared lines are sent; the rest of the journal stays local, and the connection settings are not in backups.
- **Clearer affordances**: buttons are raised with hover and press states, links are underlined, status labels are flat rounded tags (not buttons), rows that open something show an arrow, and in the formula grid white cells are editable and grey cells calculated, with a legend. Less-used formula exports are under **More**.
- **Tutorial**: an eight-step tour on first start that opens each screen as it describes it. *Skip tutorial* closes it for good; the **Tutorial** button in the top bar opens it again.
- **Demonstration data**: a fictional Amber Tea project (two revisions, two batches including one overpour, one prepared stock, two lots, observations on both clocks). Every record is badged DEMO, and observation texts are labelled placeholders. It can be removed with a preview.

## Simulated or manual by design

- **Balance reading** needs a balance that prints weight lines over USB/serial (most laboratory balances do when data output is enabled). The parser handles common formats (`ST,GS,+ 0.1200 g`, `N +0.120 g`, mg/kg units) but was tested only against sample lines, not real hardware.
- **QR scanning**: a hardware scanner that types into the search box works everywhere. A camera **Scan** button appears only in browsers with the `BarcodeDetector` API (Chrome on Android, macOS and ChromeOS). It was not testable in this Windows browser, so camera scanning is unverified.
- **Label printing** uses the browser's print dialog at 50 × 25 mm. Label-printer drivers are not integrated.

## Incomplete or deferred

- **Team sessions** were tested against an in-memory Postgres (PGlite) with a stand-in for Supabase auth: session creation, join codes, member-only access, blocked forged names and direct activity writes, and the activity log all behaved correctly. They were **not** run against a live Supabase project, so live updates, presence and anonymous sign-in are unverified. Sessions share one formula's lines (no batches or journal), edits are last-write-wins per field, and there are no roles: every member can edit and remove lines.
- **Material catalog** was compiled from general references, not from supplier catalogues; some aliases, families and supplier names may be wrong, and generic "… Base" entries describe a type rather than a specific product.
- **Not built**: user accounts beyond anonymous team sign-in, a hosted sync service, community features (share files are the local stand-in), certified IFRA or regulatory checks (the limit check uses only limits you enter).
- **Data**: folder sync merges whole records; it does not merge two different edits of the same draft. Costs in different currencies are summed separately and never converted.
- **Import**: `.xls`, `.xlsb` and macro workbooks are refused (save as `.xlsx`, `.ods` or CSV). Merged header cells are read as their top-left value.
- **Translations** need review by native-speaking perfumers.
- **Unverified on real hardware**: balance connection and camera scanning. The AI summary was not called with a real key.
- **Accessibility**: landmarks, focus and labels were improved, but no formal audit with a screen reader was done.
- **No encryption** is applied to stored data, and none is claimed. The desktop app is not code-signed.
- **No user validation**: the switching hypothesis and the brief's validation targets have not been tested with perfumers.
