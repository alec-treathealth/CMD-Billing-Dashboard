# HANDOFF: Indigo VOB PDF Extraction Project

## Status as of this handoff

**All files below live in:**
`/Users/aleclowi/Downloads/indigo_vob_extraction/`
(moved here from a temp directory so it survives reboots/cleanup)

**DONE — validated, working:**
- `extract_vob.py` — extraction script, tested against 18 real
  Indigo VOB PDFs spanning Dec 2021 - Jul 2026. Zero errors. Correctly handles
  3 known schema versions (auto-detected per file).
- 18 test PDFs already downloaded (the `*.pdf` files in this folder)
- `output.csv` — extraction output from those 18, spot-checked
  correct against raw PDF field dumps by hand.
- `venv/` — Python venv with `pypdf` installed, ready to use.

**NOT DONE — this is the actual remaining work:**
- Downloading the PDFs for the other ~36,965 items on the Indigo VOB Monday
  board (board ID `1606316049`, workspace "Indigo Billing",
  `indigobilling.monday.com`).
- Running the extraction script against the full set.
- Loading the resulting CSV into Supabase (tenant-scoped, through the
  existing PHI/libsodium pipeline — this part not yet designed).

## Why this wasn't finished in the prior session

The prior session tried to do the full-board download manually inside a
claude.ai chat conversation: paginate the Monday board via MCP tool calls,
resolve each PDF's signed download URL via `get_assets`, then hand batches to
Desktop Commander to actually download.

**This does not scale.** Two hard problems:
1. `get_board_items_page` at 500 items/call returns large JSON that either
   floods the chat context or gets redirected to a stored file that then has
   to be read back and re-processed — expensive either way.
2. `get_assets` (which resolves asset IDs to signed download URLs) returns
   full verbose JSON **directly into the conversation with no way to
   suppress it** — there is no "quiet" mode. Every batch call, however small,
   dumps significant text into the chat transcript. At ~37k items this would
   consume enormous context for zero benefit to the user.

Roughly 495 items' worth of asset IDs were identified and 80 of those had
their signed URLs resolved before this became clearly unworkable at scale.

## The correct approach for this session: use Claude Code with the Monday MCP connector

Do NOT repeat the manual per-batch chat approach above. Instead:

1. **In Claude Code settings, add the Monday.com MCP connector** (the same
   OAuth-based connector already used in claude.ai chat — this does NOT
   require a separate personal API token). This lets a single long-running
   CC process paginate the board, resolve URLs, and download files locally
   without any chat-context bottleneck.

2. Once connected, CC should:
   a. Paginate `get_board_items_page` on board `1606316049` (500/page,
      ~74 pages total) to build a complete manifest of every item's
      `files4` column value.
   b. For each item, parse the (possibly comma-separated) file URLs. Skip
      any URL containing `Indigo%20Blank` (placeholder attachments) or
      `Image%20copy` (non-PDF junk). If multiple real PDFs remain, take the
      LAST one (most recent/superseding version).
   c. Extract the numeric asset ID from each URL
      (`/resources/(\d+)/filename` pattern).
   d. In batches (suggest 100-200 at a time to stay well within any rate
      limits), call `get_assets` to get fresh signed S3 URLs — **these
      expire in 1 hour**, so download promptly after resolving each batch,
      don't resolve everything up front and let URLs go stale.
   e. Download each PDF to a local folder, e.g.
      `/Users/aleclowi/Downloads/indigo_vob_pdfs/`, named by item_id to
      avoid collisions (e.g. `{item_id}.pdf`), while also keeping a
      manifest CSV/JSON mapping `item_id -> board_item_name -> local_path`
      for later joining back to Monday data.
   f. Log failures (network errors, 404s, non-PDF content) to a separate
      file rather than silently skipping — at 37k items some failures are
      expected and need review, not silent loss.

3. **Run the extraction script** against the full downloaded folder:
   ```bash
   /Users/aleclowi/Downloads/indigo_vob_extraction/venv/bin/python3 \
       /Users/aleclowi/Downloads/indigo_vob_extraction/extract_vob.py \
       /Users/aleclowi/Downloads/indigo_vob_full_extract.csv \
       /Users/aleclowi/Downloads/indigo_vob_pdfs/
   ```
   (Recreate the venv if working in a fresh environment — just needs `pypdf`:
   `python3 -m venv venv && venv/bin/pip install pypdf`)

4. **Review the version-breakdown and error report** the script prints.
   Given only 18 files were sampled previously, expect the full 37k to
   surface:
   - A possible 4th (or more) schema version not yet seen — these will be
     flagged `UNRECOGNIZED_SCHEMA_VERSION` in the output rather than
     silently mismapped, but will need a human look at a sample to build a
     new mapping if the volume is meaningful.
   - Scanned/non-fillable PDFs (older items might not be true AcroForms) —
     flagged `NOT_A_FILLABLE_FORM`. These would need OCR/vision extraction
     as a fallback, which the current script does NOT attempt.
   - Genuinely corrupted or non-PDF files.

5. **Do not proceed to Supabase loading** until Alec has reviewed the
   error/unknown-version report from the full run — per standing project
   discipline (gate-review protocol, PHI hygiene), do not silently load
   partial or mismapped extractions into a table that other systems will
   trust.

## Key technical facts established (don't re-derive these)

- Board: Indigo VOB board = `1606316049` on `indigobilling.monday.com`,
  column `files4` holds the PDF attachment(s).
- These are genuine fillable AcroForm PDFs (not scanned/image-based) for at
  least the 18 sampled — form field values are directly machine-readable via
  `pypdf`'s `reader.get_fields()`, no OCR needed for these.
- **3 schema versions confirmed** by field-name signature (see
  `extract_vob.py` for the exact discriminator field sets and full mapping):
  - V1 (~2021 to mid-2024): 116 fields, combined IP/OP coinsurance field
    (`coins`), uses `MRC1`/`MRC2`/`Serv Add` etc.
  - V2 (mid-2024 to ~mid-2026): 115 fields, still combined `coins`, uses
    `deductible 1`/`deductible 2` for the "DED included in OOPM" Y/N
    checkbox pair, has `Text6` as a clean unique discriminator.
  - V3 (2026+, at least from July 2026 onward): 125 fields, splits
    coinsurance into separate `IP Coins`/`OP Coins`, adds `Admit Fee`,
    `DED in OOP Y`/`DED in OOP N`, `Auth Time Frame`/`Auth Penalty`/
    `Auth Fax #`, `MemberServices`, `Indigo Rep / Date` (combined field).
  - Version boundaries are NOT hard cutover dates — overlap exists (e.g. one
    V1-pattern file appeared as late as 2024-05-31, one V2-pattern file as
    early as 2024-04-16). Detection must be by field-name signature, never
    by date.
- The `deductible 1`/`deductible 2` (V2) and `DED in OOP Y`/`DED in OOP N`
  (V3) checkbox pairs were verified via field position (rect) analysis to
  both follow a left=Yes, right=No layout convention — confirmed correct via
  matching x-coordinates across the two versions on the same visual row.
- Companion Monday board (separate company, QuantumBillingSolutions,
  different Monday account/org — cannot be reached via the current MCP
  connector session, which is authenticated to Indigo's org only) has its
  own VOB tracking board with a DIFFERENT structure: a Monday-native
  queue/pipeline board (groups: FOLLOW UPS, NEW VOB, IN PROCESS, COMPLETED,
  etc.) with ~22 flat columns, not PDF attachments — the actual benefit data
  for Quantum's board lives in linked PDF attachments referenced from a
  `VOB` column, similar in kind to Indigo's, not yet investigated for
  schema consistency.
- Monday's native "Extract with AI" column feature was evaluated and
  rejected for this task — it only offers ~8 shallow demographic fields
  (name, DOB, employer, etc.) in its field picker, with no way to select the
  actual financial/benefit-structure fields (deductibles, OOP, coinsurance,
  per-LOC rates) that are the actual point of this extraction.

## Cost note

This pipeline is pure local PDF field extraction — **no AI/LLM API calls
required**, no Monday AI credits consumed for the extraction itself (only
normal Monday API read-call volume for pagination/asset resolution, well
within typical usage). Estimated near-zero marginal cost at 37k documents
beyond compute time.
