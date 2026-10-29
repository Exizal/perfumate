# Research notes (28 October 2026)

Ten short desk-research passes informed the build. Most sources are forums (Basenotes), vendor pages and blogs, not standards. Treat these as practitioner conventions to validate with real perfumers, not findings.

## What changed in the design because of it

| Finding | Design consequence |
|---|---|
| Formulas are written by mass; totals of 1000 (ppt) or 100 (%) are conventions, not rules. Unlabelled totals are inferred from the sum. | Amount mode (g / % / parts) is an explicit per-revision setting. Percent and ppt are derived views. Non-100 % totals are shown, never fixed silently. |
| Diluted materials appear as "Material 10%" or "(10%)"; the listed amount is the solution, not the neat material. | Every line carries a stock strength and carrier. Parent-material equivalent is derived (amount × strength) and shown separately. Strength embedded in a name is *suggested* on import, never applied without review. |
| Stocks are prepared w/w on a balance (1 g + 9 g = 10 %), serially (10 % → 1 %). Supplier "10 % in DPG" labels often omit the basis. Densities differ, so volume is avoided. | Prepared stocks are lots with provenance (source lot, source mass, carrier mass). Nested strengths multiply. The MVP is mass-only; no mL anywhere. |
| Balance readability is not accuracy. USP <41> derives a minimum weight from repeatability (~820 × readability at 0.10 % tolerance). Perfumery practice is looser (~1 % of target). One drop of a 10 % dilution is ~10–15 mg. | Readability and practical minimum are separate settings. Additions below the minimum are flagged; the app never swaps in a different dilution. |
| Overpour practice is not documented in sources found. | Brief's rule implemented: keep as weighed, or preview a proportional top-up the perfumer must approve. |
| Trial numbering schemes "fall apart after two or three months"; the chosen version is often not the latest. | Revision and batch codes are generated (AT-F003, AT-B019), immutable, with parent links and change reasons. |
| Labels carry formula ID, concentration and date. Maceration is weeks; evaluation checkpoints are minutes to hours (0, 15 min, 1 h, 4 h, 24 h). | Two independent clocks: batch age and application elapsed time, both stored on each observation. Checkpoint presets are editable. |
| No agreed descriptor vocabulary; sillage/longevity have no standard measurement. 0–5 intensity scales are common. | Free text first; optional 0–5 intensity and own-vocabulary descriptors. No derived scores. |
| Real spreadsheets put headers in row 7–8, mix totals rows into data, use semicolon CSVs with decimal commas. | Import chooses sheet and header row, flags total rows, detects delimiter, and asks for the number convention when "1,250"-style cells are present. |
| CAS identifies a substance, not a product or grade (Hedione vs Hedione HC; Kharismal). | Material identity = trade name + grade + supplier. No automatic merging by name or CAS. |
| IFRA does not issue certificates; the formulator does. | Documents are attachments with source, date, intended use and review state. No compliance badge. |
| Competitors (PerfuMate, Formulair, Perfume Workbench, Perfumers Vault) already offer versioning, weighing, inventory and export. Formulair rescales after overpour. | Differentiation is treated as a workflow hypothesis: the connected record from label to batch to observation. |

## Terminology for localisation

Trade names are never translated. French loan terms are kept where the trade keeps them (mouillette / ムエット). Chinese and Turkish technical terms had the weakest sources and need review by a native-speaking perfumer before release.
