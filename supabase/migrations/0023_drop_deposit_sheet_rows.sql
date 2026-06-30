-- 0023: retire the deposit Google-Sheet daily rows (source_tag='deposit_sheet').
--
-- WHY: the Master BXR chart's collections series has moved off the manually-maintained deposit
-- Google Sheet onto the live CMD report (source_tag='cmd', written by the per-customer cron —
-- see migration 0022 + src/collections/cmdExplorerCron.ts). The deposit-Sheet ingest code is
-- removed. This deletes its leftover rows so the resolved view (max-gross-wins) is pure
-- workbook(legacy)/cmd.
--
-- ORDER (important): apply this ONLY AFTER the CMD backfill (`npm run ingest:cmd-daily -- --commit`)
-- has loaded 'cmd' rows and they've been verified. Splitting the delete out of 0022 means the old
-- deposit-Sheet data is never destroyed before the replacement is confirmed good, and the chart
-- never shows a gap (while both sources briefly coexist, the resolved view shows whichever has the
-- real dollars). If 'cmd' rows are NOT yet present, do not run this.
--
-- Idempotent: a DELETE of absent rows is a no-op.

delete from collections.daily_collections where source_tag = 'deposit_sheet';
