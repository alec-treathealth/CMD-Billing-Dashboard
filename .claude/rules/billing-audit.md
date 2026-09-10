---
paths:
  - "src/billingAudit/**"
  - "app/lib/billing-audit/**"
  - "app/components/billing-audit/**"
  - "app/app/billing-audit/**"
---

# Billing Audit (displayed as "AR Management" since 2026-09-09; "Claims Desk" before that)

The billing team's AR tab at `/billing-audit`: the **AR Queue** (default, 2026-09-09) plus the
IP/OP claim-audit workbench and Billable Days. Route and internal names stay `billing-audit`;
only the **display label** changed — "Claims Audit" → "Claims Desk" (2026-07-15) → "AR
Management" (2026-09-09). The name "Claims" is reserved for Veris S10.

## The AR Queue — fed by the CMD V2 customer DATA SNAPSHOT (2026-09-09)

`claims.ar_*` (migrations 0109 + 0110, both applied live 2026-09-09) is written nightly by
`/api/cron/ar-snapshot` (14:05 UTC) from `GET /v2/customer/{c}/snapshot` — CMD's full per-customer
data extract (30 tab-delimited `.DAT` tables). It returns 200 for **19 of BXR's 20 accounts**; the
billing umbrella 10030472 is 401 and the ACCOUNT-level endpoint for 475729 is 404 (not configured),
as is the Indigo account (10024431 → 404, 2026-08-14). Roster: `src/billingAudit/arConfig.ts`
(the 17 audit-consolidated accounts + TREAT_CO + HOUSTON_MH — the last two are a HOLD item for
Alec). A snapshot is a direct GET: it consumes **no CBI report slot** and does not contend with
the hourly explorer/census pulls.

**CMD's "CLAIM AT <payer>" is DERIVED, not stored.** `B_CHARGE.STATUS` is set on ~5% of charges
(the hand-applied statuses); the rest of what CMD reports show comes from money + responsibility
columns. The verified rule (`src/billingAudit/arSnapshotMap.ts`, header): custom status text →
else `PAID` at zero balance → else `BALDUETO='P'` → `BALANCE DUE PATIENT` → else `BALDUETO='I'` →
`CLAIM AT <payer of the newest E/P/F submission activity>` (+ ` - SECONDARY` when that submission
went to the secondary) → else `BALANCE DUE OTHER`. Measured 2026-09-09: 128 of the 139 distinct
`CLAIM AT …` strings on `claims.audit_row` reproduce byte-for-byte. `status_category` uses the
SHARED `normalizeStatus` taxonomy — do not fork it.

**Notes are two kinds.** `B_PATNOTES.TYPE=0` rows carry `CLAIM=0` and are PATIENT-level follow-up
notes (CAMH: 1,535 of 1,567); `TYPE=2` rows carry a real claim id. 0110 made `cmd_claim_id`
nullable for exactly this; a patient-level note renders on every claim of that patient. All note
bodies (CMD-imported and in-app) are libsodium ciphertext; the notes read is gated to
`canRevealPhi` and audited (`read_ar_notes`).

**Planes and roles.** `ar_patient` is the ONLY PHI table (name / DOB / member id ciphertext +
blind indexes); `ar_claim` / `ar_charge` / `ar_remit` / `ar_claim_status_event` carry opaque CMD
ids only, so the queue page never selects an encrypted column. Ingest writes as
`claims_audit_writer` under GUC-scoped RLS via `withTenant()`; human writes (`ar_add_note`,
`ar_set_work`, `ar_mark_notifications_seen`) are `claims_admin`-owned definers with EXECUTE to
`claims_reader`. Reads are `claims_reader` + the app-layer tenant WHERE. Age is computed at READ
time from `dos_from` against the business day (`src/billingAudit/arBuckets.ts` — nine bands
31–60d … 1–2yr, plus 0–30 and 2yr+ so the set is exhaustive; NOT the CMD a)–h) labels in
`ageBucket.ts`).

### The ingest's two capacity limits — MEASURED, not estimated (2026-09-09)

Both were measured on the live roster before release; neither is a guess, and both have a guard
in code rather than a note asking you to be careful.

**MEMORY IS THE BINDING CONSTRAINT, IT IS UNPINNED, AND LAZINESS DID NOT FIX IT.** Read all three
sentences before optimising anything here; two of them were learned the expensive way.

`parseTsv` materialises one JS object per row with a property per column — roughly **13x the source
text**. CAMH is the worst case: a 6.4 MB ZIP holding **77.5 MB uncompressed across 32 tables**, of
which `arSnapshotMap.ts` reads only **11**.

`parseSnapshotZip` is lazy in two layers — `readZipEntriesLazy` defers the INFLATE, and the table
view defers the ROW MATERIALISATION — so the 21 unread tables (B_CREDIT 12.4 MB, CLAIM_ICD_CODE and
ICLAIM 4.9 MB each, plus ~18 smaller) cost nothing. Measured against the live CAMH snapshot:

| stage | eager | lazy |
|---|---|---|
| after `parseSnapshotZip` | heap 9 MB / rss 198 MB / **ext 83 MB** | heap 11 MB / rss 135 MB / **ext 10 MB** |
| **peak** (after `mapSnapshot`) | heap 903 MB / rss **1,131 MB** | heap 908 MB / rss **1,125 MB** |

⚠ **The laziness removed the parse-step spike and left the PEAK essentially unchanged**, because the
peak is the row objects of the eleven tables the mapper *does* read. Do not reach for laziness again
expecting the peak to move.

**RELEASE-AFTER-USE is what actually moved it.** Every table is read exactly once, so `mapSnapshot`
calls `tables.release(name)` after each loop; the ORDER is what does the work, since B_CLAIMSTATUS
(29 MB of source at CAMH) is parsed late and the saving comes from having already freed B_ACTIVITY,
B_CHARGE and B_REMITTANCE. B_CLAIM, ICLAIM and B_PATIENT are deliberately NOT released — their rows
are retained in lookup maps, so releasing would free the wrapper and none of the memory.

Measured on the live CAMH snapshot by capping V8's old space, which is the only test that answers
"would this OOM" — `heapUsed` after a forced GC does not, because it reports the live set once the
map is finished rather than the peak during it:

| `--max-old-space-size` | 700 | 900 | 1300 |
|---|---|---|---|
| without release-after-use | OOM | **OOM** | OK |
| with release-after-use | OOM | **OK** | OK |

So the minimum viable old space went from >900 MB to 900 MB, and the post-map live set from 908 MB
to 393 MB. ⚠ **RSS is a poor proxy here and reads as if nothing improved** (1,125 → 1,086 MB): V8
does not return freed pages promptly, and RSS still measures ~1,046 MB when the live heap is 12 MB.
Judge this code by a capped run, never by RSS.

A released table **THROWS** on a second read rather than reading as empty — `rowsOf()` maps a
missing table to `[]`, so the silent version of this optimisation would have contributed zero rows
and recorded `ok` over an incomplete book. `release()` on an absent table, or twice, is a no-op.

⚠⚠ **`memory` CANNOT BE PINNED ON THIS PROJECT — do not re-add it.** `app/vercel.json` briefly
carried `"functions": {"app/api/cron/ar-snapshot/route.ts": {"memory": 3009}}` and the deploy log
answered plainly: *"Provided `memory` setting in `vercel.json` is ignored on Active CPU billing. You
can safely remove this setting from your configuration."* It was removed. The lambda count going
10 → 11 when the block landed is NOT evidence it worked — a distinct config makes Vercel bundle the
route separately whether or not the memory value is honoured, and that misreading is exactly how the
pin was reported as working for several hours. So the ~1.1 GB peak runs against whatever Fluid
Compute provisions, with no ceiling of our choosing.

⚠ **An OOM here is worse than a timeout and does not look like a failure.** A thrown stage error is
caught per-customer and closes the run row with a label; an OOM kills the process, so the `running`
row is never closed and the rest of the roster is silently skipped for the day. If you make the
mapper read more tables, or CMD's export grows, **re-measure the peak** — do not reason about it.
The cheap win left on the table is a compact row representation (array + shared column index)
instead of an object per row; it is a real refactor of `SnapshotRow`, not a tweak.

**THE BUDGET IS ~20% OF HEADROOM, AND ORDER IS WHAT MAKES A TRUNCATED PASS SURVIVABLE.** A full
19-customer pass measured **173.8s** of parse+write (summed run rows) plus a download leg of only a
few seconds — against a 240s budget under a 300s function. Fine today. But the freshness window
(20h) is SHORTER than the schedule (24h), so at every run all 19 are stale again: with a fixed
roster order a pass that ever truncates restarts at position 1 and burns the same budget on the same
head customers, and **the tail is never reached on any day** — starved permanently, not delayed.
The loop is therefore walked **stalest-first, never-ingested first**, ties keeping roster order
(one `max(finished_at)` query per entity, tenant-scoped like every other run-log read). Keep that
property if you touch the loop; `test/arSnapshotCron.test.ts` pins all three cases.

### The queue is AGED AR ONLY, and the note column carries PHI — two rulings, 2026-09-10

**0–30 DAYS IS NOT ON THIS QUEUE.** Ruled by Alec: that set "is not needed" — money that has not had
time to be worked, and 2,584 claims / $14.3M of noise at the top of a queue built for aged AR. The
predicate lives in `arBaseConds`, so the grid, the tiles and the KPI cannot disagree about the
population they describe (measured after the change: 25,999 claims / $39.0M across 8 bands).

Two details that are easy to get wrong if you touch this:

- **It is enforced at READ, not at ingest.** The snapshot still records every claim, so one that
  crosses 31 days arrives WITH its accumulated status history and follow-up notes. Filtering at
  ingest would surface a claim on the day it ages in with no history at all — exactly when a rep
  needs the context — and undoing it would need a backfill.
- **`0_30` stays in `AR_BANDS`; the tile set is `AR_QUEUE_BANDS`.** The SQL CASE must stay total or a
  stray row classifies as `null`. `AR_BANDS` is the taxonomy, `AR_QUEUE_BANDS` is the 8 tiles.
- **A NULL `dos_from` is KEPT.** `dos_from <= asOf - 31` is NULL for an undated claim, so a bare
  comparison would silently drop money we cannot prove is new. On an AR queue that is the worst
  possible default. Undated claims stay visible.

The "Aged 31+ days only" toggle is **deleted, not moved**: a control offering to filter to what is
already the only population would misrepresent what it does.

**THE QUEUE'S FOLLOW-UP NOTE COLUMN IS PHI, SERVED TO EVERY ROLE THAT REACHES THE QUEUE.** Ruled by
Alec 2026-09-10. Note bodies are staff free text about patients; they were previously readable only
behind `canRevealPhi`, in the drawer. They are now shown in the grid to everyone who can open the
tab — **including entity `user`, which `app/lib/rbac.ts` describes as NON-PHI**. That contradiction
is deliberate and is recorded here so a reviewer (or Qodo) does not read it as the defect it would
otherwise look like. Two properties were NOT relaxed and must not be:

- **The read is AUDITED**, one `read_ar_queue_notes` row per page load, written BEFORE any decrypt,
  carrying counts and opaque claim ids only. Every other reveal on this plane audits first; a bulk
  disclosure on every page load is the last one that should skip it.
- **It is delivered UNCACHED, on its own channel** (`loadArLatestNotes`), keyed by claim id and never
  folded into `ArQueueRow`. `loadArQueuePage` is wrapped in `unstable_cache` and its payload is
  PHI-free by construction; putting note text in it would write PHI into Next's data cache — an
  at-rest surface outside the libsodium design, with none of its key management — and would audit
  once per five-minute window instead of once per read.

⚠ **`buildArLatestNotesQuery` takes (claim, patient) PAIRS, and that is not incidental.** 0110 made
CMD notes patient-level, so a claim-id-only lookup silently misses most of them: measured on a live
page, **15 notes were claim-level and 32 were patient-level** — 68% would have been invisible, and
the column would have looked merely sparse rather than broken. The pairs come from a tenant-scoped
read, so a claim can still only ever reach its own patient's notes. One indexed lateral per row;
206 ms / 609 buffers for a 50-row page. A partial index on
`(business_entity_id, cmd_patient_id, noted_at desc) where cmd_claim_id is null` would cut that if
it ever matters.

### PHI retention and removal — RATIFIED 2026-09-10

This plane is a **permanent, growing PHI replica**, by design rather than oversight: 2,415 patients'
encrypted identity, 58,830 claims, 103,367 remits and 15,010 CMD staff notes across 19 accounts,
refreshed daily. There is **no `delete` statement anywhere in it** — not in `arSnapshotWrite.ts`, not
in the three definers, not in the cron, not in the CLI. A claim that leaves CMD's snapshot is marked
`in_latest_snapshot = false` and KEPT, because surfacing claims CMD has stopped reporting is the
whole point of the queue.

The consequence nothing in the code stated until now: **when a facility offboards, its patients'
names, DOBs and member ids stay in `claims.ar_patient` indefinitely.** Three accounts left the
roster in the month CLAUDE.md documents, so this is a live path, not a hypothetical. The only
removal tool that existed was `0109_ar_management_rollback.sql`, which drops the plane for all 19
accounts — no per-facility or per-patient path for an amendment or a records request.

**THE WINDOW, RULED BY ALEC 2026-09-10 — this is the policy, not a proposal:**

- **Keep non-current rows for 24 months** from `last_seen_at`, then purge.
- **Purge an offboarded facility within 90 days** of its removal from `AR_SNAPSHOT_CUSTOMERS`.

24 months is derived from the queue's own bands rather than picked: the tab exposes 1–2yr and 2yr+,
so any window shorter than two years would delete rows the queue exists to show, and the margin
above 730 days covers a claim that ages in near the boundary.

Two consequences of the ruling that are easy to miss:

- **A 24-month clock needs something to measure, and `last_seen_at` is the only honest column.**
  `first_seen_at` would purge a long-lived claim that CMD is still reporting, and `dos_from` is a
  clinical date that has no bearing on how long we have held the record. `last_seen_at` advances on
  every ingest that still carries the row, so the clock only starts once CMD stops reporting it.
- **Nothing enforces this yet, and that is deliberate.** There is no retention cron and none is
  wanted (see THE MECHANISM below). The window is a stated obligation with a named tool, which is
  what makes it auditable; a scheduled PHI deleter with no alerting behind it would be a worse
  failure mode than holding data slightly too long. Whoever offboards a facility runs the purge.

**THE MECHANISM: a scoped migration at offboarding, run by a human.** Deliberately NOT a cron. An
automatic PHI deleter is a worse failure mode than retention, and this repo has no alerting that
would notice it misfiring.

**The scoping map matters more than the statements, because the tables do not agree.** Measured from
0109 rather than assumed:

| Scoped directly by `cmd_customer_id` | Reachable only via `cmd_claim_id` |
|---|---|
| `ar_snapshot_run`, `ar_patient`, `ar_claim`, `ar_charge`, `ar_claim_note` | `ar_remit`, `ar_claim_status_event`, `ar_claim_work`, `ar_claim_event` |

`ar_notification_seen` is keyed by `app_user_id` alone — a per-user read cursor, no facility scope,
left alone by a purge.

```sql
-- Purge one offboarded facility. Run as claims_admin.
--
-- TWO parameters, and BOTH are required: :entity (the tenant uuid) and :cust (the CMD customer id).
-- psql's :'name' form emits a QUOTED literal — plain :name substitutes raw text, so `-v cust=10033951`
-- would compare a text column to an integer and abort the transaction with
-- "operator does not exist: text = integer" before deleting anything.
--
--   psql -v entity="'af504ab6-...'" -v cust=10033951 -f purge.sql
set role claims_admin;
begin;
-- Capture (entity, claim, patient) TRIPLES before deleting ar_claim: four tables are reachable only
-- through it, and the entity must travel with the ids for the reason in trap 0 below.
create temp table _purge as
  select business_entity_id, cmd_claim_id, cmd_patient_id
    from claims.ar_claim
   where business_entity_id = :'entity'::uuid and cmd_customer_id = :'cust';

delete from claims.ar_claim_event e
 where (e.business_entity_id, e.cmd_claim_id) in (select business_entity_id, cmd_claim_id from _purge);
delete from claims.ar_claim_work w
 where (w.business_entity_id, w.cmd_claim_id) in (select business_entity_id, cmd_claim_id from _purge);
delete from claims.ar_claim_status_event t
 where (t.business_entity_id, t.cmd_claim_id) in (select business_entity_id, cmd_claim_id from _purge);
delete from claims.ar_remit r
 where (r.business_entity_id, r.cmd_claim_id) in (select business_entity_id, cmd_claim_id from _purge);
delete from claims.ar_claim_note  where business_entity_id = :'entity'::uuid and cmd_customer_id = :'cust';
delete from claims.ar_charge      where business_entity_id = :'entity'::uuid and cmd_customer_id = :'cust';
delete from claims.ar_claim       where business_entity_id = :'entity'::uuid and cmd_customer_id = :'cust';
-- ar_patient LAST and never by customer alone: see trap 1.
delete from claims.ar_patient p
 where (p.business_entity_id, p.cmd_patient_id) in (select business_entity_id, cmd_patient_id from _purge)
   and not exists (select 1 from claims.ar_claim c
                    where c.business_entity_id = p.business_entity_id
                      and c.cmd_patient_id = p.cmd_patient_id
                      and c.cmd_customer_id <> :'cust');
delete from claims.ar_snapshot_run where business_entity_id = :'entity'::uuid and cmd_customer_id = :'cust';
commit;
```

⚠ **TRAP 0 — EVERY PREDICATE CARRIES `business_entity_id`, AND A CMD ID ALONE IS NOT A KEY.** Every
table in this plane is unique on `(business_entity_id, cmd_*_id)`, never on the CMD id by itself —
CMD's SEQNOs are per-customer-database, so two accounts can legitimately hold the same claim id. A
purge matching child rows on `cmd_claim_id` alone would therefore reach another customer's — and,
once a second tenant exists, another TENANT's — remits, status events, work and change history. And
nothing else would stop it: this runs as `claims_admin`, which bypasses RLS, so the entity predicate
in the statement is the only isolation there is.
**Measured 2026-09-10: zero collisions today, and that is not reassurance.** `ar_claim` currently
holds exactly ONE `business_entity_id` — Indigo's snapshot endpoint 404s, so no Indigo rows exist —
which is the only reason the cross-tenant case cannot fire yet. Enabling Indigo is a named
follow-up. Re-run the collision counts before trusting any purge:

```sql
select count(*) from (select cmd_claim_id from claims.ar_claim
                       group by cmd_claim_id having count(distinct cmd_customer_id) > 1) x;
```

⚠ **TRAP 1 — `ar_patient` must NOT be deleted by `cmd_customer_id`, even though it has that column.**
The table is `unique (business_entity_id, cmd_patient_id)`: one row per patient per TENANT, with
`cmd_customer_id` a mutable attribute stamped by whichever facility's ingest last upserted them. A
patient treated at two facilities has ONE row carrying ONE of those customer ids, so a
customer-scoped delete is wrong in both directions — it can remove an identity another facility's
live claims still reference, and miss a patient who only ever belonged to the purged facility but
whose row happens to carry a different id.
**Rehearsed 2026-09-10: the guard is currently a NO-OP** — the `not exists` form and the naive form
both return 4 rows for WRC, because **0 patients appear at more than one facility today**. It is the
correct form for the day one does, and that count is the trigger to watch.

⚠ **TRAP 2 — notes are safe to purge by customer, and that is not obvious.** 0110 made CMD-sourced
notes patient-level, so `cmd_claim_id` is NULL on most of them (1,535 of CAMH's 1,567). A
claim-only delete would silently leave the note BODIES behind — the exact opposite of a purge's
purpose. `ar_claim_note.cmd_customer_id` is `not null` on every row and is stamped by both the
ingest and `ar_add_note`, so scoping by customer is correct AND complete. Verified by measurement:
WRC's 13 notes are 2 claim-level + 11 patient-level, and all 13 carry the customer id.

⚠ **TRAP 3 — remove the facility from `AR_SNAPSHOT_CUSTOMERS` (`src/billingAudit/arConfig.ts`) in the
same change**, or the next 14:05 ingest re-creates everything the purge just deleted.

Every statement above was **rehearsed read-only** in its `select count(*)` form on 2026-09-10 and
resolves correctly. Do that again before running it for real: nothing here is reversible and this
plane has no soft-delete.

**What "resolved" means here.** A claim never leaves history: `in_latest_snapshot` flips off when
CMD's snapshot stops carrying it, `balance` drops to 0 when it pays, and the work disposition
(`ar_claim_work`) is human-owned and never touched by the ingest — so "worked, then paid" is
visible as a state, not lost. The bell (super_admin) reads `ar_claim_event`, which every definer
appends to.

**Currently behind a refactor notice** for everyone except the shared bypass
allowlist — `alec@treathealth.ai` + `ryan@treathealth.ai` as of 2026-08-18
(`app/lib/maintenance-bypass.ts`, shared with Payer Intel; the flag itself stays
in `app/lib/billing-audit/maintenance.ts`). Kill switch:
`CLAIMS_AUDIT_MAINTENANCE=off`.

⚠ The gate covers **both** routes on this tab — `/billing-audit` and
`/billing-audit/facility-resolution`. The sub-route was ungated until 2026-08-18,
so a blocked viewer could reach the facility-resolution workbench by URL.

## Scope: TOB-derived on the consolidated feed; roster-implied only on legacy OP

**The consolidated feed (report 10064394, filters B `10148376` + C `10148377`,
live 2026-07-29) derives IP/OP per row from the Type of Bill first-two-digit
prefix** — `{11,86}→IP`, `{13,89,76}→OP`, measured zero-overlap
(`deriveScopeFromTob`, `auditRowMap.ts`). One roster
(`AUDIT_CONSOLIDATED_CUSTOMERS`, 17 = 16 data-bearing + WRC expected-empty)
serves both scopes; each customer runs B then C sequentially.

**Professional-claim fallback (ruled 2026-07-29, 0074):** CMS-1500/837P rows carry
NO TOB and NO revenue code by construction — when BOTH are blank, scope derives
from the customer's roster membership (`rosterScopeForCustomer`), recorded as
`scope_source='roster_fallback'` (TOB-derived rows are `'tob'`). CPT is NEVER a
scope signal (H2018 spans both scopes, measured). Fail-loud stays for everything
else: an unrecognised non-blank TOB, a blank TOB with a revenue code present, or
a both-blank row from a customer not in exactly one roster all QUARANTINE the
row and mark the run partial — never a defaulted scope.

The LEGACY rule — "a row is IP or OP because of which roster its customer sits
in" — now applies only to the still-soaking OP pair (`10073210`/`10147817`,
`AUDIT_OP_CUSTOMERS`): the OP cron stays live and untouched until the
consolidated feed proves 5 clean nights, then decommissions like the IP pair
did (dead since 2026-07-17, cron removed 2026-07-29). During the soak the
consolidated ingest FETCHES but does not WRITE OP-scope rows
(`CMD_AUDIT_CONSOLIDATED_OP_WRITE`, default off) so the two feeds never
co-write a charge.

**Roster exclusions (ruled reality, probes reconfirmed 2026-07-29 — two distinct
cases, do not collapse):** HOUSTON_MH `10035976` and TREAT_CO `10035974` are **not
yet open** (Alec, 2026-07-29 — supersedes "defunct vs new-no-data"); INVALID
CRITERIA under the audit filters until they open; re-add only after a rows-bearing
probe at a gate. TREAT MENTAL HEALTH VIRGINIA `10036125` is a **brand-new
pre-launch facility** — a different case with an operational resolution: switch
the filters when it opens, do NOT re-probe (it is not defunct-class; it predates
its own launch). TEEN MH TX and WELLNESS RECOVERY are collections-cron exclusions
but ARE valid audit customers (WRC is allowlisted expected-empty).

**Row identity (ruled 2026-07-29):** the consolidated ingest upserts on
`(business_entity_id, charge_debit_id)` — the feed's true unique row key — with
a fingerprint-match backfill stamping legacy rows. `row_fingerprint` is
write-once; the fingerprint UNIQUE constraint stays until the OP pair
decommissions (its arbiter). Current-state-only: status history is not kept.

`facilityCode` on this plane is a **log label only**. Row-level facility
attribution comes from the report's Office Name via `claims.facility_alias`,
never from the roster. (`cmd_customer_id` on audit_row is ingest provenance,
same discipline.)

## Config is env-only

Report and filter ids have **no hardcoded fallbacks** here — a missing var throws
at compose time. This is a deliberate break from the collections pattern, whose
in-code defaults are tracked debt we do not replicate. Don't "helpfully" add a
default.

## RBAC

Gated like Collections — not like the old deploy-protection-only `/claims` page.
This plane is PHI: a plain `user` never gets the reveal control, entity scope
comes from the `?view=` switcher, and reads are tenant-scoped server-side.

⚠ **THE CLAMP IS ROUTE-SCOPED, WHICH IS NOT "exactly like Collections" — this
line said it was until 2026-08-31.** `/billing-audit` offers **BXR + Indigo
only** and defaults to **BXR**, via `app/lib/billing-audit/views.ts`; Collections
clamps against the raw RBAC entitlement and defaults to `consolidated`. The desk
has no cross-tenant plane, so a Consolidated tab would promise a screen nobody
has specified, and `?view=consolidated` **clamps** to BXR rather than throwing.

The offered set is the RBAC entitlement **∩** this screen's planes, so it can only
ever NARROW what `allowedViewsFor` granted — an Indigo-scoped admin hand-editing
`?view=bxr` still lands on `indigo`. That intersection is a **surface
capability**, deliberately NOT an entitlement decision: `app/lib/rbac.ts` remains
the only place the view→entitlement question is answered.

The switcher itself is `TenantTabs` — the same component both /dashboard routes
use, given a narrowed option set, never a fork. It landed on this route
2026-08-31; **before that the route had no in-place tenant control at all, and
that absence was load-bearing** for the Billable Days override keys, which is why
those keys now carry the entity (`billable-days/overrides.ts`,
`app/test/billableDaysEntityScope.test.tsx`).

Audit data is **BXR-only** today. A non-BXR view resolves to an empty,
fail-closed workbench until that tenant's plane lands — never a cross-tenant
leak. Keep that shape when adding readers.

## Render shape

The server fetches the IP first page for the default (YTD) window plus both
scopes' filter options, so the grid paints with data and the client starts on the
**same** window the seeded page was fetched with — no first-render refetch or
mismatch. OP rows fetch on first view. Preserve that when changing the initial
payload.
